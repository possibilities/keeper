## Description

**Size:** M
**Files:** src/dispatch-command.ts, src/derivers.ts, cli/escalation-brief.ts, cli/dispatch.ts, test/dispatch-command.test.ts, test/derivers.test.ts, test/escalation-brief.test.ts

### Approach

Teach every ref surface the repo-scoped `repair::<repo-token>` key. The token is NEVER a
raw path: reuse the worktree provisioning repo slug+hash naming seam (the
`<basename-slug>-<hash>` convention worktree dirs already use) via a shared pure helper
both the daemon and CLI import. EscalationVerb gains "repair" (union + DISPATCHABLE_VERBS
+ isEscalationVerb + the parse-error strings listing valid verbs), keeping the documented
retry-wire separation — repair keys are never retry_dispatch keys. SPAWN_VERB_REF_RE in
derivers gains a repair arm accepting the non-fn-shaped token so a repair session's jobs
row binds plan_verb/plan_ref (today it would bind null/null and be invisible to
occupancy). parseEscalationKey gains a repair arm that does NOT route through parsePlanRef
(which only knows epic/task shapes); ParsedKey and the brief's kind unions gain a repair
member carrying `repo` instead of epic_id/task_id. Add buildRepairIncident as the third
incident builder: (repo, repo_token, fingerprint, base sha, failing command, affected
blocked tasks across ALL epics on that repo with their epic ids, baseline verdict) — the
flat envelope root stays one JSON value and must tolerate a task-less/epic-less incident.
cli/dispatch.ts's manual plan form accepts repair::<token>, resolving cwd to that repo's
shared checkout; unknown token -> typed error, never a guess.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/dispatch-command.ts:42-58 — the verb union/set/guard triad; :184 — error strings enumerating verbs; :234 — defaultPlanPrompt (repair prompt falls out free)
- src/derivers.ts:40 — SPAWN_VERB_REF_RE (currently rejects any non-fn-shaped ref)
- cli/escalation-brief.ts:155-179 — parseEscalationKey/ParsedKey; the buildUnblockIncident/buildDeconflictIncident shapes to mirror for the third builder
- cli/dispatch.ts:149-194 and :312-317 — plan-form parsing and per-verb cwd resolution
- the worktree repo slug+hash naming helper — locate where worktree provisioning derives its `<slug>-<hash>` dir names and extract/reuse, do not invent a second convention

**Optional** (reference as needed):
- test/dispatch-command.test.ts, test/escalation-brief.test.ts, test/derivers.test.ts — existing parse-table test shapes

### Risks

- dispatch-command and derivers are dep-free leaf modules — the token helper they share must also be leaf-safe (no db, no daemon imports)
- The brief envelope shape change must leave unblock/deconflict briefs byte-identical

### Test notes

Parse tables: repair::<valid-token> accepted everywhere, malformed/path-shaped tokens
rejected with typed errors; derivers bind plan_verb='repair'; brief golden test for the
repair incident; explicit byte-equality regression on an unblock and a deconflict brief.

## Acceptance

- [ ] keeper dispatch accepts the repair plan form with a valid repo token and rejects malformed or path-shaped tokens with a typed error
- [ ] A repair session's jobs projection row binds the repair verb and its token as plan_verb/plan_ref
- [ ] keeper escalation-brief on a repair key emits a repair-kind incident carrying repo, fingerprint, base evidence, and the affected blocked tasks across every epic on that repo, as exactly one top-level JSON value
- [ ] Unblock and deconflict brief outputs are byte-unchanged for existing keys
- [ ] Fast suite green including the new parse/brief tables

## Done summary
Added repair::<repo-token> as a third, repo-scoped escalation verb: verb/set/guard plumbing in dispatch-command.ts, a shared REPO_TOKEN_RE + SPAWN_VERB_REF_RE arm in derivers.ts so its jobs row binds plan_verb/plan_ref, an extracted repoToken() helper in worktree-plan.ts reused by cli/dispatch.ts's cwd resolution (scans all epics, typed error on an unresolved token) and cli/escalation-brief.ts's new repair-kind incident builder (repo + fingerprint + base evidence + affected blocked tasks across every epic on the repo). Unblock/deconflict brief output is unchanged.
## Evidence
