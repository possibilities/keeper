/**
 * Usage-worker tests, mirroring the plan-worker.test.ts layout:
 *
 * (a) DETERMINISM unit tests against the PURE `UsageScanner` core — no
 *     Worker, no watcher, just files + `onChange` / `onDelete` / `markSeen` /
 *     `sweep`. Cover the filename predicate, snapshot derivation, change-gate
 *     dedupe, safe-parse skips (malformed JSON, oversize, missing id,
 *     missing-session/-week sub-blocks), tombstone retraction, boot sweep,
 *     and the load-bearing FRESHNESS-EXCLUSION case (two envelopes differing
 *     only in `fetched_at` / `next_fetch_at` / `last_successful_fetch_at` /
 *     `last_skipped_fetch_at` produce zero emits — the tripwire that catches
 *     any future drift adding a freshness column to the change-gate hash).
 * (b) A roundtrip test that {@link seedFromDb} suppresses a re-emit of an
 *     already-folded projection row (slot-order discipline check — the seed
 *     reconstruction must produce byte-identical JSON to {@link buildUsageMessage}'s
 *     output, or every profile re-emits on every boot).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUsageMessage,
  idFromUsagePath,
  isUsageFilename,
  scanRoot,
  seedFromDb,
  type UsageMessage,
  UsageScanner,
} from "../src/usage-worker";
import { freshMemDb } from "./helpers/template-db";

let tmpDir: string;
let stateDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-usage-test-"));
  stateDir = join(tmpDir, "agentusage");
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write one `<id>.json` envelope under stateDir; return absolute path. */
function writeEnvelope(id: string, body: Record<string, unknown>): string {
  const path = join(stateDir, `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, ...body }));
  return path;
}

/**
 * A realistic agentusage envelope with the four freshness fields populated.
 * Tests that flip ONLY the freshness fields verify the change-gate
 * suppression.
 */
function envelopeBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    target: "claude",
    multiplier: 5,
    last_successful_fetch_at: "2026-05-26T15:49:02.302958-04:00",
    last_skipped_fetch_at: null,
    last_failed_fetch_at: null,
    next_fetch_at: "2026-05-26T15:51:30.316687-04:00",
    fetched_at: "2026-05-26T15:49:02.302958-04:00",
    usage: {
      session: { percent_used: 12.0, resets_at: "2026-05-26T18:30:00-04:00" },
      week: { percent_used: 8.0, resets_at: "2026-06-01T20:00:00-04:00" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) Pure-core determinism — filename predicate + id derivation
// ---------------------------------------------------------------------------

test("isUsageFilename accepts <id>.json (lowercase, digit, hyphen); rejects everything else", () => {
  expect(isUsageFilename("claude-default.json")).toBe(true);
  expect(isUsageFilename("claude-multi-1.json")).toBe(true);
  expect(isUsageFilename("codex.json")).toBe(true);
  expect(isUsageFilename("a.json")).toBe(true);
  // Reject extra dot segment (future agentusage error envelope).
  expect(isUsageFilename("claude-default.error.json")).toBe(false);
  // Reject non-.json files (agentusage log surfaces).
  expect(isUsageFilename("server.stdout")).toBe(false);
  expect(isUsageFilename("server.stderr")).toBe(false);
  expect(isUsageFilename("events.jsonl")).toBe(false);
  // Reject atomic-rename temp artifacts.
  expect(isUsageFilename("claude-default.json.tmp.12345")).toBe(false);
  // Reject uppercase / non-portable characters.
  expect(isUsageFilename("Claude.json")).toBe(false);
  expect(isUsageFilename(".hidden.json")).toBe(false);
  expect(isUsageFilename("a_b.json")).toBe(false);
});

test("idFromUsagePath strips the .json suffix; null on a non-matching basename", () => {
  expect(idFromUsagePath("/a/b/claude-default.json")).toBe("claude-default");
  expect(idFromUsagePath("/a/b/codex.json")).toBe("codex");
  expect(idFromUsagePath("/a/b/claude-default.error.json")).toBeNull();
  expect(idFromUsagePath("/a/b/server.stderr")).toBeNull();
});

// ---------------------------------------------------------------------------
// (a) Pure-core determinism — buildUsageMessage shape
// ---------------------------------------------------------------------------

test("buildUsageMessage maps id/target/multiplier and the two-window usage sub-block", () => {
  const msg = buildUsageMessage({
    id: "claude-default",
    target: "claude",
    multiplier: 5,
    usage: {
      session: { percent_used: 12.0, resets_at: "2026-05-26T18:30:00-04:00" },
      week: { percent_used: 8.0, resets_at: "2026-06-01T20:00:00-04:00" },
    },
  });
  expect(msg).toEqual({
    kind: "usage-snapshot",
    id: "claude-default",
    target: "claude",
    multiplier: 5,
    session_percent: 12.0,
    session_resets_at: "2026-05-26T18:30:00-04:00",
    week_percent: 8.0,
    week_resets_at: "2026-06-01T20:00:00-04:00",
    // `usage.sonnet_week` absent → both fields fold to null per the
    // safe-value invariant. (codex envelopes never carry this sub-object.)
    sonnet_week_percent: null,
    sonnet_week_resets_at: null,
    codex_spark_session_percent: null,
    codex_spark_session_resets_at: null,
    codex_spark_week_percent: null,
    codex_spark_week_resets_at: null,
    // fn-645 fields: this envelope omits status/subscription/error → all null.
    status: null,
    subscription_active: null,
    error_type: null,
    error_message: null,
    error_at: null,
    error_kind: null,
    // fn-651: envelope omits `lift_at` → null.
    lift_at: null,
  });
});

test("buildUsageMessage projects the optional sonnet_week sub-block when present", () => {
  // Claude target's envelope carries a third per-model `sonnet_week`
  // window. The worker parses it into `sonnet_week_percent` +
  // `sonnet_week_resets_at` so the projection's third column lights up
  // for claude profiles without affecting the codex shape.
  const msg = buildUsageMessage({
    id: "claude-default",
    target: "claude",
    multiplier: 5,
    usage: {
      session: { percent_used: 12.0, resets_at: "2026-05-26T18:30:00-04:00" },
      week: { percent_used: 8.0, resets_at: "2026-06-01T20:00:00-04:00" },
      sonnet_week: {
        percent_used: 2.0,
        resets_at: "2026-06-01T20:00:00-04:00",
      },
    },
  });
  expect(msg?.sonnet_week_percent).toBe(2.0);
  expect(msg?.sonnet_week_resets_at).toBe("2026-06-01T20:00:00-04:00");
});

test("buildUsageMessage projects the optional codex-spark sub-blocks when present", () => {
  const msg = buildUsageMessage({
    id: "codex",
    target: "codex",
    multiplier: 1,
    usage: {
      session: { percent_used: 33, resets_at: "2026-06-26T22:57:00-04:00" },
      week: { percent_used: 28, resets_at: "2026-06-28T19:20:00-04:00" },
      codex_spark_session: {
        percent_used: 27,
        resets_at: "2026-06-26T23:59:00-04:00",
      },
      codex_spark_week: {
        percent_used: 48,
        resets_at: "2026-06-28T21:00:00-04:00",
      },
    },
  });
  expect(msg?.codex_spark_session_percent).toBe(27);
  expect(msg?.codex_spark_session_resets_at).toBe("2026-06-26T23:59:00-04:00");
  expect(msg?.codex_spark_week_percent).toBe(48);
  expect(msg?.codex_spark_week_resets_at).toBe("2026-06-28T21:00:00-04:00");
});

test("buildUsageMessage returns null when id is missing or non-string", () => {
  expect(buildUsageMessage({})).toBeNull();
  expect(buildUsageMessage({ id: 42 })).toBeNull();
  expect(buildUsageMessage({ id: "" })).toBeNull();
});

test("buildUsageMessage folds missing usage.session / usage.week to NULL fields", () => {
  // No usage block at all → both windows NULL.
  const bare = buildUsageMessage({ id: "x", target: "claude", multiplier: 1 });
  expect(bare?.session_percent).toBeNull();
  expect(bare?.session_resets_at).toBeNull();
  expect(bare?.week_percent).toBeNull();
  expect(bare?.week_resets_at).toBeNull();
  // Only session present → week NULL.
  const sessOnly = buildUsageMessage({
    id: "x",
    usage: { session: { percent_used: 10, resets_at: "T" } },
  });
  expect(sessOnly?.session_percent).toBe(10);
  expect(sessOnly?.week_percent).toBeNull();
  // Only week present → session NULL.
  const weekOnly = buildUsageMessage({
    id: "x",
    usage: { week: { percent_used: 20, resets_at: "T" } },
  });
  expect(weekOnly?.week_percent).toBe(20);
  expect(weekOnly?.session_percent).toBeNull();
});

test("buildUsageMessage drops every freshness field — they NEVER enter the message", () => {
  const msg = buildUsageMessage({
    id: "claude-default",
    target: "claude",
    multiplier: 5,
    fetched_at: "T1",
    next_fetch_at: "T2",
    last_successful_fetch_at: "T3",
    last_skipped_fetch_at: "T4",
    // fn-645: `last_failed_fetch_at` joined the freshness exclusion set.
    last_failed_fetch_at: "T5",
    usage: { session: { percent_used: 1, resets_at: "S" } },
  });
  // None of the freshness fields appear in the message shape.
  const json = JSON.stringify(msg);
  expect(json).not.toContain("fetched_at");
  expect(json).not.toContain("next_fetch_at");
  expect(json).not.toContain("last_successful_fetch_at");
  expect(json).not.toContain("last_skipped_fetch_at");
  expect(json).not.toContain("last_failed_fetch_at");
});

// ---------------------------------------------------------------------------
// (a) FRESHNESS-EXCLUSION TRIPWIRE — load-bearing discipline test
// ---------------------------------------------------------------------------

test("FRESHNESS EXCLUSION: two envelopes differing ONLY in fetch timestamps produce ZERO emits past the first", () => {
  // The point of this test: a future contributor adding `fetched_at` (or any
  // of the four freshness fields) to the change-gate hash would force a
  // synthetic event on every ~90s agentusage fetch cycle, churning the
  // projection. The change-gate compares JSON.stringify byte-for-byte, so
  // omitting the field from `buildUsageMessage`'s output is the discipline
  // — and this test asserts that discipline holds.
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // First scan: emits.
  const path = writeEnvelope("claude-default", envelopeBody());
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  // Rewrite with ONLY the four freshness fields advanced. The session/week
  // numbers + resets_at + target + multiplier all stay byte-identical.
  writeFileSync(
    path,
    JSON.stringify({
      id: "claude-default",
      ...envelopeBody({
        fetched_at: "2026-05-26T16:00:00.000000-04:00",
        next_fetch_at: "2026-05-26T16:01:30.000000-04:00",
        last_successful_fetch_at: "2026-05-26T16:00:00.000000-04:00",
        last_skipped_fetch_at: "2026-05-26T15:59:00.000000-04:00",
      }),
    }),
  );
  scanner.onChange(path);
  // ZERO additional emits — the freshness-only diff is suppressed by the
  // change-gate. If this assertion fails, a freshness field has leaked into
  // buildUsageMessage's output (or into the schema-derived seed). FIX BY
  // REMOVING THE LEAK — do NOT relax this test.
  expect(emitted.length).toBe(1);
});

test("buildUsageMessage projects fn-645 status / subscription_active / error axes", () => {
  // A stale envelope: status carried, subscription_active false, full error
  // sub-object flattened into error_type / error_message / error_at.
  const stale = buildUsageMessage({
    id: "claude-default",
    target: "claude",
    multiplier: 5,
    status: "stale",
    subscription_active: false,
    error: {
      type: "ClaudeUsageParseError",
      message: "required label not found: 'Current session'",
      at: "2026-05-29T11:42:17-07:00",
    },
    usage: null,
  });
  expect(stale?.status).toBe("stale");
  expect(stale?.subscription_active).toBe(false);
  expect(stale?.error_type).toBe("ClaudeUsageParseError");
  expect(stale?.error_message).toBe(
    "required label not found: 'Current session'",
  );
  expect(stale?.error_at).toBe("2026-05-29T11:42:17-07:00");

  // An active subscribed envelope: status carried, subscription_active true,
  // error sub-object null → all three error_* fields null.
  const active = buildUsageMessage({
    id: "x",
    status: "active",
    subscription_active: true,
    error: null,
  });
  expect(active?.status).toBe("active");
  expect(active?.subscription_active).toBe(true);
  expect(active?.error_type).toBeNull();
  expect(active?.error_message).toBeNull();
  expect(active?.error_at).toBeNull();

  // Codex never-observed-subscription: subscription_active null tri-state.
  const unknown = buildUsageMessage({
    id: "codex",
    status: "active",
    subscription_active: null,
  });
  expect(unknown?.subscription_active).toBeNull();
});

test("fn-651: buildUsageMessage projects top-level lift_at; absent/non-string → null", () => {
  // The rate-limit lift instant ships as a top-level envelope field
  // alongside `target` / `multiplier` / `status`. Mirrors `session_resets_at`
  // shape (ISO string | null) and is null-safe on missing/non-string.
  const present = buildUsageMessage({
    id: "claude-mc1",
    target: "claude",
    multiplier: 5,
    lift_at: "2026-05-30T20:30:00-04:00",
  });
  expect(present?.lift_at).toBe("2026-05-30T20:30:00-04:00");

  // Absent → null.
  const absent = buildUsageMessage({ id: "x" });
  expect(absent?.lift_at).toBeNull();

  // Non-string (e.g. agentusage fault, or a typo'd envelope) → null per the
  // safe-value invariant. The reducer's `parseUsageSnapshot` enforces the
  // same string-guard on the wire side.
  const bogus = buildUsageMessage({ id: "x", lift_at: 42 });
  expect(bogus?.lift_at).toBeNull();
});

test("fn-1000: buildUsageMessage projects error.kind; absent/unknown → null", () => {
  // The scraper worker stamps a stable classification on the stale envelope's
  // `error.kind`; the consumer folds it onto `error_kind`. A classified
  // envelope carries it...
  const classified = buildUsageMessage({
    id: "claude-default",
    status: "stale",
    error: {
      type: "ClaudeUsageEndpointRateLimited",
      message: "usage endpoint is rate limited",
      at: "2026-05-29T11:42:17-07:00",
      kind: "upstream_limited",
    },
  });
  expect(classified?.error_kind).toBe("upstream_limited");

  // ...a pre-classification envelope (error sub-object without `kind`) folds to
  // null...
  const legacy = buildUsageMessage({
    id: "x",
    status: "stale",
    error: { type: "ClaudeUsageParseError", message: "drift", at: "T" },
  });
  expect(legacy?.error_kind).toBeNull();

  // ...an unknown/garbage kind folds to null per the safe-value invariant...
  const bogus = buildUsageMessage({
    id: "x",
    status: "stale",
    error: { type: "X", message: "m", at: "T", kind: "not_a_kind" },
  });
  expect(bogus?.error_kind).toBeNull();

  // ...and an active envelope (no error sub-object) → null.
  const active = buildUsageMessage({ id: "x", status: "active", error: null });
  expect(active?.error_kind).toBeNull();
});

test("ERROR_KIND IS GATED: a kind flip (error_type/message/at held) re-emits; error_at still excluded", () => {
  // `error_kind` is PROJECTED and — unlike `error_at` — STAYS in the change
  // gate, so a classification flip (e.g. format drift reclassified as a panel
  // miss) emits a fresh snapshot even when error_type / message / at are
  // unchanged. The error_at exclusion still holds: advancing ONLY error_at
  // (kind held) suppresses.
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  // error_type + message held constant across all three writes so the ONLY
  // gate-moving field under test is `error_kind` (then `error_at`).
  const constErr = {
    type: "ClaudeUsageParseError",
    message: "required label not found: 'Current session'",
  };
  const base = {
    target: "claude",
    multiplier: 5,
    status: "stale",
    subscription_active: true,
    usage: null,
  };

  const path = writeEnvelope("claude-default", {
    ...base,
    error: {
      ...constErr,
      at: "2026-05-29T11:42:17-07:00",
      kind: "format_changed",
    },
  });
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  // Flip ONLY the kind (error_at held). error_kind is in the gate → re-emit.
  writeFileSync(
    path,
    JSON.stringify({
      id: "claude-default",
      ...base,
      error: {
        ...constErr,
        at: "2026-05-29T11:42:17-07:00",
        kind: "panel_missing",
      },
    }),
  );
  scanner.onChange(path);
  expect(emitted.length).toBe(2);
  expect((emitted[1] as { error_kind: string | null }).error_kind).toBe(
    "panel_missing",
  );

  // Advance ONLY error_at (kind held). error_at is excluded → suppressed.
  writeFileSync(
    path,
    JSON.stringify({
      id: "claude-default",
      ...base,
      error: {
        ...constErr,
        at: "2026-05-29T11:50:00-07:00",
        kind: "panel_missing",
      },
    }),
  );
  scanner.onChange(path);
  expect(emitted.length).toBe(2);
});

test("ERROR_AT GATE EXCLUSION: two envelopes differing ONLY in error.at produce ONE emit", () => {
  // fn-645 introduces the first PROJECTED-but-GATE-EXCLUDED field. `error.at`
  // advances on every failed scrape (~90s during an outage); without the
  // exclusion, a stable outage would mint a synthetic event every cycle.
  // The exclusion lives in `usageGateKey` — both `onChange` and `seedFromDb`
  // route through it. This is the tripwire that catches a future regression
  // that includes `error_at` in the gate.
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = writeEnvelope("claude-default", {
    target: "claude",
    multiplier: 5,
    status: "stale",
    subscription_active: true,
    error: {
      type: "ClaudeUsageParseError",
      message: "required label not found: 'Current session'",
      at: "2026-05-29T11:42:17-07:00",
    },
    usage: null,
  });
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  // Rewrite with ONLY error.at advanced (and the freshness fields that move
  // with each scrape). Type/message/status all unchanged.
  writeFileSync(
    path,
    JSON.stringify({
      id: "claude-default",
      target: "claude",
      multiplier: 5,
      status: "stale",
      subscription_active: true,
      error: {
        type: "ClaudeUsageParseError",
        message: "required label not found: 'Current session'",
        at: "2026-05-29T11:43:47-07:00",
      },
      usage: null,
    }),
  );
  scanner.onChange(path);
  // ZERO additional emits — gate suppresses. If this fails, error_at has
  // leaked into the gate key. FIX BY REMOVING THE LEAK from `usageGateKey`.
  expect(emitted.length).toBe(1);

  // But: a status flip (stale → active) IS in the gate and re-emits, even if
  // error.at stayed the same as a previous emit's stamp.
  writeFileSync(
    path,
    JSON.stringify({
      id: "claude-default",
      target: "claude",
      multiplier: 5,
      status: "active",
      subscription_active: true,
      error: null,
      usage: {
        session: { percent_used: 1, resets_at: "T" },
        week: { percent_used: 1, resets_at: "T" },
      },
    }),
  );
  scanner.onChange(path);
  expect(emitted.length).toBe(2);
  // The full message DOES carry error_at when present — the gate exclusion
  // only governs change detection, not the emitted payload. Here the new
  // status is "active" so the error_at is null in the second emit.
  expect((emitted[1] as { status: string }).status).toBe("active");
  expect((emitted[1] as { error_at: string | null }).error_at).toBeNull();
});

test("a different error type/message DOES re-emit (gate fields moved)", () => {
  // The flip-side of the error_at exclusion: error_type and error_message ARE
  // in the gate (they're real content changes), so a different failure shape
  // re-emits even if error_at advances on the same cadence as a noop scrape.
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = writeEnvelope("claude-default", {
    target: "claude",
    multiplier: 5,
    status: "stale",
    error: {
      type: "ClaudeUsageParseError",
      message: "first failure",
      at: "2026-05-29T11:42:17-07:00",
    },
  });
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  // Different message → re-emit.
  writeFileSync(
    path,
    JSON.stringify({
      id: "claude-default",
      target: "claude",
      multiplier: 5,
      status: "stale",
      error: {
        type: "ClaudeUsageParseError",
        message: "second failure",
        at: "2026-05-29T11:43:47-07:00",
      },
    }),
  );
  scanner.onChange(path);
  expect(emitted.length).toBe(2);
});

// ---------------------------------------------------------------------------
// (a) Pure-core determinism — onChange end-to-end with real files
// ---------------------------------------------------------------------------

test("onChange emits a usage-snapshot for a real envelope, then change-gates an identical re-scan", () => {
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = writeEnvelope("claude-default", envelopeBody());
  scanner.onChange(path);
  expect(emitted.length).toBe(1);
  expect(emitted[0]).toEqual({
    kind: "usage-snapshot",
    id: "claude-default",
    target: "claude",
    multiplier: 5,
    session_percent: 12.0,
    session_resets_at: "2026-05-26T18:30:00-04:00",
    week_percent: 8.0,
    week_resets_at: "2026-06-01T20:00:00-04:00",
    sonnet_week_percent: null,
    sonnet_week_resets_at: null,
    codex_spark_session_percent: null,
    codex_spark_session_resets_at: null,
    codex_spark_week_percent: null,
    codex_spark_week_resets_at: null,
    status: null,
    subscription_active: null,
    error_type: null,
    error_message: null,
    error_at: null,
    error_kind: null,
    // fn-651: envelope omits lift_at → null.
    lift_at: null,
  });

  // Identical re-scan suppressed.
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  // A real change to the session_percent re-emits.
  writeFileSync(
    path,
    JSON.stringify({
      id: "claude-default",
      ...envelopeBody({
        usage: {
          session: {
            percent_used: 25.0,
            resets_at: "2026-05-26T18:30:00-04:00",
          },
          week: { percent_used: 8.0, resets_at: "2026-06-01T20:00:00-04:00" },
        },
      }),
    }),
  );
  scanner.onChange(path);
  expect(emitted.length).toBe(2);
  expect((emitted[1] as { session_percent: number }).session_percent).toBe(25);
});

test("malformed JSON skips-and-logs without emitting", () => {
  const emitted: UsageMessage[] = [];
  const logs: string[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    (l) => logs.push(l),
  );

  const path = join(stateDir, "claude-default.json");
  writeFileSync(path, "{ not json");
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("malformed JSON"))).toBe(true);
});

test("oversize file skips-and-logs without emitting", () => {
  const emitted: UsageMessage[] = [];
  const logs: string[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    (l) => logs.push(l),
  );
  // Write a >1MiB file (cheap big string).
  const path = join(stateDir, "claude-default.json");
  writeFileSync(path, "x".repeat(2 * 1024 * 1024));
  // Sanity: the file really is over the cap.
  expect(statSync(path).size).toBeGreaterThan(1024 * 1024);
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("exceeds"))).toBe(true);
});

test("missing-id envelope skips-and-logs without emitting", () => {
  const emitted: UsageMessage[] = [];
  const logs: string[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    (l) => logs.push(l),
  );
  const path = join(stateDir, "claude-default.json");
  writeFileSync(path, JSON.stringify({ target: "claude" })); // no id
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("no usable id"))).toBe(true);
});

test("a non-usage filename is a no-op (filename predicate rejects)", () => {
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  // Even with valid envelope content, the wrong filename is ignored.
  const path = join(stateDir, "server.stderr");
  writeFileSync(path, JSON.stringify({ id: "x" }));
  scanner.onChange(path);
  expect(emitted).toEqual([]);
});

test("a vanished file (read-vs-delete race) skips-and-logs, no emit", () => {
  const emitted: UsageMessage[] = [];
  const logs: string[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    (l) => logs.push(l),
  );
  // Path passes the filename predicate but doesn't exist on disk.
  const path = join(stateDir, "claude-default.json");
  scanner.onChange(path);
  expect(emitted).toEqual([]);
  expect(logs.some((l) => l.includes("stat failed"))).toBe(true);
});

// ---------------------------------------------------------------------------
// (a) Pure-core determinism — onDelete + change-gate cleanup
// ---------------------------------------------------------------------------

test("onDelete emits a tombstone for a previously-folded path; re-created file re-emits", () => {
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  const path = writeEnvelope("claude-default", envelopeBody());
  scanner.onChange(path);
  expect(emitted.length).toBe(1);

  scanner.onDelete(path);
  expect(emitted.length).toBe(2);
  expect(emitted[1]).toEqual({ kind: "usage-deleted", id: "claude-default" });

  // The change-gate was cleared, so the same content re-arriving re-emits.
  scanner.onChange(path);
  expect(emitted.length).toBe(3);
  expect((emitted[2] as { kind: string }).kind).toBe("usage-snapshot");
});

test("onDelete on an un-seeded path emits nothing (nothing to retract)", () => {
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  // Never folded this path → no change-gate entry → no tombstone.
  const path = join(stateDir, "claude-default.json");
  scanner.onDelete(path);
  expect(emitted).toEqual([]);
});

// ---------------------------------------------------------------------------
// (a) Boot-sweep reconciliation — ghost retraction
// ---------------------------------------------------------------------------

test("sweep retracts a projection id whose file was deleted while down", () => {
  // fn-769 mem variant: single in-process connection (`sweep` reuses the same
  // `db`); no second opener or spawned worker touches the path.
  const { db } = freshMemDb();
  // Seed a usage row for a profile whose file is no longer on disk.
  db.run(
    `INSERT INTO usage (id, target, multiplier, session_percent, session_resets_at,
                        week_percent, week_resets_at, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["ghost-profile", "claude", 5, 12.0, "T", 8.0, "T", 1, 100],
  );
  db.run(
    `INSERT INTO usage (id, target, multiplier, session_percent, session_resets_at,
                        week_percent, week_resets_at, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["live-profile", "claude", 5, 25.0, "T", 8.0, "T", 2, 100],
  );

  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // Boot scan sees ONLY live-profile on disk.
  writeEnvelope("live-profile", envelopeBody());
  scanRoot(stateDir, scanner);
  // The boot scan calls onChange for live-profile (no snapshot in change-gate
  // → emits once). Now sweep — ghost-profile's id is in the projection but
  // not in seenOnDisk, so it retracts.
  const beforeSweep = emitted.length;
  scanner.sweep(db);
  const tombstones = emitted
    .slice(beforeSweep)
    .filter((m) => m.kind === "usage-deleted");
  expect(tombstones).toEqual([{ kind: "usage-deleted", id: "ghost-profile" }]);
  db.close();
});

test("sweep does NOT retract a profile present on disk (even if it failed to parse)", () => {
  // fn-769 mem variant: single in-process connection (`sweep` reuses the same
  // `db`); no second opener or spawned worker touches the path.
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO usage (id, last_event_id, updated_at)
       VALUES (?, ?, ?)`,
    ["claude-default", 1, 100],
  );

  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );

  // File exists but is malformed — boot scan's onChange skips-and-logs,
  // BUT markSeen runs first (filename-keyed) so the census includes the id.
  writeFileSync(join(stateDir, "claude-default.json"), "{ not json");
  scanRoot(stateDir, scanner);

  const beforeSweep = emitted.length;
  scanner.sweep(db);
  // No tombstone fires — the file is on disk, even though it didn't parse.
  const tombstones = emitted
    .slice(beforeSweep)
    .filter((m) => m.kind === "usage-deleted");
  expect(tombstones).toEqual([]);
  db.close();
});

