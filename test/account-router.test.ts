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
  OBSERVATION_SCHEMA_VERSION,
  observationSidecarPath,
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
    windows: [
      { key: "session", utilization, resetsAt: null },
      { key: "week", utilization, resetsAt: null },
    ],
    measuredAtMs: NOW,
  };
}

function routeWithFable(
  slot: number,
  baseUtilization: number,
  fableUtilization: number | null,
): Route {
  return {
    ...route(slot, baseUtilization),
    windows: [
      ...route(slot, baseUtilization).windows,
      ...(fableUtilization === null
        ? []
        : [
            {
              key: "model:Fable",
              utilization: fableUtilization,
              resetsAt: null,
            },
          ]),
    ],
  };
}

function observation(
  routes: Route[],
  options: {
    observedAtMs?: number;
    health?: Observation["health"];
    count?: number;
    accountIssues?: Observation["account_issues"];
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
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: options.observedAtMs ?? NOW,
    health: options.health ?? "ok",
    routes,
    claude_accounts: { count, ordinals },
    account_issues: options.accountIssues ?? {},
    notes: [],
  };
}

function publish(dir: string, value: Observation): void {
  writeObservationSidecar(observationSidecarPath(dir), value);
}

describe("mandatory managed account selection", () => {
  test("missing, stale, unhealthy, and empty observations fail closed", () => {
    const dir = root();
    const missing = selectRoute({ stateDir: dir, nowMs: NOW });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error).toContain(
      "no current claude-swap inventory is available",
    );

    publish(dir, observation([route(1, 0.2)], { observedAtMs: NOW - 300_001 }));
    const stale = selectRoute({ stateDir: dir, nowMs: NOW });
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.error).toContain("301s old; maximum 300s");

    publish(dir, observation([], { health: "error", count: 0 }));
    const unhealthy = selectRoute({ stateDir: dir, nowMs: NOW });
    expect(unhealthy.ok).toBe(false);
    expect(!unhealthy.ok && unhealthy.error).toContain(
      "inventory health is error",
    );

    publish(dir, observation([], { count: 0 }));
    const empty = selectRoute({ stateDir: dir, nowMs: NOW });
    expect(empty.ok).toBe(false);
    expect(!empty.ok && empty.error).toContain("has no managed accounts");
  });

  test("stale Fable inventory explains every known account", () => {
    const dir = root();
    publish(
      dir,
      observation([routeWithFable(1, 0.2, 0.3), routeWithFable(2, 0.4, 0.5)], {
        observedAtMs: NOW - 300_001,
      }),
    );
    const result = selectRoute({ stateDir: dir, nowMs: NOW, model: "fable" });
    expect(result).toEqual({
      ok: false,
      error: [
        "Claude cannot start with Fable.",
        "  c0: inventory snapshot is stale (301s old; maximum 300s).",
        "  c1: inventory snapshot is stale (301s old; maximum 300s).",
        "Next: wait for keeperd to refresh it or run `cswap list --json`.",
      ].join("\n"),
    });
  });

  test("unsafe model text never enters launch diagnostics", () => {
    const dir = root();
    const result = selectRoute({
      stateDir: dir,
      nowMs: NOW,
      model: "private@example.test\nmodel",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(
      "Claude cannot start with the requested model",
    );
    expect(!result.ok && result.error).not.toContain("private@example.test");
  });

  test("measurement age and future skew do not veto shared route admission", () => {
    const dir = root();
    const oldMeasurement = {
      ...route(3, 0.2),
      measuredAtMs: Date.parse("2001-01-01T00:00:00Z"),
    };
    const futureMeasurement = {
      ...route(4, 0.4),
      measuredAtMs: Date.parse("2099-01-01T00:00:00Z"),
    };
    publish(dir, observation([oldMeasurement, futureMeasurement]));

    expect(selectRoute({ stateDir: dir, nowMs: NOW })).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:3" },
    });
    expect(
      selectRouteByAccountOrdinal(1, { stateDir: dir, nowMs: NOW }),
    ).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:4", reason: "requested-account" },
    });
    expect(inspectRouting({ stateDir: dir, nowMs: NOW })).toMatchObject({
      enabled: true,
      would_choose: { id: "claude-swap:3" },
      candidates: [
        { id: "claude-swap:3", worst_utilization: 0.25 },
        { id: "claude-swap:4", worst_utilization: 0.45 },
      ],
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

  test("Fable uses raw Fable quota after a reported reset time", () => {
    const dir = root();
    const elapsedReset = routeWithFable(2, 0.1, 0.8);
    elapsedReset.windows = elapsedReset.windows.map((window) =>
      window.key === "model:Fable"
        ? { ...window, resetsAt: "2026-07-17T23:00:00Z" }
        : window,
    );
    publish(
      dir,
      observation([
        routeWithFable(1, 0.8, 0.1),
        elapsedReset,
        routeWithFable(3, 0.05, null),
      ]),
    );
    const inspection = inspectRouting({
      stateDir: dir,
      nowMs: NOW,
      model: "fAbLe",
    });
    expect(inspection.model_scope).toBe("fable");
    expect(inspection.would_choose?.id).toBe("claude-swap:1");
    expect(
      inspection.candidates.map(
        ({ id, worst_utilization, fable_remaining }) => ({
          id,
          worst_utilization,
          fable_remaining,
        }),
      ),
    ).toEqual([
      {
        id: "claude-swap:1",
        worst_utilization: 0.8,
        fable_remaining: 0.9,
      },
      {
        id: "claude-swap:2",
        worst_utilization: 0.1,
        fable_remaining: 0.2,
      },
    ]);
    const first = selectRoute({ stateDir: dir, nowMs: NOW, model: "fable" });
    const second = selectRoute({
      stateDir: dir,
      nowMs: NOW + 1,
      model: "fable",
    });
    expect(first.ok && first.selection.id).toBe("claude-swap:1");
    expect(second.ok && second.selection.id).toBe("claude-swap:1");
  });

  test("non-Fable conserves Fable-rich accounts", () => {
    const noFableDir = root();
    publish(
      noFableDir,
      observation([
        routeWithFable(1, 0.1, 0.1),
        routeWithFable(2, 0.8, 0.8),
        routeWithFable(3, 0.9, null),
      ]),
    );
    const noFable = selectRoute({
      stateDir: noFableDir,
      nowMs: NOW,
      model: "sonnet",
    });
    expect(noFable.ok && noFable.selection.id).toBe("claude-swap:3");

    const leastFableDir = root();
    publish(
      leastFableDir,
      observation([routeWithFable(1, 0.1, 0.1), routeWithFable(2, 0.8, 0.8)]),
    );
    const leastFable = selectRoute({
      stateDir: leastFableDir,
      nowMs: NOW,
      model: "opus",
    });
    expect(leastFable.ok && leastFable.selection.id).toBe("claude-swap:2");
  });

  test("Fable failure explains every managed account on separate lines", () => {
    const dir = root();
    publish(
      dir,
      observation([routeWithFable(1, 0.2, 1)], {
        count: 2,
        accountIssues: { "claude-swap:21": "token-expired" },
      }),
    );
    expect(selectRoute({ stateDir: dir, nowMs: NOW, model: "fable" })).toEqual({
      ok: false,
      error: [
        "Claude cannot start with Fable.",
        "  c0: Fable quota is exhausted.",
        "  c1: has an expired token.",
        "Next: run `cswap list --json` to refresh status or repair the listed account.",
      ].join("\n"),
    });
  });

  test("Fable requires non-exhausted week and Fable quota", () => {
    const exhaustedWeek = routeWithFable(2, 0.1, 0.1);
    exhaustedWeek.windows = exhaustedWeek.windows.map((window) =>
      window.key === "week" ? { ...window, utilization: 1 } : window,
    );
    const exhaustedFable = routeWithFable(3, 0.1, 1);
    const missingFable = routeWithFable(4, 0.1, null);
    const valid = routeWithFable(6, 0.9, 0.9);
    const dir = root();
    publish(
      dir,
      observation([exhaustedWeek, exhaustedFable, missingFable, valid]),
    );
    const selected = selectRoute({ stateDir: dir, nowMs: NOW, model: "fable" });
    expect(selected.ok && selected.selection.id).toBe("claude-swap:6");
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

  test("raw exhaustion remains authoritative after a reported reset time", () => {
    const dir = root();
    const exhausted: Route = {
      ...route(1, 1),
      windows: [
        { key: "session", utilization: 0.1, resetsAt: null },
        { key: "week", utilization: 1, resetsAt: "2026-07-17T23:00:00Z" },
      ],
    };
    publish(dir, observation([exhausted, route(2, 0.2)]));
    expect(selectRoute({ stateDir: dir, nowMs: NOW })).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:2" },
    });
    const explicit = selectRouteByAccountOrdinal(0, {
      stateDir: dir,
      nowMs: NOW,
    });
    expect(explicit.ok).toBe(false);
    expect(!explicit.ok && explicit.error).toContain(
      "weekly quota is exhausted; resets 2026-07-17T23:00:00.000Z",
    );
    expect(inspectRouting({ stateDir: dir, nowMs: NOW })).toMatchObject({
      enabled: true,
      would_choose: { id: "claude-swap:2" },
      candidates: [{ id: "claude-swap:2", worst_utilization: 0.25 }],
    });
  });
});

