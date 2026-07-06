## Description

**Size:** M
**Files:** src/worker-cell.ts, src/autopilot-worker.ts, cli/dispatch.ts, test/worker-cell.test.ts, test/dispatch-cli.test.ts, test/autopilot-worker.test.ts, docs/plugin-composition-map.md, plugins/plan/template/skills/work.md.tmpl, CONTEXT.md

### Approach

One shared decision, two caller-owned surfaces, byte-identical producer behavior.

**The helper** — new producer-side `src/worker-cell.ts` (header block states producer-only/filesystem-probing posture; node:* imports first). Exports `resolveWorkerCell` returning a closed discriminated union: `{ok:true, pluginDir: string|null}` (null = legitimately cell-less: either axis null / close row) or `{ok:false, kind: 'out-of-matrix'|'missing'|'shadowed', ...minimal machine fields}`. It wraps the pure `workerCellPluginDir` (which STAYS in reconcile-core — the pure reducer import must never gain an I/O module dep) in the same try/catch shape the producer compose uses, then runs the two filesystem probes in the producer's exact precedence order (invalid → missing → shadowed). Probes are INJECTED functions (`dirExists`, `probeShadow`) so the producer passes its existing per-cycle memoized shadow closure while dispatch passes the fresh default probe — the hot reconcile loop must never regress to a readdir per launch. `findShadowingWorkManifest` + `defaultShadowingWorkProbe` move here (exports preserved). The helper returns machine kinds + minimal fields ONLY — no prose, no KEEPER_ROOT: each surface composes its own text, which is what keeps the producer's byte-pinned reason strings (including the KEEPER_ROOT-baked remediation) untouched.

**Producer caller** — the inline guard block in autopilot-worker becomes an extract-and-call: exhaustive switch over the helper result closed by assertNever, re-composing the EXACT current sticky reason strings (worker-cell-invalid / worker-cell-missing / work-plugin-shadowed prefixes + remediation text) and the same emitDispatchFailed change-gated flow. Characterize FIRST: before cutting, pin the currently-emitted DispatchFailed objects for a fixture matrix (all three rejects + ok + cell-less) as golden assertions; the extract must keep every existing pin green unmodified. Enumerate all pin sites before the cut (at least the producer emission pins, the workerCommand --plugin-dir pin, and the dispatch-failure-key work-plugin-shadowed key pin).

**Dispatch caller** — `resolvePlanCwd` widens its return to carry the matched task's `{model, tier}` off the epics-projection tasks[] entries it already walks (the projection already serializes both; EpicRow.tasks type widens with model?/tier?; single fetch, single source — main() never re-walks). For `work::` rows only: call the helper (fresh probes), thread `pluginDir` into both the dry-run argv builder and the LaunchSpec; a partial cell (either axis null) launches cell-less exactly like the producer — parity, never a new reject. On any reject: die() exit 1 with a three-part actionable error (what was being launched, which cell/manifest is wrong, what to do next). resolveWorkerLaunchConfig remains the orchestrator-session {model, effort} source ONLY — never the cell source. close:: rows, resume paths, and free-form launches stay byte-identical (no --plugin-dir; existing argv byte-pins must stay green).

**Worktree refusal** — for `work::` only, after the race guard: read the autopilot_state singleton's worktree_mode client-side (same query seam as the race guard; the projectWorktreeMode ===1 coercion pattern). Flag on → refuse (die exit 1) naming both recoveries: let autopilot dispatch it (autopilot provisions the lane) or re-run with --force to deliberately launch in the shared checkout. --force overrides (the repo's fail-closed-unless-force precedent). Daemon unreachable → fail open like the race guard (daemon down means manual dispatch IS the recovery tool). The refusal keys on the GLOBAL flag deliberately: while worktree mode is on, any worktree-less manual work:: launch is wrong-topology. --dry-run runs the same resolution + guards and REFLECTS the refusal/reject outcome rather than printing misleading argv. The refusal is ephemeral stderr (client-side: no synthetic event, no board row, no problem-codes entry). True lane-joining parity is explicitly out of scope.

**Docs** — composition-map launch-channel table revised (shared route + refusal line + refreshed anchors); work.md.tmpl claim verified true post-change (edit only if inaccurate); CONTEXT.md gains a 1-2 sentence "Worker cell" glossary entry. Forward-facing prose only.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves. NOTE: src/autopilot-worker.ts reads as binary to plain grep — use `grep -a` or Read.*

