# Prime Desktop

A native macOS desktop app for [Prime Agent](https://primeintellect.ai) — modeled after Hermes.app (Nous Research), skinned with the Linear desktop-app design system (dark-native `#08090a` canvas, fully achromatic — emphasis comes from white luminance steps, not hue; translucent white borders) and the official Prime butterfly mark (`assets/brand/prime-butterfly.svg` from PrimeIntellect-ai/prime-agent). Electron shell over `prime-agent --mode rpc`.

![stack](https://img.shields.io/badge/electron-35-blue) ![status](https://img.shields.io/badge/status-v0.1-green)

## Features

- **Sidebar session navigation** — every `~/.prime/agent/sessions/*.jsonl` session listed with name/preview, cwd, relative time, and message count; live-refreshes via `fs.watch`; filter box; hover-to-delete
- **Easy model switching** — searchable picker with all ~296 configured models grouped by provider; thinking-level picker alongside it
- **Streaming chat** — markdown rendering (marked + DOMPurify), collapsible thinking blocks, live tool-call cards with streaming output (bash, ipython, edits, etc.)
- **Steering** — type while the agent works to steer it; stop button aborts; queued-message hint
- **Session ops** — new chat (⌘N), switch, delete, context-window % and cost meter
- **Extension UI protocol** — confirm/select/input/editor dialogs from extensions render as native-feeling modals; notifications as banners
- **Crash resilience** — RPC process exit shows a banner with one-click restart

No voice integration, by design.

## Launch

The app is installed at `/Applications/Prime Agent.app`:

- **Spotlight**: ⌘Space → type "Prime Agent" → Enter
- **Finder**: Applications → Prime Agent (drag to Dock to pin it)
- **Terminal**: `open -a "Prime Agent"`

## Run from source

```bash
npm install
npm start            # dev
npm run smoke        # headless protocol self-test
npm run dist         # build dist/mac-arm64/Prime Agent.app
```

Requires `prime-agent` on PATH (auto-detects `~/.hermes/node/bin/prime-agent`).

## Dev hooks (env vars)

| Var | Effect |
|---|---|
| `SMOKE_TEST=1` | Headless: checks get_state / models / session listing, exits |
| `PRIME_DESKTOP_DEVTOOLS=1` | Open devtools detached |
| `PRIME_DESKTOP_CAPTURE=/path.png` | Screenshot the window after load |
| `PRIME_DESKTOP_EVAL="js"` | Run JS in the renderer after load (UI automation) |

## Architecture

```
main.js            Electron main: spawns `prime-agent --mode rpc`, strict JSONL framing
                   (LF-only splitting), request/response correlation, session-file scanner
preload.js         contextBridge: prime.command / listSessions / events
renderer/          sandboxed UI: sidebar, streaming chat, pickers, modals
```

The renderer never touches Node. All agent traffic flows:

```
renderer <--IPC--> main.js <--JSONL stdio--> prime-agent --mode rpc
```

## Notes

- **Mid-stream switching works**: the daemon keeps a switched-away session running in a resident worker. The app guards one upstream quirk — a brand-new session's file is flushed a few seconds after the first prompt, and switching away before that flush would orphan it — so a switch may pause briefly with "saving session before switching…".
- **Finder launches**: the app resolves `prime-agent` via explicit node + bundle path (`~/.local/lib/node_modules/prime-agent/dist/bundle/cli.js`), so it works from Spotlight/Finder where PATH is sparse.
- **Housekeeping**: empty sessions created by the app are deleted on quit. Double-click a session name in the sidebar to rename it.

## Known limitations (v0.2)

- No branch/tree view, no fork UI (RPC supports it — `fork`, `get_fork_messages`)
- No RLM subagent tree view (RPC `observe` command exists for this)
- Unsigned build: fine locally; for distribution add a Developer ID cert
