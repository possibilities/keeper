## Description

Add direct unit coverage for two untested server-side durable-await
surfaces flagged by the fn-1273 close audit:

- **F1** — `evaluateDurableAwaitConditions` (`src/await-worker.ts:269`).
  The ~130-line evaluator dispatches all 14 condition kinds
  (complete / unblocked / started / git-clean / agents-idle / drained /
  landed / dead-letter / block-escalation / parked-question /
  stuck-dispatch / finalize-non-ff / instant-death-wall / needs-human) and
  returns met/waiting/unknown. It has zero direct test references in
  `test/` — only transitive exercise via `decideAwaitAction`. Add a
  table-driven test in `test/await-worker.test.ts` that seeds a DB snapshot
  per condition kind and asserts the met/waiting/unknown verdict, covering
  the `target === null` guard, the task-vs-epic (`/\.\d+$/`) split, and the
  `drained` scope default.

- **F2** — the `request-await` daemon handler spill guard
  (`src/daemon.ts:8343`). It carries its OWN copy (distinct from the
  handoff copy) of the realpath + `startsWith(realDir + sep)` containment
  check plus empty-file and `HANDOFF_DOC_MAX_BYTES` rejections. Only
  param-shape validation is covered (`test/rpc-handlers.test.ts`). Add a
  daemon-level test in `test/daemon.test.ts` asserting that a
  `../`-escaping `doc_path`, an empty spill file, and an oversized spill
  file each return `ok:false` and mint no `AwaitRequested` event.

Bundled as one task: both are durable-await server-side test coverage of
the same feature, landing as one test-only commit. Tests only — do not
change production behavior.

Files: `test/await-worker.test.ts`, `test/daemon.test.ts`.

## Acceptance

- [ ] Table-driven `evaluateDurableAwaitConditions` test asserts
      met/waiting/unknown per condition kind against a seeded DB.
- [ ] Daemon test asserts `../`-escape, empty, and oversized spill
      `doc_path` each return `ok:false` and mint no event.
- [ ] `bun test` green; no production source changed.

## Done summary

## Evidence
