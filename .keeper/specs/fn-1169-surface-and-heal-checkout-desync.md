## Overview

The plumbing base→default merge advances `refs/heads/<default>` without touching the shared checkout; when its post-merge resync is skipped (dirty/off-branch/errored) the checkout silently trails landed history, and everything served off the working tree — selector policy, skills, worker templates, daemon source at next boot — is stale. This epic makes that condition visible as a first-class needs-human distress row, then makes the resync stale-aware so it self-heals: stale paths advance, real human edits are preserved, and only a genuine edit-vs-merge collision leaves the row standing.

## Quick commands

- `keeper status | jq '.data.board // .data' | rg -a 'shared-checkout-desync' || echo "no desync row"` — the row surfaces here when a resync skip leaves the checkout trailing
- `bun test test/dispatch-failure-key.test.ts test/dispatch-failure-pill.test.ts` — family consistency gates
- `KEEPER_RUN_SLOW=1 bun test test/worktree-git-catchup-realgit.slow.test.ts` — real-git proof of update-if-unmodified semantics

## Acceptance

- [ ] A skipped or aborted post-merge resync surfaces a per-repo `shared-checkout-desync` needs-human row within one reconcile cycle, and a human's ordinary edit alone never mints it
- [ ] The row level-clears on positive evidence (on-default checkout content-carries the default tip), surviving epic teardown and daemon restarts; it is not retry-clearable, not a jam, orphan-GC-exempt
- [ ] After a ref advance, a checkout with no conflicting edits is caught up in the same merge call (stale paths advance, human edits preserved); a colliding path aborts the whole catch-up with no writes and the row stays up
- [ ] No SCHEMA_VERSION change anywhere in the epic
- [ ] Fast suite green; slow-tier real-git test proves heal-unrelated-edit and abort-on-colliding-edit

## Early proof point

Task that proves the approach: ordinal 1 (the distress family + probe). If the event-seeded latch shape fights the snapshot/tracker plumbing, fall back to a pure per-cycle latch persisted via the open row itself — the row's own dir set re-seeds the latch after restart.

## References

- docs/adr/0008-plumbing-base-default-merge.md — decision-B ("best-effort resync, skipped silently, cosmetic") is the stance this epic supersedes in part; task 2 lands the new ADR + supersession pointer
- Sibling distress families to copy: shared-checkout-wedge (canonical tracker + per-repo `repoDirHash` keying + verb-neutral mint channel), stale-base-lane (per-cycle snapshot probe idiom), worktree-lane-wedge, drained shared-checkout-dirty (fn-1143 neuter — stays byte-untouched; the desync family is a NEW reason class, never an un-neutering)
- `fn-1164-phantom-working-lifecycle-fix` (overlap) — its stuck-state sentinel producer extends the same `src/autopilot-worker.ts` sweep surface, distinct regions; it also carries a rewinding migration, which is why this epic must not bump SCHEMA_VERSION. Sequenced: fn-1164 now depends on this epic.
- Incident evidence baked into the design: the observed steady state had index==HEAD with only worktree-side staleness, while a fresh desync leaves index behind HEAD — the detector contract therefore keys on the skip/abort event plus "content-carries the default tip" clear evidence, never on any single index-vs-HEAD orientation.

## Docs gaps

- **CLAUDE.md `## Autopilot` block**: one dense row-contract line for `shared-checkout-desync` woven into the existing distress enumeration (task 1 deliverable)
- **docs/adr/**: new ADR superseding 0008's decision-B consequence in part + supersession pointer on 0008 (task 2 deliverable)
- **CONTEXT.md**: optional one-sentence glossary term for the desync signal — offer to the human at close, not a task

## Best practices

- **`git read-tree -m -u <preMergeTip> <newTip>` is the catch-up primitive** — the plumbing form of `pull --ff-only`'s twoway_merge; pass both trees explicitly (post-CAS, HEAD already names the new tip) [git-read-tree(1)]
- **`git update-index -q --really-refresh` immediately before read-tree is load-bearing** — closes the racy-clean window (a full second on macOS/APFS) so a same-second human edit trips the safe abort instead of being clobbered [racy-git doc]
- **All-or-nothing abort is the safety valve** — one path both upstream-changed and locally-edited fails the entire op with no writes (two-tree cases 16/17/21); treat non-zero exit as the normal safe outcome, never route around it
- **Never `git checkout <tree> -- <paths>`, `checkout -f`, `--reset`, or hand-written blobs** — pathspec checkout silently overwrites unstaged edits; hand-rolled writers reopen the CVE-2021-21300 path-traversal class
- **The flock serializes daemon-vs-daemon only** — the human-editor race is closed by refresh + read-tree's atomic abort, not the lock
