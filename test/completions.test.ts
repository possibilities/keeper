/**
 * Tests for `keeper completions <shell>` and the hidden `keeper complete`
 * responder. Everything runs in-process against the exported completion
 * functions and the dispatch seam — no interactive shell, no daemon socket, no
 * LaunchAgent, no writes under the real home directory (the fast Bun tier).
 *
 * The completion tree is a throwaway Clerc CLI built from the SAME metadata
 * (`SUBCOMMANDS` + `SUBCOMMAND_META.verbs`) that `keeper --help --json` reads,
 * so a top-level command or verb can never drift between the two surfaces.
 */

import { describe, expect, test } from "bun:test";
import { NATIVE_COMMANDS } from "../cli/descriptor";
import {
  buildHelpIndex,
  COMPLETION_RESPONDER,
  COMPLETION_SHELLS,
  type CompletionShell,
  completionResponder,
  type DispatchDeps,
  dispatch,
  generateCompletionScript,
  isCompletionShell,
  runCompletionsCommand,
  SUBCOMMAND_META,
  SUBCOMMANDS,
  type Subcommand,
} from "../cli/keeper";

const VERSION = "9.9.9";

/** Parse a responder payload into its candidate values (the token before the
 *  tab), dropping the plugin's trailing `:<directive>` control line. */
function candidateValues(payload: string): string[] {
  return payload
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith(":"))
    .map((line) => line.split("\t")[0] as string);
}

describe("keeper completions script generation", () => {
  for (const shell of COMPLETION_SHELLS) {
    test(`${shell}: emits a non-empty framework-generated script`, async () => {
      const script = await generateCompletionScript(shell, VERSION);
      expect(script.length).toBeGreaterThan(0);
      // Every generated script wires TAB back to the hidden `keeper complete`
      // responder — that is the load-bearing line proving the script is live.
      expect(script).toContain(`keeper ${COMPLETION_RESPONDER} --`);
    });
  }

  test("bash script carries a bash completion preamble", async () => {
    const script = await generateCompletionScript("bash", VERSION);
    expect(script).toContain("bash completion for keeper");
  });

  test("zsh script carries the #compdef directive", async () => {
    const script = await generateCompletionScript("zsh", VERSION);
    expect(script).toContain("#compdef keeper");
  });

  test("fish script registers keeper completions", async () => {
    const script = await generateCompletionScript("fish", VERSION);
    expect(script).toContain("complete -c keeper");
  });
});

describe("keeper complete responder candidates", () => {
  test("top-level TAB suggests every public subcommand", async () => {
    const values = candidateValues(await completionResponder([""], VERSION));
    for (const name of SUBCOMMANDS) {
      expect(values).toContain(name);
    }
  });

  test("top-level TAB never leaks the hidden responder token", async () => {
    const values = candidateValues(await completionResponder([""], VERSION));
    expect(values).not.toContain(COMPLETION_RESPONDER);
  });

  test("second-level TAB suggests the SUBCOMMAND_META verbs", async () => {
    const twoLevel = SUBCOMMANDS.filter(
      (name) => (SUBCOMMAND_META[name].verbs?.length ?? 0) > 0,
    );
    // Guards against a future refactor that drops verb metadata entirely.
    expect(twoLevel.length).toBeGreaterThan(0);
    for (const name of twoLevel) {
      const values = candidateValues(
        await completionResponder([name, ""], VERSION),
      );
      for (const verb of SUBCOMMAND_META[name].verbs ?? []) {
        expect(values).toContain(verb);
      }
    }
  });
});

describe("completions are generated from the descriptor tree (ADR 0008)", () => {
  test("top-level TAB suggests exactly the dispatchable native surface", async () => {
    // The candidate set is the descriptor's command names (minus the hidden
    // responder, plus `completions` which the plugin registers itself).
    const values = candidateValues(await completionResponder([""], VERSION));
    for (const cmd of NATIVE_COMMANDS) {
      expect(values).toContain(cmd.name);
    }
  });

  test("second-level TAB enumerates a descriptor command's verbs", async () => {
    const twoLevel = NATIVE_COMMANDS.filter((c) => (c.verbs?.length ?? 0) > 0);
    expect(twoLevel.length).toBeGreaterThan(0);
    for (const cmd of twoLevel) {
      const values = candidateValues(
        await completionResponder([cmd.name, ""], VERSION),
      );
      for (const verb of cmd.verbs ?? []) {
        expect(values).toContain(verb.name);
      }
    }
  });
});

