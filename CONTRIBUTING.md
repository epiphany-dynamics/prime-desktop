# Contributing

Thanks for helping with Prime Desktop.

Built by [Epiphany Dynamics](https://epiphanydynamics.ai).

## Before you start

- macOS is the supported platform right now
- You need Node.js 20+ and npm
- Optional: a local [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) install if you want to run against a real agent

## Setup

```bash
git clone https://github.com/epiphany-dynamics/prime-desktop.git
cd prime-desktop
npm install
```

## Checks you should run

```bash
npm test
npm run smoke
npm run ui-smoke
```

- `npm test` — fast unit tests
- `npm run smoke` — protocol checks with a fake agent
- `npm run ui-smoke` — real Electron window checks (macOS)

No GitHub Actions on this org for this repo. **Green local checks are the gate.**

## Project rules worth knowing

1. **Desktop is a client.** Closing the app should not kill live agent workers.
2. **Split View is explicit.** Sidebar session clicks replace the current chat. They must not open a second pane by surprise.
3. **Voice is out of scope.** Do not add mic, dictation, or TTS for “parity.”
4. **Keep the renderer locked down.** No raw shell or free filesystem APIs in the UI layer.
5. **Be honest in docs.** If something is partial, say so in `PARITY.md`.

## Good first work

Look at rows marked `next` or `partial` in [`PARITY.md`](PARITY.md). Small, tested slices beat large untested rewrites.

## Pull requests

1. Keep the change focused
2. Add or update tests when behavior changes
3. Update `PARITY.md` / `README.md` when user-visible behavior changes
4. Include the commands you ran and the results

## Code of conduct

Be respectful. No harassment, no spam, no drive-by secret dumping.
