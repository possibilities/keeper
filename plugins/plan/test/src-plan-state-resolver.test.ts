// Unit tests for src/project.ts resolvePlanStateContext — the ONE seam every
// runtime-overlay / close-audit writer routes its STATE through. The contract:
// LOCATE the owning def cwd-then-global (or --project), then root the returned
// context at the committed `epic.primary_repo` FIELD (not where the defs sit, not
// roots-discovery) so a worktree LANE never wins state ownership. A null field
// degrades to the locate root; a primary missing its data dir / the id's def
// FAILS LOUD rather than writing lane-adjacent state.
//
// The lane is simulated git-free: a "primary" dir carrying the full .keeper/ tree
// and a "lane" dir carrying ONLY the committed defs (state/ stripped) whose epic
// def's primary_repo points back at primary — exactly a worktree checkout. The
// resolver reads process.cwd() + HOME (roots config), so each call runs under a
// controlled cwd/HOME that is restored after; a fail-loud emitError (process.exit)
// is captured as a thrown marker rather than killing the runner.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectContext } from "../src/project.ts";
import { resolvePlanStateContext } from "../src/project.ts";
import { seedState, setRoots } from "./harness.ts";

const created: string[] = [];

afterEach(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
  created.length = 0;
});

function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** Carrier the patched process.exit throws so a fail-loud emitError unwinds to
 * the caller as an observable value rather than terminating the test process. */
class Exited {
  constructor(readonly code: number) {}
}

/** Run `fn` under a controlled cwd + HOME (+ optional env overrides), silencing
 * the emitError write and capturing its process.exit as an Exited marker. Every
 * global is restored in `finally`. */
