import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const CRASH_LOOP_THRESHOLD = 8;
export const CRASH_LOOP_WINDOW_MS = 30 * 60_000;
export const RESTART_LEDGER_CAP = 64;
export const RESTART_LEDGER_REASON_MAX_LEN = 300;
export const RESTART_LEDGER_NATIVE_FIELD_MAX_LEN = 300;
export const EXIT_ATTRIBUTION_BOOT_ID_MAX_LEN = 128;
export const HARD_KILL_EXIT_ATTRIBUTION_REASON =
  "hard kill or SIGKILL (no exit-attribution leaf, no crash report)";
export const CRASH_LOOP_YOUNG_RUNTIME_MS = 2 * 60_000;
export const REPEATED_NATIVE_CRASH_THRESHOLD = 2;
export const KEEPERD_LAUNCHD_LABEL = "arthack.keeperd";
export const SERVE_HEALTH_HISTORY_MAX_REPORTS = 40;

export type RestartProvenance = "launchd" | "unknown" | "foreign";

export type ExitAttributionKind =
  | "signal"
  | "fatal_exit"
  | "uncaught_exception"
  | "unhandled_rejection"
  | "clean_shutdown";

export type ExitAttributionSignal = "SIGTERM" | "SIGINT" | "SIGHUP";

export interface ExitAttributionRecord {
  boot_id: string;
  ts: number;
  kind: ExitAttributionKind;
  signal?: ExitAttributionSignal;
  reason?: string;
}

export interface ExitAttributionRecorder {
  readonly bootId: string;
  readonly path: string;
  record(attribution: Omit<ExitAttributionRecord, "boot_id" | "ts">): void;
}

/**
 * The forensic classification an enrich row settles on. `watchdog` and
 * `signal` mean the daemon (or a native crash report) explains its own end;
 * `operator` means an external reload (install.sh) bounced it; `os-memory-kill`
 * means the unified log shows OS-level jetsam/memory-pressure evidence for the
 * dead pid; `soft-exit-leaf` is a recorded soft exit that matched none of the
 * named triggers; `no-evidence` is the last-resort hard-kill-or-SIGKILL verdict.
 */
export type ExitVerdictKind =
  | "watchdog"
  | "operator"
  | "soft-exit-leaf"
  | "os-memory-kill"
  | "signal"
  | "no-evidence";

export interface ExitVerdict {
  kind: ExitVerdictKind;
  /** Bounded (`boundRestartReason`) supporting probe output for the verdict. */
  evidence: string;
}

/** The install.sh attribution leaf: a bounced-by-tooling explanation for a quiet end. */
export interface OperatorReloadAttribution {
  source: string;
  action: string;
  ts: number;
}

export interface OsMemoryKillEvidence {
  reason: string;
}

export interface ServeHealthReportSample {
  ts: number;
  rss_bytes: number;
}

/** Bounded ring buffer of recent serve-health RSS samples, durable across a crash. */
export interface ServeHealthHistory {
  boot_id: string;
  reports: ServeHealthReportSample[];
}

export interface RestartBootIdentity {
  boot_id: string;
  pid: number;
  start_time: string;
}

export interface RestartBootLine {
  kind: "boot";
  boot_id: string;
  pid: number | null;
  start_time: string | null;
  ts: number;
  provenance: RestartProvenance;
  prev_runtime_ms: number | null;
}

export interface RestartNativeCrashFields {
  native_crash_signal?: string;
  native_crash_exception?: string;
  native_crash_faulting_image?: string;
  native_crash_report_id?: string;
  native_crash_no_report?: true;
  died_at_ms?: number;
}

export interface RestartEnrichLine extends RestartNativeCrashFields {
  kind: "enrich";
  boot_id: string;
  ts: number;
  reason?: string;
  verdict?: ExitVerdictKind;
  verdict_evidence?: string;
}

export type RestartLedgerLine = RestartBootLine | RestartEnrichLine;

export interface RestartBoot extends RestartNativeCrashFields {
  boot_id: string;
  pid: number | null;
  start_time: string | null;
  ts: number;
  provenance: RestartProvenance;
  prev_runtime_ms: number | null;
  reason?: string;
  verdict?: ExitVerdictKind;
  verdict_evidence?: string;
}

export type RestartLedgerSnapshot =
  | {
      status: "readable";
      format: "empty" | "ndjson" | "legacy";
      lines: RestartLedgerLine[];
      raw: string;
    }
  | { status: "missing"; lines: []; raw: "" }
  | { status: "unreadable"; lines: []; diagnostic: string };

