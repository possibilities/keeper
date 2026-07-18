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
import { OBSERVATION_SCHEMA_VERSION } from "../src/account-routing-config";

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
    expect(parseCswapList({ code: null, stdout: "" }, NOW, 60_000).health).toBe(
      "absent",
    );
    expect(parseCswapList({ code: 0, stdout: "{" }, NOW, 60_000).health).toBe(
      "malformed",
    );
    expect(
      parseCswapList(outcome({ schemaVersion: 1, error: {} }, 1), NOW, 60_000)
        .health,
    ).toBe("error");
    expect(
      parseCswapList(outcome({ schemaVersion: 2, accounts: [] }), NOW, 60_000)
        .health,
    ).toBe("unsupported");
  });

  test("retains the active slot as an ordinary managed route", () => {
    const parsed = parseCswapList(
      outcome(inventory([account(7), account(2)], 7)),
      NOW,
      60_000,
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
          account(4, { usageStatus: "relogin_required" }),
          account(9),
        ]),
      ),
      NOW,
      60_000,
    );
    expect(parsed.routes.map((route) => route.id)).toEqual(["claude-swap:9"]);
    expect(parsed.accountOrdinals).toEqual({
      "claude-swap:4": 0,
      "claude-swap:9": 1,
    });
    expect(parsed.notes).toContain(
      "cswap: slot 4 not routeable (relogin_required)",
    );
  });

  test("requires freshness and quota windows", () => {
    const parsed = parseCswapList(
      outcome(
        inventory([
          account(1, { usageFetchedAt: undefined, usageAgeSeconds: undefined }),
          account(2, { usageFetchedAt: "2026-07-17T23:00:00Z" }),
          account(3, { usage: { scoped: [] } }),
          account(4, { usageFetchedAt: undefined, usageAgeSeconds: 10 }),
        ]),
      ),
      NOW,
      60_000,
    );
    expect(parsed.routes.map((route) => route.id)).toEqual(["claude-swap:4"]);
    expect(parsed.notes).toEqual(
      expect.arrayContaining([
        "cswap: slot 1 has no freshness signal",
        "cswap: slot 2 measurement stale",
        "cswap: slot 3 has no windows",
      ]),
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
      60_000,
    );
    expect(parsed.routes.map((route) => route.id)).toEqual(["claude-swap:1"]);
    expect(parsed.routes[0]?.windows.map((window) => window.key)).toEqual([
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
    expect(parsed.notes).toEqual(
      expect.arrayContaining([
        "cswap: slot 2 has malformed scoped windows",
        "cswap: slot 3 has malformed scoped windows",
        "cswap: slot 4 has malformed scoped windows",
        "cswap: slot 5 has malformed scoped windows",
      ]),
    );
  });

  test("normalizes account and scoped windows without retaining PII", () => {
    const parsed = parseCswapList(
      outcome(inventory([account(3)])),
      NOW,
      60_000,
    );
    expect(parsed.routes[0]?.windows.map((window) => window.key)).toEqual([
      "session",
      "week",
      "model:Fable",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("private-3@example.test");
    expect(JSON.stringify(parsed)).not.toContain("secret-3");
  });
});

describe("schema-v5 observation sidecar", () => {
  test("builds a managed-only observation", () => {
    const cswap = parseCswapList(outcome(inventory([account(5)])), NOW, 60_000);
    const observation = buildObservation({ observedAtMs: NOW, cswap });
    expect(observation).toMatchObject({
      schema_version: OBSERVATION_SCHEMA_VERSION,
      health: "ok",
      routes: [{ id: "claude-swap:5", kind: "managed", slot: 5 }],
      claude_accounts: {
        count: 1,
        ordinals: { "claude-swap:5": 0 },
      },
    });
    expect(JSON.stringify(observation)).not.toContain('"default"');
  });

  test("round-trips atomically and rejects old or native-route shapes", () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-account-observation-"));
    roots.push(root);
    const path = join(root, "observation.json");
    const observation = buildObservation({
      observedAtMs: NOW,
      cswap: parseCswapList(outcome(inventory([account(6)])), NOW, 60_000),
    });
    writeObservationSidecar(path, observation);
    expect(readObservationSidecar(path)).toEqual(observation);
    expect(
      validateObservation({
        ...observation,
        schema_version: OBSERVATION_SCHEMA_VERSION - 1,
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
      cswap: parseCswapList(outcome(inventory([account(1)])), NOW, 60_000),
    });
    expect(isObservationFresh(observation, NOW, 1)).toBe(true);
    expect(isObservationFresh(observation, NOW - 1, 60_000)).toBe(false);
    expect(isObservationFresh(observation, NOW + 61_000, 60_000)).toBe(false);
  });
});
