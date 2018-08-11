'use strict';
const fsExtra = require('fs-extra');
const path = require('path');
const objectDiff = require('deep-object-diff');
const _ = require('lodash');
const assert = require('assert');

const pkgJsonUtils = require('../pkgjson');
const errors = require('../errors');
const gitWrapper = require('../commandWrappers/gitWrapper');
const npmWrapper = require('../commandWrappers/npmWrapper');
const rsyncWrapper = require('../commandWrappers/rsyncWrapper');
const pushBackends = require('./pushBackends');
const helpers = require('./helpers');

const nodeModules = path.resolve(process.cwd(), 'node_modules');
const pkgJsonPath = path.resolve(process.cwd(), 'package.json');

const getLogger = require('../logger').getLogger;

let clearNodeModulesPromise;
let rsyncAvailable = false;

/**
 * @param {boolean} force - remove node_modules if exist
 * @param {Object} config
 * @param {boolean} rePull - if true, catching BundleAlreadyExistsError from backend will reject result.
 *                           Just to make sure, we won't fall into infinite loop here.
 * @param {null|string} rePullHash - hash, on which push has failed.
 *                           We need to ensure that we'll go with the same hash the second time.
 * @param {null|string} lockfile - path to lockfile, detected at startup. null, if no lockfile detected.
 * @returns Promise
 */
function install({force = false, config, rePull = false, rePullHash = null, lockfile = null}) {
    return new Promise((resolve, reject) => {
        const logger = getLogger();

        let newPkgJson;
        let newPkgJsonHash;
        let newLockfileContents = null;
        let missingBackends = [];

        let pkgJsonPromise;


        let done = false;

        // on the second run we don't need checks and recalculations
        if (rePull) {
            newPkgJsonHash = rePullHash;
            pkgJsonPromise = Promise.resolve();
        } else {
            pkgJsonPromise = rsyncWrapper
                .rsyncAvailable()
                .then(res => rsyncAvailable = res)
                .then(() => checkNodeModules(force, rsyncAvailable))
                .then(_clearNodeModulesPromise => {
                    if (_clearNodeModulesPromise) {
                        clearNodeModulesPromise = _clearNodeModulesPromise;
                    }
                    return readPackageFiles(pkgJsonPath, lockfile);
                })
                .then(([pkgJsonBuf, lockfileBuf]) => {
                    const pkgJsonString = pkgJsonBuf.toString();

                    if (lockfileBuf) {
                        newLockfileContents = JSON.parse(lockfileBuf.toString());
                    }

                    logger.trace('Parsing package.json');
                    return pkgJsonUtils.parsePkgJson(pkgJsonString);
                })
                .then(pkgJson => {
                    newPkgJson = pkgJson;
                    logger.debug(`Got dependencies:\t${JSON.stringify(pkgJson.dependencies)}`);
                    logger.debug(`Got devDependencies:\t${JSON.stringify(pkgJson.devDependencies)}`);

                    logger.trace('Calculating hash');

                    newPkgJsonHash = pkgJsonUtils.calcHash(pkgJson, newLockfileContents, config.packageHash);

                    logger.info(`Got hash:\t${newPkgJsonHash}`);
                });
        }

        pkgJsonPromise
            .then(() => {
                return pullBackends(newPkgJsonHash, config).then(info => {
                    missingBackends = info.missingBackends;
                    done = true;
                });
            })
            .catch(error => {
                if (error instanceof BundlesNotFoundError) {
                    if (config.useGitHistory && config.useGitHistory.depth > 0) {
                        logger.trace(`Looking in git history with depth ${config.useGitHistory.depth}`);

                        return tryOlderBundles(config, newPkgJson, newPkgJsonHash, lockfile);
                    } else if (config.fallbackToNpm === true) {
                        return npmInstallAll();
                    }

                    logger.error(
                        `Couldn't find bundle with hash '${newPkgJsonHash}'. 'fallbackToNpm' isn't set. Exiting`
                    );
                    done = true;

                    throw error;
                } else if (error.code === 'ENOENT' && error.message.indexOf('package.json') !== -1) {
                    throw new PkgJsonNotFoundError(error.message);
                }

                throw error;
            })
            .catch(error => {
                if (error instanceof BundlesNotFoundError && config.fallbackToNpm === true) {
                    return npmInstallAll();
                }

                throw error;
            })
            .then(() => {
                    if (done) {
                        if (missingBackends.length > 0) {
                            return pushBackends(missingBackends, newPkgJsonHash, config, rePull)
                                .catch(error => {
                                    if (error instanceof errors.RePullNeeded) {
                                        return install({
                                            force: true,
                                            rePull: true,
                                            rePullHash: newPkgJsonHash,
                                            config,
                                            lockfile
                                        });
                                    }

                                    throw error;
                                });
                        }

                        return;
                    }

                    return pushBackends(config.backends, newPkgJsonHash, config, rePull)
                        .catch(error => {
                            if (error instanceof errors.RePullNeeded) {
                                return install({
                                    force: true,
                                    rePull: true,
                                    rePullHash: newPkgJsonHash,
                                    config,
                                    lockfile
                                });
                            }

                            throw error;
                        });
                })
            .then(resolve, reject);
    });
}

