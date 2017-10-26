const gitWrapper = require('../../lib/commandWrappers/gitWrapper');
const helpers = require('../../lib/commandWrappers/helpers');
const testHelpers = require('./helpers');

const _ = require('lodash');

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');

const assert = chai.assert;
chai.use(chaiAsPromised);

let config;

describe('gitWrapper', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = sinon.sandbox.create();
    });

    afterEach(() => {
        sandbox.restore();
    });

    describe('.olderRevision', () => {
        it('should reject with TooOldRevisionError if file doen\'t have that amount of revisions', done => {
            sandbox.stub(helpers, 'getOutput').callsFake((executable, args) => {
                if (executable === 'git' && args.some(arg => arg === '--pretty=format:%h')) {
                    return Promise.resolve('43485c2\n8638279\n12312a\n1231241\n');
                }

                return Promise.reject(new Error(`mock me, bitch! args: ${args}`));
            });

            const result = gitWrapper.olderRevision(process.cwd(), 'test', 5);

            assert.isRejected(result, gitWrapper.TooOldRevisionError).notify(done);
        });

        it('should call git show with last line of git log output', done => {
            sandbox.stub(helpers, 'getOutput').callsFake((executable, args) => {
                if (executable === 'git' && args.some(arg => arg === '--pretty=format:%h')) {
                    return Promise.resolve('43485c2\n8638279\n');
                } else if (executable === 'git' && args[1] === 'show') {
                    assert.equal(args[2], '8638279:test');

                    done();
                    return Promise.resolve('ok');
                }

                return Promise.reject(new Error(`mock me, bitch! args: ${args}`));
            });

            gitWrapper.olderRevision(process.cwd(), 'test', 2);
        });

        it('should resolve with git show output', done => {
            sandbox.stub(helpers, 'getOutput').callsFake((executable, args) => {
                if (executable === 'git' && args.some(arg => arg === '--pretty=format:%h')) {
                    return Promise.resolve('43485c2\n8638279\n');
                } else if (executable === 'git' && args[1] === 'show') {
                    return Promise.resolve('this is elder file.\nShow some respect.\n');
                }

                return Promise.reject(new Error(`mock me, bitch! args: ${args}`));
            });

            const result = gitWrapper.olderRevision(process.cwd(), 'test', 2);
            assert.becomes(result, 'this is elder file.\nShow some respect.\n').notify(done);
        });
    });

    describe('tag', () => {
        it('should throw RefAlreadyExistsError when git output shows it', done => {
            sandbox.stub(helpers, 'getOutput').callsFake((executable, args) => {
                if (executable === 'git' && args[0] === 'tag') {
                    return Promise.reject(new helpers.CommandReturnedNonZeroError(
                        'Command [git tag] returned 1',
                        'fatal: tag \'veendor-32097f47c59765895b8b9d2002fe40ddc0de38bf-linux\' already exists'
                    ));
                }

                return Promise.reject(new Error(`mock me, bitch! args: ${args}`));
            });

            const result = gitWrapper.tag(process.cwd(), 'veendor-e00d8185b0bdb7f25d89e79ed779d0b6809bfcd0-linux');

            assert.isRejected(result, gitWrapper.RefAlreadyExistsError).notify(done);
        });
    });

    describe('push', () => {
        it('should throw RefAlreadyExistsError when git output shows it', done => {
            sandbox.stub(helpers, 'getOutput').callsFake((executable, args) => {
                if (executable === 'git' && args[0] === 'push') {
                    return Promise.reject(new helpers.CommandReturnedNonZeroError(
                        'Command [git push] returned 1',
                        'HEAD is now at 7b3abff Initial commit\n' +
                        'Git LFS: (1 of 1 files) 47.46 MB / 47.46 MB\n' +
                        'To git@github.com:mutantcornholio/veendor-cache.git\n' +
                        ' ! [rejected]        veendor-e00d8185b0bdb7f25d89e79ed779d0b6809bfcd0-linux' +
                        ' -> veendor-e00d8185b0bdb7f25d89e79ed779d0b6809bfcd0-linux (already exists)\n' +
                        'error: failed to push some refs to \'git@github.yandex-team.ru:market/veendor-cache.git\'\n' +
                        'hint: Updates were rejected because the tag already exists in the remote.'
                    ));
                }

                if (executable === 'git' && args[0] === 'remote') {
                    return Promise.resolve('origin');
                }

                return Promise.reject(new Error(`mock me, bitch! args: ${args}`));
            });

            const result = gitWrapper.push(process.cwd(), 'veendor-e00d8185b0bdb7f25d89e79ed779d0b6809bfcd0-linux');

            assert.isRejected(result, gitWrapper.RefAlreadyExistsError).notify(done);
        });
        
        it('should throw original generic error from git', done => {
            sandbox.stub(helpers, 'getOutput').callsFake((executable, args) => {
                if (executable === 'git' && args[0] === 'push') {
                    return Promise.reject(new testHelpers.AnError('test'));
                }

                if (executable === 'git' && args[0] === 'remote') {
                    return Promise.resolve('origin');
                }

                return Promise.reject(new Error(`mock me, bitch! args: ${args}`));
            });

            const result = gitWrapper.push(process.cwd(), 'veendor-e00d8185b0bdb7f25d89e79ed779d0b6809bfcd0-linux');

            assert.isRejected(result, testHelpers.AnError).notify(done);
        });
    });
});
