/**
 * Fast-tier unit tests for `src/bus-wake.ts` — the `keeper bus wake planner@<epic>`
 * client-side resume pipeline. Drives the PURE decision functions and the
 * `runWake` orchestration with fully injected deps (no real tmux/daemon/process/fs):
 *  - `creatorIsLive` / `isRunningState` — the spawn-time liveness recheck.
 *  - `inCooldown` — the failed-wake circuit-breaker window.
 *  - `pickCreatorJob` — the newest-creator pick over >1 edges.
 *  - `runWake` — resolve → liveness-skip → single-flight-skip → cooldown-skip →
 *    launch (the unified `keeperAgentLaunch` resume transport, resume target carried
 *    through the seam) → launch_failed bumps cooldown.
 */

import { expect, test } from "bun:test";
import {
  creatorIsLive,
  inCooldown,
  isRunningState,
  isStoppedPaneLive,
  pickCreatorJob,
  runWake,
  WAKE_COOLDOWN_MS,
  type WakeCooldownRecord,
  type WakeCreator,
  type WakeDeps,
} from "../src/bus-wake";
import type { LaunchResult } from "../src/exec-backend";

const exactClaim = {
  verb: "work",
  id: "fn-1-a.1",
  attempt_id: 41,
  state: "bound",
  session_id: "s1",
  legacy_unfenced: 0,
};

function creator(overrides: Partial<WakeCreator> = {}): WakeCreator {
  return {
    job_id: "sess-creator",
    cwd: "/abs/repo",
    title: "planner",
    state: "stopped",
    backend_exec_pane_id: null,
    updated_at: 100,
    ...overrides,
  };
}

/** Build a `WakeDeps` with sensible passing defaults + per-test overrides. The
 *  in-memory cooldown map doubles as the read/write store so a launch_failed write
 *  is observable. */
function makeDeps(
  overrides: Partial<WakeDeps> & {
    jobs?: WakeCreator[];
    live?: Set<string>;
    livePanes?: ReadonlySet<string> | null;
    launchResult?: LaunchResult;
    nowMs?: number;
    cooldowns?: Map<string, WakeCooldownRecord>;
    locked?: Set<string>;
  } = {},
): WakeDeps {
  const cooldowns =
    overrides.cooldowns ?? new Map<string, WakeCooldownRecord>();
  const locked = overrides.locked ?? new Set<string>();
  return {
    launcherPrefix: overrides.launcherPrefix ?? [
      "/abs/bun",
      "/abs/cli/keeper.ts",
      "agent",
    ],
    resolveCreatorJobs:
      overrides.resolveCreatorJobs ?? (() => overrides.jobs ?? [creator()]),
    liveSessionIds:
      overrides.liveSessionIds ?? (() => overrides.live ?? new Set<string>()),
    livePaneIds:
      overrides.livePaneIds ??
      (() =>
        overrides.livePanes !== undefined
          ? overrides.livePanes
          : new Set<string>()),
    readCooldown: overrides.readCooldown ?? ((id) => cooldowns.get(id) ?? null),
    writeCooldown:
      overrides.writeCooldown ??
      ((id, rec) => {
        if (rec === null) cooldowns.delete(id);
        else cooldowns.set(id, rec);
      }),
    tryLock:
      overrides.tryLock ??
      ((id) => (locked.has(id) ? null : { release: () => {} })),
    launch:
      overrides.launch ??
      (async () => overrides.launchResult ?? ({ ok: true } as LaunchResult)),
    ...(overrides.requestResume === undefined
      ? {}
      : { requestResume: overrides.requestResume }),
    ...(overrides.awaitResumeAccepted === undefined
      ? {}
      : { awaitResumeAccepted: overrides.awaitResumeAccepted }),
    ...(overrides.revokeAttempt === undefined
      ? {}
      : { revokeAttempt: overrides.revokeAttempt }),
    now: overrides.now ?? (() => overrides.nowMs ?? 1_000_000),
    noteLine: overrides.noteLine ?? (() => {}),
  };
}

// ---------------------------------------------------------------------------
// Pure liveness + cooldown decisions
// ---------------------------------------------------------------------------

test("isRunningState: only 'working' is running", () => {
  expect(isRunningState("working")).toBe(true);
  expect(isRunningState("stopped")).toBe(false);
  expect(isRunningState("ended")).toBe(false);
  expect(isRunningState(null)).toBe(false);
});

