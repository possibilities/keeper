import { describe, expect, test } from "bun:test";
import {
  classifyRestartDeathEvidence,
  classifyRestartEvidence,
  RESTART_OBSERVABILITY_EVIDENCE,
  type RestartHealthObservation,
  type RestartIdentity,
  type RestartLedgerBootRecord,
  type RestartObservationInput,
} from "../src/restart-observation";

const OLD: RestartIdentity = {
  boot_id: "boot-old",
  pid: 410,
  start_time: "darwin:old-start",
};
const NEXT: RestartIdentity = {
  boot_id: "boot-next",
  pid: 520,
  start_time: "darwin:next-start",
};
const REPLACEMENT: RestartIdentity = {
  boot_id: "boot-replacement",
  pid: 630,
  start_time: "darwin:replacement-start",
};

function ledgerBoot(
  identity: RestartIdentity,
  ts = 1_700_000_000_000,
): RestartLedgerBootRecord {
  return { ...identity, ts };
}

function health(
  identity: RestartIdentity,
  observedAtMs: number,
  overrides: Partial<RestartHealthObservation> = {},
): RestartHealthObservation {
  return {
    identity,
    observed_at_ms: observedAtMs,
    healthy: true,
    catching_up: false,
    ...overrides,
  };
}

function exactInput(
  overrides: Partial<RestartObservationInput> = {},
): RestartObservationInput {
  return {
    pre_restart: {
      served_identity: OLD,
      ledger_marker: ledgerBoot(OLD, 1_699_999_000_000),
    },
    command: { issued: true, accepted: true },
    old_process: "dead",
    ledger: {
      status: "readable",
      boots: [ledgerBoot(OLD), ledgerBoot(NEXT, 1_700_000_001_000)],
    },
    health: [health(NEXT, 1_000), health(NEXT, 7_000), health(NEXT, 13_000)],
    monotonic: {
      started_at_ms: 0,
      now_ms: 13_000,
      deadline_at_ms: 20_000,
      stabilization_ms: 12_000,
    },
    required_healthy_observations: 3,
    ...overrides,
  };
}

function reasonCodes(input: RestartObservationInput): string[] {
  return classifyRestartEvidence(input).reasons.map((reason) => reason.code);
}

describe("restart evidence identity", () => {
  test("a newly readable old row after a null marker snapshot is not a new boot", () => {
    const verdict = classifyRestartEvidence(
      exactInput({
        pre_restart: { served_identity: OLD, ledger_marker: null },
        ledger: { status: "readable", boots: [ledgerBoot(OLD)] },
        health: [health(OLD, 1_000), health(OLD, 7_000), health(OLD, 13_000)],
      }),
    );

    expect(verdict.verdict).toBe("incomplete");
    expect(verdict.replacement.status).toBe("not-distinct");
    expect(verdict.durable_boot.status).toBe("old");
    expect(verdict.reasons).toContainEqual({
      code: "durable-boot-is-old-marker",
      phase: "durable-boot",
    });
  });

  test("a reused boot id cannot present a changed process tuple as a replacement", () => {
    const corrupt: RestartIdentity = {
      boot_id: OLD.boot_id,
      pid: NEXT.pid,
      start_time: NEXT.start_time,
    };
    const verdict = classifyRestartEvidence(
      exactInput({
        old_process: "dead",
        ledger: {
          status: "readable",
          boots: [ledgerBoot(OLD), ledgerBoot(corrupt)],
        },
        health: [
          health(corrupt, 1_000),
          health(corrupt, 7_000),
          health(corrupt, 13_000),
        ],
      }),
    );

    expect(verdict.replacement.status).toBe("not-distinct");
    expect(verdict.durable_boot.status).toBe("old");
    expect(verdict.verdict).toBe("incomplete");
  });

  test("a missing or unreadable pre-restart marker cannot bless a later distinct row", () => {
    const missing = classifyRestartEvidence(
      exactInput({
        pre_restart: {
          served_identity: OLD,
          ledger_marker: null,
          ledger_status: "missing",
        },
      }),
    );
    const unreadable = classifyRestartEvidence(
      exactInput({
        pre_restart: {
          served_identity: OLD,
          ledger_marker: null,
          ledger_status: "unreadable",
        },
      }),
    );

    expect(missing.verdict).toBe("incomplete");
    expect(unreadable.verdict).toBe("incomplete");
    expect(missing.reasons).toContainEqual({
      code: "pre-restart-ledger-missing",
      phase: "durable-boot",
    });
    expect(unreadable.reasons).toContainEqual({
      code: "pre-restart-ledger-unreadable",
      phase: "durable-boot",
    });
  });

  test("a recycled PID cannot join a new served start time to the old durable row", () => {
    const recycled: RestartIdentity = {
      boot_id: "boot-next",
      pid: OLD.pid,
      start_time: "darwin:recycled-start",
    };
    const verdict = classifyRestartEvidence(
      exactInput({
        old_process: "recycled",
        ledger: {
          status: "readable",
          boots: [
            ledgerBoot(OLD),
            ledgerBoot({ ...recycled, start_time: OLD.start_time }),
          ],
        },
        health: [
          health(recycled, 1_000),
          health(recycled, 7_000),
          health(recycled, 13_000),
        ],
      }),
    );

    expect(verdict.replacement).toEqual({
      status: "replaced",
      old_process: "recycled",
    });
    expect(verdict.durable_boot.status).toBe("mismatched");
    expect(verdict.verdict).toBe("incomplete");
  });

  test("a different healthy row is insufficient while the old identity is alive", () => {
    const verdict = classifyRestartEvidence(
      exactInput({ old_process: "alive" }),
    );

    expect(verdict.replacement.status).toBe("old-alive");
    expect(verdict.durable_boot.status).toBe("matched");
    expect(verdict.stabilization.status).toBe("complete");
    expect(verdict.verdict).toBe("incomplete");
    expect(reasonCodes(exactInput({ old_process: "alive" }))).toContain(
      "old-process-still-alive",
    );
  });

  test("a boot row without served health proves durability but no candidate", () => {
    const verdict = classifyRestartEvidence(exactInput({ health: [] }));

    expect(verdict.durable_boot.status).toBe("unmatched");
    expect(verdict.health.status).toBe("unobserved");
    expect(verdict.drain.status).toBe("unobserved");
    expect(verdict.stabilization.status).toBe("not-started");
    expect(reasonCodes(exactInput({ health: [] }))).toContain(
      "served-health-missing",
    );
  });

  test("served health without its durable row does not prove a boot", () => {
    const verdict = classifyRestartEvidence(
      exactInput({
        ledger: { status: "readable", boots: [ledgerBoot(OLD)] },
      }),
    );

    expect(verdict.health.status).toBe("healthy");
    expect(verdict.durable_boot.status).toBe("absent");
    expect(verdict.verdict).toBe("incomplete");
    expect(verdict.reasons).toContainEqual({
      code: "durable-boot-missing",
      phase: "durable-boot",
    });
  });

  test("boot-id and start-time mismatches are exact-identity failures", () => {
    const wrongBootId = classifyRestartEvidence(
      exactInput({
        ledger: {
          status: "readable",
          boots: [ledgerBoot({ ...NEXT, boot_id: "different-boot" })],
        },
      }),
    );
    const wrongStart = classifyRestartEvidence(
      exactInput({
        ledger: {
          status: "readable",
          boots: [ledgerBoot({ ...NEXT, start_time: "darwin:wrong-start" })],
        },
      }),
    );

    expect(wrongBootId.durable_boot.status).toBe("mismatched");
    expect(wrongStart.durable_boot.status).toBe("mismatched");
    expect(wrongBootId.verdict).toBe("incomplete");
    expect(wrongStart.verdict).toBe("incomplete");
  });
});

