# Troubleshooting

## “prime-agent binary not found”

Desktop looks in:

- `~/.local/bin/prime-agent`
- `~/.local/lib/node_modules/prime-agent/...`
- `~/.hermes/node/bin/prime-agent`
- `/opt/homebrew/bin/prime-agent`
- `/usr/local/bin/prime-agent`
- your login-shell `PATH`

Fix:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
hash -r
prime-agent --version
```

Then restart Desktop, or use **Prime → Install or Repair Agent…**

---

## App opens, but chat never answers

1. Confirm the agent works alone:

   ```bash
   cd /path/to/some/project
   prime-agent
   ```

2. Complete provider login / API key there or in Desktop **Settings**.
3. Pick a project folder in Desktop (Cmd+O).
4. Check the small status text under the composer.

---

## macOS blocks the `.app`

The public build is **not signed yet**.

- Right-click app → **Open** → **Open**
- or System Settings → Privacy & Security → **Open Anyway**

---

## I quit the app and my agent vanished

It should not. Desktop detaches on quit on purpose.

Check:

```bash
prime-agent agents
prime-agent status
```

Reopen Desktop and select the session from the sidebar.

If you used **Restart agents** inside the app, that *does* stop workers on purpose.

---

## `npm run ui-smoke` fails

- Must be macOS
- Must be able to launch Electron windows
- Run from a normal GUI session (not a locked-down SSH-only box)

Unit + protocol smoke can still pass:

```bash
npm test
npm run smoke
```

---

## Split View opened when I only clicked a session

That is a bug if it happens. Sidebar clicks must stay single-pane.  
Split only from the **Split View** control. Please file a bug with steps.

---

## API keys in issues

Never paste keys. See [SECURITY.md](../SECURITY.md).
