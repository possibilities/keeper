/**
 * End-to-end test of `cli/pair.ts main()` orchestration (Finding F4). The pure
 * builders/parsers live in `src/pair-command.ts` and are unit-tested in
 * `test/pair-command.test.ts`; this file covers the thin orchestration entry —
 * specifically the LOAD-BEARING two-line Monitor contract: stdout is the Monitor
 * event channel and EVERY exit path must emit exactly one `[keeper-pair] started`
 * line plus exactly one terminal (`completed`/`failed`) line.
 *
 * The highest-value coverage is a failure path. We drive the launch-failure
 * branch by pointing `KEEPER_AGENTWRAP_PATH` at a nonexistent binary: the
 * `agentwrap <cli>` launch spawn throws ENOENT, `runAgentwrap` returns null, and
 * `main()` takes the `fail(...)` path. No real tmux, no real git (read-only is
 * off so the git backstop is skipped), no daemon — a deterministic synchronous
 * failure.
 *
 * `main()` writes to process.stdout/stderr and calls process.exit() directly, so
 * (mirroring `test/keeper-cli.test.ts`'s `runMain`) we patch those globals around
 * the call: exit throws a tagged ExitError so the never-return `fail` branch
 * stops the function, and the streams are captured + restored in a finally. The
 * agentwrap-path + state env are sandboxed per the repo isolation rule and
 * restored after each run.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as pairMain } from "../cli/pair";
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
  "KEEPER_AGENTWRAP_PATH",
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
  // rule) and point the keeper-agent launcher path at a nonexistent module so the
  // launch spawn (`bun <bad-path> agent claude …`) deterministically fails — bun
  // runs but cannot load the bad module and exits non-zero.
  const env = sandboxEnv({
    tmpDir: dir,
    dbPath: join(dir, "keeper.db"),
    extra: {
      KEEPER_AGENTWRAP_PATH: join(dir, "no-such-agentwrap-binary"),
      // Point the config resolver at a nonexistent file so `disable-autoclose`
      // resolves to its EMPTY default (the user's real config never bleeds in):
      // the codex reap path is then exercised against an autoclosing session.
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

/** Drive `pairMain(argv)` with process.{exit,stdout,stderr} captured. */
async function runMain(argv: string[]): Promise<MainRun> {
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
    await pairMain(argv);
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

  const r = await runMain([
    "send",
    promptFile,
    "--cli",
    "claude",
    "--output",
    join(dir, "result.yaml"),
  ]);

  // Failure path exits 1 (the launch/wait/show error taxonomy).
  expect(r.code).toBe(1);

  // The load-bearing invariant: stdout carries EXACTLY one started + one failed.
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(1);
  // …and no completed line leaked onto the failure path.
  expect(countEvent(r.stdout, "completed")).toBe(0);

  // The terminal line carries the launch-failure cause: bun runs the bad launcher
  // module and exits non-zero, surfaced as an "agentwrap launch exited" error.
  expect(r.stdout).toContain("[keeper-pair] failed");
  expect(r.stdout).toContain("error=agentwrap launch exited");
});

test("started precedes failed on the failure path", async () => {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "audit this");

  const r = await runMain([
    "send",
    promptFile,
    "--cli",
    "codex",
    "--output",
    join(dir, "result.yaml"),
  ]);

  expect(r.code).toBe(1);
  const startedIdx = r.stdout.indexOf("[keeper-pair] started");
  const failedIdx = r.stdout.indexOf("[keeper-pair] failed");
  expect(startedIdx).toBeGreaterThanOrEqual(0);
  expect(failedIdx).toBeGreaterThan(startedIdx);
});

/** Write the sandboxed `presets.yaml` (KEEPER_CONFIG_DIR/presets.yaml). */
function writePresets(body: string): void {
  writeFileSync(join(dir, "presets.yaml"), body);
}

test("--preset alone is valid: harness comes from the preset, started carries preset=", async () => {
  writePresets("presets:\n  reviewer:\n    harness: claude\n    model: opus\n");
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "review this");

  // --preset (no --cli) reaches the LAUNCH (fails there on the bad launcher path),
  // proving the cli===undefined hard-fail was relaxed for the preset case.
  const r = await runMain([
    "send",
    promptFile,
    "--preset",
    "reviewer",
    "--output",
    join(dir, "result.yaml"),
  ]);
  expect(r.code).toBe(1);
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(1);
  // started carries the preset name AND the harness resolved from the preset.
  expect(r.stdout).toContain("[keeper-pair] started cli=claude");
  expect(r.stdout).toContain("preset=reviewer");
  // It reached the launch, not an arg-fault exit-2.
  expect(r.stdout).toContain("error=agentwrap launch exited");
});

test("--preset + agreeing --cli is accepted", async () => {
  writePresets("presets:\n  reviewer:\n    harness: claude\n    model: opus\n");
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "review this");

  const r = await runMain([
    "send",
    promptFile,
    "--preset",
    "reviewer",
    "--cli",
    "claude",
    "--output",
    join(dir, "result.yaml"),
  ]);
  expect(r.code).toBe(1);
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(r.stdout).toContain("error=agentwrap launch exited");
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
  // (failing there on the sandboxed bad-launcher path) like the claude preset,
  // instead of the old exit-2 reject — no accept/reject inconsistency remains.
  const r = await runMain([
    "send",
    promptFile,
    "--preset",
    "thinker",
    "--output",
    join(dir, "result.yaml"),
  ]);
  expect(r.code).toBe(1);
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(1);
  expect(r.stdout).toContain("[keeper-pair] started cli=pi");
  expect(r.stdout).toContain("preset=thinker");
  expect(r.stdout).toContain("error=agentwrap launch exited");
});

test("--cli pi is accepted: reaches launch (exit 1)", async () => {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "explore this");

  const r = await runMain([
    "send",
    promptFile,
    "--cli",
    "pi",
    "--output",
    join(dir, "result.yaml"),
  ]);
  expect(r.code).toBe(1);
  expect(countEvent(r.stdout, "started")).toBe(1);
  expect(countEvent(r.stdout, "failed")).toBe(1);
  expect(r.stdout).toContain("[keeper-pair] started cli=pi");
  expect(r.stdout).toContain("error=agentwrap launch exited");
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
