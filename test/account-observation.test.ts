import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildObservation,
  isObservationFresh,
  parseCswapList,
  readObservationSidecar,
  validateObservation,
  writeObservationSidecar,
} from "../src/account-observation";
import {
  MAX_CSWAP_ACCOUNTS,
  OBSERVATION_SCHEMA_VERSION,
} from "../src/account-routing-config";

const NOW = Date.parse("2026-07-18T00:00:00Z");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function outcome(value: unknown, code = 0) {
  return { code, stdout: JSON.stringify(value) };
}

function account(
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    email: `private-${number}@example.test`,
    organizationUuid: `secret-${number}`,
    usageStatus: "ok",
    usageFetchedAt: "2026-07-17T23:59:30Z",
    usage: {
      fiveHour: { pct: 20, resetsAt: "2026-07-18T02:00:00Z" },
      sevenDay: { pct: 40, resetsAt: "2026-07-20T00:00:00Z" },
      scoped: [{ name: "Fable", pct: 50, resetsAt: "2026-07-21T00:00:00Z" }],
    },
    ...overrides,
  };
}

function inventory(accounts: unknown[], activeAccountNumber = 1) {
  return { schemaVersion: 1, activeAccountNumber, accounts };
}

describe("parseCswapList", () => {
  test("classifies unavailable, malformed, provider error, and unsupported schema", () => {
    expect(parseCswapList({ code: null, stdout: "" }, NOW).health).toBe(
      "absent",
    );
    expect(parseCswapList({ code: 0, stdout: "{" }, NOW).health).toBe(
      "malformed",
    );
    expect(
      parseCswapList(outcome({ schemaVersion: 1, error: {} }, 1), NOW).health,
    ).toBe("error");
    const unsupported = parseCswapList(
      outcome({ schemaVersion: "private-account@example.test", accounts: [] }),
      NOW,
    );
    expect(unsupported.health).toBe("unsupported");
    expect(unsupported.notes).toEqual(["cswap: unsupported schema"]);
    expect(JSON.stringify(unsupported)).not.toContain(
      "private-account@example.test",
    );
    const tooMany = Array.from({ length: MAX_CSWAP_ACCOUNTS + 1 }, (_, index) =>
      account(index + 1),
    );
    const bounded = parseCswapList(outcome(inventory(tooMany)), NOW);
    expect(bounded.health).toBe("unsupported");
    expect(bounded.notes).toEqual([
      `cswap: account count exceeds ${MAX_CSWAP_ACCOUNTS}`,
    ]);
  });

  test("retains the active slot as an ordinary managed route", () => {
    const parsed = parseCswapList(
      outcome(inventory([account(7), account(2)], 7)),
      NOW,
    );
    expect(parsed.health).toBe("ok");
    expect(parsed.routes.map((route) => route.id)).toEqual([
      "claude-swap:7",
      "claude-swap:2",
    ]);
    expect(parsed.routes[0]).toMatchObject({
      kind: "managed",
      slot: 7,
      measuredAtMs: Date.parse("2026-07-17T23:59:30Z"),
    });
    expect(parsed.accountOrdinals).toEqual({
      "claude-swap:7": 0,
      "claude-swap:2": 1,
    });
  });

  test("keeps stable ordinals for known but unrouteable rows", () => {
    const parsed = parseCswapList(
      outcome(
        inventory([
          account(4, {
            usageStatus: "relogin_required",
            usageFetchedAt: undefined,
          }),
          account(9),
        ]),
      ),
      NOW,
    );
    expect(parsed.routes.map((route) => route.id)).toEqual(["claude-swap:9"]);
    expect(parsed.accountOrdinals).toEqual({
      "claude-swap:4": 0,
      "claude-swap:9": 1,
    });
    expect(parsed.accountIssues).toEqual({
      "claude-swap:4": "relogin-required",
    });
    expect(parsed.notes).toContain(
      "cswap: slot 4 not routeable (relogin_required)",
    );
  });

  test("maps unknown provider statuses without retaining provider text", () => {
    const parsed = parseCswapList(
      outcome(
        inventory([
          account(5, { usageStatus: "private-account@example.test" }),
        ]),
      ),
      NOW,
    );
    expect(parsed.accountIssues).toEqual({
      "claude-swap:5": "account-unavailable",
    });
    expect(parsed.notes).toEqual(["cswap: slot 5 not routeable (unavailable)"]);
    expect(JSON.stringify(parsed)).not.toContain(
      "private-account@example.test",
    );
  });

  test("requires provenance and base windows but not a measurement age", () => {
    const oldFetchedAt = "2001-01-01T00:00:00Z";
    const futureFetchedAt = "2099-01-01T00:00:00Z";
    const parsed = parseCswapList(
      outcome(
        inventory([
          account(1, { usageFetchedAt: undefined, usageAgeSeconds: undefined }),
          account(2, { usageFetchedAt: oldFetchedAt }),
          account(3, { usage: { scoped: [] } }),
          account(4, { usageFetchedAt: undefined, usageAgeSeconds: 10 }),
          account(5, { usageFetchedAt: futureFetchedAt }),
          account(6, {
            usageFetchedAt: oldFetchedAt,
            usageAgeSeconds: 1,
          }),
          account(7, {
            usageFetchedAt: "private-account@example.test",
            usageAgeSeconds: undefined,
          }),
          account(8, {
            usage: {
              fiveHour: { pct: "unknown" },
              sevenDay: { pct: 40 },
              scoped: [],
            },
          }),
        ]),
      ),
      NOW,
    );
    expect(parsed.routes.map((route) => route.id)).toEqual([
      "claude-swap:2",
      "claude-swap:4",
      "claude-swap:5",
      "claude-swap:6",
    ]);
    expect(parsed.routes.map((route) => route.measuredAtMs)).toEqual([
      Date.parse(oldFetchedAt),
      NOW - 10_000,
      Date.parse(futureFetchedAt),
      Date.parse(oldFetchedAt),
    ]);
    expect(parsed.accountIssues).toEqual({
      "claude-swap:1": "missing-freshness",
      "claude-swap:3": "missing-windows",
      "claude-swap:7": "missing-freshness",
      "claude-swap:8": "missing-windows",
    });
    expect(parsed.notes).toEqual(
      expect.arrayContaining([
        "cswap: slot 1 has no freshness signal",
        "cswap: slot 3 has no required windows",
        "cswap: slot 7 has no freshness signal",
        "cswap: slot 8 has no required windows",
      ]),
    );
    expect(JSON.stringify(parsed)).not.toContain(
      "private-account@example.test",
    );
  });

  test("distinguishes no scoped entitlement from malformed scoped data", () => {
    const baseUsage = {
      fiveHour: { pct: 20, resetsAt: "2026-07-18T02:00:00Z" },
      sevenDay: { pct: 40, resetsAt: "2026-07-20T00:00:00Z" },
    };
    const parsed = parseCswapList(
      outcome(
        inventory([
          account(1, { usage: { ...baseUsage, scoped: [] } }),
          account(2, {
            usage: {
              ...baseUsage,
              scoped: [{ name: "Fable", pct: "unknown" }],
            },
          }),
          account(3, { usage: baseUsage }),
          account(4, {
            usage: { ...baseUsage, scoped: [{ name: "   ", pct: 10 }] },
          }),
          account(5, {
            usage: {
              ...baseUsage,
              scoped: [
                { name: "Fable", pct: 10 },
                { name: " fable ", pct: 20 },
              ],
            },
          }),
        ]),
      ),
      NOW,
    );
    expect(parsed.routes.map((route) => route.id)).toEqual([
      "claude-swap:1",
      "claude-swap:3",
    ]);
    expect(parsed.routes[0]?.windows.map((window) => window.key)).toEqual([
      "session",
      "week",
    ]);
    expect(parsed.routes[1]?.windows.map((window) => window.key)).toEqual([
      "session",
      "week",
    ]);
    expect(parsed.accountOrdinals).toEqual({
      "claude-swap:1": 0,
      "claude-swap:2": 1,
      "claude-swap:3": 2,
      "claude-swap:4": 3,
      "claude-swap:5": 4,
    });
    expect(parsed.accountIssues).toEqual({
      "claude-swap:2": "malformed-scoped-windows",
      "claude-swap:4": "malformed-scoped-windows",
      "claude-swap:5": "malformed-scoped-windows",
    });
    expect(parsed.notes).toEqual(
      expect.arrayContaining([
        "cswap: slot 2 has malformed scoped windows",
        "cswap: slot 4 has malformed scoped windows",
        "cswap: slot 5 has malformed scoped windows",
      ]),
    );
  });

  test("rejects unsafe scoped names at the PII-free boundary", () => {
    const parsed = parseCswapList(
      outcome(
        inventory([
          account(8, {
            usage: {
              fiveHour: { pct: 20 },
              sevenDay: { pct: 40 },
              scoped: [{ name: "owner@example.test", pct: 50 }],
            },
          }),
        ]),
      ),
      NOW,
    );
    expect(parsed.routes).toEqual([]);
    expect(parsed.accountIssues).toEqual({
      "claude-swap:8": "malformed-scoped-windows",
    });
    expect(JSON.stringify(parsed)).not.toContain("owner@example.test");
  });

  test("drops malformed reset timestamps instead of emitting provider text", () => {
    const privateReset = "private-account@example.test\nZ";
    const parsed = parseCswapList(
      outcome(
        inventory([
          account(8, {
            usage: {
              fiveHour: { pct: 20 },
              sevenDay: { pct: 40 },
              scoped: [{ name: "Fable", pct: 50, resetsAt: privateReset }],
            },
          }),
        ]),
      ),
      NOW,
    );
    expect(
      parsed.routes[0]?.windows.find((window) => window.key === "model:Fable")
        ?.resetsAt,
    ).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain(privateReset);
  });

  test("normalizes account and scoped windows without retaining PII", () => {
    const parsed = parseCswapList(outcome(inventory([account(3)])), NOW);
    expect(parsed.routes[0]?.windows.map((window) => window.key)).toEqual([
      "session",
      "week",
      "model:Fable",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("private-3@example.test");
    expect(JSON.stringify(parsed)).not.toContain("secret-3");
  });
});

describe("schema-v7 observation sidecar", () => {
  test("builds a managed-only observation", () => {
    expect(OBSERVATION_SCHEMA_VERSION).toBe(7);
    const cswap = parseCswapList(outcome(inventory([account(5)])), NOW);
    const observation = buildObservation({ observedAtMs: NOW, cswap });
    expect(observation).toMatchObject({
      schema_version: OBSERVATION_SCHEMA_VERSION,
      health: "ok",
      routes: [{ id: "claude-swap:5", kind: "managed", slot: 5 }],
      claude_accounts: {
        count: 1,
        ordinals: { "claude-swap:5": 0 },
      },
      account_issues: {},
    });
    expect(JSON.stringify(observation)).not.toContain('"default"');
  });

  test("round-trips atomically and rejects old or native-route shapes", () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-account-observation-"));
    roots.push(root);
    const path = join(root, "observation.json");
    const observation = buildObservation({
      observedAtMs: NOW,
      cswap: parseCswapList(outcome(inventory([account(6)])), NOW),
    });
    writeObservationSidecar(path, observation);
    expect(readObservationSidecar(path)).toEqual(observation);
    expect(
      validateObservation({
        ...observation,
        schema_version: 6,
      }),
    ).toBeNull();
    expect(
      validateObservation({
        ...observation,
        routes: [],
        account_issues: {},
      }),
    ).toBeNull();
    expect(
      validateObservation({
        ...observation,
        claude_accounts: {
          count: 1,
          ordinals: { "claude-swap:99": 0 },
        },
      }),
    ).toBeNull();
    expect(
      validateObservation({
        ...observation,
        account_issues: { "claude-swap:6": "account-unavailable" },
      }),
    ).toBeNull();
    expect(
      validateObservation({
        ...observation,
        account_issues: { "claude-swap:99": "account-unavailable" },
      }),
    ).toBeNull();
    expect(
      validateObservation({
        ...observation,
        routes: observation.routes.map((route) => ({
          ...route,
          windows: route.windows.map((window, index) =>
            index === 0
              ? { ...window, resetsAt: "private@example.test\nZ" }
              : window,
          ),
        })),
      }),
    ).toBeNull();
    expect(
      validateObservation({
        ...observation,
        routes: observation.routes.map((route) => ({
          ...route,
          windows: route.windows.filter((window) => window.key !== "week"),
        })),
      }),
    ).toBeNull();
    expect(
      validateObservation({
        ...observation,
        routes: observation.routes.map((route) => ({
          ...route,
          windows: [...route.windows, route.windows[0]],
        })),
      }),
    ).toBeNull();
    expect(
      validateObservation({
        ...observation,
        routes: [
          {
            id: "default",
            kind: "native",
            slot: null,
            measuredAtMs: NOW,
            windows: observation.routes[0]?.windows,
          },
        ],
      }),
    ).toBeNull();
  });

  test("freshness rejects future and old sidecars", () => {
    const observation = buildObservation({
      observedAtMs: NOW,
      cswap: parseCswapList(outcome(inventory([account(1)])), NOW),
    });
    expect(isObservationFresh(observation, NOW, 1)).toBe(true);
    expect(isObservationFresh(observation, NOW - 1, 60_000)).toBe(false);
    expect(isObservationFresh(observation, NOW + 61_000, 60_000)).toBe(false);
  });
});
