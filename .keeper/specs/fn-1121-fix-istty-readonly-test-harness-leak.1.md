## Description

**Size:** S
**Files:** test/setup-tmux.test.ts, plugins/plan/test/harness.ts

### Approach

Two ends of one bug. (1) In `test/setup-tmux.test.ts`, every
`Object.defineProperty(process.stdout|process.stdin, "isTTY", …)` descriptor
omits `writable` (the data-descriptor default is `false`), so after the test's
save/restore the global `isTTY` is left non-writable — poisoning any later test
in the same `bun test` process. Add `writable: true` to each isTTY descriptor.
Find the sites by grepping (`isTTY` + `defineProperty`), not a hand-list — one
missed site re-poisons the global. (2) In `plugins/plan/test/harness.ts`,
`setTTY` bare-assigns `stream.isTTY = value`, which throws
`TypeError: Attempted to assign to readonly property` against a non-writable
descriptor. Switch it to
`Object.defineProperty(stream, "isTTY", { value, configurable: true, writable: true })`
— self-healing regardless of any prior definition — and rewrite its comment to
state current behavior only (no history / fn-ids, per CLAUDE.md rule #0).
`value` may legitimately be `undefined` (piped streams); `defineProperty`
handles that fine.

Test-hygiene only — do NOT touch the test topology; the separate-process
isolation in `test:full` is intentional and orthogonal. A centralized
descriptor save/restore helper (with delete-vs-redefine for the piped-stream
case, where the original `isTTY` has no own property) is a cleaner long-term
shape but is out of scope here; leave it as an optional follow-up.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required:**
- test/setup-tmux.test.ts — the ~23 `Object.defineProperty(process.*, "isTTY", …)`
  sites, all currently without `writable`.
- plugins/plan/test/harness.ts — `setTTY` (the sole bare `isTTY =` write in the
  tree) and its stale "without tripping the readonly type" comment; called with
  `false` and with the saved prior value (which can be `undefined`).

## Acceptance

- [ ] Raw `bun test` at the repo root reports zero `readonly property` errors
  (the ~578 setTTY failures are gone).
- [ ] Every `isTTY` `defineProperty` descriptor in `test/setup-tmux.test.ts` is
  writable, so the suite leaves no non-writable global behind.
- [ ] `plugins/plan/test/harness.ts` `setTTY` performs a descriptor-based write
  that survives a prior non-writable definition, and its comment describes only
  current behavior.
- [ ] The sanctioned suites (`bun run test`, `cd plugins/plan && bun test`)
  remain green.

## Done summary
Made isTTY globals writable: added writable:true to all 19 isTTY defineProperty descriptors in setup-tmux.test.ts, and rewrote harness.ts setTTY to write via a writable+configurable descriptor. Raw bun test now reports 0 readonly-property errors (was ~578).
## Evidence
