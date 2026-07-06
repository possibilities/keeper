/**
 * Boot-seed producer for the LIVE-ONLY tmux location surface (epic fn-907) —
 * `jobs.backend_exec_session_id` + `jobs.window_index`, the two columns the
 * `TmuxTopologySnapshot` fold owns.
 *
 * The tmux location surface is a Marten "Live projection" — NOT replayed from
 * history. The v83 migration raises a skip-floor (`tmux_projection_state.floor`)
 * to the current `max(events.id)`, so every historical `TmuxTopologySnapshot`
 * fold no-ops (the two location columns are charter-excluded from the
 * byte-identical re-fold). This producer re-derives the WHOLE-SERVER pane
 * topology once BEFORE the daemon serves, so a worker pane's live location is
 * correct from the first board read; the restore-worker's ~1s topology pulse
 * keeps it current thereafter.
 *
 * Boot slot (in `serveBootDrain`, AFTER the git seed):
 *
 *   drainToCompletion → seedKilledSweep → … → seedGitProjection
 *   seedTmuxProjection(db, stmts, { drainToCompletion })   // <-- here
 *   truncateEphemeralProjections → boot-complete (actuator/RPC gate)
 *
 * Job rows must already exist (post-`seedKilledSweep`) so the synthetic snapshot
 * matches them; the seed must precede the actuator gate so no consumer ever acts
 * on an unseeded location surface.
 *
 * Contract (mirrors {@link import("./git-boot-seed").seedGitProjection}, minus
 * the per-root machinery — the tmux probe is whole-server, ONE shot):
 *   1. read `max(events.id)` FIRST — this is the floor we persist. Events that
 *      arrive DURING the probe (id > this) re-apply idempotently via the live
 *      fold, so capturing the floor before the probe is the correctness anchor.
 *   2. mark `seed_required = 1` (crash mid-seed ⇒ next boot re-seeds).
 *   3. probe `tmux list-panes -a` (whole server) + the server generation. On a
 *      SUCCESSFUL probe (server up — panes MAY be empty), append a synthetic
 *      `TmuxTopologySnapshot` via the prepared `stmts.insertEvent` (NOT a raw
 *      INSERT — avoids EVENT_COLUMNS drift) carrying `{generation_id, panes}` and
 *      drain it. The synthetic event's id > floor, so `foldTmuxTopologySnapshot`
 *      overwrites each matching live tmux job's session + window_index.
 *   4. raise `floor = capturedMaxId` (monotonic) and — only on a successful probe
 *      — clear `seed_required`, ATOMICALLY relative to the fold above.
 *
 * **Degrade, NOT fatalExit.** This is a tmux shell-out on the daemon main thread;
 * a hang or failure must NOT take down the control plane. The default probe is
 * time-bound (the same `Bun.spawnSync` timeout the restore-worker pulse uses) and
 * never throws. On a DEGRADED probe — server gone, a transient failure (timeout /
 * EPIPE / SIGKILL / ENOENT), or an unresolvable server generation — the seed
 * appends NOTHING, leaves `seed_required` set, and serves; the next boot (or the
 * restore-worker's first topology pulse) re-derives the surface. A degraded probe
 * must NEVER wipe a job's last-known good location.
 *
 * Determinism note: this is a PRODUCER (the boot half of the tmux location
 * surface, the restore-worker's pulse being the steady-state half). It probes
 * tmux + reads `max(events.id)` — both producer-only. The synthetic
 * `TmuxTopologySnapshot` it appends is folded by the deterministic
 * `foldTmuxTopologySnapshot`, and the floor/seed_required it writes are
 * charter-excluded control state, so the re-fold byte-identical guarantee for the
 * OTHER projections is untouched.
 */

import type { Database } from "bun:sqlite";
import type { Stmts } from "./db";
import { raiseTmuxProjectionFloor, setTmuxProjectionSeedRequired } from "./db";
import { localeDefaultedEnv } from "./exec-backend";
import type { SpawnSyncFn, TmuxTopologyPane } from "./restore-worker";
import { probeServerGeneration, probeTmuxTopology } from "./restore-worker";

/**
 * Upper bound on each tmux probe spawn. A wedged tmux server degrades to a
 * transient skip rather than freezing boot — the seed leaves `seed_required` set
 * and serves. Matches the restore-worker pulse's probe timeout.
 */
