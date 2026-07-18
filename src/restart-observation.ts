import type { RestartBootIdentity } from "./restart-ledger";

export const DEFAULT_RESTART_STABILIZATION_MS = 12_000;
export const DEFAULT_RESTART_HEALTH_OBSERVATIONS = 3;
export const MAX_RESTART_EVIDENCE_REASONS = 12;
export const MAX_RESTART_DIAGNOSTIC_CHARS = 512;

export type RestartIdentity = RestartBootIdentity;

export interface RestartLedgerBootRecord extends RestartIdentity {
  ts: number;
}

export type RestartLedgerSnapshot =
  | {
      status: "readable";
      boots: readonly RestartLedgerBootRecord[];
    }
  | { status: "missing" }
  | {
      status: "unreadable";
      diagnostic?: string;
    };

export interface RestartHealthObservation {
  identity: RestartIdentity;
  observed_at_ms: number;
  healthy: boolean;
  catching_up: boolean;
}

export type RestartProcessIdentityState =
  | "alive"
  | "dead"
  | "recycled"
  | "unknown";

export interface RestartCommandDiagnostics {
  exit_code?: number;
  timed_out?: boolean;
  stdout?: string;
  stderr?: string;
}

export interface RestartCommandObservation {
  issued: boolean;
  accepted: boolean;
  diagnostics?: RestartCommandDiagnostics;
}

export interface RestartObservationInput {
  pre_restart: {
    served_identity: RestartIdentity | null;
    ledger_marker: RestartLedgerBootRecord | null;
    ledger_status?: "readable" | "missing" | "unreadable";
  };
  command?: RestartCommandObservation;
  old_process: RestartProcessIdentityState;
  ledger: RestartLedgerSnapshot;
  health: readonly RestartHealthObservation[];
  monotonic: {
    started_at_ms: number;
    now_ms: number;
    deadline_at_ms: number;
    stabilization_ms?: number;
  };
  required_healthy_observations?: number;
}

export type RestartEvidenceReasonCode =
  | "command-not-issued"
  | "pre-restart-identity-missing"
  | "pre-restart-ledger-missing"
  | "pre-restart-ledger-unreadable"
  | "old-process-still-alive"
  | "old-process-state-unknown"
  | "replacement-not-distinct"
  | "served-health-missing"
  | "served-identity-invalid"
  | "served-health-unhealthy"
  | "drain-incomplete"
  | "ledger-missing"
  | "ledger-unreadable"
  | "durable-boot-missing"
  | "durable-boot-mismatched"
  | "durable-boot-is-old-marker"
  | "mixed-served-identities"
  | "insufficient-healthy-observations"
  | "replacement-during-stabilization"
  | "stabilization-pending"
  | "monotonic-timing-invalid"
  | "deadline-exceeded";

export type RestartEvidencePhase =
  | "command"
  | "replacement"
  | "durable-boot"
  | "drain"
  | "health"
  | "stabilization"
  | "deadline";

export interface RestartEvidenceReason {
  code: RestartEvidenceReasonCode;
  phase: RestartEvidencePhase;
}

export interface RestartCommandState {
  status: "not-issued" | "accepted" | "warning";
  diagnostics?: RestartCommandDiagnostics;
}

export interface RestartReplacementState {
  status: "unobserved" | "old-alive" | "old-gone" | "not-distinct" | "replaced";
  old_process: RestartProcessIdentityState;
}

export interface RestartDurableBootState {
  status:
    | "missing"
    | "unreadable"
    | "unmatched"
    | "absent"
    | "old"
    | "mismatched"
    | "matched";
}

export interface RestartDrainState {
  status: "unobserved" | "catching-up" | "complete";
}

export interface RestartHealthState {
  status: "unobserved" | "unhealthy" | "healthy";
  consecutive_caught_up_observations: number;
  required_observations: number;
  mixed_identities: boolean;
}

export interface RestartStabilizationState {
  status:
    | "not-started"
    | "pending"
    | "replaced"
    | "complete"
    | "deadline-exceeded";
  observed_for_ms: number;
  required_ms: number;
}

export interface RestartEvidenceVerdict {
  verdict: "incomplete" | "proven";
  identity: RestartIdentity | null;
  command: RestartCommandState;
  replacement: RestartReplacementState;
  durable_boot: RestartDurableBootState;
  drain: RestartDrainState;
  health: RestartHealthState;
  stabilization: RestartStabilizationState;
  reasons: readonly RestartEvidenceReason[];
}

