import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";

export const NATIVE_CRASH_LAUNCH_TOLERANCE_MS = 5_000;
export const NATIVE_CRASH_SCAN_MAX_FILES = 32;
export const NATIVE_CRASH_SCAN_MAX_FILE_BYTES = 512 * 1024;
export const NATIVE_CRASH_SCAN_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const NATIVE_CRASH_SCAN_TIME_BUDGET_MS = 100;
export const NATIVE_CRASH_FIELD_MAX_LEN = 300;
export const DEFAULT_NATIVE_CRASH_PROCESS_PREFIXES = [
  "keeperd",
  "bun",
] as const;

export interface NativeCrashBootIdentityWindow {
  boot_id: string;
  pid: number;
  start_time: string;
  started_at_ms: number;
  died_at_ms: number;
}

export interface ParsedCrashReport {
  bugType: string;
  pid: number;
  launchTimeMs: number;
  crashTimeMs: number;
  processPath?: string;
  signal?: string;
  exception?: string;
  faultingImage?: string;
  reportId?: string;
}

export interface NativeCrashMatch {
  boot_id: string;
  died_at_ms: number;
  native_crash_signal?: string;
  native_crash_exception?: string;
  native_crash_faulting_image?: string;
  native_crash_report_id: string;
}

export interface NativeCrashScanResult {
  matches: NativeCrashMatch[];
  filesInspected: number;
  bytesRead: number;
  timedOut: boolean;
}