export function classifyRestartProvenance(
  xpcServiceName: string | null | undefined,
): RestartProvenance {
  const value = (xpcServiceName ?? "").trim();
  if (value.length === 0 || value === "0") return "unknown";
  if (value.startsWith(KEEPERD_LAUNCHD_LABEL)) return "launchd";
  return "foreign";
}

function normalizeProvenance(value: unknown): RestartProvenance {
  return value === "launchd" || value === "foreign" || value === "unknown"
    ? value
    : "unknown";
}

export function boundRestartReason(reason: string): string {
  return reason.length > RESTART_LEDGER_REASON_MAX_LEN
    ? reason.slice(0, RESTART_LEDGER_REASON_MAX_LEN)
    : reason;
}

function isExitAttributionKind(value: unknown): value is ExitAttributionKind {
  return (
    value === "signal" ||
    value === "fatal_exit" ||
    value === "uncaught_exception" ||
    value === "unhandled_rejection" ||
    value === "clean_shutdown"
  );
}

function isExitAttributionSignal(
  value: unknown,
): value is ExitAttributionSignal {
  return value === "SIGTERM" || value === "SIGINT" || value === "SIGHUP";
}

function isExitVerdictKind(value: unknown): value is ExitVerdictKind {
  return (
    value === "watchdog" ||
    value === "operator" ||
    value === "soft-exit-leaf" ||
    value === "os-memory-kill" ||
    value === "signal" ||
    value === "no-evidence"
  );
}

function normalizeExitAttribution(
  value: unknown,
): ExitAttributionRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  if (
    typeof object.boot_id !== "string" ||
    object.boot_id.length === 0 ||
    object.boot_id.length > EXIT_ATTRIBUTION_BOOT_ID_MAX_LEN ||
    typeof object.ts !== "number" ||
    !Number.isFinite(object.ts) ||
    !isExitAttributionKind(object.kind)
  ) {
    return null;
  }
  const signal = isExitAttributionSignal(object.signal)
    ? object.signal
    : undefined;
  if ((object.kind === "signal") !== (signal !== undefined)) return null;
  if (object.signal !== undefined && signal === undefined) return null;
  const reason =
    typeof object.reason === "string" && object.reason.length > 0
      ? boundRestartReason(object.reason)
      : undefined;
  if (object.reason !== undefined && reason === undefined) return null;
  return {
    boot_id: object.boot_id,
    ts: object.ts,
    kind: object.kind,
    ...(signal !== undefined ? { signal } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

function boundNativeCrashField(value: string): string {
  return value.length > RESTART_LEDGER_NATIVE_FIELD_MAX_LEN
    ? value.slice(0, RESTART_LEDGER_NATIVE_FIELD_MAX_LEN)
    : value;
}

function optionalBoundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? boundNativeCrashField(value)
    : undefined;
}

function nativeCrashFields(
  object: Record<string, unknown>,
): RestartNativeCrashFields {
  const fields: RestartNativeCrashFields = {};
  const signal = optionalBoundedString(object.native_crash_signal);
  const exception = optionalBoundedString(object.native_crash_exception);
  const image = optionalBoundedString(object.native_crash_faulting_image);
  const reportId = optionalBoundedString(object.native_crash_report_id);
  if (signal !== undefined) fields.native_crash_signal = signal;
  if (exception !== undefined) fields.native_crash_exception = exception;
  if (image !== undefined) fields.native_crash_faulting_image = image;
  if (reportId !== undefined) fields.native_crash_report_id = reportId;
  if (object.native_crash_no_report === true) {
    fields.native_crash_no_report = true;
  }
  if (
    typeof object.died_at_ms === "number" &&
    Number.isFinite(object.died_at_ms)
  ) {
    fields.died_at_ms = object.died_at_ms;
  }
  return fields;
}

function hasNativeCrashFields(fields: RestartNativeCrashFields): boolean {
  return (
    fields.native_crash_signal !== undefined ||
    fields.native_crash_exception !== undefined ||
    fields.native_crash_faulting_image !== undefined ||
    fields.native_crash_report_id !== undefined ||
    fields.native_crash_no_report === true ||
    fields.died_at_ms !== undefined
  );
}

function validPid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function validStartTime(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function serializeRestartLedgerLine(line: RestartLedgerLine): string {
  return `${JSON.stringify(line)}\n`;
}

export function parseRestartLedgerLine(line: string): RestartLedgerLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const object = parsed as Record<string, unknown>;
  const bootId = object.boot_id;
  const ts = object.ts;
  if (typeof bootId !== "string" || bootId.length === 0) return null;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  if (object.kind === "enrich") {
    const reason =
      typeof object.reason === "string"
        ? boundRestartReason(object.reason)
        : undefined;
    const crashFields = nativeCrashFields(object);
    const verdict = isExitVerdictKind(object.verdict)
      ? object.verdict
      : undefined;
    const verdictEvidence =
      typeof object.verdict_evidence === "string" &&
      object.verdict_evidence.length > 0
        ? boundRestartReason(object.verdict_evidence)
        : undefined;
    if (reason === undefined && !hasNativeCrashFields(crashFields)) return null;
    return {
      kind: "enrich",
      boot_id: bootId,
      ts,
      ...(reason !== undefined ? { reason } : {}),
      ...crashFields,
      ...(verdict !== undefined ? { verdict } : {}),
      ...(verdictEvidence !== undefined
        ? { verdict_evidence: verdictEvidence }
        : {}),
    };
  }
  if (object.kind !== "boot") return null;
  const previousRuntime = object.prev_runtime_ms;
  return {
    kind: "boot",
    boot_id: bootId,
    pid: validPid(object.pid),
    start_time: validStartTime(object.start_time),
    ts,
    provenance: normalizeProvenance(object.provenance),
    prev_runtime_ms:
      typeof previousRuntime === "number" && Number.isFinite(previousRuntime)
        ? previousRuntime
        : null,
  };
}

function legacyRestartEntriesToLines(items: unknown[]): RestartLedgerLine[] {
  const lines: RestartLedgerLine[] = [];
  items.forEach((item, index) => {
    let ts: number | null = null;
    let reason: string | undefined;
    if (typeof item === "number" && Number.isFinite(item)) {
      ts = item;
    } else if (
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      const object = item as Record<string, unknown>;
      if (typeof object.ts === "number" && Number.isFinite(object.ts)) {
        ts = object.ts;
        if (typeof object.reason === "string") {
          reason = boundRestartReason(object.reason);
        }
      }
    }
    if (ts === null) return;
    const bootId = `legacy:${index}:${ts}`;
    lines.push({
      kind: "boot",
      boot_id: bootId,
      pid: null,
      start_time: null,
      ts,
      provenance: "unknown",
      prev_runtime_ms: null,
    });
    if (reason !== undefined) {
      lines.push({ kind: "enrich", boot_id: bootId, ts, reason });
    }
  });
  return lines;
}

function parseWholeLegacy(raw: string): RestartLedgerLine[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? legacyRestartEntriesToLines(parsed) : null;
  } catch {
    return null;
  }
}

