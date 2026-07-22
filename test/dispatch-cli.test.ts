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
import { buildProviderEquivalenceMap } from "../src/provider-equivalence";

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

/** A v2 roster: Claude-native opus/sonnet plus wrapped `gpt-5.5` served by Pi,
 *  all three listed in subagent_models (so gpt-5.5 composes its own cell). */
const WRAPPED_MATRIX = [
  "efforts: [high]",
  "subagent_templates: [template/agents/worker.md.tmpl]",
  "subagent_models: [opus, sonnet, gpt-5.5]",
  "providers:",
  "  - name: claude",
  "    models: [opus, sonnet]",
  "  - name: pi",
  "    models: [openai-codex/gpt-5.5]",
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
    // Focused CLI tests default compiler/inventory-clean without touching the
    // repository's generated workers tree or launcher config.
    probeWorkerCellFreshness: () => ({ ok: true }),
    probeShadowingWorkManifest: () => null,
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
// Help text documents the dispatchable plan-form verbs (the parser accepts
// work/close — the help must not under-claim either).
// ---------------------------------------------------------------------------

test("--help documents the plan-form verbs with their id shapes + scope", async () => {
  const r = await runDispatch(["--help"]);
  expect(r.code).toBe(0);
  for (const key of ["work::fn-N.M", "close::fn-N"]) {
    expect(r.stdout).toContain(key);
  }
  // Scope is named, not just the verbs — a task-id shape vs an epic-id shape.
  expect(r.stdout).toContain("task-scoped");
  expect(r.stdout).toContain("epic-scoped");
});

test("--agent-help names the plan-form verbs and their scope", async () => {
  const r = await runDispatch(["--agent-help"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("work|close");
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

test("a retired harness --preset triple fails loud (exit 2)", async () => {
  const r = await runDispatch([
    "--prompt",
    "x",
    "--preset",
    "codex::gpt::high",
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("not a registered harness");
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
  let freshnessCalls = 0;
  let inventoryCalls = 0;
  let inventoriedCwd: string | undefined;
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({ epics: epicWith(dir, { model: "opus", tier: "max" }) }),
    dirExists: () => true,
    probeWorkerCellFreshness: () => {
      freshnessCalls++;
      return { ok: true };
    },
    probeShadowingWorkManifest: (_pluginDir, launchCwd) => {
      inventoryCalls++;
      inventoriedCwd = launchCwd;
      return null;
    },
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
  expect(freshnessCalls).toBe(1);
  expect(inventoryCalls).toBe(1);
  expect(inventoriedCwd).toBe(dir);
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
  // …and the wrapped-cell guard marker rides the spec (task .1): the effective
  // `<model>::<effort>` + the per-task envelope path under the launch repo.
  expect(r.spec?.wrappedCell).toBe("gpt-5.5::high");
  expect(r.spec?.wrappedEnvelope).toBe(
    join(dir, ".keeper", "state", "wrapped-envelopes", "fn-1-x.1.json"),
  );
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
  expect(r.stderr).toContain(
    "keeper prompt compile --role work:worker --target claude",
  );
});

test("plan work: a stale compiler cohort fails closed before launch with canonical remediation", async () => {
  writeMatrix(CLAUDE_MATRIX);
  let freshnessCalls = 0;
  let shadowCalls = 0;
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({ epics: epicWith(dir, { model: "opus", tier: "max" }) }),
    dirExists: () => true,
    probeWorkerCellFreshness: () => {
      freshnessCalls++;
      return { ok: false, detail: "hash-mismatch: compiled worker differs" };
    },
    probeShadowingWorkManifest: () => {
      shadowCalls++;
      return null;
    },
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined();
  expect(freshnessCalls).toBe(1);
  expect(shadowCalls).toBe(0);
  expect(r.stderr).toContain("worker-cell-stale:");
  expect(r.stderr).toContain(
    "keeper prompt compile --role work:worker --target claude",
  );
});

test("plan work: a sibling worker-cell work plugin refuses (exit 1) naming the offending manifest", async () => {
  writeMatrix(CLAUDE_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({ epics: epicWith(dir, { model: "opus", tier: "max" }) }),
    dirExists: () => true,
    probeShadowingWorkManifest: () =>
      "/plugins/plan/workers/sonnet-max/.claude-plugin/plugin.json",
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined();
  expect(r.stderr).toContain("work:worker");
  expect(r.stderr).toContain(
    "/plugins/plan/workers/sonnet-max/.claude-plugin/plugin.json",
  );
  expect(r.stderr).not.toContain("non-cell");
});

// ---------------------------------------------------------------------------
// worker_provider pin translation (ADR 0047) — the manual dispatch applies the
// SAME `applyProviderConstraint` seam the autopilot producer does.
// ---------------------------------------------------------------------------

/** A v2 roster: Claude-native opus/sonnet plus Pi serving gpt-5.6-sol
 *  (the committed map's opus→gpt target), all in subagent_models. */
const SOL_MATRIX = [
  "efforts: [low, medium, high, xhigh, max]",
  "subagent_templates: [template/agents/worker.md.tmpl]",
  "subagent_models: [opus, sonnet, gpt-5.6-sol]",
  "providers:",
  "  - name: claude",
  "    models: [opus, sonnet]",
  "  - name: pi",
  "    models: [openai-codex/gpt-5.6-sol]",
  "wrapper_driver: { model: sonnet, effort: high }",
  "defaults: { stop_timeout_ms: 3600000, max_attempts: 2 }",
  "",
].join("\n");

test("plan work: worker_provider=gpt TRANSLATES an opus cell to its mapped gpt cell + carries the dispatched-cell spec fields", async () => {
  writeMatrix(SOL_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "max" }),
      autopilotState: [
        { id: 1, paused: 1, worker_provider: "gpt" } as unknown as Row,
      ],
    }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
  });
  expect(r.code).toBeUndefined(); // launched
  // The launched cell is the TRANSLATED gpt cell, not the assigned opus cell.
  expect(r.spec?.pluginDir).toContain("plugins/plan/workers/gpt-5.6-sol-max");
  expect(r.spec?.dispatchedModel).toBe("gpt-5.6-sol");
  expect(r.spec?.dispatchedTier).toBe("max");
  expect(r.spec?.dispatchConstraint).toBe("gpt");
  // The wrapped-cell marker keys on the EFFECTIVE (translated) cell, not the
  // assigned opus — the pin translated an opus cell INTO a wrapped gpt cell.
  expect(r.spec?.wrappedCell).toBe("gpt-5.6-sol::max");
  expect(r.spec?.wrappedEnvelope).toBe(
    join(dir, ".keeper", "state", "wrapped-envelopes", "fn-1-x.1.json"),
  );
});

test("plan work: worker_provider=gpt with the mapped target OFF the host matrix refuses (fail-closed, exit 1)", async () => {
  // CLAUDE_MATRIX has no gpt-5.6-sol, so translating opus/max resolves a target
  // that is not a dispatchable cell — refuse, never fall back to opus.
  writeMatrix(CLAUDE_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "max" }),
      autopilotState: [
        { id: 1, paused: 1, worker_provider: "gpt" } as unknown as Row,
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
  // A native opus cell carries NO wrapped-cell marker — the guard stays inert.
  expect(r.spec?.wrappedCell).toBeUndefined();
  expect(r.spec?.wrappedEnvelope).toBeUndefined();
});

// The pin AUTHORITY read is tri-stated: a THROW is UNKNOWN, not ABSENT. A durable
// gpt pin whose value a by-hand launch cannot observe must NOT collapse to the
// unpinned assigned Claude cell — a cell-bearing work launch refuses instead.
test("plan work (cell-bearing): a pin-query THROW refuses — UNKNOWN never collapses to the assigned cell", async () => {
  writeMatrix(SOL_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      // The worker_provider pin read throws → UNKNOWN (not "no pin").
      epics: epicWith(dir, { model: "opus", tier: "max" }),
      throwOn: "autopilot_state",
    }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined(); // never launched — no fallback to opus
  expect(r.stderr).toContain("worker-provider-pin-unknown");
  expect(r.stderr).toContain("worker_provider");
});

// A present-but-INVALID pin value is UNKNOWN too — an unobservable authority, not
// a silent "no pin" — so a cell-bearing launch refuses rather than dispatch opus.
test("plan work (cell-bearing): a present-but-INVALID pin value refuses (UNKNOWN, not absent)", async () => {
  writeMatrix(SOL_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "max" }),
      autopilotState: [
        { id: 1, paused: 1, worker_provider: "banana" } as unknown as Row,
      ],
    }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined(); // never launched — no fallback to opus
  expect(r.stderr).toContain("worker-provider-pin-unknown");
});

// A cell-LESS task is pin-independent: an UNKNOWN pin (here present-invalid) never
// refuses it, because a cell-less launch invents no translation to begin with.
test("plan work (cell-less): an UNKNOWN pin does NOT refuse — cell-less invents no translation", async () => {
  writeMatrix(SOL_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir), // no {model,tier} → cell-less
      autopilotState: [
        { id: 1, paused: 1, worker_provider: "banana" } as unknown as Row,
      ],
    }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
  });
  expect(r.code).toBeUndefined(); // launched — pin-independent
  expect(r.spec).toBeDefined();
  expect(r.spec?.dispatchedModel).toBeUndefined();
});