describe("restart evidence phases", () => {
  test("mixed boot samples do not combine into a healthy run", () => {
    const verdict = classifyRestartEvidence(
      exactInput({
        ledger: {
          status: "readable",
          boots: [ledgerBoot(NEXT), ledgerBoot(REPLACEMENT)],
        },
        health: [
          health(NEXT, 1_000),
          health(NEXT, 7_000),
          health(REPLACEMENT, 13_000),
        ],
      }),
    );

    expect(verdict.health).toEqual({
      status: "healthy",
      consecutive_caught_up_observations: 1,
      required_observations: 3,
      mixed_identities: true,
    });
    expect(verdict.stabilization.status).toBe("replaced");
    expect(
      reasonCodes(
        exactInput({
          ledger: {
            status: "readable",
            boots: [ledgerBoot(NEXT), ledgerBoot(REPLACEMENT)],
          },
          health: [
            health(NEXT, 1_000),
            health(NEXT, 7_000),
            health(REPLACEMENT, 13_000),
          ],
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "mixed-served-identities",
        "replacement-during-stabilization",
      ]),
    );
    expect(verdict.verdict).toBe("incomplete");
  });

  test("replacement inside stabilization resets elapsed evidence", () => {
    const verdict = classifyRestartEvidence(
      exactInput({
        ledger: {
          status: "readable",
          boots: [ledgerBoot(NEXT), ledgerBoot(REPLACEMENT)],
        },
        health: [
          health(NEXT, 1_000),
          health(NEXT, 8_000),
          health(REPLACEMENT, 10_000),
          health(REPLACEMENT, 11_000),
          health(REPLACEMENT, 12_000),
        ],
        monotonic: {
          started_at_ms: 0,
          now_ms: 12_000,
          deadline_at_ms: 20_000,
          stabilization_ms: 12_000,
        },
      }),
    );

    expect(verdict.health.consecutive_caught_up_observations).toBe(3);
    expect(verdict.stabilization).toEqual({
      status: "replaced",
      observed_for_ms: 2_000,
      required_ms: 12_000,
    });
    expect(verdict.verdict).toBe("incomplete");
  });

  test("Drain, health, and stabilization remain separate states", () => {
    const verdict = classifyRestartEvidence(
      exactInput({
        health: [
          health(NEXT, 1_000),
          health(NEXT, 7_000),
          health(NEXT, 13_000, { catching_up: true }),
        ],
      }),
    );

    expect(verdict.command.status).toBe("accepted");
    expect(verdict.replacement.status).toBe("replaced");
    expect(verdict.durable_boot.status).toBe("matched");
    expect(verdict.drain.status).toBe("catching-up");
    expect(verdict.health.status).toBe("healthy");
    expect(verdict.stabilization.status).toBe("not-started");
    expect(verdict.verdict).toBe("incomplete");
  });

  test("missing and unreadable ledger evidence have distinct bounded reasons", () => {
    const missing = classifyRestartEvidence(
      exactInput({ ledger: { status: "missing" } }),
    );
    const unreadable = classifyRestartEvidence(
      exactInput({
        ledger: {
          status: "unreadable",
          diagnostic: "E".repeat(10_000),
        },
      }),
    );

    expect(missing.durable_boot.status).toBe("missing");
    expect(unreadable.durable_boot.status).toBe("unreadable");
    expect(missing.reasons).toContainEqual({
      code: "ledger-missing",
      phase: "durable-boot",
    });
    expect(unreadable.reasons).toContainEqual({
      code: "ledger-unreadable",
      phase: "durable-boot",
    });
    expect(missing.reasons.length).toBeLessThanOrEqual(12);
    expect(unreadable.reasons.length).toBeLessThanOrEqual(12);
  });

  test("the monotonic deadline cannot be satisfied by wall-clock ledger time", () => {
    const verdict = classifyRestartEvidence(
      exactInput({
        ledger: {
          status: "readable",
          boots: [ledgerBoot(NEXT, 9_999_999_999_999)],
        },
        health: [health(NEXT, 1_000), health(NEXT, 4_000), health(NEXT, 8_000)],
        monotonic: {
          started_at_ms: 0,
          now_ms: 10_000,
          deadline_at_ms: 10_000,
          stabilization_ms: 12_000,
        },
      }),
    );

    expect(verdict.durable_boot.status).toBe("matched");
    expect(verdict.stabilization).toEqual({
      status: "deadline-exceeded",
      observed_for_ms: 7_000,
      required_ms: 12_000,
    });
    expect(
      reasonCodes(
        exactInput({
          health: [
            health(NEXT, 1_000),
            health(NEXT, 4_000),
            health(NEXT, 8_000),
          ],
          monotonic: {
            started_at_ms: 0,
            now_ms: 10_000,
            deadline_at_ms: 10_000,
            stabilization_ms: 12_000,
          },
        }),
      ),
    ).toContain("deadline-exceeded");
  });

  test("only one exact identity across replacement, row, Drain, health, and stability proves success", () => {
    const verdict = classifyRestartEvidence(exactInput());

    expect(verdict).toEqual({
      verdict: "proven",
      identity: NEXT,
      command: { status: "accepted" },
      replacement: { status: "replaced", old_process: "dead" },
      durable_boot: { status: "matched" },
      drain: { status: "complete" },
      health: {
        status: "healthy",
        consecutive_caught_up_observations: 3,
        required_observations: 3,
        mixed_identities: false,
      },
      stabilization: {
        status: "complete",
        observed_for_ms: 12_000,
        required_ms: 12_000,
      },
      reasons: [],
    });
  });

  test("command rejection is retained as a bounded warning when stronger proof succeeds", () => {
    const verdict = classifyRestartEvidence(
      exactInput({
        command: {
          issued: true,
          accepted: false,
          diagnostics: {
            exit_code: 143,
            timed_out: true,
            stdout: "x".repeat(2_000),
            stderr: "launchctl timed out",
          },
        },
      }),
    );

    expect(verdict.verdict).toBe("proven");
    expect(verdict.command.status).toBe("warning");
    expect(verdict.command.diagnostics?.stdout).toHaveLength(512);
    expect(verdict.command.diagnostics?.stderr).toBe("launchctl timed out");
  });
});

describe("restart forensic evidence", () => {
  test("the demonstrated mechanisms and unattributed death are encoded separately", () => {
    expect(RESTART_OBSERVABILITY_EVIDENCE).toEqual([
      {
        contradiction: "history-loss",
        classification: "demonstrated",
        mechanism: "compaction/rewrite",
      },
      {
        contradiction: "stats-without-row",
        classification: "demonstrated",
        mechanism: "swallowed-persistence-write",
      },
      {
        contradiction: "false-success",
        classification: "demonstrated",
        mechanism: "old-marker/mixed-sample-acceptance",
      },
      {
        contradiction: "short-death",
        classification: "unattributed",
        mechanism: null,
      },
    ]);
  });

  test("throttle-correlated timing cannot invent an unavailable death cause", () => {
    expect(
      classifyRestartDeathEvidence({
        primary_cause: null,
        runtime_ms: 9_800,
        throttle_interval_ms: 10_000,
      }),
    ).toEqual({ status: "unattributed", cause: null });
    expect(
      classifyRestartDeathEvidence({
        primary_cause: "accept-stall-server",
        runtime_ms: 9_800,
        throttle_interval_ms: 10_000,
      }),
    ).toEqual({ status: "attributed", cause: "accept-stall-server" });
  });
});