export function parseRestartLedger(raw: string): RestartLedgerLine[] {
  if (raw.trim().length === 0) return [];
  const legacy = parseWholeLegacy(raw);
  if (legacy !== null) return legacy;
  const lines: RestartLedgerLine[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = parseRestartLedgerLine(rawLine);
    if (line !== null) lines.push(line);
  }
  return lines;
}

export function collapseRestartLedger(
  lines: RestartLedgerLine[],
): RestartBoot[] {
  const boots = new Map<string, RestartBoot>();
  for (const line of lines) {
    if (line.kind !== "boot") continue;
    const existing = boots.get(line.boot_id);
    boots.set(line.boot_id, {
      boot_id: line.boot_id,
      pid: line.pid,
      start_time: line.start_time,
      ts: line.ts,
      provenance: line.provenance,
      prev_runtime_ms: line.prev_runtime_ms,
      reason: existing?.reason,
      native_crash_signal: existing?.native_crash_signal,
      native_crash_exception: existing?.native_crash_exception,
      native_crash_faulting_image: existing?.native_crash_faulting_image,
      native_crash_report_id: existing?.native_crash_report_id,
      native_crash_no_report: existing?.native_crash_no_report,
      died_at_ms: existing?.died_at_ms,
      verdict: existing?.verdict,
      verdict_evidence: existing?.verdict_evidence,
    });
  }
  for (const line of lines) {
    if (line.kind !== "enrich") continue;
    const existing = boots.get(line.boot_id);
    const enrichFields = nativeCrashFields(
      line as unknown as Record<string, unknown>,
    );
    if (existing) {
      if (line.reason !== undefined) existing.reason = line.reason;
      if (line.verdict !== undefined) existing.verdict = line.verdict;
      if (line.verdict_evidence !== undefined) {
        existing.verdict_evidence = line.verdict_evidence;
      }
      if (enrichFields.native_crash_signal !== undefined) {
        existing.native_crash_signal = enrichFields.native_crash_signal;
      }
      if (enrichFields.native_crash_exception !== undefined) {
        existing.native_crash_exception = enrichFields.native_crash_exception;
      }
      if (enrichFields.native_crash_faulting_image !== undefined) {
        existing.native_crash_faulting_image =
          enrichFields.native_crash_faulting_image;
      }
      if (enrichFields.native_crash_report_id !== undefined) {
        existing.native_crash_report_id = enrichFields.native_crash_report_id;
      }
      if (enrichFields.native_crash_no_report === true) {
        existing.native_crash_no_report = true;
      }
      if (enrichFields.died_at_ms !== undefined) {
        existing.died_at_ms = enrichFields.died_at_ms;
      } else if (
        line.reason !== undefined &&
        existing.died_at_ms === undefined
      ) {
        existing.died_at_ms = line.ts;
      }
    } else {
      boots.set(line.boot_id, {
        boot_id: line.boot_id,
        pid: null,
        start_time: null,
        ts: line.ts,
        provenance: "unknown",
        prev_runtime_ms: null,
        ...(line.reason !== undefined ? { reason: line.reason } : {}),
        ...enrichFields,
        ...(line.verdict !== undefined ? { verdict: line.verdict } : {}),
        ...(line.verdict_evidence !== undefined
          ? { verdict_evidence: line.verdict_evidence }
          : {}),
        ...(enrichFields.died_at_ms === undefined && line.reason !== undefined
          ? { died_at_ms: line.ts }
          : {}),
      });
    }
  }
  const result = [...boots.values()].sort(
    (left, right) =>
      left.ts - right.ts || left.boot_id.localeCompare(right.boot_id),
  );
  for (let index = 1; index < result.length; index++) {
    if (result[index].prev_runtime_ms === null) {
      result[index].prev_runtime_ms = result[index].ts - result[index - 1].ts;
    }
  }
  return result;
}

