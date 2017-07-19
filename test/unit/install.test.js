const {describe, it, beforeEach, afterEach} = require('mocha');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const mockfs = require('mock-fs');
const fsz = require('mz/fs');
const path = require('path');
const _ = require('lodash');

const install = require('../../lib/install');
const pkgJson = require('../../lib/pkgjson');
const gitWrapper = require('../../lib/commandWrappers/gitWrapper');
const npmWrapper = require('../../lib/commandWrappers/npmWrapper');
const backendsErrors = require('../../lib/backends/errors');

const assert = chai.assert;
chai.use(chaiAsPromised);

let PKGJSON;
let fakeSha1;
let sandbox;
let fakeBackends;

describe('install', () => {
    beforeEach(() => {
        mockfs();
        sandbox = sinon.sandbox.create();

        fakeBackends = [
            {
                backend: {
                    pull: _ => Promise.reject(new backendsErrors.BundleNotFoundError),
                    push: _ => Promise.resolve(),
                    validateOptions: _ => Promise.resolve()
                },
                options: {}
            },
            {
                backend: {
                    pull: _ => Promise.resolve(),
                    push: _ => Promise.resolve(),
                    validateOptions: _ => Promise.resolve()
                },
                options: {}
            },
        ];

        PKGJSON = {
            dependencies: {
                foo: '2.2.8',
                c: '2.2.9'
            },
            devDependencies: {
                baz: '6.6.6'
            }
        };

        fakeSha1 = '1234567890deadbeef1234567890';

    });

    afterEach(() => {
        mockfs.restore();
        sandbox.restore();
    });

    it('should fail if node_modules already exist', done => {
        mockfs({
            'node_modules': {},
            'package.json': JSON.stringify(PKGJSON)
        });

        const result = install({config: {}});

        assert.isRejected(result, install.NodeModulesAlreadyExistError).notify(done);
    });

    it('should delete node_modules, if force option is used', done => {
        mockfs({
            'node_modules': {},
            'package.json': JSON.stringify(PKGJSON)
        });

        const nodeModules = path.join(process.cwd(), 'node_modules');

        sandbox.spy(fsz, 'rmdir');

        const result = install({force: true, config: {backends: fakeBackends}}).then(() => {
            assert(fsz.rmdir.calledWith(nodeModules));
            done();
        }, done);
    });

    it('should fail if pkgJson is not supplied', done => {
        const result = install({config: {}});

        assert.isRejected(result).notify(done);
    });

    it('should call pkgjson with package.json contents first', done => {
        mockfs({
            'package.json': JSON.stringify(PKGJSON)
        });

        const pkgJsonMock = sandbox.mock(pkgJson).expects('calcHash').withArgs(PKGJSON);
        const checkResult = checkMockResult.bind(null, [pkgJsonMock], done);

        const result = install({config: {backends: fakeBackends}}).then(checkResult, checkResult);
    });

    it('should call `pull` on all backends until any backend succedes', done => {
        mockfs({
            'package.json': JSON.stringify(PKGJSON)
        });

        sandbox.stub(pkgJson, 'calcHash').returns(fakeSha1);

        const fakeBackends0Mock = sandbox.mock(fakeBackends[0].backend)
            .expects('pull')
            .withArgs(fakeSha1)
            .rejects(new backendsErrors.BundleNotFoundError);
        const fakeBackends1Mock = sandbox.mock(fakeBackends[1].backend)
            .expects('pull')
            .withArgs(fakeSha1)
            .resolves();

        const checkResult = checkMockResult.bind(null, [fakeBackends0Mock, fakeBackends1Mock], done);

        install({
            config: {backends: fakeBackends}
        }).then(checkResult, checkResult);
    });

    it('should pass options to `pull` on a backend', done => {
        mockfs({
            'package.json': JSON.stringify(PKGJSON)
        });

        sandbox.stub(pkgJson, 'calcHash').returns(fakeSha1);

        const fakeBackends0Mock = sandbox.mock(fakeBackends[0].backend)
            .expects('pull')
            .withArgs(sinon.match.any, sinon.match.same(fakeBackends[0].options))
            .rejects(new backendsErrors.BundleNotFoundError);
        const fakeBackends1Mock = sandbox.mock(fakeBackends[1].backend)
            .expects('pull')
            .withArgs(sinon.match.any, sinon.match.same(fakeBackends[1].options))
            .resolves();

        const checkResult = checkMockResult.bind(null, [fakeBackends0Mock, fakeBackends1Mock], done);

        install({
            config: {backends: fakeBackends}
        }).then(checkResult, checkResult);
    });

    it('should reject with BundlesNotFoundError if no backend succeded with pull', done => {
        mockfs({
            'package.json': JSON.stringify(PKGJSON)
        });

        sandbox.stub(pkgJson, 'calcHash').returns(fakeSha1);

        const result = install({
            config: {backends: [fakeBackends[0], fakeBackends[0]]}
        });

        assert.isRejected(result, install.BundlesNotFoundError).notify(done);
    });

    describe('_', () => {
        let fakePkgJson1;
        let fakePkgJson2;
        let pkgJsonStub;
        let gitWrapperOlderRevisionStub;
        let gitWrapperIsGitRepoStub;
        let npmWrapperStub;

        beforeEach(() => {
            mockfs({
                'package.json': JSON.stringify(PKGJSON)
            });

            fakePkgJson1 = _.cloneDeep(PKGJSON);
            fakePkgJson1.dependencies.c = '1.0.0';

            fakePkgJson2 = _.cloneDeep(PKGJSON);
            fakePkgJson2.dependencies.c = '2.1.8';

            pkgJsonStub = sandbox.stub(pkgJson, 'calcHash').callsFake(_pkgJson => {
                if (_.isEqual(_pkgJson, fakePkgJson1)) {
                    return 'fakePkgJson1Hash';
                } else if (_.isEqual(_pkgJson, fakePkgJson2)) {
                    return 'fakePkgJson2Hash';
                } else if (_.isEqual(_pkgJson, PKGJSON)) {
                    return 'PKGJSONHash';
                }

                throw new Error('Something is unmocked');
            });

            gitWrapperOlderRevisionStub = sandbox.stub(gitWrapper, 'olderRevision').callsFake((filename, age) => {
                if (age === 2) {
                    return Promise.resolve(JSON.stringify(fakePkgJson1));
                } else if (age === 3) {
                    return Promise.resolve(JSON.stringify(fakePkgJson2));
                }
            });

            gitWrapperIsGitRepoStub = sandbox.stub(gitWrapper, 'isGitRepo').callsFake(() => Promise.resolve());

            npmWrapperStub = sandbox.stub(npmWrapper, 'install').callsFake(() => Promise.resolve());
        });

        it('should look in useGitHistory.depth entries', (done) => {
            gitWrapperOlderRevisionStub.restore();
            const gitWrapperMock = sandbox.mock(gitWrapper);

            gitWrapperMock.expects('olderRevision')
                .withArgs(sinon.match(/package\.json$/), 2)
                .resolves(JSON.stringify(fakePkgJson1));

            gitWrapperMock.expects('olderRevision')
                .withArgs(sinon.match(/package\.json$/), 3)
                .resolves(JSON.stringify(fakePkgJson2));

            const result = install({
                config: {
                    backends: [fakeBackends[0]],
                    useGitHistory: {
                        depth: 2
                    }
                }
            });

            const checkResult = checkMockResult.bind(null, [gitWrapperMock], done);

            result.then(checkResult, checkResult);
        });

        it('should call pkgjson with older package.json revision', done => {
            pkgJsonStub.restore();
            const pkgJsonMock = sandbox.mock(pkgJson);

            pkgJsonMock.expects('calcHash').withArgs(PKGJSON).returns('PKGJSONHash');
            pkgJsonMock.expects('calcHash').withArgs(fakePkgJson1).returns('fakePkgJson1Hash');

            const checkResult = checkMockResult.bind(null, [pkgJsonMock], done);

            install({
                config: {
                    backends: [fakeBackends[0]],
                    useGitHistory: {
                        depth: 1
                    }
                }
            }).then(checkResult, checkResult);
        });

        it('should call `pull` on backends with gitWrapper.olderRevision\'s hash', done => {
            const backendMock = sandbox.mock(fakeBackends[0].backend);
            backendMock.expects('pull').withArgs('PKGJSONHash').rejects(new backendsErrors.BundleNotFoundError);
            backendMock.expects('pull').withArgs('fakePkgJson1Hash').resolves();

            const checkResult = checkMockResult.bind(null, [backendMock], done);

            install({
                config: {
                    backends: [fakeBackends[0]],
                    useGitHistory: {
                        depth: 1
                    }
                }
            }).then(checkResult, checkResult);
        });

        it('should not call gitWrapper.olderRevision if useGitHistory.depth is not defined', done => {
            gitWrapperOlderRevisionStub.restore();
            const gitWrapperMock = sandbox.mock(gitWrapper);

            gitWrapperMock.expects('olderRevision').never();

            const checkResult = checkMockResult.bind(null, [gitWrapperMock], done);

            install({
                config: {
                    backends: [fakeBackends[0]]
                }
            }).then(checkResult, checkResult);
        });

        it('should not call gitWrapper.olderRevision if not in git repo', done => {
            gitWrapperOlderRevisionStub.restore();
            gitWrapperIsGitRepoStub.restore();
            const gitWrapperMock = sandbox.mock(gitWrapper);

            gitWrapperMock.expects('isGitRepo').rejects(new gitWrapper.NotAGitRepoError);
            gitWrapperMock.expects('olderRevision').never();

            const checkResult = checkMockResult.bind(null, [gitWrapperMock], done);

            install({
                config: {
                    backends: [fakeBackends[0]],
                    useGitHistory: {
                        depth: 1
                    }
                }
            }).then(checkResult, checkResult);
        });

        it('should call `npmWrapper.install` with diff between package.json\'s ' +
            'after successful pull of history bundle', done => {
            const fakeBackend = {
                backend: {
                    pull: (hash) => {
                        if (hash === 'PKGJSONHash' || hash === 'fakePkgJson1Hash') {
                            return Promise.reject(new backendsErrors.BundleNotFoundError);
                        } else if (hash === 'fakePkgJson2Hash') {
                            return Promise.resolve();
                        } else {
                            throw new Error('Something is unmocked');
                        }
                    }
                }
            };

            npmWrapperStub.restore();
            const npmWrapperMock = sandbox.mock(npmWrapper);
            npmWrapperMock.expects('install').withArgs({c: '2.2.9'}).resolves();

            const checkResult = checkMockResult.bind(null, [npmWrapperMock], done);

            install({
                config: {
                    backends: [fakeBackend],
                    useGitHistory: {
                        depth: 2
                    }
                }
            }).then(checkResult, checkResult);
        });

        it('should call `npmWrapper.uninstall` for deleted modules', done => {
            delete PKGJSON.dependencies.c;

            mockfs({
                'package.json': JSON.stringify(PKGJSON)
            });

            const fakeBackend = {
                backend: {
                    pull: (hash) => {
                        if (hash === 'PKGJSONHash' || hash === 'fakePkgJson1Hash') {
                            return Promise.reject(new backendsErrors.BundleNotFoundError);
                        } else if (hash === 'fakePkgJson2Hash') {
                            return Promise.resolve();
                        } else {
                            throw new Error('Something is unmocked');
                        }
                    }
                }
            };

            npmWrapperStub.restore();
            const npmWrapperMock = sandbox.mock(npmWrapper);
            npmWrapperMock.expects('uninstall').withArgs(['c']).resolves();

            const checkResult = checkMockResult.bind(null, [npmWrapperMock], done);

            install({
                config: {
                    backends: [fakeBackend],
                    useGitHistory: {
                        depth: 2
                    }
                }
            }).then(checkResult, checkResult);
        });

        it('should call `push` on all backends with push: true option after partial npm install', done => {
            fakeBackends[0].push = true;

            fakeBackends[1].backend.pull = (hash) => {
                if (hash === 'PKGJSONHash' || hash === 'fakePkgJson1Hash') {
                    return Promise.reject(new backendsErrors.BundleNotFoundError);
                } else if (hash === 'fakePkgJson2Hash') {
                    return Promise.resolve();
                } else {
                    throw new Error('Something is unmocked');
                }
            };

            const backendMock0 = sandbox.mock(fakeBackends[0].backend);
            const backendMock1 = sandbox.mock(fakeBackends[1].backend);

            backendMock0.expects('push').withArgs('PKGJSONHash').resolves();
            backendMock1.expects('push').never();

            const checkResult = checkMockResult.bind(null, [backendMock0, backendMock1], done);

            install({
                config: {
                    backends: fakeBackends,
                    useGitHistory: {
                        depth: 2
                    }
                }
            }).then(checkResult, checkResult);
        });

        it('should pass options to `push`', done => {
            fakeBackends[0].push = true;
            fakeBackends[1].backend.pull = (hash) => {
                if (hash === 'PKGJSONHash' || hash === 'fakePkgJson1Hash') {
                    return Promise.reject(new backendsErrors.BundleNotFoundError);
                } else if (hash === 'fakePkgJson2Hash') {
                    return Promise.resolve();
                } else {
                    throw new Error('Something is unmocked');
                }
            };

            const backendMock0 = sandbox.mock(fakeBackends[0].backend);

            backendMock0
                .expects('push')
                .withArgs(sinon.match.any, sinon.match.same(fakeBackends[0].options))
                .resolves();

            const checkResult = checkMockResult.bind(null, [backendMock0], done);

            install({
                config: {
                    backends: fakeBackends,
                    useGitHistory: {
                        depth: 2
                    }
                }
            }).then(checkResult, checkResult);
        });

        xit('should not call `gitWrapper.olderRevision` if installDiffOnly is false');
        xit('should call `npmWrapper.installAll` if no backend succeded');
        xit('should not call `npmWrapper.installAll` if fallbackToNpm set to false');
        xit('should call `push` on all backends with push: true option after npm install');
        xit('failing to push on backends without pushMayFail === true should reject install');
        xit('failing to push on backends with pushMayFail === true should be ignored');
    });
});

function checkMockResult(mocks, done) {
    try {
        mocks.map(mock => mock.verify());
    } catch (error) {
        return done(error);
    }

    done();
}
