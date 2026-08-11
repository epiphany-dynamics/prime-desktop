"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseRosterFile,
  listSubagentsForParent,
  mergeAgentLists,
  normalizeLiveChild,
  canonicalPrimeSessionPath,
} = require("../lib/subagent-roster");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test("parseRosterFile keeps latest row per childId", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prime-roster-"));
  const file = path.join(root, "rlm-subagents.jsonl");
  write(file, [
    JSON.stringify({ type: "rlm_subagent", childId: "sub-a", sessionName: "one", status: "running", sessionFile: path.join(root, "a.jsonl") }),
    JSON.stringify({ type: "rlm_subagent", childId: "sub-a", sessionName: "one", status: "done", sessionFile: path.join(root, "a.jsonl") }),
    JSON.stringify({ type: "rlm_subagent", childId: "sub-b", sessionName: "two", status: "running", sessionFile: path.join(root, "b.jsonl") }),
    "",
  ].join("\n"));
  const rows = parseRosterFile(file);
  assert.equal(rows.length, 2);
  const a = rows.find((row) => row.childId === "sub-a");
  assert.equal(a.status, "done");
});

test("listSubagentsForParent finds artifact children by parent session file", () => {
  const prime = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-dir-"));
  const parent = path.join(prime, "sessions", "parent.jsonl");
  write(parent, JSON.stringify({ type: "session", id: "parent-id", cwd: prime }) + "\n");
  const childFile = path.join(prime, "session-artifacts", "parent-id", "sub-abc", "child.jsonl");
  write(childFile, JSON.stringify({ type: "session", id: "child-id", cwd: prime, parentSession: parent, rlmDepth: 1 }) + "\n");
  const roster = path.join(prime, "session-artifacts", "parent-id", "rlm-subagents.jsonl");
  write(roster, JSON.stringify({
    type: "rlm_subagent",
    childId: "sub-abc",
    sessionName: "researcher",
    status: "running",
    sessionFile: childFile,
    parentSessionFile: parent,
    parentSessionId: "parent-id",
    model: "test-model",
    prompt: "Do the thing",
  }) + "\n");

  const agents = listSubagentsForParent(prime, { parentSessionPath: parent, parentSessionId: "parent-id" });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "researcher");
  assert.equal(agents[0].running, true);
  assert.equal(agents[0].sessionFile, fs.realpathSync(childFile));
});

test("canonicalPrimeSessionPath allows nested artifact child sessions only", async () => {
  const prime = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-dir-"));
  const top = path.join(prime, "sessions", "top.jsonl");
  write(top, "{}\n");
  const child = path.join(prime, "session-artifacts", "pid", "sub-1", "c.jsonl");
  write(child, "{}\n");
  const outside = path.join(prime, "session-artifacts", "pid", "not-sub", "x.jsonl");
  write(outside, "{}\n");

  assert.equal(await canonicalPrimeSessionPath(prime, top), fs.realpathSync(top));
  assert.equal(await canonicalPrimeSessionPath(prime, child), fs.realpathSync(child));
  await assert.rejects(() => canonicalPrimeSessionPath(prime, outside));
  await assert.rejects(() => canonicalPrimeSessionPath(prime, path.join(prime, "models.json")));
});

test("mergeAgentLists prefers live status and keeps roster session file", () => {
  const merged = mergeAgentLists(
    [{ id: "1", childId: "1", name: "A", status: "running", running: true, sessionFile: "/tmp/a.jsonl", source: "artifact-roster" }],
    [normalizeLiveChild({ id: "1", label: "A", status: "done", sessionDir: "/tmp", recap: "finished" })],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sessionFile, "/tmp/a.jsonl");
  assert.equal(merged[0].recap, "finished");
});

test("listSubagentsForParent finds roster when artifact dir uses header id not filename stem", () => {
  const prime = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agent-dir-"));
  const parent = path.join(prime, "sessions", "file-stem-aaaa.jsonl");
  write(parent, JSON.stringify({ type: "session", id: "header-id-bbbb", cwd: prime }) + "\n");
  const childFile = path.join(prime, "session-artifacts", "header-id-bbbb", "sub-abc", "child.jsonl");
  write(childFile, JSON.stringify({ type: "session", id: "child-id", cwd: prime, parentSession: parent, rlmDepth: 1 }) + "\n");
  const roster = path.join(prime, "session-artifacts", "header-id-bbbb", "rlm-subagents.jsonl");
  write(roster, JSON.stringify({
    type: "rlm_subagent",
    childId: "sub-abc",
    sessionName: "live-child",
    status: "running",
    sessionFile: childFile,
    parentSessionFile: parent,
    parentSessionId: "header-id-bbbb",
  }) + "\n");

  // Caller only knows the file path (stem differs from id) — must still find children.
  const agents = listSubagentsForParent(prime, { parentSessionPath: parent });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "live-child");
  assert.equal(agents[0].running, true);
});

test("mergeAgentLists does not let disk deleted clobber live running", () => {
  const merged = mergeAgentLists(
    [{ id: "1", childId: "1", name: "A", status: "deleted", running: false, sessionFile: "/tmp/a.jsonl", source: "artifact-roster" }],
    [{ id: "1", childId: "1", name: "A", status: "running", running: true, recap: "working", source: "live-snapshot" }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].running, true);
  assert.equal(merged[0].status, "running");
  assert.equal(merged[0].recap, "working");
});
