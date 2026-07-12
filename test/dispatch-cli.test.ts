/**
 * Integration tests of `cli/dispatch.ts main()` orchestration for the `--preset`
 * model/effort resolution path (fn-937 task 3). The pure builders live in
 * `src/dispatch-command.ts` (unit-tested in `test/dispatch-command.test.ts`); this
 * file covers the thin entry's PRECEDENCE — explicit --model/--effort > --preset >
 * the verb's `dispatch:` row (plan form only) > floor — by capturing the
 * `LaunchSpec` the injected `launch` seam receives, never a real tmux/daemon.
 *
 * The preset catalog dir is sandboxed via KEEPER_CONFIG_DIR (os.homedir()
 * ignores $HOME on macOS). `main()` calls process.exit() directly on failures, so
 * we patch it (throwing a tagged ExitError) around the call.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as dispatchMain, type MainDeps } from "../cli/dispatch";
import type { LaunchResult, LaunchSpec } from "../src/exec-backend";
import type { Row } from "../src/protocol";

class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

let dir: string;
const TOUCHED = ["KEEPER_CONFIG_DIR"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dispatch-cli-"));
  saved = {};
  for (const k of TOUCHED) saved[k] = process.env[k];
  process.env.KEEPER_CONFIG_DIR = dir;
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

function writePresets(body: string): void {
  writeFileSync(join(dir, "presets.yaml"), body);
}

/** Write a v2 host matrix into the sandboxed config dir so the CLI's fresh
 *  `composeWorkerCellDir` → `loadMatrixV2` resolves a cell — fixture-injected,
 *  never the host `~/.config/keeper/matrix.yaml`. */
function writeMatrix(body: string): void {
  writeFileSync(join(dir, "matrix.yaml"), body);
}

/** A minimal valid v2 host matrix (ADR 0036): claude-native opus/sonnet across
 *  the full effort axis, both worker cells. */
const CLAUDE_MATRIX = [
  "efforts: [low, medium, high, xhigh, max]",
  "subagent_templates: [template/agents/worker.md.tmpl]",
  "subagent_models: [opus, sonnet]",
  "providers:",
  "  - name: claude",
  "    models: [opus, sonnet]",
  "wrapper_driver: { model: sonnet, effort: high }",
  "defaults: { stop_timeout_ms: 3600000, max_attempts: 2 }",
  "",
].join("\n");

/** A v2 roster: claude native (opus/sonnet) + a wrapped `gpt-5.5` served by codex,
 *  all three listed in subagent_models (so gpt-5.5 composes its own cell). */
const WRAPPED_MATRIX = [
  "efforts: [high]",
  "subagent_templates: [template/agents/worker.md.tmpl]",
  "subagent_models: [opus, sonnet, gpt-5.5]",
  "providers:",
  "  - name: claude",
  "    models: [opus, sonnet]",
  "  - name: codex",
  "    models: [gpt-5.5]",
  "wrapper_driver: { model: sonnet, effort: high }",
  "defaults: { stop_timeout_ms: 3600000, max_attempts: 2 }",
  "",
].join("\n");

interface CapturedLaunch {
  spec: LaunchSpec | undefined;
  /** The shell-wrapped launch argv the seam received (mirrors the dry-run line). */
  launchArgv: string[] | undefined;
  code: number | undefined;
  stderr: string;
  stdout: string;
}

