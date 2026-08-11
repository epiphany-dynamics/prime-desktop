# Changelog

## 0.6.5 — 2026-08-11

### Critical

- Sessions keep running when Desktop quits/restarts (resident daemon workers)
- Fixes false "not running" after UI reinstall/reopen
- Live Agents panel path retained from 0.6.4 work


## 0.6.4 — 2026-08-11

### Critical: sessions survive Desktop quit

- Desktop now creates **resident** daemon workers (not client-owned RPC)
- client_owned RPC was cleaned up ~30s after UI disconnect — that made sessions look "stopped"
- Quit still detaches only; workers stay under the Prime Agent daemon


### Critical

- Sub-agents appear in the **Agents** panel in near-real-time (no more ~60s wait)
- `rlm_child_update` events no longer buffered behind chat send
- Live child rows win over stale disk "deleted" roster rows
- 250ms poll while streaming / panel open + direct roster mtime watch

## 0.6.3 — 2026-08-11

### Ship readiness

- Sticky session-switch lock fixed (no more “wait for session change” brick)
- **Agents** button opens the panel immediately; sub-agents stay in the panel (not dumped into the main sidebar)
- Sub-agent lookup uses session **header id** (filename stem is often different)
- Faster session list (cached index) + progressive history load
- `npm run ship-check` full local gate
- Honest ship docs: `docs/KNOWN_LIMITS.md`, `docs/SHIP.md`
- Unsigned arm64 zip release artifact path

### Verification

- `npm run ship-check` (lint, tests, doctor, smoke, ui-smoke)

## 0.6.2 — 2026-08-10

### Highlights

- Closing Prime Desktop **detaches** from agents instead of stopping them. Live work keeps running; reopen the app to reattach.
- You can switch sessions and start a new chat while a reply is still streaming. The old chat keeps working in the background.
- Closing a split pane no longer demands that you stop the live reply first.
- Composer text is remembered per session when you navigate away and come back (until you send it).
- Chat view sticks to the latest output while you follow along, and lets go when you scroll up.
- New **Agents** dashboard: live workers, child sessions, and related resident sessions.
- Sidebar session clicks always stay single-pane. Split View only opens from the explicit split controls.
- Local install helper: `scripts/install-prime-desktop.sh` (build, clean quit, install into Applications, reopen).
- Open-source pack: MIT license, security notes, contributing guide, package metadata.


### Docs & first-run (flagship)

- Full install guide, troubleshooting, roadmap under `docs/`
- `npm run doctor` environment check
- Stronger README with hero, stranger install path, demo checklist
- First-run empty state with setup steps
- Code of conduct + support docs
- GitHub secret scanning enabled on the public repo

### Verification

- `npm test` — pass
- `npm run smoke` — pass
- `npm run ui-smoke` — pass

## 0.6.1

- Concurrent two-pane Split View
- Terminal-resident Prime Agent 0.7 daemon attachment
- Project-aware chats, safe file explorer, attachment drafts
- HUD, schedules, capabilities, hardened IPC boundaries