test("scanRoot tolerates a missing root (no throw, no emit)", () => {
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  // Use a path that does not exist on disk.
  scanRoot(join(tmpDir, "does-not-exist"), scanner);
  expect(emitted).toEqual([]);
});

// ---------------------------------------------------------------------------
// (b) Restart-seed — slot-order discipline
// ---------------------------------------------------------------------------

test("seedFromDb suppresses a re-emit of an already-folded projection row (slot-order discipline)", () => {
  // This is the test that catches drift between `buildUsageMessage` and
  // `seedFromDb`'s reconstruction. If the two diverge on key order or field
  // set, the change-gate compares JSON.stringify byte-for-byte and re-emits
  // every profile on every daemon boot.
  // fn-769 mem variant: single in-process connection (`sweep` reuses the same
  // `db`); no second opener or spawned worker touches the path.
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO usage (id, target, multiplier, session_percent, session_resets_at,
                        week_percent, week_resets_at, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "claude-default",
      "claude",
      5,
      12.0,
      "2026-05-26T18:30:00-04:00",
      8.0,
      "2026-06-01T20:00:00-04:00",
      1,
      100,
    ],
  );

  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);

  // The on-disk file matches the projection row exactly. The change-gate
  // (seeded by seedFromDb) MUST suppress the boot scan's onChange emit.
  writeEnvelope("claude-default", envelopeBody());
  scanner.onChange(join(stateDir, "claude-default.json"));
  expect(emitted).toEqual([]);
  db.close();
});