function underCwd<T>(
  cwd: string,
  home: string,
  fn: () => T,
  env: Record<string, string> = {},
): T | Exited {
  const priorCwd = process.cwd();
  const priorHome = process.env.HOME;
  const priorExit = process.exit;
  const priorOut = process.stdout.write;
  const priorErr = process.stderr.write;
  const priorEnv: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    priorEnv[k] = process.env[k];
  }

  process.env.HOME = home;
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }
  process.chdir(cwd);
  process.exit = ((code?: number): never => {
    throw new Exited(code ?? 0);
  }) as typeof process.exit;
  const swallow = (() => true) as typeof process.stdout.write;
  process.stdout.write = swallow;
  process.stderr.write = swallow;

  try {
    return fn();
  } catch (exc) {
    if (exc instanceof Exited) {
      return exc;
    }
    throw exc;
  } finally {
    process.chdir(priorCwd);
    if (priorHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = priorHome;
    }
    for (const [k, v] of Object.entries(priorEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    process.exit = priorExit;
    process.stdout.write = priorOut;
    process.stderr.write = priorErr;
  }
}

interface Scenario {
  root: string;
  primary: string;
  lane: string;
  home: string;
  epicId: string;
  taskId: string;
}

/** Stand up a primary (child of a configured root) carrying the full .keeper/
 * tree + a lane OUTSIDE any root holding ONLY the committed defs (state/
 * stripped), whose epic def's primary_repo points at primary. `primaryRepoField`
 * overrides what primary_repo the lane's committed def carries (for the
 * fail-loud / stale-field cases). */
function makeScenario(prefix: string, primaryRepoField?: string): Scenario {
  const root = freshDir(`${prefix}root-`);
  const home = freshDir(`${prefix}home-`);
  const lane = freshDir(`${prefix}lane-`);
  const primary = join(root, "primary");
  mkdirSync(primary, { recursive: true });
  const epicId = "fn-1-demo";

  const [, taskIds] = seedState(primary, {
    epicId,
    nTasks: 1,
    primaryRepo: primary,
  });
  const taskId = taskIds[0] as string;

  // The lane carries the committed defs (state/ stripped) — exactly a worktree
  // checkout. Its epic def's primary_repo points at primary by default.
  seedState(lane, {
    epicId,
    nTasks: 1,
    primaryRepo: primaryRepoField ?? primary,
  });
  rmSync(join(lane, ".keeper", "state"), { recursive: true, force: true });

  setRoots(home, [root]);
  return { root, primary, lane, home, epicId, taskId };
}

function asCtx(r: ProjectContext | Exited): ProjectContext {
  if (r instanceof Exited) {
    throw new Error(`expected a context, got fail-loud exit ${r.code}`);
  }
  return r;
}

describe("resolvePlanStateContext roots state at primary_repo", () => {
  test("from a lane (task id) -> ctx rooted at PRIMARY, never the lane", () => {
    const s = makeScenario("planctl-psr-lane-task-");
    const ctx = asCtx(
      underCwd(s.lane, s.home, () =>
        resolvePlanStateContext(s.taskId, null, null),
      ),
    );
    expect(ctx.projectPath).toBe(s.primary);
    expect(ctx.stateDir).toBe(join(s.primary, ".keeper", "state"));
  });

  test("from a lane (epic id) -> ctx rooted at PRIMARY", () => {
    const s = makeScenario("planctl-psr-lane-epic-");
    const ctx = asCtx(
      underCwd(s.lane, s.home, () =>
        resolvePlanStateContext(s.epicId, null, null),
      ),
    );
    expect(ctx.projectPath).toBe(s.primary);
  });

  test("from primary cwd -> no-op (resolves to primary)", () => {
    const s = makeScenario("planctl-psr-primary-");
    const ctx = asCtx(
      underCwd(s.primary, s.home, () =>
        resolvePlanStateContext(s.taskId, null, null),
      ),
    );
    expect(ctx.projectPath).toBe(s.primary);
  });

  test("--project stays authoritative for locating (returned outright)", () => {
    // The lane's committed def points primary_repo at primary, but an explicit
    // --project=lane is operator intent and wins: state resolves to the lane.
    const s = makeScenario("planctl-psr-proj-");
    const ctx = asCtx(
      underCwd(s.primary, s.home, () =>
        resolvePlanStateContext(s.taskId, s.lane, null),
      ),
    );
    expect(ctx.projectPath).toBe(s.lane);
  });

  test("primary OUTSIDE configured roots still resolves to primary (Q7 gap)", () => {
    // setRoots points at an unrelated dir, so neither lane nor primary is a root
    // child. Discovery-based resolution (done's findProjectsWithTask) would miss
    // primary; keying on the committed FIELD lands it regardless.
    const s = makeScenario("planctl-psr-q7-");
    const unrelated = freshDir("planctl-psr-q7-elsewhere-");
    setRoots(s.home, [unrelated]);
    const ctx = asCtx(
      underCwd(s.lane, s.home, () =>
        resolvePlanStateContext(s.taskId, null, null),
      ),
    );
    expect(ctx.projectPath).toBe(s.primary);
  });

  test("KEEPER_PLAN_WORKTREE moves only targetRepo, never STATE", () => {
    // The worktree PATH lever is producer-only for a worker's targetRepo; the
    // state resolver must ignore it and still root at primary.
    const s = makeScenario("planctl-psr-wt-");
    const ctx = asCtx(
      underCwd(
        s.primary,
        s.home,
        () => resolvePlanStateContext(s.taskId, null, null),
        { KEEPER_PLAN_WORKTREE: s.lane },
      ),
    );
    expect(ctx.projectPath).toBe(s.primary);
  });
});

describe("resolvePlanStateContext fails loud, never a lane write", () => {
  test("primary_repo missing its data dir -> emitError (exit), no lane write", () => {
    const badPrimary = freshDir("planctl-psr-nodd-bad-");
    const s = makeScenario("planctl-psr-nodd-", badPrimary);
    const r = underCwd(s.lane, s.home, () =>
      resolvePlanStateContext(s.taskId, null, null),
    );
    expect(r).toBeInstanceOf(Exited);
    expect((r as Exited).code).toBe(1);
  });

  test("primary lacks the id's def (stale primary_repo) -> emitError (exit)", () => {
    // primary_repo points at a real project that carries a DIFFERENT epic, so the
    // lane's id has no def there — the stale-field backstop fires.
    const otherPrimary = freshDir("planctl-psr-stale-other-");
    seedState(otherPrimary, {
      epicId: "fn-2-other",
      nTasks: 1,
      primaryRepo: otherPrimary,
    });
    const s = makeScenario("planctl-psr-stale-", otherPrimary);
    const r = underCwd(s.lane, s.home, () =>
      resolvePlanStateContext(s.taskId, null, null),
    );
    expect(r).toBeInstanceOf(Exited);
    expect((r as Exited).code).toBe(1);
  });
});