/** Read-side projection used for bounded crash-loop decisions; never persisted. */
export function compactRestartLedger(
  lines: RestartLedgerLine[],
  opts: { nowMs: number; windowMs: number; cap: number },
): RestartLedgerLine[] {
  const cutoff = opts.nowMs - opts.windowMs;
  const boots = collapseRestartLedger(lines).filter(
    (boot) => boot.ts >= cutoff && boot.ts <= opts.nowMs,
  );
  const capped = boots.length > opts.cap ? boots.slice(-opts.cap) : boots;
  const projected: RestartLedgerLine[] = [];
  for (const boot of capped) {
    projected.push({
      kind: "boot",
      boot_id: boot.boot_id,
      pid: boot.pid,
      start_time: boot.start_time,
      ts: boot.ts,
      provenance: boot.provenance,
      prev_runtime_ms: boot.prev_runtime_ms,
    });
    const crashFields: RestartNativeCrashFields = {
      ...(boot.native_crash_signal !== undefined
        ? { native_crash_signal: boot.native_crash_signal }
        : {}),
      ...(boot.native_crash_exception !== undefined
        ? { native_crash_exception: boot.native_crash_exception }
        : {}),
      ...(boot.native_crash_faulting_image !== undefined
        ? { native_crash_faulting_image: boot.native_crash_faulting_image }
        : {}),
      ...(boot.native_crash_report_id !== undefined
        ? { native_crash_report_id: boot.native_crash_report_id }
        : {}),
      ...(boot.native_crash_no_report === true
        ? { native_crash_no_report: true as const }
        : {}),
      ...(boot.died_at_ms !== undefined ? { died_at_ms: boot.died_at_ms } : {}),
    };
    if (
      boot.reason !== undefined ||
      hasNativeCrashFields(crashFields) ||
      boot.verdict !== undefined
    ) {
      projected.push({
        kind: "enrich",
        boot_id: boot.boot_id,
        ts: boot.died_at_ms ?? boot.ts,
        ...(boot.reason !== undefined ? { reason: boot.reason } : {}),
        ...crashFields,
        ...(boot.verdict !== undefined ? { verdict: boot.verdict } : {}),
        ...(boot.verdict_evidence !== undefined
          ? { verdict_evidence: boot.verdict_evidence }
          : {}),
      });
    }
  }
  return projected;
}