/** Drive dispatchMain capturing the LaunchSpec + argv the launch seam receives. */
async function runDispatch(
  argv: string[],
  extraDeps: Partial<MainDeps> = {},
): Promise<CapturedLaunch> {
  let spec: LaunchSpec | undefined;
  let launchArgv: string[] | undefined;
  const err: string[] = [];
  const out: string[] = [];
  const realErr = process.stderr.write.bind(process.stderr);
  const realOut = process.stdout.write.bind(process.stdout);
  const realExit = process.exit.bind(process);
  let code: number | undefined;
  process.stderr.write = ((s: string | Uint8Array) => {
    err.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((s: string | Uint8Array) => {
    out.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new ExitError(code);
  }) as typeof process.exit;
  const deps: MainDeps = {
    launch: async (_session, a, _cwd, _name, s): Promise<LaunchResult> => {
      spec = s;
      launchArgv = a;
      return { ok: true } as LaunchResult;
    },
    ...extraDeps,
  };
  try {
    await dispatchMain(argv, deps);
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
  } finally {
    process.stderr.write = realErr;
    process.stdout.write = realOut;
    process.exit = realExit;
  }
  return { spec, launchArgv, code, stderr: err.join(""), stdout: out.join("") };
}

/** Route a `query` stub by collection so a plan-form run drives the epics walk,
 *  the race guard (pending_dispatches / autopilot_state / jobs), AND the
 *  worktree-mode read off one canned board. Any collection defaults to `[]`. */
function makeQuery(rows: {
  epics?: Row[];
  autopilotState?: Row[];
  pending?: Row[];
  jobs?: Row[];
  throwOn?: string;
}): MainDeps["query"] {
  return async (collection: string): Promise<Row[]> => {
    if (collection === rows.throwOn) {
      throw new Error(`daemon unreachable (${collection})`);
    }
    switch (collection) {
      case "epics":
        return rows.epics ?? [];
      case "autopilot_state":
        return rows.autopilotState ?? [{ id: 1, paused: 1 } as unknown as Row];
      case "pending_dispatches":
        return rows.pending ?? [];
      case "jobs":
        return rows.jobs ?? [];
      default:
        return [];
    }
  };
}

/** One epics row whose sole task carries the given cell axes. */
function epicWith(
  taskDir: string,
  cell: { model?: string | null; tier?: string | null } = {},
): Row[] {
  return [
    {
      epic_id: "fn-1-x",
      project_dir: taskDir,
      tasks: [{ task_id: "fn-1-x.1", target_repo: taskDir, ...cell }],
    } as unknown as Row,
  ];
}

// ---------------------------------------------------------------------------
// Help text documents every dispatchable plan-form verb (the parser accepts
// work/close/unblock/deconflict — the help must not under-claim work|close).
// ---------------------------------------------------------------------------

test("--help documents all four plan-form verbs with their id shapes + scope", async () => {
  const r = await runDispatch(["--help"]);
  expect(r.code).toBe(0);
  for (const key of [
    "work::fn-N.M",
    "unblock::fn-N.M",
    "close::fn-N",
    "deconflict::fn-N",
  ]) {
    expect(r.stdout).toContain(key);
  }
  // Scope is named, not just the verbs — a task-id shape vs an epic-id shape.
  expect(r.stdout).toContain("task-scoped");
  expect(r.stdout).toContain("epic-scoped");
});

test("--agent-help names all four plan-form verbs and their scope", async () => {
  const r = await runDispatch(["--agent-help"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("work|close|unblock|deconflict");
  expect(r.stdout).toContain("task-scoped");
  expect(r.stdout).toContain("epic-scoped");
});

test("free-form --preset triple supplies the spec model/effort", async () => {
  const r = await runDispatch([
    "--prompt",
    "do a thing",
    "--preset",
    "claude::haiku::low",
  ]);
  expect(r.spec?.model).toBe("haiku");
  expect(r.spec?.effort).toBe("low");
});

test("explicit --model/--effort override the preset triple (per field)", async () => {
  const r = await runDispatch([
    "--prompt",
    "do a thing",
    "--preset",
    "claude::haiku::low",
    "--model",
    "opus",
  ]);
  // --model wins; the triple's effort still applies.
  expect(r.spec?.model).toBe("opus");
  expect(r.spec?.effort).toBe("low");
});

test("free-form without preset passes no model/effort (zero behavior change)", async () => {
  const r = await runDispatch(["--prompt", "do a thing"]);
  expect(r.spec?.model).toBeUndefined();
  expect(r.spec?.effort).toBeUndefined();
});

test("plan form defaults to the dispatch.work row model/effort", async () => {
  writePresets("dispatch:\n  work: claude::opus::high\n");
  const epicRows: Row[] = [
    {
      epic_id: "fn-1-x",
      project_dir: dir,
      tasks: [{ task_id: "fn-1-x.1", target_repo: dir }],
    } as unknown as Row,
  ];
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: async () => epicRows,
    dirExists: () => true,
  });
  expect(r.code).toBeUndefined();
  expect(r.spec?.model).toBe("opus");
  expect(r.spec?.effort).toBe("high");
});

test("plan form with no dispatch.work row falls back to sonnet/max", async () => {
  // No catalog file → the resolver floors to the WORKER_* constants (sonnet/max).
  const epicRows: Row[] = [
    {
      epic_id: "fn-1-x",
      project_dir: dir,
      tasks: [{ task_id: "fn-1-x.1", target_repo: dir }],
    } as unknown as Row,
  ];
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: async () => epicRows,
    dirExists: () => true,
  });
  expect(r.spec?.model).toBe("sonnet");
  expect(r.spec?.effort).toBe("max");
});

