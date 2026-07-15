import { describe, expect, test } from "bun:test";
import { applyDispatchPromptPrefix } from "../src/prompt-prefix";

describe("applyDispatchPromptPrefix", () => {
  test("returns the prompt unchanged when the prefix is absent", () => {
    for (const harness of [undefined, "pi", "claude", "codex"]) {
      expect(
        applyDispatchPromptPrefix(undefined, "  prompt\nbytes  ", harness),
      ).toBe("  prompt\nbytes  ");
    }
  });

  test("preserves byte-for-byte prefix composition outside Pi", () => {
    for (const harness of [undefined, "claude", "codex"]) {
      expect(applyDispatchPromptPrefix("/hack", "do it", harness)).toBe(
        "/hack do it",
      );
      expect(
        applyDispatchPromptPrefix("/hack\t extra  ", "\nprompt", harness),
      ).toBe("/hack\t extra   \nprompt");
    }
  });

  test("normalizes a Pi slash-name token into a skill command", () => {
    expect(applyDispatchPromptPrefix("/hack", "do it", "pi")).toBe(
      "/skill:hack do it",
    );
  });

  test("preserves suffix text and whitespace after the first Pi prefix token", () => {
    expect(applyDispatchPromptPrefix("/hack extra", "do it", "pi")).toBe(
      "/skill:hack extra do it",
    );
    expect(
      applyDispatchPromptPrefix(" \t/hack\t  extra\ncontext  ", "prompt", "pi"),
    ).toBe(" \t/skill:hack\t  extra\ncontext   prompt");
  });

  test("leaves an existing Pi skill command unchanged", () => {
    expect(applyDispatchPromptPrefix("/skill:hack", "do it", "pi")).toBe(
      "/skill:hack do it",
    );
  });

  test("leaves slash paths and non-slash Pi prefixes unchanged", () => {
    for (const prefix of ["/hack/path", "/hack/", "//hack", "hack extra"]) {
      expect(applyDispatchPromptPrefix(prefix, "do it", "pi")).toBe(
        `${prefix} do it`,
      );
    }
  });
});
