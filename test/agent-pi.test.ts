/**
 * Pi launcher pins: `keeper agent pi` maps wrapper features onto Pi-native CLI
 * contracts. There is no Keeper-owned Pi profile farm — model/thinking defaults
 * become `--model`/`--thinking`, session naming uses Pi's `--session-id` and
 * `--name`, and package/metadata commands pass through cleanly.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_OBSERVATION_SCHEMA_VERSION,
  codexPressureLedgerPath,
} from "../src/account-routing-config";
import { parseArgsForAgent } from "../src/agent/args";
import type { PresetCatalog } from "../src/agent/config";
import {
  PI_CODEX_POOL_PACKAGE_NAME,
  PI_CODEX_POOL_PACKAGE_VERSION,
  resolvePiCodexPoolExtension,
} from "../src/agent/launch-config";
import { main, productionCodexPoolLaunchContext } from "../src/agent/main";
import {
  KEEPER_AGENT_PI_PROMPT_CLI_ENV,
  KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV,
  PiPromptArtifactsError,
} from "../src/agent/pi-prompt-artifacts";
import { publishCodexObservation } from "../src/codex-account-observation-refresh";
import {
  codexPoolBindings,
  FileCodexPoolActivationStore,
  poolAliasPolicyBinding,
  resolveCodexPoolWorkflowPaths,
  resolveKeeperRevision,
} from "../src/codex-pool-activation";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
} from "../src/codex-quota-scope";
import {
  expectExit,
  flagValues,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

function piHarness(
  argv: string[],
  opts: Omit<Parameters<typeof makeHarness>[0], "argv"> = {},
) {
  return makeHarness({
    ...opts,
    argv: ["pi", ...argv],
    rawArgv: true,
  });
}

// The harness's default pi_default injects `--thinking high --model glm` on a
// fresh pi launch (see DEFAULT_PRESET_CATALOG).
const DEFAULT_THINKING = ["--thinking", "high"];
const DEFAULT_MODEL = ["--model", "glm"];
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

function quotaWindow(
  quotaScope: typeof CODEX_GENERIC_QUOTA_SCOPE | typeof CODEX_SPARK_QUOTA_SCOPE,
  usedPercent: number,
  exhausted: boolean,
  resetAtMs: number,
) {
  return {
    role:
      quotaScope === CODEX_GENERIC_QUOTA_SCOPE
        ? ("primary" as const)
        : ("additional" as const),
    quota_scope: quotaScope,
    key: quotaScope === CODEX_GENERIC_QUOTA_SCOPE ? "session" : "spark",
    label:
      quotaScope === CODEX_GENERIC_QUOTA_SCOPE
        ? "session"
        : "GPT-5.3-Codex-Spark",
    window_seconds: 18_000,
    used_percent: usedPercent,
    exhausted,
    reset_at_ms: resetAtMs,
  };
}

/** A catalog whose pi_default triple pins the given model + thinking. The triple's
 *  effort segment carries the keeper effort that maps onto pi's thinking band. */
function piDefaultCatalog(model: string, thinking: string): PresetCatalog {
  return {
    presets: {},
    pi_default: { harness: "pi", model, effort: thinking },
  };
}

describe("Pi parse signals", () => {
  test("Pi session/fork/headless flags are detected without stripping them", () => {
    const session = parseArgsForAgent(["--session", "abc", "hello"], "pi");
    expect(session.hasContinueOrResume).toBe(true);
    expect(session.remainingArgs).toEqual(["--session", "abc", "hello"]);

    const fork = parseArgsForAgent(["--fork", "abc"], "pi");
    expect(fork.hasContinueOrResume).toBe(true);
    expect(fork.hasForkSession).toBe(true);

    expect(parseArgsForAgent(["--print", "hello"], "pi").hasPrint).toBe(true);
    expect(parseArgsForAgent(["--mode", "json"], "pi").hasPrint).toBe(true);
  });
});

