## Description

Finding F1 (Should-fix). Evidence: `resolveOperatorReloadAttributionPath`
(src/restart-ledger.ts:907) derives the operator-reload leaf path from
`dirname(resolveRestartLedgerPath())`; `resolveRestartLedgerPath`
(src/db.ts:5166-5171) hardcodes `join(homedir(), ".local", "state",
"keeper", ...)` and only honors the `KEEPER_RESTART_LEDGER` override, so it
ignores `XDG_STATE_HOME`. `scripts/install.sh:451` sets
`fingerprint_dir="${XDG_STATE_HOME:-${HOME}/.local/state}/keeper"` and
writes `install-reload-attribution.json` there. With `XDG_STATE_HOME` set to
a non-default value the daemon reads from a different directory than
install.sh wrote to, and the operator verdict silently degrades to
`no-evidence`.

Files: src/db.ts (resolveRestartLedgerPath), src/restart-ledger.ts
(leaf-path resolvers derived from it), scripts/install.sh (fingerprint_dir).
Pick ONE convention and make both sides agree: either read `XDG_STATE_HOME`
in resolveRestartLedgerPath (preferred — keeps install.sh unchanged and
matches the XDG default it already documents), or drop the `XDG_STATE_HOME`
fallback in install.sh. Keep the `KEEPER_RESTART_LEDGER` override precedence
intact.

## Acceptance

- [ ] Writer and reader resolve the same directory for both a set and an
      unset `XDG_STATE_HOME` (with the non-default value exercised).
- [ ] A deterministic, in-process test pins the resolution across both
      env states; the `KEEPER_RESTART_LEDGER` override still wins when set.

## Done summary
Extracted resolveKeeperStateDir (honoring XDG_STATE_HOME, matching install.sh's fingerprint_dir) and rebuilt resolveRestartLedgerPath on top of it, so the operator-reload attribution leaf reader and install.sh writer now agree under both default and non-default XDG_STATE_HOME; added a deterministic test pinning the resolution across both env states plus KEEPER_RESTART_LEDGER override precedence.
## Evidence