/** Pure boot-line builder. History is returned intact; retention is read-side. */
export function foldBootIntoRestartLedger(inputs: {
  existing: RestartLedgerLine[];
  bootId: string;
  pid?: number | null;
  startTime?: string | null;
  provenance: RestartProvenance;
  nowMs: number;
  windowMs?: number;
  cap?: number;
}): { lines: RestartLedgerLine[]; bootLine: RestartBootLine } {
  const priorBoots = collapseRestartLedger(inputs.existing).filter(
    (boot) => boot.ts <= inputs.nowMs,
  );
  const predecessor = priorBoots.at(-1) ?? null;
  const bootLine: RestartBootLine = {
    kind: "boot",
    boot_id: inputs.bootId,
    pid: inputs.pid ?? null,
    start_time: inputs.startTime ?? null,
    ts: inputs.nowMs,
    provenance: inputs.provenance,
    prev_runtime_ms: predecessor ? inputs.nowMs - predecessor.ts : null,
  };
  return { lines: [...inputs.existing, bootLine], bootLine };
}

export function qualifyCrashLoopBootTimestamps(
  boots: RestartBoot[],
  youngRuntimeMs: number,
): number[] {
  return boots
    .filter((boot) => boot.provenance !== "foreign")
    .filter(
      (boot) =>
        boot.prev_runtime_ms !== null && boot.prev_runtime_ms <= youngRuntimeMs,
    )
    .map((boot) => boot.ts);
}

function hasNativeCrashMatch(fields: RestartNativeCrashFields): boolean {
  return (
    fields.native_crash_report_id !== undefined ||
    fields.native_crash_signal !== undefined ||
    fields.native_crash_exception !== undefined ||
    fields.native_crash_faulting_image !== undefined
  );
}

export function isNativeCrashAttributed(boot: RestartBoot): boolean {
  return hasNativeCrashMatch(boot);
}

export function shouldEnrichPriorExitAttribution(inputs: {
  priorBoot: RestartBoot | null;
  exitAttribution: ExitAttributionRecord | null;
  allowHardKillFallback: boolean;
}): boolean {
  if (inputs.priorBoot === null) return false;
  if (
    inputs.priorBoot.reason !== undefined ||
    isNativeCrashAttributed(inputs.priorBoot)
  ) {
    return false;
  }
  return inputs.exitAttribution !== null || inputs.allowHardKillFallback;
}

/**
 * Named `fatalExit` reasons a live watchdog trigger writes (see daemon.ts's
 * serve-liveness/git-seed/tmux-control watchdogs) — distinct from a generic
 * soft-exit leaf whose reason names none of them.
 */
const WATCHDOG_REASON_PATTERN =
  /^(serve-liveness-watchdog|git-seed-watchdog|tmux-control-watchdog):/;

/**
 * Pure forensic classifier: settles the ONE {@link ExitVerdictKind} a dead
 * boot's enrich row carries, in order of certainty — an external operator
 * reload (install.sh) outranks even a leaf/native-crash match (a bounced
 * process's own leaf can lag the bounce), then the recorded soft-exit leaf
 * (named watchdog trigger vs. a generic soft exit), then a matched native
 * crash report, then OS-level jetsam/memory-pressure evidence, and finally
 * the last-resort hard-kill-or-SIGKILL verdict when nothing else explains it.
 */
export function classifyExitVerdict(inputs: {
  exitAttribution: ExitAttributionRecord | null;
  nativeCrash: RestartNativeCrashFields | null;
  operatorReload: OperatorReloadAttribution | null;
  osMemoryKill: OsMemoryKillEvidence | null;
}): ExitVerdict {
  if (inputs.operatorReload !== null) {
    const { source, action } = inputs.operatorReload;
    return {
      kind: "operator",
      evidence: boundRestartReason(`${source} ${action}`),
    };
  }
  if (inputs.exitAttribution !== null) {
    const attribution = inputs.exitAttribution;
    if (attribution.kind === "signal") {
      return {
        kind: "signal",
        evidence: boundRestartReason(
          attribution.reason ?? `signal: ${attribution.signal}`,
        ),
      };
    }
    const reason = attribution.reason;
    if (reason !== undefined && WATCHDOG_REASON_PATTERN.test(reason)) {
      return { kind: "watchdog", evidence: boundRestartReason(reason) };
    }
    return {
      kind: "soft-exit-leaf",
      evidence: boundRestartReason(
        reason ?? `exit attribution: ${attribution.kind}`,
      ),
    };
  }
  const nativeCrash =
    inputs.nativeCrash === null
      ? {}
      : nativeCrashFields(
          inputs.nativeCrash as unknown as Record<string, unknown>,
        );
  if (hasNativeCrashMatch(nativeCrash)) {
    const detail =
      nativeCrash.native_crash_signal ??
      nativeCrash.native_crash_exception ??
      nativeCrash.native_crash_report_id ??
      "native crash report matched";
    return {
      kind: "signal",
      evidence: boundRestartReason(`native crash: ${detail}`),
    };
  }
  if (inputs.osMemoryKill !== null) {
    return {
      kind: "os-memory-kill",
      evidence: boundRestartReason(inputs.osMemoryKill.reason),
    };
  }
  return { kind: "no-evidence", evidence: HARD_KILL_EXIT_ATTRIBUTION_REASON };
}

