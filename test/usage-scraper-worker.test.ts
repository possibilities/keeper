/**
 * Unit pins for the usage-scraper PRODUCER worker (`src/usage-scraper-worker.ts`,
 * fn-930 `.4`) — the in-process port of agentusage's retired daemon.py. NO real
 * `uv`/PTY: every test drives the pure helpers + the dependency-injected
 * {@link AccountLoop} with a STUB `ScrapeRunner`, a PINNED clock, and a sandboxed
 * `stateDir` under the per-test tmpdir. The real scrape round-trip lives in
 * `.3`'s allowlisted `usage-scrape-runner.slow.test.ts`; this file owns the
 * worker's branch + envelope logic.
 *
 * Covers the task's test notes: idle-skip gate, cooldown gate, envelope assembly
 * + filename parity (`isUsageId` ↔ the consumer's `isUsageFilename`),
 * keep-prior-multiplier on a failed tier read, restart-cheap `next_fetch_at`
 * reload, and the no-throw failure path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageModels } from "../src/usage-models";
import type {
  ScrapeAccount,
  ScrapeResult,
  ScrapeRunner,
} from "../src/usage-scrape-runner";
import {
  type Account,
  AccountLoop,
  type AccountLoopDeps,
  buildAccounts,
  buildEnvelope,
  deriveLiftAt,
  type Envelope,
  forcedScrapeDue,
  isUsageId,
  type LoopClock,
  liftIsInFuture,
  localIsoWithOffset,
  ProfileGate,
  reResolveMultiplier,
  resolveMultiplierOrNull,
  TargetMutex,
} from "../src/usage-scraper-worker";
import { isUsageFilename } from "../src/usage-worker";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "usage-scraper-worker-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// A non-aborting signal — the loop helpers never abort in these single-cycle drives.
const liveSignal = new AbortController().signal;

/** A clock pinned to a fixed instant with a DETERMINISTIC uniform (returns `lo`). */
function fixedClock(nowIso: string): LoopClock {
  const fixed = new Date(nowIso);
  return {
    now: () => new Date(fixed.getTime()),
    monotonic: () => 0,
    uniform: (lo) => lo,
    sleep: async () => {},
  };
}

/** A stub runner returning one canned result, recording every request. */
function stubRunner(
  result: ScrapeResult,
  calls: ScrapeAccount[] = [],
): ScrapeRunner {
  return async (account) => {
    calls.push(account);
    return result;
  };
}

function makeDeps(
  overrides: Partial<AccountLoopDeps> & { stateDir: string; clock: LoopClock },
): AccountLoopDeps {
  return {
    gate: new ProfileGate(overrides.clock),
    targets: new TargetMutex(),
    runScrape: stubRunner({
      kind: "ok",
      no_subscription: false,
      usage: {},
      subscription_active: true,
    }),
    shutdownSignal: liveSignal,
    // Default the in-cycle tier re-resolve at the sandbox home so a cycle test is
    // deterministic on both CI and a dev box with a real `~/.claude-profiles`.
    homeDir: tmpDir,
    ...overrides,
  };
}

function readEnvelope(stateDir: string, id: string): Envelope {
  return JSON.parse(
    readFileSync(join(stateDir, `${id}.json`), "utf8"),
  ) as Envelope;
}

// ---------- pure helpers ----------------------------------------------------

describe("isUsageId ↔ isUsageFilename parity", () => {
  test("an id passes isUsageId iff `<id>.json` passes the consumer's isUsageFilename", () => {
    for (const id of ["default", "codex", "multi-claude-1", "a-b-c", "x9"]) {
      expect(isUsageId(id)).toBe(true);
      expect(isUsageFilename(`${id}.json`)).toBe(true);
    }
    for (const bad of ["Default", "has_underscore", "dot.in", "UPPER", ""]) {
      expect(isUsageId(bad)).toBe(false);
      expect(isUsageFilename(`${bad}.json`)).toBe(false);
    }
  });
});

describe("deriveLiftAt", () => {
  test("returns null with no >=100% window; the soonest resets_at when binding", () => {
    expect(deriveLiftAt(null)).toBeNull();
    expect(
      deriveLiftAt({
        session: { percent_used: 50, resets_at: "2026-01-01T00:00:00Z" },
      }),
    ).toBeNull();
    expect(
      deriveLiftAt({
        session: { percent_used: 100, resets_at: "2026-06-30T00:00:00Z" },
        week: { percent_used: 100, resets_at: "2026-06-29T00:00:00Z" },
      }),
    ).toBe("2026-06-29T00:00:00Z");
  });
});

describe("liftIsInFuture", () => {
  const now = new Date("2026-06-24T12:00:00-04:00");
  test("future tz-aware → true; past → false; naive/garbage → false", () => {
    expect(liftIsInFuture("2026-06-24T13:00:00-04:00", now)).toBe(true);
    expect(liftIsInFuture("2026-06-24T11:00:00-04:00", now)).toBe(false);
    expect(liftIsInFuture("2026-06-24T13:00:00", now)).toBe(false); // naive
    expect(liftIsInFuture("not-a-date", now)).toBe(false);
    expect(liftIsInFuture(123, now)).toBe(false);
  });
});

