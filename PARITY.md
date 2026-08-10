# Prime Desktop Hermes-Parity Matrix

Prime Desktop treats **Hermes desktop parity, minus voice**, as a standing product target. This file is the repository-local source of truth for what exists, what remains partial, and what is intentionally excluded. States describe this commit; they do not infer backend/provider success from visible UI strings.

## State vocabulary

- `done` — the core surface is implemented and covered by automated verification.
- `partial` — useful behavior exists, but material Hermes behavior remains.
- `next` — accepted direction, not implemented in this release.
- `unsupported` — not promised by the current public Prime Agent RPC contract.
- `excluded` — deliberately outside the product target.

## Matrix

| Surface | State | Prime Desktop v0.6.2 status | Remaining boundary |
|---|---|---|---|
| Chat rendering and streaming | done | Markdown, thinking, tool cards, prompt/steer/follow-up transport, stop, queue notices, attachment-only turns, and stick-to-bottom chat scrolling that unpins on user scroll-up and resticks at the bottom. | Richer artifact/tool renderers remain incremental. |
| Sessions and history | done | New/switch/delete/rename, pins, search, cwd-aware resume, non-owning attachment to terminal-resident Prime 0.7 daemon workers, in-flight snapshot hydration, draft-preserving recovery, per-session unsent composer memory, streaming-safe in-place navigation, serialized deletion, safe header validation, and history attachment reconstruction. Desktop quit/detach leaves workers running. | Export and branch-from-message remain `next`. |
| Concurrent panes | done | One BrowserWindow owns two visible side-by-side panes; persistent labeled topbar/menu/session controls, blank-chat split, streaming-safe routing, pop-outs, one shared connection per session, pane-scoped drafts, and independent project rebinding are verified. Sidebar session clicks never open split; Split View is explicit-only. Closing a split pane may leave a live reply running. The two-pane limit is explicit. | Persisted arbitrary split trees and more than two panes remain `next`, not part of the current two-pane contract. |
| Models and reasoning | done | Searchable provider/model and thinking-level controls with session fidelity. | Provider availability is backend-owned. |
| Provider settings | partial | Built-in/custom providers, masked key state, secret-preserving redacted edits, xAI device OAuth, write-only secret handling, and cwd/draft-preserving restart. | Broader account/gateway lifecycle remains `next`. |
| Image paste and image files | done | Paste, picker, and drop; byte sniffing; native PNG/JPEG decode plus bounded macOS GIF/WebP conversion; resize; thumbnails; removal; dedupe; caps; and exact bare-base64 Prime image RPC blocks. | Animated images intentionally normalize to one still PNG frame. Prime RPC publishes no server-side image limits, so the documented Desktop limits apply. |
| General file attachments | partial | Picker/drop/tree chips, workspace-relative and explicit external refs, exact structured transport parsing, dedupe/caps, and rejection retention. | Prime RPC has no generic upload object; refs require local file-tool access and are not remote uploads. |
| Folder and session references | partial | Workspace-folder and bounded session transcript context can be attached with pane-scoped chips. | Arbitrary external folder uploads and richer context objects are not supported by public RPC. |
| Project selection and recents | done | Obvious project button, native Choose Folder, merged recents, Cmd+O, opaque choice IDs, and per-pane transactional activation. | Multi-root workspaces remain `next`; one Prime runtime is pinned to one cwd. |
| Git branch/worktree selection | done | Branch/detached identity and linked-worktree choices use argument-array git calls. | Branch/worktree create/remove/mutation UI remains `next`. |
| File explorer | done | Root-confined lazy tree, ignores, symlink containment, cached opaque pagination, bounded watch refresh/degradation, preview, Add to chat, copy path, and Finder reveal. | Editing, rename/Trash, diffs, and terminal remain `next`. |
| Inline commands and references | done | Async-invalidated `/` command suggestions plus `@` workspace/session/folder suggestions with keyboard navigation. | A unified global Cmd+K/Cmd+P palette remains `next`. |
| Conversation branch/tree | partial | Existing tree/branch RPC compatibility and subagent/session context are preserved. | Full visual lineage navigation and fork workflows remain `next`. |
| Schedules and heartbeats | partial | Current RPC shapes render with create/edit/pause/resume/run/delete entry points. | Delivery/history depth and exhaustive error/status UX need further parity work. |
| Agents and messaging | partial | Agents dashboard lists live workers, child sessions, and related resident sessions; rows open a live transcript/viewer. Inline subagent summaries remain. | Full live nested worker lifecycle controls (create/stop/message graph admin) remain `next`. |
| Capabilities / skills / commands | partial | Discoverable capabilities panel, safe skill preview tokens, and public RPC command list. | Plugin/MCP lifecycle administration remains `next`. |
| HUD | done | A distinct frameless always-on-top BrowserWindow has an in-app button, dynamic Window menu action, checked global shortcut with accessible fallback, startup readiness queue, focused-session binding, live output, stop, and open-full-session actions. Dock activation ignores the hidden HUD. | Shared attachment/reference composition remains `next`. |
| Activity and usage | partial | Per-session context and cost appear in each pane. | Cross-session 7/30/90-day usage and system activity views remain `next`. |
| Notifications | partial | Inline banners, attachment errors, streaming state, and empty/loading/retry states. | Native completion/error notification preferences remain `next`. |
| Keybindings | partial | Cmd+N, Cmd+O, Cmd+Shift+A, settings, Split View/New Chat in Split, checked global HUD chord plus local fallback, Escape, tree keyboard/context actions, and menu accelerators. | Editable keybinding registry remains `next`. |
| Artifacts | next | Project preview is workspace-scoped, not a cross-session artifact index. | Add an artifact index with source-session linkage. |
| Export | next | No session export UI. | Add safe export formats and destinations. |
| Update / repair | partial | Agent install/repair/update and controlled restart surfaces are retained. Local `scripts/install-prime-desktop.sh` builds, clean-quits Desktop, installs the `.app`, and reopens without force-killing workers. | Signed app self-update/distribution remains incomplete. |
| Voice | excluded | No capture, dictation, wake word, TTS, or voice settings will be added for parity. | Deliberate product rule. |

