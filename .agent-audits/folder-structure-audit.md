# Folder Structure Audit — prime-desktop

**Scope:** Structural / folder audit only (no source modifications)  
**Path:** `/Users/epiphanydynamics/Projects/prime-desktop`  
**Commit audited:** `c2dd481` (`main` — *release: v0.6.3 early public ship pack*)  
**Package version:** `0.6.3`  
**Date:** 2026-08-11  
**Working-tree size on disk:** ~7.2 GB (dominated by local `.worktrees/` + `node_modules/` + `dist/`)  
**Git-tracked files:** 87

---

## 1. Structure overview

### 1.1 Top-level map

```text
prime-desktop/
├── .agent-audits/          # local agent audit outputs (empty before this report; not gitignored)
├── .git/
├── .github/                # issue + PR templates only (no workflows)
│   ├── ISSUE_TEMPLATE/
│   └── pull_request_template.md
├── .worktrees/             # 8 nested git worktrees (~6.3 GB) — gitignored
├── build/                  # macOS app icon source assets (tracked)
│   ├── icon.icns
│   └── icon.iconset/       # 10 PNG sizes
├── dist/                   # electron-builder output (~346 MB) — gitignored
│   ├── mac-arm64/Prime Agent.app/
│   ├── Prime Agent-0.6.3-arm64.zip
│   └── builder-*.yml, latest-mac.yml, *.blockmap
├── docs/                   # user/install/ship docs + marketing assets
│   ├── assets/
│   ├── INSTALL.md
│   ├── KNOWN_LIMITS.md
│   ├── ROADMAP.md
│   ├── SHIP.md
│   └── TROUBLESHOOTING.md
├── lib/                    # main-process domain modules (12 JS files)
├── node_modules/           # deps (~555 MB) — gitignored
├── renderer/               # sandboxed UI (HTML/CSS/JS + asset)
├── scripts/                # doctor, smokes, lint, ship-check, install, icon tooling
├── test/                   # node:test unit/integration tests (16 files)
├── main.js                 # Electron main entry (~91 KB / ~1951 lines)
├── preload.js              # contextBridge IPC surface
├── daemon-launch.js        # daemon socket path helper (GUI TMPDIR)
├── package.json / package-lock.json
├── .gitignore / .nvmrc / .editorconfig
└── community + product docs (README, PARITY, DAEMON-ATTACHMENT, CHANGELOG, …)
```

### 1.2 Major directories and purpose

| Path | Purpose | Notes |
|---|---|---|
| `main.js` (root) | Electron **main process**: windows, menus, IPC, session/pane lifecycle, settings, HUD, agent spawn/attach | Monolith; requires all of `lib/*` + `daemon-launch.js` |
| `preload.js` (root) | Sandboxed **preload bridge** exposing `window.prime` via `contextBridge` | Paired with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| `daemon-launch.js` (root) | Resolves macOS `DARWIN_USER_TEMP_DIR` + daemon socket path so GUI and shell clients agree | Small, tested (`test/daemon-launch.test.js`) |
| `lib/` | Main-process services extracted from main: RPC, daemon attach, workspace FS, attachments, sessions, subagents, nav policy, secrets | 12 modules; most have dedicated tests |
| `renderer/` | UI layer: multi-pane chat shell + floating HUD | Loads `marked` / `DOMPurify` from `../node_modules` in dev; packaged via electron-builder `files` |
| `scripts/` | Dev/QA/release tooling (not shipped in the app bundle except indirectly via npm scripts) | Includes fakes for offline smoke |
| `test/` | `node --test` suite (`npm test`) | Covers lib + CSS/HUD/security boundaries |
| `build/` | **Source** icon assets for electron-builder (`build.mac.icon`) | Tracked on purpose (not a compile output) |
| `dist/` | Packaged `.app`, zip, blockmap, builder metadata | Local artifact; gitignored |
| `docs/` | Stranger install path, troubleshooting, known limits, roadmap, ship checklist | Solid open-source docs surface |
| `.github/` | Bug/feature issue templates + PR checklist | **No** `.github/workflows` (matches CONTRIBUTING: local gate only) |
| `.worktrees/` | Nested `git worktree` checkouts from agent feature branches | Gitignored; each still holds its own `node_modules` + `dist` + `build` |