test("seedFromDb reconstructs fn-645 fields and suppresses re-emit (subscription_active boolean)", () => {
  // The seed path stores `subscription_active` as 1/0/NULL; the reconstruction
  // must coerce back to boolean | null so the gate key matches the live
  // `buildUsageMessage` output byte-for-byte. Also: `error_at` is in the
  // projection but NOT in the gate, so seeding from a row that carries a
  // different `error_at` than the on-disk file must still suppress.
  // fn-769 mem variant: single in-process connection (`sweep` reuses the same
  // `db`); no second opener or spawned worker touches the path.
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO usage (id, target, multiplier, session_percent, session_resets_at,
                        week_percent, week_resets_at, status, subscription_active,
                        error_type, error_message, error_at,
                        last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "claude-default",
      "claude",
      5,
      12.0,
      "2026-05-26T18:30:00-04:00",
      8.0,
      "2026-06-01T20:00:00-04:00",
      "stale",
      1, // SQLite stores boolean as integer
      "ClaudeUsageParseError",
      "required label not found",
      "2026-05-29T11:42:17-07:00",
      1,
      100,
    ],
  );

  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);

  // The on-disk file carries the SAME content as the projection row except
  // `error.at` has advanced (the re-failed scrape stamp). The gate must
  // suppress — error_at is excluded from the gate.
  writeEnvelope("claude-default", {
    target: "claude",
    multiplier: 5,
    status: "stale",
    subscription_active: true,
    error: {
      type: "ClaudeUsageParseError",
      message: "required label not found",
      at: "2026-05-29T11:50:00-07:00", // different from seeded
    },
    usage: {
      session: { percent_used: 12.0, resets_at: "2026-05-26T18:30:00-04:00" },
      week: { percent_used: 8.0, resets_at: "2026-06-01T20:00:00-04:00" },
    },
  });
  scanner.onChange(join(stateDir, "claude-default.json"));
  expect(emitted).toEqual([]);
  db.close();
});

