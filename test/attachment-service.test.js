"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  AttachmentService,
  sniffImageMime,
  imageDimensions,
  buildFileTransport,
  parseFileTransport,
  TRANSPORT_START,
  TRANSPORT_END,
  TRANSPORT_LABEL,
} = require("../lib/attachment-service");
const { DraftState, sameBinding } = require("../renderer/draft-state");
const { canonicalSessionPath, validateSessionHeader, safeDeleteSession, cleanupTrackedEmptySessions, countSessionMessages, assertIdleState } = require("../lib/session-utils");

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-attachment-test-"));
  const workspaceRoot = path.join(base, "project");
  fs.mkdirSync(workspaceRoot);
  let workspace = { selected: true, workspaceId: "workspace-test", generation: 1, cwd: workspaceRoot };
  const service = new AttachmentService({
    getWorkspace: () => workspace,
    normalizeImage: async ({ buffer, mimeType, dimensions }) => ({
      buffer: Buffer.from(buffer), mimeType,
      width: dimensions && dimensions.width, height: dimensions && dimensions.height,
      previewBuffer: Buffer.from(buffer), previewMimeType: mimeType,
    }),
  });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, workspaceRoot, service, setWorkspace: (next) => { workspace = next; } };
}

test("sniffs supported image bytes instead of trusting extensions or MIME", () => {
  assert.equal(sniffImageMime(PNG_1X1), "image/png");
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 1])), "image/jpeg");
  assert.equal(sniffImageMime(Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "binary")), "image/gif");
  const webp = Buffer.alloc(16); webp.write("RIFF", 0); webp.write("WEBP", 8);
  assert.equal(sniffImageMime(webp), "image/webp");
  assert.equal(sniffImageMime(Buffer.from("not an image")), null);
});

test("reads dimensions before decode and rejects headers over the 36 MP limit", async (t) => {
  const f = fixture(t);
  const huge = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(huge);
  huge.write("IHDR", 12, "ascii");
  huge.writeUInt32BE(6_001, 16); huge.writeUInt32BE(6_001, 20);
  assert.deepEqual(imageDimensions(huge), { width: 6_001, height: 6_001 });
  assert.ok(6_001 * 6_001 > 36_000_000);
  const draft = f.service.createDraft();
  await assert.rejects(f.service.ingestClipboardImage({ draftId: draft.id, bytes: huge, name: "small-looking.png" }), (error) => {
    assert.equal(error.code, "IMAGE_DIMENSIONS");
    return true;
  });
});

test("image payloads use bare base64 and exact prompt/steer/follow_up contracts", async (t) => {
  const f = fixture(t);
  const draft = f.service.createDraft();
  const added = await f.service.ingestClipboardImage({ draftId: draft.id, bytes: PNG_1X1, name: "paste" });
  assert.equal(added.item.kind, "image");
  assert.match(added.item.previewDataUrl, /^data:image\/png;base64,/);
  for (const [behavior, type] of [["prompt", "prompt"], ["steer", "steer"], ["followUp", "follow_up"]]) {
    const serialized = f.service.serialize({ draftId: draft.id, text: "look", behavior });
    assert.equal(serialized.command.type, type);
    assert.deepEqual(Object.keys(serialized.command.images[0]), ["type", "data", "mimeType"]);
    assert.equal(serialized.command.images[0].type, "image");
    assert.equal(serialized.command.images[0].mimeType, "image/png");
    assert.equal(serialized.command.images[0].data, PNG_1X1.toString("base64"));
    assert.ok(!serialized.command.images[0].data.startsWith("data:"));
  }
});


