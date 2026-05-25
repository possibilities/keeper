## Description

**Size:** M
**Files:** scripts/autopilot.ts, README.md

### Approach

Two surfaces change: autopilot's command-list output (now two `===`-delimited blocks) and the README (Example clients refresh + Architecture deferral note).

**Autopilot rewire:**

1. Replace the single-collection setup at `scripts/autopilot.ts:103-185` and the connect/poll/SIGINT plumbing at `:414-510` with a `subscribeReadiness({ sockPath, idPrefix: "autopilot", onSnapshot: emitFrameIfChanged, onLifecycle: emitLifecycle })` call from `src/readiness-client.ts`. SIGINT now calls `handle.dispose()` from the returned `ReadinessClientHandle`. First-paint policy automatically tightens from `epics.gotResult` to all-three-strict — acceptable; first frame may take slightly longer after a cold start, no steady-state quality regression.
2. `renderBody` (currently `scripts/autopilot.ts:232-239`) returns two blocks joined by `\n===\n`. Block 1 keeps current `renderEpicCommands` behavior (every task pair + close pair per epic). Block 2 walks the same traversal and emits only rows whose readiness verdict is `{ tag: "ready" }` — per-task via `readiness.perTask.get(task_id)`, per-close-row via `readiness.perCloseRow.get(epic_id)`.
3. Implementation shape: add a sibling `renderEpicCommandsFiltered(row, isReady)` that takes a predicate `(kind: "task" | "close", id: string) => boolean` and delegates the same shell-command rendering. Keep `renderEpicCommands` intact for block 1; don't retrofit a filter into the existing pure function.
4. `lastBody` byte-compare gate at `scripts/autopilot.ts:325-341` is correct as-is — it already compares the COMBINED rendered body. Just confirm the body the renderer hands it includes both blocks.

**Header comment for block 2:** add a one-line preamble inside the rendered block explaining that "ready" doesn't mean "all dispatchable in parallel" — the single-root post-pass (predicate 10 in `src/readiness.ts`) keeps at most one ready row per project root, so the block lists "any one of these can be dispatched next," not a parallel work queue.

**Divider byte form:** `\n===\n` between blocks (mirrors board's `\n~~~\n` joiner at `scripts/board.ts:633`). Empty-state: when block 1 has no epics, block 2 is also empty; the frame body is `===` alone — same `---` lead, just a divider line. Mirrors board's empty-section policy.

**README updates:**

- `## Example clients` (around `README.md:96` index + `:255` section): refresh the `scripts/readiness.ts` cross-reference to `src/readiness.ts` (now a library, not a runnable script); add a new entry for `autopilot.ts` describing the two-block UI (flat command list + `===`-delimited "ready" block); collapse any standalone description of `readiness.ts` into a one-liner. Place the new `autopilot.ts` entry after `board.ts` (the two are now the helper's primary consumers).
- `## Architecture` section: add a one-paragraph forward note on the deferred server-side `readiness` collection. Substance: `src/readiness.ts` is the shared readiness-verdict library consumed by `scripts/board.ts` and `scripts/autopilot.ts` via the `src/readiness-client.ts` helper; a server-side `readiness` projection (synthetic recompute, persisted verdict map, diffed over the wire) is a natural future extension and intentionally out of scope here. Rationale (one sentence): inputs already on the wire, helper-in-`src/` design preserves the option without paying its cost today.
- `CLAUDE.md`: no change (per docs-gap-scout; design stance lives there but doesn't need an inventory entry for these two files).

### Investigation targets

**Required** (read before coding):
- `scripts/autopilot.ts:103-185` — current single-collection setup to replace.
- `scripts/autopilot.ts:197-225` `renderEpicCommands` — reuse for block 1; mirror its shape for `renderEpicCommandsFiltered`.
- `scripts/autopilot.ts:232-239` `renderBody` — add second block + divider.
- `scripts/autopilot.ts:325-341` `emitFrameIfChanged` + `lastBody` byte-compare — confirm it already compares the combined body, no code change needed.
- `scripts/autopilot.ts:414-510` — connect/poll/SIGINT plumbing to replace with `dispose()` from the helper handle.
- `src/readiness.ts` (post-task `.1`) — `Verdict` discriminated union (`tag: "ready" | "completed" | "blocked"`); the filter predicate keys on `tag === "ready"`.
- `src/readiness-client.ts` (post-task `.2`) — `subscribeReadiness` API contract.
- `scripts/board.ts:633` — board's `\n~~~\n` joiner as the divider-byte-form precedent.
- `README.md` — find `## Example clients` and `## Architecture` sections.

**Optional** (reference as needed):
- `src/readiness.ts:367-408` (`applySingleRootMutex`, post-move) — context for the block-2 header comment about predicate 10.

### Risks

- **`lastBody` byte-compare edge case.** A verdict transition with no task-set change MUST emit a new frame. Already correct because `lastBody` compares the whole rendered body string and block 2 changes whenever a verdict tag flips. Verify with a smoke test that toggles a task's approval via `bun scripts/approve.ts <id>` and confirms autopilot emits a fresh frame.
- **First-paint latency.** Cold-start first frame may be slightly delayed by `subagent_invocations.gotResult` landing. No steady-state impact.
- **README ordering convention.** `## Example clients` has no documented ordering rule. Add `autopilot.ts` after `board.ts`; keep `approve.ts` where it sits (different client family — RPC, not subscribe).

### Test notes

No new unit test required. Validation is visual: run `bun scripts/autopilot.ts` against a running keeperd with a mix of ready and blocked tasks and verify:
1. Block 1 is unchanged from current output.
2. Block 2 contains only pairs whose task or close-row verdict is `{tag: "ready"}` (matches board's `[ready]` pill for the same snapshot).
3. When no rows are ready, block 2 is empty under the divider (`===\n` then nothing).
4. Toggling a task's approval via `bun scripts/approve.ts <id>` updates block 2 within one poll cycle.
5. SIGINT cleanly disposes (no error stacks, no orphan subscriptions on the server side).

## Acceptance

- [ ] `scripts/autopilot.ts` uses `subscribeReadiness` from `src/readiness-client.ts`; the file no longer contains its own three-collection setup, connect/poll loop, or SIGINT-driven socket-write code (SIGINT now calls `handle.dispose()`).
- [ ] `renderBody` produces `<block1>\n===\n<block2>` (or `===` alone when both are empty); block 2 contains only `cd … claude /plan:work` + `bun approve.ts` pairs whose verdict tag is `"ready"`.
- [ ] Block 2 carries a one-line header comment explaining the single-root post-pass semantics ("any one of these can be dispatched next," not a parallel queue).
- [ ] `bun scripts/autopilot.ts` against a running keeperd visually matches: block 1 unchanged from pre-change; block 2 matches the set of board's `[ready]` pills for the same snapshot.
- [ ] `README.md ## Example clients` updated: `autopilot.ts` entry added (after `board.ts`); `scripts/readiness.ts` reference retargeted to `src/readiness.ts` (or folded into board's prose).
- [ ] `README.md ## Architecture` carries the one-paragraph deferral note on a future server-side `readiness` collection.
- [ ] SIGINT during autopilot cleanly drops the subscription and exits 0.
- [ ] `bun test` passes.

## Done summary

## Evidence
