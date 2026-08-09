"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { tryAcquireFlag } = require("../lib/inflight-lock");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function guardedSend(owner, gate) {
  const release = tryAcquireFlag(owner, "sending");
  if (!release) throw new Error("already sending");
  try { await gate.promise; return "accepted"; }
  finally { release(); }
}

test("a rejected concurrent send cannot release the active sender's lock", async () => {
  const owner = { sending: false };
  const firstGate = deferred();
  const first = guardedSend(owner, firstGate);
  assert.equal(owner.sending, true);

  const rejectedGate = deferred();
  await assert.rejects(guardedSend(owner, rejectedGate), /already sending/);
  assert.equal(owner.sending, true, "the rejected contender does not own or clear the lock");
  await assert.rejects(guardedSend(owner, deferred()), /already sending/, "a third send stays blocked");

  firstGate.resolve();
  assert.equal(await first, "accepted");
  assert.equal(owner.sending, false);

  const finalGate = deferred();
  const final = guardedSend(owner, finalGate);
  finalGate.resolve();
  assert.equal(await final, "accepted");
});