describe("forcedScrapeDue", () => {
  const now = new Date("2026-06-24T12:00:00-04:00"); // floor is 15m
  test("true past the floor (or absent/garbage), false within — strict at the edge", () => {
    // Older than 15m → force a scrape.
    expect(
      forcedScrapeDue(
        { last_successful_fetch_at: "2026-06-24T11:40:00-04:00" },
        now,
      ),
    ).toBe(true); // 20m
    // Within 15m → let the park/idle gate decide.
    expect(
      forcedScrapeDue(
        { last_successful_fetch_at: "2026-06-24T11:50:00-04:00" },
        now,
      ),
    ).toBe(false); // 10m
    // Exactly at the floor is NOT past it (strict `>`).
    expect(
      forcedScrapeDue(
        { last_successful_fetch_at: "2026-06-24T11:45:00-04:00" },
        now,
      ),
    ).toBe(false); // exactly 15m
    // Never scraped / unparseable / missing → force.
    expect(forcedScrapeDue({ last_successful_fetch_at: null }, now)).toBe(true);
    expect(forcedScrapeDue({ last_successful_fetch_at: "garbage" }, now)).toBe(
      true,
    );
    expect(forcedScrapeDue({}, now)).toBe(true);
  });
});

describe("localIsoWithOffset", () => {
  test("emits an offset-bearing local stamp the consumer trusts (not Z-form)", () => {
    const s = localIsoWithOffset(new Date("2026-06-24T16:00:00.500Z"));
    // tz-aware per the picker's hasTimezone check.
    expect(liftIsInFuture(s, new Date("2000-01-01T00:00:00Z"))).toBe(true);
    expect(s).not.toMatch(/Z$/);
    expect(s).toMatch(/[+-]\d{2}:\d{2}$/);
  });
});

describe("buildEnvelope", () => {
  test("emits the canonical key set with the account's id/target/multiplier", () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 20,
    };
    const env = buildEnvelope(acct, {
      status: "active",
      subscription_active: true,
      account_state: null,
      usage: { session: { percent_used: 5, resets_at: null } },
      lift_at: null,
      last_successful_fetch_at: "2026-06-24T12:00:00-04:00",
      last_skipped_fetch_at: null,
      last_failed_fetch_at: null,
      next_fetch_at: "2026-06-24T12:02:00-04:00",
      error: null,
    });
    expect(Object.keys(env)).toEqual([
      "schema_version",
      "id",
      "target",
      "multiplier",
      "status",
      "subscription_active",
      "account_state",
      "last_successful_fetch_at",
      "last_skipped_fetch_at",
      "last_failed_fetch_at",
      "next_fetch_at",
      "usage",
      "lift_at",
      "error",
    ]);
    expect(env.id).toBe("default");
    expect(env.multiplier).toBe(20);
    expect(env.schema_version).toBe(1);
  });

  test("a null multiplier (boot-time unresolved tier) rides as the key with a null value", () => {
    // The boot resolve returns null when the tier never resolved; the envelope
    // must carry the key (the reducer/UPSERT tolerate null — no schema bump),
    // value null, NOT a collapsed `1x` default and NOT a dropped key.
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: null,
    };
    const env = buildEnvelope(acct, {
      status: "active",
      subscription_active: true,
      account_state: null,
      usage: null,
      lift_at: null,
      last_successful_fetch_at: "2026-06-24T12:00:00-04:00",
      last_skipped_fetch_at: null,
      last_failed_fetch_at: null,
      next_fetch_at: "2026-06-24T12:02:00-04:00",
      error: null,
    });
    expect(Object.keys(env)).toContain("multiplier");
    expect(env.multiplier).toBeNull();
  });
});

// ---------- AccountLoop cycle (stubbed runner, sandboxed root) ---------------

describe("AccountLoop success cycle", () => {
  test("writes an active envelope with a filename passing isUsageFilename + clears the error sidecar", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    const clock = fixedClock("2026-06-24T12:00:00-04:00");
    // Sandbox the in-cycle tier re-resolve so it deterministically keeps 5x.
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_5x");
    // Pre-seed a stale error sidecar to assert it is cleared on success.
    writeFileSync(join(tmpDir, "default.error.json"), "{}");
    const calls: ScrapeAccount[] = [];
    const deps = makeDeps({
      stateDir: tmpDir,
      clock,
      runScrape: stubRunner(
        {
          kind: "ok",
          no_subscription: false,
          usage: {
            session: {
              percent_used: 7,
              resets_at: "2026-06-25T08:00:00-04:00",
            },
          },
          subscription_active: true,
        },
        calls,
      ),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();

    expect(calls).toEqual([{ target: "claude", profile: "default" }]);
    expect(existsSync(join(tmpDir, "default.json"))).toBe(true);
    expect(isUsageFilename("default.json")).toBe(true);
    expect(existsSync(join(tmpDir, "default.error.json"))).toBe(false);

    const env = readEnvelope(tmpDir, "default");
    expect(env.status).toBe("active");
    expect(env.subscription_active).toBe(true);
    expect(env.usage?.session?.percent_used).toBe(7);
    expect(env.last_successful_fetch_at).not.toBeNull();
    // events.jsonl recorded the scrape.
    const events = readFileSync(join(tmpDir, "events.jsonl"), "utf8").trim();
    expect(events).toContain('"event":"scraped"');
  });

  test("no_subscription success → subscription_active false, status active, no usage", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 1,
    };
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      runScrape: stubRunner({ kind: "ok", no_subscription: true }),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();
    const env = readEnvelope(tmpDir, "default");
    expect(env.status).toBe("active");
    expect(env.subscription_active).toBe(false);
    expect(env.account_state).toBe("no_subscription");
    expect(env.usage).toBeNull();
  });

  test("signed_out success → subscription_active null, account_state signed_out, no usage (fn-1007)", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 1,
    };
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      runScrape: stubRunner({ kind: "ok", signed_out: true }),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();
    const env = readEnvelope(tmpDir, "default");
    expect(env.status).toBe("active");
    // Signed-out: no subscription signal is knowable (distinct from no-sub).
    expect(env.subscription_active).toBeNull();
    expect(env.account_state).toBe("signed_out");
    expect(env.usage).toBeNull();
  });
});

