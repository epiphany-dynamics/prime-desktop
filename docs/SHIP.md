# Ship checklist (Patrick / Epiphany Dynamics)

Use this before every public post, star-push, or social blast.

## 1) Code gate (this machine)

```bash
cd /Users/epiphanydynamics/Projects/prime-desktop
npm run ship-check
```

Must print **SHIP CHECK PASS**.

## 2) Fresh install rehearsal (15 minutes)

1. Quit Prime Desktop completely (Cmd+Q).
2. Install or reinstall:
   - Source: `npm start`, or
   - App: `./scripts/install-prime-desktop.sh`
3. Confirm **About / version** or package version matches the release tag.
4. Manual path:
   - [ ] App opens
   - [ ] **◈ Agents** opens a panel (even if empty)
   - [ ] New chat works
   - [ ] Switch sessions **10 times** quickly — no sticky “wait for session change” brick
   - [ ] Choose project (Cmd+O)
   - [ ] Send a message (with Prime Agent + provider configured)
   - [ ] Spawn sub-agents → open **Agents** while they run → rows appear in the panel
   - [ ] Quit app → agents still alive (`prime-agent agents`) → reopen

If any box fails, **do not post**. Fix first.

## 3) GitHub Release

```bash
# already tagged by release process; verify:
gh release view vX.Y.Z --repo epiphany-dynamics/prime-desktop
```

Release must include:

- clear **early build** language
- link to [KNOWN_LIMITS.md](KNOWN_LIMITS.md)
- arm64 zip (unsigned) **or** “build from source” only

## 4) Social copy template

**Short**

> Prime Desktop (early): open-source macOS UI for Prime Agent.
> Split chats, live attach, Agents panel. Unsigned Mac build for now.
> https://github.com/epiphany-dynamics/prime-desktop

**Longer**

> We open-sourced Prime Desktop — a native Mac client for Prime Agent.
> It’s early. You’ll need Prime Agent installed, and macOS will warn because the build isn’t Apple-signed yet.
> If you try it, tell us what breaks.

## 5) After you post

- Watch issues for the first 48 hours
- If a blocker appears, cut a patch release the same day
- Never leave strangers on a known-broken `/Applications` build
