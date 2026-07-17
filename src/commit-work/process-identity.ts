import { closeSync, constants, openSync, readSync } from "node:fs";
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
 * Classify one recorded pid-and-start-time witness. ESRCH and a mismatched
 * resident identity prove the recorded claimant gone; every unreadable or
 * unsupported observation remains inconclusive.
 */
export function recordedProcessIdentity(
  pid: number,
  startTime: string,
  deps: RecordedProcessIdentityDeps = {},
): RecordedProcessIdentityVerdict {
  if (!Number.isSafeInteger(pid) || pid <= 1 || startTime.length === 0) {
    return "inconclusive";
  }
  const signalZero =
    deps.signalZero ?? ((target: number) => process.kill(target, 0));
  try {
    signalZero(pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code !== "EPERM") return "inconclusive";
  }
  let observed: ProcessIdentityObservation | null;
  try {
    observed = (deps.read ?? readProcessIdentity)(pid);
  } catch {
    return "inconclusive";
  }
  if (observed === null) {
    // Close the existence/read race without treating a parser or permission
    // failure as death.
    try {
      signalZero(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
    }
    return "inconclusive";
  }
  return observed.startTime === startTime ? "matching" : "gone";
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