describe("AccountLoop failure path (no-throw)", () => {
  test("a runner_failure writes a stale envelope + .error.json, never throws", async () => {
    const acct: Account = {
      id: "codex",
      target: "codex",
      profile: "",
      multiplier: 1,
    };
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      runScrape: stubRunner({
        kind: "runner_failure",
        reason: "timed_out",
        message: "scrape exceeded budget",
        stderr: "",
        exitCode: null,
      }),
    });
    // Must resolve (no throw) — a scrape failure must never reach onerror.
    await new AccountLoop(acct, deps).runCycleNoThrow();
    const env = readEnvelope(tmpDir, "codex");
    expect(env.status).toBe("stale");
    expect(env.error?.type).toBe("runner_failure:timed_out");
    // A runner_failure always classifies as `runner_failed` — on the stale
    // envelope, the verbose sidecar, and the events.jsonl line.
    expect(env.error?.kind).toBe("runner_failed");
    expect(existsSync(join(tmpDir, "codex.error.json"))).toBe(true);
    const sidecar = JSON.parse(
      readFileSync(join(tmpDir, "codex.error.json"), "utf8"),
    );
    expect(sidecar.error_kind).toBe("runner_failed");
    const events = readFileSync(join(tmpDir, "events.jsonl"), "utf8");
    expect(events).toContain('"event":"scrape_failed"');
    expect(events).toContain('"error_kind":"runner_failed"');
  });

  test("v1 parse error (no error_kind) falls back to format_changed", async () => {
    // A v1 `error` arm carries no error_kind; the parser exception family
    // (`*ParseError`) classifies as format drift on the stale envelope.
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      runScrape: stubRunner({
        kind: "error",
        error_type: "ClaudeUsageParseError",
        message: "required label not found: 'Current session'",
        screen_excerpt: ["line1"],
        error_kind: null,
      }),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();
    expect(readEnvelope(tmpDir, "default").error?.kind).toBe("format_changed");
  });

  test("v1 endpoint throttle (no error_kind) falls back to upstream_limited", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      runScrape: stubRunner({
        kind: "error",
        error_type: "ClaudeUsageEndpointRateLimited",
        message: "claude /usage endpoint is rate limited — retry later",
        screen_excerpt: [],
        error_kind: null,
      }),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();
    expect(readEnvelope(tmpDir, "default").error?.kind).toBe(
      "upstream_limited",
    );
  });

  test("an unclassified v1 crash falls back to scrape_failed", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      runScrape: stubRunner({
        kind: "error",
        error_type: "RuntimeError",
        message: "the TUI binary was not found",
        screen_excerpt: [],
        error_kind: null,
      }),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();
    expect(readEnvelope(tmpDir, "default").error?.kind).toBe("scrape_failed");
  });

  test("a v2 error arm's explicit error_kind reaches the stale envelope", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      runScrape: stubRunner({
        kind: "error",
        error_type: "ClaudeUsageParseError",
        message: "panel never rendered",
        screen_excerpt: ["line1"],
        error_kind: "panel_missing",
      }),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();
    const env = readEnvelope(tmpDir, "default");
    // The v2 contract's own classification wins over any fallback derivation.
    expect(env.error?.kind).toBe("panel_missing");
    const sidecar = JSON.parse(
      readFileSync(join(tmpDir, "default.error.json"), "utf8"),
    );
    expect(sidecar.error_kind).toBe("panel_missing");
  });

  test("Claude /usage endpoint throttle backs off for 15m", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 1,
    };
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      runScrape: stubRunner({
        kind: "error",
        error_type: "ClaudeUsageEndpointRateLimited",
        message: "claude /usage endpoint is rate limited — retry later",
        screen_excerpt: [],
        error_kind: null,
      }),
    });

    const delay = await new AccountLoop(acct, deps).runCycleNoThrow();
    const env = readEnvelope(tmpDir, "default");
    const events = readFileSync(join(tmpDir, "events.jsonl"), "utf8");

    expect(delay).toBe(15 * 60);
    expect(new Date(env.next_fetch_at).getTime()).toBe(
      new Date("2026-06-24T12:15:00-04:00").getTime(),
    );
    expect(events).toContain('"error_type":"ClaudeUsageEndpointRateLimited"');
    expect(events).toContain('"next_fetch_at"');
  });

  test("failure preserves prior last-good usage/subscription on the stale envelope", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    // Prior active envelope with good usage.
    const prior = buildEnvelope(acct, {
      status: "active",
      subscription_active: true,
      account_state: null,
      usage: { session: { percent_used: 3, resets_at: null } },
      lift_at: null,
      last_successful_fetch_at: "2026-06-24T11:00:00-04:00",
      last_skipped_fetch_at: null,
      last_failed_fetch_at: null,
      next_fetch_at: "2026-06-24T11:02:00-04:00",
      error: null,
    });
    writeFileSync(join(tmpDir, "default.json"), JSON.stringify(prior, null, 2));
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      runScrape: stubRunner({
        kind: "error",
        error_type: "ClaudeUsageParseError",
        message: "drift",
        screen_excerpt: ["line1", "line2"],
        error_kind: null,
      }),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();
    const env = readEnvelope(tmpDir, "default");
    expect(env.status).toBe("stale");
    expect(env.usage?.session?.percent_used).toBe(3); // last-good preserved
    expect(env.subscription_active).toBe(true);
    expect(env.last_successful_fetch_at).toBe("2026-06-24T11:00:00-04:00");
    // The verbose sidecar keeps the screen excerpt.
    const sidecar = JSON.parse(
      readFileSync(join(tmpDir, "default.error.json"), "utf8"),
    );
    expect(sidecar.screen_excerpt).toEqual(["line1", "line2"]);
  });
});