function identityIsValid(identity: RestartIdentity): boolean {
  return (
    typeof identity.boot_id === "string" &&
    identity.boot_id.length > 0 &&
    Number.isInteger(identity.pid) &&
    identity.pid > 0 &&
    typeof identity.start_time === "string" &&
    identity.start_time.length > 0
  );
}

export function sameRestartIdentity(
  left: RestartIdentity | null | undefined,
  right: RestartIdentity | null | undefined,
): boolean {
  return (
    left != null &&
    right != null &&
    left.boot_id === right.boot_id &&
    left.pid === right.pid &&
    left.start_time === right.start_time
  );
}

function boundDiagnostic(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= MAX_RESTART_DIAGNOSTIC_CHARS
    ? value
    : value.slice(0, MAX_RESTART_DIAGNOSTIC_CHARS);
}

function normalizeDiagnostics(
  diagnostics: RestartCommandDiagnostics | undefined,
): RestartCommandDiagnostics | undefined {
  if (diagnostics === undefined) return undefined;
  return {
    ...(Number.isFinite(diagnostics.exit_code)
      ? { exit_code: diagnostics.exit_code }
      : {}),
    ...(diagnostics.timed_out === undefined
      ? {}
      : { timed_out: diagnostics.timed_out === true }),
    ...(diagnostics.stdout === undefined
      ? {}
      : { stdout: boundDiagnostic(diagnostics.stdout) }),
    ...(diagnostics.stderr === undefined
      ? {}
      : { stderr: boundDiagnostic(diagnostics.stderr) }),
  };
}

