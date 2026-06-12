/**
 * Unit tests for the `helptailing` babysitter scanner (epic fn-791 task .1).
 *
 * Two layers:
 *  1. PURE detectors + trend math + the quote-aware walk — fed hand-built
 *     fixtures, asserted against the expected output. No DB.
 *  2. The DB layer (`scan` / `tick`) — seeds a sandbox `keeper.db` via
 *     `freshDbFile`, raw-INSERTs events (and relocates a blob to `event_blobs`
 *     to prove the COALESCE join), and asserts the wired findings + the
 *     baseline-seed + followup writes.
 *
 * Per the CLAUDE.md isolation rule every state path is sandboxed under the
 * per-test tmpdir: `KEEPER_DB` + the sitter's own `BABYSITTER_STATE_DIR` root.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bucketByWeek,
  detectRateSpike,
  detectTrendDigest,
  EPOCH_BOUNDARY_SECS,
  type Finding,
  type FrozenBaseline,
  followupFilename,
  garwoodPoissonCI,
  hasAgentHelpFlag,
  isoWeek,
  loadBaseline,
  loadSeenState,
  pipeTarget,
  rateRatio,
  rateRatioLowerBound,
  renderFollowup,
  resolveBaselinePath,
  resolveFollowupsDir,
  resolveSeenStatePath,
  rrBand,
  type ScanDeps,
  sanitizeKey,
  saveBaseline,
  scan,
  type TrendInput,
  tick,
  tokenizeCommand,
  validateMatch,
} from "../babysitters/helptailing/watch";
import { freshDbFile } from "./helpers/template-db";

// ---------------------------------------------------------------------------
// Sandbox: tmpdir DB + the sitter's own state-dir root.
// ---------------------------------------------------------------------------

let tmpDir: string;
let dbPath: string;
let savedEnv: Record<string, string | undefined>;
const SANDBOXED_ENV = ["KEEPER_DB", "BABYSITTER_STATE_DIR"] as const;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "helptailing-"));
  dbPath = join(tmpDir, "keeper.db");
  savedEnv = {};
  for (const k of SANDBOXED_ENV) savedEnv[k] = process.env[k];
  process.env.KEEPER_DB = dbPath;
  process.env.BABYSITTER_STATE_DIR = join(tmpDir, "bb-state");
});

afterEach(() => {
  for (const k of SANDBOXED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A PreToolUse Bash event `data` JSON for a command. */
function bashData(command: string): string {
  return JSON.stringify({ tool_name: "Bash", tool_input: { command } });
}

/** Insert one events row; optionally relocate its data into event_blobs. */
function insertEvent(
  db: Database,
  row: {
    ts: number;
    session_id: string;
    hook_event: string;
    data: string | null;
    /** When true, NULL the inline data and write it to event_blobs instead. */
    relocate?: boolean;
  },
): void {
  db.query(
    `INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, data)
     VALUES (?, ?, ?, 'lifecycle', 'Bash', ?)`,
  ).run(row.ts, row.session_id, row.hook_event, row.relocate ? null : row.data);
  if (row.relocate && row.data !== null) {
    const id = (
      db.query("SELECT last_insert_rowid() AS id").get() as { id: number }
    ).id;
    db.query("INSERT INTO event_blobs (event_id, data) VALUES (?, ?)").run(
      id,
      row.data,
    );
  }
}

/** A baseline TrendInput with overridable fields. */
function trendInput(over: Partial<TrendInput>): TrendInput {
  return {
    baseline: { hits: 100, sessions: 50 },
    epoch: { hits: 10, sessions: 5 },
    weeks: [{ week: "2026-W24", hits: 10, sessions: 5 }],
    pipeTargets: { tail: 0, head: 6, grep: 4, none: 0 },
    baselineSuspect: false,
    nowWeek: "2026-W24",
    ...over,
  };
}

const BEFORE = EPOCH_BOUNDARY_SECS - 86_400; // a day before the boundary
const AFTER = EPOCH_BOUNDARY_SECS + 86_400; // a day after

// ===========================================================================
// Pure: the quote-aware flag-token + pipe-target walk
// ===========================================================================

