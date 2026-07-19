import { describe, expect, test } from "bun:test";
import type {
  LiveProofReport,
  ProofTranscriptEntry,
} from "../integrations/pi-codex-pool/src/proof";
import {
  activateCodexPool,
  armCodexPoolProofWindow,
  type CodexPoolActivationDeps,
  type CodexPoolActivationState,
  type CodexPoolActivationStore,
  captureCodexPoolProof,
  codexPoolProofWindowActive,
  codexPoolStatus,
  effectiveCodexPoolActivation,
  recoverCodexPool,
  rollbackCodexPool,
  verdictCodexPoolProof,
  verifyCodexPool,
} from "../src/codex-pool-activation";

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const CONFIG_BINDING =
  "0923a3886bf43b4addaee22e4a8bb1fc9ecd4699182074d78997e53fff334298";
const ALIAS_BINDING =
  "d5e41344d0a0be8fd5bd21dc9d276ce16d9822bf8a7a3a2928b71ed30e098b0f";
const NOW = 1_000_000;
const BINDINGS = {
  revision: REVISION,
  aliases: ["keeper-codex-a", "keeper-codex-b"],
  alias_roles: [
    { alias: "keeper-codex-a", role: "primary" as const },
    { alias: "keeper-codex-b", role: "alternate" as const },
  ],
  config_binding: CONFIG_BINDING,
  alias_binding: ALIAS_BINDING,
};
const PASSING_TRANSCRIPT: ProofTranscriptEntry[] = [
  {
    sequence: 1,
    clause: "independent_credentials",
    evidence: ["primary-credential-rotated", "alternate-credential-rotated"],
  },
  {
    sequence: 2,
    clause: "sanitized_observer",
    evidence: ["sanitized-observer-rendered"],
  },
  {
    sequence: 3,
    clause: "deterministic_routing",
    evidence: ["routes-recorded", "attempt-aliases-recorded"],
  },
  {
    sequence: 4,
    clause: "session_stickiness",
    evidence: ["completed-session-reused-alias"],
  },
  {
    sequence: 5,
    clause: "pressure_cooldown",
    evidence: [
      "concurrent-routes-observed",
      "classified-retry-observed",
      "cooldown-observed",
    ],
  },
  {
    sequence: 6,
    clause: "single_retry",
    evidence: ["two-attempt-route-observed", "all-routes-at-most-two-attempts"],
  },
  {
    sequence: 7,
    clause: "substantive_cutoff",
    evidence: ["substantive-output-fault-not-retried"],
  },
  {
    sequence: 8,
    clause: "abort_preserved",
    evidence: ["deliberate-child-abort-not-retried"],
  },
  {
    sequence: 9,
    clause: "request_contract",
    evidence: ["all-attempts-preserved-request-contract"],
  },
  {
    sequence: 10,
    clause: "native_fallback",
    evidence: ["native-fallback-completed"],
  },
  {
    sequence: 11,
    clause: "compat_root_delegate",
    evidence: ["compat-root-delegate-used"],
  },
  {
    sequence: 12,
    clause: "root_child_sessions",
    evidence: ["root-route-observed", "child-route-observed"],
  },
  {
    sequence: 13,
    clause: "transport_isolation",
    evidence: ["root-child-distinct-aliases"],
  },
];