### 1.3 Key entry / launch graph

```text
npm start  →  electron .  →  package.json "main": "main.js"
                                │
                                ├─ require('./daemon-launch')
                                ├─ require('./lib/*')  (rpc, daemon, workspace, attachments, …)
                                ├─ BrowserWindow(main)  loadFile(renderer/index.html)
                                │     webPreferences.preload = preload.js
                                │     renderer: draft-state.js + app.js (+ marked, DOMPurify)
                                └─ BrowserWindow(HUD)   loadFile(renderer/hud.html)
                                      same preload; hud.js

Agent connectivity (from main, not renderer):
  1. Prefer non-owning attach via lib/daemon-rpc-adapter.js
     (Prime Agent 0.7 DaemonClient / socket from daemon-launch.js)
  2. Else spawn detached `prime-agent --mode rpc` via lib/rpc-manager.js
```

**Packaged app:** `npm run pack` / `npm run dist` → electron-builder → `dist/`  
**Local Applications install:** `./scripts/install-prime-desktop.sh` (runs `npm run pack`, clean-quits UI, copies `.app`).

### 1.4 `package.json` scripts, engines, build

| Field | Value |
|---|---|
| `name` / `version` | `prime-desktop` / `0.6.3` |
| `main` | `main.js` |
| `engines.node` | `>=20` (matches `.nvmrc` → `20`) |
| Runtime deps | `marked`, `dompurify` |
| Dev deps | `electron` ^35, `electron-builder` ^25 |

**Scripts:**

| Script | Command | Role |
|---|---|---|
| `start` | `electron .` | Dev launch |
| `test` | `node --test test/*.test.js` | Unit/contract tests |
| `smoke` | `node scripts/smoke.js` | Protocol checks w/ fake agent |
| `ui-smoke` | `ui-smoke.js && window-smoke.js` | Real Electron window checks |
| `doctor` | `node scripts/doctor.js` | Env / prime-agent presence |
| `lint` | `node scripts/lint.js` | Lightweight custom lint (not ESLint) |
| `ship-check` | `node scripts/ship-check.js` | Full local release gate |
| `pack` | `electron-builder --dir` | Unpacked `.app` |
| `dist` | `electron-builder --mac` | arm64 zip (+ dir) |
| `postinstall` | console hint → doctor + docs/INSTALL.md | First-run nudge |

**electron-builder `build.files` (what ships inside the app):**  
`main.js`, `daemon-launch.js`, `lib/**/*`, `preload.js`, `renderer/**/*`, plus `marked` + `dompurify` from `node_modules`.  
Explicitly **excludes** `scripts/`, `test/`, `docs/`, root markdown, etc. — appropriate.

**mac targets:** zip + dir, **arm64 only**, `identity: null` (unsigned), icon `build/icon.icns`, `appId` `ai.primeintellect.prime-desktop`, product name **Prime Agent**.

### 1.5 `lib/` modules (actual)

| Module | Role (from naming + main requires) |
|---|---|
| `rpc-manager.js` | Process-backed JSONL RPC clients; detach-on-quit |
| `daemon-rpc-adapter.js` | Non-owning daemon attach / resident session discovery |
| `workspace-service.js` | Project cwd, file tree, search, watch |
| `attachment-service.js` | Draft attachments, images, file/context refs |
| `electron-image-normalizer.js` | Native-image decode/resize path |
| `session-utils.js` | Canonical paths, header validation, safe delete |
| `session-index.js` | Cached session list / progressive history support |
| `session-lifecycle.js` | Pane/session lifecycle registry |
| `subagent-roster.js` | Agents panel roster merge (artifacts + live children) |
| `navigation-policy.js` | Renderer navigation lockdown |
| `inflight-lock.js` | Simple concurrency flag helper |
| `config-secrets.js` | Secret-preserving provider config edits |