test("creatorIsLive: true when on the bus OR working OR stopped+live-pane; false otherwise", () => {
  const job = creator({
    job_id: "s1",
    state: "stopped",
    backend_exec_pane_id: "%5",
  });
  expect(creatorIsLive(job, new Set(["s1"]), new Set())).toBe(true); // on the bus
  expect(
    creatorIsLive(
      creator({ job_id: "s1", state: "working" }),
      new Set(),
      new Set(),
    ),
  ).toBe(true); // running
  // stopped + pane listed in the live-pane set, absent from the bus → live (the
  // F1 hazard case: a redundant resume would double-attach).
  expect(creatorIsLive(job, new Set(), new Set(["%5"]))).toBe(true);
  // genuinely gone: stopped, pane not listed, not on the bus → wakes.
  expect(creatorIsLive(job, new Set(), new Set())).toBe(false);
});

test("isStoppedPaneLive: only a stopped row with its pane listed is live", () => {
  const stopped = creator({ state: "stopped", backend_exec_pane_id: "%5" });
  expect(isStoppedPaneLive(stopped, new Set(["%5"]))).toBe(true);
  expect(isStoppedPaneLive(stopped, new Set(["%9"]))).toBe(false);
  // No recorded pane → not live-provable.
  expect(
    isStoppedPaneLive(
      creator({ state: "stopped", backend_exec_pane_id: null }),
      new Set(["%5"]),
    ),
  ).toBe(false);
  // A working row never consults the pane set here (it short-circuits upstream).
  expect(
    isStoppedPaneLive(
      creator({ state: "working", backend_exec_pane_id: "%5" }),
      new Set(["%5"]),
    ),
  ).toBe(false);
  // null probe (unavailable) → treat stopped as live (on doubt, SKIP the resume).
  expect(isStoppedPaneLive(stopped, null)).toBe(true);
});

test("inCooldown: a recent failure gates; old/absent/zero-failure does not", () => {
  const now = 1_000_000;
  expect(inCooldown(null, now)).toBe(false);
  expect(inCooldown({ failures: 0, last_failure_ms: now }, now)).toBe(false);
  expect(inCooldown({ failures: 1, last_failure_ms: now - 1000 }, now)).toBe(
    true,
  );
  expect(
    inCooldown(
      { failures: 1, last_failure_ms: now - WAKE_COOLDOWN_MS - 1 },
      now,
    ),
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// pickCreatorJob — deterministic newest-first over >1 edges
// ---------------------------------------------------------------------------

test("pickCreatorJob: null on empty, newest-by-updated_at over multiple edges", () => {
  expect(pickCreatorJob([])).toBe(null);
  const older = creator({ job_id: "old", updated_at: 10 });
  const newer = creator({ job_id: "new", updated_at: 99 });
  expect(pickCreatorJob([older, newer])?.job_id).toBe("new");
  expect(pickCreatorJob([newer, older])?.job_id).toBe("new");
});

// ---------------------------------------------------------------------------
// runWake — the full pipeline
// ---------------------------------------------------------------------------

test("runWake: unknown_creator when the epic resolves to no creator job", async () => {
  const res = await runWake("fn-x", makeDeps({ jobs: [] }));
  expect(res.outcome).toBe("unknown_creator");
  expect(res.sessionId).toBe(null);
});

test("runWake: already_live skips the launch when the creator is on the bus", async () => {
  let launched = false;
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [creator({ job_id: "s1" })],
      live: new Set(["s1"]),
      launch: async () => {
        launched = true;
        return { ok: true };
      },
    }),
  );
  expect(res.outcome).toBe("already_live");
  expect(launched).toBe(false);
});

test("runWake: already_live skips when jobs.state is working", async () => {
  const res = await runWake(
    "fn-x",
    makeDeps({ jobs: [creator({ job_id: "s1", state: "working" })] }),
  );
  expect(res.outcome).toBe("already_live");
});

