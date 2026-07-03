## Description

**Size:** M
**Files:** cli/tabs.ts, cli/keeper.ts, src/tabs-core.ts, scripts/restore-agents.ts, docs/problem-codes.md, README.md, CLAUDE.md, test/tabs.test.ts, test/keeper-cli.test.ts, test/restore-agents.test.ts

### Approach

Promote restore to a first-class `keeper tabs` subcommand with three
verbs. `list`: JSON envelope of the generation summaries (id, first/last
seen, lifespan, snapshot count, restorable count, degenerate/ambiguous
flags, sample labels) plus the current live set. `restore`: dry-run by
default; `--apply` launches via keeperAgentLaunch through the shared
core; `--generation <id>` targets a generation explicitly; on a TTY the
chosen generation's summary (age, count, labels) is shown and confirmed
before applying, and an ambiguous selection escalates to a numbered
picker; non-TTY ambiguity exits with a dedicated refuse code after
printing the ranked table; the autopilot fail-closed gate carries over
verbatim (--force override, stderr warning); `--allow-empty` suppresses
the zero-candidate failure (gate still asserted); any partial launch
failure exits non-zero with a restored/failed summary; the killed-cohort
fallback always banners. `dump`: the current-live revive script on
stdout, header reporting "captured N keeper agents; M panes without
keeper jobs not included"; excludes plan_verb='work' by default with
--include-managed to opt in.

Move the engine out of scripts/restore-agents.ts into a dep-lean
src/tabs-core.ts (renderSnapshotScript, shellQuote, renderOutcomes,
planRestore, applyRestore, the load* readers, the autopilot gate) so both
cli/tabs.ts and the restore-worker can import it — no cli/ imports
inside. Convert scripts/restore-agents.ts to a thin deprecation shim that
re-execs `keeper tabs` with mapped flags: setup-tmux still spawns it
until the delegation task re-points and deletes it, so flag behavior
stays compatible. Slot the new exit codes into the published EXIT_CODES
table — distinct codes for non-TTY refusal, zero-candidates-under-apply,
and partial failure; never reuse the usage code or the await-owned range.
Docs ride along: docs/problem-codes.md gains the tabs section for the
envelope codes, README's example-clients bullet gains tabs, and
CLAUDE.md's restore-agents guardrail line is revised in place to the
`keeper tabs restore --apply` spelling.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/keeper.ts:22 — SUBCOMMANDS; :70 — SUBCOMMAND_META (verbs pattern); :237 — EXIT_CODES table; :376 — lazy-import handler wiring
- scripts/restore-agents.ts:205-638 — planRestore/applyRestore/renderers/loaders/gate (the code moving to src/tabs-core.ts); :640-760 — the flag surface the shim must keep mapping
- cli/envelope.ts — successEnvelope/errorEnvelope/emitEnvelope contract
- cli/bus.ts:186-210 — verb-dispatch pattern
- cli/setup-tmux.ts:633 — confirm(); :707 — buildRestoreAgentsArgv (shim consumer until the delegation task)
- docs/problem-codes.md — table format contract (code / emitted by / meaning / recovery / retry-safe)

**Optional** (reference as needed):
- test/restore-agents.test.ts — port targets for test/tabs.test.ts

### Risks

- The shim must keep byte-compatible flag behavior for setup-tmux's existing spawn until the delegation task lands — breaking it mid-epic silently kills the crash-restore offer.
- Exit-code collisions with the global table; verify the await-owned codes before assigning new ones.

### Test notes

test/tabs.test.ts ports the restore-agents suites against the moved core
(injected fakes, no real tmux): the exit-code matrix
(refuse/zero/partial/allow-empty/gate), TTY-patched confirm and picker
paths, dump header counts, --include-managed. keeper-cli.test.ts covers
the new subcommand registration. restore-agents.test.ts shrinks to shim
flag-mapping coverage.

## Acceptance

- [ ] keeper tabs list, restore, and dump ship as registered one-binary verbs with per-verb help and published exit codes
- [ ] A non-TTY ambiguous restore refuses with its dedicated exit code and prints the ranked table; a TTY gets summary-confirm and a picker on ambiguity
- [ ] Apply preserves the autopilot fail-closed gate, fails non-zero on zero candidates without allow-empty, and fails non-zero on any partial launch failure with a summary
- [ ] Dump excludes reconciler-managed workers by default and reports the count of panes it cannot revive
- [ ] The legacy restore-agents script delegates to the new verbs, and problem-codes, README, and the CLAUDE.md guardrail reflect the new surface

## Done summary

## Evidence
