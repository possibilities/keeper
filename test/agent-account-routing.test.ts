import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeObservationSidecar } from "../src/account-observation";
import type { RouteResolution, RouteSelection } from "../src/account-router";
import {
  deriveCswapAccountConfigDir,
  existingCswapAccountConfigDir,
  OBSERVATION_SCHEMA_VERSION,
  observationSidecarPath,
} from "../src/account-routing-config";
import { main, seedClaudeWorkspaceTrust } from "../src/agent/main";
import {
  expectExit,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

const CSWAP = "/fake-home/.local/bin/cswap";
const UUID = "11111111-1111-1111-1111-111111111111";

function selection(slot: number, accountOrdinal?: number): RouteSelection {
  return {
    id: `claude-swap:${slot}`,
    kind: "managed",
    slot,
    ...(accountOrdinal === undefined ? {} : { accountOrdinal }),
    reason: "selected",
  };
}

function managed(slot: number, accountOrdinal?: number): () => RouteResolution {
  return () => ({ ok: true, selection: selection(slot, accountOrdinal) });
}

describe("mandatory Claude account routing", () => {
  test("metadata inference selects a fresh non-Fable route through cswap", async () => {
    const routed: Array<[string | null, boolean | null | undefined]> = [];
    const spawned: string[][] = [];
    const h = makeHarness({
      argv: [
        "claude",
        "--x-metadata-inference",
        "User: Improve project search ranking",
      ],
      rawArgv: true,
      selectAccountRoute: (model, fableIntent) => {
        routed.push([model, fableIntent]);
        return { ok: true, selection: selection(6) };
      },
    });
    h.deps.metadataInferenceRuntime = {
      spawn: (argv) => {
        spawned.push(argv);
        return {
          exited: Promise.resolve(0),
          captureStdout: async () => ({
            text: JSON.stringify({
              structured_output: { name: "Project Search Ranking" },
            }),
            overflow: false,
          }),
          captureStderr: async () => ({ text: "", overflow: false }),
          terminateTree: () => {},
        };
      },
      setTimeout: () => 1,
      clearTimeout: () => {},
      createCancellation: () => ({
        signal: new AbortController().signal,
        dispose() {},
      }),
    };

    expect(await expectExit(main(h.deps))).toBe(0);
    expect(routed).toEqual([["haiku", false]]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.slice(0, 5)).toEqual([
      CSWAP,
      "run",
      "6",
      "--share-history",
      "--",
    ]);
    expect(h.spawned).toEqual([]);
  });

  test("every successful launch uses cswap run --share-history", async () => {
    const h = makeHarness({
      argv: ["claude", "hello"],
      rawArgv: true,
      randomUuid: () => UUID,
      selectAccountRoute: managed(2),
    });
    const command = await runAndCapture(h, main);
    expect(command.slice(0, 5)).toEqual([
      CSWAP,
      "run",
      "2",
      "--share-history",
      "--",
    ]);
    expect(command.slice(5)).toContain("hello");
    expect(h.deps.env.KEEPER_ACCOUNT_ROUTE).toBe("claude-swap:2");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBe(
      "/fake-home/.claude-swap/sessions/2-account",
    );
    expect(h.spawnOptions[0]?.env?.CLAUDE_CONFIG_DIR).toBe(
      "/fake-home/.claude-swap/sessions/2-account",
    );
    expect(h.routerCalls()).toBe(1);
  });

  test("model, effort, session id, and prompt survive after the boundary", async () => {
    const h = makeHarness({
      argv: ["claude", "--model", "sonnet", "--effort", "xhigh", "task"],
      rawArgv: true,
      randomUuid: () => UUID,
      selectAccountRoute: managed(7),
    });
    const tail = (await runAndCapture(h, main)).slice(5);
    expect(tail).toContain("--model");
    expect(tail[tail.indexOf("--model") + 1]).toBe("sonnet");
    expect(tail).toContain("--session-id");
    expect(tail[tail.indexOf("--session-id") + 1]).toBe(UUID);
    expect(tail).toContain("task");
  });

  test("passes explicit and launch-triple models into account scoring", async () => {
    const explicitModels: Array<string | null> = [];
    const explicit = makeHarness({
      argv: ["claude", "--model=fable", "--effort", "high", "explicit task"],
      rawArgv: true,
      selectAccountRoute: (model) => {
        explicitModels.push(model);
        return { ok: true, selection: selection(4) };
      },
    });
    await runAndCapture(explicit, main);
    expect(explicitModels).toEqual(["fable"]);

    const presetModels: Array<string | null> = [];
    const preset = makeHarness({
      argv: ["claude", "--x-preset", "claude::fable::medium", "preset task"],
      rawArgv: true,
      selectAccountRoute: (model) => {
        presetModels.push(model);
        return { ok: true, selection: selection(5) };
      },
    });
    const command = await runAndCapture(preset, main);
    expect(presetModels).toEqual(["fable"]);
    expect(command[command.indexOf("--model") + 1]).toBe("fable");
  });

  test("automatic routing failure exits 1 before Claude starts", async () => {
    const h = makeHarness({
      argv: ["claude", "hello"],
      rawArgv: true,
      selectAccountRoute: () => ({
        ok: false,
        error: [
          "Claude cannot start with Fable.",
          "  c0: Fable quota is exhausted.",
          "Next: refresh account status.",
        ].join("\n"),
      }),
    });
    expect(await expectExit(main(h.deps))).toBe(1);
    expect(h.spawned).toEqual([]);
    expect(h.err.join("")).toBe(
      [
        "Error: Claude cannot start with Fable.",
        "  c0: Fable quota is exhausted.",
        "Next: refresh account status.",
        "",
      ].join("\n"),
    );
  });

  test("route identity and display ordinal survive the same-account path", async () => {
    const h = makeHarness({
      argv: ["claude", "hello"],
      rawArgv: true,
      env: { KEEPER_ACCOUNT_ORDINAL: "99" },
      selectAccountRoute: managed(5, 1),
    });
    await runAndCapture(h, main);
    expect(h.deps.env.KEEPER_ACCOUNT_ROUTE).toBe("claude-swap:5");
    expect(h.deps.env.KEEPER_ACCOUNT_ORDINAL).toBe("1");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBe(
      "/fake-home/.claude-swap/sessions/5-account",
    );
  });

  test("serial and worktree launches seed the selected account store", async () => {
    for (const cwd of [
      "/fake-home/code/repo",
      "/fake-home/worktrees/repo-lane",
    ]) {
      const calls: Array<[string, string]> = [];
      const h = makeHarness({
        argv: ["claude", "task"],
        rawArgv: true,
        cwd,
        env: cwd.includes("worktrees")
          ? { KEEPER_PLAN_WORKTREE: cwd }
          : undefined,
        selectAccountRoute: managed(3),
        seedClaudeWorkspaceTrust: (configDir, launchCwd) => {
          calls.push([configDir, launchCwd]);
          return true;
        },
      });
      await runAndCapture(h, main);
      expect(calls).toEqual([
        ["/fake-home/.claude-swap/sessions/3-account", cwd],
      ]);
    }
  });

  test("a trust write failure logs once and still launches", async () => {
    const h = makeHarness({
      argv: ["claude", "task"],
      rawArgv: true,
      seedClaudeWorkspaceTrust: () => {
        throw new Error("read-only account config");
      },
    });
    const command = await runAndCapture(h, main);
    expect(command.slice(0, 3)).toEqual([CSWAP, "run", "1"]);
    expect(h.err).toEqual([
      "Warning: Claude workspace trust preflight failed: read-only account config; launching anyway.\n",
    ]);
  });

  test("an absent account directory logs once and still launches", async () => {
    const h = makeHarness({
      argv: ["claude", "task"],
      rawArgv: true,
      resolveAccountConfigDir: () => {
        throw new Error("claude-swap profile directory is absent for slot 1");
      },
    });
    const command = await runAndCapture(h, main);
    expect(command.slice(0, 3)).toEqual([CSWAP, "run", "1"]);
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(h.err).toEqual([
      "Warning: Claude account config preflight failed: claude-swap profile directory is absent for slot 1; launching anyway.\n",
    ]);
  });
});

describe("claude-swap account config resolution", () => {
  const inventory = {
    schemaVersion: 1,
    accounts: [{ number: 2, email: "person+work@example.com" }],
  };

  test("derives the installed session layout from one live inventory", () => {
    expect(
      deriveCswapAccountConfigDir(2, inventory, {
        homeDir: "/Users/test",
        platform: "darwin",
      }),
    ).toBe(
      "/Users/test/.claude-swap-backup/sessions/2-person_work_example.com",
    );
    expect(
      deriveCswapAccountConfigDir(2, inventory, {
        homeDir: "/home/test",
        platform: "linux",
        xdgDataHome: "/state",
      }),
    ).toBe("/state/claude-swap/sessions/2-person_work_example.com");
  });

  test("fails loudly when the derived profile directory is absent", () => {
    expect(() =>
      existingCswapAccountConfigDir(
        2,
        inventory,
        { homeDir: "/Users/test", platform: "darwin" },
        () => false,
      ),
    ).toThrow("claude-swap profile directory is absent for slot 2");
  });
});

test("seedClaudeWorkspaceTrust uses the real launch cwd and preserves config fields", () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-claude-trust-"));
  try {
    const configDir = join(root, "account");
    const repo = join(root, "repo");
    const alias = join(root, "repo-alias");
    mkdirSync(configDir);
    mkdirSync(repo);
    symlinkSync(repo, alias);
    writeFileSync(
      join(configDir, ".claude.json"),
      JSON.stringify({ projects: {}, sibling: { keep: true } }),
    );

    expect(seedClaudeWorkspaceTrust(configDir, alias)).toBe(true);
    const config = JSON.parse(
      readFileSync(join(configDir, ".claude.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config.sibling).toEqual({ keep: true });
    expect(
      (config.projects as Record<string, unknown>)[realpathSync(repo)],
    ).toEqual({
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: true,
    });
    expect(seedClaudeWorkspaceTrust(configDir, alias)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("explicit account selection", () => {
  test("the selected active account is still wrapped as a managed route", async () => {
    const models: Array<string | null> = [];
    const h = makeHarness({
      argv: ["claude", "--x-account=0", "--model", "fable", "hello"],
      rawArgv: true,
      selectAccountRouteByOrdinal: (ordinal, model) => {
        models.push(model);
        return {
          ok: true,
          selection: selection(9, ordinal),
        };
      },
    });
    const command = await runAndCapture(h, main);
    expect(command.slice(0, 3)).toEqual([CSWAP, "run", "9"]);
    expect(h.requestedAccountOrdinals()).toEqual([0]);
    expect(models).toEqual(["fable"]);
    expect(h.routerCalls()).toBe(0);
    expect(h.deps.env.KEEPER_ACCOUNT_ROUTE).toBe("claude-swap:9");
  });

  test("an unresolved request exits 2 without substitution", async () => {
    const h = makeHarness({
      argv: ["claude", "--x-account", "c3", "hello"],
      rawArgv: true,
      selectAccountRouteByOrdinal: () => ({
        ok: false,
        error: "account c3 is out of range (available: c0-c1)",
      }),
    });
    expect(await expectExit(main(h.deps))).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(h.routerCalls()).toBe(0);
  });
});

describe("selection remains independent per invocation", () => {
  test("a resume resolves and wraps its own managed route", async () => {
    const h = makeHarness({
      argv: ["claude", "--resume", UUID],
      rawArgv: true,
      selectAccountRoute: managed(3),
    });
    const command = await runAndCapture(h, main);
    expect(h.routerCalls()).toBe(1);
    expect(command.slice(0, 5)).toEqual([
      CSWAP,
      "run",
      "3",
      "--share-history",
      "--",
    ]);
    expect(command.slice(5)).toContain("--resume");
  });

  test("continuation inherits Fable intent while an explicit model overrides it", async () => {
    const inherited: Array<boolean | null | undefined> = [];
    const resume = makeHarness({
      argv: ["claude", "--resume", UUID],
      rawArgv: true,
      resolveFableIntent: async (target) => target === UUID,
      selectAccountRoute: (_model, fableIntent) => {
        inherited.push(fableIntent);
        return { ok: true, selection: selection(3) };
      },
    });
    await runAndCapture(resume, main);
    expect(inherited).toEqual([true]);
    expect(resume.deps.env.KEEPER_FABLE_INTENT).toBe("1");

    const overridden: Array<boolean | null | undefined> = [];
    const explicit = makeHarness({
      argv: ["claude", "--resume", UUID, "--model", "opus", "--effort", "high"],
      rawArgv: true,
      resolveFableIntent: async () => true,
      selectAccountRoute: (_model, fableIntent) => {
        overridden.push(fableIntent);
        return { ok: true, selection: selection(4) };
      },
    });
    await runAndCapture(explicit, main);
    expect(overridden).toEqual([false]);
    expect(explicit.deps.env.KEEPER_FABLE_INTENT).toBe("0");
  });

  test("Pi launches never consult claude-swap routing", async () => {
    const h = makeHarness({ argv: ["pi", "hello"], rawArgv: true });
    const command = await runAndCapture(h, main);
    expect(command[0]).toBe("/fake-home/.local/bin/pi");
    expect(h.routerCalls()).toBe(0);
  });

  test("a Pi triple naming Fable still never consults Claude routing", async () => {
    const h = makeHarness({
      argv: ["pi", "--x-preset", "pi::fable::medium", "task"],
      rawArgv: true,
      selectAccountRoute: () => {
        throw new Error("Pi must not route through Claude accounts");
      },
    });
    const command = await runAndCapture(h, main);
    expect(command[0]).toBe("/fake-home/.local/bin/pi");
    expect(command[command.indexOf("--model") + 1]).toBe("fable");
    expect(h.routerCalls()).toBe(0);
  });
});

describe("keeper agent accounts fable-focus", () => {
  const baseInspection = {
    model_scope: "fable",
    health: "ok" as const,
    observed_at_ms: 1000,
    age_ms: 0,
    fresh: true,
    enabled: true,
    error: null,
    would_choose: null,
    candidates: [],
  };

  test("show emits one PII-free machine status envelope", async () => {
    const h = makeHarness({
      argv: ["accounts", "fable-focus", "show", "--json"],
      rawArgv: true,
      inspectRouting: () => ({
        ...baseInspection,
        fable_focus: {
          configured: true,
          state: "active",
          target_route: "claude-swap:2",
          lifetime: { kind: "permanent" },
          target_eligible: true,
          outcome: "focused",
          reason: "target-focused",
          diagnostic: "none",
        },
      }),
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    const envelope = JSON.parse(h.out.join(""));
    expect(envelope.schema_version).toBe(1);
    expect(envelope.data.target_route).toBe("claude-swap:2");
    expect(JSON.stringify(envelope)).not.toContain("@");
  });

  test("guarded current-reset refusal never mutates prior policy", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keeper-focus-refusal-"));
    let mutations = 0;
    try {
      const h = makeHarness({
        argv: [
          "accounts",
          "fable-focus",
          "set",
          "claude-swap:2",
          "current-reset",
          "--expect-reset",
          "2026-07-19T00:00:00Z",
          "--json",
        ],
        rawArgv: true,
        env: { KEEPER_ACCOUNT_ROUTING_ROOT: stateDir },
        now: () => Date.parse("2026-07-18T00:00:00Z"),
        inspectRouting: () => ({
          ...baseInspection,
          fable_focus: {
            configured: true,
            state: "active",
            target_route: "claude-swap:1",
            lifetime: { kind: "permanent" },
            target_eligible: true,
            outcome: "focused",
            reason: "target-focused",
            diagnostic: "none",
          },
        }),
        setFableFocus: async () => {
          mutations += 1;
          return { ok: true };
        },
      });
      expect(await expectExit(main(h.deps))).toBe(2);
      expect(mutations).toBe(0);
      expect(JSON.parse(h.out.join("")).error.code).toBe(
        "focus_observation_unavailable",
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("absolute, cycle-end, and guarded current-reset setters preserve stable route identity", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keeper-focus-lifetimes-"));
    const now = Date.parse("2026-07-18T00:00:00Z");
    const resetAt = "2026-07-18T01:00:00.900Z";
    const applied: unknown[] = [];
    try {
      writeObservationSidecar(observationSidecarPath(stateDir), {
        schema_version: OBSERVATION_SCHEMA_VERSION,
        observed_at_ms: now,
        health: "ok",
        routes: [
          {
            id: "claude-swap:2",
            kind: "managed",
            slot: 2,
            measuredAtMs: now,
            windows: [
              { key: "session", utilization: 0.2, resetsAt: null },
              { key: "week", utilization: 0.3, resetsAt: null },
              { key: "model:Fable", utilization: 0.4, resetsAt: resetAt },
            ],
          },
        ],
        claude_accounts: {
          count: 1,
          ordinals: { "claude-swap:2": 0 },
        },
        account_issues: {},
        notes: [],
      });
      const runSet = async (args: string[]): Promise<void> => {
        const h = makeHarness({
          argv: ["accounts", "fable-focus", "set", ...args, "--json"],
          rawArgv: true,
          env: { KEEPER_ACCOUNT_ROUTING_ROOT: stateDir },
          now: () => now,
          inspectRouting: () => ({
            ...baseInspection,
            fable_focus: {
              configured: false,
              state: "off",
              target_route: null,
              lifetime: null,
              target_eligible: null,
              outcome: "off",
              reason: "policy-off",
              diagnostic: "none",
            },
          }),
          setFableFocus: async (focus) => {
            applied.push(focus);
            return { ok: true };
          },
        });
        expect(await expectExit(main(h.deps))).toBe(0);
      };
      await runSet(["claude-swap:2", "absolute", "2026-07-19T03:00:00+03:00"]);
      await runSet(["c0", "cycle-end"]);
      await runSet([
        "claude-swap:2",
        "current-reset",
        "--expect-reset",
        "2026-07-18T01:00:00.100Z",
      ]);
      expect(applied).toEqual([
        {
          target_route: "claude-swap:2",
          lifetime: {
            kind: "absolute",
            deadline_at: "2026-07-19T00:00:00.000Z",
          },
        },
        {
          target_route: "claude-swap:2",
          lifetime: { kind: "cycle-end", reset_at: resetAt },
        },
        {
          target_route: "claude-swap:2",
          lifetime: { kind: "current-reset", reset_at: resetAt },
        },
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("clear repairs unavailable delivery instead of treating it as off", async () => {
    let cleared = 0;
    const h = makeHarness({
      argv: ["accounts", "fable-focus", "clear", "--json"],
      rawArgv: true,
      inspectRouting: () => ({
        ...baseInspection,
        fable_focus: {
          configured: false,
          state: "unavailable",
          target_route: null,
          lifetime: null,
          target_eligible: null,
          outcome: "fallback",
          reason: "policy-unavailable",
          diagnostic: "delivery-malformed",
        },
      }),
      setFableFocus: async (focus) => {
        expect(focus).toBeNull();
        cleared += 1;
        return { ok: true };
      },
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    expect(cleared).toBe(1);
  });

  test("set persists a stable route and clear is idempotent when already off", async () => {
    const applied: unknown[] = [];
    const set = makeHarness({
      argv: [
        "accounts",
        "fable-focus",
        "set",
        "claude-swap:2",
        "permanent",
        "--json",
      ],
      rawArgv: true,
      now: () => Date.parse("2026-07-18T00:00:00Z"),
      inspectRouting: () => ({
        ...baseInspection,
        fable_focus: {
          configured: false,
          state: "off",
          target_route: null,
          lifetime: null,
          target_eligible: null,
          outcome: "off",
          reason: "policy-off",
          diagnostic: "none",
        },
      }),
      setFableFocus: async (focus) => {
        applied.push(focus);
        return { ok: true };
      },
    });
    expect(await expectExit(main(set.deps))).toBe(0);
    expect(applied).toEqual([
      {
        target_route: "claude-swap:2",
        lifetime: { kind: "permanent" },
      },
    ]);

    const clear = makeHarness({
      argv: ["accounts", "fable-focus", "clear", "--json"],
      rawArgv: true,
      inspectRouting: set.deps.inspectRoutingFn,
      setFableFocus: async () => {
        throw new Error("idempotent clear must not mutate");
      },
    });
    expect(await expectExit(main(clear.deps))).toBe(0);
  });
});

describe("keeper agent accounts codex-pool", () => {
  test("interactive enrollment inherits the terminal and loads only the companion", async () => {
    const h = makeHarness({
      argv: ["accounts", "codex-pool", "enroll", "keeper-codex-b"],
      rawArgv: true,
      resolvePiCodexPoolExtension: () => ({
        args: ["-e", "/fake/pi-codex-pool.ts"],
        health: "ready",
        problem_code: null,
      }),
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    expect(h.spawned).toEqual([
      [h.deps.piBin, "-e", "/fake/pi-codex-pool.ts", "--model", "openai-codex"],
    ]);
    expect(h.err.join("")).toBe(
      "Codex pool enrollment is interactive; in Pi run /login keeper-codex-b, then exit.\n",
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBe("native");
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIASES).toBe(
      '["keeper-codex-a","keeper-codex-b"]',
    );
  });

  test("noninteractive workflow commands preserve the versioned result", async () => {
    const calls: Array<{ operation: string; source?: string }> = [];
    const h = makeHarness({
      argv: [
        "accounts",
        "codex-pool",
        "proof",
        "capture",
        "/fake/report.json",
        "--json",
      ],
      rawArgv: true,
      runCodexPoolWorkflow: (operation, source) => {
        calls.push({ operation, ...(source ? { source } : {}) });
        return {
          schema_version: 1,
          ok: true,
          operation,
          state: "native",
          problem_code: null,
          proof: { verdict: "proven", reasons: [] },
        };
      },
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    expect(calls).toEqual([
      { operation: "proof-capture", source: "/fake/report.json" },
    ]);
    expect(JSON.parse(h.out.join(""))).toEqual({
      schema_version: 1,
      ok: true,
      operation: "proof-capture",
      state: "native",
      problem_code: null,
      proof: { verdict: "proven", reasons: [] },
    });
    expect(h.spawned).toEqual([]);
  });
});

describe("keeper agent accounts check", () => {
  const inspection = {
    model_scope: null,
    health: "ok" as const,
    observed_at_ms: 1000,
    age_ms: 42,
    fresh: true,
    enabled: true,
    error: null,
    would_choose: {
      id: "claude-swap:2",
      kind: "managed" as const,
      slot: 2,
      reason: "selected",
    },
    candidates: [
      {
        id: "claude-swap:2",
        kind: "managed" as const,
        slot: 2,
        worst_utilization: 0.2,
        fable_remaining: 0.4,
      },
    ],
    fable_focus: {
      configured: false,
      state: "off" as const,
      target_route: null,
      lifetime: null,
      target_eligible: null,
      outcome: "off" as const,
      reason: "policy-off" as const,
      diagnostic: "none",
    },
  };

  test("--json emits the read-only snapshot", async () => {
    const h = makeHarness({
      argv: ["accounts", "check", "--json"],
      rawArgv: true,
      inspectRouting: () => inspection,
      selectAccountRoute: () => {
        throw new Error("accounts check must not reserve");
      },
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    expect(h.routerCalls()).toBe(0);
    expect(h.spawned).toEqual([]);
    expect(JSON.parse(h.out.join(""))).toEqual({
      schema_version: 1,
      claude_launch_routing: inspection,
      codex_session_routing: h.deps.inspectCodexSessionRoutingFn(),
    });
  });

  test("disabled human output reports unavailable without a fake default", async () => {
    const h = makeHarness({
      argv: ["accounts", "check"],
      rawArgv: true,
      inspectRouting: () => ({
        model_scope: null,
        health: "no-observation",
        observed_at_ms: null,
        age_ms: null,
        fresh: false,
        enabled: false,
        error: "no claude-swap account inventory is available",
        would_choose: null,
        candidates: [],
        fable_focus: {
          configured: false,
          state: "unavailable",
          target_route: null,
          lifetime: null,
          target_eligible: null,
          outcome: "fallback",
          reason: "policy-unavailable",
          diagnostic: "delivery-missing",
        },
      }),
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    expect(h.out.join("")).toContain("model-scope=generic-only");
    expect(h.out.join("")).toContain("would choose: unavailable");
    expect(h.out.join("")).toContain("codex session routing:");
  });

  test("reports Codex session routing separately without selecting or creating pressure", async () => {
    let codexReads = 0;
    const codex = {
      activation: { mode: "active" as const, problem_code: null },
      companion: { health: "ready" as const, problem_code: null },
      capacity: {
        provider: "openai-codex" as const,
        health: "ready" as const,
        config_binding: "a".repeat(64),
        observed_at_ms: 1000,
        fresh: true,
        verdict: {
          kind: "pooled" as const,
          provider: "openai-codex" as const,
          alias: "keeper-codex-b",
          reason: "selected" as const,
        },
        candidates: [
          {
            alias: "keeper-codex-a",
            worst_used_percent: 80,
            pressure: 0,
            cooldown_until_ms: 0,
            eligible: true,
          },
          {
            alias: "keeper-codex-b",
            worst_used_percent: 10,
            pressure: 0,
            cooldown_until_ms: 0,
            eligible: true,
          },
        ],
      },
    };
    const h = makeHarness({
      argv: ["accounts", "check", "--json"],
      rawArgv: true,
      inspectRouting: () => inspection,
      inspectCodexSessionRouting: () => {
        codexReads += 1;
        return codex;
      },
      selectAccountRoute: () => {
        throw new Error("diagnostics must not reserve Claude capacity");
      },
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    const output = JSON.parse(h.out.join(""));
    expect(output.codex_session_routing).toEqual(codex);
    expect(output.claude_launch_routing.would_choose.id).toBe("claude-swap:2");
    expect(codexReads).toBe(1);
    expect(h.routerCalls()).toBe(0);
    expect(h.spawned).toEqual([]);
    expect(JSON.stringify(output)).not.toContain("@example");
  });
});