test("seedFromDb handles subscription_active=0 (false) round-trip", () => {
  // Confirm the 0→false coercion at seed time matches buildUsageMessage's
  // false output (the no-subscription account case).
  // fn-769 mem variant: single in-process connection (`sweep` reuses the same
  // `db`); no second opener or spawned worker touches the path.
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO usage (id, target, multiplier, status, subscription_active,
                        last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["no-sub", "claude", 5, "active", 0, 1, 100],
  );
  const emitted: UsageMessage[] = [];
  const scanner = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  seedFromDb(db, scanner);

  // On-disk file matches the projection row.
  writeEnvelope("no-sub", {
    target: "claude",
    multiplier: 5,
    status: "active",
    subscription_active: false,
    error: null,
  });
  scanner.onChange(join(stateDir, "no-sub.json"));
  expect(emitted).toEqual([]);
  db.close();
});

// ---------------------------------------------------------------------------
// (b) markSeen filename-keying — parse-independence
// ---------------------------------------------------------------------------

test("markSeen keys off filename, parse-independent", () => {
  const scanner = new UsageScanner(
    () => {},
    () => {},
  );
  // A path whose basename passes the filter is marked; one that doesn't is
  // silently ignored.
  scanner.markSeen("/a/b/claude-default.json");
  scanner.markSeen("/a/b/server.stderr"); // ignored
  // Now drive a sweep against an empty usage table — no rows to retract,
  // proving markSeen accepted the valid path silently and ignored the other.
  // (We can't directly inspect seenOnDisk; the sweep behavior is the
  // observable.)
  // fn-769 mem variant: single in-process connection (`sweep` reuses the same
  // `db`); no second opener or spawned worker touches the path.
  const { db } = freshMemDb();
  const emitted: UsageMessage[] = [];
  const scanner2 = new UsageScanner(
    (m) => emitted.push(m),
    () => {},
  );
  scanner2.markSeen("/a/b/claude-default.json");
  db.run(`INSERT INTO usage (id, last_event_id, updated_at) VALUES (?, ?, ?)`, [
    "claude-default",
    1,
    100,
  ]);
  scanner2.sweep(db);
  // No tombstone — the id was marked seen (filename-derived).
  expect(emitted.filter((m) => m.kind === "usage-deleted")).toEqual([]);
  db.close();
});
