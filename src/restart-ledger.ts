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
export const CRASH_LOOP_YOUNG_RUNTIME_MS = 2 * 60_000;
export const REPEATED_NATIVE_CRASH_THRESHOLD = 2;
export const KEEPERD_LAUNCHD_LABEL = "arthack.keeperd";

export type RestartProvenance = "launchd" | "unknown" | "foreign";

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
    if (reason === undefined && !hasNativeCrashFields(crashFields)) return null;
    return {
      kind: "enrich",
      boot_id: bootId,
      ts,
      ...(reason !== undefined ? { reason } : {}),
      ...crashFields,
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
    if (boot.reason !== undefined || hasNativeCrashFields(crashFields)) {
      projected.push({
        kind: "enrich",
        boot_id: boot.boot_id,
        ts: boot.died_at_ms ?? boot.ts,
        ...(boot.reason !== undefined ? { reason: boot.reason } : {}),
        ...crashFields,
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

export function isNativeCrashAttributed(boot: RestartBoot): boolean {
  return (
    boot.native_crash_report_id !== undefined ||
    boot.native_crash_signal !== undefined ||
    boot.native_crash_exception !== undefined ||
    boot.native_crash_faulting_image !== undefined
  );
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
