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
import type { RouteResolution, RouteSelection } from "../src/account-router";
import {
  deriveCswapAccountConfigDir,
  existingCswapAccountConfigDir,
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
    expect(JSON.parse(h.out.join(""))).toEqual(inspection);
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
      }),
    });
    expect(await expectExit(main(h.deps))).toBe(0);
    expect(h.out.join("")).toContain("model-scope=generic-only");
    expect(h.out.join("")).toContain("would choose: unavailable");
  });
});
