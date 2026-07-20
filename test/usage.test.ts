import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Observation,
  writeObservationSidecar,
} from "../src/account-observation";
import {
  CODEX_OBSERVATION_SCHEMA_VERSION,
  OBSERVATION_SCHEMA_VERSION,
} from "../src/account-routing-config";
import {
  CODEX_PROVIDER,
  type CodexCapacityObservation,
  writeCodexObservationSidecar,
} from "../src/codex-account-observation";
import {
  createUsagePoller,
  loadUsageSnapshot,
  renderUsageLines,
  type UsageSnapshot,
  usageSemanticFingerprint,
} from "../src/usage-observation-view";

const NOW = Date.parse("2026-07-19T18:00:00Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function paths() {
  const root = mkdtempSync(join(tmpdir(), "keeper-usage-"));
  roots.push(root);
  return {
    claude: join(root, "claude.json"),
    codex: join(root, "codex.json"),
  };
}

function claudeObservation(): Observation {
  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    observed_at_ms: NOW,
    health: "ok",
    routes: [
      {
        id: "claude-swap:2",
        kind: "managed",
        slot: 2,
        measuredAtMs: NOW,
        windows: [
          {
            key: "week",
            utilization: 0.44,
            resetsAt: new Date(NOW + 2 * 24 * 60 * 60_000).toISOString(),
          },
          {
            key: "model:Fable",
            utilization: 0.65,
            resetsAt: new Date(NOW + 2 * 24 * 60 * 60_000).toISOString(),
          },
        ],
      },
    ],
    claude_accounts: {
      count: 2,
      ordinals: { "claude-swap:1": 0, "claude-swap:2": 1 },
    },
    account_issues: { "claude-swap:1": "relogin-required" },
    notes: [],
  };
}

function codexObservation(): CodexCapacityObservation {
  return {
    schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
    provider: CODEX_PROVIDER,
    config_binding: "a".repeat(64),
    observed_at_ms: NOW,
    aliases: [
      {
        alias: "keeper-codex-a",
        status: "healthy",
        observed_at_ms: NOW,
        expires_at_ms: NOW + 60_000,
        windows: [
          {
            role: "primary",
            key: "week",
            label: "weekly",
            window_seconds: 604_800,
            used_percent: 38,
            reset_at_ms: NOW + 3 * 24 * 60 * 60_000,
          },
          {
            role: "additional",
            key: "meter:95e633c373a9cdcf6cdc5e63:primary",
            label: "GPT-5.3-Codex-Spark",
            window_seconds: 604_800,
            used_percent: 5,
            reset_at_ms: NOW + 3 * 24 * 60 * 60_000,
          },
        ],
      },
    ],
  };
}

function writeHealthySidecars(target: { claude: string; codex: string }): void {
  writeObservationSidecar(target.claude, claudeObservation());
  writeCodexObservationSidecar(target.codex, codexObservation());
}