test("plan form unblock:: defaults to the escalation floor (sonnet/high), boots /plan:unblock", async () => {
  // No presets.yaml → the resolver floors unblock to the ESCALATION_* constants
  // (sonnet/high). unblock is task-scoped, so it resolves the blocked task's repo.
  const epicRows: Row[] = [
    {
      epic_id: "fn-1-x",
      project_dir: dir,
      tasks: [{ task_id: "fn-1-x.1", target_repo: dir }],
    } as unknown as Row,
  ];
  const r = await runDispatch(["unblock::fn-1-x.1", "--force"], {
    query: async () => epicRows,
    dirExists: () => true,
  });
  expect(r.code).toBeUndefined();
  expect(r.spec?.model).toBe("sonnet");
  expect(r.spec?.effort).toBe("high");
  expect(r.spec?.prompt).toBe("/plan:unblock fn-1-x.1");
  expect(r.spec?.claudeName).toBe("unblock::fn-1-x.1");
  // Escalation dispatches are never cell-based — no --plugin-dir.
  expect(r.spec?.pluginDir).toBeUndefined();
});

test("plan form escalation verb resolves its own dispatch row, independent of work", async () => {
  // Both rows present → an escalation verb resolves its OWN dispatch row
  // (dispatch.unblock), NEVER the dispatch.work one.
  writePresets(
    "dispatch:\n  work: claude::opus::low\n  unblock: claude::haiku::max\n",
  );
  const epicRows: Row[] = [
    {
      epic_id: "fn-1-x",
      project_dir: dir,
      tasks: [{ task_id: "fn-1-x.1", target_repo: dir }],
    } as unknown as Row,
  ];
  const r = await runDispatch(["unblock::fn-1-x.1", "--force"], {
    query: async () => epicRows,
    dirExists: () => true,
  });
  expect(r.spec?.model).toBe("haiku");
  expect(r.spec?.effort).toBe("max");
});

test("plan form deconflict:: is epic-scoped — runs in the epic dir, boots /plan:deconflict", async () => {
  const epicRows: Row[] = [
    { epic_id: "fn-1-x", project_dir: dir, tasks: [] } as unknown as Row,
  ];
  const r = await runDispatch(["deconflict::fn-1-x", "--force"], {
    query: async () => epicRows,
    dirExists: () => true,
    // No lane worktree → falls back to project_dir (a note on stderr), never a
    // real git probe.
    resolveLaneDir: async () => null,
  });
  expect(r.code).toBeUndefined();
  expect(r.spec?.prompt).toBe("/plan:deconflict fn-1-x");
  expect(r.spec?.claudeName).toBe("deconflict::fn-1-x");
});

