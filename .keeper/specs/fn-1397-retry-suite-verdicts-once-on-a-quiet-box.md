Finalize/recover suite verification run during live load mints
worktree-finalize-suite-red rows with NO named failing test (empty digest)
even when the same commit is green on a quiet rerun — five specimens on
2026-07-21 alone (fn-1351, fn-1390 x2, fn-1391 x2, all verified green at
9862-9873/0 by quiet scratch-worktree reruns of the identical merged
commits). Backlog #92 residual. The gate already distinguishes deadline-kill
(cannot-run) from red (src/autopilot-worker.ts:7646-7648); the gap is that a
crashed-no-failing-test verdict and a deadline cannot-run both surface
operator rows instead of triggering ONE bounded quiet retry.
