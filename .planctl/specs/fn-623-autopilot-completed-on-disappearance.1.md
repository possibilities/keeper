## Description

**Size:** S
**Files:** scripts/autopilot.ts, test/autopilot.test.ts

### Approach

Four coordinated changes in `scripts/autopilot.ts`, then a new test in `test/autopilot.test.ts`:

1. **Extract `detectJobTransitions` to module scope** (`scripts/autopilot.ts:1374-1435` today). Currently an inner closure of `main()`, it must move to a module-level exported function taking its closure deps as a single `Deps` record argument: `{ dispatchLog, fulfilledKeys, completedKeys, dispatchLogPath, noteLine, pid, appendLine }`. The `appendLine: (line: string) => void` callback wraps `appendFileSync(dispatchLogPath, ...)` so tests can inject an in-memory recorder (preserving the file's 100%-in-memory test style). Update the single call site inside `main()` to pass the Deps record. This mirrors the existing module-scope pure-function pattern (`findSessionJob`, `hydrateDispatchLog`, `predictNextDispatches`, `renderEpicCommandsFiltered`).

2. **Add the new disappearance branch** inside `detectJobTransitions`. It MUST go BEFORE the existing `if (job === undefined) continue;` at today's `:1393-1395` — otherwise the early-return preempts it. Logic: when `findSessionJob` returns `undefined` AND `fulfilledKeys.has(key)`, treat as terminal: `completedKeys.add(key)`, write the `kind:"completed"` line using the EXACT same JSON shape the existing terminal-state branch emits at `:1417-1427` (`{kind, ts, verb, id, pid}` — no `reason` field, no new fields), then `continue`. The `fulfilledKeys.has(key)` gate is load-bearing: a queued dispatch whose job has not yet appeared in the snapshot ALSO has `findSessionJob === undefined`, and must NOT migrate to completed. Verb-and-form-agnostic: fire for both epic-form (`fn-N-slug`) and task-form (`fn-N-slug.M`) keys — `findSessionJob` already handles both uniformly.

3. **Update the module-level lifecycle docstring** at `scripts/autopilot.ts:683-722`. Extend the `kind:"completed"` bullet (today around `:695-698`) to name both triggers (terminal-state observation AND fulfilled-then-disappeared). Explicitly cite the dependency on `subscribeReadiness.emitSnapshotIfReady`'s all-three-collections gate (`src/readiness-client.ts:840-841`) — that gate is what makes the disappearance signal non-spurious during reconnect; without it, a partial post-reconnect snapshot could fire the branch wrongly. Match the existing block-comment style (paragraph-level, explains *why*).

4. **Update the `renderDispatchFrame` comment block** at `scripts/autopilot.ts:877-891`. Widen the `--- completed ---` section description at today's `:884-886` to mirror the two-trigger reading. Acknowledge that an explicit `planctl epic-delete` after a fulfilled dispatch will also migrate the row (correct semantics: the dispatch's target no longer exists).

5. **Add one new test in `test/autopilot.test.ts`**. Naming: `test("detectJobTransitions — fulfilled key disappears from snapshot reaches completed", () => { ... })` (em-dash separator per file convention). Reuse `makeEpic`, `makeEmbeddedJob`, `buildSnap` (`test/autopilot.test.ts:35-213`); do not duplicate. Drive the test as a sequence of `detectJobTransitions(deps, snap)` calls with an injected `appendLine` capture array, covering THREE interactions in one test: (a) snapshot with epic+embedded job → `fulfilledKeys` gains the key and an `appendLine` capture records the `kind:"fulfilled"` line; (b) snapshot with the epic removed → `completedKeys` gains the key and a `kind:"completed"` line is recorded; (c) a third call with the epic still absent → no second `completed` line emitted (idempotent guard via `completedKeys.has(key)` at top of loop). Bonus assertion: a separately-keyed dispatch that was NEVER fulfilled stays absent from `completedKeys` after the same disappearance frame (proves the `fulfilledKeys` gate).

### Investigation targets

