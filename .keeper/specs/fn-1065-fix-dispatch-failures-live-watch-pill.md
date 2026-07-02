## Overview

The dispatch_failures collection descriptor declares pk: "verb", but the
table's real identity is (verb, id) and verb holds only a small class
(work / close). The live subscription keys everything by the descriptor
pk, so on `keeper board --watch` a second live edge to another same-verb row
collapses into one key and only one pill surfaces - degrading exactly this
feature's headline Gap A case (multiple worktree-finalize:<epic>-<hash>
rows). The initial snapshot and one-shot `keeper status` (both via runQuery)
are correct; only the live-diff path is lossy. This is a bug fix: give
dispatch_failures a composite live identity so each (verb, id) row tracks
independently on the watch path.

## Acceptance

- [ ] Two simultaneous same-verb dispatch_failures rows (e.g. two close
      worktree-finalize rows, or two work failures) each surface their own
      live pill on `keeper board --watch`, not just one.
- [ ] The composite-identity change is covered by a unit test at the pure
      diff/version seam (descriptor keying) without booting a real subscription.
- [ ] No regression to the initial-snapshot / status paths, and no change to
      the reducer/fold/RPC surface.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | collections.ts:601 pk:"verb" collapses all same-verb rows to one live-diff key (seedSubState watched/lastSent, selectVersionsByIds, byId fan-out); board --watch drops a second simultaneous work/close failure pill. |
| F2 | culled | - | cli/board.ts:582 closeFailureReasonFor picks first-of-Map-order kind for the close row; cosmetic, one pill per row by design, rare multi-kind same-epic case; auditor's own call is leave-as-is. |
| F3 | merged-into-F1 | .1 | F3 (no --watch multi-same-verb-row test) rides with F1's fix: the composite-identity change is unit-testable at the pure diff/version seam, so its coverage lands with F1's task. |

## Out of scope

- The cosmetic closeFailureReasonFor first-of-Map-order divergence (F2) - culled.
- Any reducer/fold/RPC/readiness change; this stays render/subscription-layer only.
