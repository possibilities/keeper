## Description

**Size:** S
**Files:** `src/plan-worker.ts`, `src/git-worker.ts`, `src/await-conditions.ts`, `cli/await.ts`, `src/readiness-client.ts`

### Approach

Pure symbol rename (no logic change) of the `planctl`-named identifiers the strip's other phases scoped out. Rename + update every call site; verify with typecheck + test:full.

### Investigation targets

**Required** (read before coding):
- `src/plan-worker.ts` — `scanPlanctlDir` (~:2293), `discoverPlanctlDirs` (~:2436), `reconcilePlanctlDirs` (~:2554), `discoverPlanctlRepos` (~:2749), `attributePlanctlDirToRoot` (~:2818), `repoRootFromPlanctlPath` (~:1937), `PlanctlCommitChange` (~:298)
- `src/git-worker.ts` — `PlanctlCommitChangedMessage` / `PlanctlChangedFile` interfaces (~:227-234) — rename the SYMBOLS only
- `src/await-conditions.ts` — `PlanctlCondition` type (~:106), used in `AwaitCondition` (~:117); call sites `cli/await.ts`, `src/readiness-client.ts`

### Risks

- Do NOT touch `parsePlanctlOpTrailer`/`parsePlanctlTargetTrailer` or the `Planctl-Op:`/`Planctl-Target:` trailer key string literals — those are Problem B (immutable git-history keys).
- `isPlanctlChangedPath` may already be renamed/handled by fn-859 — check current state before touching `git-worker.ts`.

### Test notes

- `bun run typecheck` + `bun run test:full` (touches worker/git paths).

## Acceptance

- [ ] All listed plan-dir symbols + `PlanctlCondition` renamed; call sites updated
- [ ] Trailer parsers + trailer key string literals untouched
- [ ] typecheck + test:full green

## Done summary

## Evidence