test("plan form unblock:: honors the race guard (parity with work/close)", async () => {
  const r = await runDispatch(["unblock::fn-1-x.1"], {
    query: makeQuery({
      epics: epicWith(dir),
      pending: [{ verb: "unblock", id: "fn-1-x.1" } as unknown as Row],
    }),
    dirExists: () => true,
  });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("already in flight");
  expect(r.spec).toBeUndefined();
});

test("a codex --preset triple handed to dispatch fails loud (claude-only, exit 2)", async () => {
  const r = await runDispatch([
    "--prompt",
    "x",
    "--preset",
    "codex::gpt::high",
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("claude-only");
});

test("a malformed --preset triple fails loud (exit 2)", async () => {
  const r = await runDispatch(["--prompt", "x", "--preset", "nope"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("three");
});

// ---------------------------------------------------------------------------
// Worker-cell resolution — a manual work:: dispatch threads the task's cell
// ---------------------------------------------------------------------------

test("plan work: an in-matrix cell threads --plugin-dir into the spec AND the argv", async () => {
  writeMatrix(CLAUDE_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({ epics: epicWith(dir, { model: "opus", tier: "max" }) }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
  });
  expect(r.code).toBeUndefined(); // launched
  expect(r.spec?.pluginDir).toContain("plugins/plan/workers/opus-max");
  // The shell-wrapped argv mirrors it — `--plugin-dir` right after `--name`.
  const argv = r.launchArgv ?? [];
  const nameIdx = argv.indexOf("--name");
  expect(nameIdx).toBeGreaterThanOrEqual(0);
  expect(argv[nameIdx + 1]).toBe("work::fn-1-x.1");
  expect(argv[nameIdx + 2]).toBe("--plugin-dir");
  expect(argv[nameIdx + 3]).toContain("plugins/plan/workers/opus-max");
});

test("plan work: a cell-less task (no model/tier) launches with NO --plugin-dir", async () => {
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({ epics: epicWith(dir) }),
    dirExists: () => true,
  });
  expect(r.code).toBeUndefined();
  expect(r.spec?.pluginDir).toBeUndefined();
  expect(r.launchArgv ?? []).not.toContain("--plugin-dir");
});

test("plan work: an out-of-matrix cell refuses (exit 1, actionable), launches nothing", async () => {
  writeMatrix(CLAUDE_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "ludicrous" }),
    }),
    dirExists: () => true,
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined(); // never launched
  expect(r.stderr).toContain("no valid");
  expect(r.stderr).toContain("model/tier");
});

test("plan work: a WRAPPED cell in subagent_models threads the resolved --plugin-dir into the spec AND the argv", async () => {
  // CLI parity with the autopilot producer: in v2 a wrapped capability model listed
  // in subagent_models composes its `workers/<model>-<effort>` cell directly (no
  // route probe) and launches with it — in the structured spec AND the byte-pinned argv.
  writeMatrix(WRAPPED_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "gpt-5.5", tier: "high" }),
    }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
  });
  expect(r.code).toBeUndefined(); // launched
  expect(r.spec?.pluginDir).toContain("plugins/plan/workers/gpt-5.5-high");
  const argv = r.launchArgv ?? [];
  const nameIdx = argv.indexOf("--name");
  expect(nameIdx).toBeGreaterThanOrEqual(0);
  expect(argv[nameIdx + 1]).toBe("work::fn-1-x.1");
  expect(argv[nameIdx + 2]).toBe("--plugin-dir");
  expect(argv[nameIdx + 3]).toContain("plugins/plan/workers/gpt-5.5-high");
});

test("plan work: with NO host matrix present, a work dispatch refuses (exit 1) with worker-cell-bad-matrix", async () => {
  // v2 (ADR 0036): the host matrix is REQUIRED. A manual dispatch loads it FRESH and,
  // finding none, refuses with the four-state bad-matrix reject NAMING the absent
  // state (matching the producer's parked-dispatch sticky) — never a silent launch.
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "high" }),
    }),
    dirExists: () => true,
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined(); // never launched
  expect(r.stderr).toContain("worker-cell-bad-matrix");
  expect(r.stderr).toContain("absent");
});

