/**
 * The help-purity walk (ADR 0008, the epic's capstone regression). For EVERY
 * leaf + verb in the merged descriptor tree — native leaves, native two-level
 * verbs, and the plan/prompt plugin verb sets — invoking its main IN-PROCESS with
 * `--help` (and `--agent-help` where the descriptor declares it) must exit 0 with
 * non-empty stdout while touching NO side effect: a subprocess spawn, a socket
 * connect, an async filesystem write, and a database open are all wired to THROW.
 * A `--help` path that reached for any of them fails here rather than in the wild.
 *
 * This is the structural proof of the whole purity property, not a spot check of
 * the sites earlier ordinals fixed: the case list is generated from the descriptor
 * data, so a newly-added command or verb is walked automatically.
 *
 * `agent`'s launch verbs (claude/codex/pi/run/wait/panel/…) are DELIBERATELY not
 * descended into: `keeper agent <x> --help` forwards `--help` to the launched
 * agent binary (a real spawn), so only `keeper agent --help` is a keeper-help path.
 */

import { describe, expect, test } from "bun:test";
import { NATIVE_COMMANDS } from "../cli/descriptor";
import { buildHelpIndex, runCompletionsCommand } from "../cli/keeper";
import { main as planMain } from "../plugins/plan/src/cli";
import { PLAN_COMMANDS } from "../plugins/plan/src/descriptor";
import { main as promptMain } from "../plugins/prompt/src/cli";
import { PROMPT_COMMANDS } from "../plugins/prompt/src/descriptor";

/** Thrown by the patched `process.exit` so a never-returning help branch (the
 *  leaves that `process.exit(0)`) unwinds to a captured exit code instead of
 *  tearing down the test runner. */
class ExitCapture extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

interface PureRun {
  code: number;
  stdout: string;
}

/**
 * Run one CLI main under the throwing-stub regime and capture its exit + stdout.
 * The four side-effect seams a `--help` path must never reach — subprocess spawn
 * (`Bun.spawn`/`spawnSync`), socket connect (`Bun.connect`), async fs write
 * (`Bun.write`), and db open (every `openDb` resolves `KEEPER_DB`, here pointed at
 * an un-openable path) — throw, so an impure help path surfaces as a rejected run
 * (rethrown → the test fails) rather than a silent connect/write. A leaf that
 * `process.exit(0)`s and one that just `return`s both land as code 0.
 */