### 1.6 `renderer/` layout

```text
renderer/
├── index.html      # main multi-pane shell
├── app.js          # ~134 KB / ~2994 lines — primary UI logic
├── draft-state.js  # per-session composer draft helper
├── styles.css      # ~40 KB
├── hud.html / hud.js
└── assets/prime-butterfly.svg
```

### 1.7 Docs vs layout alignment

| Doc | Present | Matches layout? |
|---|---|---|
| `README.md` | Yes | Architecture table lists main entry points accurately; omits several `lib/*` modules and `daemon-launch.js` (acceptable high-level map) |
| `CONTRIBUTING.md` | Yes | Setup/scripts match `package.json`; correctly states no GitHub Actions |
| `SECURITY.md` / `SUPPORT.md` / `CODE_OF_CONDUCT.md` | Yes | Paths and commands valid |
| `PARITY.md` | Yes | Feature SSOT; **column still says “v0.6.2 status” while package is 0.6.3** |
| `DAEMON-ATTACHMENT.md` | Yes | Root-level contract doc; linked from README |
| `CHANGELOG.md` | Yes | 0.6.3 present |
| `docs/INSTALL.md`, `TROUBLESHOOTING.md`, `ROADMAP.md`, `KNOWN_LIMITS.md`, `SHIP.md` | Yes | Paths/commands generally match; see issues |
| `LICENSE` + `NOTICE` | Yes | MIT + trademark disclaimer |
| `.github` templates | Yes | Check commands match scripts |
| CI workflows | **No** | Intentional per CONTRIBUTING |

README-linked community docs are complete. No orphan root `*.md` relative to README (all eight root markdown files are part of the published surface).

---

## 2. Issues (by severity)

### Critical / high

1. **Nested worktrees balloon the project tree (~6.3 GB, 8 checkouts)**  
   - Path: `.worktrees/` (gitignored — good)  
   - Each worktree is a near-full clone-of-checkout with its own `node_modules/` (~300+ packages), `dist/mac-arm64/Prime Agent.app`, and `build/` icons.  
   - Names (all dated `2026-08-09-*`): `composer-parity`, `daemon-attach-verifier`, `fix-session-switch`, `multipane`, `v06-workspace-integration`, `v06-workspace-verifier`, `v06-workspace-verifier-340c019`, `workspace-parity`.  
   - Several are **detached HEAD** leftover verifier trees.  
   - **Impact:** disk pressure, slow full-tree searches/backups, agent confusion if tools walk into `.worktrees/` despite gitignore, stale code that looks like “another copy of the app.”  
   - **Not a git leak** (ignored), but a **local workspace hygiene** problem.

2. **In-tree packaging artifacts present locally (`dist/` ~346 MB)**  
   - Includes `Prime Agent-0.6.3-arm64.zip` (~98 MB), unpacked `mac-arm64/Prime Agent.app` (~248 MB), blockmap, builder yml.  
   - Correctly **gitignored**. Safe for git; still clutter for local audits and Time Machine-style backups.

### Medium

3. **God-files at the architectural center**  
   - `main.js` ~91 KB / ~1951 lines  
   - `renderer/app.js` ~134 KB / ~2994 lines  
   - `scripts/ui-smoke.js` ~35 KB  
   - Structure is “flat Electron classic” rather than `src/main`, `src/renderer`, feature folders. Works for v0.6 but is a maintainability hotspot; new contributors must treat two megamonoliths as the app.

