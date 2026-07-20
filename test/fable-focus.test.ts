import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Observation,
  writeObservationSidecar,
} from "../src/account-observation";
import { selectRoute } from "../src/account-router";
import {
  OBSERVATION_SCHEMA_VERSION,
  observationSidecarPath,
} from "../src/account-routing-config";
import {
  buildCurrentResetFableFocus,
  effectiveFableFocus,
  materializeFableFocusPolicy,
  normalizeFableFocusInput,
  publishFableFocusLeaf,
  readFableFocusLeaf,
} from "../src/fable-focus";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const RESET = "2026-07-20T23:59:59.000Z";
const OLD_MEASUREMENT = NOW - 3 * 60 * 60_000;

function observation(
  overrides: Partial<Observation> = {},
  utilization = 0.75,
  measuredAtMs = NOW,
): Observation {
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW,
    health: "ok",
    routes: [
      {
        id: "claude-swap:2",
        kind: "managed",
        slot: 2,
        measuredAtMs,
        windows: [
          { key: "session", utilization: 0.1, resetsAt: RESET },
          { key: "week", utilization: 0.2, resetsAt: RESET },
          {
            key: "model:Fable",
            utilization,
            resetsAt: RESET,
          },
        ],
      },
    ],
    claude_accounts: {
      count: 1,
      ordinals: { "claude-swap:2": 0 },
    },
    account_issues: {},
    notes: [],
    ...overrides,
  };
}

function policy(
  lifetime:
    | { kind: "permanent" }
    | { kind: "absolute"; deadline_at: string }
    | { kind: "cycle-end"; reset_at: string },
) {
  const value = materializeFableFocusPolicy(
    { target_route: "claude-swap:2", lifetime },
    42,
    NOW / 1_000,
  );
  if (value === null) throw new Error("expected policy");
  return value;
}

test("tagged inputs canonicalize atomically and reject PII/control characters", () => {
  expect(
    normalizeFableFocusInput({
      target_route: "claude-swap:2",
      lifetime: { kind: "permanent" },
    }),
  ).toEqual({
    target_route: "claude-swap:2",
    lifetime: { kind: "permanent" },
  });
  expect(
    normalizeFableFocusInput({
      target_route: "claude-swap:2",
      lifetime: {
        kind: "absolute",
        deadline_at: "2026-07-20T19:59:59-04:00",
      },
    }),
  ).toEqual({
    target_route: "claude-swap:2",
    lifetime: { kind: "absolute", deadline_at: RESET },
  });
  expect(
    normalizeFableFocusInput({
      target_route: "claude-swap:2",
      lifetime: { kind: "current-reset", reset_at: RESET },
    }),
  ).toEqual({
    target_route: "claude-swap:2",
    lifetime: { kind: "absolute", deadline_at: RESET },
  });
  expect(
    normalizeFableFocusInput({
      target_route: "claude-swap:2",
      lifetime: { kind: "cycle-end", reset_at: RESET },
    }),
  ).toEqual({
    target_route: "claude-swap:2",
    lifetime: { kind: "cycle-end", reset_at: RESET },
  });
  for (const target_route of [
    "claude-swap:0",
    "claude-swap:02",
    "claude-swap:2\n",
    "person@example.com",
    "claude-swap:2\u001b[31m",
  ]) {
    expect(
      normalizeFableFocusInput({
        target_route,
        lifetime: { kind: "permanent" },
      }),
    ).toBeNull();
  }
});

test("policy identity and set timestamp derive only from event data", () => {
  expect(policy({ kind: "permanent" })).toEqual({
    schema_version: 1,
    policy_id: "event:42",
    target_route: "claude-swap:2",
    fable_intent: true,
    set_at: "2026-07-18T12:00:00.000Z",
    lifetime: { kind: "permanent" },
  });
  expect(
    materializeFableFocusPolicy(
      {
        target_route: "claude-swap:2",
        lifetime: { kind: "permanent" },
      },
      42,
      Number.NaN,
    ),
  ).toBeNull();
});