test("normalization output cap and source-byte cap fail with app-owned plain errors", async (t) => {
  const f = fixture(t);
  const draft = f.service.createDraft();
  const normalizedTooLarge = Buffer.alloc(3_600_000);
  PNG_1X1.subarray(0, 24).copy(normalizedTooLarge);
  await assert.rejects(f.service.ingestClipboardImage({ draftId: draft.id, bytes: normalizedTooLarge, name: "large-normalized.png" }), (error) => error.code === "IMAGE_NORMALIZE_LIMIT");
  const sourceTooLarge = Buffer.alloc(20_000_001);
  PNG_1X1.subarray(0, 24).copy(sourceTooLarge);
  await assert.rejects(f.service.ingestClipboardImage({ draftId: draft.id, bytes: sourceTooLarge, name: "source-too-large.png" }), (error) => error.code === "IMAGE_TOO_LARGE");
});

test("image dedupe and app-owned six-image cap are deterministic", async (t) => {
  const f = fixture(t);
  const draft = f.service.createDraft();
  const first = await f.service.ingestClipboardImage({ draftId: draft.id, bytes: PNG_1X1, name: "first.png" });
  const duplicate = await f.service.ingestClipboardImage({ draftId: draft.id, bytes: PNG_1X1, name: "again.png" });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  for (let index = 1; index < 6; index += 1) {
    await f.service.ingestClipboardImage({ draftId: draft.id, bytes: Buffer.concat([PNG_1X1, Buffer.from([index])]), name: `image-${index}.png` });
  }
  await assert.rejects(f.service.ingestClipboardImage({ draftId: draft.id, bytes: Buffer.concat([PNG_1X1, Buffer.from([99])]), name: "seventh.png" }), (error) => error.code === "IMAGE_COUNT");
  assert.equal(f.service.describeDraft(draft.id).items.length, 6);
});

test("workspace and user-picked external files serialize with explicit scope and parse back into chips", async (t) => {
  const f = fixture(t);
  const inside = path.join(f.workspaceRoot, "src", "file name.txt");
  const outside = path.join(f.base, "external.txt");
  fs.mkdirSync(path.dirname(inside));
  fs.writeFileSync(inside, "inside\n");
  fs.writeFileSync(outside, "outside\n");
  const draft = f.service.createDraft();
  const added = await f.service.ingestPaths({ draftId: draft.id, paths: [inside, outside], source: "picker" });
  assert.equal(added.errors.length, 0);
  assert.equal(added.items.find((item) => item.name === "file name.txt").external, false);
  assert.equal(added.items.find((item) => item.name === "external.txt").external, true);
  const serialized = f.service.serialize({ draftId: draft.id, text: "inspect", behavior: "prompt" });
  assert.match(serialized.command.message, /Attached local files — use file tools to inspect/);
  assert.match(serialized.command.message, /src\/file name\.txt/);
  assert.match(serialized.command.message, /"scope":"external"/);
  const parsed = parseFileTransport(serialized.command.message);
  assert.equal(parsed.text, "inspect");
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files.filter((item) => item.external).length, 1);
  assert.ok(!parsed.text.includes(outside));
});

test("transport markers are deterministic and attachment-only file turns are sendable", async (t) => {
  const f = fixture(t);
  const file = path.join(f.workspaceRoot, "README.md"); fs.writeFileSync(file, "hi\n");
  const draft = f.service.createDraft();
  await f.service.ingestPaths({ draftId: draft.id, paths: [file], source: "tree" });
  const serialized = f.service.serialize({ draftId: draft.id, text: "", behavior: "prompt" });
  assert.ok(serialized.command.message.startsWith(TRANSPORT_START));
  assert.ok(serialized.command.message.endsWith(TRANSPORT_END));
  assert.deepEqual(parseFileTransport(serialized.command.message).files.map((item) => item.name), ["README.md"]);
  assert.equal(buildFileTransport("", []).trim(), "");
});