4. **README architecture map is incomplete relative to real `lib/`**  
   - Documents: `rpc-manager`, `daemon-rpc-adapter`, `workspace-service`, `attachment-service`.  
   - Omits (now material): `session-index`, `subagent-roster`, `session-lifecycle`, `session-utils`, `electron-image-normalizer`, `navigation-policy`, `config-secrets`, `inflight-lock`, plus root `daemon-launch.js`.  
   - Not wrong, but the map under-sells where Agents panel / session cache live.

5. **`PARITY.md` version label lag**  
   - Matrix header: “Prime Desktop **v0.6.2** status” while `package.json` / CHANGELOG are **0.6.3**.  
   - Risk: external readers think parity text is one release behind (even if content was updated in place).

6. **`docs/SHIP.md` hardcodes a machine-absolute path**  
   - `cd /Users/epiphanydynamics/Projects/prime-desktop`  
   - Fine as a Patrick-private checklist, odd for a public OSS repo (leaks local layout; breaks copy-paste for strangers). Prefer `cd` to repo root via relative instructions.

7. **`.agent-audits/` not gitignored**  
   - Currently empty of tracked files; this audit will live there.  
   - If agents keep writing reports, they can be accidentally `git add`ed unless ignored (or the directory is documented as local-only).

8. **Duplicate brand asset**  
   - `docs/assets/prime-butterfly.svg` and `renderer/assets/prime-butterfly.svg` (same role).  
   - Also `docs/assets/app-icon.png` overlaps conceptually with `build/icon.iconset` mid sizes.  
   - Low risk; minor drift hazard.

9. **No CI workflows under `.github/workflows/`**  
   - Documented as intentional (“No GitHub Actions on this org for this repo”).  
   - Still a structural gap for public contributors: quality depends entirely on local `ship-check`. Flag as **accepted risk**, not an accident.

### Low

10. **Custom `scripts/lint.js` instead of standard ESLint/Prettier configs**  
    - No `.eslintrc` / `eslint.config.js` / `.prettierrc`.  
    - OK for a small repo; contributors may expect standard tooling.

11. **No TypeScript / no `src/` package layout**  
    - Plain CommonJS JS at repo root. Consistent and simple; not a defect for this product stage.

12. **`.DS_Store` at repo root**  
    - Gitignored; local Finder noise only.

13. **`.gitignore` is minimal but mostly sufficient**  
    - Covers: `node_modules/`, `dist/`, `.DS_Store`, logs, `.env*`, `coverage/`, `test-results/`, `.worktrees/`.  
    - Missing candidates: `.agent-audits/`, maybe `*.blockmap` if ever emitted outside `dist/`, editor folders (none present today).  
    - `build/` correctly **not** ignored (icon sources are tracked).

14. **`build/` naming can confuse**  
    - In many Electron apps `build/` means generated output; here it means **static icon inputs**. electron-builder convention supports this (`directories.buildResources` defaulting patterns), and `directories.output` is correctly `dist`. Worth a one-line README note to avoid “should this be gitignored?” churn.

15. **Worktree fossils differ from main layout**  
    - Older worktrees still have root `session-handoff.js` / thinner `lib/` / missing modules — expected for historical branches, but reinforces that **only the primary tree is SSOT**.

16. **Empty directory before audit write**  
    - `.agent-audits/` was empty; now holds this report. Not a product issue.

17. **Test naming minor asymmetry**  
    - `electron-image-normalizer.js` ↔ `image-normalizer.test.js` (not `electron-image-normalizer.test.js`).  
    - `session-utils.js` has no same-stem test file (may be covered indirectly). Cosmetic.

18. **Product name vs package name**  
    - npm/package: `prime-desktop`; app productName: `Prime Agent`; folder: `prime-desktop`.  
    - Documented; can still confuse “which binary name am I looking for?” in `dist/` and `/Applications`.

### What is *not* an issue

