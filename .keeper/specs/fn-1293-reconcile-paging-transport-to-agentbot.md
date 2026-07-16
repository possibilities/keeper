## Overview

The fn-1286 epic consolidated every daemon operator page behind a
`sendBotctlPage` helper that hardcodes the literal `"botctl"` binary. After
that epic was authored, mainline renamed the notifier binary to `agentbot`
(all 7 spawn sites), so the merged epic reintroduces a `botctl` spawn that no
longer exists — ENOENT at page time, a `paging-channel-down` distress row
minted, and no operator page ever delivered. This follow-up renames the
paging vocabulary to `agentbot` so the fail-visible-paging feature actually
reaches operators.

This follow-up blocks the close of `fn-1286-daemon-rides-through-subsystem-failure`:
the source stays open until this lands, because merging it as-is silently
deadens the operator alerting channel the epic exists to make fail-visible.

## Acceptance

- [ ] Every daemon page spawn uses the `agentbot` binary, no `botctl` literal remains in source
- [ ] The `Botctl*` symbols are renamed to the current `agentbot` vocabulary
- [ ] The operator paging path is exercised end-to-end against the current binary name

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | src/integrity-probe.ts:249 hardcodes "botctl" while main (d19e9d9e) renamed all 7 spawn sites to "agentbot"; the moved-helper merge can auto-resolve silently keeping botctl, spawning a nonexistent binary and killing operator paging. |
| F2 | culled | —  | Untested readyState arm is safe-failing; the authoritative connection!==null null-check (bus-worker.ts:1184) is correct and tested. |
| F3 | culled | —  | The degrade-vs-fatalExit reversal is already documented in CLAUDE.md + docs/problem-codes.md; a redundant ADR clears no keep bar. |
| F4 | culled | —  | Both distress minters keep the daemon up on transient busy; the paging minter's swallow-all is defensibly maximally-non-fatal — pure style divergence. |
| F5 | culled | —  | The sharedCheckout-named page-once sweep reuse works (keys on the unique id); a mechanical rename the next toucher can do in place. |
| F6 | culled | —  | The `as unknown as {readyState?}` duck-check is safe-failing per the finding itself; connection!==null is authoritative. |

## Out of scope

- The bus-degraded / duplicate-subscriber / readiness / zombie-reaper work of the source epic (audited clean or safe-failing)
- Renaming the `runSharedCheckoutPageSweep` page-once sweep (F5, culled — reuse works)