describe("Pi Codex companion contract", () => {
  test("the repository manifest and source resolve to one explicit extension", () => {
    const resolved = resolvePiCodexPoolExtension();
    expect(resolved.health).toBe("ready");
    expect(resolved.problem_code).toBeNull();
    expect(resolved.args).toHaveLength(2);
    expect(resolved.args[0]).toBe("-e");
    expect(resolved.args[1]).toEndWith(
      "/integrations/pi-codex-pool/src/index.ts",
    );
    expect(PI_CODEX_POOL_PACKAGE_NAME).toBe(
      "@earendil-works/keeper-pi-codex-pool",
    );
    expect(PI_CODEX_POOL_PACKAGE_VERSION).toBe("0.1.0");
  });

  test("missing and incompatible source contracts return no argv", () => {
    expect(
      resolvePiCodexPoolExtension(
        "/missing",
        () => false,
        () => "",
      ),
    ).toEqual({
      args: [],
      health: "missing",
      problem_code: "companion-missing",
    });
    expect(
      resolvePiCodexPoolExtension(
        "/fake",
        () => true,
        (path) =>
          path.endsWith("package.json")
            ? JSON.stringify({
                name: PI_CODEX_POOL_PACKAGE_NAME,
                version: "9.9.9",
              })
            : "openAICodexResponsesApi KEEPER_PI_CODEX_POOL_MODE",
      ),
    ).toEqual({
      args: [],
      health: "incompatible",
      problem_code: "companion-incompatible",
    });
  });
});