export const TMUX_SEED_PROBE_TIMEOUT_MS = 5000;

/**
 * The validated whole-server topology a successful probe yields: the server
 * `generation_id` (the recycle-guard key) + the per-pane location map. `null` on
 * any degraded probe (server gone / transient / unresolvable generation) — the
 * seed appends nothing and keeps `seed_required` set.
 */
export interface TmuxSeedSnapshot {
  generation_id: string;
  panes: TmuxTopologyPane[];
}

export interface SeedTmuxProjectionOptions {
  /**
   * Drain the event log to completion. Passed in (not imported) so the boot-seed
   * stays decoupled from `daemon.ts` (which imports THIS module — a direct import
   * back would be circular) and so tests inject a drain stub.
   */
  drainToCompletion: (db: Database) => void;
  /**
   * The whole-server topology probe — the ONLY tmux-touching step. Defaults to
   * the real producer path ({@link defaultBuildTopologySnapshot}: the server
   * generation probe + `tmux list-panes -a`). Returns `null` for every degraded
   * outcome (server gone, a transient failure, or an unresolvable generation).
   * Injectable so tests drive the seed's fold / floor / seed_required DECISIONS
   * with synthetic snapshots — NEVER a real tmux invocation (the no-real-tmux
   * default tier).
   */
  buildSnapshot?: () => TmuxSeedSnapshot | null;
}

export interface SeedTmuxProjectionResult {
  /** The floor persisted (the `max(events.id)` captured before the probe). */
  floor: number;
  /** True when the probe SUCCEEDED (a snapshot was obtained ⇒ `seed_required` cleared). */
  seeded: boolean;
}

/**
 * Read `max(events.id)`. Returns 0 on an empty log. Captured BEFORE the probe and
 * persisted as the floor — see the module header's correctness note.
 */
function readMaxEventId(db: Database): number {
  const row = db.query("SELECT MAX(id) AS maxId FROM events").get() as {
    maxId: number | null;
  } | null;
  return row?.maxId ?? 0;
}

/**
 * Locale-defaulted, stderr-piping spawn for the tmux probes — same shape as the
 * restore-worker's `defaultTopologySpawnSync`. The locale default is LOAD-BEARING:
 * a daemon-side tmux client under the C locale (the LaunchAgent env carries no
 * LANG/LC_*) sanitizes the `-F` TAB delimiters to `_` and drops every row; stderr
 * is piped so {@link probeTmuxTopology} can classify server-gone vs transient.
 */
const defaultSeedSpawnSync: SpawnSyncFn = (cmd) =>
  Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: TMUX_SEED_PROBE_TIMEOUT_MS,
    env: localeDefaultedEnv(process.env as Record<string, string | undefined>),
  });

/**
 * The default {@link SeedTmuxProjectionOptions.buildSnapshot}: the real producer
 * path. Resolves the server generation (the recycle-guard key) and the
 * whole-server pane topology, reusing the restore-worker's
 * {@link probeServerGeneration} + {@link probeTmuxTopology} (never reimplemented).
 * Returns `null` when:
 *   - the generation probe yields no generation (no server / garbage) — we can't
 *     stamp the recycle key, so don't seed an unkeyable topology; OR
 *   - the topology probe is degraded (`gone` server-down, or `transient`
 *     timeout/EPIPE/SIGKILL/ENOENT) — keep the last-known location.
 * A SUCCESSFUL probe with EMPTY panes still returns a snapshot (server up, no
 * panes): the fold treats an empty pane set as "nothing to assert" and the seed
 * clears `seed_required` — a tmux server with no live panes is a settled state,
 * not a probe failure. PURE relative to {@link defaultSeedSpawnSync}; NEVER throws.
 */
function defaultBuildTopologySnapshot(): TmuxSeedSnapshot | null {
  const generationId = probeServerGeneration(defaultSeedSpawnSync);
  if (generationId == null) {
    return null;
  }
  const probe = probeTmuxTopology(defaultSeedSpawnSync);
  if (probe.kind !== "panes") {
    // gone / transient — keep last state, never wipe.
    return null;
  }
  return { generation_id: generationId, panes: probe.panes };
}

