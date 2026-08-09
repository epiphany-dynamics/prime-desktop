const test = require('node:test');
const assert = require('node:assert/strict');
const { isSessionBusy, prepareSessionHandoff } = require('../session-handoff');

test('busy sessions and attached sessions are protected', () => {
  assert.equal(isSessionBusy({ isStreaming: true }), true);
  assert.equal(isSessionBusy({ hasRunningRlmChildren: true }), true);
  assert.equal(isSessionBusy({ attachedClients: 1 }), true);
  assert.equal(isSessionBusy({ unfinishedActionCount: 0, attachedClients: 0 }), false);
});

test('an inactive saved session needs no handoff', async () => {
  let stopped = false;
  const result = await prepareSessionHandoff('/sessions/a.jsonl', {
    list: async () => [], stop: async () => { stopped = true; }, sleep: async () => {},
  });
  assert.deepEqual(result, { ok: true, handedOff: false });
  assert.equal(stopped, false);
});

test('an idle resident worker is stopped and released', async () => {
  let calls = 0;
  const resident = { activeSessionId: 'worker-1', sessionFile: '/sessions/a.jsonl' };
  const result = await prepareSessionHandoff('/sessions/a.jsonl', {
    list: async () => (++calls === 1 ? [resident] : []),
    stop: async (id) => assert.equal(id, 'worker-1'), sleep: async () => {},
  });
  assert.deepEqual(result, { ok: true, handedOff: true });
});

test('a working resident session is never interrupted', async () => {
  let stopped = false;
  const result = await prepareSessionHandoff('/sessions/a.jsonl', {
    list: async () => [{ activeSessionId: 'worker-1', sessionFile: '/sessions/a.jsonl', isRunningTools: true }],
    stop: async () => { stopped = true; }, sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /currently running/);
  assert.equal(stopped, false);
});