// A provider-constraint READ ERROR (the equivalence map fails to load/parse at
// dispatch) adopts the autopilot owner's fail-closed posture: refuse with the
// typed map-malformed reason (naming the config + error class), NEVER a silent
// fallback to the assigned cell — the impossible-manifest class the pin prevents.
test("plan work: a provider-constraint READ ERROR refuses fail-closed (map-malformed), never a fallback", async () => {
  writeMatrix(SOL_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "max" }),
      autopilotState: [
        { id: 1, paused: 1, worker_provider: "gpt" } as unknown as Row,
      ],
    }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
    loadProviderEquivalence: () => ({
      ok: false,
      detail:
        "cannot read provider-equivalence map at /nope/provider-equivalence.yaml: ENOENT",
    }),
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined(); // never launched — no fallback to opus
  expect(r.stderr).toContain("worker-provider-map-malformed");
  expect(r.stderr).toContain("ENOENT"); // the error class rides through
  expect(r.stderr).toContain("provider-equivalence.yaml"); // the config to fix
});

// Absent PIN ≠ unreadable MAP (the tri-state discipline): with NO pin configured
// the constraint block short-circuits BEFORE the map is ever read, so even a map
// that WOULD fail to load leaves the assigned cell dispatching byte-identically.
test("plan work: a cleanly-absent pin passes through — the map is never read (absent ≠ unreadable)", async () => {
  writeMatrix(SOL_MATRIX);
  let mapRead = false;
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "max" }),
      autopilotState: [{ id: 1, paused: 1 } as unknown as Row], // no worker_provider
    }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
    loadProviderEquivalence: () => {
      mapRead = true;
      return { ok: false, detail: "must never be read without a pin" };
    },
  });
  expect(r.code).toBeUndefined(); // launched
  expect(mapRead).toBe(false); // the absent pin short-circuits before the map read
  expect(r.spec?.pluginDir).toContain("plugins/plan/workers/opus-max");
  expect(r.spec?.dispatchedModel).toBeUndefined();
});

