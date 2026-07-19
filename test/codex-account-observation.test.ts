import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_MAX_OBSERVER_OUTPUT_BYTES,
  CODEX_OBSERVATION_SCHEMA_VERSION,
} from "../src/account-routing-config";
import {
  CODEX_PROVIDER,
  isCodexObservationFresh,
  parseCodexObserverOutcome,
  readCodexObservationSidecar,
  validateCodexObservation,
  writeCodexObservationSidecar,
} from "../src/codex-account-observation";

const NOW = Date.parse("2026-07-18T12:00:00Z");
const BINDING = "a".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function envelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema_version: 1,
    config_binding: BINDING,
    observed_at_ms: NOW,
    aliases: [
      {
        alias: "keeper-codex-a",
        usage: {
          schema_version: 1,
          alias: "keeper-codex-a",
          status: "healthy",
          observed_at_ms: NOW,
          expires_at_ms: NOW + 60_000,
          windows: [
            {
              role: "primary",
              used_percent: 12.3,
              reset_at_ms: NOW + 30_000,
              private_plan: "enterprise-secret",
            },
          ],
          owner_email: "owner@example.test",
        },
        raw_token: "Bearer private-token",
      },
    ],
    truncated: false,
    raw_headers: { Authorization: "Bearer private-token" },
    ...overrides,
  };
}

function parse(value: unknown = envelope()) {
  return parseCodexObserverOutcome({
    code: 0,
    stdout: JSON.stringify(value),
  });
}

describe("Codex observer envelope", () => {
  test("normalizes provider-qualified bounded capacity without retaining PII", () => {
    const observation = parse();
    expect(observation).toEqual({
      schema_version: CODEX_OBSERVATION_SCHEMA_VERSION,
      provider: CODEX_PROVIDER,
      config_binding: BINDING,
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
              used_percent: 12.3,
              reset_at_ms: NOW + 30_000,
            },
          ],
        },
      ],
    });
    const rendered = JSON.stringify(observation);
    for (const forbidden of [
      "owner@example.test",
      "enterprise-secret",
      "private-token",
      "Authorization",
      "raw_headers",
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  test("rejects failed, malformed, unsupported, truncated, duplicate, and oversized input", () => {
    expect(
      parseCodexObserverOutcome({
        code: 1,
        stdout: JSON.stringify(envelope()),
      }),
    ).toBeNull();
    expect(parseCodexObserverOutcome({ code: 0, stdout: "{" })).toBeNull();
    expect(parse(envelope({ schema_version: 2 }))).toBeNull();
    expect(parse(envelope({ truncated: true }))).toBeNull();
    const duplicate = envelope() as Record<string, unknown>;
    duplicate.aliases = [
      ...(duplicate.aliases as unknown[]),
      ...(duplicate.aliases as unknown[]),
    ];
    expect(parse(duplicate)).toBeNull();
    expect(
      parseCodexObserverOutcome({
        code: 0,
        stdout: "x".repeat(CODEX_MAX_OBSERVER_OUTPUT_BYTES + 1),
      }),
    ).toBeNull();
  });

  test("accepts only fixed status classes, opaque aliases, and bounded windows", () => {
    const invalidAlias = envelope() as Record<string, unknown>;
    invalidAlias.aliases = [
      {
        alias: "owner@example.test",
        usage: {
          schema_version: 1,
          alias: "owner@example.test",
          status: "healthy",
          observed_at_ms: NOW,
          expires_at_ms: NOW + 1,
          windows: [{ role: "primary", used_percent: 10, reset_at_ms: null }],
        },
      },
    ];
    expect(parse(invalidAlias)).toBeNull();

    const unavailable = envelope() as Record<string, unknown>;
    unavailable.aliases = [
      {
        alias: "keeper-codex-a",
        usage: {
          schema_version: 1,
          alias: "keeper-codex-a",
          status: "unavailable",
          failure_class: "auth",
          observed_at_ms: NOW,
          expires_at_ms: NOW,
          windows: [],
        },
      },
    ];
    expect(parse(unavailable)?.aliases[0]?.failure_class).toBe("auth");

    const raw = unavailable.aliases as Array<Record<string, unknown>>;
    (raw[0]?.usage as Record<string, unknown>).failure_class =
      "private provider error";
    expect(parse(unavailable)).toBeNull();
  });
});

describe("Codex capacity sidecar", () => {
  test("atomically replaces a private sidecar and strictly revalidates reads", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-observation-"));
    roots.push(root);
    const path = join(root, "observation.json");
    const first = parse();
    expect(first).not.toBeNull();
    if (first === null) throw new Error("fixture did not parse");
    writeCodexObservationSidecar(path, first);
    const second = {
      ...first,
      observed_at_ms: NOW + 1,
      aliases: first.aliases.map((alias) => ({
        ...alias,
        observed_at_ms: NOW + 1,
      })),
    };
    writeCodexObservationSidecar(path, second);
    expect(readCodexObservationSidecar(path)).toEqual(second);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["observation.json"]);
    expect(
      validateCodexObservation({
        ...second,
        schema_version: CODEX_OBSERVATION_SCHEMA_VERSION + 1,
      }),
    ).toBeNull();
    expect(
      validateCodexObservation({ ...second, provider: "claude" }),
    ).toBeNull();

    chmodSync(path, 0o644);
    writeCodexObservationSidecar(path, second);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("freshness rejects future and expired observations", () => {
    const observation = parse();
    if (observation === null) throw new Error("fixture did not parse");
    expect(isCodexObservationFresh(observation, NOW, 1)).toBe(true);
    expect(isCodexObservationFresh(observation, NOW - 1, 60_000)).toBe(false);
    expect(isCodexObservationFresh(observation, NOW + 60_001, 60_000)).toBe(
      false,
    );
  });
});
