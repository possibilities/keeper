/**
 * Behavior pins for the latched-reserve profile picker (`src/usage-picker.ts`):
 * pure LRU rotation (name ties, new-entrant catch-up, corrupt-stamp ordering),
 * the latched reserve (healthy-only while any healthy account exists, same-call
 * fast-open when none remain, conservative re-latch under the re-arm mark, the
 * anti-flap hysteresis band, and the all-included backstop), the `pending`
 * burst reservation and its scrape-driven reset, rollover grace, multiplier
 * coercion as the reservation divisor, the v2 ledger shape + `last_pick`
 * forensic blob carrying `tier`/`reserve_open`, and the fail-open / never-throws
 * contract (corrupt state, unreadable state dir, rate-limit cooldown). Every
 * scenario pins deterministically under `installMonotonicClock` — no
 * statistical sampling, no real daemon, per-test tmpdir only.
 *
 * The picker reads two sources redirected into tmp: per-account envelopes under
 * the state dir (via `setStateDir`) and the `usage_models` registry in keeper's
 * `config.yaml` (via the `KEEPER_CONFIG` env override). The clock is pinned with
 * `setClock` — one `nowFn()` read per pick, so stamps strictly increase and LRU
 * order is exact.
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
let configPath: string;
let savedKeeperConfig: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentusage-picker-"));
  stateDir = join(tmpDir, "state");
  mkdirSync(stateDir);
  setStateDir(stateDir);
  configPath = join(tmpDir, "config.yaml");
  savedKeeperConfig = process.env.KEEPER_CONFIG;
  // Point at the (not-yet-written) keeper config so a test without writeConfig
  // fail-opens to an empty registry instead of reading the real user config.
  process.env.KEEPER_CONFIG = configPath;
});

afterEach(() => {
  resetClock();
  if (savedKeeperConfig === undefined) {
    delete process.env.KEEPER_CONFIG;
  } else {
    process.env.KEEPER_CONFIG = savedKeeperConfig;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- helpers ---------------------------------------------------------

// Declare the claude profile ids via keeper's `usage_models` registry (aliases
// are irrelevant to the picker, so every id is null-aliased). listProfiles reads
// this through resolveUsageModels.
function writeConfig(profiles: string[]): void {
  const yaml =
    profiles.length > 0
      ? `usage_models:\n${profiles.map((p) => `  ${p}:`).join("\n")}\n`
      : "usage_models: {}\n";
  writeFileSync(configPath, yaml);
}

interface EnvelopeOpts {
  subscription_active: unknown;
  target?: string;
  status?: string;
  lift_at?: unknown;
  multiplier?: unknown;
  session_percent?: unknown;
  week_percent?: unknown;
  session_resets_at?: unknown;
  week_resets_at?: unknown;
  last_successful_fetch_at?: unknown;
  usage?: unknown;
  error?: unknown;
}

function writeEnvelope(name: string, opts: EnvelopeOpts): void {
  let usage: unknown = opts.usage;
  if (usage === undefined) {
    const hasSession =
      opts.session_percent !== undefined ||
      opts.session_resets_at !== undefined;
    const hasWeek =
      opts.week_percent !== undefined || opts.week_resets_at !== undefined;
    if (!hasSession && !hasWeek) {
      usage = null;
    } else {
      const built: Record<string, unknown> = {};
      if (hasSession) {
        const s: Record<string, unknown> = {};
        if (opts.session_percent !== undefined)
          s.percent_used = opts.session_percent;
        if (opts.session_resets_at !== undefined)
          s.resets_at = opts.session_resets_at;
        built.session = s;
      }
      if (hasWeek) {
        const w: Record<string, unknown> = {};
        if (opts.week_percent !== undefined) w.percent_used = opts.week_percent;
        if (opts.week_resets_at !== undefined)
          w.resets_at = opts.week_resets_at;
        built.week = w;
      }
      usage = built;
    }
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
  if (opts.multiplier !== undefined) {
    envelope.multiplier = opts.multiplier;
  }
  if (opts.last_successful_fetch_at !== undefined) {
    envelope.last_successful_fetch_at = opts.last_successful_fetch_at;
  }
  writeFileSync(join(stateDir, `${name}.json`), JSON.stringify(envelope));
}

// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic ledger shape
function readState(): any {
  return JSON.parse(readFileSync(join(stateDir, "picker.json"), "utf8"));
}

// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic ledger shape
function readPicks(): Record<string, any> {
  return readState().picks;
}

function seedState(state: unknown): void {
  writeFileSync(join(stateDir, "picker.json"), JSON.stringify(state));
}

// Fixed base for the pinned clock. `isoOffset` derives from the SAME base so
// relative lift_at / resets_at stamps stay consistent with the pinned `now`.
const CLOCK_BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Monotonic clock — strictly increasing stamps, defeats microsecond ties. */
function installMonotonicClock(): void {
  let counter = 0;
  setClock(() => {
    counter += 1;
    return new Date(CLOCK_BASE + counter * 1000);
  });
}

