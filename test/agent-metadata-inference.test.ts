import { describe, expect, test } from "bun:test";
import {
  buildClaudeMetadataInferenceArgv,
  buildClaudeMetadataInferenceEnv,
  CLAUDE_METADATA_INFERENCE_MAX_OUTPUT_BYTES,
  CLAUDE_METADATA_INFERENCE_SCHEMA,
  CLAUDE_METADATA_INFERENCE_SYSTEM_PROMPT,
} from "../src/agent/launch-config";
import {
  captureClaudeMetadataInference,
  type MetadataInferenceCapture,
  type MetadataInferenceRuntime,
  main,
} from "../src/agent/main";
import { expectExit, makeHarness } from "./helpers/agent-main-harness";

const CLAUDE = "/opt/claude";
const CSWAP = "/opt/cswap";
const INPUT = "User: Improve project search ranking";

function completedRuntime(
  options: {
    code?: number;
    stdout?: string;
    stderr?: string;
    stdoutOverflow?: boolean;
    stderrOverflow?: boolean;
    onSpawn?: (argv: string[], env: Record<string, string>) => void;
    onCapture?: (stream: "stdout" | "stderr", maxBytes: number) => void;
    onTerminate?: (signal: "SIGKILL") => void;
  } = {},
): MetadataInferenceRuntime {
  return {
    spawn: (argv, spawnOptions) => {
      options.onSpawn?.(argv, spawnOptions.env);
      return {
        exited: Promise.resolve(options.code ?? 0),
        captureStdout: async (maxBytes): Promise<MetadataInferenceCapture> => {
          options.onCapture?.("stdout", maxBytes);
          return {
            text:
              options.stdout ??
              JSON.stringify({
                structured_output: { name: "Project Search Ranking" },
              }),
            overflow: options.stdoutOverflow ?? false,
          };
        },
        captureStderr: async (maxBytes): Promise<MetadataInferenceCapture> => {
          options.onCapture?.("stderr", maxBytes);
          return {
            text: options.stderr ?? "",
            overflow: options.stderrOverflow ?? false,
          };
        },
        terminateTree: (signal) => options.onTerminate?.(signal),
      };
    },
    setTimeout: () => 17,
    clearTimeout: () => {},
    createCancellation: () => ({
      signal: new AbortController().signal,
      dispose() {},
    }),
  };
}

function inferenceArgs(): string[] {
  return buildClaudeMetadataInferenceArgv({
    claudeBin: CLAUDE,
    cswapBin: CSWAP,
    slot: 4,
    input: INPUT,
  });
}

async function captureWith(
  runtime: MetadataInferenceRuntime,
  signal: AbortSignal = new AbortController().signal,
) {
  return captureClaudeMetadataInference({
    argv: inferenceArgs(),
    env: { HOME: "/home/test" },
    cwd: "/work/project",
    runtime,
    signal,
  });
}

describe("Claude metadata inference launch plan", () => {
  test("pins the managed Haiku print command and strips ambient identity/auth routes", () => {
    const argv = inferenceArgs();
    expect(argv).toEqual([
      CSWAP,
      "run",
      "4",
      "--share-history",
      "--",
      "--print",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      CLAUDE_METADATA_INFERENCE_SCHEMA,
      "--system-prompt",
      CLAUDE_METADATA_INFERENCE_SYSTEM_PROMPT,
      "--",
      INPUT,
    ]);
    for (const absent of [
      "--session-id",
      "--name",
      "--plugin-dir",
      "--fallback-model",
      "--resume",
      "--continue",
    ]) {
      expect(argv).not.toContain(absent);
    }

    const env = buildClaudeMetadataInferenceEnv(
      {
        HOME: "/home/test",
        PATH: "/bin",
        LANG: "en_US.UTF-8",
        CLAUDE_CODE_SESSION_ID: "parent-session",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CONFIG_DIR: "/ambient/claude",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
        ANTHROPIC_API_KEY: "api-secret",
        ANTHROPIC_AUTH_TOKEN: "bearer-secret",
        ANTHROPIC_BASE_URL: "https://ambient.invalid",
        AWS_PROFILE: "bedrock",
        AWS_ACCESS_KEY_ID: "aws-secret",
        GOOGLE_APPLICATION_CREDENTIALS: "/ambient/google.json",
        CLOUD_ML_REGION: "ambient-region",
        KEEPER_JOB_ID: "parent-job",
        KEEPER_ACCOUNT_ROUTE: "claude-swap:99",
      },
      { id: "claude-swap:4", accountOrdinal: 2 },
    );
    expect(env).toEqual({
      HOME: "/home/test",
      PATH: "/bin",
      LANG: "en_US.UTF-8",
      KEEPER_ACCOUNT_ROUTE: "claude-swap:4",
      KEEPER_ACCOUNT_ORDINAL: "2",
    });
  });

  test("rejects empty, NUL, and over-cap input before composition", () => {
    for (const input of ["", " \n ", "a\0b", "x".repeat(16 * 1024 + 1)]) {
      expect(() =>
        buildClaudeMetadataInferenceArgv({
          claudeBin: CLAUDE,
          cswapBin: CSWAP,
          slot: 1,
          input,
        }),
      ).toThrow();
    }
  });
});