test("runWake: already_live skips a stopped creator whose pane is live but off the bus", async () => {
  let launched = false;
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [
        creator({ job_id: "s1", state: "stopped", backend_exec_pane_id: "%7" }),
      ],
      live: new Set<string>(), // NOT on the bus (never re-armed `keeper bus watch`)
      livePanes: new Set(["%7"]), // but its tmux pane is still listed
      launch: async () => {
        launched = true;
        return { ok: true };
      },
    }),
  );
  expect(res.outcome).toBe("already_live");
  expect(launched).toBe(false);
});

test("runWake: a stopped creator with no live pane and off the bus still wakes", async () => {
  let launched = false;
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [
        creator({ job_id: "s1", state: "stopped", backend_exec_pane_id: "%7" }),
      ],
      live: new Set<string>(),
      livePanes: new Set(["%99"]), // some OTHER pane, not the creator's
      launch: async () => {
        launched = true;
        return { ok: true };
      },
    }),
  );
  expect(res.outcome).toBe("launched");
  expect(launched).toBe(true);
});

test("runWake: an exact parked claim resumes despite a live shell pane and carries its attempt", async () => {
  const attempts: Array<number | undefined> = [];
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [
        creator({
          job_id: "s1",
          state: "stopped",
          backend_exec_pane_id: "%7",
          monitors: JSON.stringify([{ id: "bus", kind: "ambient" }]),
          dispatchClaim: exactClaim,
        }),
      ],
      live: new Set(["s1"]),
      livePanes: new Set(["%7"]),
      requestResume: () => true,
      awaitResumeAccepted: async () => true,
      launch: async (_session, _target, _cwd, _harness, attemptId) => {
        attempts.push(attemptId);
        return { ok: true };
      },
    }),
  );
  expect(res.outcome).toBe("launched");
  expect(attempts).toEqual([41]);
});

test("runWake: missed exact-attempt acknowledgement requests revocation and never authorizes replacement", async () => {
  const revoked: number[] = [];
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [
        creator({
          job_id: "s1",
          state: "stopped",
          dispatchClaim: exactClaim,
        }),
      ],
      requestResume: () => true,
      awaitResumeAccepted: async () => false,
      revokeAttempt: (claim) => {
        revoked.push(claim.attempt_id as number);
        return false;
      },
    }),
  );
  expect(res.outcome).toBe("acknowledgement_missed");
  expect(revoked).toEqual([41]);
});

test("runWake: in_flight when the per-session lock is held by another wake", async () => {
  let launched = false;
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [creator({ job_id: "s1" })],
      locked: new Set(["s1"]),
      launch: async () => {
        launched = true;
        return { ok: true };
      },
    }),
  );
  expect(res.outcome).toBe("in_flight");
  expect(launched).toBe(false);
});

test("runWake: cooldown skips when a recent failure is still inside the window", async () => {
  const cooldowns = new Map<string, WakeCooldownRecord>([
    ["s1", { failures: 2, last_failure_ms: 1_000_000 - 5_000 }],
  ]);
  let launched = false;
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [creator({ job_id: "s1" })],
      cooldowns,
      nowMs: 1_000_000,
      launch: async () => {
        launched = true;
        return { ok: true };
      },
    }),
  );
  expect(res.outcome).toBe("cooldown");
  expect(launched).toBe(false);
});

test("runWake: launched resumes into agentbus by the creator's session UUID, clears cooldown, no marker", async () => {
  const launchArgs: { session: string; target: string; cwd: string }[] = [];
  const cooldowns = new Map<string, WakeCooldownRecord>([
    ["s1", { failures: 1, last_failure_ms: 0 }],
  ]);
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [creator({ job_id: "s1", cwd: "/abs/repo", title: "planner" })],
      cooldowns,
      nowMs: WAKE_COOLDOWN_MS * 100, // far past any cooldown
      launch: async (session, target, cwd) => {
        launchArgs.push({ session, target, cwd });
        return { ok: true };
      },
    }),
  );
  expect(res.outcome).toBe("launched");
  expect(res.sessionId).toBe("s1");
  // Launched into the dedicated agentbus session, carrying the RESUME TARGET (the
  // creator's session UUID `job_id`, so `claude --resume <uuid>` re-attaches to
  // the EXACT session — a title never becomes the key) and cwd, NOT a pre-wrapped
  // argv. keeperAgentLaunch builds the `--resume <target>` invocation and owns the
  // window.
  expect(launchArgs).toEqual([
    { session: "agentbus", target: "s1", cwd: "/abs/repo" },
  ]);
  // Cooldown cleared on success.
  expect(cooldowns.has("s1")).toBe(false);
});

