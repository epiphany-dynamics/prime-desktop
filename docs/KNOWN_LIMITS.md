# Known limits (read before you share)

Prime Desktop is an **early public macOS build** from Epiphany Dynamics.
It is useful today. It is **not** a finished consumer product.

## Say this when you post it

> Open-source Mac desktop client for Prime Agent. Early build. Needs Prime Agent installed. App is **unsigned** until Apple Developer signing is ready.

Do **not** say “works like Hermes” or “one-click for everyone” yet.

## What works well

- Run from source (`npm start`) or local unsigned `.app`
- Multi-pane chats, project folders, attachments
- Attach to live Prime Agent sessions without killing them on quit
- **Agents** panel for sub-agent visibility (focused chat)
- Offline checks: `npm run lint && npm test && npm run smoke`

## What will frustrate strangers

| Issue | Why |
|---|---|
| macOS “unidentified developer” | Build is **not signed / not notarized** yet |
| Two installs | Needs **Prime Agent** + Desktop |
| Provider login | Needs API key / `/login` before chat answers |
| Apple Silicon pack | Release zip is **arm64** first |
| No GitHub Actions CI | Quality gate is local `npm run ship-check` |
| Sub-agent UX | Live panel is early; not full Hermes parity |
| Huge old sessions | History can take a moment to load (UI should stay responsive) |

## Support promise

- File bugs with: macOS version, Desktop version, Prime Agent version, steps
- Never paste API keys into issues
- Security: [SECURITY.md](../SECURITY.md)

## Roadmap that unlocks “loud” marketing

1. Apple Developer ID + notarized DMG
2. Cold-install video under 3 minutes
3. Intel Mac or universal build if you need it
4. Signed auto-update (later)

Until those land, market as **builder / early access**, not polished App Store quality.
