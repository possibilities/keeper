import { describe, expect, test } from "bun:test";
import {
  ensurePiPromptArtifacts,
  PiPromptArtifactsError,
  type PiPromptArtifactsSpawnResult,
} from "../src/agent/pi-prompt-artifacts";

const FINGERPRINT = "a".repeat(64);
const EXECUTABLE_PATH = "/opt/keeper/bin/bun";
const KEEPER_CLI_PATH = "/checkout/keeper/cli/keeper.ts";
const COMPILER_PATHS = {
  executablePath: EXECUTABLE_PATH,
  keeperCliPath: KEEPER_CLI_PATH,
} as const;

function successfulResult(
  overrides: Partial<PiPromptArtifactsSpawnResult> = {},
): PiPromptArtifactsSpawnResult {
  return {
    status: 0,
    stdout: JSON.stringify({
      ok: true,
      target: "pi",
      request: { kind: "bundle", name: "plan:static" },
      outcome: "hit",
      fingerprint: FINGERPRINT,
    }),
    stderr: "",
    ...overrides,
  };
}

describe("ensurePiPromptArtifacts", () => {
  test("runs the absolute compiler prefix with the unmodified Pi environment", () => {
    const env = {
      PI_CODING_AGENT_DIR: "/tmp/pi-override",
      PATH: "/path-spoof/keeper-only",
    };
    const actionLog: string[] = [];
    let receivedEnv: NodeJS.ProcessEnv | undefined;

    ensurePiPromptArtifacts(actionLog, {
      ...COMPILER_PATHS,
      env,
      spawnSyncFn: (command, argv, options) => {
        expect(command).toBe(EXECUTABLE_PATH);
        expect(argv).toEqual([
          KEEPER_CLI_PATH,
          "prompt",
          "compile",
          "--bundle",
          "plan:static",
          "--target",
          "pi",
        ]);
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.maxBuffer).toBeGreaterThan(0);
        receivedEnv = options.env;
        return successfulResult();
      },
    });

    expect(receivedEnv).toBe(env);
    expect(actionLog).toEqual([
      `Pi prompt artifacts hit (fingerprint: ${FINGERPRINT})`,
    ]);
  });

  test.each([
    ["nonzero", successfulResult({ status: 1, stderr: "compiler failed" })],
    ["malformed", successfulResult({ stdout: "not-json" })],
    [
      "reported failure",
      successfulResult({
        stdout: JSON.stringify({
          ok: false,
          target: "pi",
          request: { kind: "bundle", name: "plan:static" },
        }),
      }),
    ],
  ])("throws an actionable typed failure for $0 output", (_name, result) => {
    let failure: unknown;
    try {
      ensurePiPromptArtifacts([], {
        ...COMPILER_PATHS,
        spawnSyncFn: () => result,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PiPromptArtifactsError);
    expect((failure as Error).message).toContain(
      "keeper prompt compile --bundle plan:static --target pi",
    );
  });

  test.each([
    ["executable", { executablePath: "bun", keeperCliPath: KEEPER_CLI_PATH }],
    [
      "CLI",
      { executablePath: EXECUTABLE_PATH, keeperCliPath: "cli/keeper.ts" },
    ],
  ])("rejects a relative $0 path before spawn", (_name, paths) => {
    let spawnCalls = 0;
    expect(() =>
      ensurePiPromptArtifacts([], {
        ...paths,
        spawnSyncFn: () => {
          spawnCalls += 1;
          return successfulResult();
        },
      }),
    ).toThrow(/requires an absolute/);
    expect(spawnCalls).toBe(0);
  });
});