describe("hasAgentHelpFlag (flag-token match)", () => {
  test("plain flag token matches", () => {
    expect(hasAgentHelpFlag("dashctl --agent-help | head -50")).toBe(true);
  });

  test("--agent-help=value form matches", () => {
    expect(hasAgentHelpFlag("foo --agent-help=verbose")).toBe(true);
  });

  test("quoted arg containing --agent-help does NOT match", () => {
    expect(hasAgentHelpFlag("grep -E '--agent-help | tail'")).toBe(false);
  });

  test("a regex-alternation false positive does NOT match", () => {
    // `grep -E 'foo|tail'` carries no --agent-help at all → false.
    expect(hasAgentHelpFlag("grep -E 'foo|tail'")).toBe(false);
  });

  test("substring inside a longer token does NOT match", () => {
    expect(hasAgentHelpFlag("foo --agent-helpfulness")).toBe(false);
  });

  test("double-quoted --agent-help is one token, no bare flag", () => {
    expect(hasAgentHelpFlag('echo "--agent-help here"')).toBe(false);
  });
});

describe("pipeTarget (quote-aware, evidence only)", () => {
  test("head after the flag", () => {
    expect(pipeTarget("dashctl --agent-help | head -50")).toBe("head");
  });
  test("tail after the flag", () => {
    expect(pipeTarget("pairctl --agent-help 2>&1 | tail -20")).toBe("tail");
  });
  test("grep after the flag", () => {
    expect(pipeTarget("ctl --agent-help | grep foo")).toBe("grep");
  });
  test("no pipe → none", () => {
    expect(pipeTarget("ctl --agent-help")).toBe("none");
  });
  test("a quoted pipe is not a real pipe target", () => {
    // The `|` is inside the quoted grep pattern, not a shell pipe.
    expect(pipeTarget("ctl --agent-help && grep -E 'a|b' x")).toBe("none");
  });
  test("first recognized downstream target wins", () => {
    expect(pipeTarget("ctl --agent-help | head -5 | grep x")).toBe("head");
  });
});

