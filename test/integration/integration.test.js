'use strict';

const {describe, it, before, after} = require('mocha');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const fsExtra = require('fs-extra');
const _ = require('lodash');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const AWS = require('aws-sdk');
const S3rver = require('s3rver');

const helpers = require('@/lib/commandWrappers/helpers');
const {getTmpDir} = require('@/lib/install/helpers');

chai.use(chaiAsPromised);

/**
 * This is just for test runner.
 * Test cases are written in bash.
 */

const TEST_SCRIPT = 'test/integration/runTest.sh';
const PREPARE_NVM_SCRIPT = 'test/integration/prepareNvm.sh';
const s3Dir = path.resolve(process.cwd(), 'tmp', 'test', 'integration', 's3rver');

const NODE_VERSIONS = [{
    nodeVersion: 'v6.13.0',
    npmVersions: ['v3.10.10', 'v5.6.0'],
}, {
    nodeVersion: 'v8.9.4',
    npmVersions: ['v5.10.0', 'v6.4.0'],
}, {
    nodeVersion: 'v10.9.0',
    npmVersions: ['v6.4.0'],
}];

let s3rverInstance;
let s3Client;

describe('veendor', function () {
    before(function (done) {
        this.timeout(120000);
        const nvmDir = path.resolve(process.cwd(), 'nvm');

        const resultArgs = ['-x', PREPARE_NVM_SCRIPT];

        for (const nodeVersion of NODE_VERSIONS) {
            for (const npmVersion of nodeVersion.npmVersions) {
                resultArgs.push(nodeVersion.nodeVersion);
                resultArgs.push(npmVersion);
            }
        }

        helpers
            .getOutput('bash', resultArgs, {timeoutDuration: 120000})
            .then(() => {
                done();
            }, error => {
                if (error.output) {
                    const outPath = path.resolve(nvmDir, 'output.txt');
                    fsExtra.ensureDirSync(nvmDir);
                    fsExtra.writeFileSync(outPath, error.output);
                    error.message += `. Output saved to ${outPath}`;
                }
                done(error);
            });
    });

    before(function (done) {
        this.timeout(15000);

        fsExtra.ensureDirSync(s3Dir);

        s3rverInstance = new S3rver({
            port: 14569,
            silent: true,
            directory: s3Dir,
        }).run(err => {
            if(err) {
                return done(err);
            }

            s3Client = new AWS.S3({
                endpoint: `http://localhost:14569`,
                accessKeyId: "123",
                secretAccessKey: "abc",
                sslEnabled: false,
                s3ForcePathStyle: true,
            });

            done();
        });
    });

    after(done => {
        s3rverInstance.close(done);
    });

    describe('install', function () {
        this.timeout(40000);

        it('shoud pull node_modules from git repo', ()=> {
            return runBashTest('gitPull');
        });

        it('shoud push archive to git repo', () => {
            return runBashTest('gitPush');
        });

        it('shoud pull node_modules from local directory', () => {
            return runBashTest('localPull');
        });

        it('shoud copy archive to local directory', () => {
            return runBashTest('localPush');
        });

        it('shoud copy archive to local directory when used with lockfile', () => {
            return runBashTest('localPushWithPackageLock');
        });

        it('shoud pull node_modules from http server', () => {
            return runBashTest('httpPull');
        });

        describe('s3', () => {
            beforeEach(() => {
                return fsExtra.emptyDir(path.join(s3Dir, 'testbucket'));
            });

            it('shoud pull node_modules from s3 server', () => {
                return runBashTest('s3Pull');
            });

            it('shoud push node_modules to s3 server', () => {
                return runBashTest('s3Push');
            });
        });
    });

    describe('calc', function () {
        this.timeout(20000);

        it('shoud return hash on package.json', () => {
            return runBashTest('calcHashPlain');
        });

        it('shoud return hash on package.json + package-lock.json', () => {
            return runBashTest('calcHashWithPackageLock');
        });

        it('shoud return hash on package.json + npm-shrinkwrap.json', () => {
            return runBashTest('calcHashWithShrinkWrap');
        });

        xit('shoud return hash on package.json + yarn.lock', done => {
            runBashTest('calcHashWithYarnLock', done);
        });
    });
});

function runBashTest(testCase) {
    const testPromises = [];
    const remainingVersions = _.cloneDeep(NODE_VERSIONS);

    while (remainingVersions.length !== 0) {
        const nodeVersion = remainingVersions[0].nodeVersion;
        const npmVersion = remainingVersions[0].npmVersions[0];

        if (remainingVersions[0].npmVersions.length === 1) {
            remainingVersions.shift();
        } else {
            remainingVersions[0].npmVersions.shift();
        }

        testPromises.push(executeBashTest(testCase, nodeVersion, npmVersion));
    }
    return Promise.all(testPromises);
}

function executeBashTest(testCase, nodeVersion, npmVersion) {
    return new Promise((resolve, reject) => {
        const testDir = path.resolve(
            process.cwd(), 'tmp', 'test', 'integration', testCase, `${nodeVersion}-${npmVersion}`
        );

        const tmpDir = os.tmpdir();
        const cwdHash = crypto.createHash('sha1');
        cwdHash.update(testDir);
        const cacheDir = path.resolve(tmpDir, `veendor-${cwdHash.digest('hex')}`);

        return helpers
            .getOutput(
                'bash',
                [TEST_SCRIPT, testCase, testDir, cacheDir, nodeVersion, npmVersion],
                {timeoutDuration: 40000}
            ).then(() => {
                    resolve();
            }, error => {
                if (error.output) {
                    const outPath = path.resolve(testDir, 'output.txt');
                    fsExtra.ensureDirSync(testDir);
                    fsExtra.writeFileSync(outPath, error.output);
                    error.message += `. Output saved to ${outPath}`;
                }
                reject(error);
            });
    });

}
