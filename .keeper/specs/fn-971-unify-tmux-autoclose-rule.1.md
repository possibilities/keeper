## Description

**Size:** S
**Files:** src/glob.ts (new), src/reducer.ts, src/pair-command.ts, cli/pair.ts, test/glob.test.ts (new), test/config.test.ts, test/pair-cli.test.ts

### Approach

Extract the dependency-free fnmatch helper (`compileFnmatch` + `FNMATCH_CACHE` +
`isGlobToken`) out of `src/reducer.ts` into a new ZERO-IMPORT leaf `src/glob.ts`
(`node:*` only — it becomes hook-reachable through reducer's `bashTargetMatches`,
so mirror the `src/derivers.ts` / `src/dead-letter.ts` dep-free precedent).
`reducer.ts` imports the leaf; `bashTargetMatches` stays byte-identical in
behavior. Then make `resolveDisableAutoclose` (`src/pair-command.ts`) return a
precompiled `(session: string) => boolean` matcher instead of a `Set<string>`:
each configured pattern compiles via the leaf, and a token with no `*`/`?`
compiles to an exact anchored match, so glob is a strict SUPERSET of today's
exact-match (backward compatible). Update the CLI consumer `cli/pair.ts` from
`!set.has(name)` to `!predicate(name)`. Fail-open: an empty/malformed pattern
list yields a matcher that matches nothing and NEVER throws (a throw at the
reaper's boot-frozen compile in the next task would crash the worker).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:1074,1081-1140 — `compileFnmatch`/`FNMATCH_CACHE`/`isGlobToken` to extract; `bashTargetMatches`:1161-1177 stays and imports the leaf
- src/pair-command.ts:677-681 — `resolveDisableAutoclose` (returns a `Set` today)
- cli/pair.ts:341-349 — the CLI consumer (`.has()` today)
- src/derivers.ts, src/dead-letter.ts — the zero-import dep-free leaf precedent to mirror

**Optional** (reference as needed):
- test/config.test.ts:266-305 — existing `disable_autoclose` test block (template)
- test/pair-cli.test.ts — pair CLI test patterns

### Risks

- `src/glob.ts` MUST stay zero-import (`node:*` only) — it enters the hook import graph via `reducer.ts`. A stray `src/` import breaks the hook dep rule.
- `*` maps to `[^/]*` (not `.*`), anchored both ends; `:` is not a separator so `panels:*` → `^panels:[^/]*$` matches `panels:foo`. Collapse consecutive `*` (ReDoS safety).

### Test notes

- New `test/glob.test.ts`: exact token = exact match, `*`/`?` semantics, `panels:*` matches `panels:foo` but not `panelsfoo`, empty/garbage pattern → matches nothing, no throw.
- Update `test/config.test.ts` `disable_autoclose` cases to assert glob patterns resolve through the matcher.
- Update `test/pair-cli.test.ts` for the predicate consumer.

## Acceptance

- [ ] `src/glob.ts` exists, zero-import (`node:*` only), exports the fnmatch compiler; `reducer.ts` imports it and `bashTargetMatches` behavior is unchanged
- [ ] `resolveDisableAutoclose` returns a `(session)=>boolean`; bare names match exactly (backward compatible), `panels:*` matches `panels:foo`
- [ ] `cli/pair.ts` uses the predicate; an empty/malformed config matches nothing and never throws
- [ ] new `test/glob.test.ts` passes; `config` + `pair-cli` tests updated and green

## Done summary
Extracted the dep-free fnmatch helper into src/glob.ts (node:* only, hook-reachable via reducer) and made resolveDisableAutoclose return a glob-aware (session)=>boolean predicate; bare names match exactly (backward compatible), panels:* matches via fnmatch, fail-open never throws.
## Evidence
