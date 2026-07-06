## Overview

`max_concurrent_per_root` becomes a mode-scoped setting that survives worktree-mode toggles: the stored column is durable intent ("the per-root cap while worktree mode is on") and the effective cap dispatch honors is derived at read time (`worktree_mode ? stored : 1`). The write-time invariant that rejects/coerces the value is deleted; the safety invariant (never >1 concurrent worker in one shared checkout) moves to the consumption seams via one shared pure helper, which is strictly stronger — a stale >1 row can no longer over-dispatch. Toggling worktree off and back on restores the prior cap with no re-set.

## Quick commands

- `keeper autopilot config max_concurrent_per_root 3` — legal regardless of worktree mode; while worktree is off the success envelope notes the value is stored with effective cap 1
- `keeper autopilot worktree off && keeper status --format json | jq '.data.autopilot | {max_concurrent_per_root, max_concurrent_per_root_stored}'` — effective 1, stored 3
- `keeper autopilot worktree on && keeper status --format json | jq '.data.autopilot.max_concurrent_per_root'` — 3 restored, no re-set
- `bun test` — fast tier green

## Acceptance

- [ ] Toggle round-trip: a cap set while worktree mode is on survives off→on untouched (no re-set needed)
- [ ] Setting the cap while worktree mode is off is legal, stores intent, and the result envelope says so
- [ ] No dispatch-relevant seam ever computes a per-root cap >1 while worktree mode is off (reconciler, autoclose, boot-status latch, board readiness)
- [ ] Status/watch/show surface stored and effective distinctly; the take-over capture/restore contract round-trips the stored value
- [ ] No surface (CLI help, autopilot SKILL, orient snippet) still claims reject-while-off or pin-back-to-1 semantics

## Early proof point

Task that proves the approach: `.1` — the shared helper, invariant deletion, and the two producer-side derive seams. If the derivation can't reach `worktree_mode` at some consumer, revisit enforcement placement before touching display surfaces.

## References

- CONTEXT.md "Per-root cap" glossary entry (landed pre-scaffold) — the stored-vs-effective vocabulary every surface tracks
- `worktree_multi_repo` is the dormant-setting template: shape-only validation, no cross-field invariant (src/rpc-handlers.ts:430-441)
- Old-regime observed meaning: stored always equaled effective, so publishing effective in the existing wire/status field is meaning-stable; stored is the new concept and gets the new additive field `max_concurrent_per_root_stored`

## Docs gaps

- **cli/autopilot.ts**: help text carries two now-false claims (reject-while-off; pins-back-to-1) — rewritten in task .2
- **plugins/keeper/skills/autopilot/SKILL.md**: caps table, capture/restore field list, status examples — task .3
- **plugins/prompt/corpus/.../snippets/engineering/orient.md.tmpl**: autopilot envelope field list — task .3

## Best practices

- **Store intent, derive effective through one resolver:** consumers never re-interpret the raw stored value inline; divergent per-seam derivations drift [Unleash/Octopus feature-flag canon]
- **Never repurpose a wire field's meaning:** additive fields only; changed meaning of existing information is a semantic break for old clients [Protobuf/Specmatic]
- **Fail closed:** missing/malformed/absent stored value derives to cap 1, never permissive [authzed/default-deny]
- **Level-triggered recompute:** derive fresh each reconcile cycle; never memoize the effective cap across toggles [Kubernetes reconciler canon]
