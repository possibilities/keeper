import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Observation, Route } from "../src/account-observation";
import { writeObservationSidecar } from "../src/account-observation";
import {
  inspectRouting,
  selectRoute,
  selectRouteByAccountOrdinal,
} from "../src/account-router";
import {
  ledgerPath,
  observationSidecarPath,
  ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS,
} from "../src/account-routing-config";

const NOW = Date.parse("2026-07-18T00:00:00Z");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "keeper-account-router-"));
  roots.push(dir);
  return dir;
}

function route(slot: number, utilization: number): Route {
  return {
    id: `claude-swap:${slot}`,
    kind: "managed",
    slot,
    windows: [{ key: "week", utilization, resetsAt: null }],
    measuredAtMs: NOW,
  };
}

function routeWithScopes(
  slot: number,
  weekly: number,
  fable: number,
  other?: number,
): Route {
  return {
    ...route(slot, weekly),
    windows: [
      { key: "week", utilization: weekly, resetsAt: null },
      { key: "model:Fable", utilization: fable, resetsAt: null },
      ...(other === undefined
        ? []
        : [{ key: "model:Other", utilization: other, resetsAt: null }]),
    ],
  };
}

function observation(
  routes: Route[],
  options: {
    observedAtMs?: number;
    health?: Observation["health"];
    count?: number;
  } = {},
): Observation {
  const count = options.count ?? routes.length;
  const ordinals: Record<string, number> = {};
  for (let i = 0; i < count; i += 1) {
    const candidate = routes[i];
    const id = candidate?.id ?? `claude-swap:${i + 20}`;
    ordinals[id] = i;
  }
  return {
    schema_version: 4,
    observed_at_ms: options.observedAtMs ?? NOW,
    health: options.health ?? "ok",
    routes,
    claude_accounts: { count, ordinals },
    notes: [],
  };
}

function publish(dir: string, value: Observation): void {
  writeObservationSidecar(observationSidecarPath(dir), value);
}

describe("mandatory managed account selection", () => {
  test("missing, stale, unhealthy, and empty observations fail closed", () => {
    const dir = root();
    expect(selectRoute({ stateDir: dir, nowMs: NOW })).toEqual({
      ok: false,
      error: "no claude-swap account inventory is available",
    });

    publish(dir, observation([route(1, 0.2)], { observedAtMs: NOW - 300_001 }));
    expect(selectRoute({ stateDir: dir, nowMs: NOW })).toEqual({
      ok: false,
      error: "claude-swap account inventory is stale",
    });

    publish(dir, observation([], { health: "error", count: 0 }));
    expect(selectRoute({ stateDir: dir, nowMs: NOW })).toEqual({
      ok: false,
      error: "claude-swap account inventory is error",
    });

    publish(dir, observation([], { count: 0 }));
    expect(selectRoute({ stateDir: dir, nowMs: NOW })).toEqual({
      ok: false,
      error: "no fresh routeable claude-swap account is available",
    });
  });

  test("revalidates route measurement freshness at the launch boundary", () => {
    const dir = root();
    const boundary = {
      ...route(3, 0.2),
      measuredAtMs: NOW - ROUTE_MEASUREMENT_FRESHNESS_CEILING_MS,
    };
    publish(dir, observation([boundary]));
    expect(selectRoute({ stateDir: dir, nowMs: NOW }).ok).toBe(true);

    const expired = { ...boundary, measuredAtMs: boundary.measuredAtMs - 1 };
    publish(dir, observation([expired]));
    expect(selectRoute({ stateDir: dir, nowMs: NOW })).toEqual({
      ok: false,
      error: "no fresh routeable claude-swap account is available",
    });
    expect(
      selectRouteByAccountOrdinal(0, { stateDir: dir, nowMs: NOW }),
    ).toEqual({
      ok: false,
      error: "account c0 is known but is not currently routeable",
    });
    expect(inspectRouting({ stateDir: dir, nowMs: NOW })).toMatchObject({
      enabled: false,
      would_choose: null,
      error: "no fresh routeable claude-swap account is available",
    });
  });

  test("chooses greatest worst-window headroom and returns a managed slot", () => {
    const dir = root();
    publish(dir, observation([route(2, 0.7), route(9, 0.2)]));
    expect(selectRoute({ stateDir: dir, nowMs: NOW })).toEqual({
      ok: true,
      selection: {
        id: "claude-swap:9",
        kind: "managed",
        slot: 9,
        accountOrdinal: 1,
        reason: "selected",
      },
    });
  });

  test("uses only the matching model scope when balancing a launch", () => {
    const genericDir = root();
    publish(
      genericDir,
      observation([
        routeWithScopes(1, 0.1, 1),
        routeWithScopes(2, 0.7, 0.2, 1),
      ]),
    );
    const generic = selectRoute({ stateDir: genericDir, nowMs: NOW });
    expect(generic.ok && generic.selection.id).toBe("claude-swap:1");

    const fableDir = root();
    publish(
      fableDir,
      observation([
        routeWithScopes(1, 0.1, 1),
        routeWithScopes(2, 0.7, 0.2, 1),
      ]),
    );
    const fable = selectRoute({
      stateDir: fableDir,
      nowMs: NOW,
      model: "fAbLe",
    });
    expect(fable.ok && fable.selection.id).toBe("claude-swap:2");

    const inspection = inspectRouting({
      stateDir: fableDir,
      nowMs: NOW,
      model: "fable",
    });
    expect(inspection.model_scope).toBe("fable");
    expect(
      inspection.candidates.map(({ id, worst_utilization }) => ({
        id,
        worst_utilization,
      })),
    ).toEqual([
      { id: "claude-swap:1", worst_utilization: 1 },
      { id: "claude-swap:2", worst_utilization: 0.75 },
    ]);
  });

  test("reservations spread equal concurrent selections", () => {
    const dir = root();
    publish(dir, observation([route(2, 0.2), route(9, 0.2)]));
    const first = selectRoute({ stateDir: dir, nowMs: NOW });
    const second = selectRoute({ stateDir: dir, nowMs: NOW + 1 });
    expect(first.ok && first.selection.id).toBe("claude-swap:2");
    expect(second.ok && second.selection.id).toBe("claude-swap:9");
    const ledger = JSON.parse(readFileSync(ledgerPath(dir), "utf8"));
    expect(ledger.schema_version).toBe(2);
    expect(Object.keys(ledger.routes).sort()).toEqual([
      "claude-swap:2",
      "claude-swap:9",
    ]);
  });

  test("past reset windows receive rollover grace", () => {
    const dir = root();
    const reset: Route = {
      ...route(1, 1),
      windows: [
        { key: "week", utilization: 1, resetsAt: "2026-07-17T23:00:00Z" },
      ],
    };
    publish(dir, observation([reset, route(2, 0.2)]));
    const selected = selectRoute({ stateDir: dir, nowMs: NOW });
    expect(selected.ok && selected.selection.id).toBe("claude-swap:1");
  });
});