function commandState(
  observation: RestartCommandObservation | undefined,
): RestartCommandState {
  if (observation?.issued !== true) return { status: "not-issued" };
  const diagnostics = normalizeDiagnostics(observation.diagnostics);
  return {
    status: observation.accepted ? "accepted" : "warning",
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function partialIdentityMatch(
  left: RestartIdentity,
  right: RestartIdentity,
): boolean {
  return (
    left.boot_id === right.boot_id ||
    left.pid === right.pid ||
    (left.pid === right.pid && left.start_time === right.start_time)
  );
}

function timingIsValid(input: RestartObservationInput): boolean {
  const { started_at_ms, now_ms, deadline_at_ms, stabilization_ms } =
    input.monotonic;
  if (
    !Number.isFinite(started_at_ms) ||
    !Number.isFinite(now_ms) ||
    !Number.isFinite(deadline_at_ms) ||
    now_ms < started_at_ms ||
    deadline_at_ms < started_at_ms ||
    (stabilization_ms !== undefined &&
      (!Number.isFinite(stabilization_ms) || stabilization_ms < 0))
  ) {
    return false;
  }
  let prior = started_at_ms;
  for (const observation of input.health) {
    if (
      !Number.isFinite(observation.observed_at_ms) ||
      observation.observed_at_ms < prior ||
      observation.observed_at_ms > now_ms
    ) {
      return false;
    }
    prior = observation.observed_at_ms;
  }
  return true;
}

function qualifyingObservation(observation: RestartHealthObservation): boolean {
  return observation.healthy && !observation.catching_up;
}

export function classifyRestartEvidence(
  input: RestartObservationInput,
): RestartEvidenceVerdict {
  const reasons: RestartEvidenceReason[] = [];
  const addReason = (
    code: RestartEvidenceReasonCode,
    phase: RestartEvidencePhase,
  ): void => {
    if (
      reasons.length < MAX_RESTART_EVIDENCE_REASONS &&
      !reasons.some((reason) => reason.code === code)
    ) {
      reasons.push({ code, phase });
    }
  };

  const command = commandState(input.command);
  if (command.status === "not-issued") {
    addReason("command-not-issued", "command");
  }

  const preRestartLedgerStatus =
    input.pre_restart.ledger_status ??
    (input.pre_restart.ledger_marker === null ? "missing" : "readable");
  if (preRestartLedgerStatus === "missing") {
    addReason("pre-restart-ledger-missing", "durable-boot");
  } else if (preRestartLedgerStatus === "unreadable") {
    addReason("pre-restart-ledger-unreadable", "durable-boot");
  }

  const timingValid = timingIsValid(input);
  if (!timingValid) {
    addReason("monotonic-timing-invalid", "stabilization");
  }

  const requestedObservations = input.required_healthy_observations;
  const requiredObservations =
    typeof requestedObservations === "number" &&
    Number.isInteger(requestedObservations) &&
    requestedObservations > 0
      ? requestedObservations
      : DEFAULT_RESTART_HEALTH_OBSERVATIONS;
  const requiredStabilization =
    input.monotonic.stabilization_ms ?? DEFAULT_RESTART_STABILIZATION_MS;
  const latest = input.health.at(-1) ?? null;
  const candidate = latest?.identity ?? null;
  const candidateValid = candidate !== null && identityIsValid(candidate);

  let replacement: RestartReplacementState;
  const oldIdentity = input.pre_restart.served_identity;
  if (oldIdentity === null) {
    replacement = {
      status: "unobserved",
      old_process: input.old_process,
    };
    addReason("pre-restart-identity-missing", "replacement");
  } else if (
    candidate !== null &&
    (sameRestartIdentity(candidate, oldIdentity) ||
      candidate.boot_id === oldIdentity.boot_id)
  ) {
    replacement = {
      status: "not-distinct",
      old_process: input.old_process,
    };
    addReason("replacement-not-distinct", "replacement");
  } else if (input.old_process === "alive") {
    replacement = { status: "old-alive", old_process: input.old_process };
    addReason("old-process-still-alive", "replacement");
  } else if (input.old_process === "unknown") {
    replacement = { status: "unobserved", old_process: input.old_process };
    addReason("old-process-state-unknown", "replacement");
  } else if (candidate === null) {
    replacement = { status: "old-gone", old_process: input.old_process };
  } else {
    replacement = { status: "replaced", old_process: input.old_process };
  }

  if (latest === null) {
    addReason("served-health-missing", "health");
  } else if (!candidateValid) {
    addReason("served-identity-invalid", "health");
  }

  let durableBoot: RestartDurableBootState;
  if (input.ledger.status === "missing") {
    durableBoot = { status: "missing" };
    addReason("ledger-missing", "durable-boot");
  } else if (input.ledger.status === "unreadable") {
    durableBoot = { status: "unreadable" };
    addReason("ledger-unreadable", "durable-boot");
  } else if (candidate === null || !candidateValid) {
    durableBoot = { status: "unmatched" };
  } else {
    const exact = input.ledger.boots.find((boot) =>
      sameRestartIdentity(boot, candidate),
    );
    const isOld =
      sameRestartIdentity(candidate, oldIdentity) ||
      candidate.boot_id === oldIdentity?.boot_id ||
      sameRestartIdentity(candidate, input.pre_restart.ledger_marker) ||
      candidate.boot_id === input.pre_restart.ledger_marker?.boot_id;
    if (exact !== undefined && isOld) {
      durableBoot = { status: "old" };
      addReason("durable-boot-is-old-marker", "durable-boot");
    } else if (exact !== undefined) {
      durableBoot = { status: "matched" };
    } else if (
      input.ledger.boots.some((boot) => partialIdentityMatch(boot, candidate))
    ) {
      durableBoot = { status: "mismatched" };
      addReason("durable-boot-mismatched", "durable-boot");
    } else {
      durableBoot = { status: "absent" };
      addReason("durable-boot-missing", "durable-boot");
    }
  }

  const drain: RestartDrainState =
    latest === null
      ? { status: "unobserved" }
      : latest.catching_up
        ? { status: "catching-up" }
        : { status: "complete" };
  if (drain.status === "catching-up") {
    addReason("drain-incomplete", "drain");
  }

  let suffixStart = input.health.length;
  if (candidateValid) {
    for (let i = input.health.length - 1; i >= 0; i--) {
      const observation = input.health[i];
      if (
        !qualifyingObservation(observation) ||
        !sameRestartIdentity(observation.identity, candidate)
      ) {
        break;
      }
      suffixStart = i;
    }
  }
  const consecutive = input.health.length - suffixStart;
  const currentRun = input.health.slice(suffixStart);
  const observedFor =
    currentRun.length < 2
      ? 0
      : currentRun[currentRun.length - 1].observed_at_ms -
        currentRun[0].observed_at_ms;
  const mixedIdentities =
    candidate !== null &&
    input.health.some(
      (observation) => !sameRestartIdentity(observation.identity, candidate),
    );
  const replacedDuringStabilization = input.health
    .slice(0, suffixStart)
    .some(
      (observation) =>
        qualifyingObservation(observation) &&
        candidate !== null &&
        !sameRestartIdentity(observation.identity, candidate),
    );

  const health: RestartHealthState = {
    status:
      latest === null ? "unobserved" : latest.healthy ? "healthy" : "unhealthy",
    consecutive_caught_up_observations: consecutive,
    required_observations: requiredObservations,
    mixed_identities: mixedIdentities,
  };
  if (latest !== null && !latest.healthy) {
    addReason("served-health-unhealthy", "health");
  }
  if (mixedIdentities) {
    addReason("mixed-served-identities", "health");
  }
  if (latest?.healthy === true && consecutive < requiredObservations) {
    addReason("insufficient-healthy-observations", "health");
  }

  const currentRunLast = currentRun.at(-1);
  const stabilizationComplete =
    timingValid &&
    consecutive >= requiredObservations &&
    observedFor >= requiredStabilization &&
    currentRunLast !== undefined &&
    currentRunLast.observed_at_ms <= input.monotonic.deadline_at_ms;
  const deadlineExceeded =
    timingValid &&
    input.monotonic.now_ms >= input.monotonic.deadline_at_ms &&
    !stabilizationComplete;
  let stabilization: RestartStabilizationState;
  if (deadlineExceeded) {
    if (replacedDuringStabilization) {
      addReason("replacement-during-stabilization", "stabilization");
    }
    stabilization = {
      status: "deadline-exceeded",
      observed_for_ms: Math.max(0, observedFor),
      required_ms: requiredStabilization,
    };
    addReason("deadline-exceeded", "deadline");
  } else if (stabilizationComplete) {
    stabilization = {
      status: "complete",
      observed_for_ms: observedFor,
      required_ms: requiredStabilization,
    };
  } else if (replacedDuringStabilization) {
    stabilization = {
      status: "replaced",
      observed_for_ms: Math.max(0, observedFor),
      required_ms: requiredStabilization,
    };
    addReason("replacement-during-stabilization", "stabilization");
  } else if (consecutive > 0) {
    stabilization = {
      status: "pending",
      observed_for_ms: Math.max(0, observedFor),
      required_ms: requiredStabilization,
    };
    addReason("stabilization-pending", "stabilization");
  } else {
    stabilization = {
      status: "not-started",
      observed_for_ms: 0,
      required_ms: requiredStabilization,
    };
  }

  const proven =
    command.status !== "not-issued" &&
    preRestartLedgerStatus === "readable" &&
    input.pre_restart.ledger_marker !== null &&
    timingValid &&
    replacement.status === "replaced" &&
    durableBoot.status === "matched" &&
    drain.status === "complete" &&
    health.status === "healthy" &&
    stabilization.status === "complete";

  return {
    verdict: proven ? "proven" : "incomplete",
    identity:
      proven && candidate !== null
        ? {
            boot_id: candidate.boot_id,
            pid: candidate.pid,
            start_time: candidate.start_time,
          }
        : null,
    command,
    replacement,
    durable_boot: durableBoot,
    drain,
    health,
    stabilization,
    reasons: proven ? [] : reasons,
  };
}

export interface RestartDeathEvidenceInput {
  primary_cause?: string | null;
  runtime_ms?: number;
  throttle_interval_ms?: number;
}

export type RestartDeathEvidence =
  | { status: "attributed"; cause: string }
  | { status: "unattributed"; cause: null };

export function classifyRestartDeathEvidence(
  input: RestartDeathEvidenceInput,
): RestartDeathEvidence {
  const cause = input.primary_cause?.trim();
  if (cause === undefined || cause.length === 0) {
    return { status: "unattributed", cause: null };
  }
  return {
    status: "attributed",
    cause:
      cause.length <= MAX_RESTART_DIAGNOSTIC_CHARS
        ? cause
        : cause.slice(0, MAX_RESTART_DIAGNOSTIC_CHARS),
  };
}

export const RESTART_OBSERVABILITY_EVIDENCE = [
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
] as const;
