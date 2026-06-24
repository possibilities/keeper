/**
 * Byte-pin: the folded `keeper agent` launcher (`src/agent/main.ts`) must build
 * the SAME native argv the retired external `agentwrap` binary did. The fold
 * (fn-929) vendored agentwrap's 17 src modules verbatim, then will repoint every
 * keeper launch call site at the in-binary surface; this test is the contract
 * that proves byte-identity across that repoint — if a later mechanical change
 * drifts the composed agent command, these pins fail loudly.
 *
 * Drives `main()` through the recording harness with fully deterministic stubs
 * (fixed uuid, no profiles, null launcher defaults) so the composed argv is a
 * function only of the input flags. The pinned arrays are the exact native
 * commands agentwrap produced for the same inputs.
 */

import { describe, expect, test } from "bun:test";
import { main } from "../src/agent/main";
import { makeHarness, runAndCapture } from "./helpers/agent-main-harness";

const CLAUDE_BIN = "/fake-home/.local/bin/claude";
const CODEX_BIN = "/fake-home/bin/codex";
const PI_BIN = "/fake-home/.local/bin/pi";
const UUID = "11111111-1111-1111-1111-111111111111";

describe("keeper agent byte-pin — claude native argv", () => {
  test("bare prompt launch composes the pinned claude command", async () => {
    const h = makeHarness({
      argv: ["claude", "hello world"],
      rawArgv: true,
      randomUuid: () => UUID,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      CLAUDE_BIN,
      "hello world",
      "--strict-mcp-config",
      "--teammate-mode",
      "in-process",
      "--session-id",
      UUID,
      "--name",
      "proj-001",
    ]);
  });

  test("--continue keeps the persisted session (no id/name injected)", async () => {
    const h = makeHarness({
      argv: ["claude", "--continue"],
      rawArgv: true,
      randomUuid: () => UUID,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      CLAUDE_BIN,
      "--continue",
      "--strict-mcp-config",
      "--teammate-mode",
      "in-process",
    ]);
  });
});

describe("keeper agent byte-pin — codex native argv", () => {
  test("bare prompt launch composes the pinned codex command", async () => {
    const h = makeHarness({
      argv: ["codex", "hello"],
      rawArgv: true,
      randomUuid: () => UUID,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      CODEX_BIN,
      "--dangerously-bypass-approvals-and-sandbox",
      "--search",
      "hello",
    ]);
  });
});

describe("keeper agent byte-pin — pi native argv", () => {
  test("bare prompt launch composes the pinned pi command", async () => {
    const h = makeHarness({
      argv: ["pi", "hello"],
      rawArgv: true,
      randomUuid: () => UUID,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      PI_BIN,
      "hello",
      "--session-id",
      UUID,
      "--name",
      "proj-001",
    ]);
  });
});