## Current security and ownership boundary

The renderer is sandboxed and receives bounded descriptors or opaque IDs for filesystem authority. Main-process IPC validates the sender and DTO size; high-authority operations have dedicated handlers. Pane bindings use main-issued epochs; session/project changes and pane release are serialized and transactional, never mutate another pane's live client, and never reopen a canonical session until its prior TERM→KILL teardown is awaited. Filesystem, mounted-volume, macOS internal-volume and other broad roots, HOME, private credential paths, escaping symlinks, remote navigation, remote Markdown media, malformed attachment markers, and accidental dropped external files are denied.

Resident sessions add no renderer authority: Electron main loads Prime Agent's public ESM exports, discovers by canonical `sessionFile`, addresses the worker by daemon `activeSessionId`, and attaches with `sendClientEnv:false` and `ownedSession:false`. Every pane for that canonical session shares one Desktop adapter. Snapshot/cursor/replay handling remains inside `DaemonAgentConnection`; Desktop disposal detaches its client and never completes or stops the terminal-owned worker. Process-backed RPC is used only after discovery finds no resident match; those children spawn detached, and app quit / last-pane release detaches Desktop without SIGTERM so work can continue and reattach later. Deliberate restart still disposes workers. See [`DAEMON-ATTACHMENT.md`](DAEMON-ATTACHMENT.md).

Prime Agent 0.7.1 does not document attachment limits, so Desktop owns these limits: 20 MB and 36 megapixels per source image, normalization to at most 1568×1568 and under 4.5 MiB of base64, six images and 18 MiB normalized image base64 per draft, twenty file/context refs per draft, 200 visible file-tree entries per page, and bounded workspace search.
