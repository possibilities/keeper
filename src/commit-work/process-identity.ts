import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { basename } from "node:path";
import { parseLinuxStarttime } from "../proc-starttime";

/** The ancestry walk is bounded even if a malformed probe returns a cycle. */
export const INVOCATION_ANCESTRY_MAX_DEPTH = 40;
const MAX_PROC_STAT_BYTES = 8_192;
const MAX_PS_OUTPUT_BYTES = 4_096;
// Node omits O_CLOEXEC; establish it atomically on the Linux /proc descriptor.
const O_CLOEXEC = process.platform === "darwin" ? 0x1000000 : 0o2000000;
const PS_TIMEOUT_MS = 500;

export interface ProcessIdentityObservation {
  ppid: number;
  /** Platform-tagged in the same format as jobs.start_time. */
  startTime: string;
}

export type ProcessIdentityReader = (
  pid: number,
) =>
  | ProcessIdentityObservation
  | null
  | Promise<ProcessIdentityObservation | null>;

export type RecordedProcessIdentityVerdict =
  | "matching"
  | "gone"
  | "inconclusive";

export interface RecordedProcessIdentityDeps {
  signalZero?: (pid: number) => void;
  read?: (pid: number) => ProcessIdentityObservation | null;
}

export type RecordedProcessIdentityReason =
  | "matching"
  | "esrch"
  | "start_mismatch"
  | "unreadable";

export interface RecordedProcessIdentityResult {
  verdict: RecordedProcessIdentityVerdict;
  reason: RecordedProcessIdentityReason;
  observed: ProcessIdentityObservation | null;
}

export type HarnessProcess = "claude" | "pi";

export interface HarnessProcessObservation {
  identity: RecordedProcessIdentityVerdict;
  identityReason: RecordedProcessIdentityReason;
  observedStartTime: string | null;
  command: string | null;
}

export interface HarnessProcessProbeDeps extends RecordedProcessIdentityDeps {
  readCommand?: (pid: number) => string | null;
}

function parsePositivePid(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Parse Linux /proc/<pid>/stat without splitting the parenthesized comm field. */
export function parseLinuxProcessIdentity(
  stat: string,
): ProcessIdentityObservation | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // The remainder starts at field 3 (state): ppid is field 4 => index 1.
  const ppid = parsePositivePid(fields[1]);
  const start = parseLinuxStarttime(stat);
  if (ppid === null || start === null) return null;
  return { ppid, startTime: `linux:${start}` };
}

/** Parse the fixed-width BSD ps row emitted by readProcessIdentity on Darwin. */
export function parseDarwinProcessIdentity(
  output: string,
): ProcessIdentityObservation | null {
  const match = output.match(/^\s*(\d+)\s+(.{24})\s*$/);
  if (!match) return null;
  const ppid = parsePositivePid(match[1]);
  const start = match[2];
  if (
    ppid === null ||
    start === undefined ||
    !/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9]\d \d{2}:\d{2}:\d{2} \d{4}$/.test(
      start,
    )
  ) {
    return null;
  }
  return { ppid, startTime: `darwin:${start}` };
}

function readLinuxProcStat(pid: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(
      `/proc/${pid}/stat`,
      constants.O_RDONLY | constants.O_NONBLOCK | O_CLOEXEC,
    );
    const bytes = Buffer.alloc(MAX_PROC_STAT_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, null);
    if (count <= 0 || count > MAX_PROC_STAT_BYTES) return null;
    return bytes.subarray(0, count).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // A failed close cannot turn an unreadable process identity into trust.
      }
    }
  }
}

/**
 * Read one OS-authenticated process identity. Every failure is inconclusive and
 * therefore returns null. Darwin executes the absolute system ps binary with a
 * fixed one-row projection; Linux uses a size-bounded /proc descriptor read.
 */
