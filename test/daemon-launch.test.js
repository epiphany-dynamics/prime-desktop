const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalUserTempDir, primeDaemonLaunchConfig } = require('../daemon-launch');

test('macOS uses DARWIN_USER_TEMP_DIR instead of a Finder-style /tmp fallback', () => {
  const getconf = () => '/var/folders/example/T/\n';
  assert.equal(canonicalUserTempDir({ platform: 'darwin', fallback: '/tmp', execFileSync: getconf }), '/var/folders/example/T');
  assert.deepEqual(
    primeDaemonLaunchConfig({ platform: 'darwin', fallback: '/tmp', execFileSync: getconf, uid: 501 }),
    {
      tempDir: '/var/folders/example/T/',
      socketPath: '/var/folders/example/T/prime-agent-501/daemon.sock',
    },
  );
});

test('non-macOS platforms keep the runtime temp directory', () => {
  assert.equal(canonicalUserTempDir({ platform: 'linux', fallback: '/tmp' }), '/tmp');
});

test('getconf failure falls back safely', () => {
  const fail = () => { throw new Error('missing'); };
  assert.equal(canonicalUserTempDir({ platform: 'darwin', fallback: '/private/tmp', execFileSync: fail }), '/private/tmp');
});