describe("AccountLoop idle gate", () => {
  test("skips the scrape + writes an idle heartbeat when no agent log moved within the window", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    // Sandbox the in-cycle tier re-resolve so it deterministically keeps 5x.
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_5x");
    // Prior non-stale envelope so the gate engages (the gate only runs with a prior).
    writeFileSync(
      join(tmpDir, "default.json"),
      JSON.stringify(
        buildEnvelope(acct, {
          status: "active",
          subscription_active: true,
          account_state: null,
          usage: { session: { percent_used: 4, resets_at: null } },
          lift_at: null,
          last_successful_fetch_at: "2026-06-24T11:50:00-04:00",
          last_skipped_fetch_at: null,
          last_failed_fetch_at: null,
          next_fetch_at: "2026-06-24T11:02:00-04:00",
          error: null,
        }),
        null,
        2,
      ),
    );
    const calls: ScrapeAccount[] = [];
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      // Force idle: last activity is the epoch (far past the 15-min window).
      latestActivity: () => 0,
      runScrape: stubRunner(
        {
          kind: "ok",
          no_subscription: false,
          usage: {},
          subscription_active: true,
        },
        calls,
      ),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();
    // The scrape was SKIPPED.
    expect(calls).toHaveLength(0);
    const env = readEnvelope(tmpDir, "default");
    expect(env.status).toBe("idle");
    expect(env.last_skipped_fetch_at).not.toBeNull();
    // last-good usage rides forward via the heartbeat.
    expect(env.usage?.session?.percent_used).toBe(4);
    const events = readFileSync(join(tmpDir, "events.jsonl"), "utf8");
    expect(events).toContain('"event":"idle_skipped"');
  });

  test("scrapes (no idle skip) when an agent log moved recently", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    writeFileSync(
      join(tmpDir, "default.json"),
      JSON.stringify(
        buildEnvelope(acct, {
          status: "active",
          subscription_active: true,
          account_state: null,
          usage: {},
          lift_at: null,
          last_successful_fetch_at: null,
          last_skipped_fetch_at: null,
          last_failed_fetch_at: null,
          next_fetch_at: "2026-06-24T11:02:00-04:00",
          error: null,
        }),
        null,
        2,
      ),
    );
    const calls: ScrapeAccount[] = [];
    const nowSec = new Date("2026-06-24T12:00:00-04:00").getTime() / 1000;
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      latestActivity: () => nowSec, // active right now
      runScrape: stubRunner(
        {
          kind: "ok",
          no_subscription: false,
          usage: {},
          subscription_active: true,
        },
        calls,
      ),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();
    expect(calls).toHaveLength(1);
    expect(readEnvelope(tmpDir, "default").status).toBe("active");
  });
});

describe("AccountLoop cooldown gate", () => {
  test("skips when the prior lift_at is in the future; re-checks past the lift", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    // Sandbox the in-cycle tier re-resolve so it deterministically keeps 5x.
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_5x");
    // Prior envelope with a future lift_at.
    writeFileSync(
      join(tmpDir, "default.json"),
      JSON.stringify(
        buildEnvelope(acct, {
          status: "active",
          subscription_active: true,
          account_state: null,
          usage: {
            session: {
              percent_used: 100,
              resets_at: "2026-06-24T13:00:00-04:00",
            },
          },
          lift_at: "2026-06-24T13:00:00-04:00",
          last_successful_fetch_at: "2026-06-24T11:50:00-04:00",
          last_skipped_fetch_at: null,
          last_failed_fetch_at: null,
          next_fetch_at: "2026-06-24T11:02:00-04:00",
          error: null,
        }),
        null,
        2,
      ),
    );
    const calls: ScrapeAccount[] = [];
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"), // before the 13:00 lift
      latestActivity: () =>
        new Date("2026-06-24T12:00:00-04:00").getTime() / 1000,
      runScrape: stubRunner(
        {
          kind: "ok",
          no_subscription: false,
          usage: {},
          subscription_active: true,
        },
        calls,
      ),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();
    expect(calls).toHaveLength(0); // cooldown skip — no scrape
    const env = readEnvelope(tmpDir, "default");
    expect(env.status).toBe("idle");
    expect(env.lift_at).toBe("2026-06-24T13:00:00-04:00"); // carried forward
    const events = readFileSync(join(tmpDir, "events.jsonl"), "utf8");
    expect(events).toContain('"event":"rate_limited_skipped"');
  });

  test("a stale prior envelope bypasses the gates (keeps retrying through quiet periods)", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    // Stale prior with a future lift_at — the gate must NOT honor it.
    writeFileSync(
      join(tmpDir, "default.json"),
      JSON.stringify(
        buildEnvelope(acct, {
          status: "stale",
          subscription_active: true,
          account_state: null,
          usage: {},
          lift_at: "2026-06-24T13:00:00-04:00",
          last_successful_fetch_at: null,
          last_skipped_fetch_at: null,
          last_failed_fetch_at: "2026-06-24T11:00:00-04:00",
          next_fetch_at: "2026-06-24T11:02:00-04:00",
          error: {
            type: "X",
            message: "y",
            at: "2026-06-24T11:00:00-04:00",
            kind: null,
          },
        }),
        null,
        2,
      ),
    );
    const calls: ScrapeAccount[] = [];
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      latestActivity: () => 0, // even idle — but stale must still scrape
      runScrape: stubRunner(
        {
          kind: "ok",
          no_subscription: false,
          usage: {},
          subscription_active: true,
        },
        calls,
      ),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();
    expect(calls).toHaveLength(1); // scraped despite future lift + idle
    expect(readEnvelope(tmpDir, "default").status).toBe("active");
  });
});