describe("tokenizeCommand (quote/escape state)", () => {
  test("splits on top-level whitespace", () => {
    expect(tokenizeCommand("a b c").map((t) => t.token)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
  test("a quoted span is one token", () => {
    expect(tokenizeCommand("grep 'a b c' x").map((t) => t.token)).toEqual([
      "grep",
      "a b c",
      "x",
    ]);
  });
  test("marks the token immediately after a top-level pipe", () => {
    const toks = tokenizeCommand("a | b");
    expect(toks.find((t) => t.token === "b")?.afterPipe).toBe(true);
    expect(toks.find((t) => t.token === "a")?.afterPipe).toBe(false);
  });
});

// ===========================================================================
// Pure: trend math
// ===========================================================================

describe("rateRatio (per-session normalization)", () => {
  test("computes epoch-rate / baseline-rate", () => {
    // epoch 10/5 = 2.0; baseline 100/50 = 2.0 → RR 1.0
    expect(
      rateRatio({ hits: 10, sessions: 5 }, { hits: 100, sessions: 50 }),
    ).toBe(1);
  });
  test("zero epoch sessions → null (no occurrences, not RR=0)", () => {
    expect(
      rateRatio({ hits: 0, sessions: 0 }, { hits: 100, sessions: 50 }),
    ).toBe(null);
  });
  test("zero baseline hits → null (undefined ratio)", () => {
    expect(rateRatio({ hits: 5, sessions: 3 }, { hits: 0, sessions: 10 })).toBe(
      null,
    );
  });
});

describe("garwoodPoissonCI (exact, handles zero)", () => {
  test("n=0 lower bound is 0", () => {
    expect(garwoodPoissonCI(0).lo).toBe(0);
  });
  test("n=0 upper bound is positive (~3.7 at 95%)", () => {
    const { hi } = garwoodPoissonCI(0);
    expect(hi).toBeGreaterThan(3);
    expect(hi).toBeLessThan(4);
  });
  test("the interval brackets the count for a moderate n", () => {
    const { lo, hi } = garwoodPoissonCI(20);
    expect(lo).toBeGreaterThan(10);
    expect(lo).toBeLessThan(20);
    expect(hi).toBeGreaterThan(20);
    expect(hi).toBeLessThan(35);
  });
});

describe("rateRatioLowerBound + rrBand", () => {
  test("a strong spike clears the 1.5 floor", () => {
    // epoch 40/4 = 10/session vs baseline 100/50 = 2/session → RR ~5; the
    // Garwood lower bound on 40 is well above the 1.5 floor.
    const lo = rateRatioLowerBound(
      { hits: 40, sessions: 4 },
      { hits: 100, sessions: 50 },
    );
    expect(lo).not.toBeNull();
    expect(lo as number).toBeGreaterThan(1.5);
  });
  test("a flat rate does NOT clear the floor", () => {
    const lo = rateRatioLowerBound(
      { hits: 10, sessions: 5 },
      { hits: 100, sessions: 50 },
    );
    expect(lo).not.toBeNull();
    expect(lo as number).toBeLessThan(1.5);
  });
  test("zero baseline → null", () => {
    expect(
      rateRatioLowerBound({ hits: 5, sessions: 3 }, { hits: 0, sessions: 10 }),
    ).toBe(null);
  });
  test("rrBand buckets stably", () => {
    expect(rrBand(null)).toBe("undefined");
    expect(rrBand(0.9)).toBe("<1");
    expect(rrBand(1.7)).toBe("1.5-2");
    expect(rrBand(6)).toBe(">=5");
  });
});

describe("isoWeek + bucketByWeek", () => {
  test("isoWeek labels a known instant", () => {
    // 2026-06-11 is a Thursday in ISO week 24.
    expect(isoWeek(Date.parse("2026-06-11T12:00:00Z") / 1000)).toBe("2026-W24");
  });
  test("buckets occurrences by week with distinct-session denominators", () => {
    const w24 = Date.parse("2026-06-11T00:00:00Z") / 1000;
    const w25 = Date.parse("2026-06-18T00:00:00Z") / 1000;
    const buckets = bucketByWeek([
      { ts: w24, session_id: "a" },
      { ts: w24, session_id: "a" }, // same session → denom stays 1
      { ts: w25, session_id: "b" },
    ]);
    expect(buckets).toEqual([
      { week: "2026-W24", hits: 2, sessions: 1 },
      { week: "2026-W25", hits: 1, sessions: 1 },
    ]);
  });
});

// ===========================================================================
// Pure: detectors
// ===========================================================================

describe("detectTrendDigest", () => {
  test("emits one per-week digest conforming to the Finding contract", () => {
    const [f] = detectTrendDigest(trendInput({}));
    expect(f.category).toBe("trend-digest");
    expect(f.key).toBe("trend-digest:weekly:helptailing:2026-W24");
    expect(f.severity).toBe("info");
    expect(typeof f.fingerprint).toBe("string");
    expect(f.evidence.rate_ratio).toBe(1);
    expect(f.evidence.weekly_buckets).toEqual([
      { week: "2026-W24", hits: 10, sessions: 5 },
    ]);
  });

  test("zero epoch → RR null, no division by zero", () => {
    const [f] = detectTrendDigest(
      trendInput({ epoch: { hits: 0, sessions: 0 }, weeks: [] }),
    );
    expect(f.evidence.rate_ratio).toBe(null);
    expect(f.detail).toContain("n/a");
  });

  test("below the raw floor sets insufficient_data (annotation, not a gate)", () => {
    const [f] = detectTrendDigest(
      trendInput({ epoch: { hits: 3, sessions: 2 } }),
    );
    expect(f.evidence.insufficient_data).toBe(true);
  });

  test("per-period key is stable across content for the same week", () => {
    const a = detectTrendDigest(
      trendInput({ epoch: { hits: 4, sessions: 2 } }),
    );
    const b = detectTrendDigest(
      trendInput({ epoch: { hits: 9, sessions: 3 } }),
    );
    expect(a[0].key).toBe(b[0].key);
    expect(a[0].fingerprint).toBe(b[0].fingerprint);
  });
});

describe("detectRateSpike", () => {
  test("fires when floor + Garwood CI gate both clear", () => {
    const out = detectRateSpike(
      trendInput({ epoch: { hits: 40, sessions: 4 } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("rate-spike");
    expect(out[0].severity).toBe("warning");
    expect(out[0].evidence.rr_ci_lower).toBeGreaterThan(1.5);
  });

  test("below the raw floor → no spike", () => {
    expect(
      detectRateSpike(trendInput({ epoch: { hits: 4, sessions: 1 } })),
    ).toHaveLength(0);
  });

  test("above the floor but flat rate → no spike", () => {
    expect(
      detectRateSpike(trendInput({ epoch: { hits: 10, sessions: 5 } })),
    ).toHaveLength(0);
  });

  test("fingerprint folds the RR band (re-emits only on band change)", () => {
    const lowBand = detectRateSpike(
      trendInput({ epoch: { hits: 30, sessions: 4 } }),
    );
    const highBand = detectRateSpike(
      trendInput({ epoch: { hits: 200, sessions: 4 } }),
    );
    expect(lowBand[0].evidence.rr_band).not.toBe(highBand[0].evidence.rr_band);
    expect(lowBand[0].fingerprint).not.toBe(highBand[0].fingerprint);
  });
});

// ===========================================================================
// Pure: followup rendering (frontmatter canonical, injection-safe)
// ===========================================================================

describe("renderFollowup + filename", () => {
  const finding: Finding = {
    key: "trend-digest:weekly:helptailing:2026-W24",
    fingerprint: "12345",
    severity: "info",
    category: "trend-digest",
    title: "weekly trend",
    detail: "epoch vs baseline",
    evidence: { rate_ratio: 0.95 },
  };

  test("frontmatter carries the four canonical fields", () => {
    const body = renderFollowup(finding, "2026-06-11T00:00:00Z");
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain("fingerprint: '12345'");
    expect(body).toContain("category: 'trend-digest'");
    expect(body).toContain("severity: 'info'");
    expect(body).toContain("key: 'trend-digest:weekly:helptailing:2026-W24'");
  });

  test("Evidence is fenced and echoes the key", () => {
    const body = renderFollowup(finding, "2026-06-11T00:00:00Z");
    expect(body).toContain("## Evidence");
    expect(body).toContain(
      "key:      trend-digest:weekly:helptailing:2026-W24",
    );
  });

  test("a malicious key cannot break the frontmatter fence", () => {
    const evil: Finding = {
      ...finding,
      key: "x'\n---\ninjected: true\nkey: 'y",
    };
    const body = renderFollowup(evil, "2026-06-11T00:00:00Z");
    // Newlines are stripped and single quotes doubled, so the whole evil value
    // collapses into ONE single-quoted YAML scalar on the `key:` line — it never
    // introduces a second `---` fence or a real top-level YAML key. The
    // frontmatter block is exactly its 6 lines (open fence, 4 keys, close fence).
    const fmEnd = body.indexOf("\n---\n", 4);
    const frontmatter = body.slice(0, fmEnd);
    const lines = frontmatter.split("\n");
    expect(lines[0]).toBe("---");
    // No bare `injected:` key at line start (it lives inside the quoted scalar).
    expect(lines.some((l) => /^injected:/.test(l))).toBe(false);
    // The key line stays a single quoted scalar that swallows the payload.
    expect(frontmatter).toContain("key: 'x'' --- injected: true key: ''y'");
  });

  test("a triple-backtick in evidence cannot break out of the fence", () => {
    const evil: Finding = {
      ...finding,
      detail: "```\n## Injected heading\n```",
    };
    const body = renderFollowup(evil, "2026-06-11T00:00:00Z");
    // Only the two real fences remain (open + close of ## Evidence).
    expect(body.match(/```/g)?.length).toBe(2);
  });

  test("filename is fixed-prefix + sanitized key + sha8", () => {
    const fname = followupFilename(finding, 1_700_000_000);
    expect(fname).toMatch(/^helptailing-1700000000-[0-9a-f]{8}\.md$/);
  });

  test("sanitizeKey strips unsafe chars and caps length", () => {
    expect(sanitizeKey("a:b::c.d")).toBe("a_b_c_d");
    expect(sanitizeKey("x".repeat(300)).length).toBe(150);
  });
});

// ===========================================================================
// DB layer: scan + tick
// ===========================================================================

const seedDeps = (now: number): ScanDeps => {
  const path = resolveBaselinePath();
  return {
    nowSecs: () => now,
    loadBaseline: () => loadBaseline(path),
    // Real persistence so the test exercises the sidecar round-trip.
    saveBaseline: (b: FrozenBaseline) => saveBaseline(path, b),
  };
};

describe("scan (DB layer)", () => {
  test("validateMatch rejects a non-Bash / non-flag match", () => {
    // command present but no flag token.
    expect(
      validateMatch({ ts: 1, session_id: "s", command: "grep 'foo|tail'" }),
    ).toBe(null);
    // null command (json_extract yielded NULL) → rejected.
    expect(validateMatch({ ts: 1, session_id: "s", command: null })).toBe(null);
  });

  test("counts PreToolUse only — a matching Pre+Post pair counts 1", async () => {
    const writer = freshDbFile(dbPath);
    const cmd = bashData("ctl --agent-help | head -5");
    insertEvent(writer.db, {
      ts: AFTER,
      session_id: "s1",
      hook_event: "PreToolUse",
      data: cmd,
    });
    insertEvent(writer.db, {
      ts: AFTER,
      session_id: "s1",
      hook_event: "PostToolUse",
      data: cmd,
    });
    writer.db.close();

    const result = await scan(dbPath, seedDeps(AFTER + 100));
    expect(result.epoch.hits).toBe(1);
  });

  test("the event_blobs COALESCE join sees a relocated blob", async () => {
    const writer = freshDbFile(dbPath);
    insertEvent(writer.db, {
      ts: AFTER,
      session_id: "s1",
      hook_event: "PreToolUse",
      data: bashData("ctl --agent-help | tail -5"),
      relocate: true, // inline data NULLed, blob in event_blobs
    });
    writer.db.close();

    const result = await scan(dbPath, seedDeps(AFTER + 100));
    // Without the COALESCE join this would read 0 (inline data is NULL).
    expect(result.epoch.hits).toBe(1);
    expect(result.findings[0].evidence.pipe_targets).toEqual({
      tail: 1,
      head: 0,
      grep: 0,
      none: 0,
    });
  });

  test("baseline seeded once (pre-boundary) and reused", async () => {
    const writer = freshDbFile(dbPath);
    // Two pre-boundary baseline hits (distinct sessions).
    insertEvent(writer.db, {
      ts: BEFORE,
      session_id: "b1",
      hook_event: "PreToolUse",
      data: bashData("ctl --agent-help | head"),
    });
    insertEvent(writer.db, {
      ts: BEFORE,
      session_id: "b2",
      hook_event: "PreToolUse",
      data: bashData("ctl --agent-help | head"),
    });
    writer.db.close();

    await scan(dbPath, seedDeps(AFTER));
    const baseline = loadBaseline(resolveBaselinePath());
    expect(baseline).not.toBeNull();
    expect((baseline as FrozenBaseline).hits).toBe(2);
    expect((baseline as FrozenBaseline).sessions).toBe(2);
  });

  test("suspect self-check flags a near-undercount seed", async () => {
    const writer = freshDbFile(dbPath);
    // A single low pre-boundary hit (under the suspect floor) → suspect:true.
    insertEvent(writer.db, {
      ts: BEFORE,
      session_id: "b1",
      hook_event: "PreToolUse",
      data: bashData("ctl --agent-help | head"),
    });
    writer.db.close();

    await scan(dbPath, seedDeps(AFTER));
    const baseline = loadBaseline(resolveBaselinePath());
    expect((baseline as FrozenBaseline).suspect).toBe(true);
  });

  test("epoch is recomputed per tick — two scans don't double-count", async () => {
    const writer = freshDbFile(dbPath);
    insertEvent(writer.db, {
      ts: AFTER,
      session_id: "s1",
      hook_event: "PreToolUse",
      data: bashData("ctl --agent-help | head"),
    });
    writer.db.close();

    const deps = seedDeps(AFTER + 100);
    const first = await scan(dbPath, deps);
    const second = await scan(dbPath, deps);
    expect(first.epoch.hits).toBe(1);
    expect(second.epoch.hits).toBe(1); // recomputed, not accumulated
  });
});

describe("tick (followup writes, no notification)", () => {
  test("missing DB → heartbeat-only, no throw", async () => {
    const res = await tick(
      join(tmpDir, "nope.db"),
      seedDeps(AFTER),
      resolveSeenStatePath(),
    );
    expect(res.newCount).toBe(0);
  });

  test("first tick seeds baseline + writes a followup; second is silent", async () => {
    const writer = freshDbFile(dbPath);
    insertEvent(writer.db, {
      ts: AFTER,
      session_id: "s1",
      hook_event: "PreToolUse",
      data: bashData("ctl --agent-help | head"),
    });
    writer.db.close();

    const followups = resolveFollowupsDir();
    const first = await tick(
      dbPath,
      seedDeps(AFTER + 100),
      resolveSeenStatePath(),
      followups,
    );
    expect(first.baselineSeeded).toBe(true);
    expect(first.newCount).toBe(1);
    expect(first.writtenCount).toBe(1);
    expect(existsSync(join(followups, "latest.md"))).toBe(true);

    // A new followup file exists with canonical frontmatter.
    const latest = readFileSync(join(followups, "latest.md"), "utf8");
    expect(latest).toContain("category: 'trend-digest'");

    // Second tick: same finding (same week) → no new write.
    const second = await tick(
      dbPath,
      seedDeps(AFTER + 200),
      resolveSeenStatePath(),
      followups,
    );
    expect(second.baselineSeeded).toBe(false);
    expect(second.newCount).toBe(0);
    expect(second.writtenCount).toBe(0);
  });

  test("seen-state dedups by fingerprint across ticks", async () => {
    const writer = freshDbFile(dbPath);
    insertEvent(writer.db, {
      ts: AFTER,
      session_id: "s1",
      hook_event: "PreToolUse",
      data: bashData("ctl --agent-help | head"),
    });
    writer.db.close();

    await tick(dbPath, seedDeps(AFTER + 100), resolveSeenStatePath());
    const seen = loadSeenState(resolveSeenStatePath());
    expect(Object.keys(seen.fingerprints).length).toBeGreaterThan(0);
  });
});
