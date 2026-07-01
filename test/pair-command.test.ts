/**
 * Unit tests for the pair-ONLY symbols of `src/pair-command.ts`: prompt assembly
 * (directive + role + message ordering), the `--timeout`→ms stop budget, the
 * output-YAML assembly, and the default session name. The SHARED launch cluster
 * (argv builder, native flag sets, env strip, role resolver) is tested in
 * `test/agent-launch-config.test.ts`.
 */

import { expect, test } from "bun:test";
import { READ_ONLY_DIRECTIVE } from "../src/agent/launch-config";
import {
  assemblePrompt,
  buildPairOutput,
  DEFAULT_PAIR_SESSION,
  stopTimeoutMsFromSeconds,
} from "../src/pair-command";

// ---------------------------------------------------------------------------
// prompt assembly
// ---------------------------------------------------------------------------

test("assemblePrompt: orders directive (read-only) → system → user", () => {
  const out = assemblePrompt({
    message: "do the thing",
    systemPrompt: "be helpful",
    readOnly: true,
  });
  const idxDirective = out.indexOf(READ_ONLY_DIRECTIVE);
  const idxSystem = out.indexOf("System: be helpful");
  const idxUser = out.indexOf("User: do the thing");
  expect(idxDirective).toBe(0);
  expect(idxSystem).toBeGreaterThan(idxDirective);
  expect(idxUser).toBeGreaterThan(idxSystem);
});

test("assemblePrompt: omits the directive when not read-only", () => {
  const out = assemblePrompt({
    message: "m",
    systemPrompt: "s",
    readOnly: false,
  });
  expect(out).not.toContain(READ_ONLY_DIRECTIVE);
  expect(out).toBe("System: s\n\nUser: m");
});

test("assemblePrompt: omits the System block when systemPrompt is empty", () => {
  const out = assemblePrompt({
    message: "m",
    systemPrompt: "",
    readOnly: false,
  });
  expect(out).toBe("User: m");
});

// ---------------------------------------------------------------------------
// stop-wait budget
// ---------------------------------------------------------------------------

test("stopTimeoutMsFromSeconds: integer seconds → exact ms", () => {
  expect(stopTimeoutMsFromSeconds(1800)).toBe(1_800_000);
  expect(stopTimeoutMsFromSeconds(1)).toBe(1000);
});

test("stopTimeoutMsFromSeconds: fractional seconds round UP to ms", () => {
  expect(stopTimeoutMsFromSeconds(0.5)).toBe(500);
  expect(stopTimeoutMsFromSeconds(1.0009)).toBe(1001);
  expect(stopTimeoutMsFromSeconds(599.9999)).toBe(600_000);
});

// ---------------------------------------------------------------------------
// output assembly
// ---------------------------------------------------------------------------

test("buildPairOutput: carries message + cli/role + handle drill-down", () => {
  const out = buildPairOutput({
    cli: "claude",
    role: "default",
    message: "answer text",
    transcriptPath: "/t/x.jsonl",
    handle: "tmux-h",
    elapsedSeconds: 12.34,
  });
  expect(out.message).toBe("answer text");
  expect(out.cli).toBe("claude");
  expect(out.role).toBe("default");
  expect(out.handle).toBe("tmux-h");
  expect(out.transcript_path).toBe("/t/x.jsonl");
  expect(out.elapsed_seconds).toBe(12.3);
  // The read-only YAML surface is retired — no read_only / changed_files keys.
  expect(out.read_only).toBeUndefined();
  expect(out.changed_files).toBeUndefined();
  expect(out.read_only_violation).toBeUndefined();
});

test("buildPairOutput: null message serializes to an empty string message", () => {
  const out = buildPairOutput({
    cli: "claude",
    role: "default",
    message: null,
    transcriptPath: null,
    handle: "h",
  });
  expect(out.message).toBe("");
});

// ---------------------------------------------------------------------------
// tmux session naming
// ---------------------------------------------------------------------------

test("DEFAULT_PAIR_SESSION is the stable 'pair' session name", () => {
  expect(DEFAULT_PAIR_SESSION).toBe("pair");
});