export function decideExitAttribution(inputs: {
  bootId: string;
  ts: number;
  exitAttribution: ExitAttributionRecord | null;
  nativeCrash: RestartNativeCrashFields | null;
  operatorReload?: OperatorReloadAttribution | null;
  osMemoryKill?: OsMemoryKillEvidence | null;
}): RestartEnrichLine {
  const operatorReload = inputs.operatorReload ?? null;
  const osMemoryKill = inputs.osMemoryKill ?? null;
  const verdict = classifyExitVerdict({
    exitAttribution: inputs.exitAttribution,
    nativeCrash: inputs.nativeCrash,
    operatorReload,
    osMemoryKill,
  });
  const base = {
    kind: "enrich" as const,
    boot_id: inputs.bootId,
    ts: inputs.ts,
    verdict: verdict.kind,
    verdict_evidence: verdict.evidence,
  };

  if (operatorReload !== null) {
    return { ...base, reason: verdict.evidence };
  }
  if (inputs.exitAttribution !== null) {
    const attribution = inputs.exitAttribution;
    const reason =
      attribution.reason ??
      (attribution.signal !== undefined
        ? `signal: ${attribution.signal}`
        : `exit attribution: ${attribution.kind}`);
    return { ...base, reason: boundRestartReason(reason) };
  }
  const nativeCrash =
    inputs.nativeCrash === null
      ? {}
      : nativeCrashFields(
          inputs.nativeCrash as unknown as Record<string, unknown>,
        );
  if (hasNativeCrashMatch(nativeCrash)) {
    return { ...base, ...nativeCrash };
  }
  if (osMemoryKill !== null) {
    return { ...base, reason: verdict.evidence };
  }
  return { ...base, reason: HARD_KILL_EXIT_ATTRIBUTION_REASON };
}

export function planNativeCrashEnrichLines(inputs: {
  boots: RestartBoot[];
  matches: Array<RestartNativeCrashFields & { boot_id: string }>;
  exhausted: boolean;
  nowMs: number;
}): RestartEnrichLine[] {
  const matches = new Map(
    inputs.matches.map((match) => [match.boot_id, match] as const),
  );
  const planned: RestartEnrichLine[] = [];
  for (const boot of inputs.boots.slice(0, -1)) {
    if (isNativeCrashAttributed(boot)) continue;
    const match = matches.get(boot.boot_id);
    if (match !== undefined) {
      const fields = nativeCrashFields(
        match as unknown as Record<string, unknown>,
      );
      if (isNativeCrashAttributed({ ...boot, ...fields })) {
        planned.push({
          kind: "enrich",
          boot_id: boot.boot_id,
          ts: inputs.nowMs,
          ...fields,
        });
      }
      continue;
    }
    if (inputs.exhausted && boot.native_crash_no_report !== true) {
      planned.push({
        kind: "enrich",
        boot_id: boot.boot_id,
        ts: inputs.nowMs,
        native_crash_no_report: true,
      });
    }
  }
  return planned;
}

export function decideRepeatedNativeCrash(
  boots: RestartBoot[],
  threshold = REPEATED_NATIVE_CRASH_THRESHOLD,
): { repeatedNativeCrash: boolean; attributedBoots: number } {
  const attributedBoots = boots.filter(isNativeCrashAttributed).length;
  return {
    repeatedNativeCrash: attributedBoots >= threshold,
    attributedBoots,
  };
}

export function decideCrashLoop(inputs: {
  nowMs: number;
  bootTimestamps: number[];
  threshold: number;
  windowMs: number;
}): { crashLoop: boolean; recentBoots: number } {
  const cutoff = inputs.nowMs - inputs.windowMs;
  const recentBoots = inputs.bootTimestamps.filter(
    (ts) => Number.isFinite(ts) && ts >= cutoff && ts <= inputs.nowMs,
  ).length;
  return {
    crashLoop: recentBoots >= inputs.threshold,
    recentBoots,
  };
}

