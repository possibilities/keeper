/**
 * Fast-tier unit tests for `src/bus-wake.ts` — the `keeper bus wake planner@<epic>`
 * client-side resume pipeline (epic fn-918 task .2). Drives the PURE decision
 * functions and the `runWake` orchestration with fully injected deps (no real
 * tmux/daemon/process/fs):
 *  - `creatorIsLive` / `isRunningState` — the spawn-time liveness recheck.
 *  - `inCooldown` — the failed-wake circuit-breaker window.
 *  - `buildWakeResumeArgv` — the alias-independent, quoting-safe positional
 *    resume LAUNCH argv (absolute launcher prefix + `claude --resume` as `"$@"`).
 *  - `pickCreatorJob` — the newest-creator pick over >1 edges.
 *  - `runWake` — resolve → liveness-skip → single-flight-skip → cooldown-skip →
 *    launch (+ the managed-window marker argv) → launch_failed bumps cooldown.
 */

import { expect, test } from "bun:test";
import {
  buildWakeResumeArgv,
  creatorIsLive,
  inCooldown,
  isRunningState,
  isStoppedPaneLive,
  MANAGED_WINDOW_OPTION,
  MANAGED_WINDOW_VALUE,
  pickCreatorJob,
  runWake,
  WAKE_COOLDOWN_MS,
  type WakeCooldownRecord,
  type WakeCreator,
  type WakeDeps,
} from "../src/bus-wake";
import type { LaunchResult, SpawnFn } from "../src/exec-backend";

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