test("plan work: a missing cell manifest refuses (exit 1) with the regenerate remedy", async () => {
  writeMatrix(CLAUDE_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({ epics: epicWith(dir, { model: "opus", tier: "max" }) }),
    // cwd exists; the cell's `.claude-plugin/…` manifest does not.
    dirExists: (p) => !p.includes(".claude-plugin"),
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined();
  expect(r.stderr).toContain("manifest is");
  expect(r.stderr).toContain("render-plugin-templates");
});

test("plan work: a shadowing work plugin refuses (exit 1) naming the offending manifest", async () => {
  writeMatrix(CLAUDE_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({ epics: epicWith(dir, { model: "opus", tier: "max" }) }),
    dirExists: () => true,
    probeShadowingWorkManifest: () =>
      "/scan/arthack-work/.claude-plugin/plugin.json",
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined();
  expect(r.stderr).toContain("work:worker");
  expect(r.stderr).toContain("/scan/arthack-work/.claude-plugin/plugin.json");
});

// ---------------------------------------------------------------------------
// worker_provider pin translation (ADR 0047) — the manual dispatch applies the
// SAME `applyProviderConstraint` seam the autopilot producer does.
// ---------------------------------------------------------------------------

/** A v2 roster: claude native (opus/sonnet) + codex serving gpt-5.6-sol (the
 *  committed map's opus→codex target), all in subagent_models. */
const SOL_MATRIX = [
  "efforts: [low, medium, high, xhigh, max]",
  "subagent_templates: [template/agents/worker.md.tmpl]",
  "subagent_models: [opus, sonnet, gpt-5.6-sol]",
  "providers:",
  "  - name: claude",
  "    models: [opus, sonnet]",
  "  - name: codex",
  "    models: [gpt-5.6-sol]",
  "wrapper_driver: { model: sonnet, effort: high }",
  "defaults: { stop_timeout_ms: 3600000, max_attempts: 2 }",
  "",
].join("\n");

test("plan work: worker_provider=codex TRANSLATES an opus cell to its mapped codex cell + carries the dispatched-cell spec fields", async () => {
  writeMatrix(SOL_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "max" }),
      autopilotState: [
        { id: 1, paused: 1, worker_provider: "codex" } as unknown as Row,
      ],
    }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
  });
  expect(r.code).toBeUndefined(); // launched
  // The launched cell is the TRANSLATED codex cell, not the assigned opus cell.
  expect(r.spec?.pluginDir).toContain("plugins/plan/workers/gpt-5.6-sol-max");
  expect(r.spec?.dispatchedModel).toBe("gpt-5.6-sol");
  expect(r.spec?.dispatchedTier).toBe("max");
  expect(r.spec?.dispatchConstraint).toBe("codex");
});

test("plan work: worker_provider=codex with the mapped target OFF the host matrix refuses (fail-closed, exit 1)", async () => {
  // CLAUDE_MATRIX has no gpt-5.6-sol, so translating opus/max resolves a target
  // that is not a dispatchable cell — refuse, never fall back to opus.
  writeMatrix(CLAUDE_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "max" }),
      autopilotState: [
        { id: 1, paused: 1, worker_provider: "codex" } as unknown as Row,
      ],
    }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined(); // never launched — no fallback to opus
  expect(r.stderr).toContain("worker-provider-target-not-on-host");
  expect(r.stderr).toContain("opus/max");
});

test("plan work: a NULL worker_provider pin is byte-identical to today (assigned cell, no dispatched fields)", async () => {
  writeMatrix(SOL_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "max" }),
      autopilotState: [{ id: 1, paused: 1 } as unknown as Row],
    }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
  });
  expect(r.code).toBeUndefined();
  expect(r.spec?.pluginDir).toContain("plugins/plan/workers/opus-max");
  expect(r.spec?.dispatchedModel).toBeUndefined();
  expect(r.spec?.dispatchConstraint).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Worktree-mode refusal — a shared-checkout work:: launch is wrong-topology