function tryOlderBundles(config, newPkgJson, newPkgJsonHash, lockfile = null) {
    return new Promise((resolve, reject) => {
        const logger = getLogger();
        logger.info('Trying backends with older bundles');

        return gitWrapper.isGitRepo(path.dirname(pkgJsonPath))
            .then(() => {
                return pullOlderBundle(config, newPkgJsonHash, lockfile);
            })
            .then(oldPkgJson => {
                return installDiff(oldPkgJson, newPkgJson);
            })
            .then(resolve)
            .catch(reject);
    });
}

function checkNodeModules(force) {
    const logger = getLogger();
    logger.trace('Checking node_modules');


    return fsExtra.access(nodeModules)
        .then(() => {
            logger.trace('\'node_modules\' directory already exists');

            if (!force) {
                throw new NodeModulesAlreadyExistError;
            }

            if (rsyncAvailable) {
                return Promise.resolve();
            }

            return Promise.resolve(fsExtra.remove(nodeModules));
        }, () => Promise.resolve());
}

function readPackageFiles(pkgJsonPath, lockfilePath) {
    const logger = getLogger();
    const result = [];

    logger.trace('Reading package.json');
    result.push(fsExtra.readFile(pkgJsonPath));

    if (lockfilePath !== null) {
        logger.trace(`Reading ${lockfilePath}`);
        result.push(fsExtra.readFile(lockfilePath));
    }

    return Promise.all(result);
}

function pullBackends(hash, config, backendIndex = 0) {
    return new Promise((resolve, reject) => {
        const logger = getLogger();

        if (!config.backends[backendIndex]) {
            return reject(new BundlesNotFoundError(`Backends don't have bundle ${hash}`));
        }

        logger.info(`Trying backend '${config.backends[backendIndex].alias}' with hash ${hash}`);


        helpers.createCleanCwd()
            .then(() => helpers.createCleanCacheDir(config.backends[backendIndex]))
            .then(cacheDirPath => {
                logger.trace(`Cache directory for backend '${config.backends[backendIndex].alias}' is set`);
                return config.backends[backendIndex].backend
                    .pull(hash, config.backends[backendIndex].options, cacheDirPath);
            })
            .then(() => clearNodeModulesPromise)
            .then(() => {
                logger.info(`Successfully fetched ${hash} from '${config.backends[backendIndex].alias}'. Unpacking.`);
                const newNodeModules = path.resolve(process.cwd(), 'node_modules');
                helpers.restoreCWD();

                if (rsyncAvailable) {
                    return rsyncWrapper.syncDirs(newNodeModules, process.cwd());
                }

                return fsExtra.move(newNodeModules, nodeModules);
            })
            .then(() => {
                logger.info(`Pulled ${hash} from backend '${config.backends[backendIndex].alias}'`);
                resolve({missingBackends: config.backends.slice(0, backendIndex)});
            })
            .catch(error => {
                helpers.restoreCWD();

                if (error instanceof errors.BundleNotFoundError) {
                    pullBackends(hash, config, backendIndex + 1).then(resolve, reject)
                } else {
                    reject(error);
                }
            });
    });
}