test("canonical path dedupe catches symlink aliases and missing-file errors reveal no path", async (t) => {
  const f = fixture(t);
  const original = path.join(f.workspaceRoot, "one.txt");
  const alias = path.join(f.workspaceRoot, "alias.txt");
  fs.writeFileSync(original, "one\n"); fs.symlinkSync(original, alias);
  const draft = f.service.createDraft();
  const result = await f.service.ingestPaths({ draftId: draft.id, paths: [original, alias], source: "picker" });
  assert.equal(result.items.length, 1);
  assert.equal(result.duplicates, 1);
  const missing = path.join(f.base, "private-name-that-must-not-leak.txt");
  const failed = await f.service.ingestPaths({ draftId: draft.id, paths: [missing], source: "picker" });
  assert.equal(failed.errors.length, 1);
  assert.ok(!failed.errors[0].error.includes(missing));
  assert.ok(!failed.errors[0].error.includes("private-name-that-must-not-leak"));
});

test("draft generation rejects late attachment work after project changes", async (t) => {
  const f = fixture(t);
  const draft = f.service.createDraft();
  f.setWorkspace({ selected: true, workspaceId: "other", generation: 2, cwd: f.workspaceRoot });
  await assert.rejects(f.service.ingestClipboardImage({ draftId: draft.id, bytes: PNG_1X1, name: "late.png" }), (error) => error.code === "STALE_DRAFT");
});

test("sendDraft reports rejection without deleting draft data", async (t) => {
  const f = fixture(t);
  const draft = f.service.createDraft();
  await f.service.ingestClipboardImage({ draftId: draft.id, bytes: PNG_1X1, name: "retain.png" });
  const rejected = await f.service.sendDraft({ draftId: draft.id, text: "", behavior: "prompt" }, async () => ({ success: false, error: "fixture rejection" }));
  assert.equal(rejected.accepted, false);
  assert.equal(f.service.describeDraft(draft.id).items.length, 1);
  const accepted = await f.service.sendDraft({ draftId: draft.id, text: "", behavior: "prompt" }, async () => ({ success: true }));
  assert.equal(accepted.accepted, true);
  assert.equal(f.service.describeDraft(draft.id).items.length, 1, "main rotates only after acceptance");
});

test("draft reducer retains text attachments on rejection and clears only on acceptance", () => {
  const state = new DraftState();
  state.reset({ id: "draft-a", workspaceGeneration: 1, items: [{ id: "file-a", kind: "file" }] });
  const send = state.beginSend();
  state.rejected(send, "offline");
  assert.equal(state.id, "draft-a");
  assert.equal(state.items.length, 1);
  assert.equal(state.error, "offline");
  const retry = state.beginSend();
  assert.equal(state.accepted(retry, { id: "draft-b", workspaceGeneration: 1, items: [] }), true);
  assert.equal(state.id, "draft-b");
  assert.deepEqual(state.items, []);
});

test("new/switch reset ignores late ingest results from the prior draft", () => {
  const state = new DraftState();
  state.reset({ id: "draft-a", workspaceGeneration: 1, items: [] });
  const receipt = state.beginIngest();
  state.reset({ id: "draft-b", workspaceGeneration: 1, items: [] });
  assert.equal(state.applyIngest(receipt, { items: [{ id: "leak" }] }), false);
  assert.deepEqual(state.items, []);
  state.reset({ id: "draft-c", workspaceGeneration: 2, items: [] });
  assert.equal(state.applyIngest(receipt, { items: [{ id: "cross-project" }] }), false);
});

test("streaming state blocks destructive session/project transitions with a stop instruction", () => {
  assert.throws(() => assertIdleState({ isStreaming: true }, "switching projects"), /Stop the current response before switching projects/);
  assert.equal(assertIdleState({ isStreaming: false }, "switching projects").isStreaming, false);
});

test("session header validation enforces direct canonical JSONL files and existing absolute cwd", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-session-test-"));
  const sessions = path.join(base, "sessions");
  const cwd = path.join(base, "project");
  fs.mkdirSync(sessions); fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(sessions, "session.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 1, id: "fixture", cwd }) + "\n");
  const verified = await validateSessionHeader(sessions, file);
  assert.equal(verified.header.cwd, fs.realpathSync(cwd));
  assert.equal(verified.sessionPath, fs.realpathSync(file));
  const future = path.join(sessions, "future.jsonl");
  fs.writeFileSync(future, JSON.stringify({ type: "session", version: 99, id: "future", cwd }) + "\n");
  await assert.rejects(validateSessionHeader(sessions, future), /not supported/);

  const prefix = path.join(base, "sessions-private"); fs.mkdirSync(prefix);
  const outside = path.join(prefix, "outside.jsonl"); fs.writeFileSync(outside, "{}\n");
  await assert.rejects(canonicalSessionPath(sessions, outside), /Invalid session/);
  await assert.rejects(canonicalSessionPath(sessions, path.join(sessions, "..", "sessions-private", "outside.jsonl")), /Invalid session/);
});