describe("Pi command assembly", () => {
  test("fresh interactive launch adds Pi session flags without Claude-only flags", async () => {
    const h = piHarness(["--x-no-confirm", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.piBin,
      "hello",
      ...DEFAULT_THINKING,
      ...DEFAULT_MODEL,
      "--session-id",
      "00000000-0000-0000-0000-000000000000",
      "--name",
      "proj-001",
    ]);
    expect(cmd).not.toContain("--strict-mcp-config");
    expect(cmd).not.toContain("--teammate-mode");
  });

  test("configured model and thinking are injected for Pi", async () => {
    const h = piHarness(["--print", "hello"], {
      presetCatalog: piDefaultCatalog("openai/gpt-4o", "high"),
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["openai/gpt-4o"]);
    expect(flagValues(cmd, "--thinking")).toEqual(["high"]);
  });

  test("explicit native model and thinking suppress the configured Pi default", async () => {
    const h = piHarness(
      ["--print", "--model", "sonnet", "--thinking", "low", "hello"],
      {
        presetCatalog: piDefaultCatalog("openai/gpt-4o", "high"),
      },
    );
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["sonnet"]);
    expect(flagValues(cmd, "--thinking")).toEqual(["low"]);
  });

  test("an explicit --x-profile has no effect — no Pi profile farm remains", async () => {
    const h = piHarness(["--x-profile", "work", "--print", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd[0]).toBe(h.deps.piBin);
    expect(cmd).toContain("--print");
    expect(h.deps.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("--fork gets a fresh display name but not a wrapper session id", async () => {
    const h = piHarness(["--fork", "abc"]);
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--session-id")).toEqual([]);
    expect(flagValues(cmd, "--name")).toEqual(["proj-001"]);
  });

  test("--no-session suppresses wrapper session id and name", async () => {
    const h = piHarness(["--no-session", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--session-id")).toEqual([]);
    expect(flagValues(cmd, "--name")).toEqual([]);
  });

  test("arms the keeper pi extension (-e) when the resolver yields flags", async () => {
    const h = piHarness(["--x-no-confirm", "hello"], {
      resolvePiExtensionArgs: () => ["-e", "/fake/keeper-events.ts"],
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "-e")).toEqual(["/fake/keeper-events.ts"]);
  });

  test("loads the tracked extension and Codex companion as separate explicit sources", async () => {
    const launches: Array<[boolean | undefined, string | null | undefined]> =
      [];
    const h = piHarness(["--x-no-confirm", "hello"], {
      presetCatalog: piDefaultCatalog("openai-codex/gpt-5.2-codex", "high"),
      resolvePiExtensionArgs: () => ["-e", "/fake/keeper-events.ts"],
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
          requested_quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
          initial_scope: CODEX_GENERIC_QUOTA_SCOPE,
          config_binding: "b".repeat(64),
          initial_alias: "keeper-codex-b",
          problem_code: null,
        };
      },
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "-e")).toEqual([
      "/fake/keeper-events.ts",
      "/fake/pi-codex-pool.ts",
    ]);
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBe("active");
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
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS).toBe(
      "keeper-codex-b",
    );
    expect(launches).toEqual([[true, "openai-codex/gpt-5.2-codex"]]);
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_FALLBACK_REASON).toBeUndefined();
  });

  test("active-degraded launch emits the pinned generic policy", async () => {
    const h = piHarness(["--x-no-confirm", "hello"], {
      presetCatalog: piDefaultCatalog("openai-codex/gpt-5.2-codex", "high"),
      resolvePiCodexPoolExtension: () => ({
        args: ["-e", "/fake/pi-codex-pool.ts"],
        health: "ready",
        problem_code: null,
      }),
      codexPoolLaunchContext: () => ({
        mode: "active",
        activation_mode: "active-degraded",
        degraded: true,
        aliases: CODEX_ALIASES,
        alias_policy: {
          [CODEX_GENERIC_QUOTA_SCOPE]: ["keeper-codex-b"],
          [CODEX_SPARK_QUOTA_SCOPE]: [],
        },
        requested_quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
        initial_scope: CODEX_GENERIC_QUOTA_SCOPE,
        config_binding: "e".repeat(64),
        initial_alias: "keeper-codex-b",
        problem_code: null,
      }),
    });

    await runAndCapture(h, main);

    expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBe("active");
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY).toBe(
      aliasPolicyEnv(["keeper-codex-b"], []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING).toBe(
      aliasPolicyBindingEnv(["keeper-codex-b"], []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE).toBe(
      CODEX_GENERIC_QUOTA_SCOPE,
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS).toBe(
      "keeper-codex-b",
    );
  });

  test("generic active Spark startup stays active without an initial alias", async () => {
    const h = piHarness(["--x-no-confirm", "hello"], {
      presetCatalog: piDefaultCatalog(
        "openai-codex/gpt-5.3-codex-spark",
        "high",
      ),
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
        requested_quota_scope: CODEX_SPARK_QUOTA_SCOPE,
        initial_scope: CODEX_SPARK_QUOTA_SCOPE,
        config_binding: "f".repeat(64),
        initial_alias: null,
        problem_code: null,
      }),
    });

    await runAndCapture(h, main);

    expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBe("active");
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY).toBe(
      aliasPolicyEnv(CODEX_ALIASES, []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING).toBe(
      aliasPolicyBindingEnv(CODEX_ALIASES, []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE).toBe(
      CODEX_SPARK_QUOTA_SCOPE,
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS).toBeUndefined();
  });

  test("Spark-only active-scoped launch emits only Spark aliases", async () => {
    const h = piHarness(["--x-no-confirm", "hello"], {
      presetCatalog: piDefaultCatalog(
        "openai-codex/gpt-5.3-codex-spark",
        "high",
      ),
      resolvePiCodexPoolExtension: () => ({
        args: ["-e", "/fake/pi-codex-pool.ts"],
        health: "ready",
        problem_code: null,
      }),
      codexPoolLaunchContext: () => ({
        mode: "active",
        activation_mode: "active-scoped",
        aliases: CODEX_ALIASES,
        alias_policy: {
          [CODEX_GENERIC_QUOTA_SCOPE]: [],
          [CODEX_SPARK_QUOTA_SCOPE]: ["keeper-codex-b"],
        },
        requested_quota_scope: CODEX_SPARK_QUOTA_SCOPE,
        initial_scope: CODEX_SPARK_QUOTA_SCOPE,
        config_binding: "0".repeat(64),
        initial_alias: "keeper-codex-b",
        problem_code: null,
      }),
    });

    await runAndCapture(h, main);

    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY).toBe(
      aliasPolicyEnv([], ["keeper-codex-b"]),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING).toBe(
      aliasPolicyBindingEnv([], ["keeper-codex-b"]),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE).toBe(
      CODEX_SPARK_QUOTA_SCOPE,
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS).toBe(
      "keeper-codex-b",
    );
  });

  test("active-scoped launch preserves generic and Spark policy", async () => {
    const h = piHarness(["--x-no-confirm", "hello"], {
      presetCatalog: piDefaultCatalog(
        "openai-codex/gpt-5.3-codex-spark",
        "high",
      ),
      resolvePiCodexPoolExtension: () => ({
        args: ["-e", "/fake/pi-codex-pool.ts"],
        health: "ready",
        problem_code: null,
      }),
      codexPoolLaunchContext: () => ({
        mode: "active",
        activation_mode: "active-scoped",
        aliases: CODEX_ALIASES,
        alias_policy: {
          [CODEX_GENERIC_QUOTA_SCOPE]: ["keeper-codex-a"],
          [CODEX_SPARK_QUOTA_SCOPE]: ["keeper-codex-b"],
        },
        requested_quota_scope: CODEX_SPARK_QUOTA_SCOPE,
        initial_scope: CODEX_SPARK_QUOTA_SCOPE,
        config_binding: "1".repeat(64),
        initial_alias: "keeper-codex-b",
        problem_code: null,
      }),
    });

    await runAndCapture(h, main);

    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY).toBe(
      aliasPolicyEnv(["keeper-codex-a"], ["keeper-codex-b"]),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING).toBe(
      aliasPolicyBindingEnv(["keeper-codex-a"], ["keeper-codex-b"]),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE).toBe(
      CODEX_SPARK_QUOTA_SCOPE,
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS).toBe(
      "keeper-codex-b",
    );
  });

  test("production launch keeps runtime switching active when only one scope verifies", () => {
    const previousRoutingRoot = process.env.KEEPER_CODEX_ACCOUNT_ROUTING_ROOT;
    const previousConfigRoot = process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT;
    const previousAliases = process.env.KEEPER_PI_CODEX_POOL_ALIASES;
    const root = mkdtempSync(join(tmpdir(), "codex-pool-launch-scope-"));
    try {
      const routingRoot = join(root, "routing");
      const configRoot = join(root, "config");
      process.env.KEEPER_CODEX_ACCOUNT_ROUTING_ROOT = routingRoot;
      process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT = configRoot;
      process.env.KEEPER_PI_CODEX_POOL_ALIASES = JSON.stringify(CODEX_ALIASES);
      const now = Date.now();
      const bindings = codexPoolBindings(
        resolveKeeperRevision(),
        CODEX_ALIASES,
      );
      new FileCodexPoolActivationStore(
        resolveCodexPoolWorkflowPaths({
          KEEPER_PI_CODEX_POOL_CONFIG_ROOT: configRoot,
        }),
      ).writeActivation({
        schema_version: 1,
        mode: "active-scoped",
        revision: bindings.revision,
        config_binding: bindings.config_binding,
        alias_binding: bindings.alias_binding,
        aliases: CODEX_ALIASES,
        degraded: null,
        scoped: {
          proof_scope: CODEX_SPARK_QUOTA_SCOPE,
          authorized_aliases: aliasPolicy(CODEX_ALIASES, CODEX_ALIASES),
        },
        updated_at_ms: now,
      });
      const publish = (
        genericExhausted: boolean,
        spark: "healthy" | "missing",
      ) =>
        publishCodexObservation(routingRoot, {
          schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
          provider: "openai-codex",
          config_binding: bindings.config_binding,
          observed_at_ms: now,
          aliases: CODEX_ALIASES.map((alias) => ({
            alias,
            status: "healthy" as const,
            observed_at_ms: now,
            expires_at_ms: now + 60_000,
            windows: [
              quotaWindow(
                CODEX_GENERIC_QUOTA_SCOPE,
                genericExhausted ? 100 : 20,
                genericExhausted,
                now + 60_000,
              ),
              ...(spark === "healthy"
                ? [
                    quotaWindow(
                      CODEX_SPARK_QUOTA_SCOPE,
                      20,
                      false,
                      now + 60_000,
                    ),
                  ]
                : []),
            ],
          })),
        });

      publish(false, "missing");
      const sparkContext = productionCodexPoolLaunchContext(
        process.env,
        true,
        "openai-codex/gpt-5.3-codex-spark",
      );
      expect(sparkContext).toMatchObject({
        mode: "active",
        activation_mode: "active-scoped",
        alias_policy: aliasPolicy(CODEX_ALIASES, CODEX_ALIASES),
        initial_alias: null,
        problem_code: "pool-unavailable",
      });
      expect(existsSync(codexPressureLedgerPath(routingRoot))).toBe(false);
      expect(
        productionCodexPoolLaunchContext(
          process.env,
          true,
          "openai-codex/gpt-5.4-mini",
        ).initial_alias,
      ).toMatch(/^keeper-codex-/);

      publish(true, "healthy");
      const genericContext = productionCodexPoolLaunchContext(
        process.env,
        true,
        "openai-codex/gpt-5.4-mini",
      );
      expect(genericContext).toMatchObject({
        mode: "active",
        activation_mode: "active-scoped",
        alias_policy: aliasPolicy(CODEX_ALIASES, CODEX_ALIASES),
        initial_alias: null,
        problem_code: "pool-unavailable",
      });
      expect(
        productionCodexPoolLaunchContext(
          process.env,
          true,
          "openai-codex/gpt-5.3-codex-spark",
        ).initial_alias,
      ).toMatch(/^keeper-codex-/);

      publish(true, "missing");
      expect(
        productionCodexPoolLaunchContext(
          process.env,
          true,
          "openai-codex/gpt-5.4-mini",
        ),
      ).toMatchObject({
        mode: "native",
        alias_policy: aliasPolicy([], []),
        initial_alias: null,
      });
    } finally {
      if (previousRoutingRoot === undefined) {
        delete process.env.KEEPER_CODEX_ACCOUNT_ROUTING_ROOT;
      } else {
        process.env.KEEPER_CODEX_ACCOUNT_ROUTING_ROOT = previousRoutingRoot;
      }
      if (previousConfigRoot === undefined) {
        delete process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT;
      } else {
        process.env.KEEPER_PI_CODEX_POOL_CONFIG_ROOT = previousConfigRoot;
      }
      if (previousAliases === undefined) {
        delete process.env.KEEPER_PI_CODEX_POOL_ALIASES;
      } else {
        process.env.KEEPER_PI_CODEX_POOL_ALIASES = previousAliases;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing or incompatible companion stays native with a bounded warning", async () => {
    for (const unavailable of [
      {
        health: "missing" as const,
        problem_code: "companion-missing" as const,
      },
      {
        health: "incompatible" as const,
        problem_code: "companion-incompatible" as const,
      },
    ]) {
      const h = piHarness(["--x-no-confirm", "hello"], {
        resolvePiCodexPoolExtension: () => ({ args: [], ...unavailable }),
        codexPoolLaunchContext: () => ({
          mode: "active",
          activation_mode: "active",
          aliases: CODEX_ALIASES,
          alias_policy: {
            [CODEX_GENERIC_QUOTA_SCOPE]: CODEX_ALIASES,
            [CODEX_SPARK_QUOTA_SCOPE]: [],
          },
          requested_quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
          initial_scope: CODEX_GENERIC_QUOTA_SCOPE,
          config_binding: "c".repeat(64),
          initial_alias: "keeper-codex-a",
          problem_code: null,
        }),
      });
      const cmd = await runAndCapture(h, main);
      expect(cmd).not.toContain("/fake/pi-codex-pool.ts");
      expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBe("native");
      expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY).toBe(
        aliasPolicyEnv([], []),
      );
      expect(h.deps.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING).toBe(
        aliasPolicyBindingEnv([], []),
      );
      expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS).toBeUndefined();
      expect(h.err.join("")).toBe(
        `Warning: [${unavailable.problem_code}] [keeper-codex-pool] pool-unavailable; using native openai-codex\n`,
      );
    }
  });

  test("a non-Codex model loads the scoped source without reserving Codex pressure", async () => {
    const reservations: Array<boolean | undefined> = [];
    const h = piHarness(["--x-no-confirm", "hello"], {
      presetCatalog: piDefaultCatalog("anthropic/claude-sonnet", "high"),
      resolvePiCodexPoolExtension: () => ({
        args: ["-e", "/fake/pi-codex-pool.ts"],
        health: "ready",
        problem_code: null,
      }),
      codexPoolLaunchContext: (reserve?: boolean, modelId?: string | null) => {
        reservations.push(reserve);
        expect(modelId).toBe("anthropic/claude-sonnet");
        return {
          mode: "active",
          activation_mode: "active",
          aliases: CODEX_ALIASES,
          alias_policy: {
            [CODEX_GENERIC_QUOTA_SCOPE]: CODEX_ALIASES,
            [CODEX_SPARK_QUOTA_SCOPE]: [],
          },
          requested_quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
          initial_scope: CODEX_GENERIC_QUOTA_SCOPE,
          config_binding: "d".repeat(64),
          initial_alias: null,
          problem_code: null,
        };
      },
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "--model")).toEqual(["anthropic/claude-sonnet"]);
    expect(flagValues(cmd, "-e")).toEqual(["/fake/pi-codex-pool.ts"]);
    expect(reservations).toEqual([false]);
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_ALIAS_POLICY).toBe(
      aliasPolicyEnv(CODEX_ALIASES, []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_POLICY_BINDING).toBe(
      aliasPolicyBindingEnv(CODEX_ALIASES, []),
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE).toBe(
      CODEX_GENERIC_QUOTA_SCOPE,
    );
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS).toBeUndefined();
  });

  test("activation-pending context loads the companion but keeps native Codex authoritative", async () => {
    const h = piHarness(["--x-no-confirm", "hello"], {
      resolvePiCodexPoolExtension: () => ({
        args: ["-e", "/fake/pi-codex-pool.ts"],
        health: "ready",
        problem_code: null,
      }),
    });
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "-e")).toEqual(["/fake/pi-codex-pool.ts"]);
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
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_FALLBACK_REASON).toBe(
      "activation-pending",
    );
  });

  test("omits -e when both explicit extension sources are absent", async () => {
    const h = piHarness(["--x-no-confirm", "hello"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).not.toContain("-e");
  });
});