async function runPure(fn: () => unknown | Promise<unknown>): Promise<PureRun> {
  const out: string[] = [];
  const orig = {
    spawn: Bun.spawn,
    spawnSync: Bun.spawnSync,
    connect: Bun.connect,
    write: Bun.write,
    exit: process.exit,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  const savedEnv: Record<string, string | undefined> = {
    KEEPER_DB: process.env.KEEPER_DB,
    KEEPER_BUS_DB: process.env.KEEPER_BUS_DB,
    KEEPER_BUS_SOCK: process.env.KEEPER_BUS_SOCK,
    KEEPER_SOCK: process.env.KEEPER_SOCK,
  };
  const boom = (op: string) => (): never => {
    throw new Error(`purity violation: ${op} reached on a --help path`);
  };
  // Any real db open / socket connect throws when pointed at this bad path.
  const junk = "/keeper-help-purity-nonexistent-dir/x";
  process.env.KEEPER_DB = `${junk}.db`;
  process.env.KEEPER_BUS_DB = `${junk}-bus.db`;
  process.env.KEEPER_BUS_SOCK = `${junk}.sock`;
  process.env.KEEPER_SOCK = `${junk}.sock`;
  // biome-ignore lint/suspicious/noExplicitAny: patching Bun globals for the walk.
  (Bun as any).spawn = boom("Bun.spawn");
  // biome-ignore lint/suspicious/noExplicitAny: patching Bun globals for the walk.
  (Bun as any).spawnSync = boom("Bun.spawnSync");
  // biome-ignore lint/suspicious/noExplicitAny: patching Bun globals for the walk.
  (Bun as any).connect = boom("Bun.connect");
  // biome-ignore lint/suspicious/noExplicitAny: patching Bun globals for the walk.
  (Bun as any).write = boom("Bun.write");
  process.stdout.write = ((s: string | Uint8Array) => {
    out.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stdout.write;
  // stderr is swallowed — a pure help path writes its help to stdout.
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((c?: number) => {
    throw new ExitCapture(c ?? 0);
  }) as typeof process.exit;
  let code = 0;
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitCapture) code = e.code;
    else throw e;
  } finally {
    Bun.spawn = orig.spawn;
    Bun.spawnSync = orig.spawnSync;
    Bun.connect = orig.connect;
    Bun.write = orig.write;
    process.exit = orig.exit;
    process.stdout.write = orig.stdout;
    process.stderr.write = orig.stderr;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { code, stdout: out.join("") };
}

/** Resolve a native leaf's `main(argv)`. `completions` has no `cli/` module — it
 *  is served by `runCompletionsCommand` in `cli/keeper.ts` — so it is wired to an
 *  equivalent argv-only main here. `daemon` dispatches to the restart module. */
async function resolveNativeMain(
  name: string,
): Promise<(argv: string[]) => unknown> {
  if (name === "completions") {
    return (argv: string[]) =>
      runCompletionsCommand(argv, {
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
        exit: (c) => process.exit(c),
        version: "9.9.9",
      });
  }
  // The daemon descriptor routes to the restart leaf in keeper.ts; test that
  // real handler rather than inventing a cli/daemon.ts module.
  if (name === "daemon") {
    const restartMain = (await import("../cli/restart.ts")).main;
    return (argv) =>
      restartMain(argv[0] === "restart" ? argv : ["restart", ...argv]);
  }
  const mod = (await import(`../cli/${name}.ts`)) as {
    main: (argv: string[]) => unknown;
  };
  return mod.main;
}

function assertPure(r: PureRun): void {
  expect(r.code).toBe(0);
  expect(r.stdout.length).toBeGreaterThan(0);
}

describe("native leaf --help is pure (exit 0, non-empty stdout, no side effects)", () => {
  for (const cmd of NATIVE_COMMANDS) {
    test(`keeper ${cmd.name} --help`, async () => {
      const main = await resolveNativeMain(cmd.name);
      assertPure(await runPure(() => main(["--help"])));
    });

    if (cmd.agent_help === true) {
      test(`keeper ${cmd.name} --agent-help`, async () => {
        const main = await resolveNativeMain(cmd.name);
        assertPure(await runPure(() => main(["--agent-help"])));
      });
    }
  }
});

describe("native two-level verb --help is pure", () => {
  // agent's verbs forward --help to the launched binary (a spawn), so they are
  // not keeper-help leaves; every other two-level command owns keeper help.
  // transcript's verbs sit behind a required leading harness positional
  // (`keeper transcript <harness> list|show`), so its argv needs that token
  // prepended before the verb.
  for (const cmd of NATIVE_COMMANDS) {
    if (cmd.verbs === undefined || cmd.name === "agent") continue;
    for (const verb of cmd.verbs) {
      test(`keeper ${cmd.name} ${verb.name} --help`, async () => {
        const main = await resolveNativeMain(cmd.name);
        const argv =
          cmd.name === "transcript"
            ? ["claude", verb.name, "--help"]
            : [verb.name, "--help"];
        assertPure(await runPure(() => main(argv)));
      });
    }
  }
});

describe("plan verb --help is pure", () => {
  for (const cmd of PLAN_COMMANDS) {
    if (cmd.subcommands !== undefined) {
      for (const sub of cmd.subcommands) {
        test(`keeper plan ${cmd.name} ${sub.name} --help`, async () => {
          assertPure(
            await runPure(() => planMain([cmd.name, sub.name, "--help"])),
          );
        });
      }
    } else {
      test(`keeper plan ${cmd.name} --help`, async () => {
        assertPure(await runPure(() => planMain([cmd.name, "--help"])));
      });
    }
  }
});

describe("prompt verb --help is pure", () => {
  for (const cmd of PROMPT_COMMANDS) {
    test(`keeper prompt ${cmd.name} --help`, async () => {
      assertPure(await runPure(() => promptMain([cmd.name, "--help"])));
    });
  }
});

describe("the merged --help --json verb sets match the plugins' dispatchable reality", () => {
  test("plan node verb count equals the plan descriptor's command count (drift pin)", () => {
    const plan = buildHelpIndex().subcommands.find((s) => s.name === "plan");
    expect(plan?.verbs?.length).toBe(PLAN_COMMANDS.length);
    expect(plan?.verbs?.map((v) => v.name)).toEqual(
      PLAN_COMMANDS.map((c) => c.name),
    );
  });

  test("prompt node verb count equals the prompt descriptor's command count", () => {
    const prompt = buildHelpIndex().subcommands.find(
      (s) => s.name === "prompt",
    );
    expect(prompt?.verbs?.length).toBe(PROMPT_COMMANDS.length);
    expect(prompt?.verbs?.map((v) => v.name)).toEqual(
      PROMPT_COMMANDS.map((c) => c.name),
    );
  });

  test("a plan subgroup carries its nested verbs recursively in the index", () => {
    const plan = buildHelpIndex().subcommands.find((s) => s.name === "plan");
    const epic = plan?.verbs?.find((v) => v.name === "epic");
    const epicDesc = PLAN_COMMANDS.find((c) => c.name === "epic");
    expect(epic?.verbs?.map((v) => v.name)).toEqual(
      epicDesc?.subcommands?.map((s) => s.name),
    );
  });
});