test("session deletion cannot follow a symlink outside the sessions root", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-session-delete-test-"));
  const sessions = path.join(base, "sessions"); fs.mkdirSync(sessions);
  const outside = path.join(base, "outside.jsonl"); fs.writeFileSync(outside, "keep\n");
  const alias = path.join(sessions, "alias.jsonl"); fs.symlinkSync(outside, alias);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  await assert.rejects(safeDeleteSession(sessions, alias), /Invalid session/);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");
});


test("drop confinement, sensitive picker denial, and HOME-relative external transport are explicit", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-attachment-policy-"));
  const home = path.join(base, "home");
  const workspaceRoot = path.join(base, "project");
  fs.mkdirSync(home); fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(path.join(home, ".ssh"));
  fs.mkdirSync(path.join(home, "Documents"));
  const privateFile = path.join(home, ".ssh", "id_rsa"); fs.writeFileSync(privateFile, "secret\n");
  const cloudCredentialFiles = [
    path.join(home, ".config", "gcloud", "application_default_credentials.json"),
    path.join(home, ".docker", "config.json"),
    path.join(home, ".config", "gh", "hosts.yml"),
    path.join(workspaceRoot, "my-service-account-key.json"),
  ];
  for (const file of cloudCredentialFiles) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "secret\n"); }
  const external = path.join(home, "Documents", "report.txt"); fs.writeFileSync(external, "report\n");
  const outside = path.join(base, "outside.txt"); fs.writeFileSync(outside, "outside\n");
  const inside = path.join(workspaceRoot, "inside.txt"); fs.writeFileSync(inside, "inside\n");
  const workspace = { selected: true, workspaceId: "workspace-policy", generation: 1, cwd: workspaceRoot };
  const service = new AttachmentService({ homeDir: home, getWorkspace: () => workspace });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const picker = service.createDraft();
  const pickerResult = await service.ingestPaths({ draftId: picker.id, paths: [external, privateFile], source: "picker" });
  assert.equal(pickerResult.items.length, 1);
  assert.equal(pickerResult.errors[0].code, "SENSITIVE_PATH");
  const serialized = service.serialize({ draftId: picker.id, text: "inspect", behavior: "prompt" });
  assert.match(serialized.command.message, /"path":"~\/Documents\/report\.txt"/);
  assert.ok(!serialized.command.message.includes(home));

  const cloudDraft = service.createDraft();
  const cloudDenied = await service.ingestPaths({ draftId: cloudDraft.id, paths: cloudCredentialFiles, source: "picker" });
  assert.equal(cloudDenied.items.length, 0);
  assert.deepEqual(cloudDenied.errors.map((error) => error.code), cloudCredentialFiles.map(() => "SENSITIVE_PATH"));

  const drop = service.createDraft();
  const dropResult = await service.ingestPaths({ draftId: drop.id, paths: [inside, outside, privateFile], source: "drop" });
  assert.deepEqual(dropResult.items.map((item) => item.name), ["inside.txt"]);
  assert.deepEqual(dropResult.errors.map((error) => error.code), ["OUTSIDE_PROJECT", "SENSITIVE_PATH"]);
});

