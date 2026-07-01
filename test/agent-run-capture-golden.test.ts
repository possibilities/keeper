/**
 * Characterization golden pins for the PURE pair/agent builders the later
 * pair->agent flattening increments (repoint pair, posture flags, panel
 * collapse) will move. Each assertion locks the exact current output so a
 * mechanical refactor that drifts the composed command, the `--output` YAML, or
 * the Monitor event lines fails loudly.
 *
 * Every target here is a pure builder — no subprocess/tmux/git is touched (per
 * CLAUDE.md test isolation). The cross-process `cli/pair.ts` flow is NOT exercised
 * end-to-end; only its private Monitor-line formatter is mirrored and pinned.
 */

import { describe, expect, test } from "bun:test";
import {
  buildPairLaunchArgv,
  buildPairOutput,
  pairOutputYaml,
  stopTimeoutMsFromSeconds,
} from "../src/pair-command";

const PREFIX = [
  "/fake-home/.bun/bin/bun",
  "/fake-home/code/keeper/cli/keeper.ts",
  "agent",
] as const;

describe("golden: buildPairLaunchArgv", () => {
  test("claude write-mode launch (model + session, no preset)", () => {
    expect(
      buildPairLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "claude",
        prompt: "do the thing",
        model: "opus",
        session: "pair",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "claude",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--x-tmux-session",
      "pair",
      "--x-tmux-env",
      "KEEPER_TMUX_SESSION=pair",
      "--permission-mode",
      "acceptEdits",
      "--dangerously-skip-permissions",
      "--model",
      "opus",
      "do the thing",
    ]);
  });

  test("claude read-only launch (preset, no session) — posture-independent flags (no strip)", () => {
    expect(
      buildPairLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "claude",
        prompt: "explore",
        preset: "reviewer",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "claude",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--x-preset",
      "reviewer",
      "--permission-mode",
      "acceptEdits",
      "--dangerously-skip-permissions",
      "explore",
    ]);
  });

  test("codex read-only launch (model + effort + session) — keeps write flags", () => {
    expect(
      buildPairLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "codex",
        prompt: "review this",
        model: "gpt-5",
        effort: "high",
        session: "pair",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "codex",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--x-tmux-session",
      "pair",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-5",
      "-c",
      'model_reasoning_effort="high"',
      "review this",
    ]);
  });

  test("codex omits the claude-only KEEPER_TMUX_SESSION env carrier", () => {
    const argv = buildPairLaunchArgv({
      launcherArgvPrefix: PREFIX,
      cli: "codex",
      prompt: "p",
      session: "pair",
    });
    expect(argv).not.toContain("--x-tmux-env");
  });

  test("pi read-only launch (model + session) — posture-independent flags (no strip)", () => {
    expect(
      buildPairLaunchArgv({
        launcherArgvPrefix: PREFIX,
        cli: "pi",
        prompt: "scan",
        model: "pi-1",
        session: "pair",
      }),
    ).toEqual([
      "/fake-home/.bun/bin/bun",
      "/fake-home/code/keeper/cli/keeper.ts",
      "agent",
      "pi",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--x-tmux-session",
      "pair",
      "-na",
      "--model",
      "pi-1",
      "scan",
    ]);
  });
});

describe("golden: buildPairOutput + pairOutputYaml", () => {
  test("run: message + drill-down keys", () => {
    const out = buildPairOutput({
      cli: "claude",
      role: "default",
      message: "Here is the answer.",
      transcriptPath: "/transcripts/run-123.jsonl",
      handle: "run-123",
      elapsedSeconds: 12.34,
    });
    expect(out).toEqual({
      cli: "claude",
      role: "default",
      message: "Here is the answer.",
      elapsed_seconds: 12.3,
      handle: "run-123",
      transcript_path: "/transcripts/run-123.jsonl",
    });
    expect(pairOutputYaml(out)).toBe(
      "cli: claude\n" +
        "role: default\n" +
        "message: Here is the answer.\n" +
        "elapsed_seconds: 12.3\n" +
        "handle: run-123\n" +
        "transcript_path: /transcripts/run-123.jsonl\n",
    );
  });

  test("tool-only turn: null message renders as empty string, no read-only surface", () => {
    const out = buildPairOutput({
      cli: "codex",
      role: "codereviewer",
      message: null,
      transcriptPath: null,
      handle: "run-9",
    });
    expect(out).toEqual({
      cli: "codex",
      role: "codereviewer",
      message: "",
      handle: "run-9",
    });
    expect(pairOutputYaml(out)).toBe(
      "cli: codex\n" +
        "role: codereviewer\n" +
        "message: ''\n" +
        "handle: run-9\n",
    );
  });
});

/**
 * Mirror of `cli/pair.ts`'s private `emitEvent` formatter (it is not exported):
 * `[keeper-pair] <event>` then `key=value` for each field, skipping
 * undefined/null/empty, joined by a single space. Pinning the rendered lines
 * locks the two-line Monitor contract a regex consumer depends on.
 */
function formatEvent(event: string, fields: Record<string, unknown>): string {
  const parts = [`[keeper-pair] ${event}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") {
      continue;
    }
    parts.push(`${k}=${v}`);
  }
  return parts.join(" ");
}

describe("golden: [keeper-pair] Monitor event lines", () => {
  test("started line (write run drops the falsy read-only field)", () => {
    expect(
      formatEvent("started", {
        cli: "claude",
        preset: "reviewer",
        role: "default",
        output: "/out.yaml",
        "read-only": false || undefined,
        timeout: 1800,
      }),
    ).toBe(
      "[keeper-pair] started cli=claude preset=reviewer role=default output=/out.yaml timeout=1800",
    );
  });

  test("started line (read-only run renders read-only=true, empty preset dropped)", () => {
    expect(
      formatEvent("started", {
        cli: "codex",
        preset: "",
        role: "codereviewer",
        output: "/out.yaml",
        "read-only": true || undefined,
        timeout: 600,
      }),
    ).toBe(
      "[keeper-pair] started cli=codex role=codereviewer output=/out.yaml read-only=true timeout=600",
    );
  });

  test("completed line (elapsed, empty preset dropped)", () => {
    expect(
      formatEvent("completed", {
        cli: "codex",
        preset: "",
        output: "/out.yaml",
        "read-only": true || undefined,
        elapsed: 13,
      }),
    ).toBe(
      "[keeper-pair] completed cli=codex output=/out.yaml read-only=true elapsed=13",
    );
  });

  test("failed line (cli/output/error)", () => {
    expect(
      formatEvent("failed", {
        cli: "claude",
        output: "/out.yaml",
        error: "keeper agent wait-for-stop failed (spawn failed / killed)",
      }),
    ).toBe(
      "[keeper-pair] failed cli=claude output=/out.yaml error=keeper agent wait-for-stop failed (spawn failed / killed)",
    );
  });
});

describe("golden: stopTimeoutMsFromSeconds", () => {
  test("whole seconds scale to ms", () => {
    expect(stopTimeoutMsFromSeconds(1800)).toBe(1_800_000);
    expect(stopTimeoutMsFromSeconds(30)).toBe(30_000);
    expect(stopTimeoutMsFromSeconds(0)).toBe(0);
  });

  test("fractional seconds round UP to ms granularity", () => {
    expect(stopTimeoutMsFromSeconds(0.5)).toBe(500);
    expect(stopTimeoutMsFromSeconds(1.0005)).toBe(1001);
    expect(stopTimeoutMsFromSeconds(0.0001)).toBe(1);
  });
});