**Required** (read before coding):
- `scripts/autopilot.ts:1374-1435` — `detectJobTransitions` body; the extraction source + branch insertion site.
- `scripts/autopilot.ts:795-822` — `findSessionJob` — already handles both epic-form and task-form id semantics; do not duplicate.
- `scripts/autopilot.ts:733-772` — `hydrateDispatchLog` — already folds `kind:"completed"`; no format change required, no `reason` field.
- `scripts/autopilot.ts:680-705` — module lifecycle block-comment; the `kind:"completed"` bullet needs widening.
- `scripts/autopilot.ts:877-891` — `renderDispatchFrame` comment block; the `--- completed ---` section description needs widening.
- `scripts/autopilot.ts:220-242` — `DispatchEntry` shape; reference when typing the `Deps` record's `dispatchLog` field.
- `test/autopilot.test.ts:1-24` — paragraph-style file header convention; the new test gets prefix prose matching this style.
- `test/autopilot.test.ts:35-213` — existing factory helpers (`makeTask`, `makeEpic`, `makeEmbeddedJob`, `buildSnap`); reuse, do not duplicate.

**Optional** (reference as needed):
- `src/collections.ts:130, 251-254` — default scope filters that cause the disappearance (root-cause reference, no edit).
- `src/readiness-client.ts:840-841` — `emitSnapshotIfReady`'s all-three-collections gate; cite in the new docstring.
- `~/.local/state/keeper/dispatch.log` — sample log records for shape reference (`{"kind":"completed","ts":"...","verb":"...","id":"...","pid":N}`).

### Risks

- **Ordering invariant**: the new branch MUST precede the existing `if (job === undefined) continue;` (today at `:1393-1395`). A drive-by reorder by a future contributor would silently break the rule. Add a one-line comment marking the constraint where the early-return lives.
- **`fulfilledKeys` gate is load-bearing**: omitting the gate would migrate every never-registered dispatch to completed instantly. The test must include the never-fulfilled-stays-queued assertion to pin this contract.
- **Idempotence across snapshots**: a key already in `completedKeys` must short-circuit at the top of the loop (existing `:1389-1391` guard does this). Verify the new branch's `completedKeys.add(key)` happens before fall-through so re-observation across snapshots doesn't double-emit. The test covers this via the third snapshot assertion.
- **Filesystem-write failure**: mirror the existing terminal-state branch — `completedKeys.add` happens UNCONDITIONALLY (before the `try/catch`), so in-memory state advances even if the disk append throws. `noteLine` logs the warn. Do not introduce a new failure semantic.

### Test notes

- Inject `appendLine: (line: string) => void` as a Deps-record field so the new test can capture log writes in memory and assert their exact JSON shape without touching the filesystem. Production callers wire `appendLine = (line) => appendFileSync(dispatchLogPath, line)`.
- Existing `predictNextDispatches` and `renderEpicCommandsFiltered` tests must continue to pass unchanged — the extraction must not regress their module-export surface.
- Verify the captured log lines parse as JSON with the expected `kind`, `verb`, `id` (don't bother asserting `ts` / `pid` byte values — assert their presence and types).

## Acceptance

- [ ] `detectJobTransitions` is exported at module scope with a `Deps` record signature; the single call site in `main()` is updated to pass the record.
- [ ] The new disappearance branch fires when `fulfilledKeys.has(key) && findSessionJob === undefined`, BEFORE the existing `if (job === undefined) continue;` early-return.
- [ ] The disappearance branch writes the same `{kind:"completed", ts, verb, id, pid}` JSON shape as the existing terminal-state branch — no `reason` field, no new fields.
- [ ] Module lifecycle docstring (`scripts/autopilot.ts:683-722`) and `renderDispatchFrame` comment block (`scripts/autopilot.ts:877-891`) name both triggers (terminal state AND fulfilled-then-disappeared) and call out the `emitSnapshotIfReady` dependency.
- [ ] New test in `test/autopilot.test.ts` covers all three interactions in one case (fires on fulfilled+disappeared; never-fulfilled+absent stays queued; idempotent on second absent snapshot).
- [ ] `bun test` passes; existing `predictNextDispatches` and `renderEpicCommandsFiltered` tests unchanged.
- [ ] Manual smoke: run `bun scripts/autopilot.ts`, dispatch an `approve::<epic>` against a done-epic, observe the row migrates from `--- current ---` to `--- completed ---` after the epic falls off the page.

## Done summary

## Evidence