test("transport parser accepts only the exact structured record schema", () => {
  const goodRecord = { name: "a.txt", path: "src/a.txt", scope: "workspace", size: 3, type: "text/plain" };
  const good = buildFileTransport("hello", [{ external: false, transportPath: "src/a.txt", name: "a.txt", size: 3, mimeType: "text/plain" }]);
  assert.deepEqual(parseFileTransport(good).files, [{ kind: "file", name: "a.txt", mimeType: "text/plain", size: 3, external: false }]);
  const manualCanonicalBlock = `${TRANSPORT_START}\n${TRANSPORT_LABEL}\n${JSON.stringify([goodRecord])}\n${TRANSPORT_END}`;
  assert.equal(parseFileTransport(manualCanonicalBlock).files.length, 1, "the canonical label reaches record validation");
  const forged = [
    [{ name: "a", path: "../a", scope: "workspace", size: 1, type: "text/plain" }],
    [{ name: "a", path: "/tmp/a", scope: "workspace", size: 1, type: "text/plain" }],
    [{ name: "a", path: "~/a", scope: "external", size: 1, type: "text/plain", extra: true }],
    [{ name: "a", path: "~/a", scope: "external", size: -1, type: "text/plain" }],
  ];
  for (const records of forged) {
    const block = `${TRANSPORT_START}\n${TRANSPORT_LABEL}\n${JSON.stringify(records)}\n${TRANSPORT_END}`;
    assert.deepEqual(parseFileTransport(block).files, []);
  }
});

test("folder and session references use the same structured draft lifecycle", async (t) => {
  const f = fixture(t);
  const folder = path.join(f.workspaceRoot, "src"); fs.mkdirSync(folder);
  const draft = f.service.createDraft();
  const folderAdded = await f.service.ingestReference({ draftId: draft.id, kind: "folder", name: "src", text: "Referenced workspace folder: src", dedupeKey: "folder:src" });
  const sessionAdded = await f.service.ingestReference({ draftId: draft.id, kind: "session", name: "Prior chat", text: "<referenced_session>fixture</referenced_session>", dedupeKey: "session:token" });
  assert.equal(folderAdded.item.kind, "folder");
  assert.equal(sessionAdded.item.kind, "session");
  const serialized = f.service.serialize({ draftId: draft.id, text: "compare", behavior: "prompt" });
  assert.match(serialized.command.message, /Referenced workspace folder: src/);
  assert.match(serialized.command.message, /<referenced_session>fixture<\/referenced_session>/);
});


test("empty-session cleanup deletes only explicitly tracked owned paths", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-session-cleanup-test-"));
  const sessions = path.join(base, "sessions"); fs.mkdirSync(sessions);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const header = (id) => JSON.stringify({ type: "session", version: 1, id, cwd: base }) + "\n";
  const trackedEmpty = path.join(sessions, "tracked-empty.jsonl"); fs.writeFileSync(trackedEmpty, header("tracked"));
  const untrackedEmpty = path.join(sessions, "untracked-empty.jsonl"); fs.writeFileSync(untrackedEmpty, header("untracked"));
  const trackedUsed = path.join(sessions, "tracked-used.jsonl"); fs.writeFileSync(trackedUsed, header("used") + JSON.stringify({ type: "message", message: { role: "user", content: "keep" } }) + "\n");
  const outside = path.join(base, "outside.jsonl"); fs.writeFileSync(outside, header("outside"));
  const deleted = await cleanupTrackedEmptySessions(sessions, [trackedEmpty, trackedUsed, outside, trackedEmpty], countSessionMessages);
  assert.deepEqual(deleted, [trackedEmpty]);
  assert.equal(fs.existsSync(trackedEmpty), false);
  assert.equal(fs.existsSync(untrackedEmpty), true);
  assert.equal(fs.existsSync(trackedUsed), true);
  assert.equal(fs.existsSync(outside), true);
});


