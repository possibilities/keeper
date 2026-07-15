/**
 * Adversarial pins for the normalized Capacity-observation contract and the two
 * strict provider parsers (`src/account-observation.ts`): CodexBar health gating
 * + native-window extraction, claude-swap inventory normalization (active-slot
 * dedup, unlaunchable/stale exclusion, model-scoped windows, duplicate slots),
 * PII containment, bounded/oversized/deep-payload rejection, and the atomic
 * sidecar round-trip + freshness gate.
 *
 * Every parser is pure over injected run outcomes + a pinned instant, so no test
 * spawns a subprocess. Expected utilizations are hand-computed from the raw
 * percents (an independent source of truth), never re-derived by the parser.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildObservation,
  isObservationFresh,
  type Observation,
  parseCodexBar,
  parseCodexBarCodex,
  parseCswapList,
  readObservationSidecar,
  writeObservationSidecar,
} from "../src/account-observation";
import {
  MAX_OUTPUT_BYTES,
  NATIVE_ROUTE_ID,
} from "../src/account-routing-config";

// A fixed instant so stamp math is exact.
const NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0);
// The managed-measurement freshness ceiling the tests exercise (10 min in ms).
const FRESH_CEIL_MS = 10 * 60_000;

function codexUsageJson(usage: unknown): string {
  return JSON.stringify({ provider: "claude", version: "2.0.0", usage });
}

// ---------- CodexBar health gate --------------------------------------------

describe("parseCodexBar — health gate", () => {
  test("un-runnable CLI (code null) is absent", () => {
    expect(parseCodexBar({ code: null, stdout: "" }).health).toBe("absent");
  });

  test("provider-missing (exit 2) is absent", () => {
    expect(parseCodexBar({ code: 2, stdout: "" }).health).toBe("absent");
  });

  test("timeout (exit 4) and unexpected (exit 1) are errors", () => {
    expect(parseCodexBar({ code: 4, stdout: "" }).health).toBe("error");
    expect(parseCodexBar({ code: 1, stdout: "" }).health).toBe("error");
    expect(parseCodexBar({ code: 3, stdout: "" }).health).toBe("error");
  });

  test("exit 0 with unparseable JSON is malformed", () => {
    expect(parseCodexBar({ code: 0, stdout: "not json {" }).health).toBe(
      "malformed",
    );
  });

  test("exit 0 with a non-object payload is unsupported", () => {
    expect(parseCodexBar({ code: 0, stdout: "42" }).health).toBe("unsupported");
  });

  test("exit 0 with no usage block is unsupported", () => {
    expect(
      parseCodexBar({ code: 0, stdout: JSON.stringify({ provider: "claude" }) })
        .health,
    ).toBe("unsupported");
  });

  test("exit 0 with a usage block carrying no numeric window is unsupported", () => {
    const stdout = codexUsageJson({ primary: {}, secondary: null });
    expect(parseCodexBar({ code: 0, stdout }).health).toBe("unsupported");
  });

  test("exit 0 with valid session + week windows is ok, utilizations exact", () => {
    const stdout = codexUsageJson({
      primary: { usedPercent: 28, resetsAt: "2026-06-01T17:00:00Z" },
      secondary: { usedPercent: 59, resetsAt: "2026-06-05T17:00:00Z" },
      tertiary: null,
    });
    const result = parseCodexBar({ code: 0, stdout });
    expect(result.health).toBe("ok");
    // 28% and 59% used → 0.28 and 0.59 utilization (hand-computed).
    expect(result.windows).toEqual([
      { key: "session", utilization: 0.28, resetsAt: "2026-06-01T17:00:00Z" },
      { key: "week", utilization: 0.59, resetsAt: "2026-06-05T17:00:00Z" },
    ]);
  });

  test("over-cap output is malformed (never a truncated parse)", () => {
    // A payload past MAX_OUTPUT_BYTES rejects on size before any JSON parse.
    const huge = `"${"a".repeat(MAX_OUTPUT_BYTES + 10)}"`;
    expect(parseCodexBar({ code: 0, stdout: huge }).health).toBe("malformed");
  });

  test("pathologically deep nesting is malformed", () => {
    let deep = "0";
    for (let i = 0; i < 40; i++) {
      deep = `[${deep}]`;
    }
    expect(parseCodexBar({ code: 0, stdout: deep }).health).toBe("malformed");
  });

  test("a naive (offset-less) reset stamp is dropped to null, window kept", () => {
    const stdout = codexUsageJson({
      primary: { usedPercent: 10, resetsAt: "2026-06-01T17:00:00" },
    });
    const result = parseCodexBar({ code: 0, stdout });
    expect(result.windows).toEqual([
      { key: "session", utilization: 0.1, resetsAt: null },
    ]);
  });
});

describe("CodexBar provider shape + Codex capacity", () => {
  test("accepts exactly one provider object in an array", () => {
    const result = parseCodexBar({
      code: 0,
      stdout: JSON.stringify([
        {
          provider: "claude",
          usage: { primary: { usedPercent: 12 } },
        },
      ]),
    });
    expect(result.health).toBe("ok");
  });

  test("rejects empty, multi-element, non-object arrays and provider mismatch", () => {
    for (const payload of [
      [],
      [
        { provider: "claude", usage: {} },
        { provider: "claude", usage: {} },
      ],
      [42],
      [{ provider: "codex", usage: { primary: { usedPercent: 10 } } }],
    ]) {
      expect(
        parseCodexBar({ code: 0, stdout: JSON.stringify(payload) }).health,
      ).toBe("unsupported");
    }
  });

  test("Codex retains only weekly capacity and strictly numeric reset count", () => {
    const result = parseCodexBarCodex({
      code: 0,
      stdout: JSON.stringify([
        {
          provider: "codex",
          email: "secret@example.com",
          usage: {
            primary: { usedPercent: 5 },
            secondary: {
              usedPercent: 44,
              resetsAt: "2026-06-08T12:00:00Z",
            },
            codexResetCredits: { availableCount: 2, raw: "discard" },
          },
        },
      ]),
    });
    expect(result).toEqual({
      health: "ok",
      windows: [
        {
          key: "week",
          utilization: 0.44,
          resetsAt: "2026-06-08T12:00:00Z",
        },
      ],
      resetCreditsAvailableCount: 2,
      notes: [],
    });

    for (const invalidCount of ["2", -1, 1.5]) {
      const invalid = parseCodexBarCodex({
        code: 0,
        stdout: JSON.stringify({
          provider: "codex",
          usage: {
            secondary: { usedPercent: 1 },
            codexResetCredits: { availableCount: invalidCount },
          },
        }),
      });
      expect(invalid.resetCreditsAvailableCount).toBeNull();
    }

    for (const invalidPercent of [-1, 101, Number.POSITIVE_INFINITY]) {
      const invalid = parseCodexBarCodex({
        code: 0,
        stdout: JSON.stringify({
          provider: "codex",
          usage: { secondary: { usedPercent: invalidPercent } },
        }),
      });
      expect(invalid.health).toBe("unsupported");
      expect(invalid.windows).toEqual([]);
    }
  });
});

// ---------- claude-swap inventory -------------------------------------------

function cswapRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    number: 2,
    usageStatus: "ok",
    usage: {
      fiveHour: { pct: 25, resetsAt: "2026-06-01T17:00:00Z" },
      sevenDay: { pct: 16, resetsAt: "2026-06-05T17:00:00Z" },
    },
    usageAgeSeconds: 30,
    ...over,
  };
}

function cswapJson(
  accounts: unknown[],
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({ schemaVersion: 1, accounts, ...extra });
}

describe("parseCswapList — inventory normalization", () => {
  test("un-runnable / errored / unsupported inventory yields no routes, no throw", () => {
    expect(
      parseCswapList({ code: null, stdout: "" }, NOW_MS, FRESH_CEIL_MS).routes,
    ).toEqual([]);
    expect(
      parseCswapList(
        {
          code: 1,
          stdout: JSON.stringify({
            schemaVersion: 1,
            error: { type: "X", message: "y" },
          }),
        },
        NOW_MS,
        FRESH_CEIL_MS,
      ).routes,
    ).toEqual([]);
    // A newer schema major is unsupported — never optimistically parsed.
    expect(
      parseCswapList(
        { code: 0, stdout: JSON.stringify({ schemaVersion: 2, accounts: [] }) },
        NOW_MS,
        FRESH_CEIL_MS,
      ).routes,
    ).toEqual([]);
    expect(
      parseCswapList({ code: 0, stdout: "garbage" }, NOW_MS, FRESH_CEIL_MS)
        .routes,
    ).toEqual([]);
  });

  test("a fresh ok row becomes a managed route with normalized windows", () => {
    const out = parseCswapList(
      { code: 0, stdout: cswapJson([cswapRow({ number: 3 })]) },
      NOW_MS,
      FRESH_CEIL_MS,
    );
    expect(out.routes).toEqual([
      {
        id: "claude-swap:3",
        kind: "managed",
        slot: 3,
        // 25% / 16% used → 0.25 / 0.16 (hand-computed).
        windows: [
          {
            key: "session",
            utilization: 0.25,
            resetsAt: "2026-06-01T17:00:00Z",
          },
          { key: "week", utilization: 0.16, resetsAt: "2026-06-05T17:00:00Z" },
        ],
        measuredAtMs: NOW_MS - 30_000,
      },
    ]);
  });

  test("the active slot is deduped against the native route (excluded)", () => {
    const out = parseCswapList(
      {
        code: 0,
        stdout: cswapJson([cswapRow({ number: 2 }), cswapRow({ number: 5 })], {
          activeAccountNumber: 2,
        }),
      },
      NOW_MS,
      FRESH_CEIL_MS,
    );
    expect(out.activeSlot).toBe(2);
    expect(out.routes.map((r) => r.slot)).toEqual([5]);
  });

  test("unlaunchable statuses are excluded, not coerced to zero usage", () => {
    for (const status of [
      "api_key",
      "token_expired",
      "keychain_unavailable",
      "relogin_required",
      "no_credentials",
      "unavailable",
    ]) {
      const out = parseCswapList(
        {
          code: 0,
          stdout: cswapJson([cswapRow({ number: 4, usageStatus: status })]),
        },
        NOW_MS,
        FRESH_CEIL_MS,
      );
      expect(out.routes).toEqual([]);
    }
  });

  test("a measurement older than the freshness ceiling is excluded as stale", () => {
    const out = parseCswapList(
      {
        code: 0,
        stdout: cswapJson([cswapRow({ number: 6, usageAgeSeconds: 3600 })]),
      },
      NOW_MS,
      FRESH_CEIL_MS,
    );
    expect(out.routes).toEqual([]);
  });

  test("duplicate slot numbers collapse to one route", () => {
    const out = parseCswapList(
      {
        code: 0,
        stdout: cswapJson([cswapRow({ number: 7 }), cswapRow({ number: 7 })]),
      },
      NOW_MS,
      FRESH_CEIL_MS,
    );
    expect(out.routes.map((r) => r.slot)).toEqual([7]);
  });

  test("model-scoped + spend windows normalize with stable keys", () => {
    const row = cswapRow({
      number: 8,
      usage: {
        fiveHour: { pct: 40 },
        spend: { pct: 12 },
        scoped: [
          { name: "Fable", pct: 90, resetsAt: "2026-06-08T17:00:00Z" },
          { name: "Opus", pct: 5 },
        ],
      },
    });
    const out = parseCswapList(
      { code: 0, stdout: cswapJson([row]) },
      NOW_MS,
      FRESH_CEIL_MS,
    );
    expect(out.routes[0].windows).toEqual([
      { key: "session", utilization: 0.4, resetsAt: null },
      { key: "spend", utilization: 0.12, resetsAt: null },
      {
        key: "model:Fable",
        utilization: 0.9,
        resetsAt: "2026-06-08T17:00:00Z",
      },
      { key: "model:Opus", utilization: 0.05, resetsAt: null },
    ]);
  });

  test("a row whose windows all fail to parse is excluded (unknown, not zero)", () => {
    const row = cswapRow({
      number: 9,
      usage: { fiveHour: { pct: "lots" }, sevenDay: { pct: null } },
    });
    const out = parseCswapList(
      { code: 0, stdout: cswapJson([row]) },
      NOW_MS,
      FRESH_CEIL_MS,
    );
    expect(out.routes).toEqual([]);
  });

  test("percent is clamped into [0,1]", () => {
    const row = cswapRow({
      number: 10,
      usage: { fiveHour: { pct: 150 }, sevenDay: { pct: -5 } },
    });
    const out = parseCswapList(
      { code: 0, stdout: cswapJson([row]) },
      NOW_MS,
      FRESH_CEIL_MS,
    );
    expect(out.routes[0].windows).toEqual([
      { key: "session", utilization: 1, resetsAt: null },
      { key: "week", utilization: 0, resetsAt: null },
    ]);
  });
});

// ---------- observation assembly + PII containment --------------------------

describe("buildObservation", () => {
  test("the native route always exists; health mirrors CodexBar", () => {
    const obs = buildObservation({
      observedAtMs: NOW_MS,
      codex: { health: "absent", windows: [], notes: [] },
      cswap: { routes: [], activeSlot: null, notes: [] },
    });
    expect(obs.health).toBe("absent");
    expect(obs.routes).toHaveLength(1);
    expect(obs.routes[0]).toMatchObject({
      id: NATIVE_ROUTE_ID,
      kind: "native",
      slot: null,
    });
    // Unhealthy CodexBar contributes no native windows.
    expect(obs.routes[0].windows).toEqual([]);
  });

  test("healthy assembly carries native + managed routes", () => {
    const obs = buildObservation({
      observedAtMs: NOW_MS,
      codex: {
        health: "ok",
        windows: [{ key: "session", utilization: 0.2, resetsAt: null }],
        notes: [],
      },
      cswap: {
        routes: [
          {
            id: "claude-swap:3",
            kind: "managed",
            slot: 3,
            windows: [{ key: "session", utilization: 0.1, resetsAt: null }],
            measuredAtMs: NOW_MS,
          },
        ],
        activeSlot: null,
        notes: [],
      },
    });
    expect(obs.routes.map((r) => r.id)).toEqual([
      NATIVE_ROUTE_ID,
      "claude-swap:3",
    ]);
    expect(obs.routes[0].windows).toHaveLength(1);
  });

  test("the serialized observation carries no PII from either provider", () => {
    // Feed raw payloads laden with email / org / identity, then assert none of it
    // survives into the normalized, serialized observation.
    const codex = parseCodexBar({
      code: 0,
      stdout: JSON.stringify({
        provider: "claude",
        usage: {
          primary: { usedPercent: 10 },
          secondary: { usedPercent: 20 },
          identity: {
            accountEmail: "secret@example.com",
            accountOrganization: "AcmeOrg",
          },
          accountEmail: "secret@example.com",
        },
      }),
    });
    const codexCapacity = parseCodexBarCodex({
      code: 0,
      stdout: JSON.stringify([
        {
          provider: "codex",
          email: "codex-secret@example.com",
          identity: { organization: "CodexOrg" },
          usage: {
            secondary: { usedPercent: 25 },
            codexResetCredits: { availableCount: 3 },
          },
        },
      ]),
    });
    const cswap = parseCswapList(
      {
        code: 0,
        stdout: cswapJson([
          cswapRow({
            number: 4,
            email: "person@example.com",
            organizationName: "AcmeOrg",
            organizationUuid: "org-uuid-123",
          }),
        ]),
      },
      NOW_MS,
      FRESH_CEIL_MS,
    );
    const obs = buildObservation({
      observedAtMs: NOW_MS,
      codex,
      codexCapacity,
      cswap,
    });
    expect(obs.schema_version).toBe(2);
    expect(obs.codex.resetCreditsAvailableCount).toBe(3);
    const serialized = JSON.stringify(obs);
    expect(serialized).not.toContain("@");
    expect(serialized.toLowerCase()).not.toContain("email");
    expect(serialized.toLowerCase()).not.toContain("organization");
    expect(serialized).not.toContain("AcmeOrg");
    expect(serialized).not.toContain("org-uuid-123");
  });

  test("notes are bounded in count and length", () => {
    const codex = {
      health: "error" as const,
      windows: [],
      notes: Array.from({ length: 50 }, (_, i) => `n${i}`),
    };
    const cswap = { routes: [], activeSlot: null, notes: ["x".repeat(1000)] };
    const obs = buildObservation({ observedAtMs: NOW_MS, codex, cswap });
    expect(obs.notes.length).toBeLessThanOrEqual(16);
    for (const n of obs.notes) {
      expect(n.length).toBeLessThanOrEqual(200);
    }
  });
});

// ---------- sidecar I/O + freshness -----------------------------------------

describe("observation sidecar", () => {
  test("write → read round-trips a valid observation", () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-obs-"));
    try {
      const path = join(dir, "observation.json");
      const obs: Observation = {
        schema_version: 2,
        observed_at_ms: NOW_MS,
        health: "ok",
        codex: {
          health: "ok",
          windows: [{ key: "week", utilization: 0.4, resetsAt: null }],
          resetCreditsAvailableCount: 1,
          notes: [],
        },
        routes: [
          {
            id: NATIVE_ROUTE_ID,
            kind: "native",
            slot: null,
            windows: [{ key: "session", utilization: 0.3, resetsAt: null }],
            measuredAtMs: NOW_MS,
          },
        ],
        notes: ["ok"],
      };
      writeObservationSidecar(path, obs);
      const back = readObservationSidecar(path);
      expect(back).toEqual(obs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing / corrupt / wrong-version sidecar reads as null", () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-obs-"));
    try {
      const path = join(dir, "observation.json");
      expect(readObservationSidecar(path)).toBeNull();
      writeFileSync(path, "not json");
      expect(readObservationSidecar(path)).toBeNull();
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: 1,
          observed_at_ms: NOW_MS,
          health: "ok",
          routes: [],
          notes: [],
        }),
      );
      expect(readObservationSidecar(path)).toBeNull();
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: 99,
          observed_at_ms: NOW_MS,
          health: "ok",
          routes: [],
          notes: [],
        }),
      );
      expect(readObservationSidecar(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects out-of-range normalized Codex utilization", () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-obs-"));
    try {
      const path = join(dir, "observation.json");
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: 2,
          observed_at_ms: NOW_MS,
          health: "ok",
          codex: {
            health: "ok",
            windows: [{ key: "week", utilization: 1.01, resetsAt: null }],
            resetCreditsAvailableCount: 1,
            notes: [],
          },
          routes: [],
          notes: [],
        }),
      );
      expect(readObservationSidecar(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the sidecar is written user-private (mode 0600)", () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-obs-"));
    try {
      const path = join(dir, "observation.json");
      writeObservationSidecar(path, {
        schema_version: 2,
        observed_at_ms: NOW_MS,
        health: "ok",
        codex: {
          health: "absent",
          windows: [],
          resetCreditsAvailableCount: null,
          notes: [],
        },
        routes: [],
        notes: [],
      });
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("freshness gate: within the ceiling is fresh, past it is stale", () => {
    const obs: Observation = {
      schema_version: 2,
      observed_at_ms: NOW_MS,
      health: "ok",
      codex: {
        health: "absent",
        windows: [],
        resetCreditsAvailableCount: null,
        notes: [],
      },
      routes: [],
      notes: [],
    };
    expect(isObservationFresh(obs, NOW_MS + 60_000)).toBe(true);
    expect(isObservationFresh(obs, NOW_MS + 6 * 60_000)).toBe(false);
    expect(isObservationFresh(obs, NOW_MS - 1)).toBe(false);
    expect(isObservationFresh(obs, NOW_MS + 1_000, 2_000)).toBe(true);
    expect(isObservationFresh(obs, NOW_MS + 3_000, 2_000)).toBe(false);
  });
});
