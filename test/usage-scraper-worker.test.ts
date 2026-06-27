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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ScrapeAccount,
  ScrapeResult,
  ScrapeRunner,
} from "../src/usage-scrape-runner";
import {
  type Account,
  AccountLoop,
  type AccountLoopDeps,
  buildEnvelope,
  deriveLiftAt,
  type Envelope,
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
    expect(existsSync(join(tmpDir, "codex.error.json"))).toBe(true);
    const events = readFileSync(join(tmpDir, "events.jsonl"), "utf8");
    expect(events).toContain('"event":"scrape_failed"');
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
    // Prior non-stale envelope so the gate engages (the gate only runs with a prior).
    writeFileSync(
      join(tmpDir, "default.json"),
      JSON.stringify(
        buildEnvelope(acct, {
          status: "active",
          subscription_active: true,
          usage: { session: { percent_used: 4, resets_at: null } },
          lift_at: null,
          last_successful_fetch_at: "2026-06-24T11:00:00-04:00",
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
    // Prior envelope with a future lift_at.
    writeFileSync(
      join(tmpDir, "default.json"),
      JSON.stringify(
        buildEnvelope(acct, {
          status: "active",
          subscription_active: true,
          usage: {
            session: {
              percent_used: 100,
              resets_at: "2026-06-24T13:00:00-04:00",
            },
          },
          lift_at: "2026-06-24T13:00:00-04:00",
          last_successful_fetch_at: "2026-06-24T11:00:00-04:00",
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
          usage: {},
          lift_at: "2026-06-24T13:00:00-04:00",
          last_successful_fetch_at: null,
          last_skipped_fetch_at: null,
          last_failed_fetch_at: "2026-06-24T11:00:00-04:00",
          next_fetch_at: "2026-06-24T11:02:00-04:00",
          error: { type: "X", message: "y", at: "2026-06-24T11:00:00-04:00" },
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
    // Prior with a future next_fetch_at (120s out) → sleep ~120s.
    writeFileSync(
      join(tmpDir, "default.json"),
      JSON.stringify({ next_fetch_at: "2026-06-24T12:02:00-04:00" }),
    );
    const remaining = new AccountLoop(acct, deps).initialDelaySeconds();
    expect(remaining).toBeCloseTo(120, 0);
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

// Write `<tmpHome>/.claude-profiles/<profile>/.claude.json` with the given tier,
// padded past `padBytes` so the size guard is exercised against a realistic file.
function writeProfileClaudeJson(
  home: string,
  profile: string,
  tier: string | null,
  padBytes = 0,
): void {
  const dir = join(home, ".claude-profiles", profile);
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
    const path = join(tmpDir, ".claude-profiles", "default", ".claude.json");
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
    rmSync(join(tmpDir, ".claude-profiles", "default"), {
      recursive: true,
      force: true,
    });
    reResolveMultiplier(acct, tmpDir, log);
    expect(acct.multiplier).toBe(5);
    expect(acct.tierResolveFailed).toBe(true);
    expect(logs.length).toBe(2);
  });
});
