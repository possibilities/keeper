/**
 * Behavior pins for the dumb credit-weighted picker (`src/usage-picker.ts`),
 * vendored from agentusage's `src/api.ts`: rotation, 5x-weighting
 * proportionality, headroom scaling, stale-still-rotates, missing-usage→full-
 * headroom, new-entrant-no-catch-up-burst, over-100 clamp, garbage-multiplier
 * coercion, empty/skip paths, corrupt-state-reset-not-fatal, never-raises-on-
 * unreadable-state-dir, and the rate-limit cooldown (future/past/all-cooling/
 * malformed lift_at). The real multi-process flock-contention test lives in the
 * slow-tier sibling `usage-picker-flock.slow.test.ts`.
 *
 * The picker reads two sources redirected into tmp: per-account envelopes under
 * the state dir (via `setStateDir`) and the catalog at
 * `$XDG_CONFIG_HOME/agentusage/config.yaml` (via the env var). The clock is
 * pinned with `setClock` (the DI seam replacing Python's `_MonotonicClock`).
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
import {
  listProfiles,
  pickProfile,
  resetClock,
  setClock,
  setStateDir,
} from "../src/usage-picker";

let tmpDir: string;
let stateDir: string;
let configHome: string;
let savedXdg: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentusage-picker-"));
  stateDir = join(tmpDir, "state");
  mkdirSync(stateDir);
  configHome = join(tmpDir, "config");
  mkdirSync(join(configHome, "agentusage"), { recursive: true });
  setStateDir(stateDir);
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(() => {
  resetClock();
  if (savedXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedXdg;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- helpers ---------------------------------------------------------

function writeConfig(profiles: string[]): void {
  const yaml = `profiles:\n${profiles.map((p) => `  - ${p}`).join("\n")}\n`;
  writeFileSync(join(configHome, "agentusage", "config.yaml"), yaml);
}

const UNSET = Symbol("unset");

interface EnvelopeOpts {
  subscription_active: unknown;
  target?: string;
  status?: string;
  lift_at?: unknown;
  multiplier?: unknown;
  session_percent?: unknown;
  usage?: unknown;
  error?: unknown;
}

function writeEnvelope(name: string, opts: EnvelopeOpts): void {
  let usage: unknown = opts.usage;
  if (usage === undefined) {
    usage =
      opts.session_percent === undefined
        ? null
        : { session: { percent_used: opts.session_percent } };
  }
  const envelope: Record<string, unknown> = {
    schema_version: 1,
    id: name,
    target: opts.target ?? "claude",
    subscription_active: opts.subscription_active,
    status: opts.status ?? "active",
    usage,
    lift_at: opts.lift_at ?? null,
  };
  if (opts.error !== undefined) {
    envelope.error = opts.error;
  }
  if (opts.multiplier !== undefined && opts.multiplier !== UNSET) {
    envelope.multiplier = opts.multiplier;
  }
  writeFileSync(join(stateDir, `${name}.json`), JSON.stringify(envelope));
}

function readCounts(): Record<string, number> {
  const state = JSON.parse(readFileSync(join(stateDir, "picker.json"), "utf8"));
  const out: Record<string, number> = {};
  for (const [name, entry] of Object.entries(state.picks)) {
    out[name] = (entry as { count: number }).count;
  }
  return out;
}

/** Monotonic clock — strictly increasing stamps, defeats microsecond ties. */
function installMonotonicClock(): void {
  let counter = 0;
  setClock(() => {
    counter += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, counter));
  });
}

/** ISO stamp offset from real `now()` by `seconds`, with explicit tz offset. */
function isoOffset(seconds: number): string {
  const d = new Date(Date.now() + seconds * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  const offStr = `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offStr}`
  );
}

// ---------- rotation --------------------------------------------------------