describe("AccountLoop freshness floor", () => {
  // A prior parked at a future lift AND idle — both skip gates would normally hold.
  // Only the last SUCCESSFUL scrape's age decides whether the floor forces a scrape.
  function writeParkedPrior(lastSuccess: string): void {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_5x");
    writeFileSync(
      join(tmpDir, "default.json"),
      JSON.stringify(
        buildEnvelope(acct, {
          status: "idle",
          subscription_active: true,
          account_state: null,
          usage: {
            session: {
              percent_used: 100,
              resets_at: "2026-06-25T00:00:00-04:00",
            },
          },
          lift_at: "2026-06-25T00:00:00-04:00", // a day out → cooldown would park
          last_successful_fetch_at: lastSuccess,
          last_skipped_fetch_at: null,
          last_failed_fetch_at: null,
          next_fetch_at: "2026-06-24T11:31:00-04:00",
          error: null,
        }),
        null,
        2,
      ),
    );
  }

  test("a parked+idle profile past the 15m floor scrapes despite a future lift_at", async () => {
    writeParkedPrior("2026-06-24T11:40:00-04:00"); // 20m before the clock → past floor
    const calls: ScrapeAccount[] = [];
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      latestActivity: () => 0, // idle too — the floor must bypass BOTH gates
      runScrape: stubRunner(
        {
          kind: "ok",
          no_subscription: false,
          usage: {},
          subscription_active: true,
        },
        calls,
      ),
    });
    await new AccountLoop(
      { id: "default", target: "claude", profile: "default", multiplier: 5 },
      deps,
    ).runCycleNoThrow();
    // The floor forced a real scrape past the cooldown + idle gates: a provider-side
    // reset before the derived lift is caught here instead of days later.
    expect(calls).toHaveLength(1);
    expect(readEnvelope(tmpDir, "default").status).toBe("active");
  });

  test("a parked profile still WITHIN the 15m floor keeps parking (no scrape)", async () => {
    writeParkedPrior("2026-06-24T11:50:00-04:00"); // 10m before the clock → within floor
    const calls: ScrapeAccount[] = [];
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      latestActivity: () =>
        new Date("2026-06-24T12:00:00-04:00").getTime() / 1000,
      runScrape: stubRunner(
        {
          kind: "ok",
          no_subscription: false,
          usage: {},
          subscription_active: true,
        },
        calls,
      ),
    });
    await new AccountLoop(
      { id: "default", target: "claude", profile: "default", multiplier: 5 },
      deps,
    ).runCycleNoThrow();
    expect(calls).toHaveLength(0); // within the floor → cooldown park still applies
    expect(readEnvelope(tmpDir, "default").status).toBe("idle");
  });
});

