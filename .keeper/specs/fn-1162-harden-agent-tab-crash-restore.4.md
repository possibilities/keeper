## Description

**Size:** M
**Files:** cli/setup-tmux.ts, src/restore-worker.ts, test/setup-tmux.test.ts, test/restore-worker.test.ts

### Approach

The boot offer honors the escalate-or-refuse contract. `defaultRestoreOffer` carries `ambiguous` and `fallbackNote` through to the offer flow: a contested pick at a TTY presents the numbered generation picker (reuse cli/tabs.ts's menu + choice parser), non-TTY prints a visible stderr refusal naming `keeper tabs restore` — never a silent auto-pick, never a silent drop. Add the mirror cross-check: compare the derivation's picked cohort against the last non-empty restore.json current set (job-id set comparison); disagreement forces the ambiguous path (the mirror stays a disaster-fallback cross-check, never the primary source). In restore-worker, add the refuse-to-clobber guard: never overwrite a non-empty restore.json/revive.sh with an empty live set (protects the pre-crash mirror from a post-crash keeperd restart); the next non-empty write proceeds normally, and sticky-when-empty is accepted for a fallback surface. Offer text names the picked generation's agent count, age, and session names.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/setup-tmux.ts:670-721 — RESTORABLE + defaultRestoreOffer (where ambiguous is currently dropped)
- cli/setup-tmux.ts:970-1081 — the offer/confirm/apply flow + retry store interplay
- cli/tabs.ts:309-386 — classifyRestore + formatGenerationMenu + parsePickerChoice to reuse
- src/restore-worker.ts:940-1000 — the restorePulse write path + per-file content-hash gates (clobber-guard site)

**Optional** (reference as needed):
- src/restore-worker.ts:545-566 — serializeForHash/serializeForWrite split (captured_at excluded from hash)
- test/setup-tmux.test.ts — RestoreOfferFn fakes + retry-store round-trip patterns

### Risks

- setup-tmux runs at shell boot where non-TTY is common — the refusal line must be unmissable but must not block provisioning.
- The clobber guard must not suppress legitimate empty writes forever (human intentionally closed all tabs): acceptable staleness for a fallback, but the header must say so.

### Test notes

Fake offers with ambiguous set/unset × TTY/non-TTY: assert picker spawn, refusal line, and that accepted picks apply the chosen generation id. Clobber guard: non-empty file + empty live set ⇒ no write; empty file + empty set ⇒ no-op; non-empty set ⇒ normal write.

## Acceptance

- [ ] A contested pick at a TTY presents a numbered picker; non-TTY prints a visible refusal naming the recovery command; neither path silently restores the auto-pick.
- [ ] A disagreement between the derived cohort and the last non-empty mirror forces the escalation path.
- [ ] A keeperd restart with zero live agents can no longer blank a non-empty restore.json or revive.sh.

## Done summary
setup-tmux boot offer now escalates a contested auto-pick (TTY numbered picker / non-TTY visible refusal naming keeper tabs restore) with a disaster-mirror cross-check forcing ambiguity on cohort disagreement; restore-worker refuses to blank a non-empty restore.json/revive.sh with an empty live set.
## Evidence