function pullOlderBundle(config, prevHash, lockfile = null, historyIndex = 0) {
    return new Promise((resolve, reject) => {
        const logger = getLogger();

        let oldPkgJson;
        let newHash = prevHash;
        let newLockfileContents = null;

        if (historyIndex > config.useGitHistory.depth) {
            return reject(new BundlesNotFoundError(`Backends don't have bundles up to ${config.useGitHistory.depth}
             entries in git history of ${pkgJsonPath}`));
        }

        gitWrapper.olderRevision(process.cwd(), [pkgJsonPath, lockfile], historyIndex + 1)
            .then(([pkgJsonString, lockfileString]) => {
                if (lockfileString) {
                    newLockfileContents = JSON.parse(lockfileString);
                }

                return pkgJsonUtils.parsePkgJson(pkgJsonString);
            })
            .then(pkgJson => {
                oldPkgJson = pkgJson;

                logger.trace('Calculating hash');

                const hash = pkgJsonUtils.calcHash(pkgJson, newLockfileContents, config.packageHash);

                if (hash === newHash) {
                    const message = `Hash at index '${historyIndex}' is still '${hash}'. Incrementing history depth`;
                    logger.trace(message);
                    config.useGitHistory.depth++;

                    throw new Error(message);
                }

                newHash = hash;

                logger.info(`Got older hash: ${hash}`);

                return pullBackends(hash, config);
            })
            .then(
                () => {resolve(oldPkgJson)},
                () => {pullOlderBundle(config, newHash, lockfile, historyIndex + 1).then(resolve, reject)}
            );
    })
}

function installDiff(oldPkgJson, newPkgJson) {
    return new Promise((resolve, reject) => {
        const logger = getLogger();
        const allDepsOld = Object.assign({}, oldPkgJson.devDependencies, oldPkgJson.dependencies);
        const allDepsNew = Object.assign({}, newPkgJson.devDependencies, newPkgJson.dependencies);
        const depsDiff = objectDiff.diff(allDepsOld, allDepsNew);
        const depsToInstall = _.omitBy(depsDiff, _.isUndefined);
        const depsToUninstall = _.keys(_.pickBy(depsDiff, _.isUndefined));

        const loggingDepsToInstall = 'Installing dependencies: ' +
            Object.keys(depsToInstall).map(pkg => `${pkg}@${depsToInstall[pkg]}`).join(' ');

        const loggingDepsToUninstall = 'Uninstalling dependencies: ' + depsToUninstall.join(' ');

        if (_.keys(depsToInstall).length) {
            logger.info(loggingDepsToInstall);

            return npmWrapper.install(depsToInstall)
                .then(() => {
                    if (depsToUninstall.length) {
                        logger.info(loggingDepsToUninstall);
                        return npmWrapper.uninstall(depsToUninstall).then(resolve, reject);
                    }

                    resolve();
                }, reject);
        } else if (depsToUninstall.length) {
            logger.info(loggingDepsToUninstall);
            return npmWrapper.uninstall(depsToUninstall).then(resolve, reject);
        }

        assert(false, 'Unreachable. install#installDiff is called without proper diff to install');
    });
}

function npmInstallAll() {
    const logger = getLogger();

    logger.info('Couldn\'t find bundles. Running npm install');

    return npmWrapper.installAll();
}

class PkgJsonNotFoundError extends errors.VeendorError {}
class NodeModulesAlreadyExistError extends errors.VeendorError {}
class BundlesNotFoundError extends errors.VeendorError {}

module.exports = install;
module.exports.NodeModulesAlreadyExistError = NodeModulesAlreadyExistError;
module.exports.BundlesNotFoundError = BundlesNotFoundError;
module.exports.PkgJsonNotFoundError = PkgJsonNotFoundError;