describe("explicit account resolution", () => {
  test("the active account is an ordinary managed route", () => {
    const dir = root();
    publish(dir, observation([route(7, 0.1), route(4, 0.2)]));
    expect(
      selectRouteByAccountOrdinal(0, { stateDir: dir, nowMs: NOW }),
    ).toEqual({
      ok: true,
      selection: {
        id: "claude-swap:7",
        kind: "managed",
        slot: 7,
        accountOrdinal: 0,
        reason: "requested-account",
      },
    });
  });

  test("a depleted model scope never overrides an explicit account", () => {
    const dir = root();
    publish(
      dir,
      observation([routeWithScopes(1, 0.1, 1), routeWithScopes(2, 0.8, 0.1)]),
    );
    expect(
      selectRouteByAccountOrdinal(0, {
        stateDir: dir,
        nowMs: NOW,
        model: "fable",
      }),
    ).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:1", slot: 1 },
    });
  });

  test("known but unrouteable and out-of-range accounts fail", () => {
    const dir = root();
    publish(dir, observation([route(9, 0.1)], { count: 2 }));
    expect(
      selectRouteByAccountOrdinal(1, { stateDir: dir, nowMs: NOW }),
    ).toEqual({
      ok: false,
      error: "account c1 is known but is not currently routeable",
    });
    expect(
      selectRouteByAccountOrdinal(2, { stateDir: dir, nowMs: NOW }),
    ).toEqual({
      ok: false,
      error: "account c2 is out of range (available: c0-c1)",
    });
  });
});

describe("read-only inspection", () => {
  test("reports an unavailable choice instead of fabricating default", () => {
    const result = inspectRouting({ stateDir: root(), nowMs: NOW });
    expect(result).toMatchObject({
      enabled: false,
      would_choose: null,
      error: "no claude-swap account inventory is available",
    });
  });

  test("reports candidates and choice without writing a ledger", () => {
    const dir = root();
    publish(dir, observation([route(2, 0.4), route(5, 0.1)]));
    const result = inspectRouting({ stateDir: dir, nowMs: NOW });
    expect(result.enabled).toBe(true);
    expect(result.error).toBeNull();
    expect(result.would_choose?.id).toBe("claude-swap:5");
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      "claude-swap:2",
      "claude-swap:5",
    ]);
    expect(() => readFileSync(ledgerPath(dir), "utf8")).toThrow();
  });
});
