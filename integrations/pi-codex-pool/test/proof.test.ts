import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactSurface,
  aliasRoleBinding,
  classifyLiveProof,
  collectLiveProof,
  type ExpectedProofBindings,
  LIVE_PROOF_CLAUSES,
  type LiveProofReport,
  scanProofArtifacts,
  writeLiveProofReport,
} from "../src/proof.ts";
import { poolConfigBinding } from "../src/state.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const CONFIG_BINDING =
  "0923a3886bf43b4addaee22e4a8bb1fc9ecd4699182074d78997e53fff334298";
const ALIAS_BINDING =
  "d5e41344d0a0be8fd5bd21dc9d276ce16d9822bf8a7a3a2928b71ed30e098b0f";
const EXPECTED: ExpectedProofBindings = {
  revision: REVISION,
  config_binding: CONFIG_BINDING,
  alias_binding: ALIAS_BINDING,
  now_ms: 1_000_000,
  max_age_ms: 60_000,
};

function passingReport(): LiveProofReport {
  return collectLiveProof(
    {
      revision: REVISION,
      config_binding: CONFIG_BINDING,
      alias_binding: ALIAS_BINDING,
      started_at_ms: 990_000,
      completed_at_ms: 999_000,
      interrupted: false,
      alias_roles: [
        { alias: "keeper-codex-a", role: "primary" },
        { alias: "keeper-codex-b", role: "alternate" },
      ],
      clauses: Object.fromEntries(
        LIVE_PROOF_CLAUSES.map((clause) => [clause, true]),
      ) as LiveProofReport["clauses"],
      routes: [
        {
          session_role: "root",
          attempts: 2,
          failure_class: "quota",
          substantive_output: false,
          restored: true,
        },
        {
          session_role: "child",
          attempts: 1,
          failure_class: "none",
          substantive_output: true,
          restored: true,
        },
      ],
      restoration: { required: true, completed: true },
      artifact_scan: {
        status: "clean",
        scanned_count: 7,
        scanned_bytes: 700,
        finding_classes: [],
      },
    },
    EXPECTED,
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("live proof bindings and classifier", () => {
  test("pins independently computed configuration and alias-role bindings", () => {
    expect(poolConfigBinding(["keeper-codex-a", "keeper-codex-b"])).toBe(
      CONFIG_BINDING,
    );
    expect(
      aliasRoleBinding([
        { alias: "keeper-codex-a", role: "primary" },
        { alias: "keeper-codex-b", role: "alternate" },
      ]),
    ).toBe(ALIAS_BINDING);
  });

  test("returns proven only for the complete fresh allowlisted report", () => {
    const report = passingReport();
    expect(report.verdict).toBe("proven");
    expect(classifyLiveProof(report, EXPECTED)).toEqual({
      verdict: "proven",
      reasons: [],
    });
  });

  test("makes every missing or false live clause non-passing", () => {
    for (const clause of LIVE_PROOF_CLAUSES) {
      const report = clone(passingReport());
      report.clauses[clause] = false;
      report.verdict = "incomplete";
      expect(classifyLiveProof(report, EXPECTED).verdict).toBe("incomplete");
    }
    const passing = passingReport();
    const missing = {
      ...passing,
      clauses: Object.fromEntries(
        Object.entries(passing.clauses).filter(
          ([clause]) => clause !== "single_retry",
        ),
      ),
    };
    expect(classifyLiveProof(missing, EXPECTED).verdict).toBe("failed");
  });

  test("rejects stale bindings, interrupted runs, incomplete routes, and required restoration", () => {
    const cases: LiveProofReport[] = [];

    const stale = clone(passingReport());
    stale.completed_at_ms = 900_000;
    stale.verdict = "incomplete";
    cases.push(stale);

    for (const field of [
      "revision",
      "config_binding",
      "alias_binding",
    ] as const) {
      const mismatched = clone(passingReport());
      mismatched[field] =
        field === "revision" ? "f".repeat(40) : "f".repeat(64);
      mismatched.verdict = "incomplete";
      cases.push(mismatched);
    }

    const interrupted = clone(passingReport());
    interrupted.interrupted = true;
    interrupted.verdict = "incomplete";
    cases.push(interrupted);

    const reboundRole = clone(passingReport());
    reboundRole.alias_roles = [
      { alias: "keeper-codex-b", role: "primary" },
      { alias: "keeper-codex-a", role: "alternate" },
    ];
    reboundRole.verdict = "incomplete";
    cases.push(reboundRole);

    const rootOnly = clone(passingReport());
    const rootRoute = rootOnly.routes[0];
    if (!rootRoute) throw new Error("missing-root-fixture");
    rootOnly.routes = [rootRoute, clone(rootRoute)];
    rootOnly.verdict = "incomplete";
    cases.push(rootOnly);

    const unrestoredRoute = clone(passingReport());
    const childRoute = unrestoredRoute.routes[1];
    if (!childRoute) throw new Error("missing-child-fixture");
    childRoute.restored = false;
    unrestoredRoute.verdict = "incomplete";
    cases.push(unrestoredRoute);

    const unrestoredRun = clone(passingReport());
    unrestoredRun.restoration.completed = false;
    unrestoredRun.verdict = "incomplete";
    cases.push(unrestoredRun);

    for (const report of cases) {
      expect(classifyLiveProof(report, EXPECTED).verdict).not.toBe("proven");
    }
  });

  test("fails unknown fields, malformed schema, scanner errors, sanitation findings, and a lying verdict", () => {
    const topUnknown = { ...passingReport(), raw_error: "hidden" };
    expect(classifyLiveProof(topUnknown, EXPECTED)).toEqual(
      expect.objectContaining({ verdict: "failed" }),
    );

    const nestedBase = passingReport();
    const nestedUnknown = {
      ...nestedBase,
      restoration: { ...nestedBase.restoration, force: true },
    };
    expect(classifyLiveProof(nestedUnknown, EXPECTED).verdict).toBe("failed");

    const malformedBase = passingReport();
    const malformed = {
      ...malformedBase,
      routes: [
        { ...malformedBase.routes[0], attempts: 3 },
        ...malformedBase.routes.slice(1),
      ],
    };
    expect(classifyLiveProof(malformed, EXPECTED).verdict).toBe("failed");

    const scannerError = clone(passingReport());
    scannerError.artifact_scan.status = "error";
    scannerError.verdict = "failed";
    expect(classifyLiveProof(scannerError, EXPECTED).verdict).toBe("failed");

    const finding = clone(passingReport());
    finding.artifact_scan.status = "findings";
    finding.artifact_scan.finding_classes = ["bearer-token"];
    finding.verdict = "failed";
    expect(classifyLiveProof(finding, EXPECTED).verdict).toBe("failed");

    const lying = clone(passingReport());
    lying.verdict = "incomplete";
    expect(classifyLiveProof(lying, EXPECTED)).toEqual(
      expect.objectContaining({
        verdict: "failed",
        reasons: ["declared-verdict-mismatch"],
      }),
    );
  });
});

describe("proof artifact sanitation and persistence", () => {
  test("scans every persisted and rendered boundary for credentials, identities, headers, and PII", () => {
    const result = scanProofArtifacts(
      [
        { surface: "observer", content: "Bearer abcdefghijklmnop" },
        {
          surface: "state",
          content: '{"type":"oauth","access_token":"private"}',
        },
        {
          surface: "proof",
          content: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2NvdW50In0.c2lnbmF0dXJl",
        },
        { surface: "log", content: "Authorization: Bearer qrstuvwxyz123456" },
        {
          surface: "error",
          content: '{"headers":{"ChatGPT-Account-Id":"private-account"}}',
        },
        { surface: "session", content: "owner@example.test" },
        { surface: "tool", content: "token-derived-private-identity" },
      ],
      ["token-derived-private-identity"],
    );
    expect(result).toEqual({
      status: "findings",
      scanned_count: 7,
      scanned_bytes: result.scanned_bytes,
      finding_classes: [
        "account-header",
        "account-pii",
        "authorization-header",
        "bearer-token",
        "forbidden-value",
        "jwt",
        "provider-headers",
        "raw-auth-object",
        "token-field",
      ],
    });
    expect(result.scanned_bytes).toBeGreaterThan(0);
  });

  test("returns scanner error rather than passing unknown surfaces or unbounded input", () => {
    expect(
      scanProofArtifacts([
        {
          surface: "unknown" as unknown as ArtifactSurface,
          content: "apparently clean",
        },
      ]),
    ).toEqual({
      status: "error",
      scanned_count: 0,
      scanned_bytes: 0,
      finding_classes: [],
    });
    expect(
      scanProofArtifacts(
        Array.from({ length: 65 }, () => ({
          surface: "log" as const,
          content: "clean",
        })),
      ).status,
    ).toBe("error");
  });

  test("accepts a bounded clean set without copying artifact content into the result", () => {
    const result = scanProofArtifacts([
      { surface: "observer", content: '{"alias":"keeper-codex-a"}' },
      { surface: "state", content: '{"used_percent":10}' },
      { surface: "proof", content: '{"verdict":"proven"}' },
      { surface: "log", content: "pool-unavailable" },
      { surface: "error", content: "pool-rate-failure" },
      { surface: "session", content: "request-aborted" },
      { surface: "tool", content: "capacity unavailable" },
    ]);
    expect(result.status).toBe("clean");
    expect(result.finding_classes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("capacity unavailable");
  });

  test("persists a private atomic allowlisted report", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-pool-proof-"));
    const path = join(dir, "proof.json");
    const report = passingReport();
    writeLiveProofReport(path, report);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(report);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort()).toEqual(
      [
        "alias_binding",
        "alias_roles",
        "artifact_scan",
        "clauses",
        "completed_at_ms",
        "config_binding",
        "interrupted",
        "restoration",
        "revision",
        "routes",
        "schema_version",
        "started_at_ms",
        "verdict",
      ].sort(),
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