/**
 * Append ONE synthetic `TmuxTopologySnapshot` carrying `{generation_id, panes}`
 * via the prepared `stmts.insertEvent`. Byte-identical to the live channel main
 * mints from the restore-worker's `tmux-topology-snapshot` message (same
 * `hook_event` / `event_type` / synthetic `session_id` / `$data` shape) so the
 * fold path is the SAME one production walks at runtime.
 */
function insertSyntheticTmuxTopology(
  stmts: Stmts,
  snapshot: TmuxSeedSnapshot,
): void {
  stmts.insertEvent.run({
    $ts: Date.now() / 1000,
    $session_id: "tmux-topology-snapshot",
    $pid: null,
    $hook_event: "TmuxTopologySnapshot",
    $event_type: "tmux_topology_snapshot",
    $tool_name: null,
    $matcher: null,
    $cwd: null,
    $permission_mode: null,
    $agent_id: null,
    $agent_type: null,
    $stop_hook_active: null,
    $data: JSON.stringify({
      generation_id: snapshot.generation_id,
      panes: snapshot.panes,
    }),
    $subagent_agent_id: null,
    $spawn_name: null,
    $start_time: null,
    $slash_command: null,
    $skill_name: null,
    $plan_op: null,
    $plan_target: null,
    $plan_epic_id: null,
    $plan_task_id: null,
    $plan_subject_present: null,
    $tool_use_id: null,
    $config_dir: null,
    $bash_mutation_kind: null,
    $bash_mutation_targets: null,
    $plan_files: null,
    $backend_exec_type: null,
    $backend_exec_session_id: null,
    $backend_exec_pane_id: null,
    $background_task_id: null,
    $mutation_path: null,
    $worktree: null,
  });
}

/**
 * Re-derive the LIVE-ONLY tmux location surface (the whole-server pane topology)
 * BEFORE serving, then raise the skip-floor + clear `seed_required`. See the
 * module header for the full contract. NEVER throws — a probe failure is isolated
 * (the snapshot builder swallows + returns `null`), and either way the floor is
 * still raised so the historical replay stays skipped and the daemon serves.
 */
export function seedTmuxProjection(
  db: Database,
  stmts: Stmts,
  options: SeedTmuxProjectionOptions,
): SeedTmuxProjectionResult {
  const buildSnapshot = options.buildSnapshot ?? defaultBuildTopologySnapshot;

  // 1. Capture the floor FIRST (before the probe), so events arriving during the
  //    probe (id > this) re-apply idempotently via the live fold.
  const floor = readMaxEventId(db);

  // 2. Mark mid-flight. A crash before the atomic finish leaves this set, so the
  //    next boot re-seeds.
  setTmuxProjectionSeedRequired(db, true);

  let seeded = false;
  try {
    const snapshot = buildSnapshot();
    if (snapshot != null) {
      // SUCCESSFUL probe (server up; panes MAY be empty). Append the synthetic
      // snapshot (id > floor → the live fold overwrites each matching job's
      // location) and drain it.
      insertSyntheticTmuxTopology(stmts, snapshot);
      options.drainToCompletion(db);
      seeded = true;
    } else {
      // DEGRADED probe (server gone / transient / unresolvable generation) — append
      // nothing, leave `seed_required` set so the next boot re-seeds. A blip must
      // never wipe a job's last-known good location.
      console.error(
        "[keeperd] tmux boot-seed: probe degraded (server gone / transient / " +
          "no generation) — surface left to the restore-worker's topology pulse; " +
          "seed_required stays set (next boot re-seeds)",
      );
    }
  } catch (err) {
    // Defense in depth: the default probe never throws, but an injected builder /
    // drain might. Isolate it — never abort the seed or the daemon.
    console.error(`[keeperd] tmux boot-seed failed: ${err}`);
  }

  // 3. Persist the floor (monotonic raise) regardless of probe outcome — the
  //    historical replay must stay skipped. Clear `seed_required` ONLY on a
  //    successful probe (a degraded probe keeps it set to re-seed next boot).
  raiseTmuxProjectionFloor(db, floor);
  if (seeded) {
    setTmuxProjectionSeedRequired(db, false);
  }

  return { floor, seeded };
}