interface CrashReportObjects {
  header: Record<string, unknown>;
  body: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bounded(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > NATIVE_CRASH_FIELD_MAX_LEN
    ? trimmed.slice(0, NATIVE_CRASH_FIELD_MAX_LEN)
    : trimmed;
}

function candidate(
  object: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function parsePid(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function crashReportTimeToEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1_000_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    return numeric >= 1_000_000_000_000 ? numeric : numeric * 1_000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function darwinStartTimeToEpochMs(value: string): number | null {
  if (!value.startsWith("darwin:")) return null;
  const parsed = Date.parse(value.slice("darwin:".length));
  return Number.isFinite(parsed) ? parsed : null;
}

export function launchTimesMatch(
  darwinStartTime: string,
  reportLaunchTime: unknown,
  toleranceMs = NATIVE_CRASH_LAUNCH_TOLERANCE_MS,
): boolean {
  const bootMs = darwinStartTimeToEpochMs(darwinStartTime);
  const reportMs = crashReportTimeToEpochMs(reportLaunchTime);
  return (
    bootMs !== null &&
    reportMs !== null &&
    Number.isFinite(toleranceMs) &&
    toleranceMs >= 0 &&
    Math.abs(bootMs - reportMs) <= toleranceMs
  );
}

function splitJsonObjects(text: string): CrashReportObjects | null {
  const start = text.search(/\S/);
  if (start < 0 || text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    const header = record(JSON.parse(text.slice(start, end)));
    const body = record(JSON.parse(text.slice(end).trim()));
    return header !== null && body !== null ? { header, body } : null;
  } catch {
    return null;
  }
}

function faultingImage(body: Record<string, unknown>): string | undefined {
  const direct = candidate(body, [
    "faultingImage",
    "faulting_image",
    "faultingImageName",
    "faulting_image_name",
  ]);
  const directRecord = record(direct);
  const directValue =
    directRecord === null
      ? bounded(direct)
      : bounded(candidate(directRecord, ["path", "name", "image"]));
  if (directValue !== undefined) return directValue;

  const faultingThread = candidate(body, ["faultingThread", "faulting_thread"]);
  const threads = Array.isArray(body.threads) ? body.threads : [];
  const thread =
    typeof faultingThread === "number" && Number.isInteger(faultingThread)
      ? record(threads[faultingThread])
      : null;
  const frames =
    thread !== null && Array.isArray(thread.frames) ? thread.frames : [];
  const firstFrame = record(frames[0]);
  const imageIndex = firstFrame?.imageIndex;
  const images = Array.isArray(body.usedImages)
    ? body.usedImages
    : Array.isArray(body.binaryImages)
      ? body.binaryImages
      : [];
  const image =
    typeof imageIndex === "number" && Number.isInteger(imageIndex)
      ? record(images[imageIndex])
      : null;
  return image === null
    ? undefined
    : bounded(candidate(image, ["path", "name", "image"]));
}

export function parseCrashReportText(text: string): ParsedCrashReport | null {
  const objects = splitJsonObjects(text);
  if (objects === null) return null;
  const { header, body } = objects;
  const bugType =
    bounded(candidate(header, ["bug_type", "bugType"])) ??
    bounded(candidate(body, ["bug_type", "bugType"]));
  if (bugType !== "309" && bugType !== "109") return null;

  const pid = parsePid(
    candidate(body, ["pid", "procPid", "processID", "process_id"]),
  );
  const launchTimeMs = crashReportTimeToEpochMs(
    candidate(body, [
      "procLaunch",
      "processLaunchTime",
      "launchTime",
      "launch_time",
    ]),
  );
  const crashTimeMs = crashReportTimeToEpochMs(
    candidate(body, ["captureTime", "crashTime", "crash_time", "timestamp"]) ??
      candidate(header, ["timestamp", "capture_time"]),
  );
  if (pid === null || launchTimeMs === null || crashTimeMs === null)
    return null;

  const exceptionRecord = record(body.exception);
  const terminationRecord = record(body.termination);
  return {
    bugType,
    pid,
    launchTimeMs,
    crashTimeMs,
    processPath: bounded(
      candidate(body, ["procPath", "processPath", "process_path"]),
    ),
    signal:
      bounded(exceptionRecord?.signal) ??
      bounded(candidate(body, ["signal", "crashSignal"])),
    exception:
      bounded(exceptionRecord?.type) ??
      bounded(candidate(body, ["exceptionType", "exception_type"])) ??
      bounded(terminationRecord?.indicator),
    faultingImage: faultingImage(body),
    reportId:
      bounded(candidate(header, ["incident_id", "incidentId", "incident"])) ??
      bounded(candidate(body, ["incident", "incident_id", "report_id"])),
  };
}

function processPathMatches(
  processPath: string | undefined,
  prefixes: readonly string[],
): boolean {
  if (processPath === undefined) return true;
  const name = basename(processPath).toLowerCase();
  return prefixes.some((prefix) => {
    const normalized = prefix.toLowerCase();
    return name === normalized || name.startsWith(`${normalized}-`);
  });
}

export function matchCrashReportToBoot(
  report: ParsedCrashReport,
  boot: NativeCrashBootIdentityWindow,
  processPrefixes: readonly string[] = DEFAULT_NATIVE_CRASH_PROCESS_PREFIXES,
): boolean {
  if (report.pid !== boot.pid) return false;
  const bootLaunchMs = darwinStartTimeToEpochMs(boot.start_time);
  if (
    bootLaunchMs === null ||
    Math.abs(bootLaunchMs - report.launchTimeMs) >
      NATIVE_CRASH_LAUNCH_TOLERANCE_MS
  ) {
    return false;
  }
  if (
    report.crashTimeMs < boot.started_at_ms ||
    report.crashTimeMs > boot.died_at_ms
  ) {
    return false;
  }
  return processPathMatches(report.processPath, processPrefixes);
}

function filenameMatches(name: string, prefixes: readonly string[]): boolean {
  if (!name.endsWith(".ips")) return false;
  const lower = name.toLowerCase();
  const hasPrefix = prefixes.some((prefix) =>
    lower.startsWith(`${prefix.toLowerCase()}-`),
  );
  return hasPrefix && /-\d{4}-\d{2}-\d{2}-\d{6}(?:[-.]|\.ips$)/.test(lower);
}

function readBoundedFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = Math.min(fstatSync(fd).size, maxBytes);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return offset === size ? buffer : buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

export function scanCrashReports(inputs: {
  directory: string;
  boots: NativeCrashBootIdentityWindow[];
  processPrefixes?: readonly string[];
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  timeBudgetMs?: number;
  now?: () => number;
}): NativeCrashScanResult {
  const prefixes =
    inputs.processPrefixes ?? DEFAULT_NATIVE_CRASH_PROCESS_PREFIXES;
  const maxFiles = Math.max(0, inputs.maxFiles ?? NATIVE_CRASH_SCAN_MAX_FILES);
  const maxFileBytes = Math.max(
    0,
    inputs.maxFileBytes ?? NATIVE_CRASH_SCAN_MAX_FILE_BYTES,
  );
  const maxTotalBytes = Math.max(
    0,
    inputs.maxTotalBytes ?? NATIVE_CRASH_SCAN_MAX_TOTAL_BYTES,
  );
  const timeBudgetMs = Math.max(
    0,
    inputs.timeBudgetMs ?? NATIVE_CRASH_SCAN_TIME_BUDGET_MS,
  );
  const now = inputs.now ?? (() => performance.now());
  const started = now();
  const result: NativeCrashScanResult = {
    matches: [],
    filesInspected: 0,
    bytesRead: 0,
    timedOut: false,
  };
  if (inputs.boots.length === 0 || prefixes.length === 0) return result;

  let names: string[];
  try {
    names = readdirSync(inputs.directory)
      .filter((name) => filenameMatches(name, prefixes))
      .sort();
  } catch {
    return result;
  }
  const unmatched = new Map(inputs.boots.map((boot) => [boot.boot_id, boot]));
  for (const name of names) {
    if (result.filesInspected >= maxFiles || unmatched.size === 0) break;
    if (now() - started > timeBudgetMs) {
      result.timedOut = true;
      break;
    }
    const remaining = maxTotalBytes - result.bytesRead;
    if (remaining <= 0) break;
    let bytes: Buffer;
    try {
      bytes = readBoundedFile(
        join(inputs.directory, name),
        Math.min(maxFileBytes, remaining),
      );
    } catch {
      continue;
    }
    result.filesInspected += 1;
    result.bytesRead += bytes.length;
    const report = parseCrashReportText(bytes.toString("utf8"));
    if (report === null) continue;
    for (const boot of unmatched.values()) {
      if (!matchCrashReportToBoot(report, boot, prefixes)) continue;
      result.matches.push({
        boot_id: boot.boot_id,
        died_at_ms: report.crashTimeMs,
        ...(report.signal !== undefined
          ? { native_crash_signal: report.signal }
          : {}),
        ...(report.exception !== undefined
          ? { native_crash_exception: report.exception }
          : {}),
        ...(report.faultingImage !== undefined
          ? { native_crash_faulting_image: report.faultingImage }
          : {}),
        native_crash_report_id:
          report.reportId ?? name.slice(0, NATIVE_CRASH_FIELD_MAX_LEN),
      });
      unmatched.delete(boot.boot_id);
      break;
    }
  }
  return result;
}
