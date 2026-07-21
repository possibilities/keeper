## Overview

The daemon resolves the operator-reload attribution leaf from a hardcoded
`~/.local/state/keeper/` directory while `install.sh` writes that leaf under
`${XDG_STATE_HOME:-$HOME/.local/state}/keeper/`. When `XDG_STATE_HOME` is set
to a non-default value the writer and reader diverge, silently degrading the
primary operator-reload verdict (the majority of observed quiet-death cases)
to `no-evidence`. This is a one-boundary bug fix: make the two sides agree on
where the leaf lives.

## Acceptance

- [ ] The daemon reads the operator-reload attribution leaf from the same
      directory install.sh writes it to, for both default and non-default
      `XDG_STATE_HOME`.
- [ ] A deterministic test pins the state-dir resolution across a set and an
      unset `XDG_STATE_HOME`.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | resolveOperatorReloadAttributionPath (restart-ledger.ts:907) reads from dirname(resolveRestartLedgerPath()), hardcoded ~/.local/state/keeper (db.ts:5171), ignoring XDG_STATE_HOME that install.sh:451 honors. |
| F2 | culled | —  | Forensic-only rare operator over-attribution; leaf overwritten each run and enrich runs early next boot, auditor's remedy is a no-op note. |
| F3 | culled | —  | OsMemoryKillEvidence duplicated at os-memory-scan.ts:9 and restart-ledger.ts:85 but structurally compatible; maintainability nit. |
| F4 | culled | —  | resolveRestartLedgerPath is pure/deterministic; repeated calls are harmless. |
| F5 | culled | —  | Async enrich-orchestration idempotency untested but forensic-only; pure classifiers covered. |
| F6 | culled | —  | No SIGTERM-to-signal-verdict end-to-end test, but pure pieces cover it; forensic-only wiring. |

## Out of scope

- Any change to the enrich verdict precedence, the os-memory-kill probe, or
  the RSS ramp instrumentation — the classifiers are correct as shipped.
- Broader XDG compliance for unrelated keeper state paths.