export function readProcessIdentity(
  pid: number,
): ProcessIdentityObservation | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    const stat = readLinuxProcStat(pid);
    return stat === null ? null : parseLinuxProcessIdentity(stat);
  }
  if (process.platform === "darwin") {
    try {
      const result = Bun.spawnSync(
        ["/bin/ps", "-ww", "-p", String(pid), "-o", "ppid=", "-o", "lstart="],
        { timeout: PS_TIMEOUT_MS, stdout: "pipe", stderr: "ignore" },
      );
      if (!result.success || result.exitCode !== 0) return null;
      const bytes = result.stdout;
      if (bytes.byteLength > MAX_PS_OUTPUT_BYTES) return null;
      return parseDarwinProcessIdentity(bytes.toString());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Inspect one recorded pid-and-start-time witness. The detailed reason lets a
 * caller distinguish an absent process from a resident recycled pid without
 * weakening the shared recycle-safe classifier.
 */
export function inspectRecordedProcessIdentity(
  pid: number,
  startTime: string,
  deps: RecordedProcessIdentityDeps = {},
): RecordedProcessIdentityResult {
  const inconclusive: RecordedProcessIdentityResult = {
    verdict: "inconclusive",
    reason: "unreadable",
    observed: null,
  };
  if (!Number.isSafeInteger(pid) || pid <= 1 || startTime.length === 0) {
    return inconclusive;
  }
  const signalZero =
    deps.signalZero ?? ((target: number) => process.kill(target, 0));
  try {
    signalZero(pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return { verdict: "gone", reason: "esrch", observed: null };
    }
    if (code !== "EPERM") return inconclusive;
  }
  let observed: ProcessIdentityObservation | null;
  try {
    observed = (deps.read ?? readProcessIdentity)(pid);
  } catch {
    return inconclusive;
  }
  if (observed === null) {
    // Close the existence/read race without treating a parser or permission
    // failure as death.
    try {
      signalZero(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return { verdict: "gone", reason: "esrch", observed: null };
      }
    }
    return inconclusive;
  }
  if (observed.startTime !== startTime) {
    return { verdict: "gone", reason: "start_mismatch", observed };
  }
  return { verdict: "matching", reason: "matching", observed };
}

/**
 * Classify one recorded pid-and-start-time witness. ESRCH and a mismatched
 * resident identity prove the recorded claimant gone; every unreadable or
 * unsupported observation remains inconclusive.
 */
export function recordedProcessIdentity(
  pid: number,
  startTime: string,
  deps: RecordedProcessIdentityDeps = {},
): RecordedProcessIdentityVerdict {
  return inspectRecordedProcessIdentity(pid, startTime, deps).verdict;
}

/** Match a direct harness executable or its bounded node/bun launcher form. */
export function isHarnessProcessCommand(
  command: string,
  harness: HarnessProcess,
): boolean {
  const argv = command.includes("\0")
    ? command.split("\0").filter(Boolean)
    : command.trim().split(/\s+/).filter(Boolean);
  if (basename(argv[0] ?? "") === harness) return true;
  const launcher = basename(argv[0] ?? "");
  if (!new Set(["env", "node", "nodejs", "bun"]).has(launcher)) return false;
  const bounded = argv.slice(1, 4);
  if (bounded.some((token) => basename(token) === harness)) return true;
  const packageMarker =
    harness === "pi" ? "/pi-coding-agent/" : "/claude-code/";
  return bounded.some((token) => token.includes(packageMarker));
}

function readHarnessCommand(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8");
    }
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(
        ["/bin/ps", "-ww", "-p", String(pid), "-o", "args="],
        { timeout: PS_TIMEOUT_MS, stdout: "pipe", stderr: "ignore" },
      );
      if (!result.success || result.exitCode !== 0) return null;
      if (result.stdout.byteLength > MAX_PS_OUTPUT_BYTES) return null;
      return result.stdout.toString();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Return true when a recycled identity is too close to distinguish safely from
 * second-granular process metadata. Unknown formats stay inside the cautious
 * window and therefore require corroboration.
 */
export function processStartTimesWithinOneSecond(
  recorded: string,
  observed: string,
): boolean {
  if (recorded.startsWith("darwin:") && observed.startsWith("darwin:")) {
    const a = Date.parse(recorded.slice("darwin:".length));
    const b = Date.parse(observed.slice("darwin:".length));
    return Number.isFinite(a) && Number.isFinite(b)
      ? Math.abs(b - a) <= 1_000
      : true;
  }
  if (recorded.startsWith("linux:") && observed.startsWith("linux:")) {
    const a = Number(recorded.slice("linux:".length));
    const b = Number(observed.slice("linux:".length));
    return Number.isFinite(a) && Number.isFinite(b)
      ? Math.abs(b - a) <= 100
      : true;
  }
  return true;
}

/**
 * Probe identity and command through one shared process-mechanics seam. A
 * matching observation is rechecked after reading argv so a recycled pid can
 * never inherit the subsequent signal authority.
 */
export function probeHarnessProcess(
  pid: number,
  startTime: string,
  deps: HarnessProcessProbeDeps = {},
): HarnessProcessObservation {
  const first = inspectRecordedProcessIdentity(pid, startTime, deps);
  const command =
    first.verdict === "matching" || first.reason === "start_mismatch"
      ? (deps.readCommand ?? readHarnessCommand)(pid)
      : null;
  if (first.verdict !== "matching") {
    return {
      identity: first.verdict,
      identityReason: first.reason,
      observedStartTime: first.observed?.startTime ?? null,
      command,
    };
  }
  const final = inspectRecordedProcessIdentity(pid, startTime, deps);
  return {
    identity: final.verdict,
    identityReason: final.reason,
    observedStartTime: final.observed?.startTime ?? null,
    command: final.verdict === "matching" ? command : null,
  };
}

/**
 * Prove that the current CLI process descends from the exact recycle-safe
 * process recorded for a Claude job. A sibling process cannot select another
 * live session merely by copying its UUID or environment carriers.
 */
export async function invocationDescendsFrom(
  targetPid: number,
  targetStartTime: string,
  options: {
    currentPid?: number;
    read?: ProcessIdentityReader;
    maxDepth?: number;
  } = {},
): Promise<boolean> {
  if (
    !Number.isSafeInteger(targetPid) ||
    targetPid <= 1 ||
    targetStartTime.length === 0
  ) {
    return false;
  }
  const read = options.read ?? readProcessIdentity;
  const maxDepth = options.maxDepth ?? INVOCATION_ANCESTRY_MAX_DEPTH;
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) return false;

  let pid = options.currentPid ?? process.pid;
  const seen = new Set<number>();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || seen.has(pid)) return false;
    seen.add(pid);
    let observed: ProcessIdentityObservation | null;
    try {
      observed = await read(pid);
    } catch {
      return false;
    }
    if (observed === null) return false;
    if (pid === targetPid) return observed.startTime === targetStartTime;
    if (
      !Number.isSafeInteger(observed.ppid) ||
      observed.ppid <= 1 ||
      observed.ppid === pid
    ) {
      return false;
    }
    pid = observed.ppid;
  }
  return false;
}
