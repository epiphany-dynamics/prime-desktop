# Good first issues

Start here if you want to contribute without learning the whole desktop shell first.

## Open starter issues

| Issue | Kind | Why it is a good first step |
|---|---|---|
| [#1](https://github.com/epiphany-dynamics/prime-desktop/issues/1) | docs | Short README checklist; no runtime risk |
| [#2](https://github.com/epiphany-dynamics/prime-desktop/issues/2) | docs | Keep this page honest as issues ship |
| [#3](https://github.com/epiphany-dynamics/prime-desktop/issues/3) | UX copy + wiring | Missing-agent empty state; high user value |
| [#4](https://github.com/epiphany-dynamics/prime-desktop/issues/4) | feature | Session export MVP (Markdown) |
| [#5](https://github.com/epiphany-dynamics/prime-desktop/issues/5) | feature | Native finish notifications for background panes |

Browse all open issues with the [`good first issue`](https://github.com/epiphany-dynamics/prime-desktop/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label.

## How to pick one

1. Read [`CONTRIBUTING.md`](../CONTRIBUTING.md) and the product rules there.
2. Comment on the issue that you want it (one person per issue is enough).
3. Keep the PR focused on that issue only.
4. Run:

```bash
npm install
npm run doctor
npm run lint
npm test
npm run smoke
```

macOS UI work should also run `npm run ui-smoke` when you touch windows or the renderer.

## File map for newcomers

| Area | Look first |
|---|---|
| App shell / windows | `main.js` |
| Daemon attach | `lib/daemon-rpc-adapter.js`, `DAEMON-ATTACHMENT.md` |
| Process RPC | `lib/rpc-manager.js` |
| Projects / tree | `lib/workspace-service.js` |
| Attachments | `lib/attachment-service.js` |
| UI | `renderer/` |
| Checks | `scripts/doctor.js`, `scripts/smoke.js`, `test/` |
| Product truth | `PARITY.md`, `docs/ROADMAP.md` |

## What we will reject quickly

- Voice features (product rule)
- Drive-by dependency bumps with no bug
- Windows/Linux ports as a first PR (later roadmap)
- Secrets, real API keys, or machine-local paths in the repo
- PRs that kill agent workers on window close

## Not sure?

Open a normal issue with:
- what you tried
- macOS version
- Prime Desktop version / commit
- whether `prime-agent --version` works

Do not paste API keys.
