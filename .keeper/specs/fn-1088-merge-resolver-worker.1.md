## Description

**Size:** M
**Files:** src/autopilot-worker.ts or src/daemon.ts (dispatch trigger), src/reconcile-core.ts (key plumbing), plugins/plan (resolver prompt surface — new agent or close-skill mode; investigate the right home), src/dispatch-failure-key.ts, test/

### Approach

One resolver attempt per sticky merge-conflict condition. Trigger: when a
worktree-merge-conflict (or finalize-conflict content case) sticky appears for an epic and
no resolver attempt has run for that condition instance, mint a resolve::<epic> dispatch
into the epic lane — once-per-condition latched like merge_escalated_at (a column-latch or
the change-gate keyed on the sticky's identity; NEVER a per-cycle re-dispatch), reset when
the sticky clears. The resolver session prompt: recreate the merge, classify — mechanically
clear (textual, both intents preservable, no state-machine/schema/security/transaction
shape) → resolve preserving both intents, run the epic's test gate within a bounded budget,
commit the merge, keeper autopilot retry the close, exit; NOT clear → stamp BLOCKED with
category + evidence + the literal unstick sentence and exit leaving the sticky and the
human escalation exactly as today. Build on the landed trust-contract language; the close
audit downstream is unchanged and still gates the result.

### Investigation targets

**Required** (read before coding):
- The merge-escalation sweep + merge_escalated_at latch — the once-only pattern and whether the resolver rides the same sweep or the reconciler
- How dispatch keys/verbs are minted and classified (work::/close:: plumbing in reconcile-core + exec-backend consumers — coordinate with the dissolution epic's landed argv changes, do not edit exec-backend if avoidable)
- This session's three manual resolutions in keeper history — encode their decision boundary as prompt exemplars

### Risks

- Authority creep is the failure mode: the guardrail classes must be named in the prompt verbatim, and "unsure" defaults to BLOCKED.
- One-attempt discipline: a resolver that fails mid-merge must abort to a clean lane (the recover pass covers residue) and never loop.

### Test notes

Latch/trigger tests through pure seams (once per condition, reset on clear); prompt is
exercised by the scratch-conflict proof in task .2, not the fast tier.

## Acceptance

- [ ] One resolver dispatch per sticky condition instance; latched; reset on clear; breaker-covered
- [ ] Resolver prompt encodes both-intents + test-gate + retry on the clear path, BLOCKED + unstick on everything else
- [ ] Escalation and close audit unchanged around it

## Done summary
Wired the merge-resolver worker dispatch: a resolver_dispatched_at once-latch (schema v106) + daemon resolver-dispatch sweep that launches ONE resolve::<epic> worker per sticky worktree-merge-conflict (dispatch-once, reset on clear, breaker-covered via a first-class resolve verb). buildResolverBrief encodes both-intents + test-gate + retry on the clear path, BLOCKED + literal unstick sentence otherwise; the human escalation notify and close audit are unchanged (independent latches).
## Evidence
