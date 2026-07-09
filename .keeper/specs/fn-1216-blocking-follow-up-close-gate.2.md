## Description

**Size:** M
**Files:** plugins/plan/src/verbs/close_finalize.ts, plugins/plan/src/verbs/close_preflight.ts, plugins/plan/src/verbs/scaffold.ts, plugins/plan/src/verbs/verdict_submit.ts, plugins/plan/src/models.ts, plugins/plan/skills/close/SKILL.md, plugins/plan/test/saga-close-finalize.test.ts, plugins/plan/test/verbs-creation.test.ts, plugins/plan/test/consistency-skills.test.ts

### Approach

Add the blocking branch to the close saga; it stays dormant until the planner prose (the contracts task) starts emitting the verdict field. Verdict surface: the verdict schema accepts blocks_closing (strict boolean) and blocks_closing_reason (length-capped, non-empty iff true), paired exactly like fatal/fatal_reason; an absent field is legacy non-blocking; a malformed value is rejected at submit so garbage can never coerce toward the irreversible close. New CloseOutcome followup_blocks_close — the only member that does not stamp the epic done. Blocking first pass (verdict true, follow-up not yet minted): compute the dep substitution — the source's depends_on_epics entries that still resolve (exists, unambiguous; status irrelevant), never the source itself — and scaffold the follow-up with that override plus a blocksClosingOf stamp threaded through the same internal-arg pattern createdByCloseOf uses, so pointer and epic land atomically in the scaffold commit; persist the minted follow-up id in a durable close artifact (what later distinguishes adopt from a deleted follow-up); arm via armEpicValidated only after a successful scaffold so the MERGE_IN_PROGRESS retry stays safe; release the close-exclusive marker exactly as the closing outcomes do — without the release the second closer dies on the claim; emit followup_blocks_close leaving the source open. Adopt/re-entry branch, which must run BEFORE any audit machinery: discover the follow-up by pointer in ANY status via a separate lookup (the existing open-only finder keeps both its callers untouched); follow-up done leads to epic close and the ordinary closed_with_followup; follow-up alive but not done re-emits followup_blocks_close idempotently with no re-scaffold; minted-marker present but follow-up absent (deleted while gated) is a typed failure — never an implicit close, never a blind re-scaffold — surfacing through the existing sticky dispatch-failure needs-human machinery. close-preflight emits blocking_followup {id, status} or null so the skill can short-circuit past the audit phases on re-entry. All stamps and the substitution key on the primary_repo state context, not cwd. normalizeEpic gains the blocks_closing_of default. Scaffold's dep validation stays status-blind — add the explicit carve-out test asserting an all-done dep list passes, so a future hardening cannot silently break gate substitution. Preserve the selection-verdict flag and document shape the apply-selection seam threads through finalize — this epic is dep-gated behind that work; build on its landed contract.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/close_finalize.ts:89-96 — CLOSE_OUTCOMES enum
- plugins/plan/src/verbs/close_finalize.ts:543-560 — the done-only idempotency short-circuit the blocking path deliberately bypasses
- plugins/plan/src/verbs/close_finalize.ts:116-117 — the close-marker release the new outcome must call
- plugins/plan/src/verbs/close_finalize.ts:176-230 — findFollowupEpic (open-only; two callers near :546 and :643 stay as-is — add a separate any-status lookup)
- plugins/plan/src/verbs/close_finalize.ts:287-336 and plugins/plan/src/verbs/scaffold.ts:1157 — the createdByCloseOf internal-arg pattern to extend
- plugins/plan/src/verbs/close_finalize.ts:777-789 — the armEpicValidated chokepoint
- plugins/plan/src/verbs/scaffold.ts:480-499 — the status-blind dep validator the substitution relies on (twin passes near :682 and :882)
- the verdict submit verb and its schema/tests (locate the exact file) — a required companion edit, or every blocking verdict fails VERDICT_INVALID and silently degrades to non-blocking

**Optional** (reference as needed):
- plugins/plan/src/verbs/close_preflight.ts:250 — the preflight envelope the new field joins
- plugins/plan/test/saga-close-finalize.test.ts:44-49 and :1002-1006 — the CLOSE_SKILL_HANDLERS exhaustiveness gate
- plugins/plan/test/consistency-skills.test.ts:420-425 — the SKILL.md backtick gate (the minimal SKILL.md outcome mention lands in THIS task to keep it green)
- plugins/plan/test/saga-close-finalize.test.ts:59-166 — truth-table helpers (doneEpic, seedVerdict, seedFollowupYaml, finalize)

### Risks

- Adopt-before-audit ordering: if the re-entry branch runs after the audit respawns, a second closer re-authors a divergent verdict and can mint a duplicate follow-up.
- The deleted-follow-up state is observationally identical to a first pass unless the minted id is persisted — the durable minted-marker is load-bearing.
- Forgetting the marker release wedges every blocking close permanently on re-claim.

### Test notes

In-process truth-table describes on the suite's main(argv) harness (no subprocess): blocking first pass asserts the source stays open, the follow-up is minted and armed with substituted deps and the pointer stamped, and the marker is released; re-entry with a live follow-up asserts an idempotent re-emit and zero duplicate scaffolds; re-entry with a done follow-up asserts adopt and closed_with_followup; minted-but-absent asserts the typed failure; an empty substitution set scaffolds deps as an empty list; both exhaustiveness gates green; verdict submit accepts and rejects the new fields per the pairing rule.

## Acceptance

- [ ] A verdict carrying a true blocking decision drives close-finalize to mint an armed follow-up whose epic deps are the still-resolving subset of the source's deps (never the source), stamp the gate pointer on it, release the close claim, and terminate with the new outcome while the source epic stays open
- [ ] Re-running close-finalize against a live gated source is idempotent (no duplicate follow-up, same outcome), adopts a done follow-up into the ordinary followup close, and turns a deleted-while-gated follow-up into a typed failure rather than a close or a re-scaffold
- [ ] A verdict without the new fields, or any non-blocking verdict, drives byte-for-byte today's outcomes, and both close-outcome exhaustiveness gates pass with the five-member enum
- [ ] Preflight reports the in-flight blocking follow-up's id and status, and the plan-plugin suite is green

## Done summary
Added the close saga's blocking-follow-up branch: a verdict blocks_closing:true mints an armed follow-up with substituted (still-resolving, never-source) deps plus a committed blocks_closing_of pointer, holds the source open (followup_blocks_close), and a re-dispatched closer adopts a done follow-up, re-emits idempotently for a live one, or fails typed on a deleted one. Verdict schema gained the optional blocks_closing/blocks_closing_reason pair; close-preflight surfaces the in-flight gate.
## Evidence
