# Security

## Report a problem

If you find a security issue in Prime Desktop, email **security@epiphanydynamics.ai**
(or open a private advisory on GitHub if that is available on this repo).

Please include:

- what you did
- what you expected
- what happened
- Prime Desktop version and macOS version
- whether `prime-agent` was involved

Do **not** post API keys, session files, or personal paths in a public issue.

## What this app stores

- App settings and window state under the normal Electron user-data folder
- Prime Agent config and sessions under `~/.prime` (owned by Prime Agent)
- API keys are write-only in the UI: the app can set or clear them, but it does
  not show full secrets again after save

## What we will not accept as a “vulnerability” by default

- Unsigned local builds (expected until Apple signing is added)
- Missing Windows/Linux builds
- Features listed as future work in `README.md` / `PARITY.md`
- Harmless locked-down file access (the app is designed to refuse broad disk access)

## Safe testing

Use the offline checks:

```bash
npm test
npm run smoke
npm run ui-smoke
```

Those runs use a fake agent and a temporary home folder. They do not need network
access or real provider keys.
