/**
 * Launcher flag-parse pins: the consumed `--agentwrap-*` flags are stripped from
 * the residual argv, value forms (split / joined) both resolve, the launch-mode
 * signals (continue/resume/fork/print) fire, and passthrough tokens survive
 * verbatim. Only the canonical `--agentwrap-*` spelling is consumed; any other
 * token (including a retired `--arthack-*` flag) falls through to remainingArgs.
 */

import { describe, expect, test } from "bun:test";
import {
  normalizeAgentwrapProfileArg,
  parseArgs,
  parseArgsForAgent,
} from "../src/agent/args";

describe("normalizeAgentwrapProfileArg", () => {
  test("'default' maps to empty (native account)", () => {
    expect(normalizeAgentwrapProfileArg("default")).toBe("");
  });
  test("whitespace is trimmed", () => {
    expect(normalizeAgentwrapProfileArg("  work  ")).toBe("work");
  });
  test("a named profile passes through", () => {
    expect(normalizeAgentwrapProfileArg("work")).toBe("work");
  });
});

describe("parseArgs", () => {
  test("strips agentwrap flags, keeps the rest in order", () => {
    const p = parseArgs([
      "--agentwrap-verbose",
      "--resume",
      "--agentwrap-no-confirm",
      "hello",
    ]);
    expect(p.agentwrapVerbose).toBe(true);
    expect(p.agentwrapNoConfirm).toBe(true);
    expect(p.remainingArgs).toEqual(["--resume", "hello"]);
  });

  test("--agentwrap-very-verbose is a bare bool, stripped", () => {
    const p = parseArgs(["--agentwrap-very-verbose", "hi"]);
    expect(p.agentwrapVeryVerbose).toBe(true);
    expect(p.agentwrapVerbose).toBe(false);
    expect(p.remainingArgs).toEqual(["hi"]);
  });

  test("verbose flags default to false", () => {
    const p = parseArgs(["hi"]);
    expect(p.agentwrapVerbose).toBe(false);
    expect(p.agentwrapVeryVerbose).toBe(false);
  });

  test("--agentwrap-profile split form", () => {
    const p = parseArgs(["--agentwrap-profile", "work", "hi"]);
    expect(p.agentwrapProfile).toBe("work");
    expect(p.explicitAgentwrapProfile).toBe(true);
    expect(p.remainingArgs).toEqual(["hi"]);
  });

  test("--agentwrap-profile=joined form", () => {
    const p = parseArgs(["--agentwrap-profile=work", "hi"]);
    expect(p.agentwrapProfile).toBe("work");
    expect(p.explicitAgentwrapProfile).toBe(true);
    expect(p.remainingArgs).toEqual(["hi"]);
  });

  test("default profile is 'auto' when unset", () => {
    const p = parseArgs(["hi"]);
    expect(p.agentwrapProfile).toBe("auto");
    expect(p.explicitAgentwrapProfile).toBe(false);
  });

  test("--continue / -c / -r / --resume set continuation", () => {
    for (const flag of ["--continue", "-c", "-r", "--resume"]) {
      expect(parseArgs([flag]).hasContinueOrResume).toBe(true);
    }
  });

  test("--fork-session sets both continuation and fork", () => {
    const p = parseArgs(["--fork-session"]);
    expect(p.hasContinueOrResume).toBe(true);
    expect(p.hasForkSession).toBe(true);
  });

  test("--print / -p set headless", () => {
    expect(parseArgs(["--print"]).hasPrint).toBe(true);
    expect(parseArgs(["-p"]).hasPrint).toBe(true);
  });

  test("pi session and headless flags are detected", () => {
    expect(
      parseArgsForAgent(["--session", "abc"], "pi").hasContinueOrResume,
    ).toBe(true);
    const fork = parseArgsForAgent(["--fork", "abc"], "pi");
    expect(fork.hasContinueOrResume).toBe(true);
    expect(fork.hasForkSession).toBe(true);
    expect(parseArgsForAgent(["--print"], "pi").hasPrint).toBe(true);
    expect(parseArgsForAgent(["--mode", "json"], "pi").hasPrint).toBe(true);
  });

  test("a value that follows --agentwrap-profile is consumed, not passed through", () => {
    // The token after a bare --agentwrap-profile is the value even if flag-shaped
    // is NOT special-cased — the very next token is consumed verbatim.
    const p = parseArgs(["--agentwrap-profile", "work"]);
    expect(p.agentwrapProfile).toBe("work");
    expect(p.remainingArgs).toEqual([]);
  });

  test("--agentwrap-preset split form is consumed and stripped", () => {
    const p = parseArgs(["--agentwrap-preset", "claude-opus-xhigh", "hi"]);
    expect(p.agentwrapPreset).toBe("claude-opus-xhigh");
    expect(p.remainingArgs).toEqual(["hi"]);
  });

  test("--agentwrap-preset=joined form is consumed and stripped", () => {
    const p = parseArgs(["--agentwrap-preset=codex-gpt55-high", "hi"]);
    expect(p.agentwrapPreset).toBe("codex-gpt55-high");
    expect(p.remainingArgs).toEqual(["hi"]);
  });

  test("--agentwrap-preset defaults to null (no auto)", () => {
    expect(parseArgs(["hi"]).agentwrapPreset).toBeNull();
  });

  test("--agentwrap-help is dispatch-owned, not a parser-consumed flag", () => {
    // main() short-circuits --agentwrap-help before parseArgs ever runs; the
    // parser sets no launch-mode signal for it and treats it like any unknown
    // token (forwarded verbatim), so it can never silently rewrite the argv.
    const p = parseArgs(["--agentwrap-help"]);
    expect(p.agentwrapVerbose).toBe(false);
    expect(p.agentwrapNoConfirm).toBe(false);
    expect(p.remainingArgs).toEqual(["--agentwrap-help"]);
  });
});

// CONTRACT (.4) removed the legacy `--arthack-*` alias: a retired flag is no
// longer consumed and falls through to the claude argv like any unknown token.
describe("parseArgs retired --arthack-* flags fall through", () => {
  test("a retired --arthack-* flag is not consumed, passes through verbatim", () => {
    const p = parseArgs([
      "--arthack-verbose",
      "--arthack-no-confirm",
      "--arthack-profile",
      "work",
      "hello",
    ]);
    // None of the launch-mode signals fired — the launcher ignores these.
    expect(p.agentwrapVerbose).toBe(false);
    expect(p.agentwrapNoConfirm).toBe(false);
    expect(p.explicitAgentwrapProfile).toBe(false);
    expect(p.agentwrapProfile).toBe("auto");
    // Every token (flag + would-be value) lands in the claude argv unchanged.
    expect(p.remainingArgs).toEqual([
      "--arthack-verbose",
      "--arthack-no-confirm",
      "--arthack-profile",
      "work",
      "hello",
    ]);
  });
});
