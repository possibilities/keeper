## Overview

Promote the pure `computeReadiness` pipeline from `scripts/readiness.ts` into `src/readiness.ts` as first-class library code, extract a shared `src/readiness-client.ts` helper that owns the three-collection subscribe + computeReadiness handoff (so `scripts/board.ts` and the new `scripts/autopilot.ts` ready-commands block both consume one source of truth), and add a `===`-delimited second block to autopilot listing only the `cd … claude /plan:work` + `bun approve.ts` pairs whose readiness verdict is `{tag: "ready"}`. End state: `src/` owns the readiness library + the subscribe helper; `scripts/board.ts` is a thin renderer; `scripts/autopilot.ts` emits two blocks (all commands + ready-only commands) for arthack-style automated dispatch.

## Quick commands

- `bun test test/readiness.test.ts test/board.test.ts` — pure-function and `projectRows` regression suites.
- `bun scripts/board.ts` against a running keeperd — visual regression: same frames as before, same pills, same dividers.
- `bun scripts/autopilot.ts` against a running keeperd — new two-block output; block 1 unchanged, block 2 contains only ready-verdict commands separated from block 1 by `\n===\n`.

## Acceptance

- [ ] `src/readiness.ts` is the canonical home for the verdict pipeline; `scripts/readiness.ts` is gone.
- [ ] `src/readiness-client.ts` exports `subscribeReadiness(opts) → ReadinessClientHandle` and co-locates `projectRows`. Helper handles capped-backoff reconnect, all-three-strict first-paint gate, per-collection coalesce, `state.rows`-based subagent_invocations projection, and idempotent `dispose()`.
- [ ] `scripts/board.ts` consumes the helper as a thin renderer (sidecars, per-frame subagent annotation, body byte-compare stay in board; connection/poll/computeReadiness lifted out). Visual output unchanged.
- [ ] `scripts/autopilot.ts` consumes the helper and emits two `===`-delimited blocks; the ready block lists only verdict-`{tag: "ready"}` commands.
- [ ] README `## Example clients` refreshed (autopilot entry added, readiness reference points at `src/readiness.ts`); README `## Architecture` carries a one-paragraph deferral note on a future server-side `readiness` collection.
- [ ] `bun test` passes; `test/board.test.ts`'s two-running-subagents-on-one-job_id regression still asserts the same invariant against the new helper.

## Early proof point

Task that proves the approach: task `.2` (the helper extraction + board refactor). If `scripts/board.ts` renders identically before and after with the regression test green, the helper's API surface is sound and task `.3` is a mechanical rewire + render addition. If `.2` reveals the helper needs additional surface area, recover by widening the API and re-running board against keeperd until the visual diff is zero.

## References

- `scripts/readiness.ts:1-44` — pure-contract docstring.
- `scripts/board.ts:749-818` — canonical three-collection coalesce + computeReadiness handoff (the extraction source).
- `scripts/board.ts:321-338` — `projectRows` (the `state.rows`-not-`byId` projection that prevents subagent collapse on the shared wire pk).
- `scripts/autopilot.ts:197-225` — `renderEpicCommands` (reused for both blocks).
- `test/board.test.ts:113-203` — the two-running-subagents-on-one-job_id regression test that load-bears the helper's projection contract.
- `fn-605` (overlap, hard upstream — task `.3` actively editing `scripts/board.ts`) — wait for fn-605 close before starting task `.2`.

## Docs gaps

- **`README.md ## Example clients`**: refresh `scripts/readiness.ts` reference to `src/readiness.ts`; add `autopilot.ts` entry describing the two-block UI; collapse readiness reference into board's prose if cleaner.
- **`README.md ## Architecture`**: add one-paragraph forward note on the deferred server-side `readiness` collection (helper-in-src/ design preserves the option without paying its cost today).

## Best practices

- **Name the helper for what it IS, not what it does for callers.** `subscribeReadiness` / `src/readiness-client.ts` matches the abstraction's identity; resist names tied to the first call site.
- **Callback + dispose, not async iterator.** Async generators have cancellation pitfalls (consumer controls iteration; force-stop requires `.return()`) and `yield*` recursive reconnect creates new frames per reconnect. Two imperative consumers (board, autopilot) want a callback API.
- **Fix the surface area to what BOTH consumers need before extracting.** Don't accept a `collections` parameter or expose internal `CollectionState` — the helper subscribes to all three by design.
- **`state.rows` (not `byId.values()`) for `subagent_invocations`.** Composite SQL identity, single-column wire pk: re-entrant sub-agents on one `job_id` MUST all reach `computeReadiness` (predicate 6: `own-progress-sub`).
- **`gotResult` reset on teardown.** Board has it right; autopilot's current code is missing the reset. Helper centralizes the correct behavior.
- **Guard every `socket.write` with `shuttingDown` + `currentSock != null`.** `socket.write()` after `socket.end()` throws synchronously in Bun.

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/central-readiness-autopilot-ready-block` — the upstream sketch handoff (empty snippet set; rides forward so future `render-spec` calls resolve any additions made post-handoff).
