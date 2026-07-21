/**
 * Proves the provisioned `keeper-pi-codex-observe` executable's module entry
 * produces output the routing state dir accepts, end to end: observePool ->
 * renderObserverEnvelope (the executable's real stdout path) -> parse ->
 * publish into a per-test state dir -> read back. No subprocess is spawned;
 * this drives the same module CodexAccountObserver's spawn would invoke.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialVault,
  MemoryCredentialStorage,
} from "../integrations/pi-codex-pool/src/auth.ts";
import {
  observePool,
  renderObserverEnvelope,
} from "../integrations/pi-codex-pool/src/observer.ts";
import { PoolRouteState } from "../integrations/pi-codex-pool/src/state.ts";
import {
  CODEX_OBSERVATION_SCHEMA_VERSION,
  codexObservationSidecarPath,
} from "../src/account-routing-config";
import {
  parseCodexObserverEnvelope,
  readCodexObservationSidecar,
} from "../src/codex-account-observation";
import { publishCodexObservation } from "../src/codex-account-observation-refresh";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
} from "../src/codex-quota-scope";

function jwt(accountId: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.sig`;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("observer module output lands in the routing state dir", () => {
  test("a healthy alias envelope publishes and reads back with the expected shape", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "codex-observer-landing-"));
    roots.push(stateDir);
    const aliases = ["keeper-codex-a"];
    const vault = new CredentialVault(
      new MemoryCredentialStorage({
        "keeper-codex-a": {
          type: "oauth",
          access: jwt("account-a"),
          refresh: "refresh-a",
          expires: 1_000_000,
        },
      }),
      async (credential) => credential,
      () => 100,
    );
    const envelope = await observePool({
      aliases,
      vault,
      routes: new PoolRouteState(aliases, null, () => 100),
      now: () => 100,
      async requestUsage() {
        return {
          rate_limit: {
            allowed: false,
            limit_reached: true,
            primary_window: {
              used_percent: 100,
              reset_at: 200,
              limit_window_seconds: 604_800,
            },
          },
          additional_rate_limits: [
            {
              limit_name: "GPT-5.3-Codex-Spark",
              rate_limit: {
                primary_window: {
                  used_percent: 0,
                  reset_at: 250,
                  limit_window_seconds: 604_800,
                },
              },
            },
          ],
        };
      },
    });

    // What the linked executable actually writes to stdout.
    const stdout = renderObserverEnvelope(envelope);

    const observation = parseCodexObserverEnvelope(JSON.parse(stdout));
    expect(observation).not.toBeNull();
    if (observation === null) throw new Error("unreachable");

    publishCodexObservation(stateDir, observation);

    const landed = readCodexObservationSidecar(
      codexObservationSidecarPath(stateDir),
    );
    expect(landed).toMatchObject({
      schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
      provider: "openai-codex",
      config_binding: envelope.config_binding,
      aliases: [
        {
          alias: "keeper-codex-a",
          status: "exhausted",
          windows: [
            {
              role: "primary",
              quota_scope: CODEX_GENERIC_QUOTA_SCOPE,
              key: "week",
              label: "weekly",
              window_seconds: 604_800,
              used_percent: 100,
              exhausted: true,
              reset_at_ms: 200_000,
            },
            {
              role: "additional",
              quota_scope: CODEX_SPARK_QUOTA_SCOPE,
              label: "GPT-5.3-Codex-Spark",
              window_seconds: 604_800,
              used_percent: 0,
              exhausted: false,
              reset_at_ms: 250_000,
            },
          ],
        },
      ],
    });
  });
});