/** ISO stamp offset from the pinned clock base by `seconds`, with explicit tz. */
function isoOffset(seconds: number): string {
  const d = new Date(CLOCK_BASE + seconds * 1000);
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

// ---------- LRU rotation ----------------------------------------------------

describe("LRU rotation", () => {
  test("rotates oldest-first with name tie-break", () => {
    installMonotonicClock();
    writeConfig(["p1", "p2", "p3"]);
    for (const name of ["p1", "p2", "p3"]) {
      writeEnvelope(name, { subscription_active: true });
    }

    const picks = Array.from({ length: 6 }, () => pickProfile());

    // All start absent (epoch-oldest) → name order; then strict LRU rotation.
    expect(picks).toEqual(["p1", "p2", "p3", "p1", "p2", "p3"]);
  });

  test("a new entrant is picked once, then rotates to the back", () => {
    installMonotonicClock();
    // Established ledger: p1, p2 already stamped (clearly older than the clock).
    seedState({
      schema_version: 2,
      picks: {
        p1: {
          last_picked_at: "2025-01-01T00:00:00+00:00",
          pending: 0,
          seen_fetch_at: null,
        },
        p2: {
          last_picked_at: "2025-01-01T00:00:01+00:00",
          pending: 0,
          seen_fetch_at: null,
        },
      },
    });
    writeConfig(["p1", "p2", "fresh"]);
    for (const name of ["p1", "p2", "fresh"]) {
      writeEnvelope(name, { subscription_active: true });
    }

    // fresh has no stamp → epoch-oldest → picked first (one catch-up turn)…
    expect(pickProfile()).toBe("fresh");
    // …then it holds the newest stamp and rotates to the back (no burst).
    expect(pickProfile()).not.toBe("fresh");
    expect(pickProfile()).not.toBe("fresh");
  });

  test("corrupt last_picked_at sorts oldest without throwing", () => {
    installMonotonicClock();
    seedState({
      schema_version: 2,
      picks: {
        valid: { last_picked_at: "2025-06-01T00:00:00+00:00", pending: 0 },
        corrupt: { last_picked_at: "not-a-date", pending: 0 },
        naive: { last_picked_at: "2030-01-01T00:00:00", pending: 0 },
      },
    });
    writeConfig(["valid", "corrupt", "naive"]);
    for (const name of ["valid", "corrupt", "naive"]) {
      writeEnvelope(name, { subscription_active: true });
    }

    // corrupt + naive both sort epoch-oldest; name tie → corrupt first. Once
    // they take real 2026 stamps, the parseable 2025 stamp on "valid" is oldest.
    expect(pickProfile()).toBe("corrupt");
    expect(pickProfile()).toBe("naive");
    expect(pickProfile()).toBe("valid");
  });

  test("stale account still rotates", () => {
    installMonotonicClock();
    writeConfig(["p1", "p2"]);
    writeEnvelope("p1", { subscription_active: true, status: "active" });
    writeEnvelope("p2", { subscription_active: true, status: "stale" });

    const picks = new Set(Array.from({ length: 4 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["p1", "p2"]));
  });
});

// ---------- healthy-tier admission ------------------------------------------

describe("healthy-tier admission", () => {
  test("over-threshold account is held non-viable while a healthy account exists", () => {
    installMonotonicClock();
    writeConfig(["over", "under"]);
    // over: session 85 (>= 80) — non-viable while `under` is healthy. under:
    // session 0 — stays healthy for many picks (pending inflation < 80).
    writeEnvelope("over", { subscription_active: true, session_percent: 85 });
    writeEnvelope("under", { subscription_active: true, session_percent: 0 });

    const picks = Array.from({ length: 5 }, () => pickProfile());

    expect(picks.every((p) => p === "under")).toBe(true);
    expect(readState().last_pick.tier).toBe("healthy");
    expect(readState().reserve_open).toBe(false);
  });

  test("the weekly threshold also gates the healthy set", () => {
    installMonotonicClock();
    writeConfig(["weekhot", "fine"]);
    writeEnvelope("weekhot", { subscription_active: true, week_percent: 95 });
    writeEnvelope("fine", { subscription_active: true, session_percent: 0 });

    const picks = Array.from({ length: 4 }, () => pickProfile());

    expect(picks.every((p) => p === "fine")).toBe(true);
    expect(readState().last_pick.tier).toBe("healthy");
  });

  test("zero subscribed returns DEFAULT with NO state write", () => {
    writeConfig(["p1", "p2"]);
    writeEnvelope("p1", { subscription_active: false });
    // p2 has no envelope at all.

    expect(pickProfile()).toBe("default");
    expect(existsSync(join(stateDir, "picker.json"))).toBe(false);
  });

  test("a fresh low-tier account is picked ahead of a heavily-used high-tier one", () => {
    // The reported starvation: under stride the burned 20x kept winning. Model
    // it — burned20x was just picked, fresh1x has never been picked (absent).
    installMonotonicClock();
    seedState({
      schema_version: 2,
      picks: {
        burned20x: {
          last_picked_at: "2025-06-01T00:00:00+00:00",
          pending: 0,
          seen_fetch_at: null,
        },
      },
    });
    writeConfig(["burned20x", "fresh1x"]);
    writeEnvelope("burned20x", {
      subscription_active: true,
      multiplier: 20,
      session_percent: 69,
    });
    writeEnvelope("fresh1x", {
      subscription_active: true,
      multiplier: 1,
      session_percent: 0,
    });

    // Both admitted (under buffer); LRU with fresh1x absent → fresh1x wins the
    // opening turn ahead of the burned 20x, and neither starves after.
    expect(pickProfile()).toBe("fresh1x");
    const picks = new Set(Array.from({ length: 4 }, () => pickProfile()));
    expect(picks).toEqual(new Set(["burned20x", "fresh1x"]));
  });

  test("usage-endpoint throttle parks a profile out of the healthy and reserve tiers", () => {
    installMonotonicClock();
    writeConfig(["ok", "throttled"]);
    writeEnvelope("ok", { subscription_active: true, session_percent: 0 });
    writeEnvelope("throttled", {
      subscription_active: true,
      session_percent: 0,
      error: {
        type: "ClaudeUsageEndpointRateLimited",
        message: "retry later",
        at: isoOffset(-60),
      },
    });

    const picks = new Set(Array.from({ length: 4 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["ok"]));
  });

  test("unsubscribed and missing and codex profiles are skipped", () => {
    installMonotonicClock();
    writeConfig(["sub", "nosub", "missing", "weird"]);
    writeEnvelope("sub", { subscription_active: true });
    writeEnvelope("nosub", { subscription_active: false });
    // "missing": no envelope written.
    writeEnvelope("weird", { subscription_active: true, target: "codex" });

    const picks = new Set(Array.from({ length: 5 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["sub"]));
  });
});

// ---------- latched reserve -------------------------------------------------

describe("latched reserve", () => {
  test("anti-flap: a recovery under the threshold but over the re-arm mark keeps the reserve open", () => {
    // THE proof point: reserve open, an account recovers 85 → 79 (under the 80
    // threshold, still over the 50 re-arm mark). The latch must STAY open; only
    // a genuine sub-re-arm-mark recovery re-latches.
    installMonotonicClock();
    seedState({ schema_version: 2, reserve_open: true, picks: {} });
    writeConfig(["a", "b"]);
    // Both start hot → the open reserve is legitimate.
    writeEnvelope("a", {
      subscription_active: true,
      session_percent: 85,
      last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
    });
    writeEnvelope("b", {
      subscription_active: true,
      session_percent: 90,
      last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
    });

    pickProfile();
    expect(readState().reserve_open).toBe(true);
    expect(readState().last_pick.tier).toBe("reserve");

    // a recovers to 79 — under 80 but above the 50 re-arm mark. (Fresh fetch
    // stamp zeroes pending so effective usage equals the scraped percent.)
    writeEnvelope("a", {
      subscription_active: true,
      session_percent: 79,
      last_successful_fetch_at: "2026-01-01T01:00:00+00:00",
    });
    pickProfile();
    expect(readState().reserve_open).toBe(true);

    // a drops under the re-arm mark → NOW the latch closes.
    writeEnvelope("a", {
      subscription_active: true,
      session_percent: 45,
      last_successful_fetch_at: "2026-01-01T02:00:00+00:00",
    });
    pickProfile();
    expect(readState().reserve_open).toBe(false);
    expect(readState().last_pick.tier).toBe("healthy");
  });

  test("same-call fast-open: the pick that empties the healthy set is served from the reserve", () => {
    installMonotonicClock();
    writeConfig(["a", "b"]);
    // Fresh ledger → latch closed. Both over the threshold → no healthy account,
    // so this very pick opens the reserve and resolves from it (not backstop).
    writeEnvelope("a", { subscription_active: true, session_percent: 85 });
    writeEnvelope("b", { subscription_active: true, session_percent: 82 });

    const chosen = pickProfile();

    expect(["a", "b"]).toContain(chosen);
    expect(readState().reserve_open).toBe(true);
    expect(readState().last_pick.tier).toBe("reserve");
  });

  test("same-call re-latch: a recovery under the re-arm mark closes the latch in the same pick", () => {
    installMonotonicClock();
    seedState({ schema_version: 2, reserve_open: true, picks: {} });
    writeConfig(["recovered", "hot"]);
    writeEnvelope("recovered", {
      subscription_active: true,
      session_percent: 30,
    });
    writeEnvelope("hot", { subscription_active: true, session_percent: 85 });

    const chosen = pickProfile();

    expect(readState().reserve_open).toBe(false);
    expect(readState().last_pick.tier).toBe("healthy");
    // Re-latched to healthy-only → the recovered account is the only viable pick.
    expect(chosen).toBe("recovered");
  });

  test("hold-open: accounts between the re-arm mark and the threshold keep the reserve open", () => {
    installMonotonicClock();
    seedState({ schema_version: 2, reserve_open: true, picks: {} });
    writeConfig(["mid1", "mid2"]);
    // Both under the threshold (so both are healthy) but neither under the
    // re-arm mark → the hysteresis band holds the reserve open.
    writeEnvelope("mid1", { subscription_active: true, session_percent: 60 });
    writeEnvelope("mid2", { subscription_active: true, session_percent: 70 });

    pickProfile();

    expect(readState().reserve_open).toBe(true);
    expect(readState().last_pick.tier).toBe("reserve");
  });

  test("boundary: session exactly at the threshold is not healthy", () => {
    installMonotonicClock();
    writeConfig(["edge", "under"]);
    // 80 is not < 80 → edge is never viable while `under` is healthy.
    writeEnvelope("edge", { subscription_active: true, session_percent: 80 });
    writeEnvelope("under", { subscription_active: true, session_percent: 0 });

    const picks = Array.from({ length: 4 }, () => pickProfile());

    expect(picks.every((p) => p === "under")).toBe(true);
    expect(readState().reserve_open).toBe(false);
  });

  test("boundary: session exactly at the re-arm mark does not re-latch", () => {
    installMonotonicClock();
    seedState({ schema_version: 2, reserve_open: true, picks: {} });
    writeConfig(["a", "b"]);
    writeEnvelope("a", {
      subscription_active: true,
      session_percent: 50,
      last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
    });
    writeEnvelope("b", {
      subscription_active: true,
      session_percent: 90,
      last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
    });

    pickProfile();
    // 50 is not < 50 → not re-armed → latch stays open.
    expect(readState().reserve_open).toBe(true);

    // Drop just under the mark → re-latch.
    writeEnvelope("a", {
      subscription_active: true,
      session_percent: 49,
      last_successful_fetch_at: "2026-01-01T01:00:00+00:00",
    });
    pickProfile();
    expect(readState().reserve_open).toBe(false);
  });

  test("boundary: week exactly at the threshold is not healthy", () => {
    installMonotonicClock();
    writeConfig(["weekedge", "fine"]);
    // 95 is not < 95 → weekedge is never in the healthy set.
    writeEnvelope("weekedge", { subscription_active: true, week_percent: 95 });
    writeEnvelope("fine", { subscription_active: true, session_percent: 0 });

    const picks = Array.from({ length: 4 }, () => pickProfile());

    expect(picks.every((p) => p === "fine")).toBe(true);
    expect(readState().reserve_open).toBe(false);
  });

  test("an absent reserve_open flag is read as latched on the first pick", () => {
    installMonotonicClock();
    // A pre-existing v2 ledger with accumulated pending/LRU state but NO
    // reserve_open field — read as latched (healthy-only), state preserved.
    seedState({
      schema_version: 2,
      picks: {
        healthy: {
          last_picked_at: "2025-01-01T00:00:00+00:00",
          pending: 0,
          seen_fetch_at: null,
        },
        hot: {
          last_picked_at: "2025-01-01T00:00:01+00:00",
          pending: 0,
          seen_fetch_at: null,
        },
      },
    });
    writeConfig(["healthy", "hot"]);
    writeEnvelope("healthy", {
      subscription_active: true,
      session_percent: 10,
    });
    writeEnvelope("hot", { subscription_active: true, session_percent: 85 });

    const chosen = pickProfile();

    // Latched → only the healthy account is viable.
    expect(chosen).toBe("healthy");
    expect(readState().last_pick.tier).toBe("healthy");
    expect(readState().reserve_open).toBe(false);
    // Prior LRU state survived (no wipe of the untouched account).
    expect(readState().picks.hot.last_picked_at).toBe(
      "2025-01-01T00:00:01+00:00",
    );
  });

  test("a stalled scraper opens the reserve and keeps the fleet rotating", () => {
    installMonotonicClock();
    writeConfig(["a", "b"]);
    // Frozen fetch stamp: pending never resets, so effective usage climbs
    // without bound and eventually pushes every account past the threshold —
    // the reserve opens and stays open, but the fleet keeps rotating.
    for (const name of ["a", "b"]) {
      writeEnvelope(name, {
        subscription_active: true,
        session_percent: 0,
        last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
      });
    }

    const picks = Array.from({ length: 50 }, () => pickProfile());

    expect(picks.filter((p) => p === "a").length).toBeGreaterThan(0);
    expect(picks.filter((p) => p === "b").length).toBeGreaterThan(0);
    expect(readState().reserve_open).toBe(true);
    expect(readState().last_pick.tier).toBe("reserve");
  });

  test("all-parked backstop: no throw, tier=backstop, reserve_open persisted", () => {
    installMonotonicClock();
    seedState({ schema_version: 2, reserve_open: true, picks: {} });
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
    expect(readState().last_pick.tier).toBe("backstop");
    expect(readState().reserve_open).toBe(true);
  });
});

// ---------- burst reservation (pending) -------------------------------------

describe("burst reservation", () => {
  test("burst launches spread across profiles instead of piling onto one", () => {
    installMonotonicClock();
    // A greedy lowest-percent picker would pile every burst pick onto "low";
    // LRU + reservation spreads them.
    writeConfig(["low", "high"]);
    writeEnvelope("low", {
      subscription_active: true,
      session_percent: 0,
      last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
    });
    writeEnvelope("high", {
      subscription_active: true,
      session_percent: 50,
      last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
    });

    const picks = Array.from({ length: 4 }, () => pickProfile());

    expect(new Set(picks)).toEqual(new Set(["low", "high"]));
    expect(picks.filter((p) => p === "low").length).toBe(2);
    expect(picks.filter((p) => p === "high").length).toBe(2);
  });

  test("pending accumulates within a scrape window and resets when the fetch stamp changes", () => {
    installMonotonicClock();
    writeConfig(["a"]);
    writeEnvelope("a", {
      subscription_active: true,
      session_percent: 0,
      last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
    });

    pickProfile();
    pickProfile();
    pickProfile();
    expect(readPicks().a.pending).toBe(3);
    expect(readPicks().a.seen_fetch_at).toBe("2026-01-01T00:00:00+00:00");

    // Fresh scrape lands: reconcile resets pending to 0, then the pick bumps it.
    writeEnvelope("a", {
      subscription_active: true,
      session_percent: 0,
      last_successful_fetch_at: "2026-01-01T01:00:00+00:00",
    });
    pickProfile();
    expect(readPicks().a.pending).toBe(1);
    expect(readPicks().a.seen_fetch_at).toBe("2026-01-01T01:00:00+00:00");
  });

  test("null-to-string fetch stamp resets pending; null-to-null does not", () => {
    installMonotonicClock();
    writeConfig(["nullstamp", "flip"]);
    // nullstamp: never has a fetch stamp → pending accumulates forever.
    writeEnvelope("nullstamp", {
      subscription_active: true,
      session_percent: 0,
    });
    // flip: starts with no stamp, later gains one.
    writeEnvelope("flip", { subscription_active: true, session_percent: 0 });

    // Two full rounds (LRU alternates), so each profile is picked twice.
    pickProfile();
    pickProfile();
    pickProfile();
    pickProfile();
    expect(readPicks().nullstamp.pending).toBe(2);
    expect(readPicks().flip.pending).toBe(2);

    // flip gains a fetch stamp (null → string) → its pending resets next pick;
    // nullstamp stays null → null and keeps accumulating.
    writeEnvelope("flip", {
      subscription_active: true,
      session_percent: 0,
      last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
    });
    // flip is LRU-oldest (nullstamp was picked most recently), so it goes next.
    expect(pickProfile()).toBe("flip");
    expect(readPicks().flip.pending).toBe(1);
    expect(readPicks().nullstamp.pending).toBe(2);
  });

  test("reservation divisor is pending * STEP / multiplier", () => {
    installMonotonicClock();
    writeConfig(["m5"]);
    // multiplier 5, STEP_SESSION 5 → each pick adds 5*1/5 = 1 to effective
    // session. Starting at 78, healthy (< 80) survives one pick then gates out.
    writeEnvelope("m5", {
      subscription_active: true,
      multiplier: 5,
      session_percent: 78,
      last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
    });

    // Pick 1: effective 78 < 80 → healthy.
    expect(pickProfile()).toBe("m5");
    expect(readState().last_pick.tier).toBe("healthy");
    expect(readState().reserve_open).toBe(false);
    // Pick 2: pending 1 → effective 78 + 1 = 79 < 80 → still healthy.
    pickProfile();
    expect(readState().last_pick.tier).toBe("healthy");
    // Pick 3: pending 2 → effective 78 + 2 = 80 → no healthy account → reserve
    // opens in this pick and serves it.
    pickProfile();
    expect(readState().last_pick.tier).toBe("reserve");
    expect(readState().reserve_open).toBe(true);
  });
});

// ---------- rollover grace --------------------------------------------------

describe("rollover grace", () => {
  test("a tz-aware past resets_at zeroes that window's scraped percent", () => {
    installMonotonicClock();
    writeConfig(["expired", "other"]);
    // expired reads 99% but its window reset in the past (tz-aware) → grace
    // treats it as 0 → healthy alongside other.
    writeEnvelope("expired", {
      subscription_active: true,
      usage: {
        session: { percent_used: 99, resets_at: isoOffset(-3600) },
      },
    });
    writeEnvelope("other", { subscription_active: true, session_percent: 50 });

    const picks = new Set(Array.from({ length: 4 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["expired", "other"]));
    expect(readState().last_pick.tier).toBe("healthy");
  });

  test("a naive past resets_at gets no grace", () => {
    installMonotonicClock();
    writeConfig(["naive", "fine"]);
    // Naive (offset-less) resets_at → no grace → 99% still gates it out.
    writeEnvelope("naive", {
      subscription_active: true,
      usage: {
        session: { percent_used: 99, resets_at: "2020-01-01T00:00:00" },
      },
    });
    writeEnvelope("fine", { subscription_active: true, session_percent: 0 });

    const picks = Array.from({ length: 5 }, () => pickProfile());

    expect(picks.every((p) => p === "fine")).toBe(true);
  });

  test("grace never touches pending (self-clears on the next scrape)", () => {
    installMonotonicClock();
    writeConfig(["g"]);
    writeEnvelope("g", {
      subscription_active: true,
      last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
      usage: { session: { percent_used: 99, resets_at: isoOffset(-3600) } },
    });

    pickProfile();
    pickProfile();

    // Grace zeroed the gate math but the reservation still accrued.
    expect(readPicks().g.pending).toBe(2);
  });
});

// ---------- ledger shape ----------------------------------------------------

describe("ledger v2", () => {
  test("persists the v2 shape: schema_version, per-profile fields, last_pick", () => {
    installMonotonicClock();
    writeConfig(["a"]);
    writeEnvelope("a", {
      subscription_active: true,
      last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
    });

    const chosen = pickProfile();
    const state = readState();

    expect(state.schema_version).toBe(2);
    const entry = state.picks.a;
    expect(typeof entry.last_picked_at).toBe("string");
    expect(entry.pending).toBe(1);
    expect(entry.seen_fetch_at).toBe("2026-01-01T00:00:00+00:00");
    // No stride-era `count` field survives.
    expect(entry.count).toBeUndefined();
    expect(state.last_pick).toMatchObject({
      profile: chosen,
      tier: "healthy",
      reserve_open: false,
    });
    expect(typeof state.last_pick.at).toBe("string");
    // The authoritative top-level latch is persisted for the next pick to read.
    expect(state.reserve_open).toBe(false);
  });

  test("a v1 picker.json is treated as absent (discarded on first pick)", () => {
    installMonotonicClock();
    seedState({
      schema_version: 1,
      picks: {
        p1: { count: 99, last_picked_at: "2099-01-01T00:00:00+00:00" },
      },
    });
    writeConfig(["p1", "p2"]);
    for (const name of ["p1", "p2"]) {
      writeEnvelope(name, { subscription_active: true });
    }

    // v1 discarded → both start absent → name order → p1 first.
    expect(pickProfile()).toBe("p1");
    expect(readState().schema_version).toBe(2);
    expect(readState().picks.p1.count).toBeUndefined();
  });

  test.each([0, -5, "garbage", 3.5, true, null])(
    "garbage multiplier %p coerces to 1 in the reservation divisor",
    (badMultiplier) => {
      installMonotonicClock();
      // If the divisor were not coerced to 1, a garbage value (0 → ÷0,
      // "garbage" → NaN) would break the gate math and desync the rotation.
      // Coerced to 1, "weird" and "one" share identical effective math and
      // rotate evenly.
      writeConfig(["weird", "one"]);
      writeEnvelope("weird", {
        subscription_active: true,
        multiplier: badMultiplier,
        session_percent: 0,
        last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
      });
      writeEnvelope("one", {
        subscription_active: true,
        multiplier: 1,
        session_percent: 0,
        last_successful_fetch_at: "2026-01-01T00:00:00+00:00",
      });

      const picks = Array.from({ length: 20 }, () => pickProfile());
      const weird = picks.filter((p) => p === "weird").length;
      const one = picks.filter((p) => p === "one").length;

      expect(Math.abs(weird - one)).toBeLessThanOrEqual(1);
    },
  );
});

// ---------- fail-open -------------------------------------------------------

describe("fail-open", () => {
  test("corrupt picker state is reset, not fatal", () => {
    installMonotonicClock();
    writeConfig(["p1"]);
    writeEnvelope("p1", { subscription_active: true });
    writeFileSync(join(stateDir, "picker.json"), "{ not json at all ]");

    expect(pickProfile()).toBe("p1");
    expect(readState().schema_version).toBe(2);
    expect(readPicks().p1.pending).toBe(1);
  });

  test("pick never raises on an unreadable state dir", () => {
    const blocker = join(tmpDir, "blocker");
    writeFileSync(blocker, "i am a file, not a dir");
    setStateDir(blocker);
    writeConfig(["p1"]);
    expect(pickProfile()).toBe("default");
  });
});

// ---------- rate-limit cooldown (lift_at) -----------------------------------

describe("rate-limit cooldown", () => {
  test("future lift_at parks a profile out of the healthy and reserve tiers", () => {
    installMonotonicClock();
    writeConfig(["cool", "hot"]);
    writeEnvelope("cool", { subscription_active: true, session_percent: 0 });
    writeEnvelope("hot", {
      subscription_active: true,
      session_percent: 0,
      lift_at: isoOffset(3600),
    });

    const picks = new Set(Array.from({ length: 5 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["cool"]));
  });

  test("past lift_at does not park a profile", () => {
    installMonotonicClock();
    writeConfig(["p1", "p2"]);
    writeEnvelope("p1", {
      subscription_active: true,
      lift_at: isoOffset(-3600),
    });
    writeEnvelope("p2", { subscription_active: true });

    const picks = new Set(Array.from({ length: 4 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["p1", "p2"]));
  });

  test("all parked falls through to the all-included backstop", () => {
    installMonotonicClock();
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
    expect(readState().last_pick.tier).toBe("backstop");
  });

  test("malformed lift_at is ignored (non-string / unparseable / naive)", () => {
    installMonotonicClock();
    writeConfig(["garbage", "naive", "good"]);
    writeEnvelope("garbage", {
      subscription_active: true,
      lift_at: "not-a-date",
    });
    // Naive ISO (no tz offset) — corrupted envelope, must not park it.
    writeEnvelope("naive", {
      subscription_active: true,
      lift_at: "2099-01-01T00:00:00",
    });
    writeEnvelope("good", { subscription_active: true });

    const picks = new Set(Array.from({ length: 6 }, () => pickProfile()));

    expect(picks).toEqual(new Set(["garbage", "naive", "good"]));
  });
});

// ---------- listProfiles (declared claude ids from usage_models) ------------

describe("listProfiles", () => {
  test("returns the declared claude ids from usage_models", () => {
    writeConfig(["alpha", "beta"]);
    expect(listProfiles()).toEqual(["alpha", "beta"]);
  });

  test("fail-open empty on missing config", () => {
    expect(listProfiles()).toEqual([]);
  });

  test("excludes the codex id — only claude profiles balance", () => {
    // codex is a declared model but not a claude profile, so it never enters the
    // picker's rotation set.
    writeFileSync(
      configPath,
      "usage_models:\n  default: claude-0\n  multi-claude-1:\n  codex: gpt\n",
    );
    expect(listProfiles()).toEqual(["default", "multi-claude-1"]);
  });
});