describe("Claude metadata inference launcher branch", () => {
  test("routes once, emits one envelope, and skips every ordinary Session artifact seam", async () => {
    const routeCalls: Array<[string | null, boolean | null | undefined]> = [];
    const metadataSpawns: Array<{
      argv: string[];
      env: Record<string, string>;
    }> = [];
    const outputCaps: Array<[string, number]> = [];
    let pluginLoads = 0;
    let presetLoads = 0;
    let stateSharing = 0;
    let ordinals = 0;
    let uuids = 0;
    let accountConfigReads = 0;
    let trustWrites = 0;
    let cancellationDisposals = 0;
    const h = makeHarness({
      argv: ["claude", "--x-metadata-inference", INPUT],
      rawArgv: true,
      env: {
        HOME: "/home/test",
        PATH: "/bin",
        CLAUDE_CODE_SESSION_ID: "parent-session",
        ANTHROPIC_API_KEY: "secret",
        AWS_PROFILE: "bedrock",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google.json",
        KEEPER_JOB_ID: "parent-job",
      },
      selectAccountRoute: (model, fableIntent) => {
        routeCalls.push([model, fableIntent]);
        return {
          ok: true,
          selection: {
            id: "claude-swap:8",
            kind: "managed",
            slot: 8,
            reason: "selected",
          },
        };
      },
      nextCwdOrdinal: () => {
        ordinals += 1;
        return 1;
      },
      randomUuid: () => {
        uuids += 1;
        return "11111111-1111-1111-1111-111111111111";
      },
      resolveAccountConfigDir: () => {
        accountConfigReads += 1;
        return "/unused";
      },
      seedClaudeWorkspaceTrust: () => {
        trustWrites += 1;
        return true;
      },
    });
    h.deps.loadPluginSourcesFn = () => {
      pluginLoads += 1;
      return { pluginDirs: [], pluginScanDirs: [] };
    };
    h.deps.loadPresetCatalogFn = () => {
      presetLoads += 1;
      throw new Error("metadata mode must not load presets");
    };
    h.deps.ensureClaudeStateSharingFn = () => {
      stateSharing += 1;
    };
    const runtime = completedRuntime({
      onSpawn: (argv, env) => metadataSpawns.push({ argv, env }),
      onCapture: (stream, maxBytes) => outputCaps.push([stream, maxBytes]),
    });
    runtime.createCancellation = () => ({
      signal: new AbortController().signal,
      dispose: () => {
        cancellationDisposals += 1;
      },
    });
    h.deps.metadataInferenceRuntime = runtime;

    expect(await expectExit(main(h.deps))).toBe(0);
    expect(routeCalls).toEqual([["haiku", false]]);
    expect(metadataSpawns).toHaveLength(1);
    expect(metadataSpawns[0]?.argv.slice(0, 5)).toEqual([
      "/fake-home/.local/bin/cswap",
      "run",
      "8",
      "--share-history",
      "--",
    ]);
    expect(metadataSpawns[0]?.env).toEqual({
      HOME: "/home/test",
      PATH: "/bin",
      KEEPER_ACCOUNT_ROUTE: "claude-swap:8",
    });
    expect(outputCaps).toEqual([
      ["stdout", CLAUDE_METADATA_INFERENCE_MAX_OUTPUT_BYTES],
      ["stderr", CLAUDE_METADATA_INFERENCE_MAX_OUTPUT_BYTES],
    ]);
    expect(JSON.parse(h.out.join(""))).toEqual({
      schema_version: 1,
      ok: true,
      candidate: "project-search-ranking",
    });
    expect(h.err).toEqual([]);
    expect(h.spawned).toEqual([]);
    expect(h.birthIntents).toEqual([]);
    expect(h.birthRecords).toEqual([]);
    expect(h.tmuxCommands).toEqual([]);
    expect(pluginLoads).toBe(0);
    expect(presetLoads).toBe(0);
    expect(stateSharing).toBe(0);
    expect(ordinals).toBe(0);
    expect(uuids).toBe(0);
    expect(accountConfigReads).toBe(0);
    expect(trustWrites).toBe(0);
    expect(cancellationDisposals).toBe(1);
  });

  test("an unavailable route returns a bounded failure without process creation", async () => {
    let metadataSpawns = 0;
    const h = makeHarness({
      argv: ["claude", "--x-metadata-inference", INPUT],
      rawArgv: true,
      selectAccountRoute: () => ({
        ok: false,
        error: `private route details ${"x".repeat(10_000)}`,
      }),
    });
    h.deps.metadataInferenceRuntime = completedRuntime({
      onSpawn: () => {
        metadataSpawns += 1;
      },
    });

    expect(await expectExit(main(h.deps))).toBe(1);
    expect(metadataSpawns).toBe(0);
    expect(h.spawned).toEqual([]);
    expect(h.err).toEqual([]);
    expect(JSON.parse(h.out.join(""))).toEqual({
      schema_version: 1,
      ok: false,
      error: {
        kind: "route_unavailable",
        message: "no managed Claude account route is available",
      },
    });
    expect(h.out.join("")).not.toContain("private route details");
  });

  test("Pi and mixed ordinary-launch flags fail before routing or artifacts", async () => {
    for (const argv of [
      ["pi", "--x-metadata-inference", INPUT],
      ["claude", "--x-metadata-inference", INPUT, "--x-tmux"],
      ["claude", "--x-account", "c1", "--x-metadata-inference", INPUT],
    ]) {
      const h = makeHarness({ argv, rawArgv: true });
      expect(await expectExit(main(h.deps))).toBe(2);
      expect(h.routerCalls()).toBe(0);
      expect(h.spawned).toEqual([]);
      expect(h.tmuxCommands).toEqual([]);
      expect(JSON.parse(h.out.join(""))).toMatchObject({
        schema_version: 1,
        ok: false,
        error: { kind: "invalid_input" },
      });
    }
  });
});