**Required** (read before coding):
- src/autopilot-worker.ts:2283-2341 — the inline guard block to extract: closes over deps.dirExists ?? existsSync (:2272), deps.emitDispatchFailed, plan.pluginDir/pluginDirReject, KEEPER_ROOT baked into the missing-remediation string (:2308-2312), and the per-cycle shadow memo (:2205-2207, :2324-2326)
- src/autopilot-worker.ts:357-415 — findShadowingWorkManifest + defaultShadowingWorkProbe (loadPluginSources().pluginScanDirs, fail-safe) — move to the new module, exports preserved
- src/reconcile-core.ts:199-215 + :1629-1658 — the pure compose that STAYS + the producer compose try/catch whose precedence and null semantics the helper mirrors (:1730-1732 close rows cell-less)
- cli/dispatch.ts:253-333 (resolvePlanCwd — task match :312, EpicRow.tasks type :196 to widen), :508-540 (resolveWorkerLaunchConfig — session preset ONLY, the conflation trap), :672-680 (LaunchSpec build), :659-669 (dry-run exit site), :349-387 (checkRaceGuard — the query seam + fail-open precedent + --force), :30-31/:182-190 (die/argFault exit taxonomy)
- cli/autopilot.ts:454-466 — projectWorktreeMode coercion pattern for the guard read
- test/dispatch-cli.test.ts — the harness (ExitError, injected launch seam, query stub epicRows :138/:156 currently only {task_id, target_repo} — add model/tier), test/autopilot-worker.test.ts:1323-1355 + :3561/:3595/:3613 + makeConfirmRunningDeps ~:496, test/dispatch-failure-key.test.ts:142 — the pin inventory to keep green unmodified
- test/exec-backend.test.ts:607-702 — argv byte-pins that must stay green untouched

**Optional** (reference as needed):
- src/worktree-plan.ts:1-45 — new-module header + import-ordering conventions
- docs/plugin-composition-map.md:60-77 — the live launch-channel table content (cited :49 anchors have drifted)
- CONTEXT.md:29 — the Tier definition referencing the undefined "worker cell" term

### Risks

- Byte-pin blast radius: the reason strings are pinned across three test files — the helper-returns-machine-kinds / callers-compose-prose split is the only shape that survives; any prose in the helper breaks parity
- A naive extract dragging reconcile-core into importing the I/O module would poison the pure reducer import — the pure compose stays put, only impure callers import the helper
- fn-1129 also edits the composition-map table and dispatch.ts — ordered transitively behind this epic via fn-1123, but expect anchor drift if landing order changes

### Test notes

test/worker-cell.test.ts (new, fast tier): all union variants (ok, cell-less null, three rejects in precedence order), injected-probe cadence (memoized vs fresh), no-prose contract. test/dispatch-cli.test.ts additions: cell → spec.pluginDir + argv threading, reject → ExitError exit 1, worktree refusal (flag on → refuse; --force → launch; daemon-unreachable stub → fail open; close:: unaffected), dry-run reflects refusal. Producer parity: existing pins green UNMODIFIED plus the new pre-cut golden fixtures. Full fast suite green.

## Acceptance

- [ ] A manual dispatch of a todo plan task launches with that task's resolved worker-cell plugin loaded, and a resolution reject (out-of-matrix, missing manifest, shadowed work plugin — in that precedence) exits non-zero with a three-part actionable error instead of launching
- [ ] Autopilot's cell-resolution behavior is byte-identical: every existing sticky-reason, workerCommand, and dispatch-failure-key pin passes unmodified, and pre-cut golden fixtures of the emitted failure objects match post-extract
- [ ] A partial or absent cell launches cell-less on both paths identically; close, resume, and free-form launches emit byte-identical argv with no plugin flag
- [ ] Manual work-dispatch while the board is in worktree mode refuses with both recoveries named unless forced; the refusal fails open when the daemon is unreachable; dry-run reflects the same outcome a real run would hit
- [ ] Both callers switch exhaustively over a closed result union such that adding a reject kind fails compilation at any unmapped surface
- [ ] Composition-map, work-skill template, and glossary describe the shared route, the refusal, and the worker-cell term accurately; the full fast suite is green

## Done summary

## Evidence