test("concurrent image mutations enforce six-image limit and canonical hash dedupe", async (t) => {
  const f = fixture(t);
  const distinct = f.service.createDraft();
  const settled = await Promise.allSettled(Array.from({ length: 7 }, (_, index) =>
    f.service.ingestClipboardImage({ draftId: distinct.id, bytes: Buffer.concat([PNG_1X1, Buffer.from([index])]), name: `image-${index}.png` })));
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 6);
  assert.deepEqual(settled.filter((result) => result.status === "rejected").map((result) => result.reason.code), ["IMAGE_COUNT"]);
  assert.equal(f.service.describeDraft(distinct.id).items.length, 6);

  const identical = f.service.createDraft();
  const duplicates = await Promise.all(Array.from({ length: 3 }, () =>
    f.service.ingestClipboardImage({ draftId: identical.id, bytes: PNG_1X1, name: "same.png" })));
  assert.deepEqual(duplicates.map((result) => result.duplicate), [false, true, true]);
  assert.equal(f.service.describeDraft(identical.id).items.length, 1);
});

test("concurrent normalized images reserve the aggregate base64 budget", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-image-budget-test-"));
  const root = path.join(base, "project"); fs.mkdirSync(root);
  const workspace = { selected: true, workspaceId: "budget", generation: 1, cwd: root };
  const normalized = Buffer.alloc(3_000_000);
  PNG_1X1.copy(normalized);
  const service = new AttachmentService({
    getWorkspace: () => workspace,
    normalizeImage: async () => ({ buffer: Buffer.from(normalized), mimeType: "image/png", previewBuffer: PNG_1X1, previewMimeType: "image/png" }),
  });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const draft = service.createDraft();
  const settled = await Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
    service.ingestClipboardImage({ draftId: draft.id, bytes: Buffer.concat([PNG_1X1, Buffer.from([index])]), name: `budget-${index}.png` })));
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 4);
  assert.deepEqual(settled.filter((result) => result.status === "rejected").map((result) => result.reason.code), ["IMAGE_AGGREGATE"]);
  assert.equal(service.describeDraft(draft.id).items.length, 4);
});

test("files, folders, and sessions share one atomic twenty-reference budget", async (t) => {
  const f = fixture(t);
  const files = Array.from({ length: 12 }, (_, index) => {
    const file = path.join(f.workspaceRoot, `ref-${index}.txt`); fs.writeFileSync(file, String(index)); return file;
  });
  const draft = f.service.createDraft();
  const operations = [];
  for (let index = 0; index < 12; index += 1) {
    operations.push(f.service.ingestReference({ draftId: draft.id, kind: "session", name: `Session ${index}`, text: `session ${index}`, dedupeKey: `session:${index}` }));
    operations.push(f.service.ingestPaths({ draftId: draft.id, paths: [files[index]], source: "picker" }));
  }
  const settled = await Promise.allSettled(operations);
  const fileErrors = settled.filter((result) => result.status === "fulfilled" && result.value.errors).flatMap((result) => result.value.errors);
  const rejected = settled.filter((result) => result.status === "rejected").map((result) => result.reason);
  assert.equal(f.service.describeDraft(draft.id).items.length, 20);
  assert.equal(fileErrors.length + rejected.length, 4);
  assert.ok(fileErrors.every((error) => error.code === "FILE_COUNT"));
  assert.ok(rejected.every((error) => error.code === "FILE_COUNT"));
});