describe("durable Fable focus", () => {
  const policy = {
    schema_version: 1 as const,
    policy_id: "event:7",
    target_route: "claude-swap:2" as const,
    fable_intent: true as const,
    set_at: "2026-07-17T00:00:00.000Z",
    lifetime: { kind: "permanent" as const },
  };

  test("eligible target serves every Fable launch despite age and reservation pressure", () => {
    const dir = root();
    const target = {
      ...routeWithFable(2, 0.9, 0.9),
      measuredAtMs: Date.parse("2001-01-01T00:00:00Z"),
    };
    publish(dir, observation([routeWithFable(1, 0.01, 0.01), target]));
    const deps = {
      stateDir: dir,
      nowMs: NOW,
      model: "fable",
      focusDelivery: { available: true as const, policy },
    };
    expect(selectRoute(deps)).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:2", reason: "fable-focus" },
    });
    expect(selectRoute({ ...deps, nowMs: NOW + 1 })).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:2", reason: "fable-focus" },
    });
    expect(inspectRouting(deps).fable_focus).toMatchObject({
      state: "active",
      target_route: "claude-swap:2",
      target_eligible: true,
      outcome: "focused",
      reason: "target-focused",
    });
  });

  test("ineligible target visibly falls back to unchanged balancing", () => {
    const dir = root();
    publish(
      dir,
      observation([
        routeWithFable(1, 0.2, 0.2),
        routeWithFable(2, 0.1, 1),
        routeWithFable(3, 0.8, 0.8),
      ]),
    );
    const deps = {
      stateDir: dir,
      nowMs: NOW,
      model: "fable",
      focusDelivery: { available: true as const, policy },
    };
    expect(selectRoute(deps)).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:1", reason: "fable-focus-fallback" },
    });
    expect(inspectRouting(deps).fable_focus).toMatchObject({
      target_eligible: false,
      outcome: "fallback",
      reason: "target-ineligible",
    });
  });

  test("non-Fable avoids the target with an alternative and uses it alone", () => {
    const dir = root();
    publish(
      dir,
      observation([routeWithFable(1, 0.9, 0.9), routeWithFable(2, 0.01, 0.01)]),
    );
    const focusDelivery = { available: true as const, policy };
    expect(
      selectRoute({
        stateDir: dir,
        nowMs: NOW,
        model: "opus",
        focusDelivery,
      }),
    ).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:1", reason: "fable-focus-avoided" },
    });

    publish(dir, observation([routeWithFable(2, 0.1, 0.1)]));
    expect(
      selectRoute({
        stateDir: dir,
        nowMs: NOW + 1,
        model: "opus",
        focusDelivery,
      }),
    ).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:2", reason: "sole-candidate" },
    });
  });

  test("stale capacity still exposes configured policy without claiming eligibility", () => {
    const dir = root();
    publish(
      dir,
      observation([routeWithFable(2, 0.2, 0.2)], {
        observedAtMs: NOW - 300_001,
      }),
    );
    expect(
      inspectRouting({
        stateDir: dir,
        nowMs: NOW,
        model: "fable",
        focusDelivery: { available: true, policy },
      }),
    ).toMatchObject({
      enabled: false,
      fable_focus: {
        configured: true,
        state: "active",
        target_route: "claude-swap:2",
        target_eligible: null,
        outcome: "fallback",
        reason: "target-ineligible",
      },
    });
  });

  test("explicit account resolution remains exact under focus", () => {
    const dir = root();
    publish(
      dir,
      observation([routeWithFable(1, 0.2, 0.2), routeWithFable(2, 0.2, 0.2)]),
    );
    expect(
      selectRouteByAccountOrdinal(0, {
        stateDir: dir,
        nowMs: NOW,
        model: "fable",
        focusDelivery: { available: true, policy },
      }),
    ).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:1", reason: "requested-account" },
    });
  });
});

