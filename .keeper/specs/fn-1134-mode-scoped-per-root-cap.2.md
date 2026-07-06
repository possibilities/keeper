## Description

**Size:** M
**Files:** src/readiness-client.ts, src/await-conditions.ts, cli/autopilot.ts, cli/status.ts, cli/watch.ts, cli/board.ts, cli/await.ts, test/readiness-client.test.ts, test/status.test.ts, test/watch.test.ts, test/await-conditions.test.ts

### Approach

Every client surface distinguishes stored intent from the effective cap, with one naming contract everywhere: `max_concurrent_per_root` (snake) / `maxConcurrentPerRoot` (camel) always means the EFFECTIVE cap — what dispatch uses — and the additive `max_concurrent_per_root_stored` / `maxConcurrentPerRootStored` carries durable intent. Stored never crosses the boot wire: the readiness-client snapshot re-projects it locally from the `autopilot_state` rows it already subscribes to (the shared raw-column projector IS the stored read post-inversion), while the boot-latched effective value keeps feeding the readiness pass unchanged.

Display seams that today read the raw column must either derive effective through the shared helper or deliberately render stored with an effective annotation: the autopilot viewer state, `autopilot show`, the shared banner segment (render `per-root N` when stored equals effective, `per-root 1 (stored N)` when they differ), and the board's own readiness pass — the board currently feeds its per-root demotions from the raw column, which would diverge from the reconciler the moment stored > effective. `keeper status` and `keeper watch` JSON carry both fields.

The `await changed` signature keys on the STORED value (worktree mode is already a signature input, so the effective cap is fully derivable from the pair — no information loss): setting intent while worktree is off is a visible board move and fires a change edge.

Rewrite the two stale help-text claims (reject-while-off; pins-back-to-1) to the store-intent / derived-effective contract. Help prose is forward-facing, addresses "the human", and keeps the glossary's "worktree mode" vocabulary.

New-client/old-server tolerance: absent `autopilot_state` rows or an older server omitting nothing new (stored is local-only) must degrade to omitting/nulling stored — never fabricate it from effective.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/readiness-client.ts:1886-1928 — snapshot un-drop; autopilot rows + worktreeMode already in scope; add the stored projection here
- src/readiness-client.ts:1952-1963 — boot latch; stays effective, comments restate meaning
- cli/autopilot.ts:416-429 — the raw-column projector (= stored post-inversion); :544 show payload; :849 banner segment; :1018 viewer state; :83-112 help text with the two stale claims
- cli/status.ts:164-168 + :358-362 and cli/watch.ts:154-156 + :207-209 — JSON shapes gaining the stored field
- cli/board.ts:92, :498, :506, :875 — board populates its readiness pass from the raw projector; must derive effective
- src/await-conditions.ts:1232-1244 — BoardSignatureInput + changedSignature; rekey the per-root input to stored; caller cli/await.ts:1575

**Optional** (reference as needed):
- src/collections.ts:672-679 — autopilot_state wire allowlist (both columns already present; expected no change)
- test/status.test.ts, test/watch.test.ts, test/await-conditions.test.ts, test/readiness-client.test.ts — extend for the two-field shape and signature rekey

### Risks

- `autopilot show` (raw source) and `keeper status` (boot-latched source) historically agreed only because stored equaled effective; carrying BOTH named fields on both surfaces is what keeps them from silently diverging — don't leave one surface single-field.
- Rekeying the changed-signature input alters `await changed` firing semantics; audit existing await-conditions tests for baked-in equal-values assumptions.

### Test notes

Status/watch snapshots: worktree off + stored 3 → `max_concurrent_per_root: 1`, `max_concurrent_per_root_stored: 3`; worktree on → both 3. Banner renders the annotation only when the values differ. Board readiness demotions match the reconciler under worktree-off + stored >1 (derive, not raw). changedSignature fires on a stored change while worktree is off and stays stable across a reconnect re-paint of an unchanged board. Pure in-process, existing suites, retryUntil.

## Acceptance

- [ ] Status and watch JSON carry both fields with the settled names; effective equals stored while worktree mode is on and floors to 1 while off
- [ ] `autopilot show`, the viewer banner, and the board surface both values, annotating stored only when it differs from effective, and the board's per-root readiness demotions use the derived effective cap
- [ ] `await changed` fires when the stored cap changes while worktree mode is off, and does not fire on an unchanged-board re-paint
- [ ] CLI help text states the store-intent / derived-effective contract and no longer claims rejection or pin-back-to-1 behavior
- [ ] A snapshot lacking autopilot rows omits/nulls the stored field rather than fabricating it
- [ ] `bun test` fast tier green

## Done summary

## Evidence
