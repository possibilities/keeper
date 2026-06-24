/**
 * The startup verbosity ladder (src/main.ts): level 0 (default) is silent before
 * claude is exec'd; level 1 (--agentwrap-verbose) prints one line per startup
 * section plus milestone markers (profile, prompts, session); level 2
 * (--agentwrap-very-verbose, implying level 1) adds the full action log + composed
 * command dump. All three still spawn claude; assertions read the captured
 * stdout sink. `--agentwrap-no-confirm` keeps the interactive path while skipping
 * the cwd-confirm prompt so section lines surface.
 */

import { describe, expect, test } from "bun:test";
import { main } from "../src/agent/main";
import { makeHarness, runAndCapture } from "./helpers/agent-main-harness";

function harness(argv: string[]) {
  return makeHarness({
    argv,
    listProfiles: () => ["default"],
    pickProfile: () => "default",
  });
}

describe("startup verbosity", () => {
  test("default is silent before launch", async () => {
    const h = harness(["--agentwrap-no-confirm"]);
    await runAndCapture(h, main);
    expect(h.out.join("")).toBe("");
  });

  test("--agentwrap-verbose prints section + milestone lines, no dump", async () => {
    const h = harness(["--agentwrap-verbose", "--agentwrap-no-confirm"]);
    await runAndCapture(h, main);
    const out = h.out.join("");
    expect(out).toContain("~ ensure shared Claude state\n");
    expect(out).toContain("~ discover plugin dirs\n");
    expect(out).toContain("~ profile: default\n");
    expect(out).toContain("~ session: ");
    expect(out).toContain("~ launching claude\n");
    expect(out).not.toContain("Actions:");
    expect(out).not.toContain("Command:");
  });

  test("--agentwrap-very-verbose adds the action log + command dump", async () => {
    const h = harness(["--agentwrap-very-verbose", "--agentwrap-no-confirm"]);
    await runAndCapture(h, main);
    const out = h.out.join("");
    // section lines still present (level 2 implies level 1)
    expect(out).toContain("~ ensure shared Claude state\n");
    expect(out).toContain("~ launching claude\n");
    // plus the noisy dump
    expect(out).toContain("Actions:\n");
    expect(out).toContain("Command:\n");
  });

  test("--print stays clean even at --agentwrap-verbose", async () => {
    const h = harness(["--print", "--agentwrap-verbose"]);
    await runAndCapture(h, main);
    expect(h.out.join("")).toBe("");
  });
});
