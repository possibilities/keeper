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
import type {
  AccountsInspectMainDeps,
  AccountsPiRuntimeData,
} from "../cli/accounts";
import { inspectMain } from "../cli/accounts";
import type { EnvelopeSink } from "../cli/envelope";
import { writeObservationSidecar } from "../src/account-observation";
import type { RouteResolution, RouteSelection } from "../src/account-router";
import {
  deriveCswapAccountConfigDir,
  existingCswapAccountConfigDir,
  OBSERVATION_SCHEMA_VERSION,
  observationSidecarPath,
} from "../src/account-routing-config";
import { main, seedClaudeWorkspaceTrust } from "../src/agent/main";
import { poolAliasPolicyBinding } from "../src/codex-pool-activation";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
} from "../src/codex-quota-scope";
import { buildSessionCatalog } from "../src/history/catalog";
import type {
  KeeperJobAlias,
  NativeSessionArtifact,
  SessionCatalog,
} from "../src/history/model";
import type { RuntimeTarget } from "../src/session-runtime";
import {
  expectExit,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

const CSWAP = "/fake-home/.local/bin/cswap";
const UUID = "11111111-1111-1111-1111-111111111111";
const CODEX_ALIASES = ["keeper-codex-a", "keeper-codex-b"];

function aliasPolicy(generic: string[], spark: string[]) {
  return {
    [CODEX_GENERIC_QUOTA_SCOPE]: generic,
    [CODEX_SPARK_QUOTA_SCOPE]: spark,
  };
}

function aliasPolicyEnv(generic: string[], spark: string[]): string {
  return JSON.stringify(aliasPolicy(generic, spark));
}

function aliasPolicyBindingEnv(generic: string[], spark: string[]): string {
  return poolAliasPolicyBinding(CODEX_ALIASES, aliasPolicy(generic, spark));
}

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

  test("an unresolved continuation preserves unknown intent", async () => {
    const observed: Array<boolean | null | undefined> = [];
    const h = makeHarness({
      argv: ["claude", "--resume", UUID],
      rawArgv: true,
      resolveFableIntent: async () => null,
      selectAccountRoute: (_model, fableIntent) => {
        observed.push(fableIntent);
        return { ok: true, selection: selection(6) };
      },
    });
    await runAndCapture(h, main);
    expect(observed).toEqual([null]);
    expect(h.deps.env.KEEPER_FABLE_INTENT).toBeUndefined();
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

  test("focus setters preserve stable routes with old measurement provenance", async () => {
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
            measuredAtMs: Date.parse("2001-01-01T00:00:00Z"),
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

describe("keeper agent accounts non-fable-focus", () => {
  const offFable = {
    configured: false,
    state: "off" as const,
    target_route: null,
    lifetime: null,
    target_eligible: null,
    outcome: "off" as const,
    reason: "policy-off" as const,
    diagnostic: "none",
  };
  const offNonFable = { ...offFable };
  const baseInspection = {
    model_scope: "non-fable",
    health: "ok" as const,
    observed_at_ms: Date.parse("2026-07-18T00:00:00Z"),
    age_ms: 0,
    fresh: true,
    enabled: true,
    error: null,
    would_choose: null,
    candidates: [
      {
        id: "claude-swap:2",
        kind: "managed" as const,
        slot: 2,
        worst_utilization: 0.2,
        fable_remaining: 0.6,
      },
    ],
    fable_focus: offFable,
    non_fable_focus: offNonFable,
  };

  test("show exposes the canonical PII-free sibling view", async () => {
    const h = makeHarness({
      argv: ["accounts", "non-fable-focus", "show", "--json"],
      rawArgv: true,
      inspectRouting: (intent) => {
        expect(intent).toBe(false);
        return {
          ...baseInspection,
          non_fable_focus: {
            configured: true,
            state: "active",
            target_route: "claude-swap:2",
            lifetime: { kind: "permanent" },
            target_eligible: true,
            outcome: "focused",
            reason: "target-focused",
            diagnostic: "none",
          },
        };
      },
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    const envelope = JSON.parse(h.out.join(""));
    expect(envelope).toMatchObject({
      schema_version: 1,
      ok: true,
      data: {
        target_route: "claude-swap:2",
        outcome: "focused",
        reason: "target-focused",
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("@");
  });

  test("stable and cN targets persist only stable routes with supported lifetimes", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keeper-non-fable-focus-"));
    const now = Date.parse("2026-07-18T00:00:00Z");
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
          argv: ["accounts", "non-fable-focus", "set", ...args, "--json"],
          rawArgv: true,
          env: { KEEPER_ACCOUNT_ROUTING_ROOT: stateDir },
          now: () => now,
          inspectRouting: () => baseInspection,
          setNonFableFocus: async (focus) => {
            applied.push(focus);
            return { ok: true };
          },
        });
        expect(await expectExit(main(h.deps))).toBe(0);
      };
      await runSet(["claude-swap:2", "permanent"]);
      await runSet([
        "c0",
        "absolute",
        "2026-07-19T03:00:00+03:00",
        "--require-eligible",
      ]);
      expect(applied).toEqual([
        {
          target_route: "claude-swap:2",
          lifetime: { kind: "permanent" },
        },
        {
          target_route: "claude-swap:2",
          lifetime: {
            kind: "absolute",
            deadline_at: "2026-07-19T00:00:00.000Z",
          },
        },
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("elapsed deadline and stale or ineligible guarded activation refuse before mutation", async () => {
    const now = Date.parse("2026-07-18T00:00:00Z");
    for (const testCase of [
      {
        args: ["claude-swap:2", "absolute", "2026-07-18T00:00:00Z"],
        inspection: baseInspection,
        code: "focus_deadline_elapsed",
      },
      {
        args: ["claude-swap:2", "permanent", "--require-eligible"],
        inspection: {
          ...baseInspection,
          fresh: false,
          enabled: false,
          health: "ok" as const,
        },
        code: "focus_observation_unavailable",
      },
      {
        args: ["claude-swap:3", "permanent", "--require-eligible"],
        inspection: baseInspection,
        code: "focus_target_ineligible",
      },
    ]) {
      let mutations = 0;
      const h = makeHarness({
        argv: [
          "accounts",
          "non-fable-focus",
          "set",
          ...testCase.args,
          "--json",
        ],
        rawArgv: true,
        now: () => now,
        inspectRouting: () => testCase.inspection,
        setNonFableFocus: async () => {
          mutations += 1;
          return { ok: true };
        },
      });
      expect(await expectExit(main(h.deps))).toBe(2);
      expect(mutations).toBe(0);
      expect(JSON.parse(h.out.join("")).error.code).toBe(testCase.code);
    }
  });

  test("clear is idempotent and uncertain mutation acknowledgement is explicit", async () => {
    const clear = makeHarness({
      argv: ["accounts", "non-fable-focus", "clear", "--json"],
      rawArgv: true,
      inspectRouting: () => baseInspection,
      setNonFableFocus: async () => {
        throw new Error("idempotent clear must not mutate");
      },
    });
    expect(await expectExit(main(clear.deps))).toBe(0);

    const uncertain = makeHarness({
      argv: [
        "accounts",
        "non-fable-focus",
        "set",
        "claude-swap:2",
        "permanent",
        "--json",
      ],
      rawArgv: true,
      inspectRouting: () => baseInspection,
      setNonFableFocus: async () => ({
        ok: false,
        code: "focus_rpc_unreachable",
        message: "acknowledgement unavailable",
      }),
    });
    expect(await expectExit(main(uncertain.deps))).toBe(1);
    expect(JSON.parse(uncertain.out.join(""))).toEqual({
      schema_version: 1,
      ok: false,
      error: {
        code: "focus_rpc_unreachable",
        message: "acknowledgement unavailable",
        recovery:
          "Re-read Non-Fable focus state before retrying an uncertain update.",
      },
      data: null,
    });
  });
});

describe("keeper agent accounts codex-pool", () => {
  test("an explicitly armed fresh Pi launch receives one bounded pooled proof window", async () => {
    const launches: Array<[boolean | undefined, string | null | undefined]> =
      [];
    const h = makeHarness({
      argv: [
        "pi",
        "--x-codex-pool-proof-window=arm",
        "--model",
        "openai-codex/gpt-5.4-mini",
        "--thinking",
        "high",
        "prove routing",
      ],
      rawArgv: true,
      now: () => 1_000_000,
      resolvePiCodexPoolExtension: () => ({
        args: ["-e", "/fake/pi-codex-pool.ts"],
        health: "ready",
        problem_code: null,
      }),
      codexPoolLaunchContext: (reserve?: boolean, modelId?: string | null) => {
        launches.push([reserve, modelId]);
        return {
          mode: "native",
          activation_mode: "native",
          aliases: CODEX_ALIASES,
          alias_policy: {
            [CODEX_GENERIC_QUOTA_SCOPE]: [],
            [CODEX_SPARK_QUOTA_SCOPE]: [],
          },
          requested_quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
          initial_scope: CODEX_GENERIC_QUOTA_SCOPE,
          config_binding: "b".repeat(64),
          revision: "c".repeat(40),
          initial_alias: null,
          problem_code: "activation-pending",
        };
      },
    });
    const command = await runAndCapture(h, main);
    expect(command).toContain("/fake/pi-codex-pool.ts");
    expect(command).not.toContain("--x-codex-pool-proof-window=arm");
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBe("proof");
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIASES).toBe(
      '["keeper-codex-a","keeper-codex-b"]',
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY).toBe(
      aliasPolicyEnv(CODEX_ALIASES, []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING).toBe(
      aliasPolicyBindingEnv(CODEX_ALIASES, []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE).toBe(
      CODEX_GENERIC_QUOTA_SCOPE,
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_CONFIG_BINDING).toBe("b".repeat(64));
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_REVISION).toBe("c".repeat(40));
    expect(
      JSON.parse(h.deps.env.KEEPER_PI_CODEX_POOL_PROOF_WINDOW ?? "null"),
    ).toEqual({
      schema_version: 1,
      armed_at_ms: 1_000_000,
      expires_at_ms: 1_900_000,
      launcher_pid: process.pid,
      seams: {
        forced_refresh: true,
        fault_injection: true,
      },
    });
    expect(h.spawnOptions[0]?.env?.KEEPER_PI_CODEX_POOL_PROOF_WINDOW).toBe(
      h.deps.env.KEEPER_PI_CODEX_POOL_PROOF_WINDOW,
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_FALLBACK_REASON).toBeUndefined();
    expect(launches).toEqual([[false, "openai-codex/gpt-5.4-mini"]]);
  });

  test("a Spark proof window authorizes only capability-detected aliases", async () => {
    const launches: Array<[boolean | undefined, string | null | undefined]> =
      [];
    const h = makeHarness({
      argv: [
        "pi",
        "--x-codex-pool-proof-window=arm",
        "--model",
        "openai-codex/gpt-5.3-codex-spark",
        "prove spark routing",
      ],
      rawArgv: true,
      now: () => 1_000_000,
      resolvePiCodexPoolExtension: () => ({
        args: ["-e", "/fake/pi-codex-pool.ts"],
        health: "ready",
        problem_code: null,
      }),
      codexPoolLaunchContext: (reserve?: boolean, modelId?: string | null) => {
        launches.push([reserve, modelId]);
        return {
          mode: "active",
          activation_mode: "active",
          aliases: CODEX_ALIASES,
          alias_policy: {
            [CODEX_GENERIC_QUOTA_SCOPE]: CODEX_ALIASES,
            [CODEX_SPARK_QUOTA_SCOPE]: [],
          },
          capability_policy: {
            [CODEX_GENERIC_QUOTA_SCOPE]: CODEX_ALIASES,
            [CODEX_SPARK_QUOTA_SCOPE]: ["keeper-codex-b"],
          },
          requested_quota_scope: CODEX_SPARK_QUOTA_SCOPE,
          initial_scope: CODEX_SPARK_QUOTA_SCOPE,
          config_binding: "d".repeat(64),
          revision: "e".repeat(40),
          initial_alias: null,
          problem_code: null,
        };
      },
    });

    await runAndCapture(h, main);

    expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBe("proof");
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY).toBe(
      aliasPolicyEnv([], ["keeper-codex-b"]),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING).toBe(
      aliasPolicyBindingEnv([], ["keeper-codex-b"]),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE).toBe(
      CODEX_SPARK_QUOTA_SCOPE,
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS).toBeUndefined();
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_REVISION).toBe("e".repeat(40));
    expect(launches).toEqual([[false, "openai-codex/gpt-5.3-codex-spark"]]);
  });

  test("a Spark proof refuses to launch without a capable alias", async () => {
    const h = makeHarness({
      argv: [
        "pi",
        "--x-codex-pool-proof-window=arm",
        "--model",
        "openai-codex/gpt-5.3-codex-spark",
        "prove spark routing",
      ],
      rawArgv: true,
      now: () => 1_000_000,
      resolvePiCodexPoolExtension: () => ({
        args: ["-e", "/fake/pi-codex-pool.ts"],
        health: "ready",
        problem_code: null,
      }),
      codexPoolLaunchContext: () => ({
        mode: "active",
        activation_mode: "active",
        aliases: CODEX_ALIASES,
        alias_policy: {
          [CODEX_GENERIC_QUOTA_SCOPE]: CODEX_ALIASES,
          [CODEX_SPARK_QUOTA_SCOPE]: [],
        },
        capability_policy: {
          [CODEX_GENERIC_QUOTA_SCOPE]: CODEX_ALIASES,
          [CODEX_SPARK_QUOTA_SCOPE]: [],
        },
        requested_quota_scope: CODEX_SPARK_QUOTA_SCOPE,
        initial_scope: CODEX_SPARK_QUOTA_SCOPE,
        config_binding: "d".repeat(64),
        revision: "e".repeat(40),
        initial_alias: null,
        problem_code: "pool-unavailable",
      }),
    });

    expect(await expectExit(main(h.deps))).toBe(1);
    expect(h.spawned).toEqual([]);
    expect(h.err.join("")).toContain(
      `no enrolled Codex account supports ${CODEX_SPARK_QUOTA_SCOPE}`,
    );
  });

  test("an absent arm clears inherited proof state and leaves native launch behavior", async () => {
    const h = makeHarness({
      argv: [
        "pi",
        "--model",
        "openai-codex/gpt-5.4-mini",
        "--thinking",
        "high",
        "resume natively",
      ],
      rawArgv: true,
      env: {
        KEEPER_PI_CODEX_POOL_PROOF_WINDOW: JSON.stringify({
          schema_version: 1,
          armed_at_ms: 1_000_000,
          expires_at_ms: 1_900_000,
          launcher_pid: process.pid,
        }),
      },
      resolvePiCodexPoolExtension: () => ({
        args: ["-e", "/fake/pi-codex-pool.ts"],
        health: "ready",
        problem_code: null,
      }),
    });
    const command = await runAndCapture(h, main);
    expect(command).toContain("/fake/pi-codex-pool.ts");
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBe("native");
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY).toBe(
      aliasPolicyEnv([], []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING).toBe(
      aliasPolicyBindingEnv([], []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE).toBe(
      CODEX_GENERIC_QUOTA_SCOPE,
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_PROOF_WINDOW).toBeUndefined();
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_REVISION).toBeUndefined();
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_FALLBACK_REASON).toBe(
      "activation-pending",
    );
  });

  test("proof arming rejects resumed sessions and malformed markers", async () => {
    for (const argv of [
      ["pi", "--x-codex-pool-proof-window=arm", "--resume", UUID],
      ["pi", "--x-codex-pool-proof-window=yes", "prove routing"],
    ]) {
      const h = makeHarness({ argv, rawArgv: true });
      expect(await expectExit(main(h.deps))).toBe(2);
      expect(h.spawned).toEqual([]);
      expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBeUndefined();
    }
  });

  test("interactive enrollment warns before starting Pi and loads only the companion", async () => {
    const warning =
      "Warning: enrolling this alias revokes that account's other live grants " +
      "(legacy leg and bare Pi), causing a native Codex outage until activation.\n";
    const h = makeHarness({
      argv: ["accounts", "codex-pool", "enroll", "keeper-codex-b"],
      rawArgv: true,
      resolvePiCodexPoolExtension: () => ({
        args: ["-e", "/fake/pi-codex-pool.ts"],
        health: "ready",
        problem_code: null,
      }),
    });
    const delegate = h.deps.spawn;
    h.deps.spawn = (argv, options) => {
      expect(h.err.join("")).toContain(warning);
      return delegate(argv, options);
    };
    expect(await expectExit(main(h.deps))).toBe(0);
    expect(h.spawned).toEqual([
      [
        h.deps.piBin,
        "-e",
        "/fake/pi-codex-pool.ts",
        "--model",
        "openai-codex/gpt-5.4-mini",
      ],
    ]);
    expect(h.err.join("")).toBe(
      warning +
        "Codex pool enrollment is interactive; in Pi run /login keeper-codex-b, then exit.\n",
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBe("native");
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIASES).toBe(
      '["keeper-codex-a","keeper-codex-b"]',
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY).toBe(
      aliasPolicyEnv([], []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING).toBe(
      aliasPolicyBindingEnv([], []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE).toBe(
      CODEX_GENERIC_QUOTA_SCOPE,
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

  test("activate forwards degraded authorization only for the exact flag", async () => {
    const calls: Array<{
      operation: string;
      source?: string;
      authorization: unknown;
    }> = [];
    const h = makeHarness({
      argv: [
        "accounts",
        "codex-pool",
        "activate",
        "--authorize-degraded=proven-degraded-single-alias",
        "--json",
      ],
      rawArgv: true,
      runCodexPoolWorkflow: (operation, source, authorization) => {
        calls.push({
          operation,
          ...(source ? { source } : {}),
          authorization: authorization ?? null,
        });
        return {
          schema_version: 1,
          ok: true,
          operation,
          state: "active-degraded",
          problem_code: null,
          proof: {
            verdict: "proven-degraded-single-alias",
            reasons: ["clause-incomplete"],
          },
        };
      },
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    expect(calls).toEqual([
      {
        operation: "activate",
        authorization: { degraded_verdict: "proven-degraded-single-alias" },
      },
    ]);
    expect(JSON.parse(h.out.join("")).state).toBe("active-degraded");
  });

  test("rejects a degraded flag naming the wrong verdict", async () => {
    const h = makeHarness({
      argv: [
        "accounts",
        "codex-pool",
        "activate",
        "--authorize-degraded=proven",
      ],
      rawArgv: true,
      runCodexPoolWorkflow: () => {
        throw new Error("must not reach the workflow");
      },
    });
    expect(await expectExit(main(h.deps))).toBe(2);
    expect(h.err.join("")).toContain("invalid arguments");
    expect(h.spawned).toEqual([]);
  });

  test("rejects the degraded flag on a non-activate operation", async () => {
    const h = makeHarness({
      argv: [
        "accounts",
        "codex-pool",
        "status",
        "--authorize-degraded=proven-degraded-single-alias",
      ],
      rawArgv: true,
      runCodexPoolWorkflow: () => {
        throw new Error("must not reach the workflow");
      },
    });
    expect(await expectExit(main(h.deps))).toBe(2);
    expect(h.err.join("")).toContain("invalid arguments");
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
    non_fable_focus: {
      configured: true,
      state: "active" as const,
      target_route: "claude-swap:2" as const,
      lifetime: { kind: "permanent" as const },
      target_eligible: true,
      outcome: "focused" as const,
      reason: "target-focused" as const,
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
        quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
        refresh_failure_state: {
          schema_version: 1 as const,
          consecutive_failures: 3,
          last_failure_class: "timeout" as const,
          last_failure_at_ms: 1_234,
        },
        verdict: {
          kind: "pooled" as const,
          provider: "openai-codex" as const,
          alias: "keeper-codex-b",
          reason: "selected" as const,
        },
        candidates: [
          {
            alias: "keeper-codex-a",
            quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
            used_percent: 80,
            worst_used_percent: 80,
            pressure: 0,
            cooldown_until_ms: 0,
            shared_cooldown_until_ms: 0,
            quota_cooldown_until_ms: 0,
            capacity_cooldown_until_ms: 0,
            supported: true,
            authorized: true,
            eligible: true,
          },
          {
            alias: "keeper-codex-b",
            quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
            used_percent: 10,
            worst_used_percent: 10,
            pressure: 0,
            cooldown_until_ms: 0,
            shared_cooldown_until_ms: 0,
            quota_cooldown_until_ms: 0,
            capacity_cooldown_until_ms: 0,
            supported: true,
            authorized: true,
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
    expect(output.codex_session_routing.capacity.refresh_failure_state).toEqual(
      {
        schema_version: 1,
        consecutive_failures: 3,
        last_failure_class: "timeout",
        last_failure_at_ms: 1_234,
      },
    );
    expect(output.claude_launch_routing.would_choose.id).toBe("claude-swap:2");
    expect(codexReads).toBe(1);
    expect(h.routerCalls()).toBe(0);
    expect(h.spawned).toEqual([]);
    expect(JSON.stringify(output)).not.toContain("@example");
  });

  test("human output surfaces the degraded single-alias state loudly", async () => {
    const h = makeHarness({
      argv: ["accounts", "check"],
      rawArgv: true,
      inspectRouting: () => inspection,
      inspectCodexSessionRouting: () => ({
        activation: { mode: "active-degraded" as const, problem_code: null },
        companion: { health: "ready" as const, problem_code: null },
        capacity: {
          provider: "openai-codex" as const,
          health: "ready" as const,
          config_binding: "a".repeat(64),
          observed_at_ms: 1000,
          fresh: true,
          quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
          verdict: {
            kind: "pooled" as const,
            provider: "openai-codex" as const,
            alias: "keeper-codex-a",
            reason: "selected" as const,
          },
          candidates: [
            {
              alias: "keeper-codex-a",
              quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
              used_percent: 10,
              worst_used_percent: 10,
              pressure: 0,
              cooldown_until_ms: 0,
              shared_cooldown_until_ms: 0,
              quota_cooldown_until_ms: 0,
              capacity_cooldown_until_ms: 0,
              supported: true,
              authorized: true,
              eligible: true,
            },
          ],
        },
      }),
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    const rendered = h.out.join("");
    expect(rendered).toContain("activation=active-degraded");
    expect(rendered).toContain("DEGRADED single-alias operation");
    expect(rendered).toContain("NOT balanced");
  });
});

describe("keeper accounts inspect", () => {
  const PI_JOB_ID = "job-pi-inspect-1";
  const PI_NATIVE_ID = "pi-inspect-1";
  const CLAUDE_JOB_ID = "job-claude-inspect-1";
  const CLAUDE_NATIVE_ID = "claude-inspect-1";

  function artifact(
    harness: "claude" | "pi",
    nativeId: string,
    title: string,
  ): NativeSessionArtifact {
    return {
      harness,
      nativeId,
      path: `/history/${nativeId}.jsonl`,
      project: "/work/accounts-inspect",
      currentTitle: title,
      titleHistory: [title],
      titleHistoryComplete: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      bytes: 10,
    };
  }

  function job(
    harness: "claude" | "pi",
    jobId: string,
    nativeId: string,
    title: string,
  ): KeeperJobAlias {
    return {
      jobId,
      harness,
      nativeId,
      transcriptPath: null,
      project: "/work/accounts-inspect",
      currentTitle: title,
      titleHistory: [title],
      state: "working",
      createdAtMs: 1_000,
      updatedAtMs: 1_500,
      pid: 42,
      startTime: "start-42",
    };
  }

  function catalog(): SessionCatalog {
    return buildSessionCatalog(
      [
        artifact("pi", PI_NATIVE_ID, "Pi inspect session"),
        artifact("claude", CLAUDE_NATIVE_ID, "Claude inspect session"),
      ],
      [
        job("pi", PI_JOB_ID, PI_NATIVE_ID, "Pi inspect session"),
        job(
          "claude",
          CLAUDE_JOB_ID,
          CLAUDE_NATIVE_ID,
          "Claude inspect session",
        ),
      ],
    );
  }

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

  const claudeLaunchFixture = {
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
    candidates: [],
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
    non_fable_focus: {
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

  const codexLaunchFixture = {
    activation: { mode: "native" as const, problem_code: null },
    companion: { health: "ready" as const, problem_code: null },
    capacity: {
      provider: "openai-codex" as const,
      health: "unavailable" as const,
      config_binding: null,
      observed_at_ms: null,
      fresh: false,
      quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
      verdict: {
        kind: "native-fallback" as const,
        provider: "openai-codex" as const,
        reason: "pool-unavailable" as const,
        warning:
          "[keeper-codex-pool] pool-unavailable; using native openai-codex" as const,
      },
      candidates: [],
    },
  };

  async function runInspect(
    argv: string[],
    overrides: Partial<AccountsInspectMainDeps> = {},
  ): Promise<{ body: Record<string, unknown>; code: number | null }> {
    let claudeCalls = 0;
    let codexCalls = 0;
    const captured = captureSink();
    await inspectMain(
      argv,
      {
        catalog: catalog(),
        env: {},
        now: () => 5_000,
        runtimeDir: "/unused/runtime",
        inspectClaudeLaunchFn: () => {
          claudeCalls += 1;
          return claudeLaunchFixture;
        },
        inspectCodexLaunchFn: () => {
          codexCalls += 1;
          return codexLaunchFixture;
        },
        readRouteFn: () => {
          throw new Error(
            "readRouteFn must not be called without a resolved Session",
          );
        },
        ...overrides,
      },
      captured.sink,
    );
    expect(claudeCalls).toBe(1);
    expect(codexCalls).toBe(1);
    return { body: captured.json(), code: captured.code() };
  }

  test("no reference and no ambient identity reports no_session, never a route dump", async () => {
    const { body, code } = await runInspect([]);
    expect(code).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      generated_at_ms: 5_000,
      claude_launch: claudeLaunchFixture,
      codex_launch: codexLaunchFixture,
      pi_runtime: {
        status: "no_session",
        job_id: null,
        reason: null,
        quota_scope: null,
        state: null,
        alias: null,
        observed_at_ms: null,
      },
    });
  });

  test("an unresolvable explicit reference reports a bounded reason, not a whole-command failure", async () => {
    const { body, code } = await runInspect(["does-not-exist"]);
    expect(code).toBe(0);
    expect(body.ok).toBe(true);
    const piRuntime = (body.data as { pi_runtime: AccountsPiRuntimeData })
      .pi_runtime;
    expect(piRuntime.status).toBe("session_unresolved");
    expect(piRuntime.reason).toBe("session_not_found");
    expect(piRuntime.job_id).toBeNull();
  });

  test("a resolved Claude Session reports not_pi without probing the Pi route store", async () => {
    const { body, code } = await runInspect(["Claude inspect session"]);
    expect(code).toBe(0);
    const piRuntime = (body.data as { pi_runtime: AccountsPiRuntimeData })
      .pi_runtime;
    expect(piRuntime).toEqual({
      status: "not_pi",
      job_id: CLAUDE_JOB_ID,
      reason: null,
      quota_scope: null,
      state: null,
      alias: null,
      observed_at_ms: null,
    });
  });

  test("a resolved Pi Session with no fresh route observation reports unavailable", async () => {
    const { body, code } = await runInspect(["Pi inspect session"], {
      readRouteFn: () => null,
    });
    expect(code).toBe(0);
    const piRuntime = (body.data as { pi_runtime: AccountsPiRuntimeData })
      .pi_runtime;
    expect(piRuntime).toEqual({
      status: "unavailable",
      job_id: PI_JOB_ID,
      reason: null,
      quota_scope: null,
      state: null,
      alias: null,
      observed_at_ms: null,
    });
  });

  test("a resolved Pi Session with a fresh route observation reports the exact proven route", async () => {
    const seenTargets: RuntimeTarget[] = [];
    const { body, code } = await runInspect(["Pi inspect session"], {
      readRouteFn: (target) => {
        seenTargets.push(target);
        return {
          schema_version: 1,
          subject_scope: "session",
          job_id: PI_JOB_ID,
          native_session_id: PI_NATIVE_ID,
          agent_id: null,
          quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
          state: "selected",
          alias: "keeper-codex-b",
          observed_at_ms: 4_950,
        };
      },
    });
    expect(code).toBe(0);
    const piRuntime = (body.data as { pi_runtime: AccountsPiRuntimeData })
      .pi_runtime;
    expect(piRuntime).toEqual({
      status: "proven",
      job_id: PI_JOB_ID,
      reason: null,
      quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
      state: "selected",
      alias: "keeper-codex-b",
      observed_at_ms: 4_950,
    });
    expect(seenTargets).toEqual([
      {
        jobId: PI_JOB_ID,
        harness: "pi",
        nativeSessionId: PI_NATIVE_ID,
      },
    ]);
  });

  test("ambient identity selects the Session when no explicit reference is given", async () => {
    const { body, code } = await runInspect([], {
      env: { KEEPER_JOB_ID: PI_JOB_ID },
      readRouteFn: () => null,
    });
    expect(code).toBe(0);
    const piRuntime = (body.data as { pi_runtime: AccountsPiRuntimeData })
      .pi_runtime;
    expect(piRuntime.status).toBe("unavailable");
    expect(piRuntime.job_id).toBe(PI_JOB_ID);
  });

  test("repeated inspections are idempotent — no reservation, pressure, or affinity drift", async () => {
    const first = await runInspect(["Pi inspect session"], {
      readRouteFn: () => null,
    });
    const second = await runInspect(["Pi inspect session"], {
      readRouteFn: () => null,
    });
    expect(first.body.data).toEqual(second.body.data);
  });

  test("--help renders leaf help without touching any inspector seam", async () => {
    let claudeCalls = 0;
    const captured = captureSink();
    await inspectMain(
      ["--help"],
      {
        inspectClaudeLaunchFn: () => {
          claudeCalls += 1;
          return claudeLaunchFixture;
        },
      },
      captured.sink,
    );
    expect(claudeCalls).toBe(0);
    expect(captured.code()).toBeNull();
  });
});