describe("rotation", () => {
  test("pick rotates round-robin", () => {
    installMonotonicClock();
    writeConfig(["p1", "p2", "p3"]);
    for (const name of ["p1", "p2", "p3"]) {
      writeEnvelope(name, { subscription_active: true });
    }

    const picks = Array.from({ length: 6 }, () => pickProfile());

    expect(new Set(picks.slice(0, 3))).toEqual(new Set(["p1", "p2", "p3"]));
    expect(readCounts()).toEqual({ p1: 2, p2: 2, p3: 2 });
  });

  test("stale account still rotates", () => {
    installMonotonicClock();
    writeConfig(["p1", "p2"]);
    writeEnvelope("p1", { subscription_active: true, status: "active" });
    writeEnvelope("p2", { subscription_active: true, status: "stale" });

    const picks = new Set(Array.from({ length: 4 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["p1", "p2"]));
  });

  test("stale Claude /usage endpoint throttle is skipped", () => {
    installMonotonicClock();
    writeConfig(["ok", "throttled"]);
    writeEnvelope("ok", { subscription_active: true, status: "active" });
    writeEnvelope("throttled", {
      subscription_active: true,
      status: "stale",
      error: {
        type: "ClaudeUsageEndpointRateLimited",
        message: "retry later",
        at: isoOffset(-60),
      },
    });

    const picks = new Set(Array.from({ length: 4 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["ok"]));
  });
});

// ---------- weighted balancing ----------------------------------------------

describe("weighted balancing", () => {
  test("5x picked five times as often at equal headroom", () => {
    installMonotonicClock();
    writeConfig(["pro", "max5"]);
    writeEnvelope("pro", { subscription_active: true, multiplier: 1 });
    writeEnvelope("max5", { subscription_active: true, multiplier: 5 });

    for (let i = 0; i < 600; i++) {
      pickProfile();
    }

    const counts = readCounts();
    const ratio = counts.max5 / counts.pro;
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThanOrEqual(5.5);
  });

  test("headroom scales multiplier to even split", () => {
    installMonotonicClock();
    writeConfig(["a", "b"]);
    writeEnvelope("a", {
      subscription_active: true,
      multiplier: 10,
      session_percent: 50.0,
    });
    writeEnvelope("b", {
      subscription_active: true,
      multiplier: 5,
      session_percent: 0.0,
    });

    for (let i = 0; i < 400; i++) {
      pickProfile();
    }

    const counts = readCounts();
    expect(Math.abs(counts.a - counts.b)).toBeLessThanOrEqual(1);
  });

  test("equal weights degrade to round-robin", () => {
    installMonotonicClock();
    writeConfig(["p1", "p2", "p3"]);
    for (const name of ["p1", "p2", "p3"]) {
      writeEnvelope(name, { subscription_active: true, multiplier: 5 });
    }

    const picks = Array.from({ length: 6 }, () => pickProfile());

    expect(new Set(picks.slice(0, 3))).toEqual(new Set(["p1", "p2", "p3"]));
    expect(readCounts()).toEqual({ p1: 2, p2: 2, p3: 2 });
  });

  test("all sessions burned falls back to multiplier credit", () => {
    installMonotonicClock();
    writeConfig(["pro", "max5"]);
    writeEnvelope("pro", {
      subscription_active: true,
      multiplier: 1,
      session_percent: 100.0,
    });
    writeEnvelope("max5", {
      subscription_active: true,
      multiplier: 5,
      session_percent: 100.0,
    });

    for (let i = 0; i < 600; i++) {
      pickProfile();
    }

    const counts = readCounts();
    expect(counts.pro + counts.max5).toBe(600);
    const ratio = counts.max5 / counts.pro;
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThanOrEqual(5.5);
  });

  test("missing usage means full headroom", () => {
    installMonotonicClock();
    writeConfig(["nousage", "nosession", "nopercent", "full"]);
    writeEnvelope("nousage", { subscription_active: true, usage: null });
    writeEnvelope("nosession", { subscription_active: true, usage: {} });
    writeEnvelope("nopercent", {
      subscription_active: true,
      usage: { session: {} },
    });
    writeEnvelope("full", { subscription_active: true, session_percent: 0.0 });

    for (let i = 0; i < 400; i++) {
      pickProfile();
    }

    const counts = readCounts();
    const vals = Object.values(counts);
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
  });

  test("new entrant gets no catch-up burst", () => {
    installMonotonicClock();
    // Seed an established ledger: p1 and p2 already have substantial counts.
    writeFileSync(
      join(stateDir, "picker.json"),
      JSON.stringify({
        schema_version: 1,
        picks: {
          p1: { count: 50, last_picked_at: "2026-01-01T00:00:00+00:00" },
          p2: { count: 50, last_picked_at: "2026-01-01T00:00:00+00:00" },
        },
      }),
    );
    writeConfig(["p1", "p2", "fresh"]);
    for (const name of ["p1", "p2", "fresh"]) {
      writeEnvelope(name, { subscription_active: true, multiplier: 1 });
    }

    // fresh enters crediting at min(50, 50) = 50, tying p1/p2; name tie-break
    // makes its first pick a single pick, not a burst back to parity.
    expect(pickProfile()).toBe("fresh");
    expect(pickProfile()).not.toBe("fresh");
  });

  test("percent_used over 100 clamps to zero headroom", () => {
    installMonotonicClock();
    writeConfig(["bad", "good"]);
    writeEnvelope("bad", {
      subscription_active: true,
      multiplier: 20,
      session_percent: 150.0,
    });
    writeEnvelope("good", {
      subscription_active: true,
      multiplier: 1,
      session_percent: 0.0,
    });

    for (let i = 0; i < 50; i++) {
      pickProfile();
    }

    const counts = readCounts();
    expect(counts.bad ?? 0).toBe(0);
    expect(counts.good).toBe(50);
  });

  test.each([0, -5, "garbage", 3.5, true, null])(
    "garbage multiplier %p treated as one",
    (badMultiplier) => {
      installMonotonicClock();
      writeConfig(["weird", "one"]);
      writeEnvelope("weird", {
        subscription_active: true,
        multiplier: badMultiplier,
      });
      writeEnvelope("one", { subscription_active: true, multiplier: 1 });

      for (let i = 0; i < 200; i++) {
        pickProfile();
      }

      const counts = readCounts();
      expect(Math.abs(counts.weird - counts.one)).toBeLessThanOrEqual(1);
    },
  );
});

// ---------- empty / skip paths ----------------------------------------------

describe("empty / skip paths", () => {
  test("no eligible returns default without writing state", () => {
    writeConfig(["p1", "p2"]);
    writeEnvelope("p1", { subscription_active: false });
    // p2 has no envelope at all.

    expect(pickProfile()).toBe("default");
    expect(existsSync(join(stateDir, "picker.json"))).toBe(false);
  });

  test("no config returns default", () => {
    expect(pickProfile()).toBe("default");
  });

  test("unsubscribed and missing and codex are skipped", () => {
    installMonotonicClock();
    writeConfig(["sub", "nosub", "missing", "weird"]);
    writeEnvelope("sub", { subscription_active: true });
    writeEnvelope("nosub", { subscription_active: false });
    // "missing": no envelope written.
    writeEnvelope("weird", { subscription_active: true, target: "codex" });

    const picks = new Set(Array.from({ length: 5 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["sub"]));
    expect(readCounts()).toEqual({ sub: 5 });
  });
});

// ---------- fail-open -------------------------------------------------------

describe("fail-open", () => {
  test("corrupt picker state is reset not fatal", () => {
    installMonotonicClock();
    writeConfig(["p1"]);
    writeEnvelope("p1", { subscription_active: true });
    writeFileSync(join(stateDir, "picker.json"), "{ not json at all ]");

    expect(pickProfile()).toBe("p1");
    expect(readCounts()).toEqual({ p1: 1 });
  });

  test("pick never raises on unreadable state dir", () => {
    const blocker = join(tmpDir, "blocker");
    writeFileSync(blocker, "i am a file, not a dir");
    setStateDir(blocker);
    writeConfig(["p1"]);
    expect(pickProfile()).toBe("default");
  });
});

// The real multi-process flock-contention test lives in
// `usage-picker-flock.slow.test.ts` (spawns ~30 child processes — too heavy for
// the fast tier; runs under `bun run test:full`).

// ---------- rate-limit cooldown (lift_at) -----------------------------------

describe("rate-limit cooldown", () => {
  test("future lift_at excludes profile", () => {
    writeConfig(["cool", "hot"]);
    writeEnvelope("cool", { subscription_active: true });
    writeEnvelope("hot", {
      subscription_active: true,
      lift_at: isoOffset(3600),
    });

    const picks = new Set(Array.from({ length: 5 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["cool"]));
    expect(readCounts()).toEqual({ cool: 5 });
  });

  test("past lift_at does not exclude profile", () => {
    writeConfig(["p1", "p2"]);
    writeEnvelope("p1", {
      subscription_active: true,
      lift_at: isoOffset(-3600),
    });
    writeEnvelope("p2", { subscription_active: true });

    const picks = new Set(Array.from({ length: 4 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["p1", "p2"]));
  });

  test("all rate limited falls back to subscribed set", () => {
    writeConfig(["p1", "p2"]);
    writeEnvelope("p1", {
      subscription_active: true,
      lift_at: isoOffset(3600),
    });
    writeEnvelope("p2", {
      subscription_active: true,
      lift_at: isoOffset(7200),
    });

    const picks = Array.from({ length: 4 }, () => pickProfile());

    expect(picks.every((p) => ["p1", "p2"].includes(p))).toBe(true);
    const counts = readCounts();
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(4);
  });

  test("malformed lift_at is ignored (non-string / unparseable / naive)", () => {
    writeConfig(["garbage", "naive", "good"]);
    writeEnvelope("garbage", {
      subscription_active: true,
      lift_at: "not-a-date",
    });
    // Naive ISO (no tz offset) — corrupted envelope, must not block selection.
    writeEnvelope("naive", {
      subscription_active: true,
      lift_at: "2099-01-01T00:00:00",
    });
    writeEnvelope("good", { subscription_active: true });

    const picks = new Set(Array.from({ length: 6 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["garbage", "naive", "good"]));
  });
});

// ---------- list_profiles + YAML adapter ------------------------------------

describe("listProfiles", () => {
  test("reads catalog", () => {
    writeConfig(["alpha", "beta"]);
    // Exercised through pickProfile's eligibility too, but assert directly.
    expect(listProfiles()).toEqual(["alpha", "beta"]);
  });

  test("fail-open empty on missing config", () => {
    expect(listProfiles()).toEqual([]);
  });

  test("parses the real ~/.config/agentusage/config.yaml shape via Bun.YAML", () => {
    // Guards the YAML-1.2-only adapter against the real config corpus shape
    // (a plain string list under `profiles:`; corpus is boolean-free).
    writeFileSync(
      join(configHome, "agentusage", "config.yaml"),
      "profiles:\n  - default\n  - multi-claude-1\n  - multi-claude-2\n  - multi-claude-3\n",
    );
    expect(listProfiles()).toEqual([
      "default",
      "multi-claude-1",
      "multi-claude-2",
      "multi-claude-3",
    ]);
  });
});
