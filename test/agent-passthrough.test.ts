/**
 * Passthrough-detection table: the subcommand scan must skip global options
 * (consuming required/optional values correctly) so a value spelling a
 * subcommand name is not mistaken for one, stop at `--`, and the effort/model
 * precedence helpers must honor explicit flags + env over the config default.
 * Ports the Python passthrough + precedence cases.
 */

import { describe, expect, test } from "bun:test";
import {
  findPassthroughCommand,
  hasExplicitEffortArg,
  hasExplicitModelArg,
  resolveStartupEffortOverride,
  resolveStartupModelOverride,
} from "../src/agent/passthrough";

describe("findPassthroughCommand", () => {
  test("bare subcommand is detected", () => {
    expect(findPassthroughCommand(["mcp"])).toBe("mcp");
    expect(findPassthroughCommand(["plugin", "list"])).toBe("plugin");
  });

  test("a prompt is not a subcommand", () => {
    expect(findPassthroughCommand(["hello world"])).toBeNull();
  });

  test("global option with required value is skipped", () => {
    expect(findPassthroughCommand(["--model", "opus", "mcp"])).toBe("mcp");
  });

  test("value spelling a subcommand name is not mistaken for one", () => {
    // --model mcp: 'mcp' is the model VALUE, not the subcommand.
    expect(findPassthroughCommand(["--model", "mcp"])).toBeNull();
  });

  test("joined option= consumes one token", () => {
    expect(findPassthroughCommand(["--model=opus", "mcp"])).toBe("mcp");
  });

  test("optional-value option consumes value only when value-shaped", () => {
    // --resume <id> mcp → id consumed, mcp is the subcommand.
    expect(findPassthroughCommand(["--resume", "abc123", "mcp"])).toBe("mcp");
    // --resume mcp → mcp is a subcommand, NOT the resume value (set guard).
    expect(findPassthroughCommand(["--resume", "mcp"])).toBe("mcp");
    // --resume then a flag → resume takes no value; flag continues the scan.
    expect(findPassthroughCommand(["--resume", "--print", "mcp"])).toBe("mcp");
  });

  test("a bare -- stops the scan", () => {
    expect(findPassthroughCommand(["--", "mcp"])).toBeNull();
  });

  test("a non-option non-subcommand first token returns null", () => {
    expect(findPassthroughCommand(["foo", "mcp"])).toBeNull();
  });
});

describe("effort precedence", () => {
  test("explicit --effort wins (override is null)", () => {
    expect(hasExplicitEffortArg(["--effort", "high"])).toBe(true);
    expect(
      resolveStartupEffortOverride(["--effort", "high"], "low", {}),
    ).toBeNull();
  });
  test("--effort= joined form is explicit", () => {
    expect(hasExplicitEffortArg(["--effort=high"])).toBe(true);
  });
  test("CLAUDE_CODE_EFFORT_LEVEL env wins over default", () => {
    expect(
      resolveStartupEffortOverride([], "low", {
        CLAUDE_CODE_EFFORT_LEVEL: "high",
      }),
    ).toBeNull();
  });
  test("config default applies when nothing explicit", () => {
    expect(resolveStartupEffortOverride([], "low", {})).toBe("low");
  });
  test("null default sends nothing", () => {
    expect(resolveStartupEffortOverride([], null, {})).toBeNull();
  });
  test("a -- stops the explicit scan", () => {
    expect(hasExplicitEffortArg(["--", "--effort", "high"])).toBe(false);
  });
});

describe("model precedence", () => {
  test("explicit --model wins (override is null)", () => {
    expect(hasExplicitModelArg(["--model", "opus"])).toBe(true);
    expect(
      resolveStartupModelOverride(["--model", "opus"], "sonnet"),
    ).toBeNull();
  });
  test("config default applies when nothing explicit", () => {
    expect(resolveStartupModelOverride([], "sonnet")).toBe("sonnet");
  });
  test("null default sends nothing", () => {
    expect(resolveStartupModelOverride([], null)).toBeNull();
  });
});
