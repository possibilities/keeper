/**
 * The startup verbosity ladder (src/main.ts): level 0 (default) is silent before
 * claude is exec'd; level 1 (--x-verbose) prints one line per startup
 * section plus milestone markers (account route, session); level 2
 * (--x-very-verbose, implying level 1) adds the full action log + composed
 * command dump. All three still spawn claude; assertions read the captured
 * stdout sink. `--x-no-confirm` keeps the interactive path while skipping
 * the cwd-confirm prompt so section lines surface.
 */

import { describe, expect, test } from "bun:test";
import { main } from "../src/agent/main";
import { makeHarness, runAndCapture } from "./helpers/agent-main-harness";

function harness(argv: string[]) {
  return makeHarness({
    argv,
  });
}

describe("startup verbosity", () => {
  test("default is silent before launch", async () => {
    const h = harness(["--x-no-confirm"]);
    await runAndCapture(h, main);
    expect(h.out.join("")).toBe("");
  });

  test("--x-verbose prints section + milestone lines, no dump", async () => {
    const h = harness(["--x-verbose", "--x-no-confirm"]);
    await runAndCapture(h, main);
    const out = h.out.join("");
    expect(out).toContain("~ ensure shared Claude state\n");
    expect(out).toContain("~ discover plugin dirs\n");
    expect(out).toContain("~ route: default\n");
    expect(out).toContain("~ session: ");
    expect(out).toContain("~ launching claude\n");
    expect(out).not.toContain("Actions:");
    expect(out).not.toContain("Command:");
  });

  test("--x-very-verbose adds the action log + command dump", async () => {
    const h = harness(["--x-very-verbose", "--x-no-confirm"]);
    await runAndCapture(h, main);
    const out = h.out.join("");
    // section lines still present (level 2 implies level 1)
    expect(out).toContain("~ ensure shared Claude state\n");
    expect(out).toContain("~ launching claude\n");
    // plus the noisy dump
    expect(out).toContain("Actions:\n");
    expect(out).toContain("Command:\n");
  });

  test("--print stays clean even at --x-verbose", async () => {
    const h = harness(["--print", "--x-verbose"]);
    await runAndCapture(h, main);
    expect(h.out.join("")).toBe("");
  });
});