// Manual dispatch composes the provider launch contract, so a map that
// translates into a cell whose DRIVER contradicts the pin (a gpt pin mapped onto
// claude-NATIVE sonnet) trips the provider-unlaunchable arm — the driver/route/
// marker mismatch a by-hand launch cannot reach without the contract the
// autopilot producer composes.
test("plan work: a driver/route mismatch trips the provider-unlaunchable contract arm (reachable by hand)", async () => {
  writeMatrix(SOL_MATRIX);
  const r = await runDispatch(["work::fn-1-x.1", "--force"], {
    query: makeQuery({
      epics: epicWith(dir, { model: "opus", tier: "max" }),
      autopilotState: [
        { id: 1, paused: 1, worker_provider: "gpt" } as unknown as Row,
      ],
    }),
    dirExists: () => true,
    probeShadowingWorkManifest: () => null,
    // A deliberately broken map: a gpt pin translated onto claude-native sonnet.
    // applyProviderConstraint passes it (sonnet IS a dispatchable host cell), but
    // the contract arm catches the effective driver (native) contradicting the pin.
    loadProviderEquivalence: () => ({
      ok: true,
      map: buildProviderEquivalenceMap({
        schema_version: 1,
        mappings: {
          claude_to_gpt: [
            {
              source: { model: "opus", effort: "max" },
              target: { model: "sonnet", effort: "max" },
            },
          ],
          gpt_to_claude: [],
        },
      }),
    }),
  });
  expect(r.code).toBe(1);
  expect(r.spec).toBeUndefined(); // never launched
  expect(r.stderr).toContain("worker-provider-cell-unlaunchable");
  expect(r.stderr).toContain("constraint requires wrapped");
  expect(r.stderr).toContain("driver=native");
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

test("plan work (cell-less): a thrown autopilot_state read FAILS OPEN — race + worktree geometry, pin-independent", async () => {
  // A CELL-LESS task (no {model,tier}) invents no provider translation, so a
  // thrown autopilot_state read (race guard + worktree-mode geometry + the pin all
  // unreachable) fails open — a manual dispatch is the recovery tool when the
  // daemon is down. This does NOT bless a CELL-BEARING task's UNKNOWN pin: that
  // refuses (below). The fail-open here covers only the worktree/geometry read.
  const r = await runDispatch(["work::fn-1-x.1"], {
    query: makeQuery({ epics: epicWith(dir), throwOn: "autopilot_state" }),
    dirExists: () => true,
  });
  expect(r.code).toBeUndefined(); // launched — cell-less, geometry read fails open
  expect(r.spec).toBeDefined();
  // Cell-less ⇒ no cell to translate: no dispatched/constraint fields leak.
  expect(r.spec?.dispatchedModel).toBeUndefined();
  expect(r.spec?.dispatchConstraint).toBeUndefined();
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
