// Safely release an idle session held by another daemon worker before switching.
const path = require('path');

function sameSessionFile(a, b) {
  return Boolean(a && b && path.resolve(a) === path.resolve(b));
}

function isSessionBusy(session) {
  return Boolean(
    session.isStreaming || session.isCompacting || session.isBashRunning ||
    session.isRunningTools || session.hasRunningRlmChildren ||
    Number(session.unfinishedActionCount || 0) > 0 ||
    Number(session.attachedClients || 0) > 0
  );
}

function findResidentSession(sessions, sessionPath) {
  return (sessions || []).find((session) =>
    session.activeSessionId && sameSessionFile(session.sessionFile, sessionPath));
}

async function prepareSessionHandoff(sessionPath, ops) {
  const resident = findResidentSession(await ops.list(), sessionPath);
  if (!resident) return { ok: true, handedOff: false };
  if (isSessionBusy(resident)) {
    return {
      ok: false,
      error: 'This session is currently running in another Prime Agent window. Wait for it to finish, then try again.',
    };
  }
  await ops.stop(resident.activeSessionId);
  const deadline = Date.now() + (ops.timeoutMs || 5000);
  while (Date.now() < deadline) {
    await ops.sleep(150);
    if (!findResidentSession(await ops.list(), sessionPath)) return { ok: true, handedOff: true };
  }
  return { ok: false, error: 'The existing session worker did not release the session in time.' };
}

module.exports = { findResidentSession, isSessionBusy, prepareSessionHandoff };
