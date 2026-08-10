# Prime Desktop

**A native macOS app for [Prime Agent](https://primeintellect.ai).**  
Multi-pane chats, project folders, file tree, image paste, live daemon attach, and a floating HUD — without taking over the agent process.

Built by **[Epiphany Dynamics](https://epiphanydynamics.ai)**.

[![Electron](https://img.shields.io/badge/electron-35-blue)](#run-from-source)
[![Version](https://img.shields.io/badge/version-v0.6.2-green)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)](#run-from-source)

> Closing the app does **not** kill your agents. They keep running. Open Desktop again and reattach.

No voice features. That is on purpose.

---

## Why this exists

Prime Agent is strong in the terminal. Prime Desktop gives it a real Mac UI:

- two chats side by side
- attach to agents that are already running
- pick a project folder per chat
- paste images and drop files
- watch live workers and child sessions

Epiphany Dynamics built this client so teams can run serious agent work from a desktop shell that stays out of the agent’s way.

---

## Highlights (v0.6.2)

- **Split View** — one window, two panes. Sidebar clicks stay single-pane; split only when you ask.
- **Daemon attach** — find a live Prime Agent 0.7 session, join it, watch output, steer it, leave without stopping it.
- **Workers survive quit** — Desktop detaches on quit. Agents keep going.
- **Project-aware chats** — Choose Folder, recents, git branch/worktree identity, Cmd+O.
- **Safe file explorer** — lazy tree, ignores, symlink safety, preview, add-to-chat, reveal in Finder.
- **Attachments** — image paste/picker/drop (PNG/JPEG plus bounded GIF/WebP), file/folder/session chips.
- **Agents dashboard** — live workers, child sessions, related resident sessions.
- **Prime controls** — model and thinking pickers, stop/steer, context and cost, schedules, capabilities, settings, floating HUD.
- **Hard shell** — sandboxed UI, tight IPC, write-only API keys, blocked sensitive paths.

Deep status vs Hermes-style desktop goals: [`PARITY.md`](PARITY.md).  
How daemon attach works: [`DAEMON-ATTACHMENT.md`](DAEMON-ATTACHMENT.md).  
What changed lately: [`CHANGELOG.md`](CHANGELOG.md).

---

## Run from source

```bash
git clone https://github.com/epiphany-dynamics/prime-desktop.git
cd prime-desktop
npm install
npm test
npm run smoke
npm run ui-smoke   # macOS + Electron window checks
npm start
```

Build a local `.app` (unsigned):

```bash
npm run pack
# output: dist/mac-arm64/Prime Agent.app
```

Install that build into Applications (clean quit first; never force-kills agents):

```bash
./scripts/install-prime-desktop.sh
```

The app finds `prime-agent` on common install paths or `PATH`. Finder launches do not need your shell `PATH`.

### Requirements

- macOS
- Node.js 20+
- Optional for real use: [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) 0.7+

---

## Architecture (short)

```text
sandboxed UI  --tight IPC-->  Electron main  --attach-->  live daemon worker
                                   \-- RPC child -->  new / inactive session only
```

| Path | Role |
|---|---|
| `main.js` | Windows, panes, IPC, settings, HUD |
| `lib/rpc-manager.js` | Process RPC; detach-on-quit; kill only when asked |
| `lib/daemon-rpc-adapter.js` | Non-owning attach to resident Prime 0.7 sessions |
| `lib/workspace-service.js` | Projects, tree, search, watch |
| `lib/attachment-service.js` | Drafts, images, file refs |
| `preload.js` | Small bridge into the UI |
| `renderer/` | Multi-pane UI |
| `scripts/` | Fake agent + offline smoke tests |

The UI never gets raw shell or free disk power. File work uses opaque IDs from main.

---

## Offline checks

These need **no network and no API keys**:

```bash
npm test        # unit tests
npm run smoke   # protocol / fake agent
npm run ui-smoke
```

This org does not run GitHub Actions on this repo. Run the checks on your machine before you open a PR.

---

## Current limits

- macOS only; build is local and unsigned (Apple signing later)
- two panes max
- general files are local refs, not remote uploads
- one project folder per live agent client
- no session export, no full git branch manager, no in-app code editor yet
- voice will not be added

---

## Security

See [`SECURITY.md`](SECURITY.md).  
To report a security issue, email **security@epiphanydynamics.ai** — do not paste secrets into public issues.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

Small tested changes beat huge untested ones. Update `PARITY.md` when user-visible behavior changes.

---

## License

[MIT](LICENSE) © [Epiphany Dynamics](https://epiphanydynamics.ai)

Prime Desktop is an independent client. “Prime Agent” / “Prime Intellect” names belong to their owners. See [`NOTICE`](NOTICE).

---

## Links

- Epiphany Dynamics: [epiphanydynamics.ai](https://epiphanydynamics.ai)
- This repo: [github.com/epiphany-dynamics/prime-desktop](https://github.com/epiphany-dynamics/prime-desktop)
- Prime Agent: [primeintellect.ai](https://primeintellect.ai)
