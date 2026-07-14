import { describe, expect, test } from "bun:test";
import {
  ensurePiPromptArtifacts,
  PiPromptArtifactsError,
  type PiPromptArtifactsSpawnResult,
} from "../src/agent/pi-prompt-artifacts";

const FINGERPRINT = "a".repeat(64);

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
  test("runs the fixed compiler command with the unmodified Pi environment", () => {
    const env = { PI_CODING_AGENT_DIR: "/tmp/pi-override", PATH: "/bin" };
    const actionLog: string[] = [];
    let receivedEnv: NodeJS.ProcessEnv | undefined;

    ensurePiPromptArtifacts(actionLog, {
      env,
      spawnSyncFn: (command, argv, options) => {
        expect(command).toBe("keeper");
        expect(argv).toEqual([
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
      ensurePiPromptArtifacts([], { spawnSyncFn: () => result });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PiPromptArtifactsError);
    expect((failure as Error).message).toContain(
      "keeper prompt compile --bundle plan:static --target pi",
    );
  });
});
