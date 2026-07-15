/**
 * Behavior pins for the per-launch account router (`src/account-router.ts`):
 * the fail-open disable gates (no / stale / unhealthy observation), greatest
 * worst-window headroom selection, deterministic LRU + stable-id tie-breaks, the
 * anti-stampede reservation pressure, reservation expiry, rollover grace, the
 * flock-guarded atomic ledger, and the never-throws contract.
 *
 * Every scenario pins a sidecar under a per-test tmpdir and a fixed `nowMs`, so
 * selection is exact and no daemon/worker/subprocess runs. Expected winners are
 * hand-derived from the raw utilizations + the published reservation step — an
 * independent source of truth, never re-computed by the selector under test.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NormalizedWindow,
  type Observation,
  type ObservationHealth,
  type Route,
  writeObservationSidecar,
} from "../src/account-observation";
import {
  selectRoute,
  selectRouteByAccountOrdinal,
} from "../src/account-router";
import {
  ledgerPath,
  NATIVE_ROUTE_ID,
  observationSidecarPath,
  RESERVATION_TTL_MS,
} from "../src/account-routing-config";

const NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "acct-router-"));
}

function win(
  key: string,
  utilization: number,
  resetsAt: string | null = null,
): NormalizedWindow {
  return { key, utilization, resetsAt };
}

function nativeRoute(...windows: NormalizedWindow[]): Route {
  return {
    id: NATIVE_ROUTE_ID,
    kind: "native",
    slot: null,
    windows,
    measuredAtMs: NOW_MS,
  };
}

function managedRoute(slot: number, ...windows: NormalizedWindow[]): Route {
  return {
    id: `claude-swap:${slot}`,
    kind: "managed",
    slot,
    windows,
    measuredAtMs: NOW_MS,
  };
}

function seedObservation(
  stateDir: string,
  routes: Route[],
  opts: {
    health?: ObservationHealth;
    observedAtMs?: number;
    accountOrdinals?: Record<string, number>;
    accountActiveRouteable?: boolean;
  } = {},
): void {
  const obs: Observation = {
    schema_version: 2,
    observed_at_ms: opts.observedAtMs ?? NOW_MS,
    health: opts.health ?? "ok",
    codex: {
      health: "absent",
      windows: [],
      resetCreditsAvailableCount: null,
      notes: [],
    },
    routes,
    ...(opts.accountOrdinals === undefined
      ? {}
      : {
          claude_accounts: {
            count: new Set(Object.values(opts.accountOrdinals)).size,
            ordinals: opts.accountOrdinals,
            ...(opts.accountActiveRouteable === undefined
              ? {}
              : { active_routeable: opts.accountActiveRouteable }),
          },
        }),
    notes: [],
  };
  writeObservationSidecar(observationSidecarPath(stateDir), obs);
}

// ---------- disable gates ---------------------------------------------------

describe("selectRoute — fail-open disable gates", () => {
  test("no observation → native default", () => {
    const dir = tmp();
    try {
      const sel = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(sel).toEqual({
        id: NATIVE_ROUTE_ID,
        kind: "native",
        slot: null,
        reason: "no-observation",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale observation → native default", () => {
    const dir = tmp();
    try {
      seedObservation(
        dir,
        [
          nativeRoute(win("session", 0.1)),
          managedRoute(3, win("session", 0.05)),
        ],
        {
          observedAtMs: NOW_MS - 60 * 60_000, // an hour old — well past the ceiling
        },
      );
      const sel = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(sel.id).toBe(NATIVE_ROUTE_ID);
      expect(sel.reason).toBe("stale-observation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unhealthy CodexBar (health != ok) → native default, balancing disabled", () => {
    const dir = tmp();
    try {
      // A managed route with far more headroom exists, but the closed gate wins.
      seedObservation(
        dir,
        [nativeRoute(), managedRoute(3, win("session", 0.01))],
        {
          health: "absent",
        },
      );
      const sel = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(sel.id).toBe(NATIVE_ROUTE_ID);
      expect(sel.reason).toBe("disabled-absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt sidecar → native default, never throws", () => {
    const dir = tmp();
    try {
      writeFileSync(observationSidecarPath(dir), "{ not json");
      const sel = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(sel.id).toBe(NATIVE_ROUTE_ID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- headroom selection ----------------------------------------------

describe("selectRouteByAccountOrdinal — exact requested account", () => {
  test("maps an inventory ordinal to its sparse managed slot and reserves it", () => {
    const dir = tmp();
    try {
      seedObservation(
        dir,
        [
          nativeRoute(win("session", 0.1)),
          managedRoute(9, win("session", 0.9)),
        ],
        {
          accountOrdinals: {
            default: 0,
            "claude-swap:4": 0,
            "claude-swap:9": 1,
          },
        },
      );
      const resolved = selectRouteByAccountOrdinal(1, {
        stateDir: dir,
        nowMs: NOW_MS,
      });
      expect(resolved).toEqual({
        ok: true,
        selection: {
          id: "claude-swap:9",
          kind: "managed",
          slot: 9,
          accountOrdinal: 1,
          reason: "requested-account",
        },
      });
      const ledger = JSON.parse(readFileSync(ledgerPath(dir), "utf8")) as {
        routes: Record<string, { reservations: number[] }>;
      };
      expect(ledger.routes["claude-swap:9"].reservations).toEqual([NOW_MS]);
      expect(ledger.routes.default).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the active inventory ordinal selects the native route even when balancing is disabled", () => {
    const dir = tmp();
    try {
      seedObservation(dir, [nativeRoute()], {
        health: "absent",
        accountOrdinals: {
          default: 1,
          "claude-swap:4": 0,
          "claude-swap:9": 1,
        },
        accountActiveRouteable: true,
      });
      const resolved = selectRouteByAccountOrdinal(1, {
        stateDir: dir,
        nowMs: NOW_MS,
      });
      expect(resolved).toEqual({
        ok: true,
        selection: {
          id: "default",
          kind: "native",
          slot: null,
          accountOrdinal: 1,
          reason: "requested-account",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a sole requested account resolves but keeps the statusline unlabeled", () => {
    const dir = tmp();
    try {
      seedObservation(dir, [nativeRoute()], {
        accountOrdinals: { default: 0, "claude-swap:7": 0 },
        accountActiveRouteable: true,
      });
      const resolved = selectRouteByAccountOrdinal(0, {
        stateDir: dir,
        nowMs: NOW_MS,
      });
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.selection.accountOrdinal).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing, stale, out-of-range, and unrouteable requests fail without fallback", () => {
    const absent = tmp();
    const stale = tmp();
    const unavailable = tmp();
    try {
      expect(
        selectRouteByAccountOrdinal(0, { stateDir: absent, nowMs: NOW_MS }),
      ).toMatchObject({
        ok: false,
        error: "no account inventory is available",
      });

      seedObservation(stale, [nativeRoute()], {
        observedAtMs: NOW_MS - 60 * 60_000,
        accountOrdinals: { default: 0, "claude-swap:4": 0 },
      });
      expect(
        selectRouteByAccountOrdinal(0, { stateDir: stale, nowMs: NOW_MS }),
      ).toMatchObject({ ok: false, error: "account inventory is stale" });

      seedObservation(unavailable, [nativeRoute()], {
        accountOrdinals: {
          default: 0,
          "claude-swap:4": 0,
          "claude-swap:9": 1,
        },
      });
      expect(
        selectRouteByAccountOrdinal(2, {
          stateDir: unavailable,
          nowMs: NOW_MS,
        }),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining("out of range"),
      });
      expect(
        selectRouteByAccountOrdinal(0, {
          stateDir: unavailable,
          nowMs: NOW_MS,
        }),
      ).toMatchObject({
        ok: false,
        error: "account c0 is known but is not currently routeable",
      });
      expect(
        selectRouteByAccountOrdinal(1, {
          stateDir: unavailable,
          nowMs: NOW_MS,
        }),
      ).toMatchObject({
        ok: false,
        error: "account c1 is known but is not currently routeable",
      });
      expect(existsSync(ledgerPath(unavailable))).toBe(false);
    } finally {
      rmSync(absent, { recursive: true, force: true });
      rmSync(stale, { recursive: true, force: true });
      rmSync(unavailable, { recursive: true, force: true });
    }
  });
});

describe("selectRoute — account display ordinal", () => {
  test("a single Claude account omits its ordinal", () => {
    const dir = tmp();
    try {
      seedObservation(dir, [nativeRoute(win("session", 0.2))], {
        accountOrdinals: { default: 0, "claude-swap:7": 0 },
      });
      expect(
        selectRoute({ stateDir: dir, nowMs: NOW_MS }).accountOrdinal,
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("multi-account selections use inventory position, not sparse slot", () => {
    const dir = tmp();
    try {
      seedObservation(
        dir,
        [
          nativeRoute(win("session", 0.8)),
          managedRoute(9, win("session", 0.1)),
        ],
        {
          accountOrdinals: {
            default: 0,
            "claude-swap:4": 0,
            "claude-swap:9": 1,
          },
        },
      );
      const selected = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(selected.id).toBe("claude-swap:9");
      expect(selected.accountOrdinal).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- headroom selection ----------------------------------------------

describe("selectRoute — greatest worst-window headroom", () => {
  test("only native carries windows → sole candidate", () => {
    const dir = tmp();
    try {
      seedObservation(dir, [nativeRoute(win("session", 0.4))]);
      const sel = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(sel).toMatchObject({
        id: NATIVE_ROUTE_ID,
        kind: "native",
        reason: "sole-candidate",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the lowest worst-window utilization (greatest headroom) wins", () => {
    const dir = tmp();
    try {
      // native worst 0.50; managed:3 worst 0.20 → managed:3 has more headroom.
      seedObservation(dir, [
        nativeRoute(win("session", 0.5)),
        managedRoute(3, win("session", 0.2)),
      ]);
      const sel = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(sel).toMatchObject({
        id: "claude-swap:3",
        kind: "managed",
        slot: 3,
        reason: "selected",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a candidate is scored by its WORST window, not its average", () => {
    const dir = tmp();
    try {
      // A: windows 0.10 + 0.80 → worst 0.80. B: 0.50 + 0.50 → worst 0.50. B wins.
      seedObservation(dir, [
        managedRoute(1, win("session", 0.1), win("week", 0.8)),
        managedRoute(2, win("session", 0.5), win("week", 0.5)),
      ]);
      const sel = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(sel.id).toBe("claude-swap:2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown-window route is excluded, never treated as zero usage", () => {
    const dir = tmp();
    try {
      // managed:9 has NO windows (unknown). Even though "0 usage" would look best,
      // it must be excluded — native (with windows) is the only candidate.
      seedObservation(dir, [nativeRoute(win("session", 0.9)), managedRoute(9)]);
      const sel = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(sel.id).toBe(NATIVE_ROUTE_ID);
      expect(sel.reason).toBe("sole-candidate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rollover grace: a window whose tz-aware reset is in the past counts as 0", () => {
    const dir = tmp();
    try {
      const pastReset = new Date(NOW_MS - 60_000).toISOString(); // tz-aware (Z), in the past
      // managed:3 looks maxed (0.9) but its window already reset → graced to 0,
      // so it beats native's genuine 0.5.
      seedObservation(dir, [
        nativeRoute(win("session", 0.5)),
        managedRoute(3, win("session", 0.9, pastReset)),
      ]);
      const sel = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(sel.id).toBe("claude-swap:3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- tie-breaks + anti-stampede --------------------------------------

describe("selectRoute — tie-breaks and reservation pressure", () => {
  test("equal headroom, never selected → stable route-id tie-break", () => {
    const dir = tmp();
    try {
      // native ("default") and managed:3 ("claude-swap:3") both at 0.30. Never
      // selected → LRU ties → smallest id wins: "claude-swap:3" < "default".
      seedObservation(dir, [
        nativeRoute(win("session", 0.3)),
        managedRoute(3, win("session", 0.3)),
      ]);
      const sel = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(sel.id).toBe("claude-swap:3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("simultaneous equal picks cannot stampede one route", () => {
    const dir = tmp();
    try {
      seedObservation(dir, [
        nativeRoute(win("session", 0.3)),
        managedRoute(3, win("session", 0.3)),
      ]);
      // Two launches at the SAME instant: the first pick's reservation shifts the
      // second to the other route. Pick 1 = claude-swap:3 (id tie); pick 2's
      // reservation pressure (0.30 + 0.05 = 0.35) makes native (0.30) win.
      const first = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      const second = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      expect(first.id).toBe("claude-swap:3");
      expect(second.id).toBe(NATIVE_ROUTE_ID);
      expect(first.id).not.toBe(second.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("both picks are recorded in ONE atomic ledger", () => {
    const dir = tmp();
    try {
      seedObservation(dir, [
        nativeRoute(win("session", 0.3)),
        managedRoute(3, win("session", 0.3)),
      ]);
      selectRoute({ stateDir: dir, nowMs: NOW_MS });
      selectRoute({ stateDir: dir, nowMs: NOW_MS });
      const ledger = JSON.parse(readFileSync(ledgerPath(dir), "utf8"));
      // Exactly one reservation each, in the single shared ledger.
      expect(ledger.routes["claude-swap:3"].reservations).toHaveLength(1);
      expect(ledger.routes[NATIVE_ROUTE_ID].reservations).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an expired reservation stops biasing after the TTL (no hardened claim)", () => {
    const dir = tmp();
    try {
      // managed:3 (0.20) beats native (0.50) until enough reservations pile on.
      // 0.20 + 6*0.05 = 0.50 ties native; the 7th pick rotates to native by LRU.
      seedObservation(dir, [
        nativeRoute(win("session", 0.5)),
        managedRoute(3, win("session", 0.2)),
      ]);
      for (let i = 0; i < 6; i++) {
        expect(selectRoute({ stateDir: dir, nowMs: NOW_MS }).id).toBe(
          "claude-swap:3",
        );
      }
      // Pressure now equal → native wins the tie (LRU: never selected).
      expect(selectRoute({ stateDir: dir, nowMs: NOW_MS }).id).toBe(
        NATIVE_ROUTE_ID,
      );
      // Advance past the reservation TTL: the pile of reservations lapses and
      // managed:3's real 0.20 headroom is restored — it is re-selectable.
      const later = NOW_MS + RESERVATION_TTL_MS + 1;
      expect(selectRoute({ stateDir: dir, nowMs: later }).id).toBe(
        "claude-swap:3",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("least-recently-used rotates fairly once reservation pressure lapses", () => {
    const dir = tmp();
    try {
      seedObservation(dir, [
        nativeRoute(win("session", 0.3)),
        managedRoute(3, win("session", 0.3)),
      ]);
      // Pick 1 at t0 → claude-swap:3 (id tie), stamping its last_selected_at.
      expect(selectRoute({ stateDir: dir, nowMs: NOW_MS }).id).toBe(
        "claude-swap:3",
      );
      // Past the TTL the reservation is gone, so pressure is equal again — but LRU
      // now favors native (never selected) over the recently-used managed:3.
      const later = NOW_MS + RESERVATION_TTL_MS + 1;
      expect(selectRoute({ stateDir: dir, nowMs: later }).id).toBe(
        NATIVE_ROUTE_ID,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt ledger fails open — selection still proceeds", () => {
    const dir = tmp();
    try {
      seedObservation(dir, [
        nativeRoute(win("session", 0.5)),
        managedRoute(3, win("session", 0.2)),
      ]);
      writeFileSync(ledgerPath(dir), "{ not json");
      const sel = selectRoute({ stateDir: dir, nowMs: NOW_MS });
      // Corrupt ledger → treated as empty → managed:3 still wins on headroom.
      expect(sel.id).toBe("claude-swap:3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