test("remove queues behind mutation, while draft rotation invalidates late normalization", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-mutation-order-test-"));
  const root = path.join(base, "project"); fs.mkdirSync(root);
  const workspace = { selected: true, workspaceId: "ordered", generation: 1, cwd: root };
  let normalizeCalls = 0;
  let releaseSecond;
  let enteredSecondResolve;
  const enteredSecond = new Promise((resolve) => { enteredSecondResolve = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const service = new AttachmentService({
    getWorkspace: () => workspace,
    normalizeImage: async ({ buffer, mimeType }) => {
      normalizeCalls += 1;
      if (normalizeCalls === 2) { enteredSecondResolve(); await secondGate; }
      return { buffer, mimeType, previewBuffer: buffer, previewMimeType: mimeType };
    },
  });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const draft = service.createDraft();
  const first = await service.ingestClipboardImage({ draftId: draft.id, bytes: PNG_1X1, name: "first.png" });
  const secondPending = service.ingestClipboardImage({ draftId: draft.id, bytes: Buffer.concat([PNG_1X1, Buffer.from([2])]), name: "second.png" });
  await enteredSecond;
  const removePending = service.remove({ draftId: draft.id, attachmentId: first.item.id });
  assert.equal(service.pendingMutationCount(draft.id), 2);
  releaseSecond();
  await secondPending;
  const removed = await removePending;
  assert.equal(removed.name, "first.png");
  assert.deepEqual(service.describeDraft(draft.id).items.map((item) => item.name), ["second.png"]);

  let lateRelease;
  let lateEnteredResolve;
  const lateEntered = new Promise((resolve) => { lateEnteredResolve = resolve; });
  const lateGate = new Promise((resolve) => { lateRelease = resolve; });
  const lateService = new AttachmentService({
    getWorkspace: () => workspace,
    normalizeImage: async ({ buffer, mimeType }) => { lateEnteredResolve(); await lateGate; return { buffer, mimeType, previewBuffer: buffer, previewMimeType: mimeType }; },
  });
  const lateDraft = lateService.createDraft();
  const pending = lateService.ingestClipboardImage({ draftId: lateDraft.id, bytes: PNG_1X1, name: "late.png" });
  await lateEntered;
  lateService.deleteDraft(lateDraft.id);
  lateRelease();
  await assert.rejects(pending, (error) => error.code === "STALE_DRAFT");
  assert.equal(lateService.describeDraft(lateDraft.id), null);
});

test("accepted sends seal a draft against late attachment mutation", async (t) => {
  const f = fixture(t);
  const draft = f.service.createDraft();
  await f.service.ingestClipboardImage({ draftId: draft.id, bytes: PNG_1X1, name: "sealed.png" });
  let accept;
  const response = new Promise((resolve) => { accept = resolve; });
  const sending = f.service.sendDraft({ draftId: draft.id, text: "send", behavior: "prompt" }, () => response);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.service.remove({ draftId: draft.id, attachmentId: f.service.describeDraft(draft.id).items[0].id }), (error) => error.code === "STALE_DRAFT");
  accept({ success: true });
  assert.equal((await sending).accepted, true);
  await assert.rejects(f.service.ingestClipboardImage({ draftId: draft.id, bytes: Buffer.concat([PNG_1X1, Buffer.from([9])]), name: "late.png" }), (error) => error.code === "STALE_DRAFT");
});


test("draft reducer blocks send while ingest is pending and ignores older revisions", () => {
  const state = new DraftState();
  state.reset({ id: "draft-r", workspaceGeneration: 1, revision: 0, items: [] });
  const first = state.beginIngest();
  const second = state.beginIngest();
  assert.equal(state.beginSend(), null);
  assert.equal(state.applyIngest(second, { draft: { id: "draft-r", workspaceGeneration: 1, revision: 2, items: [{ id: "new" }] } }), true);
  assert.equal(state.applyIngest(first, { draft: { id: "draft-r", workspaceGeneration: 1, revision: 1, items: [{ id: "old" }] } }), true);
  assert.deepEqual(state.items.map((item) => item.id), ["new"]);
  assert.equal(state.revision, 2);
  assert.ok(state.beginSend());
});


test("renderer IPC rejection fallback retains binding metadata and clears sending state", () => {
  const state = new DraftState();
  state.reset({ id: "draft-send", workspaceGeneration: 7, revision: 0, items: [] });
  const receipt = state.beginSend();
  assert.equal(state.sending, true);
  const binding = { key: "session-a", paneId: "pane-a", bindingEpoch: "epoch-a" };
  const fallback = { ...binding, ok: false, accepted: false, error: "IPC transport rejected" };
  assert.equal(sameBinding(binding, fallback), true);
  assert.equal(sameBinding(binding, { ok: false }), false, "the old metadata-free fallback would be ignored");
  assert.equal(state.rejected(receipt, fallback.error), true);
  assert.equal(state.sending, false);
  assert.equal(state.error, "IPC transport rejected");
});