// ---------------------------------------------------------------------------

test("plan work: worktree mode ON refuses without --force, naming both recoveries", async () => {
  const r = await runDispatch(["work::fn-1-x.1"], {
    query: makeQuery({
      epics: epicWith(dir),
      autopilotState: [
        { id: 1, paused: 1, worktree_mode: 1 } as unknown as Row,
      ],
    }),
    dirExists: () => true,
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined(); // never launched
  expect(r.stderr).toContain("worktree mode");
  expect(r.stderr).toContain("let autopilot dispatch"); // recovery 1
  expect(r.stderr).toContain("--force"); // recovery 2
});

test("plan work: --force deliberately overrides the worktree-mode refusal and launches", async () => {
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir),
      autopilotState: [
        { id: 1, paused: 1, worktree_mode: 1 } as unknown as Row,
      ],
    }),
    dirExists: () => true,
  });
  expect(r.code).toBeUndefined(); // launched despite worktree mode
  expect(r.spec).toBeDefined();
});

test("plan work: a daemon-unreachable worktree read FAILS OPEN (launches, no refusal)", async () => {
  const r = await runDispatch(["work::fn-1-x.1"], {
    query: makeQuery({ epics: epicWith(dir), throwOn: "autopilot_state" }),
    dirExists: () => true,
  });
  // The race guard AND the worktree read both fail open on the throw — a manual
  // dispatch is the recovery tool when the daemon is down, so it must not block.
  expect(r.code).toBeUndefined();
  expect(r.spec).toBeDefined();
});

test("plan close: worktree mode + a cell axis are BOTH ignored (no refusal, no --plugin-dir)", async () => {
  const r = await runDispatch(["close::fn-1-x", "--force"], {
    query: makeQuery({
      epics: [
        {
          epic_id: "fn-1-x",
          project_dir: dir,
          // A stray model/tier on a task must not leak onto a close launch.
          tasks: [
            {
              task_id: "fn-1-x.1",
              target_repo: dir,
              model: "opus",
              tier: "max",
            },
          ],
        } as unknown as Row,
      ],
      autopilotState: [
        { id: 1, paused: 1, worktree_mode: 1 } as unknown as Row,
      ],
    }),
    dirExists: () => true,
    resolveLaneDir: async () => null,
  });
  expect(r.code).toBeUndefined(); // launched
  expect(r.spec?.pluginDir).toBeUndefined();
  expect(r.launchArgv ?? []).not.toContain("--plugin-dir");
});

// ---------------------------------------------------------------------------
// --dry-run reflects the outcome a real run would hit (never a misleading argv)
// ---------------------------------------------------------------------------

test("plan work: --dry-run reflects the worktree-mode refusal (exit 1, no argv line)", async () => {
  const r = await runDispatch(["work::fn-1-x.1", "--dry-run"], {
    query: makeQuery({
      epics: epicWith(dir),
      autopilotState: [
        { id: 1, paused: 1, worktree_mode: 1 } as unknown as Row,
      ],
    }),
    dirExists: () => true,
  });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("worktree mode");
  expect(r.stdout).not.toContain("argv:"); // no misleading plan printed
});

test("plan work: --dry-run reflects a cell reject (exit 1) instead of printing argv", async () => {
  writeMatrix(CLAUDE_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--dry-run"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "ludicrous" }),
    }),
    dirExists: () => true,
  });
  expect(r.code).toBe(1);
  expect(r.stdout).not.toContain("argv:");
});

test("plan work: --dry-run on an in-matrix cell PRINTS the resolved --plugin-dir argv", async () => {
  writeMatrix(CLAUDE_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force", "--dry-run"], {
    query: makeQuery({ epics: epicWith(dir, { model: "opus", tier: "max" }) }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("--plugin-dir");
  expect(r.stdout).toContain("plugins/plan/workers/opus-max");
});
