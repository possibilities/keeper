## Description

**Size:** M
**Files:** plugins/plan/src/verbs/close_preflight.ts, plugins/plan/agents/close-planner.md, plugins/plan/README.md, plugins/plan/test/ (a close_preflight brief test)

Layer A — give the close-planner the repo map and teach it to emit an explicit per-task `target_repo`. The engine stays content-blind; only the close-planner reads the audit findings, so the repo decision belongs there.

### Approach

1. `close_preflight.ts` — surface the repo map in the brief (additive; keep `schema_version: 1`):
   - Add `target_repo` to the EARLY task projection at `:134-138` (`target_repo: (t.target_repo as string | null) ?? null`) where the full merged record still carries it — the brief `tasks.map` at `:185-190` iterates that projection, so the field must be carried there first to reach the brief the planner actually reads.
   - Add `target_repo` to the brief `tasks.map` at `:185-190` (the `BRIEF_REF` file the planner reads in Phase 1).
   - Add the epic's `touched_repos` (already pulled at `:127`) to the brief root object at `:178-191`.
2. `close-planner.md` — Phase 1 (`:28-31`): add `target_repo` to the enumerated per-task brief fields, and note `touched_repos` is now on the brief root. Phase 5 (`:162-181` template): add `target_repo:` to the YAML task template plus the resolution rule below. Reject-code list (`:200`): add `repo_required` with a one-line gloss (the fix is to add an explicit per-task `target_repo`).
3. Resolution rule for the close-planner (Phase 5): set each follow-up task's `target_repo` to the repo where its surviving finding's code lives — resolve the cited `file:line` against the brief's `touched_repos`; default to the `target_repo` of the source task the finding traces back to. Forbid sentinel values (`auto`/`inherit` — emit a concrete absolute path). Keep ONE follow-up epic and annotate per-task (clusters stay repo-coherent); fall back to the existing one-shot `QUESTION:` protocol only when a finding genuinely cannot be pinned to one repo. Note inline that a missing/out-of-set `target_repo` over a multi-repo source is hard-rejected by the engine (`.2`).
4. `README.md` (~:69): name `target_repo` as a per-task brief field in the close-phase brief-shape sentence.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/close_preflight.ts:124-208 — brief assembly; the `:134-138` projection vs `:185-190` brief map distinction is load-bearing.
- plugins/plan/agents/close-planner.md:28-31, 162-181, 200 — Phase 1 brief fields, Phase 5 YAML template, reject-code list.

**Optional** (reference as needed):
- plugins/plan/test/saga-close-finalize.test.ts:114-137 — `seedFollowupYaml` (emits no target_repo today; the shape `.2` will reject for multi-repo sources).

### Risks

- The brief the planner reads is the `:185-190` map, NOT the envelope — adding `target_repo` only at `:134-138` surfaces it on the envelope but not in `brief.json`. Both spots needed.
- Keep `schema_version: 1` — the planner's `schema_version == 1` self-check (close-planner.md:33) hard-stops on mismatch and would wedge every in-flight close. New fields are additive; old briefs (absent `touched_repos`) must read as single-repo (no annotation forced).

### Test notes

- A `close_preflight` brief test asserting the brief carries per-task `target_repo` and root `touched_repos`. Pair with `realpathSync(project.root)` normalization as existing close tests do.

## Acceptance

- [ ] The close brief carries per-task `target_repo` (at both the `:134-138` projection and the `:185-190` brief map) and epic `touched_repos` on the brief root; `schema_version` stays `1`.
- [ ] close-planner.md Phase 1 reads `target_repo`; Phase 5 template emits `target_repo` with the resolution rule, sentinel ban, and one-epic/annotate guidance; `repo_required` is in the reject-code list.
- [ ] README.md close-phase brief-shape sentence names `target_repo`.
- [ ] A brief test asserts `target_repo` + `touched_repos` presence.

## Done summary

## Evidence
