## Overview

The forward-facing, decided slice of the larger planctl retirement: fix the
broken `keeper:await` command, flip git-worker's watch/ingest gate from the
dead `.planctl` dir to `.keeper` (a latent-correctness fix — keeper's own repo
is `.keeper`-only, so the current `.planctl` short-circuit already silently
fails for it), and sweep forward-facing prose + stale test fixtures naming the
retired `planctl` command/dir. End state: no `planctl` command-name or
`.planctl` dir-name references remain outside intentional residue (schema
columns, commit trailers, the `'planctl'` source badge, the `planctl_invocation`
reader, code symbols, dual-path transition wire kinds, the vendored-subtree
prune, and historical `.keeper/specs/`).

Explicitly EXCLUDED here (the "full planctl strip", deferred to
`docs/planctl-strip.md` and future epics): the DB column rename
(`planctl_*` -> `plan_*`) + event-log rewrite migration, the commit-trailer
rename, the `plugins/plan/` git-subtree de-vendor, and removal of dual-path
backward-compat scaffolding.

## Quick commands

- `bun run test:full`  # mandatory — T2 touches the git-worker process path
- `rg -n "planctl show" plugins/keeper/skills/`  # -> no hits after T1
- `rg -n '"\.planctl"' src/git-worker.ts`  # -> only the vendored plugins/plan prune remains after T2

## Acceptance

- [ ] `keeper:await` invokes `keeper plan show`, not the retired `planctl show`
- [ ] git-worker recognizes `.keeper` for watch-membership (`shouldWatchRoot` + probe-cache) AND commit-ingest (`isPlanctlChangedPath`), mirroring plan-worker (`.keeper`-only), with the vendored `plugins/plan/{.planctl,.keeper}` prune kept name-tolerant
- [ ] `isPlanctlChangedPath` mirrors plan-worker's full 4-shape set (incl. `state/epics/*.state.json`), closing the documented lockstep gap
- [ ] forward-facing prose naming the retired `planctl` command reads `keeper plan`; columns/trailers/source-badge/`planctl_invocation` reader/code symbols/dual-path wire kinds/`.keeper/specs/` untouched
- [ ] stale `.planctl/` fixture PATHS modernized to `.keeper/` where they are convenience values; recognition/backward-compat assertions preserved
- [ ] `bun run test:full` passes

## Early proof point

Task that proves the approach: `.2` (git-worker `.keeper` reconciliation) — it
proves the latent-correctness thesis. If it fails (a test pins the old
`.planctl` behavior as correct): re-confirm via the real-git ingest tests
whether `.planctl` recognition is load-bearing anywhere, and fall back to
accepting BOTH `.keeper` and `.planctl` instead of `.keeper`-only.

## References

- `docs/planctl-strip.md` — the deferred full-strip handoff (DB columns, trailers, subtree); written alongside this epic
- Prior sweeps `398b0183` + `57ce45a5` — the scope contract (intentional residue left intact)
- `src/plan-worker.ts:386,455-467,516-555` — the `.keeper`-only + 4-shape + name-tolerant-prune reference impl that T2 mirrors
