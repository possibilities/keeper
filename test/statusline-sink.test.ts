/**
 * `keeper statusline-sink` — the statusLine capture leaf-writer (fn-1024 task .2)
 * plus the launcher-side `--settings` injection that wires it onto every
 * keeper-agent claude launch.
 *
 * The sink is a pure, dependency-light function set (no DB, no socket, no
 * subprocess), so it is driven directly with captured payload strings + a
 * per-test tmpdir — no stdin plumbing. The injection is exercised through the
 * shared `main()` harness (the recording spawn), asserting the claude-only /
 * caller-wins / fail-open contract.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStatuslinePayload,
  resolveStatuslineDir,
  runSink,
  type StatuslineLeaf,
  sanitizeSessionToken,
} from "../cli/statusline-sink";
import {
  buildStatuslineCommand,
  buildStatuslineSettingsContent,
  ensureStatuslineSettingsFile,
  main,
} from "../src/agent/main";
import {
  flagValues,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "statusline-sink-"));
}

/** A realistic statusLine payload (the captured contract shape). */
function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "sess-abc",
    model: { id: "claude-opus-4-8", display_name: "Opus" },
    effort: { level: "high" },
    context_window: {
      used_percentage: 42.5,
      total_input_tokens: 85000,
      context_window_size: 200000,
    },
    ...overrides,
  });
}

describe("statusline-sink — parse", () => {
  test("extracts the full contract shape (raw session_id preserved)", () => {
    const leaf = parseStatuslinePayload(payload(), 1234);
    expect(leaf).toEqual({
      session_id: "sess-abc",
      model_id: "claude-opus-4-8",
      model_display: "Opus",
      effort: "high",
      context_used_percentage: 42.5,
      context_input_tokens: 85000,
      context_window_size: 200000,
      updated_at: 1234,
    });
  });

  test("absent effort.level degrades to null (not a failure)", () => {
    const leaf = parseStatuslinePayload(payload({ effort: {} }), 0);
    expect(leaf?.effort).toBeNull();
    expect(leaf?.model_id).toBe("claude-opus-4-8");
  });

  test("pre-first-call context (current_usage null, no percentage) → null fields", () => {
    const leaf = parseStatuslinePayload(
      payload({ context_window: { current_usage: null } }),
      0,
    );
    expect(leaf?.context_used_percentage).toBeNull();
    expect(leaf?.context_input_tokens).toBeNull();
    expect(leaf?.context_window_size).toBeNull();
  });

  test("no session_id → null (the fold's only match key)", () => {
    expect(parseStatuslinePayload(JSON.stringify({ model: {} }), 0)).toBeNull();
  });

  test("malformed / empty stdin → null (no throw)", () => {
    expect(parseStatuslinePayload("", 0)).toBeNull();
    expect(parseStatuslinePayload("{not json", 0)).toBeNull();
    expect(parseStatuslinePayload("[1,2,3]", 0)).toBeNull();
    expect(parseStatuslinePayload("null", 0)).toBeNull();
  });
});

