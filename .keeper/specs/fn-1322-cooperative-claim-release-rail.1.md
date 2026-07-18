## Description

**Size:** M
**Files:** src/commit-work/surface.ts, cli/session.ts, test/commit-work.test.ts, test/commit-work-process-identity.test.ts

### Approach

Implement ADR 0078's core: a claimant-side release verb (registered in
the session subverb registry beside terminate) that writes ONE durable,
size-bounded release record naming exactly the paths being released,
carrying the releasing session's identity proven the same way
commit-work's trusted-authority check proves ancestry (pid+start-time;
a peer can never release another session's claims). The record's sole
writer is the releasing session. The commit-work classifier gains a
read of valid release records layered PER-PATH over the
session-granular foreign-conflict classification: a released path under
a live foreign claim classifies as adoptable (voluntary
terminal-witness — the live sibling of the gone-witness), while the
claimant's unreleased paths stay protected. The SAME record self-fences
the releasing session: its own subsequent discover subtracts released
paths from its owned set, so a consenting holder cannot later win a
publication race on a path it gave away. The verb refuses paths the
session's own dirty surface still depends on only via the caller's
judgment — the verb validates ownership and record shape, not intent —
but the record write is atomic (a half-written record must never
classify). Vocabulary: this is a voluntary release, distinct from the
vacated-claim gone-witness (process gone) and from wrapper-attempt
lease release; keep the terms separate in code and prose.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/commit-work/surface.ts:1698-1747 — the classifier loop (mine/foreign/live/terminal); :1718-1722 the `mine` computation the self-fence subtracts from; :1565-1615 unsafeForeignSessions (session-granular — the per-path override layers here)
- src/commit-work/surface.ts:1320-1352 — defaultClaimLiveness, the gone-witness the release record mirrors
- cli/session.ts:27-140 — the SUBVERBS registry + the terminate precedent (identity-rechecked, never writes keeper.db, refuses working sessions)
- cli/commit-work.ts:968-1011 — trustedCommitWorkAuthority, the ancestry-proof pattern the verb reuses
- docs/adr/0078-cooperative-claim-release.md — the contract
- src/commit-work/identity.ts + src/commit-work/process-identity.ts — resolveInvocationIdentity / recordedProcessIdentity primitives

**Optional** (reference as needed):
- docs/adr/0068 — the vacated-claim stance this extends; adoption evidence requirements around surface.ts:1647-1651

### Risks

- Per-path layering over session-granular classification is the sound-abstraction risk — the epic's early-proof fallback is whole-claim release
- A half-written or unauthorized record classifying a path adoptable is the corruption vector — atomic write + identity proof + decline-on-ambiguity are the guards
- The release-record surface needs exactly one writer class (the releasing session) per the sole-writer rules

### Test notes

Through the injected CommitWorkDeps seams: released-path adoption
(peer side), unreleased-path protection, self-fence (releaser's own
discover), unauthorized release rejected (wrong identity), half-record
never classifies, record bounds enforced. Extend the existing
commit-work suites; no real daemon/git.

## Acceptance

- [ ] A live session can release named paths; a blocked peer's next discover classifies exactly those paths adoptable while the claimant's other paths stay protected
- [ ] The releasing session's own next commit-work excludes released paths from its owned set
- [ ] A release attempt without matching session identity is refused; a torn or oversized record never affects classification
- [ ] The full fast correctness gates stay green

## Done summary
Add ADR 0078 cooperative claim release: identity-proven 'keeper session release' verb writing a durable release record; commit-work classifier reads it as a per-path voluntary terminal-witness (foreign paths adoptable, unreleased protected) and self-fences the releaser; recycle-safe pid+start-time binding.
## Evidence