function passingReport(): LiveProofReport {
  return {
    schema_version: 1,
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
    transcript: clone(PASSING_TRANSCRIPT),
    clauses: {
      independent_credentials: true,
      sanitized_observer: true,
      deterministic_routing: true,
      session_stickiness: true,
      pressure_cooldown: true,
      single_retry: true,
      substantive_cutoff: true,
      abort_preserved: true,
      request_contract: true,
      native_fallback: true,
      compat_root_delegate: true,
      root_child_sessions: true,
      transport_isolation: true,
    },
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
    verdict: "proven",
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class MemoryStore implements CodexPoolActivationStore {
  activation: unknown | undefined;
  report: unknown | undefined;
  sources = new Map<string, unknown>();
  transaction = false;
  locked = false;
  failNativeWrite = false;
  writes: CodexPoolActivationState[] = [];

  readActivation(): unknown | undefined {
    return this.activation;
  }

  writeActivation(state: CodexPoolActivationState): void {
    if (state.mode === "native" && this.failNativeWrite) {
      throw new Error("native-write-failed");
    }
    this.activation = clone(state);
    this.writes.push(clone(state));
  }

  readReport(source?: string): unknown | undefined {
    return source === undefined ? this.report : this.sources.get(source);
  }

  writeReport(report: LiveProofReport): void {
    this.report = clone(report);
  }

  transactionExists(): boolean {
    return this.transaction;
  }

  beginTransaction(): void {
    this.transaction = true;
  }

  endTransaction(): void {
    this.transaction = false;
  }

  tryLock(): { release(): void } | null {
    if (this.locked) return null;
    this.locked = true;
    return {
      release: () => {
        this.locked = false;
      },
    };
  }
}

function deps(
  store: MemoryStore,
  overrides: Partial<CodexPoolActivationDeps> = {},
): CodexPoolActivationDeps {
  return {
    store,
    bindings: BINDINGS,
    nowMs: () => NOW,
    reload: () => true,
    verify: () => true,
    ...overrides,
  };
}

describe("Codex pool launch-scoped proof window", () => {
  test("arms one exact bounded launcher-child window", () => {
    const state = armCodexPoolProofWindow(1_000_000, 4242);
    expect(state).toEqual({
      schema_version: 1,
      armed_at_ms: 1_000_000,
      expires_at_ms: 1_900_000,
      launcher_pid: 4242,
      seams: {
        forced_refresh: true,
        fault_injection: true,
      },
    });
    const encoded = JSON.stringify(state);
    expect(codexPoolProofWindowActive(encoded, 1_000_000, 4242)).toBe(true);
    expect(codexPoolProofWindowActive(encoded, 1_899_999, 4242)).toBe(true);
    expect(codexPoolProofWindowActive(encoded, 1_900_000, 4242)).toBe(false);
  });

  test("rejects absent, restarted, malformed, and extended windows", () => {
    const exact = {
      schema_version: 1,
      armed_at_ms: 1_000_000,
      expires_at_ms: 1_900_000,
      launcher_pid: 4242,
    };
    expect(codexPoolProofWindowActive(undefined, 1_000_001, 4242)).toBe(false);
    expect(codexPoolProofWindowActive(exact, 1_000_001, 4343)).toBe(false);
    expect(
      codexPoolProofWindowActive(
        { ...exact, expires_at_ms: 1_900_001 },
        1_000_001,
        4242,
      ),
    ).toBe(false);
    expect(
      codexPoolProofWindowActive(
        { ...exact, unexpected: true },
        1_000_001,
        4242,
      ),
    ).toBe(false);
    expect(
      codexPoolProofWindowActive(JSON.stringify(exact), 999_999, 4242),
    ).toBe(false);
  });
});

describe("Codex pool proof-gated activation", () => {
  test("activates only a fresh exact passing report and publishes once", () => {
    const store = new MemoryStore();
    store.report = passingReport();
    const outcome = activateCodexPool(deps(store));
    expect(outcome).toEqual({
      schema_version: 1,
      ok: true,
      operation: "activate",
      state: "active",
      problem_code: null,
      proof: { verdict: "proven", reasons: [] },
    });
    expect(store.transaction).toBe(false);
    expect(store.writes.map((state) => state.mode)).toEqual(["active"]);
    expect(effectiveCodexPoolActivation(store, BINDINGS)).toMatchObject({
      mode: "active",
      problem_code: null,
    });
    expect(verifyCodexPool(deps(store)).ok).toBe(true);
  });

  test("refuses stale, incomplete, failed, unknown, and unsanitized reports", () => {
    const cases: unknown[] = [];
    const stale = clone(passingReport());
    stale.completed_at_ms = 1;
    stale.verdict = "incomplete";
    cases.push(stale);
    const incomplete = clone(passingReport());
    incomplete.clauses.single_retry = false;
    incomplete.verdict = "incomplete";
    cases.push(incomplete);
    const failed = clone(passingReport());
    failed.artifact_scan.status = "findings";
    failed.artifact_scan.finding_classes = ["bearer-token"];
    failed.verdict = "failed";
    cases.push(failed);
    cases.push({ ...passingReport(), raw_provider_error: "Bearer hidden" });
    const interrupted = clone(passingReport());
    interrupted.interrupted = true;
    interrupted.verdict = "incomplete";
    cases.push(interrupted);

    for (const report of cases) {
      const store = new MemoryStore();
      store.report = report;
      const outcome = activateCodexPool(deps(store));
      expect(outcome.ok).toBe(false);
      expect(outcome.state).toBe("native");
      expect(store.writes).toEqual([]);
      expect(store.transaction).toBe(false);
    }
  });

  test("serializes concurrent activation and leaves a transaction native", () => {
    const store = new MemoryStore();
    store.report = passingReport();
    store.locked = true;
    expect(activateCodexPool(deps(store)).problem_code).toBe("activation-busy");
    store.locked = false;
    store.transaction = true;
    expect(activateCodexPool(deps(store))).toMatchObject({
      ok: false,
      state: "native",
      problem_code: "recovery-required",
    });
    store.activation = {
      schema_version: 1,
      mode: "active",
      revision: REVISION,
      config_binding: CONFIG_BINDING,
      alias_binding: ALIAS_BINDING,
      aliases: ["keeper-codex-a", "keeper-codex-b"],
      updated_at_ms: NOW,
    };
    expect(effectiveCodexPoolActivation(store, BINDINGS)).toMatchObject({
      mode: "native",
      problem_code: "recovery-required",
    });
  });

  test("reload and immediate verification failures roll back to native", () => {
    for (const override of [{ reload: () => false }, { verify: () => false }]) {
      const store = new MemoryStore();
      store.report = passingReport();
      const outcome = activateCodexPool(deps(store, override));
      expect(outcome).toMatchObject({
        ok: false,
        state: "native",
        problem_code: "rollback-complete",
      });
      expect((store.activation as CodexPoolActivationState).mode).toBe(
        "native",
      );
      expect(store.transaction).toBe(false);
    }
  });

  test("a failed rollback leaves the fail-closed recovery marker authoritative", () => {
    const store = new MemoryStore();
    store.report = passingReport();
    store.failNativeWrite = true;
    const outcome = activateCodexPool(deps(store, { reload: () => false }));
    expect(outcome).toMatchObject({
      ok: false,
      state: "recovery-required",
      problem_code: "recovery-required",
    });
    expect(store.transaction).toBe(true);
    expect(effectiveCodexPoolActivation(store, BINDINGS).mode).toBe("native");
    store.failNativeWrite = false;
    expect(recoverCodexPool(deps(store))).toMatchObject({
      ok: true,
      state: "native",
      problem_code: null,
    });
    expect(store.transaction).toBe(false);
  });
});

describe("Codex pool workflow operations", () => {
  test("capture and verdict persist only a strict allowlisted report", () => {
    const store = new MemoryStore();
    store.sources.set("passing", passingReport());
    expect(captureCodexPoolProof(deps(store), "passing")).toMatchObject({
      ok: true,
      problem_code: null,
      proof: { verdict: "proven", reasons: [] },
    });
    expect(verdictCodexPoolProof(deps(store))).toMatchObject({
      ok: true,
      proof: { verdict: "proven", reasons: [] },
    });

    store.sources.set("unsafe", {
      ...passingReport(),
      Authorization: "Bearer hidden-secret",
    });
    expect(captureCodexPoolProof(deps(store), "unsafe")).toMatchObject({
      ok: false,
      problem_code: "proof-invalid",
    });
    expect(JSON.stringify(store.report)).not.toContain("hidden-secret");
  });

  test("status is activation-pending without state and rollback is idempotent", () => {
    const store = new MemoryStore();
    expect(codexPoolStatus(deps(store))).toMatchObject({
      ok: false,
      state: "native",
      problem_code: "activation-pending",
    });
    expect(rollbackCodexPool(deps(store))).toMatchObject({
      ok: true,
      state: "native",
      problem_code: null,
    });
    expect(rollbackCodexPool(deps(store))).toMatchObject({
      ok: true,
      state: "native",
      problem_code: null,
    });
  });

  test("status degrades an active file when read-only runtime verification fails", () => {
    const store = new MemoryStore();
    store.activation = {
      schema_version: 1,
      mode: "active",
      revision: REVISION,
      config_binding: CONFIG_BINDING,
      alias_binding: ALIAS_BINDING,
      aliases: ["keeper-codex-a", "keeper-codex-b"],
      updated_at_ms: NOW,
    };
    expect(codexPoolStatus(deps(store, { verify: () => false }))).toMatchObject(
      {
        ok: false,
        state: "native",
        problem_code: "verification-failed",
      },
    );
  });

  test("changed revision, configuration, or aliases cannot retain active status", () => {
    const store = new MemoryStore();
    store.activation = {
      schema_version: 1,
      mode: "active",
      revision: REVISION,
      config_binding: CONFIG_BINDING,
      alias_binding: ALIAS_BINDING,
      aliases: ["keeper-codex-a", "keeper-codex-b"],
      updated_at_ms: NOW,
    };
    for (const changed of [
      { ...BINDINGS, revision: "f".repeat(40) },
      { ...BINDINGS, config_binding: "f".repeat(64) },
      { ...BINDINGS, aliases: ["keeper-codex-a"] },
    ]) {
      expect(effectiveCodexPoolActivation(store, changed)).toMatchObject({
        mode: "native",
        problem_code: "activation-binding-stale",
      });
    }
  });
});