- Root-level `main.js` / `preload.js` for a focused Electron client is a valid, conventional layout.  
- Tracking `build/icon.icns` + iconset is correct for reproducible `electron-builder` packs.  
- Ignoring `dist/` and `.worktrees/` is correct.  
- Shipping only allowlisted `build.files` is correct and tight.  
- Community OSS scaffolding (LICENSE, NOTICE, SECURITY, SUPPORT, CODE_OF_CONDUCT, CONTRIBUTING, issue/PR templates) is unusually complete for the repo size.  
- Docs paths referenced from README resolve to real files.

---

## 3. Build / dist artifacts and gitignore verdict

| Artifact | On disk | Gitignored? | Tracked? | Verdict |
|---|---|---|---|---|
| `node_modules/` | Yes (~555 MB) | Yes | No | Correct |
| `dist/` (app, zip, yml, blockmap) | Yes (~346 MB) | Yes | No | Correct — safe to delete anytime; regenerate via `npm run pack` / `dist` |
| `.worktrees/**/node_modules` + `dist` | Yes (~6.3 GB total trees) | Parent `.worktrees/` ignored | No | Correct for git; **prune locally** |
| `build/icon.icns` + `icon.iconset/*` | Yes (~1.1 MB) | No | **Yes** | Correct — these are **source** packaging inputs, not build output |
| `.DS_Store` | Yes (root) | Yes | No | Correct |
| `.agent-audits/` | Yes (this report) | **No** | No (yet) | **Should gitignore** if audits stay local |
| `coverage/`, `test-results/` | Absent | Yes | No | Correct preemptively |
| `.env*` | Absent | Yes | No | Correct |

**Recommendation:** Do not commit `dist/` or worktree contents. Optionally add `.agent-audits/` to `.gitignore`. Local cleanup of stale worktrees would reclaim ~6 GB.

---

## 4. Docs vs actual layout — gap list

| Claim / expectation | Actual | Gap? |
|---|---|---|
| README architecture paths | Exist | No |
| `docs/*` links from README | All exist | No |
| CONTRIBUTING scripts | Match `package.json` | No |
| “No GitHub Actions” | No workflows dir | Intentional |
| Install script path `scripts/install-prime-desktop.sh` | Exists | No |
| PARITY as feature SSOT | Present | Version label 0.6.2 vs 0.6.3 |
| SHIP checklist path | Absolute Patrick path | Public-doc smell |
| Engines Node 20 | `.nvmrc` = 20, engines `>=20` | Aligned |
| electron-builder icon path | `build/icon.icns` exists | No |
| Daemon contract doc | Root `DAEMON-ATTACHMENT.md` | Fine; could live under `docs/` for consistency (style only) |

**Docs placement style note:** Product/engineering contracts (`PARITY.md`, `DAEMON-ATTACHMENT.md`) live at **repo root**, while user ops docs live under `docs/`. That split is coherent (root = contributor SSOT; `docs/` = operator guides) but slightly uneven vs projects that put everything under `docs/`.

---

## 5. Recommendations

### Do soon (hygiene, low risk)

1. **Prune or relocate stale git worktrees** under `.worktrees/`  
   - `git worktree list` → remove detached verifier trees that are done.  
   - Reclaim ~6 GB; keep active feature worktrees only.  
2. **Add `.agent-audits/` to `.gitignore`** (and any other agent scratch dirs).  
3. **Delete local `dist/` when not actively shipping** (`rm -rf dist`) — fully regenerable.  
4. **Bump PARITY matrix label** from v0.6.2 → v0.6.3 (or “as of 0.6.3”).  
5. **Soften `docs/SHIP.md`** absolute path to a relative “from repo root” snippet for public readers (keep a private ops note elsewhere if needed).

### Should consider (structure / maintainability)

