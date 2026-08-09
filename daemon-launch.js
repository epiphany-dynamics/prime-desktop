// Stable daemon launch settings for GUI processes, whose TMPDIR may differ from shell clients.
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

function canonicalUserTempDir(options = {}) {
  const platform = options.platform || process.platform;
  const fallback = options.fallback || os.tmpdir();
  if (platform !== 'darwin') return fallback;
  try {
    const run = options.execFileSync || execFileSync;
    const value = run('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim();
    if (value) return path.resolve(value);
  } catch {}
  return path.resolve(fallback);
}

function primeDaemonLaunchConfig(options = {}) {
  const tempDir = canonicalUserTempDir(options);
  const uid = options.uid == null ? process.getuid() : options.uid;
  return {
    tempDir: tempDir.endsWith(path.sep) ? tempDir : tempDir + path.sep,
    socketPath: path.join(tempDir, `prime-agent-${uid}`, 'daemon.sock'),
  };
}

module.exports = { canonicalUserTempDir, primeDaemonLaunchConfig };
