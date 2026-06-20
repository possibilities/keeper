## Description

**Size:** M
**Files:** cli/plan.ts, scripts/*.ts, README.md, src/*.ts (comments; NOT git-worker.ts), plugins/keeper skills (NOT await/SKILL.md)

### Approach

Conservative, TEXTUAL sweep: replace `planctl` where it names the retired
COMMAND/TOOL with `keeper plan` / "the plan tooling". This is round-N of an
ongoing cleanup — prior sweeps (commits 398b0183, 57ce45a5) already swept
most of README and documented the residue that STAYS. When in doubt, leave it.

In scope:
- cli/plan.ts:3 — correct the false docstring ("the hot path ... ~132 caller files keep calling `planctl` directly") to describe current reality (`keeper plan` is the alias; `planctl` is retired).
- gate-descriptor comments collections.ts:225, types.ts:791, await-conditions.ts:668 — flip `.planctl present` -> `.keeper present` (matches T2's gate flip; this is why this task deps on T2).
- remaining src/ comments + scripts/ + README prose that NAME the command.

Explicitly OUT (do NOT touch):
- DB column names `planctl_*`, index names `idx_events_planctl_*`
- commit trailers `Planctl-Op:` / `Planctl-Target:`, the `'planctl'` source badge
- the legacy `planctl_invocation` envelope reader
- code SYMBOLS (isPlanctlChangedPath, extractPlanctlInvocation, syncPlanctlLinks, discoverPlanctlDirs, scanPlanctlDir, PlanctlCommitChangedMessage, ...) — symbol renames are a separate refactor
- dual-path transition comments (`planctl-commit-changed | plan-commit-changed`, `.planctl || .keeper`) — they describe current behavior and die with the strip
- data-format descriptors ("planctl epic id", "planctl task id", "raw planctl JSON shape") — prior sweeps left these
- git-worker.ts (T2 owns it), anything under `.keeper/specs/`, the `plugins/plan/` subtree

### Investigation targets

**Required** (read before coding):
- `git show -s 398b0183` and `git show -s 57ce45a5` — the scope contract (what stays vs goes)
- cli/plan.ts:1-30 — the false docstring
- README.md — distinguish command refs (sweep) from schema/trailer/badge residue (keep); most stays

**Optional**:
- src/{collections,types,await-conditions,daemon,compaction,epic-deps}.ts comments

### Risks

Over-reach is THE risk — columns/trailers/symbols/transition-comments are
load-bearing. Stay textual; never rename a symbol or wire/schema identifier.
Open question: a few prose refs ("planctl footprint", "planctl-CLI invocations")
are borderline command-vs-data — default to leaving borderline cases.

### Test notes

No behavior change. `bun test` (fast) green suffices unless a touched file is
process-path-adjacent; run `bun run test:full` if unsure. Grep after: no
command-naming `planctl` prose remains in swept files.

## Acceptance

- [ ] cli/plan.ts:3 docstring corrected to current reality
- [ ] gate-descriptor comments (collections.ts:225, types.ts:791, await-conditions.ts:668) say `.keeper present`
- [ ] command-naming prose -> `keeper plan` across swept src/scripts/README/skills
- [ ] columns/trailers/badge/`planctl_invocation` reader/symbols/transition-comments/data-descriptors/`.keeper/specs`/subtree all untouched
- [ ] tests green

## Done summary
Swept command-naming planctl prose to keeper plan across cli/plan.ts docstring, gate-descriptor comments (collections/types/await-conditions: .planctl present -> .keeper present), and src/scripts comments. Left all intentional residue (columns, trailers, source badge, planctl_invocation reader, symbols, dual-path transition comments, data descriptors, subtree prune, git-worker.ts) untouched. Full suite green.
## Evidence
