# Prime Desktop

A native macOS Electron client for [Prime Agent](https://primeintellect.ai), with a dark desktop workflow modeled after Hermes. It attaches as a non-owning client to resident Prime Agent 0.7 daemon sessions and uses bounded `prime-agent --mode rpc` JSONL only for genuinely inactive/new sessions. It intentionally excludes voice.

The current Hermes-minus-voice contract and honest completion states live in [`PARITY.md`](PARITY.md). The resident-session ownership and command/event mapping are documented in [`DAEMON-ATTACHMENT.md`](DAEMON-ATTACHMENT.md).

![stack](https://img.shields.io/badge/electron-35-blue) ![status](https://img.shields.io/badge/status-v0.6.1-green)

## v0.6.1 highlights

- **Concurrent sessions** — one-window two-column Split View, persistent topbar/menu/session actions, blank-chat split, streaming-safe session-click routing, pop-outs, pane focus, and live event fanout when panes/windows view the same session.
- **Terminal session attachment** — discovers resident Prime Agent 0.7 sessions by canonical file, attaches through the public daemon connection without a second lease, hydrates in-flight output, controls the same worker, and detaches without stopping it.
- **Project-aware chats** — per-pane Choose Project, recents, linked Git worktrees/branch identity, Cmd+O, and cwd-pinned process/session activation.
- **Safe file explorer** — lazy ignored tree, symlink confinement, cached pagination, refresh watching, text preview, Add to chat, copy path, and Finder reveal.
- **Attachment drafts** — image paste/picker/drop with PNG/JPEG decode, bounded GIF/WebP conversion, resize, and caps; general-file, folder, and session references; atomic pane-scoped mutation; thumbnails/chips/removal; attachment-only turns; retention when a prompt is rejected.
- **Inline context** — keyboard-navigable `/` command and `@` workspace/session suggestions.
- **Prime controls** — model/thinking pickers, steering and stop, context/cost, schedules/heartbeats, capabilities, settings, and a discoverable floating HUD (in-app button, Window menu, and checked global shortcut).
- **Hardened boundaries** — sandboxed renderer, narrow sender-validated IPC, bounded DTOs/JSONL, write-only credentials, navigation denial, sensitive-path policy, transactional project changes, and awaited RPC teardown.

No voice integration, by design.

## Run from source

```bash
npm install
npm test
npm run smoke
npm run ui-smoke
npm run pack
npm start
```

The app locates `prime-agent` from standard local install paths or `PATH`. Finder/Spotlight launches do not depend on an interactive shell PATH.

## Architecture

```text
main.js               Electron authority boundary, pane/client routing, IPC, settings/HUD
lib/rpc-manager.js    generation-safe JSONL RPC and awaited TERM→KILL lifecycle
lib/daemon-rpc-adapter.js
                      non-owning Prime 0.7 daemon discovery/attach and RPC-shape adapter
lib/workspace-service.js
                      safe projects/worktrees, tree/search/watch/cache services
lib/attachment-service.js
                      draft ownership, image normalization policy, file/reference transport
lib/session-utils.js  canonical session validation and cleanup
preload.js            narrow pane-aware contextBridge
renderer/             sandboxed multi-pane UI and draft reducer
scripts/               offline fake agent plus protocol and Electron UI smoke tests
```

```text
sandboxed renderer <-- validated IPC --> Electron main <-- AgentConnection --> resident daemon worker
                                              \-- bounded JSONL --> inactive/new RPC session
```

The renderer does not receive arbitrary shell or filesystem APIs. Project/file operations use opaque pane, workspace, choice, and node IDs. User-selected external files are explicitly labeled; dropped files remain confined to the selected project.

## Offline verification

`npm run smoke` and `npm run ui-smoke` use `scripts/fake-agent.js`, an isolated temporary HOME, and local fixtures. They require no network or provider credentials. The UI smoke covers a visible one-window blank Split View, terminal-resident daemon discovery/attachment/live control, HUD/menu/shortcut-failure and Dock-reactivation fallbacks, project/worktree selection, streaming-safe normal-click session routing, shared-session pane and HUD fan-out/abort, busy/shared/inactive deletion safety, draft-preserving same-session restart, dedicated automation routing, PNG/GIF/WebP attachment flows, rejection retention, streaming/activation guards, saved-session workspace degradation, redacted-provider secret preservation, synthetic pathless-drop rejection, sandboxing, and navigation policy.

## Current limitations

- Two panes maximum (shown explicitly by disabled controls); arbitrary persisted split trees are not implemented.
- General files are local references, not remote uploads (Prime RPC has no generic file-upload object).
- One active cwd per RPC client; project switching starts/rebinds a client rather than mutating another live chat.
- Workspace editing/diffs, integrated terminals, session export, full branch management, and signed self-update remain future work.
- Unsigned local build; distribution requires Apple signing/notarization.
