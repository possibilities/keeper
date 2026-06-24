/**
 * Integration tests of `cli/dispatch.ts main()` orchestration for the `--preset`
 * model/effort resolution path (fn-937 task 3). The pure builders live in
 * `src/dispatch-command.ts` (unit-tested in `test/dispatch-command.test.ts`); this
 * file covers the thin entry's PRECEDENCE — explicit --model/--effort > --preset >
 * the `worker` preset default (plan form only) — by capturing the `LaunchSpec` the
 * injected `launch` seam receives, never a real tmux/daemon.
 *
 * The preset registry path is sandboxed via KEEPER_PRESETS_CONFIG (os.homedir()
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
const TOUCHED = ["KEEPER_PRESETS_CONFIG"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dispatch-cli-"));
  saved = {};
  for (const k of TOUCHED) saved[k] = process.env[k];
  process.env.KEEPER_PRESETS_CONFIG = join(dir, "presets.yaml");
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

interface CapturedLaunch {
  spec: LaunchSpec | undefined;
  code: number | undefined;
  stderr: string;
}

/** Drive dispatchMain capturing the LaunchSpec the launch seam receives. */
async function runDispatch(
  argv: string[],
  extraDeps: Partial<MainDeps> = {},
): Promise<CapturedLaunch> {
  let spec: LaunchSpec | undefined;
  const err: string[] = [];
  const realErr = process.stderr.write.bind(process.stderr);
  const realOut = process.stdout.write.bind(process.stdout);
  const realExit = process.exit.bind(process);
  let code: number | undefined;
  process.stderr.write = ((s: string | Uint8Array) => {
    err.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new ExitError(code);
  }) as typeof process.exit;
  const deps: MainDeps = {
    launch: async (_session, _argv, _cwd, _name, s): Promise<LaunchResult> => {
      spec = s;
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
  return { spec, code, stderr: err.join("") };
}

test("free-form --preset supplies the spec model/effort", async () => {
  writePresets(
    "presets:\n  fast:\n    harness: claude\n    model: haiku\n    effort: low\n",
  );
  const r = await runDispatch(["--prompt", "do a thing", "--preset", "fast"]);
  expect(r.spec?.model).toBe("haiku");
  expect(r.spec?.effort).toBe("low");
});

test("explicit --model/--effort override the preset (per field)", async () => {
  writePresets(
    "presets:\n  fast:\n    harness: claude\n    model: haiku\n    effort: low\n",
  );
  const r = await runDispatch([
    "--prompt",
    "do a thing",
    "--preset",
    "fast",
    "--model",
    "opus",
  ]);
  // --model wins; the preset's effort still applies.
  expect(r.spec?.model).toBe("opus");
  expect(r.spec?.effort).toBe("low");
});

test("free-form without preset passes no model/effort (zero behavior change)", async () => {
  const r = await runDispatch(["--prompt", "do a thing"]);
  expect(r.spec?.model).toBeUndefined();
  expect(r.spec?.effort).toBeUndefined();
});

test("plan form defaults to the worker preset model/effort", async () => {
  writePresets(
    "presets:\n  worker:\n    harness: claude\n    model: opus\n    effort: high\n",
  );
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

test("plan form with no worker preset falls back to sonnet/max", async () => {
  // No presets file → empty registry → worker defaults.
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

test("a codex preset handed to dispatch fails loud (claude-only, exit 2)", async () => {
  writePresets("presets:\n  cx:\n    harness: codex\n    model: gpt\n");
  const r = await runDispatch(["--prompt", "x", "--preset", "cx"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("claude-only");
});

test("a missing preset name fails loud (exit 2)", async () => {
  writePresets("presets:\n  fast:\n    harness: claude\n    model: haiku\n");
  const r = await runDispatch(["--prompt", "x", "--preset", "nope"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("not found");
});