describe("statusline-sink — coalesced atomic write", () => {
  test("first write lands the leaf atomically (no temp file left behind)", () => {
    const dir = tmpDir();
    const res = runSink(payload(), dir, 111);
    expect(res.wrote).toBe(true);
    expect(res.path).toBe(join(dir, "sess-abc.json"));
    expect(existsSync(res.path as string)).toBe(true);
    // No orphan temp file at render frequency.
    expect(readdirSync(dir)).toEqual(["sess-abc.json"]);
    const leaf = JSON.parse(
      readFileSync(res.path as string, "utf8"),
    ) as StatuslineLeaf;
    expect(leaf.session_id).toBe("sess-abc");
    expect(leaf.model_display).toBe("Opus");
  });

  test("unchanged render does NOT rewrite (coalesce — no event-log churn)", () => {
    const dir = tmpDir();
    expect(runSink(payload(), dir, 1).wrote).toBe(true);
    // Same {model, effort, bucket} + a sub-bucket % drift → no rewrite.
    expect(
      runSink(payload({ context_window: { used_percentage: 43.9 } }), dir, 2)
        .wrote,
    ).toBe(false);
    // The leaf still carries the FIRST write's updated_at (never rewritten).
    const leaf = JSON.parse(
      readFileSync(join(dir, "sess-abc.json"), "utf8"),
    ) as StatuslineLeaf;
    expect(leaf.updated_at).toBe(1);
  });

  test("crossing a context bucket rewrites", () => {
    const dir = tmpDir();
    expect(
      runSink(payload({ context_window: { used_percentage: 42 } }), dir, 1)
        .wrote,
    ).toBe(true);
    // 42 → bucket 8; 47 → bucket 9.
    expect(
      runSink(payload({ context_window: { used_percentage: 47 } }), dir, 2)
        .wrote,
    ).toBe(true);
  });

  test("a model or effort change rewrites", () => {
    const dir = tmpDir();
    expect(runSink(payload(), dir, 1).wrote).toBe(true);
    expect(runSink(payload({ effort: { level: "max" } }), dir, 2).wrote).toBe(
      true,
    );
    expect(
      runSink(
        payload({
          effort: { level: "max" },
          model: { id: "claude-sonnet-4-8", display_name: "Sonnet" },
        }),
        dir,
        3,
      ).wrote,
    ).toBe(true);
  });

  test("fail-open on unusable payloads (no write, no throw)", () => {
    const dir = tmpDir();
    expect(runSink("", dir, 0)).toEqual({ wrote: false, path: null });
    expect(runSink("{bad", dir, 0)).toEqual({ wrote: false, path: null });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("filename is sanitized but the raw session_id rides inside the leaf", () => {
    const dir = tmpDir();
    const raw = "S/1:2 space";
    const res = runSink(payload({ session_id: raw }), dir, 0);
    expect(res.wrote).toBe(true);
    expect(res.path).toBe(join(dir, `${sanitizeSessionToken(raw)}.json`));
    const leaf = JSON.parse(
      readFileSync(res.path as string, "utf8"),
    ) as StatuslineLeaf;
    expect(leaf.session_id).toBe(raw);
  });
});

describe("statusline-sink — dir resolution", () => {
  test("KEEPER_STATUSLINE_DIR override wins", () => {
    expect(resolveStatuslineDir({ KEEPER_STATUSLINE_DIR: "/x/y" })).toBe(
      "/x/y",
    );
  });

  test("defaults under the keeper state dir", () => {
    expect(resolveStatuslineDir({})).toMatch(
      /\.local\/state\/keeper\/statusline$/,
    );
  });
});

describe("statusline settings — command builder", () => {
  test("bash -c wrapper tees into the sink then pipes to the chain", () => {
    expect(buildStatuslineCommand("claudectl show-statusline")).toBe(
      "bash -c 'tee -i >(keeper statusline-sink) | claudectl show-statusline'",
    );
  });

  test("the chain is configurable", () => {
    expect(buildStatuslineCommand("my-renderer --x")).toContain(
      "| my-renderer --x'",
    );
  });

  test("settings file is a scalar statusLine command override", () => {
    const parsed = JSON.parse(
      buildStatuslineSettingsContent("claudectl show-statusline"),
    ) as { statusLine: { type: string; command: string } };
    expect(parsed.statusLine.type).toBe("command");
    expect(parsed.statusLine.command).toContain(
      "tee -i >(keeper statusline-sink)",
    );
  });

  test("ensureStatuslineSettingsFile writes the file, then is idempotent", () => {
    const dir = tmpDir();
    const path = ensureStatuslineSettingsFile(dir, {});
    expect(path).toBe(join(dir, "agent-statusline-settings.json"));
    const first = readFileSync(path as string, "utf8");
    expect(first).toContain("keeper statusline-sink");
    // No leftover temp file; re-running is a no-op that returns the same path.
    expect(readdirSync(dir)).toEqual(["agent-statusline-settings.json"]);
    expect(ensureStatuslineSettingsFile(dir, {})).toBe(path);
    expect(readFileSync(path as string, "utf8")).toBe(first);
  });

  test("KEEPER_STATUSLINE_CHAIN env overrides the rendered chain", () => {
    const dir = tmpDir();
    const path = ensureStatuslineSettingsFile(dir, {
      KEEPER_STATUSLINE_CHAIN: "custom-render",
    });
    expect(readFileSync(path as string, "utf8")).toContain("| custom-render'");
  });
});

describe("statusline settings — launch injection", () => {
  const UUID = "11111111-1111-1111-1111-111111111111";

  test("claude launch injects --settings with the managed path", async () => {
    const h = makeHarness({
      argv: ["claude", "hi"],
      rawArgv: true,
      randomUuid: () => UUID,
      resolveStatuslineSettingsPath: () => "/managed/statusline.json",
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--settings")).toEqual(["/managed/statusline.json"]);
  });

  test("a caller-supplied --settings wins (keeper does not clobber it)", async () => {
    const h = makeHarness({
      argv: ["claude", "--settings", "/my/own.json", "hi"],
      rawArgv: true,
      randomUuid: () => UUID,
      resolveStatuslineSettingsPath: () => "/managed/statusline.json",
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--settings")).toEqual(["/my/own.json"]);
    expect(cmd).not.toContain("/managed/statusline.json");
  });

  test("a null resolver skips the injection (fail-open)", async () => {
    const h = makeHarness({
      argv: ["claude", "hi"],
      rawArgv: true,
      randomUuid: () => UUID,
      resolveStatuslineSettingsPath: () => null,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).not.toContain("--settings");
  });

  test("codex launch gets no statusline --settings (claude branch only)", async () => {
    const h = makeHarness({
      argv: ["codex", "hi"],
      rawArgv: true,
      randomUuid: () => UUID,
      resolveStatuslineSettingsPath: () => "/managed/statusline.json",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).not.toContain("--settings");
  });
});
