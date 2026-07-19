import { describe, expect, test } from "bun:test";
import { parseArgs, parseArgsForAgent } from "../src/agent/args";

describe("parseArgs", () => {
  test("strips supported keeper flags and preserves order", () => {
    const parsed = parseArgs([
      "--x-verbose",
      "--resume",
      "--x-no-confirm",
      "hello",
    ]);
    expect(parsed.launcherVerbose).toBe(true);
    expect(parsed.launcherNoConfirm).toBe(true);
    expect(parsed.remainingArgs).toEqual(["--resume", "hello"]);
  });

  test("very-verbose and defaults", () => {
    const parsed = parseArgs(["--x-very-verbose", "hi"]);
    expect(parsed.launcherVeryVerbose).toBe(true);
    expect(parsed.launcherVerbose).toBe(false);
    expect(parseArgs(["hi"]).launcherVeryVerbose).toBe(false);
  });

  test("Claude continuation, fork, and print signals", () => {
    for (const flag of ["--continue", "-c", "-r", "--resume"]) {
      expect(parseArgs([flag]).hasContinueOrResume).toBe(true);
    }
    const fork = parseArgs(["--fork-session"]);
    expect(fork.hasContinueOrResume).toBe(true);
    expect(fork.hasForkSession).toBe(true);
    expect(parseArgs(["--print"]).hasPrint).toBe(true);
    expect(parseArgs(["-p"]).hasPrint).toBe(true);
  });

  test("Pi continuation, fork, and headless signals", () => {
    expect(
      parseArgsForAgent(["--session", "abc"], "pi").hasContinueOrResume,
    ).toBe(true);
    const fork = parseArgsForAgent(["--fork", "abc"], "pi");
    expect(fork.hasContinueOrResume).toBe(true);
    expect(fork.hasForkSession).toBe(true);
    expect(parseArgsForAgent(["--print"], "pi").hasPrint).toBe(true);
    expect(parseArgsForAgent(["--mode", "json"], "pi").hasPrint).toBe(true);
  });

  test("preset split and joined forms are consumed", () => {
    const split = parseArgs(["--x-preset", "claude::opus::high", "hi"]);
    expect(split.launcherPreset).toBe("claude::opus::high");
    expect(split.remainingArgs).toEqual(["hi"]);
    const joined = parseArgs([
      "--x-preset=pi::openai-codex/gpt-5.4::high",
      "hi",
    ]);
    expect(joined.launcherPreset).toBe("pi::openai-codex/gpt-5.4::high");
    expect(joined.remainingArgs).toEqual(["hi"]);
    expect(parseArgs(["hi"]).launcherPreset).toBeNull();
  });

  test("account selector accepts canonical cN and numeric zero-based forms", () => {
    const split = parseArgs(["--x-account", "c2", "hello"]);
    expect(split.launcherAccountOrdinal).toBe(2);
    expect(split.launcherAccountError).toBeNull();
    expect(split.remainingArgs).toEqual(["hello"]);

    const joined = parseArgs(["--x-account=0", "hello"]);
    expect(joined.launcherAccountOrdinal).toBe(0);
    expect(joined.launcherAccountError).toBeNull();
    expect(joined.remainingArgs).toEqual(["hello"]);
    expect(parseArgs(["hello"]).launcherAccountOrdinal).toBeNull();
  });

  test("account selector rejects invalid, missing, overflow, and Pi values", () => {
    for (const value of ["", "c", "c-1", "01", "c01", "default", "1.5"]) {
      const parsed = parseArgs([`--x-account=${value}`, "hello"]);
      expect(parsed.launcherAccountOrdinal).toBeNull();
      expect(parsed.launcherAccountError).toContain("zero-based");
      expect(parsed.remainingArgs).toEqual(["hello"]);
    }
    expect(
      parseArgs([`--x-account=${Number.MAX_SAFE_INTEGER + 1}`])
        .launcherAccountError,
    ).toContain("zero-based");
    expect(parseArgs(["--x-account"]).launcherAccountError).toContain(
      "zero-based",
    );
    expect(
      parseArgsForAgent(["--x-account", "c1", "hello"], "pi")
        .launcherAccountError,
    ).toContain("only valid for Claude");
  });

  test("account selector is last-wins", () => {
    const parsed = parseArgs(["--x-account=bad", "--x-account", "c3", "hello"]);
    expect(parsed.launcherAccountOrdinal).toBe(3);
    expect(parsed.launcherAccountError).toBeNull();
  });

  test("Fable intent lineage carrier is consumed only for Claude", () => {
    const inherited = parseArgs(["--x-fable-intent=1", "--resume", "abc"]);
    expect(inherited.launcherFableIntent).toBe(true);
    expect(inherited.launcherFableIntentError).toBeNull();
    expect(inherited.remainingArgs).toEqual(["--resume", "abc"]);
    expect(parseArgs(["--x-fable-intent=0"]).launcherFableIntent).toBe(false);
    expect(
      parseArgsForAgent(["--x-fable-intent=1"], "pi").launcherFableIntentError,
    ).toContain("only valid for Claude");
    expect(
      parseArgs(["--x-fable-intent=maybe"]).launcherFableIntentError,
    ).toContain("expects 0 or 1");
  });

  test("legacy profile selection is an inert compatibility flag", () => {
    const split = parseArgs([
      "--x-profile",
      "work",
      "--x-codex-session-name=old",
      "hello",
    ]);
    expect(split.remainingArgs).toEqual([
      "--x-codex-session-name=old",
      "hello",
    ]);
    expect(parseArgs(["--x-profile=work", "hello"]).remainingArgs).toEqual([
      "hello",
    ]);
  });

  test("unknown wrapper and retired arthack flags pass through", () => {
    const parsed = parseArgs([
      "--x-help",
      "--arthack-verbose",
      "--arthack-profile",
      "work",
    ]);
    expect(parsed.launcherVerbose).toBe(false);
    expect(parsed.remainingArgs).toEqual([
      "--x-help",
      "--arthack-verbose",
      "--arthack-profile",
      "work",
    ]);
  });
});
