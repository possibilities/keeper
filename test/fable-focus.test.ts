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
import type { Observation } from "../src/account-observation";
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

function observation(
  overrides: Partial<Observation> = {},
  utilization = 0.75,
): Observation {
  return {
    schema_version: 6,
    observed_at_ms: NOW,
    health: "ok",
    routes: [
      {
        id: "claude-swap:2",
        kind: "managed",
        slot: 2,
        measuredAtMs: NOW,
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

test("cycle-end completes on matching fresh full utilization or its fixed boundary", () => {
  const cycle = policy({ kind: "cycle-end", reset_at: RESET });
  expect(
    effectiveFableFocus(
      { available: true, policy: cycle },
      observation({}, 0.99),
      NOW,
    ).state,
  ).toBe("active");
  expect(
    effectiveFableFocus(
      { available: true, policy: cycle },
      observation({}, 1),
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

test("current-reset construction refuses stale, elapsed, and mismatched observations", () => {
  expect(
    buildCurrentResetFableFocus("claude-swap:2", observation(), NOW, RESET),
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
      observation(),
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
