/**
 * End-to-end test of `cli/pair.ts main()` orchestration (Finding F4). The pure
 * builders/parsers live in `src/pair-command.ts` and are unit-tested in
 * `test/pair-command.test.ts`; this file covers the thin orchestration entry —
 * specifically the LOAD-BEARING two-line Monitor contract: stdout is the Monitor
 * event channel and EVERY exit path must emit exactly one `[keeper-pair] started`
 * line plus exactly one terminal (`completed`/`failed`) line.
 *
 * pair now composes the partner launch IN-PROCESS via the shared `src/agent`
 * run-capture primitives, so the launch + wait/show are driven through INJECTED
 * seams (a canned tmux command runner that forces a `TmuxLaunchError`, and canned
 * wait/show outcomes) — no real tmux, no real git (read-only is prompting-only,
 * so there is no git audit to skip), no daemon, no subprocess. Each `RunCaptureOutcome` is
 * exercised for its mapping onto pair's 0/1/2 contract.
 *
 * `main()` writes to process.stdout/stderr and calls process.exit() directly, so
 * (mirroring `test/keeper-cli.test.ts`'s `runMain`) we patch those globals around
 * the call: exit throws a tagged ExitError so the never-return `fail` branch
 * stops the function, and the streams are captured + restored in a finally. The
 * launcher state dir is redirected into the per-test tmpdir via the injected
 * seam, and the keeper state env is sandboxed per the repo isolation rule.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PairSendSeams, main as pairMain } from "../cli/pair";
import type {
  ShowLastMessageResult,
  WaitForStopResult,
} from "../src/agent/pair-subcommands";
import { sandboxEnv } from "./helpers/sandbox-env";

class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

interface MainRun {
  /** Captured exit code (undefined if main returned without exiting). */
  code: number | undefined;
  stdout: string;
  stderr: string;
}