describe("keeper --help --json completion surface", () => {
  test("lists completions with a summary", () => {
    const index = buildHelpIndex();
    const entry = index.subcommands.find((s) => s.name === "completions");
    expect(entry).toBeDefined();
    expect((entry as { summary: string }).summary.length).toBeGreaterThan(0);
  });

  test("excludes the hidden complete responder", () => {
    const index = buildHelpIndex();
    const names = index.subcommands.map((s) => String(s.name));
    expect(names).not.toContain(COMPLETION_RESPONDER);
  });
});

describe("isCompletionShell", () => {
  test("accepts the supported shells and rejects powershell/unknowns", () => {
    for (const shell of COMPLETION_SHELLS)
      expect(isCompletionShell(shell)).toBe(true);
    expect(isCompletionShell("powershell")).toBe(false);
    expect(isCompletionShell("")).toBe(false);
  });
});

/** Capture the {stdout, stderr, exit} an io-driven command produces. `exit`
 *  throws a tagged error so a never-returning branch stops the call. */
class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      exit: (code: number): never => {
        throw new ExitError(code);
      },
      version: VERSION,
    },
  };
}

describe("runCompletionsCommand", () => {
  for (const shell of COMPLETION_SHELLS) {
    test(`${shell}: writes the script to stdout, no exit`, async () => {
      const h = makeIo();
      await runCompletionsCommand([shell as CompletionShell], h.io);
      expect(h.out.join("").length).toBeGreaterThan(0);
      expect(h.err).toEqual([]);
    });
  }

  test("missing shell is an arg fault (exit 2)", async () => {
    const h = makeIo();
    let caught: unknown;
    try {
      await runCompletionsCommand([], h.io);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(2);
    expect(h.err.join("")).toContain(COMPLETION_SHELLS.join("|"));
    expect(h.out).toEqual([]);
  });

  test("unknown shell (powershell) is an arg fault (exit 2)", async () => {
    const h = makeIo();
    let caught: unknown;
    try {
      await runCompletionsCommand(["powershell"], h.io);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(2);
    expect(h.err.join("")).toContain("powershell");
    expect(h.out).toEqual([]);
  });
});

describe("dispatch routes the hidden complete responder", () => {
  interface Harness {
    stdout: string[];
    stderr: string[];
    calls: Array<{ sub: Subcommand; argv: string[] }>;
    deps: DispatchDeps;
  }

  function makeHarness(): Harness {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const calls: Array<{ sub: Subcommand; argv: string[] }> = [];
    const handler =
      (sub: Subcommand) =>
      (argv: string[]): void => {
        calls.push({ sub, argv });
      };
    const handlers = Object.fromEntries(
      SUBCOMMANDS.map((name) => [name, handler(name)]),
    ) as Record<Subcommand, (argv: string[]) => void>;
    const deps: DispatchDeps = {
      handlers,
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
      exit: (code) => {
        throw new ExitError(code);
      },
      version: VERSION,
    };
    return { stdout, stderr, calls, deps };
  }

  test("`keeper complete -- <TAB>` emits candidates on stdout, exit 0, no handler", async () => {
    const h = makeHarness();
    let caught: unknown;
    try {
      await dispatch([COMPLETION_RESPONDER, "--", ""], h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(0);
    const values = candidateValues(h.stdout.join(""));
    expect(values).toContain("board");
    expect(values).toContain("plan");
    // Routed by an internal seam, not as a subcommand handler.
    expect(h.calls).toEqual([]);
    expect(h.stderr).toEqual([]);
  });

  test("`keeper complete -- plan <TAB>` emits the plan verbs", async () => {
    const h = makeHarness();
    try {
      await dispatch([COMPLETION_RESPONDER, "--", "plan", ""], h.deps);
    } catch {
      /* swallow ExitError */
    }
    const values = candidateValues(h.stdout.join(""));
    for (const verb of SUBCOMMAND_META.plan.verbs ?? []) {
      expect(values).toContain(verb);
    }
  });
});