test("runWake: threads the creator's harness to the launch — claude by default, per-harness target otherwise", async () => {
  const claudeCalls: { target: string; harness: string }[] = [];
  await runWake(
    "fn-x",
    makeDeps({
      jobs: [creator({ job_id: "s1", cwd: "/abs/repo" })],
      nowMs: WAKE_COOLDOWN_MS * 100,
      launch: async (_session, target, _cwd, harness) => {
        claudeCalls.push({ target, harness });
        return { ok: true };
      },
    }),
  );
  // A default creator carries no harness ⇒ claude, resuming by its session UUID.
  expect(claudeCalls).toEqual([{ target: "s1", harness: "claude" }]);

  const piCalls: { target: string; harness: string }[] = [];
  await runWake(
    "fn-x",
    makeDeps({
      jobs: [
        creator({
          job_id: "keeper-job",
          cwd: "/abs/repo",
          harness: "pi",
          resume_target: "pi-rollout-id",
        }),
      ],
      nowMs: WAKE_COOLDOWN_MS * 100,
      launch: async (_session, target, _cwd, harness) => {
        piCalls.push({ target, harness });
        return { ok: true };
      },
    }),
  );
  // A pi creator resumes via its own harness + stored native target.
  expect(piCalls).toEqual([{ target: "pi-rollout-id", harness: "pi" }]);
});

test("runWake: an unregistered creator harness fails before launch", async () => {
  let launched = false;
  const notes: string[] = [];
  const cooldowns = new Map<string, WakeCooldownRecord>();
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [
        creator({
          job_id: "retired",
          harness: "codex",
          resume_target: "legacy-target",
        }),
      ],
      cooldowns,
      noteLine: (line) => notes.push(line),
      launch: async () => {
        launched = true;
        return { ok: true };
      },
    }),
  );
  expect(res.outcome).toBe("launch_failed");
  expect(res.detail).toContain("unknown harness 'codex'");
  expect(launched).toBe(false);
  expect(cooldowns.get("retired")?.failures).toBe(1);
  expect(notes.join("\n")).toContain("unknown harness 'codex'");
});

test("runWake: resume target is the creator's session UUID (job_id) even with no name", async () => {
  const launchArgs: { session: string; target: string; cwd: string }[] = [];
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [creator({ job_id: "s1", title: null, cwd: "/abs/repo" })],
      nowMs: WAKE_COOLDOWN_MS * 100,
      launch: async (session, target, cwd) => {
        launchArgs.push({ session, target, cwd });
        return { ok: true };
      },
    }),
  );
  expect(res.outcome).toBe("launched");
  expect(launchArgs).toEqual([
    { session: "agentbus", target: "s1", cwd: "/abs/repo" },
  ]);
});

test("runWake: launch_failed is fail-open and bumps the cooldown record", async () => {
  const cooldowns = new Map<string, WakeCooldownRecord>();
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [creator({ job_id: "s1" })],
      cooldowns,
      nowMs: 555,
      launch: async () => ({ ok: false, error: "tmux gone" }),
    }),
  );
  expect(res.outcome).toBe("launch_failed");
  // Cooldown bumped to 1 failure at now.
  expect(cooldowns.get("s1")).toEqual({ failures: 1, last_failure_ms: 555 });
});

test("runWake: a second launch_failure increments the failure count", async () => {
  const cooldowns = new Map<string, WakeCooldownRecord>([
    ["s1", { failures: 1, last_failure_ms: 0 }],
  ]);
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [creator({ job_id: "s1" })],
      cooldowns,
      nowMs: WAKE_COOLDOWN_MS * 10, // past the prior cooldown so we reach launch
      launch: async () => ({ ok: false, error: "boom" }),
    }),
  );
  expect(res.outcome).toBe("launch_failed");
  expect(cooldowns.get("s1")?.failures).toBe(2);
});

test("runWake: the single-flight lock is always released", async () => {
  let released = false;
  await runWake(
    "fn-x",
    makeDeps({
      jobs: [creator({ job_id: "s1" })],
      tryLock: () => ({
        release: () => {
          released = true;
        },
      }),
    }),
  );
  expect(released).toBe(true);
});