describe("independent scoped Account focus", () => {
  const fablePolicy = {
    schema_version: 1 as const,
    policy_id: "event:20",
    target_route: "claude-swap:1" as const,
    fable_intent: true as const,
    set_at: "2026-07-17T00:00:00.000Z",
    lifetime: { kind: "permanent" as const },
  };
  const nonFablePolicy = {
    schema_version: 1 as const,
    policy_id: "event:21",
    target_route: "claude-swap:2" as const,
    fable_intent: false as const,
    set_at: "2026-07-17T00:00:00.000Z",
    lifetime: { kind: "permanent" as const },
  };
  const deliveries = {
    focusDelivery: { available: true as const, policy: fablePolicy },
    nonFableFocusDelivery: {
      available: true as const,
      policy: nonFablePolicy,
    },
  };

  test("proven Non-Fable focus wins before Fable avoidance and reservation pressure", () => {
    const dir = root();
    publish(
      dir,
      observation([
        routeWithFable(1, 0.01, 0.9),
        routeWithFable(2, 0.95, 0.1),
        routeWithFable(3, 0.02, null),
      ]),
    );
    const first = selectRoute({
      stateDir: dir,
      nowMs: NOW,
      model: "opus",
      fableIntent: false,
      ...deliveries,
    });
    const second = selectRoute({
      stateDir: dir,
      nowMs: NOW + 1,
      model: "opus",
      fableIntent: false,
      ...deliveries,
    });
    expect(first).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:2", reason: "non-fable-focus" },
    });
    expect(second).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:2", reason: "non-fable-focus" },
    });
  });

  test("proven Fable ignores Non-Fable focus and unknown intent matches neither", () => {
    const fableDir = root();
    publish(
      fableDir,
      observation([routeWithFable(1, 0.8, 0.8), routeWithFable(2, 0.01, 0.01)]),
    );
    expect(
      selectRoute({
        stateDir: fableDir,
        nowMs: NOW,
        model: "fable",
        fableIntent: true,
        ...deliveries,
      }),
    ).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:1", reason: "fable-focus" },
    });

    const unknownDir = root();
    publish(
      unknownDir,
      observation([routeWithFable(1, 0.2, 0.9), routeWithFable(2, 0.2, 0.1)]),
    );
    expect(
      selectRoute({
        stateDir: unknownDir,
        nowMs: NOW,
        model: null,
        fableIntent: null,
        ...deliveries,
      }),
    ).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:1", reason: "selected" },
    });
  });

  test("ineligible Non-Fable target visibly falls through Fable avoidance", () => {
    const dir = root();
    const ineligible = routeWithFable(2, 0.1, 0.1);
    ineligible.windows = ineligible.windows.map((window) =>
      window.key === "week" ? { ...window, utilization: 1 } : window,
    );
    publish(
      dir,
      observation([
        routeWithFable(1, 0.1, 0.9),
        ineligible,
        routeWithFable(3, 0.9, 0.2),
      ]),
    );
    const deps = {
      stateDir: dir,
      nowMs: NOW,
      model: "opus",
      fableIntent: false,
      ...deliveries,
    };
    expect(selectRoute(deps)).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:3", reason: "fable-focus-avoided" },
    });
    expect(inspectRouting(deps).non_fable_focus).toEqual({
      configured: true,
      state: "active",
      target_route: "claude-swap:2",
      lifetime: { kind: "permanent" },
      target_eligible: false,
      outcome: "fallback",
      reason: "target-ineligible",
      diagnostic: "none",
    });
  });

  test("same target reports two independent focused outcomes", () => {
    const dir = root();
    publish(
      dir,
      observation([routeWithFable(1, 0.1, 0.1), routeWithFable(2, 0.9, 0.9)]),
    );
    const sameTargetFable = {
      ...fablePolicy,
      target_route: "claude-swap:2" as const,
    };
    const inspection = inspectRouting({
      stateDir: dir,
      nowMs: NOW,
      model: "opus",
      fableIntent: false,
      focusDelivery: { available: true, policy: sameTargetFable },
      nonFableFocusDelivery: {
        available: true,
        policy: nonFablePolicy,
      },
    });
    expect(inspection.fable_focus).toMatchObject({
      target_route: "claude-swap:2",
      outcome: "focused",
      reason: "target-focused",
    });
    expect(inspection.non_fable_focus).toMatchObject({
      target_route: "claude-swap:2",
      outcome: "focused",
      reason: "target-focused",
    });
    expect(inspection.would_choose).toMatchObject({
      id: "claude-swap:2",
      reason: "non-fable-focus",
    });
  });

  test("expired and unavailable Non-Fable policy state stays isolated", () => {
    const dir = root();
    publish(
      dir,
      observation([routeWithFable(1, 0.2, 0.2), routeWithFable(2, 0.8, 0.8)]),
    );
    const expired = {
      ...nonFablePolicy,
      lifetime: {
        kind: "absolute" as const,
        deadline_at: "2026-07-18T00:00:00.000Z",
      },
    };
    expect(
      inspectRouting({
        stateDir: dir,
        nowMs: NOW,
        model: "opus",
        fableIntent: false,
        focusDelivery: deliveries.focusDelivery,
        nonFableFocusDelivery: { available: true, policy: expired },
      }).non_fable_focus,
    ).toMatchObject({
      state: "expired",
      outcome: "fallback",
      reason: "policy-inactive",
    });
    const unavailable = inspectRouting({
      stateDir: dir,
      nowMs: NOW,
      model: "fable",
      fableIntent: true,
      focusDelivery: deliveries.focusDelivery,
      nonFableFocusDelivery: {
        available: false,
        diagnostic: "delivery-malformed",
      },
    });
    expect(unavailable.fable_focus.outcome).toBe("focused");
    expect(unavailable.non_fable_focus).toMatchObject({
      state: "unavailable",
      outcome: "fallback",
      reason: "policy-unavailable",
      diagnostic: "delivery-malformed",
    });
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

  test("a depleted explicit Fable account fails without substitution", () => {
    const dir = root();
    publish(
      dir,
      observation([routeWithFable(1, 0.1, 1), routeWithFable(2, 0.8, 0.1)]),
    );
    const result = selectRouteByAccountOrdinal(0, {
      stateDir: dir,
      nowMs: NOW,
      model: "fable",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(
      "Requested account c0 cannot serve Fable.\n  c0: Fable quota is exhausted.",
    );
    expect(!result.ok && result.error).toContain(
      "Next: choose another --x-account",
    );
  });

  test("known but unrouteable and out-of-range accounts fail", () => {
    const dir = root();
    publish(
      dir,
      observation([route(9, 0.1)], {
        count: 2,
        accountIssues: { "claude-swap:21": "usage-unavailable" },
      }),
    );
    const unavailable = selectRouteByAccountOrdinal(1, {
      stateDir: dir,
      nowMs: NOW,
    });
    expect(unavailable.ok).toBe(false);
    expect(!unavailable.ok && unavailable.error).toContain(
      "Requested account c1 cannot serve this Claude launch.\n  c1: has unavailable usage according to claude-swap.",
    );
    expect(
      selectRouteByAccountOrdinal(2, { stateDir: dir, nowMs: NOW }),
    ).toEqual({
      ok: false,
      error: [
        "Requested account c2 is not registered.",
        "  Available account labels: c0-c1.",
        "Next: choose a listed --x-account label or register another claude-swap account.",
      ].join("\n"),
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
