/**
 * `keeper statusline-sink` — the capture-only statusLine leaf-writer.
 *
 * The sink is a pure, dependency-light function set (no DB, no socket, no
 * subprocess), so it is driven directly with captured payload strings + a
 * per-test tmpdir — no stdin plumbing.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStatuslinePayload,
  resolveStatuslineDir,
  runSink,
  HELP as SINK_HELP,
  type StatuslineLeaf,
  sanitizeSessionToken,
  main as sinkMain,
} from "../cli/statusline-sink";
import { readExactRuntimeObservation } from "../src/session-runtime.ts";

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

describe("statusline-sink — help", () => {
  test("--help writes a non-empty one-liner WITHOUT draining stdin", async () => {
    const prev = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((s: string) => {
      out += s;
      return true;
    }) as typeof process.stdout.write;
    try {
      // Would hang on a stdin drain if the help short-circuit regressed; the
      // test completing at all is the assertion that it does not read stdin.
      await sinkMain(["--help"]);
    } finally {
      process.stdout.write = prev;
    }
    expect(out.length).toBeGreaterThan(0);
    expect(out).toBe(SINK_HELP);
    expect(out).toContain("not for agent use");
  });
});

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

  test("within-bucket movement updates exact runtime without rewriting the coalesced leaf", () => {
    const dir = tmpDir();
    const runtimeDir = join(dir, "exact");
    expect(runSink(payload(), dir, 1, runtimeDir).wrote).toBe(true);
    expect(
      runSink(
        payload({
          context_window: {
            used_percentage: 43.9,
            total_input_tokens: 87_000,
            context_window_size: 200_000,
          },
        }),
        dir,
        2,
        runtimeDir,
      ).wrote,
    ).toBe(false);

    const coalesced = JSON.parse(
      readFileSync(join(dir, "sess-abc.json"), "utf8"),
    ) as StatuslineLeaf;
    expect(coalesced.updated_at).toBe(1);
    expect(coalesced.context_used_percentage).toBe(42.5);
    expect(coalesced.context_input_tokens).toBe(85_000);

    const exact = readExactRuntimeObservation("sess-abc", runtimeDir);
    expect(exact?.observed_at_ms).toBe(2);
    expect(exact?.context_used_percentage).toBe(43.9);
    expect(exact?.context_input_tokens).toBe(87_000);
    const expectedLeaf =
      "33a386c9464a4538527687ee331d081db7d7448137f25db6fd13b1d8d1053a71.json";
    expect(readdirSync(runtimeDir)).toEqual([expectedLeaf]);
    expect(statSync(runtimeDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(runtimeDir, expectedLeaf)).mode & 0o777).toBe(0o600);
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