function diagnostic(error: unknown): string {
  return boundRestartReason(
    error instanceof Error ? error.message : String(error),
  );
}

export function readRestartLedgerSnapshot(path: string): RestartLedgerSnapshot {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { status: "missing", lines: [], raw: "" };
    }
    return { status: "unreadable", lines: [], diagnostic: diagnostic(error) };
  }
  const legacy = parseWholeLegacy(raw);
  return {
    status: "readable",
    format:
      raw.trim().length === 0 ? "empty" : legacy === null ? "ndjson" : "legacy",
    lines: legacy ?? parseRestartLedger(raw),
    raw,
  };
}

export function readRestartLedger(path: string): RestartLedgerLine[] {
  const snapshot = readRestartLedgerSnapshot(path);
  return snapshot.status === "unreadable" ? [] : snapshot.lines;
}

export function resolveExitAttributionPath(restartLedgerPath: string): string {
  return join(dirname(restartLedgerPath), "exit-attribution.json");
}

export function readExitAttribution(
  path: string,
): ExitAttributionRecord | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return normalizeExitAttribution(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function removeExitAttribution(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * `install.sh` writes this leaf right before it bounces a loaded keeperd
 * (relink + `launchctl bootout`/`bootstrap`) — an external reload otherwise
 * invisible to keeper, reading as an unattributed quiet death. Sole writer is
 * `scripts/install.sh`; the daemon only ever reads it.
 */
export function resolveOperatorReloadAttributionPath(
  restartLedgerPath: string,
): string {
  return join(dirname(restartLedgerPath), "install-reload-attribution.json");
}

function normalizeOperatorReloadAttribution(
  value: unknown,
): OperatorReloadAttribution | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  if (
    typeof object.source !== "string" ||
    object.source.length === 0 ||
    typeof object.action !== "string" ||
    object.action.length === 0 ||
    typeof object.ts_ms !== "number" ||
    !Number.isFinite(object.ts_ms)
  ) {
    return null;
  }
  return {
    source: boundNativeCrashField(object.source),
    action: boundNativeCrashField(object.action),
    ts: object.ts_ms,
  };
}

export function readOperatorReloadAttribution(
  path: string,
): OperatorReloadAttribution | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return normalizeOperatorReloadAttribution(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * An operator-reload leaf only explains a death when its stamp falls inside
 * the dying boot's OWN lifetime — otherwise it is a stale leaf from an
 * earlier or later reload and must not be misattributed to this boot.
 */
export function matchOperatorReloadAttribution(
  attribution: OperatorReloadAttribution | null,
  window: { startedAtMs: number; diedAtMs: number },
): OperatorReloadAttribution | null {
  if (attribution === null) return null;
  return attribution.ts >= window.startedAtMs &&
    attribution.ts <= window.diedAtMs
    ? attribution
    : null;
}

function writeAll(fd: number, content: string): void {
  const bytes = Buffer.from(content);
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset);
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  const temp = join(
    dir,
    `${basename(path)}.tmp.${process.pid}.${randomUUID()}`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeAll(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
    syncDirectory(dir);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {}
    throw error;
  }
}

export function writeExitAttribution(
  path: string,
  attribution: ExitAttributionRecord,
): void {
  const persisted = normalizeExitAttribution(attribution);
  if (persisted === null) throw new Error("invalid exit attribution");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWrite(path, `${JSON.stringify(persisted)}\n`);
}

export function createExitAttributionRecorder(inputs: {
  bootId: string;
  path: string;
  nowMs?: () => number;
}): ExitAttributionRecorder {
  let written = false;
  const nowMs = inputs.nowMs ?? Date.now;
  return {
    bootId: inputs.bootId,
    path: inputs.path,
    record(attribution): void {
      if (written) return;
      try {
        writeExitAttribution(inputs.path, {
          ...attribution,
          boot_id: inputs.bootId,
          ts: nowMs(),
        });
        written = true;
      } catch {}
    },
  };
}

export function resolveServeHealthHistoryPath(
  restartLedgerPath: string,
): string {
  return join(dirname(restartLedgerPath), "serve-health-history.json");
}

function normalizeServeHealthReportSample(
  value: unknown,
): ServeHealthReportSample | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  if (
    typeof object.ts !== "number" ||
    !Number.isFinite(object.ts) ||
    typeof object.rss_bytes !== "number" ||
    !Number.isFinite(object.rss_bytes) ||
    object.rss_bytes < 0
  ) {
    return null;
  }
  return { ts: object.ts, rss_bytes: object.rss_bytes };
}

function normalizeServeHealthHistory(
  value: unknown,
): ServeHealthHistory | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  if (typeof object.boot_id !== "string" || object.boot_id.length === 0) {
    return null;
  }
  const reports = Array.isArray(object.reports)
    ? object.reports
        .map(normalizeServeHealthReportSample)
        .filter((sample): sample is ServeHealthReportSample => sample !== null)
    : [];
  return { boot_id: object.boot_id, reports };
}

