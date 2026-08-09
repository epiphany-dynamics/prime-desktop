#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { RpcManager } = require("../lib/rpc-manager");
const { WorkspaceService } = require("../lib/workspace-service");
const { AttachmentService } = require("../lib/attachment-service");

(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-desktop-smoke-"));
  const home = path.join(base, "home");
  const project = path.join(base, "project");
  fs.mkdirSync(home); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "fixture.txt"), "offline smoke fixture\n");
  const manager = new RpcManager({
    defaultCwd: home,
    resolveInvocation: () => ({ command: process.execPath, args: [path.join(__dirname, "fake-agent.js")] }),
    buildEnv: () => ({
      HOME: home,
      PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: process.env.SHELL || "/bin/zsh",
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      PRIME_DESKTOP_TEST_HOME: home,
    }),
    readyDeadlineMs: 5_000,
    readyProbeMs: 250,
    readyDelayMs: 20,
  });
  const workspace = new WorkspaceService({ homeDir: home, statePath: path.join(base, "workspaces.json"), watchFactory: null });
  try {
    const started = await manager.restart({ cwd: project });
    if (!started.ok || started.cwd !== fs.realpathSync(project)) throw new Error("RPC did not pin project cwd");
    const state = await manager.command({ type: "get_state" });
    const models = await manager.command({ type: "get_available_models" });
    if (!state.success || !models.success || models.data.models[0].provider !== "fixture") throw new Error("Offline RPC fixture failed");
    const active = await workspace.activatePath(project);
    const tree = await workspace.listDirectory({ workspaceId: active.workspaceId, generation: active.generation, nodeId: active.rootNodeId });
    if (!tree.ok || !tree.entries.some((entry) => entry.name === "fixture.txt")) throw new Error("Workspace tree failed");
    const attachments = new AttachmentService({ getWorkspace: () => workspace.describe() });
    const draft = attachments.createDraft();
    await attachments.ingestPaths({ draftId: draft.id, paths: [path.join(project, "fixture.txt")], source: "tree" });
    const sent = await attachments.sendDraft({ draftId: draft.id, text: "Inspect this fixture", behavior: "prompt" }, (command) => manager.command(command));
    if (!sent.accepted) throw new Error("Offline attachment prompt failed");
    console.log("SMOKE get_state: PASS");
    console.log("SMOKE project cwd: PASS");
    console.log("SMOKE file tree: PASS");
    console.log("SMOKE attachment transport: PASS");
    console.log("SMOKE OK");
  } finally {
    await manager.stop("smoke complete");
    workspace.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error("SMOKE FAIL", error.message);
  process.exit(1);
});
