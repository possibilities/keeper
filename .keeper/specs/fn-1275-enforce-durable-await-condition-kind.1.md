## Description

Finding F2 (evidence: `test/await-worker.test.ts:319`, the `evaluateDurableAwaitConditions
covers every server-side condition kind` test and the `durableAwaitCases` table it iterates).
The table is the coverage source of truth but is never tied to the canonical enum
`DURABLE_AWAIT_CONDITION_KINDS` (exported from `src/protocol.ts`) — the test file does not
even import it. Add an enforced tie so a new condition kind cannot ship untested.

Files:
- `test/await-worker.test.ts` — import `DURABLE_AWAIT_CONDITION_KINDS` and assert the table
  covers exactly the enum: prefer keying the table by `kind` and asserting the key set equals
  the enum set (catches both a missing case AND a stray/renamed one), falling back to a
  length assertion (`durableAwaitCases.length === DURABLE_AWAIT_CONDITION_KINDS.length`) if a
  keyset comparison is awkward with the current table shape.

## Acceptance

- [ ] `test/await-worker.test.ts` imports `DURABLE_AWAIT_CONDITION_KINDS` and asserts the `durableAwaitCases` coverage matches the enum (keyset equality preferred, length tie acceptable).
- [ ] Removing or adding a case to the table (or a kind to the enum) without the other turns the suite red.
- [ ] `bun test` passes.

## Done summary
test/await-worker.test.ts now imports DURABLE_AWAIT_CONDITION_KINDS and asserts the durableAwaitCases keyset matches the enum exactly, so an untied condition kind turns the coverage suite red.
## Evidence
