import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvelopeSink } from "../cli/envelope";
import {
  runUsageJson,
  USAGE_JSON_SCHEMA_VERSION,
  main as usageMain,
} from "../cli/usage";
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
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
} from "../src/codex-quota-scope";
import {
  buildUsageJsonData,
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
            key: "session",
            utilization: 0.21,
            resetsAt: new Date(NOW + 4 * 60 * 60_000).toISOString(),
          },
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
    account_capacity: {
      "claude-swap:1": {
        subscriptionType: "pro",
        rateLimitMultiplier: 1,
      },
      "claude-swap:2": {
        subscriptionType: "max",
        rateLimitMultiplier: 20,
      },
    },
    account_measurements: {
      "claude-swap:1": {
        measuredAtMs: NOW - 85 * 60_000,
        windows: [
          {
            key: "session",
            utilization: 0.25,
            resetsAt: new Date(NOW + 2 * 60 * 60_000).toISOString(),
          },
          {
            key: "week",
            utilization: 0.5,
            resetsAt: new Date(NOW + 24 * 60 * 60_000).toISOString(),
          },
        ],
      },
    },
    account_issues: { "claude-swap:1": "usage-unavailable" },
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
        account_category: "pro",
        observed_at_ms: NOW,
        expires_at_ms: NOW + 60_000,
        windows: [
          {
            role: "primary",
            quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
            key: "week",
            label: "weekly",
            window_seconds: 604_800,
            used_percent: 38,
            exhausted: false,
            reset_at_ms: NOW + 3 * 24 * 60 * 60_000,
          },
          {
            role: "additional",
            quota_scope: CODEX_SPARK_QUOTA_SCOPE,
            key: "meter:95e633c373a9cdcf6cdc5e63:primary",
            label: "GPT-5.3-Codex-Spark",
            window_seconds: 604_800,
            used_percent: 5,
            exhausted: false,
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
    expect(text).toContain("Claude 1 · Pro 1×  [unavailable] · measured 1h");
    expect(text).toContain("Claude 2 · Max 20×  measured 0s");
    expect(text).toContain("25%");
    expect(text).toContain("weekly");
    expect(text).toContain("Fable");
    expect(text).toContain("[codex] fresh 0s");
    expect(text).toContain("Codex 1 · Pro");
    expect(text).not.toContain("Codex 1  measured");
    expect(text).toContain("GPT-5.3-Codex-Spark");
    expect(text).toContain("38%");
    expect(text).toContain("5%");
  });

  test("omits unavailable account metadata without placeholders", () => {
    const target = paths();
    const claude = claudeObservation();
    delete claude.account_capacity;
    const codex = codexObservation();
    if (codex.aliases[0]) delete codex.aliases[0].account_category;
    writeObservationSidecar(target.claude, claude);
    writeCodexObservationSidecar(target.codex, codex);

    const text = renderUsageLines(loadUsageSnapshot(target, NOW)).join("\n");
    expect(text).toContain("Claude 2  measured 0s");
    expect(text).not.toContain("Claude 2 ·");
    expect(text).not.toContain("Codex 1 ·");
    expect(text).not.toContain("?×");
  });

  test("renders admitted Claude meters with old and clock-skewed Measurement provenance", () => {
    const target = paths();
    const claude = claudeObservation();
    const route = claude.routes[0];
    if (route === undefined) throw new Error("invalid Claude fixture");
    route.measuredAtMs = NOW - 3 * 60 * 60_000;
    writeObservationSidecar(target.claude, claude);
    writeCodexObservationSidecar(target.codex, codexObservation());

    let snapshot = loadUsageSnapshot(target, NOW);
    expect(snapshot.claude.status).toBe("ok");
    expect(snapshot.claude.accounts[1]).toMatchObject({
      status: "ok",
      measuredAtMs: NOW - 3 * 60 * 60_000,
    });
    let text = renderUsageLines(snapshot).join("\n");
    expect(text).toContain("Claude 2 · Max 20×  measured 3h");
    expect(text).not.toContain("Claude 2  [stale]");
    expect(text).toContain("weekly");
    expect(text).toContain("Fable");

    route.measuredAtMs = NOW + 60_000;
    writeObservationSidecar(target.claude, claude);
    snapshot = loadUsageSnapshot(target, NOW);
    expect(snapshot.claude.accounts[1]?.status).toBe("ok");
    text = renderUsageLines(snapshot).join("\n");
    expect(text).toContain("Claude 2 · Max 20×  measured clock skew");
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
    expect(snapshot.claude.accounts[1]?.status).toBe("stale");
    expect(snapshot.codex.status).toBe("stale");
    const text = renderUsageLines(snapshot).join("\n");
    expect(text).toContain("[claude] [stale] · 6m");
    expect(text).toContain("Claude 2 · Max 20×  [stale] · measured 6m");
    expect(text).toContain("Fable");
  });

  test("age and countdown timestamps repaint without forging semantic changes", () => {
    const target = paths();
    writeHealthySidecars(target);
    const first = loadUsageSnapshot(target, NOW);
    const heartbeat = {
      ...first,
      loadedAtMs: NOW + 1_000,
      claude: { ...first.claude, observedAtMs: NOW + 1_000 },
      codex: { ...first.codex, observedAtMs: NOW + 1_000 },
    };
    const repaintOnly = structuredClone(heartbeat);
    const repaintAccount = repaintOnly.claude.accounts[1];
    const repaintMeter = repaintAccount?.meters[0];
    if (!repaintAccount || !repaintMeter) {
      throw new Error("invalid repaint snapshot");
    }
    repaintAccount.measuredAtMs = NOW - 3 * 60 * 60_000;
    repaintMeter.resetAtMs = NOW + 4 * 24 * 60 * 60_000;
    expect(usageSemanticFingerprint(repaintOnly)).toBe(
      usageSemanticFingerprint(first),
    );
    const changed = structuredClone(repaintOnly);
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

describe("usage --json schema-v1 data", () => {
  test("preserves every normalized meter, category/multiplier, and the display-only last-good measurement", () => {
    const target = paths();
    writeHealthySidecars(target);
    const data = buildUsageJsonData(loadUsageSnapshot(target, NOW));

    // Hand-computed against the claudeObservation()/codexObservation() fixture
    // literals above — never re-derived through buildUsageJsonData itself.
    expect(data).toEqual({
      generated_at_ms: NOW,
      sources: {
        claude: {
          provider: "claude",
          status: "ok",
          detail: null,
          observed_at_ms: NOW,
          accounts: [
            {
              id: "Claude 1",
              source_id: "claude-swap:1",
              status: "unavailable",
              detail: null,
              account_category: "pro",
              capacity_multiplier: 1,
              measured_at_ms: NOW - 85 * 60_000,
              meters: [
                {
                  key: "session",
                  label: "session",
                  used_percent: 25,
                  reset_at_ms: NOW + 2 * 60 * 60_000,
                },
                {
                  key: "week",
                  label: "weekly",
                  used_percent: 50,
                  reset_at_ms: NOW + 24 * 60 * 60_000,
                },
              ],
            },
            {
              id: "Claude 2",
              source_id: "claude-swap:2",
              status: "ok",
              detail: null,
              account_category: "max",
              capacity_multiplier: 20,
              measured_at_ms: NOW,
              meters: [
                {
                  key: "session",
                  label: "session",
                  used_percent: 21,
                  reset_at_ms: NOW + 4 * 60 * 60_000,
                },
                {
                  key: "week",
                  label: "weekly",
                  used_percent: 44,
                  reset_at_ms: NOW + 2 * 24 * 60 * 60_000,
                },
                {
                  key: "model:Fable",
                  label: "Fable",
                  used_percent: 65,
                  reset_at_ms: NOW + 2 * 24 * 60 * 60_000,
                },
              ],
            },
          ],
        },
        codex: {
          provider: "codex",
          status: "ok",
          detail: null,
          observed_at_ms: NOW,
          accounts: [
            {
              id: "Codex 1",
              source_id: "keeper-codex-a",
              status: "ok",
              detail: null,
              account_category: "pro",
              capacity_multiplier: null,
              measured_at_ms: null,
              meters: [
                {
                  key: "week",
                  label: "weekly",
                  used_percent: 38,
                  reset_at_ms: NOW + 3 * 24 * 60 * 60_000,
                },
                {
                  key: "meter:95e633c373a9cdcf6cdc5e63:primary",
                  label: "GPT-5.3-Codex-Spark",
                  used_percent: 5,
                  reset_at_ms: NOW + 3 * 24 * 60 * 60_000,
                },
              ],
            },
          ],
        },
      },
    });
  });

  test("missing sources are explicit partial data, never zero or a failure", () => {
    const target = paths();
    const data = buildUsageJsonData(loadUsageSnapshot(target, NOW));
    expect(data.sources.claude).toEqual({
      provider: "claude",
      status: "missing",
      detail: null,
      observed_at_ms: null,
      accounts: [],
    });
    expect(data.sources.codex).toEqual({
      provider: "codex",
      status: "missing",
      detail: null,
      observed_at_ms: null,
      accounts: [],
    });
  });
});

describe("cli/usage runUsageJson", () => {
  function captureSink(): {
    sink: EnvelopeSink;
    json: () => Record<string, unknown>;
    code: () => number | null;
  } {
    let text = "";
    let code: number | null = null;
    return {
      sink: {
        writeStdout(value) {
          text += value;
        },
        exit(value): never {
          code = value;
          return undefined as never;
        },
      },
      json: () => JSON.parse(text) as Record<string, unknown>,
      code: () => code,
    };
  }

  test("emits the schema-v1 envelope from the current sidecar snapshot", () => {
    const target = paths();
    writeHealthySidecars(target);
    const captured = captureSink();
    runUsageJson({ paths: target, nowMs: () => NOW, sink: captured.sink });
    expect(captured.code()).toBe(0);
    const body = captured.json();
    expect(body.schema_version).toBe(USAGE_JSON_SCHEMA_VERSION);
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(
      (body.data as { sources: { claude: { status: string } } }).sources.claude
        .status,
    ).toBe("ok");
    expect((body.data as { generated_at_ms: number }).generated_at_ms).toBe(
      NOW,
    );
  });
});

describe("cli/usage main() --json arg handling", () => {
  class ExitError extends Error {
    readonly code: number;
    constructor(code: number) {
      super(`exit ${code}`);
      this.code = code;
    }
  }

  async function runMain(
    argv: string[],
  ): Promise<{ err: string; code: number | null }> {
    const err: string[] = [];
    let code: number | null = null;
    const orig = { stderr: process.stderr.write, exit: process.exit };
    process.stderr.write = ((s: string | Uint8Array) => {
      err.push(typeof s === "string" ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((c?: number) => {
      code = c ?? 0;
      throw new ExitError(c ?? 0);
    }) as typeof process.exit;
    try {
      await usageMain(argv);
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      process.stderr.write = orig.stderr;
      process.exit = orig.exit;
    }
    return { err: err.join(""), code };
  }

  test("--json and --watch are mutually exclusive (exit 2, never loads a snapshot)", async () => {
    const r = await runMain(["--json", "--watch"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--json and --watch are mutually exclusive");
  });
});
