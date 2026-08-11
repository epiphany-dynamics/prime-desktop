"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSessionIndex } = require("../lib/session-index");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test("session index reads header without loading whole multi-mb body repeatedly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prime-session-index-"));
  const bigBody = Array.from({ length: 20000 }, (_, i) =>
    JSON.stringify({ type: "message", timestamp: new Date(Date.now() - i * 1000).toISOString(), message: { role: i % 2 ? "assistant" : "user", content: "x".repeat(200) } })
  ).join("\n");
  const file = path.join(root, "big.jsonl");
  write(file, [
    JSON.stringify({ type: "session", id: "sess-1", cwd: root, timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "session_info", name: "Big session" }),
    JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: "hello preview" } }),
    bigBody,
  ].join("\n"));

  const index = createSessionIndex({ sessionsRoot: root });
  const t0 = Date.now();
  const first = await index.list();
  const firstMs = Date.now() - t0;
  assert.equal(first.length, 1);
  assert.equal(first[0].name, "Big session");
  assert.match(first[0].preview || "", /hello preview/);
  assert.ok(first[0].messageCount > 1000);

  const t1 = Date.now();
  const second = await index.list();
  const secondMs = Date.now() - t1;
  assert.equal(second[0].id, "sess-1");
  // Cached path should be clearly faster / cheap.
  assert.ok(secondMs < 200, `cached list too slow: ${secondMs}ms`);
  assert.ok(firstMs < 5000, `initial list too slow: ${firstMs}ms`);
});

test("session index invalidate refreshes one file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prime-session-index-"));
  const file = path.join(root, "a.jsonl");
  write(file, [
    JSON.stringify({ type: "session", id: "a", cwd: root, timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "session_info", name: "Before" }),
    JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: "one" } }),
  ].join("\n"));
  const index = createSessionIndex({ sessionsRoot: root });
  assert.equal((await index.list())[0].name, "Before");
  // Ensure mtime changes on all filesystems.
  await new Promise((r) => setTimeout(r, 20));
  write(file, [
    JSON.stringify({ type: "session", id: "a", cwd: root, timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "session_info", name: "After" }),
    JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: "two" } }),
  ].join("\n"));
  index.invalidate("a.jsonl");
  assert.equal((await index.list())[0].name, "After");
});
