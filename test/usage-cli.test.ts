import { describe, expect, test } from "bun:test";
import { nativeDescriptor } from "../cli/descriptor";
import { completionResponder, USAGE } from "../cli/keeper";
import { HELP, parseUsageResetArgs, runUsageCommand } from "../cli/usage";
import type {
  CodexResetLoopOptions,
  CodexUsageResetOutcome,
} from "../src/codex-usage-reset";

function outcome(kind: CodexUsageResetOutcome["kind"]): CodexUsageResetOutcome {
  return { kind, message: kind };
}

function harness(result = outcome("confirmed")) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: CodexResetLoopOptions[] = [];
  const abort = new AbortController();
  return {
    stdout,
    stderr,
    calls,
    abort,
    deps: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
      signal: abort.signal,
      runController: async (options: CodexResetLoopOptions) => {
        calls.push(options);
        return result;
      },
    },
  };
}

describe("keeper usage argument grammar", () => {
  test("applies defaults and accepts inclusive bounds", () => {
    expect(parseUsageResetArgs([])).toEqual({
      ok: true,
      options: { checkEveryMs: 30_000, notifyEveryPercent: 5 },
    });
    expect(
      parseUsageResetArgs(["--check-every", "5s", "--notify-every", "1"]),
    ).toEqual({
      ok: true,
      options: { checkEveryMs: 5_000, notifyEveryPercent: 1 },
    });
    expect(
      parseUsageResetArgs(["--check-every=5m", "--notify-every=100"]),
    ).toEqual({
      ok: true,
      options: { checkEveryMs: 300_000, notifyEveryPercent: 100 },
    });
  });

  test("rejects out-of-bounds, noninteger, and unexpected arguments", () => {
    for (const argv of [
      ["--check-every", "4999ms"],
      ["--check-every", "5m1s"],
      ["--notify-every", "0"],
      ["--notify-every", "101"],
      ["--notify-every", "2.5"],
      ["surprise"],
    ]) {
      expect(parseUsageResetArgs(argv).ok).toBe(false);
    }
  });
});

describe("keeper usage command dispatch", () => {
  test("bare and help show group help without running the controller", async () => {
    for (const argv of [[], ["--help"], ["help"]]) {
      const h = harness();
      expect(await runUsageCommand(argv, h.deps)).toBe(0);
      expect(h.stdout.join("")).toBe(HELP);
      expect(h.calls).toEqual([]);
    }
  });

  test("forwards parsed options to the reset controller", async () => {
    const h = harness();
    const code = await runUsageCommand(
      [
        "reset-codex-before-exceeding",
        "--check-every",
        "45s",
        "--notify-every",
        "7",
      ],
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ checkEveryMs: 45_000, notifyEveryPercent: 7 }]);
  });

  test("unknown verbs and extra arguments exit 2", async () => {
    for (const argv of [
      ["wat"],
      ["help", "extra"],
      ["reset-codex-before-exceeding", "extra"],
    ]) {
      const h = harness();
      expect(await runUsageCommand(argv, h.deps)).toBe(2);
      expect(h.calls).toEqual([]);
      expect(h.stderr.join("")).toContain("keeper usage:");
    }
  });

  test("maps confirmed to zero and ambiguous outcomes to one", async () => {
    expect(
      await runUsageCommand(
        ["reset-codex-before-exceeding"],
        harness(outcome("confirmed")).deps,
      ),
    ).toBe(0);
    expect(
      await runUsageCommand(
        ["reset-codex-before-exceeding"],
        harness(outcome("submitted-unconfirmed")).deps,
      ),
    ).toBe(1);
  });
});

describe("usage descriptor metadata", () => {
  test("publishes the verb, flags, no-daemon contract, and corrected top help", async () => {
    const descriptor = nativeDescriptor("usage");
    expect(descriptor?.requires_daemon).toBe(false);
    expect(descriptor?.verbs?.map((verb) => verb.name)).toEqual([
      "reset-codex-before-exceeding",
    ]);
    expect(descriptor?.verbs?.[0]?.flags.map((flag) => flag.name)).toEqual([
      "check-every",
      "notify-every",
      "help",
    ]);
    expect(USAGE).toContain("five snapshot-capable viewer subcommands");
    expect(USAGE).not.toContain("board/jobs/git/usage/autopilot/builds");
    expect(await completionResponder(["usage", ""], "test")).toContain(
      "reset-codex-before-exceeding",
    );
  });
});