describe("Pi prompt-artifact preflight", () => {
  test("managed Pi canonicalizes storage and overwrites compiler stamps before preflight", async () => {
    const launcherArgvPrefix = [
      "/trusted/bin/bun",
      "/trusted/keeper/cli/keeper.ts",
      "agent",
    ];
    const h = piHarness(["--x-no-confirm", "hello"], {
      launcherArgvPrefix,
      env: {
        PI_CODING_AGENT_DIR: "/tmp/pi-override",
        PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-sessions",
        [KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV]: "/spoof/bun",
        [KEEPER_AGENT_PI_PROMPT_CLI_ENV]: "/spoof/keeper.ts",
      },
    });

    await runAndCapture(h, main);

    expect(h.piPromptArtifactEnvSnapshots).toHaveLength(1);
    expect(h.piPromptArtifactEnvSnapshots[0]).toMatchObject({
      [KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV]: launcherArgvPrefix[0],
      [KEEPER_AGENT_PI_PROMPT_CLI_ENV]: launcherArgvPrefix[1],
    });
    expect(h.piPromptArtifactEnvSnapshots[0]).not.toHaveProperty(
      "PI_CODING_AGENT_DIR",
    );
    expect(h.piPromptArtifactEnvSnapshots[0]).not.toHaveProperty(
      "PI_CODING_AGENT_SESSION_DIR",
    );
    expect(h.deps.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(h.deps.env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
  });

  test("managed Pi launches preflight before state discovery and spawn", async () => {
    const h = piHarness(["--x-no-confirm", "hello"]);

    await runAndCapture(h, main);

    expect(h.piPromptArtifactsCalls).toHaveLength(1);
    expect(h.piStateSharingCalls).toHaveLength(1);
    expect(h.piLaunchOrder).toEqual(["preflight", "state", "intent", "spawn"]);
  });

  test("a birth-intent failure aborts before Pi spawn", async () => {
    const h = piHarness(["--x-no-confirm", "hello"]);
    h.deps.writeBirthIntent = () => {
      throw new Error("birth intent unavailable");
    };

    await expect(main(h.deps)).rejects.toThrow("birth intent unavailable");
    expect(h.spawned).toEqual([]);
  });

  test("a preflight failure exits before Pi state discovery or spawn", async () => {
    const h = piHarness(["--x-no-confirm", "hello"], {
      ensurePiPromptArtifacts: () => {
        throw new PiPromptArtifactsError("prompt artifacts are unavailable");
      },
    });

    expect(await expectExit(main(h.deps))).toBe(1);
    expect(h.err.join("")).toContain("prompt artifacts are unavailable");
    expect(h.piLaunchOrder).toEqual(["preflight"]);
    expect(h.piStateSharingCalls).toEqual([]);
    expect(h.spawned).toEqual([]);
  });

  test("the outer tmux delegator skips preflight and the inner Pi launch runs it once", async () => {
    const outer = piHarness(
      ["--x-tmux", "--x-tmux-detached", "--x-no-confirm", "hello"],
      {
        env: {
          PI_CODING_AGENT_DIR: "/tmp/pi-override",
          PI_CODING_AGENT_SESSION_DIR: "/tmp/pi-sessions",
        },
        launcherStateDir: mkdtempSync(join(tmpdir(), "keeper-pi-tmux-")),
        tmuxCommand: (cmd) =>
          cmd.includes("new-window")
            ? { exitCode: 0, stdout: "agent\x01@1\x01%1\n", stderr: "" }
            : { exitCode: 0, stdout: "", stderr: "" },
      },
    );

    expect(await expectExit(main(outer.deps))).toBe(0);
    expect(outer.piPromptArtifactsCalls).toEqual([]);
    expect(outer.piStateSharingCalls).toEqual([]);
    const outerMetadata = JSON.parse(outer.out.join("")) as {
      launchScript: string;
    };
    const launchScript = readFileSync(outerMetadata.launchScript, "utf8");
    expect(launchScript).toContain(
      `export ${KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV}='/fake-home/.bun/bin/bun'`,
    );
    expect(launchScript).toContain(
      `export ${KEEPER_AGENT_PI_PROMPT_CLI_ENV}='/fake-home/code/keeper/cli/keeper.ts'`,
    );
    expect(launchScript).not.toContain("PI_CODING_AGENT_DIR");
    expect(launchScript).not.toContain("PI_CODING_AGENT_SESSION_DIR");

    const inner = piHarness(["--x-no-confirm", "hello"]);
    await runAndCapture(inner, main);
    expect(inner.piPromptArtifactsCalls).toHaveLength(1);
    expect(inner.piPromptArtifactEnvSnapshots[0]).toMatchObject({
      [KEEPER_AGENT_PI_PROMPT_EXECUTABLE_ENV]: "/fake-home/.bun/bin/bun",
      [KEEPER_AGENT_PI_PROMPT_CLI_ENV]: "/fake-home/code/keeper/cli/keeper.ts",
    });
    expect(
      outer.piPromptArtifactsCalls.length + inner.piPromptArtifactsCalls.length,
    ).toBe(1);
  });
});

describe("Pi passthrough commands", () => {
  test("package commands pass through without model or session defaults", async () => {
    const h = piHarness(["list"], {
      presetCatalog: piDefaultCatalog("openai/gpt-4o", "high"),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.piBin, "list"]);
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBeUndefined();
    expect(h.piLaunchOrder).toEqual(["preflight", "state", "spawn"]);
  });

  test("metadata flags pass through without model or session defaults", async () => {
    const h = piHarness(["--list-models"], {
      presetCatalog: piDefaultCatalog("openai/gpt-4o", "high"),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.piBin, "--list-models"]);
    expect(h.deps.env.KEEPER_PI_CODEX_POOL_MODE).toBeUndefined();
  });

  test("a package-command-shaped --print prompt is not passthrough", async () => {
    const h = piHarness(["--print", "install"], {
      presetCatalog: piDefaultCatalog("openai/gpt-4o", "high"),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.piBin,
      "--print",
      "install",
      "--thinking",
      "high",
      "--model",
      "openai/gpt-4o",
      "--session-id",
      "00000000-0000-0000-0000-000000000000",
      "--name",
      "proj-001",
    ]);
  });

  test("an explicit --x-profile still has no effect for passthrough", async () => {
    const h = piHarness(["--x-profile", "work", "list"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.piBin, "list"]);
    expect(h.deps.env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  test("the canonical AGENTS.md leaf-guard fn runs on a passthrough launch", async () => {
    // Pi passthrough launches (package commands like `list`) must still reach
    // the leaf guard exactly once, matching every other pi launch — there is no
    // profile farm loop left to gate it behind.
    const h = piHarness(["list"]);
    await runAndCapture(h, main);
    expect(h.piStateSharingCalls).toHaveLength(1);
  });
});