describe("AccountLoop multiplier sub-cadence (parked re-resolve)", () => {
  // A prior envelope at `mult`, parked with a future lift_at so the cooldown gate
  // would normally park the account until the lift.
  function writeParkedPrior(mult: number, lift: string): void {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: mult,
    };
    writeFileSync(
      join(tmpDir, "default.json"),
      JSON.stringify(
        buildEnvelope(acct, {
          status: "active",
          subscription_active: true,
          account_state: null,
          usage: { session: { percent_used: 100, resets_at: lift } },
          lift_at: lift,
          last_successful_fetch_at: "2026-06-24T11:50:00-04:00",
          last_skipped_fetch_at: null,
          last_failed_fetch_at: null,
          next_fetch_at: "2026-06-24T11:02:00-04:00",
          error: null,
        }),
        null,
        2,
      ),
    );
  }

  test("a parked cooldown wake re-resolves + rewrites the multiplier, caps the sleep, no scrape", async () => {
    // In-memory acct is stale at 1x; the config + on-disk envelope both say 20x.
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 1,
    };
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_20x");
    writeParkedPrior(20, "2026-06-25T00:00:00-04:00"); // a day out → parks
    const calls: ScrapeAccount[] = [];
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      latestActivity: () =>
        new Date("2026-06-24T12:00:00-04:00").getTime() / 1000,
      runScrape: stubRunner(
        {
          kind: "ok",
          no_subscription: false,
          usage: {},
          subscription_active: true,
        },
        calls,
      ),
    });
    const sleepSec = await new AccountLoop(acct, deps).runCycleNoThrow();

    expect(calls).toHaveLength(0); // parked → no network scrape
    // The day-long cooldown sleep is capped to the ~60s poll window.
    expect(sleepSec).toBeGreaterThan(0);
    expect(sleepSec).toBe(60);
    const env = readEnvelope(tmpDir, "default");
    expect(env.status).toBe("idle");
    expect(env.multiplier).toBe(20); // re-resolved 1 → 20 on a no-scrape wake
  });

  test("a multiplier change vs the on-disk prior bypasses both gates → full scrape", async () => {
    // Boot already corrected acct to 20x (the 16MB fix); the on-disk envelope is
    // FROZEN at 1x with a future lift AND the account is idle — both gates must yield.
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 20,
    };
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_20x");
    writeParkedPrior(1, "2026-06-25T00:00:00-04:00");
    const calls: ScrapeAccount[] = [];
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      latestActivity: () => 0, // idle too — must still be bypassed
      runScrape: stubRunner(
        {
          kind: "ok",
          no_subscription: false,
          usage: {},
          subscription_active: true,
        },
        calls,
      ),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();

    expect(calls).toHaveLength(1); // the change forced a scrape past both gates
    const env = readEnvelope(tmpDir, "default");
    expect(env.status).toBe("active");
    expect(env.multiplier).toBe(20); // the corrected tier reached the envelope
  });

  test("a numeric→null change (tier went unresolvable) bypasses both gates → full scrape", async () => {
    // The on-disk prior is a known 20x; on restart the tier no longer resolves
    // (no `.claude.json`), so keep-prior leaves the carrier null. A 20→null
    // downgrade-to-unknown is a genuine change and must force a scrape so the
    // `?x` lands at once, NOT sit parked behind the idle/cooldown gates.
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: null,
    };
    // NB: no writeProfileClaudeJson → the per-cycle re-resolve stays null.
    writeParkedPrior(20, "2026-06-25T00:00:00-04:00");
    const calls: ScrapeAccount[] = [];
    const deps = makeDeps({
      stateDir: tmpDir,
      clock: fixedClock("2026-06-24T12:00:00-04:00"),
      latestActivity: () => 0, // idle too — must still be bypassed
      runScrape: stubRunner(
        {
          kind: "ok",
          no_subscription: false,
          usage: {},
          subscription_active: true,
        },
        calls,
      ),
    });
    await new AccountLoop(acct, deps).runCycleNoThrow();

    expect(calls).toHaveLength(1); // 20 → null forced a scrape past both gates
    const env = readEnvelope(tmpDir, "default");
    expect(env.status).toBe("active");
    expect(env.multiplier).toBeNull(); // the unresolved tier reached the envelope
  });

  test("a >interval no-scrape sleep is capped, but a post-scrape failure backoff is not", async () => {
    // (1) No-scrape: a week-out cooldown lift is capped to the poll window.
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_5x");
    writeParkedPrior(5, "2026-07-01T00:00:00-04:00"); // a WEEK out
    const noScrapeSleep = await new AccountLoop(
      { id: "default", target: "claude", profile: "default", multiplier: 5 },
      makeDeps({
        stateDir: tmpDir,
        clock: fixedClock("2026-06-24T12:00:00-04:00"),
        latestActivity: () =>
          new Date("2026-06-24T12:00:00-04:00").getTime() / 1000,
      }),
    ).runCycleNoThrow();
    expect(noScrapeSleep).toBe(60); // capped — NOT the week-long lift

    // (2) Post-scrape: the /usage rate-limit backoff stays at its full 15m, uncapped.
    const failingDir = mkdtempSync(join(tmpdir(), "usage-scraper-cap-"));
    try {
      const failed = await new AccountLoop(
        { id: "default", target: "claude", profile: "default", multiplier: 5 },
        makeDeps({
          stateDir: failingDir,
          clock: fixedClock("2026-06-24T12:00:00-04:00"),
          runScrape: stubRunner({
            kind: "error",
            error_type: "ClaudeUsageEndpointRateLimited",
            message: "rate limited",
            screen_excerpt: [],
            error_kind: null,
          }),
        }),
      ).runCycleNoThrow();
      expect(failed).toBe(15 * 60); // far above the cap → not capped
    } finally {
      rmSync(failingDir, { recursive: true, force: true });
    }
  });

  test("a redundant parked wake (already idle, same multiplier) suppresses the re-write + event", async () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_5x");
    // Prior is ALREADY an idle heartbeat at 5x with a future lift — a parked wake.
    writeFileSync(
      join(tmpDir, "default.json"),
      JSON.stringify(
        buildEnvelope(acct, {
          status: "idle",
          subscription_active: true,
          account_state: null,
          usage: {
            session: {
              percent_used: 100,
              resets_at: "2026-06-25T00:00:00-04:00",
            },
          },
          lift_at: "2026-06-25T00:00:00-04:00",
          last_successful_fetch_at: "2026-06-24T11:50:00-04:00",
          last_skipped_fetch_at: "2026-06-24T11:30:00-04:00",
          last_failed_fetch_at: null,
          next_fetch_at: "2026-06-24T11:31:00-04:00",
          error: null,
        }),
        null,
        2,
      ),
    );
    const before = readFileSync(join(tmpDir, "default.json"), "utf8");
    const sleepSec = await new AccountLoop(
      acct,
      makeDeps({
        stateDir: tmpDir,
        clock: fixedClock("2026-06-24T12:00:00-04:00"),
        latestActivity: () =>
          new Date("2026-06-24T12:00:00-04:00").getTime() / 1000,
      }),
    ).runCycleNoThrow();

    // Re-polls within the window, but the envelope is byte-identical (no churn) and
    // no events line was appended — a multi-day park doesn't grow the log.
    expect(readFileSync(join(tmpDir, "default.json"), "utf8")).toBe(before);
    expect(existsSync(join(tmpDir, "events.jsonl"))).toBe(false);
    expect(sleepSec).toBe(60);
  });

  test("resolveMultiplierOrNull skips the re-parse when size+mtime are unchanged", () => {
    const dir = profileClaudeJsonDir(tmpDir, "default");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, ".claude.json");
    // Two payloads of IDENTICAL byte length so only mtime (not size) can differ:
    // the 20x tier is one char longer than 5x, offset by a 1-char pad on the 5x.
    const json20 = JSON.stringify({
      oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" },
      pad: "",
    });
    const json5 = JSON.stringify({
      oauthAccount: { organizationRateLimitTier: "default_claude_max_5x" },
      pad: "x",
    });
    expect(json20.length).toBe(json5.length);

    const pinned = new Date("2026-06-01T00:00:00Z");
    writeFileSync(path, json20);
    utimesSync(path, pinned, pinned);
    expect(resolveMultiplierOrNull("default", tmpDir)).toBe(20); // memoized

    // Rewrite to 5x but PIN the same mtime → the memo short-circuits the re-parse.
    writeFileSync(path, json5);
    utimesSync(path, pinned, pinned);
    expect(resolveMultiplierOrNull("default", tmpDir)).toBe(20); // stale memo wins

    // Bump the mtime → the memo invalidates and the new tier resolves.
    const bumped = new Date("2026-06-02T00:00:00Z");
    utimesSync(path, bumped, bumped);
    expect(resolveMultiplierOrNull("default", tmpDir)).toBe(5);
  });
});