/**
 * Durable ring buffer of the last {@link SERVE_HEALTH_HISTORY_MAX_REPORTS}
 * serve-health ticks' main RSS, so a memory-growth death leaves a visible
 * ramp for the NEXT boot's enrich pass — a hard kill gives zero warning at
 * death time, so this is persisted PERIODICALLY, never only on exit.
 */
export function readServeHealthHistory(
  path: string,
): ServeHealthHistory | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return normalizeServeHealthHistory(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeServeHealthHistory(
  path: string,
  history: ServeHealthHistory,
): void {
  const persisted = normalizeServeHealthHistory(history);
  if (persisted === null) throw new Error("invalid serve-health history");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWrite(path, `${JSON.stringify(persisted)}\n`);
}

/** Pure ring-buffer append, bounded to `maxReports` (oldest samples drop first). */
export function appendServeHealthReportSample(
  history: ServeHealthHistory,
  sample: ServeHealthReportSample,
  maxReports = SERVE_HEALTH_HISTORY_MAX_REPORTS,
): ServeHealthHistory {
  const reports = [...history.reports, sample];
  return {
    boot_id: history.boot_id,
    reports: reports.length > maxReports ? reports.slice(-maxReports) : reports,
  };
}

/** Compatibility helper for explicit conversion/tests; normal boot never calls it. */
export function writeRestartLedger(
  path: string,
  lines: RestartLedgerLine[],
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWrite(path, lines.map(serializeRestartLedgerLine).join(""));
}

/** Append and sync one record without rewriting existing NDJSON history. */
export function appendRestartLedgerLine(
  path: string,
  line: RestartLedgerLine,
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existed = existsSync(path);
  let fd: number | null = null;
  try {
    fd = openSync(path, "a+", 0o600);
    const size = fstatSync(fd).size;
    let prefix = "";
    if (size > 0) {
      const byte = Buffer.allocUnsafe(1);
      readSync(fd, byte, 0, 1, size - 1);
      if (byte[0] !== 0x0a) prefix = "\n";
    }
    const persisted =
      line.kind === "enrich"
        ? {
            ...line,
            ...(line.reason !== undefined
              ? { reason: boundRestartReason(line.reason) }
              : {}),
            ...nativeCrashFields(line as unknown as Record<string, unknown>),
          }
        : line;
    writeAll(fd, prefix + serializeRestartLedgerLine(persisted));
    fsyncSync(fd);
    if (!existed) syncDirectory(dir);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Persist the admitted daemon identity. A valid legacy array is converted once
 * atomically; NDJSON history is only appended. Any failure throws before DB open.
 */
export function appendDurableRestartBoot(inputs: {
  path: string;
  bootId: string;
  pid: number;
  startTime: string;
  provenance: RestartProvenance;
  nowMs: number;
}): RestartBootLine {
  if (
    inputs.bootId.length === 0 ||
    !Number.isInteger(inputs.pid) ||
    inputs.pid <= 0 ||
    inputs.startTime.length === 0 ||
    !Number.isFinite(inputs.nowMs)
  ) {
    throw new Error("invalid daemon boot identity");
  }
  mkdirSync(dirname(inputs.path), { recursive: true, mode: 0o700 });
  const snapshot = readRestartLedgerSnapshot(inputs.path);
  if (snapshot.status === "unreadable") {
    throw new Error(`cannot read existing history: ${snapshot.diagnostic}`);
  }
  const { bootLine } = foldBootIntoRestartLedger({
    existing: snapshot.lines,
    bootId: inputs.bootId,
    pid: inputs.pid,
    startTime: inputs.startTime,
    provenance: inputs.provenance,
    nowMs: inputs.nowMs,
  });
  if (snapshot.status === "readable" && snapshot.format === "legacy") {
    atomicWrite(
      inputs.path,
      [...snapshot.lines, bootLine].map(serializeRestartLedgerLine).join(""),
    );
  } else {
    appendRestartLedgerLine(inputs.path, bootLine);
  }
  return bootLine;
}
