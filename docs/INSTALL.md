# Install Prime Desktop

macOS only for now.

You need two pieces:

1. **Prime Agent** — the brain (CLI + background worker)
2. **Prime Desktop** — this Mac app (the face)

---

## Path A — Fastest (run from source)

### 1) Install Prime Agent

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

Check it:

```bash
prime-agent --version
```

On first real use, run `prime-agent` once and complete `/login` (API key or subscription).

### 2) Install Desktop from this repo

```bash
git clone https://github.com/epiphany-dynamics/prime-desktop.git
cd prime-desktop
npm install
npm start
```

### 3) First five minutes in the app

1. Open **Settings** and confirm your provider/key (or use the same login you did in the terminal).
2. Click **Choose Project** (or press **Cmd+O**) and pick a folder.
3. Type a message and send.
4. Optional: **Prime → Install or Repair Agent…** if the app cannot find `prime-agent`.

**Quit is safe.** Closing Desktop does not kill live agents. Open the app again to reattach.

---

## Path B — Local `.app` in Applications

Still unsigned (Apple Gatekeeper will warn). Fine for developers and early adopters.

```bash
git clone https://github.com/epiphany-dynamics/prime-desktop.git
cd prime-desktop
npm install
./scripts/install-prime-desktop.sh
```

That script:

1. builds the app
2. asks Desktop to quit cleanly
3. copies `Prime Agent.app` into `/Applications` and `~/Applications`
4. reopens it

If macOS says the app is from an unidentified developer:

1. System Settings → Privacy & Security → Open Anyway  
   or right-click the app → Open → Open

---

## Requirements

| Need | Notes |
|---|---|
| macOS | Apple Silicon builds are what we pack today (`dist/mac-arm64`) |
| Node.js 20+ | For source runs and packing |
| Prime Agent 0.7+ | Install script above |
| Network | Only for model providers / first agent install — not for Desktop unit tests |

---

## Prove the install (no API key needed)

```bash
npm test
npm run smoke
npm run ui-smoke
npm run doctor
```

These use a fake agent and a temp home folder.

---

## Update

```bash
cd prime-desktop
git pull
npm install
npm start
# or
./scripts/install-prime-desktop.sh
```

Update the agent itself from the app menu **Install or Repair Agent…** or:

```bash
prime-agent update
```

---

## Uninstall Desktop only

Agents and `~/.prime` stay unless you remove them yourself.

```bash
rm -rf "/Applications/Prime Agent.app" "$HOME/Applications/Prime Agent.app"
# optional: remove this git clone
```

---

## Still stuck?

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