describe("AccountLoop restart-cheap initial delay", () => {
  test("sleeps out a prior future next_fetch_at; cold-boot jitter otherwise", () => {
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 5,
    };
    const clock = fixedClock("2026-06-24T12:00:00-04:00");
    const deps = makeDeps({ stateDir: tmpDir, clock });
    // No prior file → cold-boot jitter (uniform stub returns lo=0).
    expect(new AccountLoop(acct, deps).initialDelaySeconds()).toBe(0);
    // Prior with a future next_fetch_at (120s out) → capped to the multiplier poll
    // window so a restart re-resolves within ~60s, not after the full cooldown.
    writeFileSync(
      join(tmpDir, "default.json"),
      JSON.stringify({ next_fetch_at: "2026-06-24T12:02:00-04:00" }),
    );
    const remaining = new AccountLoop(acct, deps).initialDelaySeconds();
    expect(remaining).toBeCloseTo(60, 0);
  });
});

describe("ProfileGate / TargetMutex serialization", () => {
  test("the target mutex runs same-target tasks one at a time", async () => {
    const targets = new TargetMutex();
    const order: string[] = [];
    const a = targets.run("claude", async () => {
      order.push("a-start");
      await Promise.resolve();
      order.push("a-end");
    });
    const b = targets.run("claude", async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([a, b]);
    // b never interleaves into a's window.
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("the profile gate hands out a release and bumps the next-allowed instant", async () => {
    const clock = fixedClock("2026-06-24T12:00:00-04:00");
    const gate = new ProfileGate(clock);
    const release = await gate.acquire(liveSignal);
    expect(typeof release).toBe("function");
    release();
  });
});

// Directory holding a profile's `.claude.json`. Mirrors production: `default`
// lives in `~/.claude`, every other profile in `~/.claude-profiles/<profile>`.
function profileClaudeJsonDir(home: string, profile: string): string {
  return profile === "default"
    ? join(home, ".claude")
    : join(home, ".claude-profiles", profile);
}

// Write the profile's `.claude.json` with the given tier, padded past `padBytes`
// so the size guard is exercised against a realistic file.
function writeProfileClaudeJson(
  home: string,
  profile: string,
  tier: string | null,
  padBytes = 0,
): void {
  const dir = profileClaudeJsonDir(home, profile);
  mkdirSync(dir, { recursive: true });
  const body: Record<string, unknown> = {
    oauthAccount: tier === null ? {} : { organizationRateLimitTier: tier },
    _pad: "x".repeat(padBytes),
  };
  writeFileSync(join(dir, ".claude.json"), JSON.stringify(body));
}

describe("resolveMultiplierOrNull (injected home seam)", () => {
  test("resolves a >1 MB valid .claude.json to the correct multiplier", () => {
    writeProfileClaudeJson(
      tmpDir,
      "default",
      "default_claude_max_20x",
      2 * 1024 * 1024,
    );
    const path = join(profileClaudeJsonDir(tmpDir, "default"), ".claude.json");
    // The file is genuinely past the old 1 MB cap that froze multipliers at 1x.
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(1024 * 1024);
    expect(resolveMultiplierOrNull("default", tmpDir)).toBe(20);
  });

  test("maps the 5x tier and returns null on an unknown/missing tier", () => {
    writeProfileClaudeJson(tmpDir, "multi-claude-1", "default_claude_max_5x");
    expect(resolveMultiplierOrNull("multi-claude-1", tmpDir)).toBe(5);
    writeProfileClaudeJson(tmpDir, "mystery", "default_claude_ultra_99x");
    expect(resolveMultiplierOrNull("mystery", tmpDir)).toBeNull();
    expect(resolveMultiplierOrNull("absent", tmpDir)).toBeNull();
  });

  test("`default` reads ~/.claude, NOT the ~/.claude-profiles/default shadow", () => {
    // The shadow dir holds 20x; the canonical ~/.claude holds 5x. The split-brain
    // bug read the shadow — the fix must read ~/.claude.
    mkdirSync(join(tmpDir, ".claude-profiles", "default"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".claude-profiles", "default", ".claude.json"),
      JSON.stringify({
        oauthAccount: { organizationRateLimitTier: "default_claude_max_20x" },
      }),
    );
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".claude", ".claude.json"),
      JSON.stringify({
        oauthAccount: { organizationRateLimitTier: "default_claude_max_5x" },
      }),
    );
    expect(resolveMultiplierOrNull("default", tmpDir)).toBe(5);
  });

  test("a signed-out ~/.claude (no oauthAccount) resolves `default` to null", () => {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".claude", ".claude.json"),
      JSON.stringify({ someOtherKey: true }),
    );
    expect(resolveMultiplierOrNull("default", tmpDir)).toBeNull();
  });
});