test("old-measurement focus falls back on removal and resumes the durable target", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-fable-focus-routing-"));
  const target = observation({}, 0.75, OLD_MEASUREMENT).routes[0];
  if (target === undefined) throw new Error("expected target route");
  const alternate: Observation["routes"][number] = {
    id: "claude-swap:3",
    kind: "managed",
    slot: 3,
    measuredAtMs: NOW,
    windows: [
      { key: "session", utilization: 0.1, resetsAt: RESET },
      { key: "week", utilization: 0.1, resetsAt: RESET },
      { key: "model:Fable", utilization: 0.2, resetsAt: RESET },
    ],
  };
  const available = observation({
    routes: [target, alternate],
    claude_accounts: {
      count: 2,
      ordinals: { "claude-swap:2": 0, "claude-swap:3": 1 },
    },
    account_issues: {},
  });
  const removed = observation({
    routes: [alternate],
    claude_accounts: {
      count: 2,
      ordinals: { "claude-swap:2": 0, "claude-swap:3": 1 },
    },
    account_issues: { "claude-swap:2": "relogin-required" },
  });
  const durablePolicy = policy({ kind: "permanent" });
  const deps = {
    stateDir: dir,
    nowMs: NOW,
    model: "fable",
    focusDelivery: { available: true as const, policy: durablePolicy },
  };
  try {
    writeObservationSidecar(observationSidecarPath(dir), available);
    expect(selectRoute(deps)).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:2", reason: "fable-focus" },
    });

    writeObservationSidecar(observationSidecarPath(dir), removed);
    expect(selectRoute({ ...deps, nowMs: NOW + 1 })).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:3", reason: "fable-focus-fallback" },
    });

    writeObservationSidecar(observationSidecarPath(dir), available);
    expect(selectRoute({ ...deps, nowMs: NOW + 2 })).toMatchObject({
      ok: true,
      selection: { id: "claude-swap:2", reason: "fable-focus" },
    });
    expect(deps.focusDelivery.policy).toBe(durablePolicy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("permanent and absolute policies evaluate with a half-open deadline", () => {
  expect(
    effectiveFableFocus(
      { available: true, policy: policy({ kind: "permanent" }) },
      null,
      NOW,
    ).state,
  ).toBe("active");
  const absolute = policy({ kind: "absolute", deadline_at: RESET });
  const deadline = Date.parse(RESET);
  expect(
    effectiveFableFocus(
      { available: true, policy: absolute },
      null,
      deadline - 1,
    ).state,
  ).toBe("active");
  expect(
    effectiveFableFocus({ available: true, policy: absolute }, null, deadline)
      .state,
  ).toBe("expired");
  expect(
    effectiveFableFocus(
      { available: true, policy: absolute },
      null,
      deadline + 1,
    ).state,
  ).toBe("expired");
});

test("invalid policy input is visible and never treated as active", () => {
  const malformed = {
    ...policy({ kind: "permanent" }),
    target_route: "person@example.com",
  };
  expect(
    effectiveFableFocus(
      { available: true, policy: malformed as never },
      null,
      NOW,
    ),
  ).toEqual({
    state: "invalid",
    policy: null,
    diagnostic: "policy-invalid",
  });
});

test("cycle-end uses fresh Capacity and matching resets despite old Measurement age", () => {
  const cycle = policy({ kind: "cycle-end", reset_at: RESET });
  expect(
    effectiveFableFocus(
      { available: true, policy: cycle },
      observation({}, 0.99, OLD_MEASUREMENT),
      NOW,
    ).state,
  ).toBe("active");
  const mismatched = observation({}, 1, OLD_MEASUREMENT);
  const mismatchedWindow = mismatched.routes[0]?.windows.find(
    (window) => window.key === "model:Fable",
  );
  if (mismatchedWindow === undefined) throw new Error("expected Fable window");
  mismatchedWindow.resetsAt = "2026-07-21T23:59:59.000Z";
  expect(
    effectiveFableFocus({ available: true, policy: cycle }, mismatched, NOW)
      .state,
  ).toBe("active");
  expect(
    effectiveFableFocus(
      { available: true, policy: cycle },
      observation({}, 1, OLD_MEASUREMENT),
      NOW,
    ).state,
  ).toBe("completed");
  const stale = observation({ observed_at_ms: NOW - 600_000 }, 1);
  expect(
    effectiveFableFocus({ available: true, policy: cycle }, stale, NOW).state,
  ).toBe("active");
  expect(
    effectiveFableFocus(
      { available: true, policy: cycle },
      null,
      Date.parse(RESET),
    ).state,
  ).toBe("completed");
});

test("current-reset admits old Measurement evidence but refuses stale, elapsed, and mismatched resets", () => {
  const admittedOldMeasurement = observation({}, 0.75, OLD_MEASUREMENT);
  expect(
    buildCurrentResetFableFocus(
      "claude-swap:2",
      admittedOldMeasurement,
      NOW,
      RESET,
    ),
  ).toEqual({
    ok: true,
    focus: {
      target_route: "claude-swap:2",
      lifetime: { kind: "current-reset", reset_at: RESET },
    },
  });
  expect(
    buildCurrentResetFableFocus(
      "claude-swap:2",
      observation({ observed_at_ms: NOW - 600_000 }),
      NOW,
    ),
  ).toEqual({ ok: false, reason: "observation-stale" });
  const elapsedObservation = observation();
  elapsedObservation.observed_at_ms = Date.parse(RESET);
  const elapsedRoute = elapsedObservation.routes[0];
  if (elapsedRoute === undefined) throw new Error("expected route");
  elapsedRoute.measuredAtMs = Date.parse(RESET);
  expect(
    buildCurrentResetFableFocus(
      "claude-swap:2",
      elapsedObservation,
      Date.parse(RESET),
    ),
  ).toEqual({ ok: false, reason: "reset-elapsed" });
  expect(
    buildCurrentResetFableFocus(
      "claude-swap:2",
      admittedOldMeasurement,
      NOW,
      "2026-07-21T23:59:59Z",
    ),
  ).toEqual({ ok: false, reason: "reset-mismatch" });
});

test("missing, malformed, unsupported, and insecure leaves degrade to unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-fable-focus-"));
  const path = join(dir, "policy.json");
  try {
    expect(readFableFocusLeaf(path)).toEqual({
      available: false,
      diagnostic: "delivery-missing",
    });
    writeFileSync(path, "not-json", { mode: 0o600 });
    expect(readFableFocusLeaf(path)).toEqual({
      available: false,
      diagnostic: "delivery-malformed",
    });
    writeFileSync(path, '{"schema_version":99,"policy":null}\n', {
      mode: 0o600,
    });
    expect(readFableFocusLeaf(path)).toEqual({
      available: false,
      diagnostic: "delivery-unsupported",
    });
    chmodSync(path, 0o644);
    expect(readFableFocusLeaf(path)).toEqual({
      available: false,
      diagnostic: "delivery-insecure",
    });
    expect(effectiveFableFocus(readFableFocusLeaf(path), null, NOW)).toEqual({
      state: "unavailable",
      policy: null,
      diagnostic: "delivery-insecure",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic publish preserves the prior leaf when rename fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-fable-focus-"));
  const path = join(dir, "policy.json");
  try {
    const first = policy({ kind: "permanent" });
    publishFableFocusLeaf(path, first);
    const before = readFileSync(path, "utf8");
    expect(() =>
      publishFableFocusLeaf(path, null, {
        rename: () => {
          throw new Error("injected rename failure");
        },
      }),
    ).toThrow("injected rename failure");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["policy.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
