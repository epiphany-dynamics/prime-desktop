# Changelog

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