describe("Claude metadata inference captured process", () => {
  test("accepts the Claude JSON envelope and canonicalizes through root slugging", async () => {
    expect(
      await captureWith(
        completedRuntime({
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            structured_output: { name: "Résumé: Search & Ranking!" },
          }),
        }),
      ),
    ).toEqual({
      schema_version: 1,
      ok: true,
      candidate: "resume-search-ranking",
    });
  });

  test("returns distinct bounded failures without retry", async () => {
    const cases: Array<{
      runtime: MetadataInferenceRuntime;
      kind: string;
    }> = [
      {
        runtime: completedRuntime({ code: 7, stderr: "internal failure" }),
        kind: "process_failed",
      },
      {
        runtime: completedRuntime({ code: 1, stderr: "OAuth token expired" }),
        kind: "auth_failed",
      },
      {
        runtime: completedRuntime({ code: 1, stderr: "usage quota exhausted" }),
        kind: "quota_unavailable",
      },
      {
        runtime: completedRuntime({ stdoutOverflow: true }),
        kind: "output_too_large",
      },
      {
        runtime: completedRuntime({ stderrOverflow: true }),
        kind: "output_too_large",
      },
      {
        runtime: completedRuntime({ stdout: "not-json" }),
        kind: "malformed_output",
      },
      {
        runtime: completedRuntime({
          stdout: JSON.stringify({
            structured_output: { name: "valid", extra: true },
          }),
        }),
        kind: "malformed_output",
      },
      {
        runtime: completedRuntime({
          stdout: JSON.stringify({ structured_output: { name: "😀" } }),
        }),
        kind: "unusable_candidate",
      },
      {
        runtime: completedRuntime({
          stdout: JSON.stringify({
            is_error: true,
            result: "authentication required",
          }),
        }),
        kind: "auth_failed",
      },
    ];

    for (const { runtime, kind } of cases) {
      let spawns = 0;
      const originalSpawn = runtime.spawn;
      runtime.spawn = (argv, options) => {
        spawns += 1;
        return originalSpawn(argv, options);
      };
      const result = await captureWith(runtime);
      expect(result).toMatchObject({ ok: false, error: { kind } });
      expect(JSON.stringify(result).length).toBeLessThan(200);
      expect(spawns).toBe(1);
    }
  });

  test("an output overflow terminates a still-running process tree immediately", async () => {
    const kills: string[] = [];
    const runtime: MetadataInferenceRuntime = {
      spawn: () => ({
        exited: new Promise<number>(() => {}),
        captureStdout: async () => ({ text: "x", overflow: true }),
        captureStderr: async () =>
          new Promise<MetadataInferenceCapture>(() => {}),
        terminateTree: (signal) => kills.push(signal),
      }),
      setTimeout: () => "timer",
      clearTimeout: () => {},
      createCancellation: () => ({
        signal: new AbortController().signal,
        dispose() {},
      }),
    };

    expect(await captureWith(runtime)).toMatchObject({
      ok: false,
      error: { kind: "output_too_large" },
    });
    expect(kills).toEqual(["SIGKILL"]);
  });

  test("spawn and capture exceptions are typed and terminate only a spawned tree", async () => {
    const spawnFailure = completedRuntime();
    spawnFailure.spawn = () => {
      throw new Error("secret spawn diagnostic");
    };
    expect(await captureWith(spawnFailure)).toMatchObject({
      ok: false,
      error: { kind: "spawn_failed" },
    });

    const kills: string[] = [];
    const captureFailure = completedRuntime({
      onTerminate: (signal) => kills.push(signal),
    });
    const originalSpawn = captureFailure.spawn;
    captureFailure.spawn = (argv, options) => {
      const child = originalSpawn(argv, options);
      child.captureStdout = () => {
        throw new Error("secret capture diagnostic");
      };
      return child;
    };
    expect(await captureWith(captureFailure)).toMatchObject({
      ok: false,
      error: { kind: "capture_failed" },
    });
    expect(kills).toEqual(["SIGKILL"]);
  });

  test("the twenty-second deadline kills the exact process tree once", async () => {
    let timeoutMs = 0;
    let timeoutCallback: (() => void) | null = null;
    const cleared: unknown[] = [];
    const kills: string[] = [];
    let spawns = 0;
    const runtime: MetadataInferenceRuntime = {
      spawn: () => {
        spawns += 1;
        return {
          exited: new Promise<number>(() => {}),
          captureStdout: async () =>
            new Promise<MetadataInferenceCapture>(() => {}),
          captureStderr: async () =>
            new Promise<MetadataInferenceCapture>(() => {}),
          terminateTree: (signal) => kills.push(signal),
        };
      },
      setTimeout: (callback, ms) => {
        timeoutCallback = callback;
        timeoutMs = ms;
        return "timer";
      },
      clearTimeout: (handle) => cleared.push(handle),
      createCancellation: () => ({
        signal: new AbortController().signal,
        dispose() {},
      }),
    };

    const pending = captureWith(runtime);
    expect(timeoutMs).toBe(20_000);
    expect(timeoutCallback).not.toBeNull();
    (timeoutCallback as unknown as () => void)();
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: "timeout" },
    });
    expect(spawns).toBe(1);
    expect(kills).toEqual(["SIGKILL"]);
    expect(cleared).toEqual(["timer"]);
  });

  test("cancellation kills a started tree and a pre-cancelled request never spawns", async () => {
    const controller = new AbortController();
    const kills: string[] = [];
    let spawns = 0;
    const runtime: MetadataInferenceRuntime = {
      spawn: () => {
        spawns += 1;
        return {
          exited: new Promise<number>(() => {}),
          captureStdout: async () =>
            new Promise<MetadataInferenceCapture>(() => {}),
          captureStderr: async () =>
            new Promise<MetadataInferenceCapture>(() => {}),
          terminateTree: (signal) => kills.push(signal),
        };
      },
      setTimeout: () => "timer",
      clearTimeout: () => {},
      createCancellation: () => ({ signal: controller.signal, dispose() {} }),
    };

    const pending = captureWith(runtime, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: "cancelled" },
    });
    expect(spawns).toBe(1);
    expect(kills).toEqual(["SIGKILL"]);

    const preCancelled = new AbortController();
    preCancelled.abort();
    expect(await captureWith(runtime, preCancelled.signal)).toMatchObject({
      ok: false,
      error: { kind: "cancelled" },
    });
    expect(spawns).toBe(1);
  });
});