6. **Expand README architecture table** with one-liners for `daemon-launch.js`, `session-index.js`, `subagent-roster.js`, and “other `lib/*` helpers.”  
7. **Split `renderer/app.js` and/or `main.js` by concern** when next large feature lands (e.g. `renderer/js/{chat,composer,agents,settings}.js`, `lib/` already started the main-process split — continue it). Do not big-bang rewrite without need.  
8. **One-line README note:** “`build/` holds icon **sources** for electron-builder; output goes to `dist/`.”  
9. **Dedupe butterfly SVG** (single canonical asset, copy or reference) if drift becomes annoying.  
10. **Optional later:** ESLint flat config, or a thin `src/` move — only if the team wants stricter contributor guardrails; not required for current ship posture.

### Explicitly do *not* change without product reason

- Do not gitignore `build/icon*`.  
- Do not force a TypeScript migration for structure alone.  
- Do not add CI if org policy still forbids Actions; keep `ship-check` as the documented gate.  
- Do not merge `.worktrees` content into main by accident — they are historical agent branches.

---

## 6. Executive snapshot

**Shape:** Classic flat Electron app — root main/preload, `lib/` services, `renderer/` UI, `scripts/` + `test/` tooling, solid OSS docs. Launch path is clear: `electron .` → `main.js` → sandboxed `renderer/` via `preload.js`, with daemon-attach-first then process RPC.

**Biggest structural smells:** (1) **6+ GB of nested worktrees** beside the real tree, (2) **local dist artifacts**, (3) **two very large entry files** (`main.js`, `renderer/app.js`), (4) minor **doc drift** (PARITY version, SHIP absolute path), (5) **`.agent-audits` not ignored**.

**Git hygiene:** Generally good — 87 tracked files, secrets/env ignored, dist/worktrees ignored, icons correctly tracked.

**Docs:** Above average for early public; layout claims mostly match reality.

---

## Appendix A — Full primary-tree file inventory (tracked + important untracked)

**Tracked (87):** see `git ls-files` — root Electron trio, 12 `lib/*`, 6 `renderer/*`, 12 `scripts/*`, 16 `test/*`, `build/icon*`, `docs/*`, community markdown, `.github` templates, config dots.

**Important untracked / ignored on disk:**  
`node_modules/`, `dist/`, `.worktrees/` (8), `.DS_Store`, `.agent-audits/` (this report).

## Appendix B — Worktrees registered

```text
main                                              c2dd481 [main]
.worktrees/2026-08-09-composer-parity             c7ad972 [agent/2026-08-09-composer-parity]
.worktrees/2026-08-09-daemon-attach-verifier      79e486a (detached HEAD)
.worktrees/2026-08-09-fix-session-switch          31374fd [agent/2026-08-09-fix-session-switch]
.worktrees/2026-08-09-multipane                   38e11b9 [agent/2026-08-09-multipane]
.worktrees/2026-08-09-v06-workspace-integration   79e486a [agent/2026-08-09-v06-workspace-integration]
.worktrees/2026-08-09-v06-workspace-verifier      9936351 (detached HEAD)
.worktrees/2026-08-09-v06-workspace-verifier-…    e5df6b3 (detached HEAD)
.worktrees/2026-08-09-workspace-parity            3f67930 [agent/2026-08-09-workspace-parity]
```

Each ~804–805 MB on disk.

## Appendix C — How the app is launched (quick reference)

| Mode | Command | Entry |
|---|---|---|
| Dev | `npm start` → `electron .` | `main.js` |
| Doctor | `npm run doctor` | `scripts/doctor.js` |
| Unit tests | `npm test` | `test/*.test.js` via `node --test` |
| Protocol smoke | `npm run smoke` | fake agent + lib services |
| UI smoke | `npm run ui-smoke` | real BrowserWindows |
| Unpacked app | `npm run pack` | `dist/mac-arm64/Prime Agent.app` |
| Release zip | `npm run dist` | `dist/Prime Agent-<ver>-arm64.zip` |
| Install to Applications | `./scripts/install-prime-desktop.sh` | pack + copy `.app` |

Daemon vs child process selection is **runtime logic inside main/lib**, not a separate package entrypoint.

---

*End of structural audit. No project source files were modified; only this report was written under `.agent-audits/`.*