describe("usage observation view", () => {
  test("renders every current meter and every known account", () => {
    const target = paths();
    writeHealthySidecars(target);
    const snapshot = loadUsageSnapshot(target, NOW);
    const text = renderUsageLines(snapshot).join("\n");

    expect(text).toContain("[claude] fresh 0s");
    expect(text).toContain("Claude 1  [issue] · relogin-required");
    expect(text).toContain("weekly");
    expect(text).toContain("Fable");
    expect(text).toContain("[codex] fresh 0s");
    expect(text).toContain("Codex 1");
    expect(text).toContain("GPT-5.3-Codex-Spark");
    expect(text).toContain("38%");
    expect(text).toContain("5%");
  });

  test("disambiguates two windows carried by one named Codex meter", () => {
    const target = paths();
    writeObservationSidecar(target.claude, claudeObservation());
    const codex = codexObservation();
    const alias = codex.aliases[0];
    const weekly = alias?.windows[0];
    const spark = alias?.windows[1];
    if (!alias || !weekly || !spark) throw new Error("invalid Codex fixture");
    alias.windows = [
      weekly,
      { ...spark, key: `${spark.key}:session`, window_seconds: 18_000 },
      { ...spark, key: `${spark.key}:week`, window_seconds: 604_800 },
    ];
    writeCodexObservationSidecar(target.codex, codex);
    const text = renderUsageLines(loadUsageSnapshot(target, NOW)).join("\n");
    expect(text).toContain("GPT-5.3-Codex-Spark · 5h");
    expect(text).toContain("GPT-5.3-Codex-Spark · 7d");
  });

  test("removed meters disappear because arrays are full snapshots", () => {
    const target = paths();
    writeHealthySidecars(target);
    const withFable = loadUsageSnapshot(target, NOW);
    const next = claudeObservation();
    const route = next.routes[0];
    if (!route) throw new Error("invalid Claude fixture");
    next.routes[0] = {
      ...route,
      windows: route.windows.filter((window) => window.key !== "model:Fable"),
    };
    writeObservationSidecar(target.claude, next);
    const withoutFable = loadUsageSnapshot(target, NOW);

    expect(renderUsageLines(withFable).join("\n")).toContain("Fable");
    expect(renderUsageLines(withoutFable).join("\n")).not.toContain("Fable");
  });

  test("distinguishes missing, invalid, and stale sources", () => {
    const target = paths();
    let snapshot = loadUsageSnapshot(target, NOW);
    expect(snapshot.claude.status).toBe("missing");
    expect(snapshot.codex.status).toBe("missing");

    writeFileSync(target.claude, "{", "utf8");
    snapshot = loadUsageSnapshot(target, NOW);
    expect(snapshot.claude.status).toBe("invalid");

    writeHealthySidecars(target);
    snapshot = loadUsageSnapshot(target, NOW + 6 * 60_000);
    expect(snapshot.claude.status).toBe("stale");
    expect(snapshot.codex.status).toBe("stale");
  });

  test("heartbeat timestamps repaint locally without forging data changes", () => {
    const target = paths();
    writeHealthySidecars(target);
    const first = loadUsageSnapshot(target, NOW);
    const heartbeat = {
      ...first,
      loadedAtMs: NOW + 1_000,
      claude: { ...first.claude, observedAtMs: NOW + 1_000 },
      codex: { ...first.codex, observedAtMs: NOW + 1_000 },
    };
    expect(usageSemanticFingerprint(heartbeat)).toBe(
      usageSemanticFingerprint(first),
    );
    const changed = structuredClone(heartbeat);
    const changedMeter = changed.codex.accounts[0]?.meters[0];
    if (!changedMeter) throw new Error("invalid changed snapshot");
    changedMeter.usedPercent = 39;
    expect(usageSemanticFingerprint(changed)).not.toBe(
      usageSemanticFingerprint(first),
    );
  });

  test("poller emits semantic changes, repaints heartbeats, and disposes", () => {
    const target = paths();
    writeHealthySidecars(target);
    let current: UsageSnapshot = loadUsageSnapshot(target, NOW);
    const semantic: UsageSnapshot[] = [];
    const repaints: UsageSnapshot[] = [];
    const timers = new Map<number, () => void>();
    const cleared: number[] = [];
    let nextTimer = 1;
    const poller = createUsagePoller({
      read: () => current,
      onSemanticChange: (snapshot) => semantic.push(snapshot),
      onLocalRepaint: (snapshot) => repaints.push(snapshot),
      setTimeoutFn: (callback) => {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearTimeoutFn: (id) => {
        cleared.push(id as number);
        timers.delete(id as number);
      },
    });

    poller.start();
    expect(semantic).toHaveLength(1);
    current = { ...current, loadedAtMs: NOW + 1_000 };
    const firstTimer = timers.get(1);
    if (!firstTimer) throw new Error("poll timer missing");
    timers.delete(1);
    firstTimer();
    expect(repaints).toHaveLength(1);

    current = structuredClone(current);
    const currentMeter = current.codex.accounts[0]?.meters[0];
    if (!currentMeter) throw new Error("invalid current snapshot");
    currentMeter.usedPercent = 40;
    const secondTimer = timers.get(2);
    if (!secondTimer) throw new Error("second poll timer missing");
    timers.delete(2);
    secondTimer();
    expect(semantic).toHaveLength(2);

    poller.dispose();
    expect(cleared).toEqual([3]);
    expect(timers.size).toBe(0);
  });
});