describe("buildAccounts (declared usage_models registry)", () => {
  test("one claude Account per declared id, multiplier tier-derived, codex appended when declared", () => {
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_20x");
    writeProfileClaudeJson(tmpDir, "multi-claude-1", "default_claude_max_5x");
    const models: UsageModels = {
      default: "claude-0",
      "multi-claude-1": null,
      codex: "gpt",
    };
    expect(buildAccounts(models, tmpDir)).toEqual([
      { id: "default", target: "claude", profile: "default", multiplier: 20 },
      {
        id: "multi-claude-1",
        target: "claude",
        profile: "multi-claude-1",
        multiplier: 5,
      },
      { id: "codex", target: "codex", profile: "", multiplier: 1 },
    ]);
  });

  test("an empty registry yields no accounts (the worker idles — no implicit codex)", () => {
    expect(buildAccounts({}, tmpDir)).toEqual([]);
  });

  test("codex is NOT appended when it is not declared", () => {
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_5x");
    const models: UsageModels = { default: null };
    expect(buildAccounts(models, tmpDir)).toEqual([
      { id: "default", target: "claude", profile: "default", multiplier: 5 },
    ]);
  });

  test("a codex-only registry yields only the codex account", () => {
    expect(buildAccounts({ codex: null }, tmpDir)).toEqual([
      { id: "codex", target: "codex", profile: "", multiplier: 1 },
    ]);
  });

  test("an unresolvable tier carries a null multiplier (renders ?x, no downgrade)", () => {
    // No .claude.json for `default` → resolveMultiplierOrNull returns null.
    expect(buildAccounts({ default: null }, tmpDir)).toEqual([
      { id: "default", target: "claude", profile: "default", multiplier: null },
    ]);
  });
});

describe("reResolveMultiplier episode-throttled warning", () => {
  test("logs once across consecutive failures and re-arms after a recovery", () => {
    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: 20,
    };

    // No .claude.json yet → resolve fails: keep prior 20x, log exactly once.
    reResolveMultiplier(acct, tmpDir, log);
    expect(acct.multiplier).toBe(20);
    expect(acct.tierResolveFailed).toBe(true);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("default");
    expect(logs[0]).toContain("20");

    // Second consecutive failure: still kept, no new log (episode throttle).
    reResolveMultiplier(acct, tmpDir, log);
    expect(acct.multiplier).toBe(20);
    expect(logs.length).toBe(1);

    // Recovery re-arms the warning and clears the flag.
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_5x");
    reResolveMultiplier(acct, tmpDir, log);
    expect(acct.multiplier).toBe(5);
    expect(acct.tierResolveFailed).toBe(false);
    expect(logs.length).toBe(1);

    // A subsequent failure logs again (the episode re-opened).
    rmSync(profileClaudeJsonDir(tmpDir, "default"), {
      recursive: true,
      force: true,
    });
    reResolveMultiplier(acct, tmpDir, log);
    expect(acct.multiplier).toBe(5);
    expect(acct.tierResolveFailed).toBe(true);
    expect(logs.length).toBe(2);
  });

  test("a boot-null prior keeps null over a failed re-read and never logs the literal `nullx`", () => {
    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);
    // Boot resolved to null (tier never resolved), so the carrier starts null.
    const acct: Account = {
      id: "default",
      target: "claude",
      profile: "default",
      multiplier: null,
    };
    // No .claude.json → the re-read fails again; keep-prior keeps null, log once.
    reResolveMultiplier(acct, tmpDir, log);
    expect(acct.multiplier).toBeNull();
    expect(acct.tierResolveFailed).toBe(true);
    expect(logs.length).toBe(1);
    // The warning surfaces the unresolved sentinel, never the literal `nullx`.
    expect(logs[0]).not.toContain("nullx");
    expect(logs[0]).toContain("?x");

    // A later recovery still adopts the resolved tier (keep-prior is not sticky).
    writeProfileClaudeJson(tmpDir, "default", "default_claude_max_20x");
    reResolveMultiplier(acct, tmpDir, log);
    expect(acct.multiplier).toBe(20);
    expect(acct.tierResolveFailed).toBe(false);
  });
});