let dir: string;
/** Env keys this test mutates on process.env, captured for restore. */
const TOUCHED_ENV_KEYS = [
  "KEEPER_AGENT_PATH",
  "KEEPER_DB",
  "KEEPER_DEAD_LETTER_DIR",
  "KEEPER_EVENTS_LOG",
  "KEEPER_DROP_LOG",
  "KEEPER_RESTORE_FILE",
  "KEEPER_BACKSTOP_LOG",
  "KEEPER_BUS_DB",
  "KEEPER_BUS_SOCK",
  "KEEPER_CONFIG",
  // The preset catalog dir is sandboxed via KEEPER_CONFIG_DIR (os.homedir()
  // ignores $HOME on macOS, so the default `~/.config/...` can't be redirected).
  "KEEPER_CONFIG_DIR",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pair-cli-"));
  savedEnv = {};
  for (const k of TOUCHED_ENV_KEYS) savedEnv[k] = process.env[k];

  // Sandbox every keeper state path under the per-test tmpdir (the isolation
  // rule). The launcher state dir + tmux transport are injected per-run via the
  // seam bag, so no real tmux/subprocess ever fires.
  const env = sandboxEnv({
    tmpDir: dir,
    dbPath: join(dir, "keeper.db"),
    extra: {
      KEEPER_AGENT_PATH: join(dir, "no-such-keeper-agent-binary"),
      // Point the config resolver at a nonexistent file so the run uses keeper's
      // built-in defaults and the user's real config never bleeds in.
      KEEPER_CONFIG: join(dir, "no-such-config.yaml"),
      // Sandbox the preset catalog dir under the tmpdir so the user's real
      // presets never bleed in (a bare `keeper pair` with no --preset reads no
      // config; a --preset hard-fails exit 2 unless a fixture catalog is written).
      KEEPER_CONFIG_DIR: dir,
    },
  });
  for (const k of TOUCHED_ENV_KEYS) {
    if (env[k] !== undefined) process.env[k] = env[k];
    else delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A canned tmux runner that fails window creation → `TmuxLaunchError` →
 *  `launch_failed`, with no real tmux. */
const FAILING_TMUX: PairSendSeams["runTmuxCommand"] = () => ({
  exitCode: 1,
  stdout: "",
  stderr: "tmux unavailable",
});

/** A canned tmux runner that reports no existing session then a created target
 *  (`session\x01@window\x01%pane`), so the launch succeeds with no real tmux. */
const LAUNCHING_TMUX: PairSendSeams["runTmuxCommand"] = (cmd) => {
  if (cmd.includes("has-session")) {
    return { exitCode: 1, stdout: "", stderr: "no session" };
  }
  return { exitCode: 0, stdout: "pair\x01@1\x01%1\n", stderr: "" };
};

const STOP = {
  agent: "claude" as const,
  eventType: "assistant",
  reason: "end_turn",
  timestamp: null,
  message: "the answer",
};

/** Seam overrides for a launch that fails at the tmux step. */
function launchFailureSeams(): Partial<PairSendSeams> {
  return { runTmuxCommand: FAILING_TMUX, launcherStateDir: dir };
}

/** Seam overrides for a successful launch with canned wait/show outcomes. */
function composeSeams(
  wait: WaitForStopResult,
  show: ShowLastMessageResult,
): Partial<PairSendSeams> {
  return {
    runTmuxCommand: LAUNCHING_TMUX,
    launcherStateDir: dir,
    waitForStop: async () => wait,
    showLastMessage: async () => show,
    now: () => 0,
  };
}

/** Drive `pairMain(argv, seams)` with process.{exit,stdout,stderr} captured. */
async function runMain(
  argv: string[],
  seams: Partial<PairSendSeams> = {},
): Promise<MainRun> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const realExit = process.exit.bind(process);
  let code: number | undefined;
  process.stdout.write = ((s: string | Uint8Array) => {
    out.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    err.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new ExitError(code);
  }) as typeof process.exit;
  try {
    await pairMain(argv, seams);
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.exit = realExit;
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** Count lines in `stdout` whose Monitor event token equals `event`. */
function countEvent(stdout: string, event: string): number {
  return stdout
    .split("\n")
    .filter((l) => l.startsWith(`[keeper-pair] ${event} `)).length;
}

test("launch-failure path emits exactly one started + one failed line (two-line contract)", async () => {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "audit this");

  const r = await runMain(
    [
      "send",
      promptFile,
      "--cli",
      "claude",
      "--output",
      join(dir, "result.yaml"),
    ],
    launchFailureSeams(),
  );

  // Failure path exits 1 (the launch/wait/show error taxonomy).
  expect(r.code).toBe(1);

  // The load-bearing invariant: stdout carries EXACTLY one started + one failed.
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(1);
  // …and no completed line leaked onto the failure path.
  expect(countEvent(r.stdout, "completed")).toBe(0);

  // The terminal line carries the launch-failure cause (the injected tmux seam
  // forced a TmuxLaunchError → launch_failed).
  expect(r.stdout).toContain("[keeper-pair] failed");
  expect(r.stdout).toContain("error=keeper agent launch failed");
  // No --output file is written on the failure path.
  expect(existsSync(join(dir, "result.yaml"))).toBe(false);
});

test("started precedes failed on the failure path", async () => {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "audit this");

  const r = await runMain(
    [
      "send",
      promptFile,
      "--cli",
      "claude",
      "--output",
      join(dir, "result.yaml"),
    ],
    launchFailureSeams(),
  );

  expect(r.code).toBe(1);
  const startedIdx = r.stdout.indexOf("[keeper-pair] started");
  const failedIdx = r.stdout.indexOf("[keeper-pair] failed");
  expect(startedIdx).toBeGreaterThanOrEqual(0);
  expect(failedIdx).toBeGreaterThan(startedIdx);
});

// ---------------------------------------------------------------------------
// in-process compose: RunCaptureOutcome → pair's 0/1/2 contract
// ---------------------------------------------------------------------------

test("completed outcome → success tail writes YAML, completed line, exit 0", async () => {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "audit this");
  const outPath = join(dir, "result.yaml");

  const r = await runMain(
    ["send", promptFile, "--cli", "claude", "--output", outPath],
    composeSeams(
      { ok: true, transcriptPath: "/t.jsonl", stop: STOP },
      {
        ok: true,
        transcriptPath: "/t.jsonl",
        text: "partner answer",
        found: true,
      },
    ),
  );

  expect(r.code).toBe(0);
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(countEvent(r.stdout, "completed")).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(0);
  // The atomic write landed the partner's answer + the cli/role echo.
  const yaml = readFileSync(outPath, "utf8");
  expect(yaml).toContain("message: partner answer");
  expect(yaml).toContain("cli: claude");
});

test("no_message outcome (tool-only final turn) → completed, empty message, exit 0", async () => {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "audit this");
  const outPath = join(dir, "result.yaml");

  const r = await runMain(
    ["send", promptFile, "--cli", "claude", "--output", outPath],
    composeSeams(
      {
        ok: true,
        transcriptPath: "/t.jsonl",
        stop: { ...STOP, message: null },
      },
      { ok: true, transcriptPath: "/t.jsonl", text: null, found: false },
    ),
  );

  // Old pair always SUCCEEDED on a tool-only final turn — no_message is exit 0.
  expect(r.code).toBe(0);
  expect(countEvent(r.stdout, "completed")).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(0);
  const yaml = readFileSync(outPath, "utf8");
  expect(yaml).toContain("message: ''");
});

test("timed_out outcome → failed, exit 1, drops the partial message, no output file", async () => {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "audit this");
  const outPath = join(dir, "result.yaml");

  const r = await runMain(
    ["send", promptFile, "--cli", "claude", "--output", outPath],
    composeSeams(
      {
        ok: false,
        error: "timed out waiting for transcript stop after 50ms (caller)",
      },
      {
        ok: true,
        transcriptPath: "/t.jsonl",
        text: "partial so far",
        found: true,
      },
    ),
  );

  expect(r.code).toBe(1);
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(1);
  expect(countEvent(r.stdout, "completed")).toBe(0);
  expect(r.stdout).toContain("error=partner timed out before stopping");
  // The partial message is dropped — no output file is written on the fail arm.
  expect(existsSync(outPath)).toBe(false);
});