/** A `SpawnFn` stub recording every spawn; resolves exit 0 with empty streams. */
function recordingSpawn(calls: string[][]): SpawnFn {
  return (cmd, _options) => {
    calls.push([...cmd]);
    return {
      exited: Promise.resolve(0),
      stdout: null,
      stderr: null,
      kill: () => {},
    };
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
    spawnCalls?: string[][];
  } = {},
): WakeDeps {
  const cooldowns =
    overrides.cooldowns ?? new Map<string, WakeCooldownRecord>();
  const locked = overrides.locked ?? new Set<string>();
  const spawnCalls = overrides.spawnCalls ?? [];
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
    spawn: overrides.spawn ?? recordingSpawn(spawnCalls),
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
// buildWakeResumeArgv — alias-independent, quoting-safe positional LAUNCH form
// ---------------------------------------------------------------------------

const WAKE_PREFIX = ["/abs/bun", "/abs/cli/keeper.ts", "agent"] as const;

test("buildWakeResumeArgv: bash -l -i -c fixed body + absolute launcher prefix as positionals", () => {
  const argv = buildWakeResumeArgv([...WAKE_PREFIX], "planner-title");
  // Login+interactive bash wrapper.
  expect(argv.slice(0, 4)).toEqual(["bash", "-l", "-i", "-c"]);
  // The `-c` body is the FIXED literal — no caller data interpolated, and the
  // claude part is NOT exec'd (the trailing `exec "$0"` is the hold-open shell).
  expect(argv[4]).toBe(`"$@" ; exec "$0" -l -i`);
  // `$0` slot is bash (repeated) so the first prefix token is $1, not eaten.
  expect(argv[5]).toBe("bash");
  // The resume tokens ride as positionals: absolute prefix, then the alias-free
  // `claude --resume <target> --agentwrap-no-confirm`. No `claude` alias, no cd.
  expect(argv.slice(6)).toEqual([
    "/abs/bun",
    "/abs/cli/keeper.ts",
    "agent",
    "claude",
    "--resume",
    "planner-title",
    "--agentwrap-no-confirm",
  ]);
  // No --agentwrap-tmux (the launch already runs inside a tmux window), no cd.
  expect(argv).not.toContain("--agentwrap-tmux");
  expect(argv.join(" ")).not.toContain("cd ");
});

test("buildWakeResumeArgv: a session name with shell metacharacters rides byte-faithful as a positional", () => {
  const nasty = [
    "single ' quote",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${...}` is the adversarial byte content under test
    "$VAR and ${BRACED}",
    "back`tick`s",
    "$(rm -rf /)",
    "line one\nline two",
    "semis ; and && pipes |",
    "-leading-dash",
  ].join(" :: ");
  const argv = buildWakeResumeArgv([...WAKE_PREFIX], nasty);
  // The target rides as the `--resume` value positional — byte-identical, no
  // quoting/escaping/interpolation — and the `-c` body never references it.
  const resumeIdx = argv.indexOf("--resume");
  expect(argv[resumeIdx + 1]).toBe(nasty);
  expect(argv[4]).toBe(`"$@" ; exec "$0" -l -i`);
  expect(argv[4]).not.toContain(nasty);
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
  const spawnCalls: string[][] = [];
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
      spawnCalls,
    }),
  );
  expect(res.outcome).toBe("already_live");
  expect(launched).toBe(false);
  expect(spawnCalls).toHaveLength(0);
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

test("runWake: launched resumes into agentbus, clears cooldown, stamps the marker", async () => {
  const spawnCalls: string[][] = [];
  const launchArgs: { session: string; argv: string[]; cwd: string }[] = [];
  const cooldowns = new Map<string, WakeCooldownRecord>([
    ["s1", { failures: 1, last_failure_ms: 0 }],
  ]);
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [creator({ job_id: "s1", cwd: "/abs/repo", title: "planner" })],
      cooldowns,
      nowMs: WAKE_COOLDOWN_MS * 100, // far past any cooldown
      spawnCalls,
      launch: async (session, argv, cwd) => {
        launchArgs.push({ session, argv, cwd });
        return { ok: true };
      },
    }),
  );
  expect(res.outcome).toBe("launched");
  expect(res.sessionId).toBe("s1");
  // Launched into the dedicated agentbus session with the wrapped resume argv,
  // threading the injected launcher prefix as positionals (alias-independent).
  expect(launchArgs).toHaveLength(1);
  expect(launchArgs[0].session).toBe("agentbus");
  expect(launchArgs[0].cwd).toBe("/abs/repo");
  expect(launchArgs[0].argv[0]).toBe("bash");
  expect(launchArgs[0].argv[4]).toBe(`"$@" ; exec "$0" -l -i`);
  expect(launchArgs[0].argv).toContain("/abs/cli/keeper.ts");
  expect(launchArgs[0].argv.slice(-4)).toEqual([
    "claude",
    "--resume",
    "planner",
    "--agentwrap-no-confirm",
  ]);
  // Cooldown cleared on success.
  expect(cooldowns.has("s1")).toBe(false);
  // The managed-window marker is stamped on the agentbus window.
  const marker = spawnCalls.find(
    (c) => c[0] === "tmux" && c[1] === "set-option",
  );
  expect(marker).toBeDefined();
  expect(marker).toEqual([
    "tmux",
    "set-option",
    "-w",
    "-t",
    "=agentbus:",
    MANAGED_WINDOW_OPTION,
    MANAGED_WINDOW_VALUE,
  ]);
});

test("runWake: launch_failed is fail-open and bumps the cooldown record", async () => {
  const cooldowns = new Map<string, WakeCooldownRecord>();
  const spawnCalls: string[][] = [];
  const res = await runWake(
    "fn-x",
    makeDeps({
      jobs: [creator({ job_id: "s1" })],
      cooldowns,
      nowMs: 555,
      spawnCalls,
      launch: async () => ({ ok: false, error: "tmux gone" }),
    }),
  );
  expect(res.outcome).toBe("launch_failed");
  // Cooldown bumped to 1 failure at now; no marker stamped on a failed launch.
  expect(cooldowns.get("s1")).toEqual({ failures: 1, last_failure_ms: 555 });
  expect(spawnCalls.some((c) => c[1] === "set-option")).toBe(false);
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
