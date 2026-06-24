/**
 * Session-slug resolution: slug-shortcut (slash command + one slug token),
 * agent-name single-token (`<ns>:<agent>` + single token → `{token}-{agent}`),
 * and the trailing-prompt extraction guards. Ports the Python naming cases.
 */

import { describe, expect, test } from "bun:test";
import {
  extractPromptText,
  resolveSessionSlug,
  resolveSlugShortcut,
} from "../src/agent/session-name";

describe("resolveSlugShortcut", () => {
  test("slash command + one slug token returns the slug", () => {
    expect(resolveSlugShortcut("/work fn-53")).toBe("fn-53");
    expect(resolveSlugShortcut("/plan add-oauth")).toBe("add-oauth");
    expect(resolveSlugShortcut("/work fn-53.2")).toBe("fn-53.2");
  });
  test("not a slash command → null", () => {
    expect(resolveSlugShortcut("work fn-53")).toBeNull();
  });
  test("more than one trailing token → null", () => {
    expect(resolveSlugShortcut("/work fn-53 extra")).toBeNull();
  });
  test("a single-segment token is not a slug → null", () => {
    expect(resolveSlugShortcut("/work foo")).toBeNull();
  });
});

describe("resolveSessionSlug", () => {
  test("slug-shortcut branch fires first", () => {
    expect(resolveSessionSlug("/work fn-53")).toBe("fn-53");
  });
  test("agent-name single-token branch", () => {
    expect(resolveSessionSlug("hello", "work:reviewer")).toBe("hello-reviewer");
  });
  test("agent-name with a multi-token prompt does not fire", () => {
    expect(resolveSessionSlug("hello there", "work:reviewer")).toBeNull();
  });
  test("agent-name strips a leading slash command before single-token check", () => {
    expect(resolveSessionSlug("/foo hello", "work:reviewer")).toBe(
      "hello-reviewer",
    );
  });
  test("empty prompt → null", () => {
    expect(resolveSessionSlug("")).toBeNull();
    expect(resolveSessionSlug("   ")).toBeNull();
  });
  test("no current name and no slug → null", () => {
    expect(resolveSessionSlug("hello")).toBeNull();
  });
});

describe("extractPromptText", () => {
  test("trailing non-flag token after a positional is the prompt", () => {
    expect(extractPromptText(["foo", "hello"])).toBe("hello");
  });
  test("a flag-shaped last token is not a prompt", () => {
    expect(extractPromptText(["hello", "--print"])).toBeNull();
  });
  test("token following a split long option is treated as its value, not a prompt", () => {
    // Python guards: a `--xxx` second-to-last (no `=`) means the last token is
    // that option's value, so there is no trailing prompt.
    expect(extractPromptText(["--resume", "hello"])).toBeNull();
    expect(extractPromptText(["--model", "opus"])).toBeNull();
  });
  test("joined long option preceding the token does not block it", () => {
    expect(extractPromptText(["--model=opus", "hello"])).toBe("hello");
  });
  test("empty args → null", () => {
    expect(extractPromptText([])).toBeNull();
  });
  test("a single bare token is the prompt", () => {
    expect(extractPromptText(["hello"])).toBe("hello");
  });
});