test("no_transcript outcome → failed, exit 1, no output file", async () => {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "audit this");
  const outPath = join(dir, "result.yaml");

  const r = await runMain(
    ["send", promptFile, "--cli", "claude", "--output", outPath],
    composeSeams(
      { ok: false, error: "timed out waiting for transcript path" },
      { ok: false, error: "timed out waiting for transcript path" },
    ),
  );

  expect(r.code).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(1);
  expect(r.stdout).toContain("error=partner produced no transcript");
  expect(existsSync(outPath)).toBe(false);
});

// ---------------------------------------------------------------------------
// preset resolution + arg validation (unchanged, pre-compose)
// ---------------------------------------------------------------------------

/** Write the sandboxed `presets.yaml` (KEEPER_CONFIG_DIR/presets.yaml). */
function writePresets(body: string): void {
  writeFileSync(join(dir, "presets.yaml"), body);
}

test("--preset alone is valid: harness comes from the preset, started carries preset=", async () => {
  writePresets("presets:\n  reviewer:\n    harness: claude\n    model: opus\n");
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "review this");

  // --preset (no --cli) reaches the LAUNCH (failing there on the injected tmux
  // seam), proving the cli===undefined hard-fail was relaxed for the preset case.
  const r = await runMain(
    [
      "send",
      promptFile,
      "--preset",
      "reviewer",
      "--output",
      join(dir, "result.yaml"),
    ],
    launchFailureSeams(),
  );
  expect(r.code).toBe(1);
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(1);
  // started carries the preset name AND the harness resolved from the preset.
  expect(r.stdout).toContain("[keeper-pair] started cli=claude");
  expect(r.stdout).toContain("preset=reviewer");
  // It reached the launch, not an arg-fault exit-2.
  expect(r.stdout).toContain("error=keeper agent launch failed");
});

test("--preset + agreeing --cli is accepted", async () => {
  writePresets("presets:\n  reviewer:\n    harness: claude\n    model: opus\n");
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "review this");

  const r = await runMain(
    [
      "send",
      promptFile,
      "--preset",
      "reviewer",
      "--cli",
      "claude",
      "--output",
      join(dir, "result.yaml"),
    ],
    launchFailureSeams(),
  );
  expect(r.code).toBe(1);
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(r.stdout).toContain("error=keeper agent launch failed");
});

test("--preset disagreeing with --cli fails loud (exit 2, no started line)", async () => {
  writePresets("presets:\n  reviewer:\n    harness: claude\n    model: opus\n");
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "review this");

  const r = await runMain([
    "send",
    promptFile,
    "--preset",
    "reviewer",
    "--cli",
    "codex",
    "--output",
    join(dir, "result.yaml"),
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("disagrees with preset");
  // Arg fault precedes any Monitor event.
  expect(countEvent(r.stdout, "started")).toBe(0);
});

test("a pi preset is accepted: reaches launch (exit 1, started cli=pi)", async () => {
  // The fixture uses model:/thinking: (pi-valid), never effort: (pi-forbidden).
  writePresets(
    "presets:\n  thinker:\n    harness: pi\n    model: pi-1\n    thinking: high\n",
  );
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "think");

  // pi is a first-class pair partner now: --preset thinker reaches the LAUNCH
  // (failing there on the injected tmux seam) like the claude preset, instead of
  // the old exit-2 reject — no accept/reject inconsistency remains.
  const r = await runMain(
    [
      "send",
      promptFile,
      "--preset",
      "thinker",
      "--output",
      join(dir, "result.yaml"),
    ],
    launchFailureSeams(),
  );
  expect(r.code).toBe(1);
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(1);
  expect(r.stdout).toContain("[keeper-pair] started cli=pi");
  expect(r.stdout).toContain("preset=thinker");
  expect(r.stdout).toContain("error=keeper agent launch failed");
});

test("--cli pi is accepted: reaches launch (exit 1)", async () => {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "explore this");

  const r = await runMain(
    ["send", promptFile, "--cli", "pi", "--output", join(dir, "result.yaml")],
    launchFailureSeams(),
  );
  expect(r.code).toBe(1);
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(1);
  expect(r.stdout).toContain("[keeper-pair] started cli=pi");
  expect(r.stdout).toContain("error=keeper agent launch failed");
});

test("a missing preset name fails loud naming the available presets (exit 2)", async () => {
  writePresets("presets:\n  reviewer:\n    harness: claude\n    model: opus\n");
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "x");

  const r = await runMain([
    "send",
    promptFile,
    "--preset",
    "nope",
    "--output",
    join(dir, "result.yaml"),
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("not found");
  expect(r.stderr).toContain("reviewer");
  expect(countEvent(r.stdout, "started")).toBe(0);
});
