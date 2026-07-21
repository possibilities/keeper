import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const OWNER_SCHEMA_VERSION = 2;
const OWNER_NONCE_BYTES = 16;
const OWNER_NONCE_RE = /^[a-f0-9]{32}$/;
const OWNER_START_ID_MAX_BYTES = 96;
const OWNER_MAX_BYTES = 384;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_MS = 10;
const PID_MAX = 2_147_483_647;
const PS_TIMEOUT_MS = 1_000;
const PS_MAX_BUFFER_BYTES = 1024;
const RECLAIM_GATE_SUFFIX = ".reclaim";
const GATE_RECOVERY_SUFFIX = ".recover";

export interface HeldOwnerFileLock {
  release(): void;
}

export type PidLiveness = "alive" | "dead" | "unknown";

interface OwnerRecord {
  schema_version: 2;
  pid: number;
  process_start_id: string;
  nonce: string;
}

export interface OwnerFileLockDeps {
  now(): number;
  sleep(ms: number): void;
  nonce(): string;
  pid(): number;
  pidLiveness(pid: number): PidLiveness;
  processStartIdentity(pid: number): string | null;
}

export interface OwnerFileLockHooks {
  beforeStaleOwnerUnlink?(input: {
    lockPath: string;
    owner: {
      pid: number;
      process_start_id: string;
      nonce: string;
    };
  }): void;
}

export interface OwnerFileLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  maxRetries?: number;
  deps?: Partial<OwnerFileLockDeps>;
  hooks?: OwnerFileLockHooks;
}

type OwnerInspection =
  | { kind: "missing" }
  | { kind: "ambiguous" }
  | { kind: "owner"; owner: OwnerRecord; stat: Stats };

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function defaultPidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (isErrno(error, "ESRCH")) return "dead";
    if (isErrno(error, "EPERM")) return "alive";
    return "unknown";
  }
}

function linuxProcStartIdentity(pid: number): string | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const commEnd = raw.lastIndexOf(")");
  if (commEnd < 0) return null;
  const fields = raw
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  const startTime = fields[19];
  if (startTime === undefined || !/^\d+$/.test(startTime)) return null;
  return `linux-proc-starttime:${startTime}`;
}

function darwinPsStartIdentity(pid: number): string | null {
  let raw: string;
  try {
    raw = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER_BYTES,
    });
  } catch {
    return null;
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) return null;
  return `darwin-ps-lstart:${lines[0]}`;
}

function defaultProcessStartIdentity(pid: number): string | null {
  if (!validPid(pid)) return null;
  if (process.platform === "linux") return linuxProcStartIdentity(pid);
  if (process.platform === "darwin") return darwinPsStartIdentity(pid);
  return null;
}

function resolveDeps(deps: Partial<OwnerFileLockDeps> = {}): OwnerFileLockDeps {
  return {
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? sleepSync,
    nonce: deps.nonce ?? (() => randomBytes(OWNER_NONCE_BYTES).toString("hex")),
    pid: deps.pid ?? (() => process.pid),
    pidLiveness: deps.pidLiveness ?? defaultPidLiveness,
    processStartIdentity:
      deps.processStartIdentity ?? defaultProcessStartIdentity,
  };
}

function validPid(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= PID_MAX
  );
}

function validNonce(value: unknown): value is string {
  return typeof value === "string" && OWNER_NONCE_RE.test(value);
}

function validProcessStartId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= OWNER_START_ID_MAX_BYTES &&
    !/[\0\r\n]/.test(value)
  );
}

function readProcessStartIdentity(
  deps: OwnerFileLockDeps,
  pid: number,
): string | null {
  let identity: string | null;
  try {
    identity = deps.processStartIdentity(pid);
  } catch {
    return null;
  }
  return validProcessStartId(identity) ? identity : null;
}

function encodeOwner(owner: OwnerRecord): string {
  return `${JSON.stringify(owner)}\n`;
}

function parseOwner(raw: string): OwnerRecord | null {
  if (Buffer.byteLength(raw, "utf8") > OWNER_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join("\0") !== "nonce\0pid\0process_start_id\0schema_version") {
    return null;
  }
  if (record.schema_version !== OWNER_SCHEMA_VERSION) return null;
  if (
    !validPid(record.pid) ||
    !validProcessStartId(record.process_start_id) ||
    !validNonce(record.nonce)
  ) {
    return null;
  }
  return {
    schema_version: OWNER_SCHEMA_VERSION,
    pid: record.pid,
    process_start_id: record.process_start_id,
    nonce: record.nonce,
  };
}

function inspectOwner(lockPath: string): OwnerInspection {
  let stat: Stats;
  try {
    stat = lstatSync(lockPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "missing" };
    return { kind: "ambiguous" };
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > OWNER_MAX_BYTES) {
    return { kind: "ambiguous" };
  }
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return { kind: "ambiguous" };
  }
  const owner = parseOwner(raw);
  return owner === null
    ? { kind: "ambiguous" }
    : { kind: "owner", stat, owner };
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type OwnerLiveness = "live" | "stale" | "ambiguous";

function ownerLiveness(
  owner: OwnerRecord,
  deps: OwnerFileLockDeps,
): OwnerLiveness {
  const liveness = deps.pidLiveness(owner.pid);
  if (liveness === "unknown") return "ambiguous";
  if (liveness === "dead") return "stale";
  const processStartId = readProcessStartIdentity(deps, owner.pid);
  if (processStartId === null) return "ambiguous";
  return processStartId === owner.process_start_id ? "live" : "stale";
}

function unlinkSeenOwner(
  lockPath: string,
  seen: Stats,
  failureCode: string,
): "unlinked" | "changed" {
  let current: Stats;
  try {
    current = lstatSync(lockPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "changed";
    throw new Error(failureCode);
  }
  if (!sameFile(seen, current)) return "changed";
  try {
    unlinkSync(lockPath);
    return "unlinked";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "changed";
    throw new Error(failureCode);
  }
}

function reclaimGatePath(lockPath: string): string {
  return `${lockPath}${RECLAIM_GATE_SUFFIX}`;
}

function gateRecoveryPath(gatePath: string): string {
  return `${gatePath}${GATE_RECOVERY_SUFFIX}`;
}

function ownerTempPath(lockPath: string, pid: number, nonce: string): string {
  return join(dirname(lockPath), `.owner-lock-${pid}-${nonce}.tmp`);
}

class OwnerFileLock implements HeldOwnerFileLock {
  private released = false;

  constructor(
    private readonly lockPath: string,
    private readonly owner: OwnerRecord,
  ) {}

  release(): void {
    if (this.released) return;
    const inspected = inspectOwner(this.lockPath);
    if (
      inspected.kind === "owner" &&
      inspected.owner.pid === this.owner.pid &&
      inspected.owner.process_start_id === this.owner.process_start_id &&
      inspected.owner.nonce === this.owner.nonce
    ) {
      try {
        unlinkSync(this.lockPath);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
    this.released = true;
  }
}

function tryLinkOwner(
  lockPath: string,
  owner: OwnerRecord,
): HeldOwnerFileLock | null {
  const tempPath = ownerTempPath(lockPath, owner.pid, owner.nonce);
  writeFileSync(tempPath, encodeOwner(owner), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    linkSync(tempPath, lockPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup of the private temp owner.
    }
    if (isErrno(error, "EEXIST")) return null;
    throw error;
  }
  try {
    unlinkSync(tempPath);
  } catch {
    // The lock path is already linked to the complete owner.
  }
  return new OwnerFileLock(lockPath, owner);
}

function makeOwner(
  pid: number,
  processStartId: string,
  deps: OwnerFileLockDeps,
): OwnerRecord {
  const owner: OwnerRecord = {
    schema_version: OWNER_SCHEMA_VERSION,
    pid,
    process_start_id: processStartId,
    nonce: deps.nonce(),
  };
  if (!validNonce(owner.nonce)) {
    throw new Error("owner-file-lock-owner-invalid");
  }
  return owner;
}

function sleepOrTimeout(
  deps: OwnerFileLockDeps,
  retryMs: number,
  deadlineMs: number,
  retries: number,
  maxRetries: number,
): number {
  const remainingMs = deadlineMs - deps.now();
  if (remainingMs <= 0 || retries >= maxRetries) {
    throw new Error("owner-file-lock-timeout");
  }
  deps.sleep(Math.min(retryMs, remainingMs));
  return retries + 1;
}

function acquireUnrecoveredOwnerFileLock(
  lockPath: string,
  deps: OwnerFileLockDeps,
  pid: number,
  processStartId: string,
  retryMs: number,
  deadlineMs: number,
  maxRetries: number,
  ambiguousCode: string,
): HeldOwnerFileLock {
  let retries = 0;
  while (true) {
    const acquired = tryLinkOwner(
      lockPath,
      makeOwner(pid, processStartId, deps),
    );
    if (acquired !== null) return acquired;
    const inspected = inspectOwner(lockPath);
    if (inspected.kind === "missing") {
      if (retries >= maxRetries) throw new Error("owner-file-lock-timeout");
      retries += 1;
      continue;
    }
    if (inspected.kind === "ambiguous") throw new Error(ambiguousCode);
    if (ownerLiveness(inspected.owner, deps) !== "live") {
      throw new Error(ambiguousCode);
    }
    retries = sleepOrTimeout(deps, retryMs, deadlineMs, retries, maxRetries);
  }
}

function waitForNoGateRecovery(
  recoveryPath: string,
  deps: OwnerFileLockDeps,
  retryMs: number,
  deadlineMs: number,
  maxRetries: number,
): void {
  let retries = 0;
  while (true) {
    const inspected = inspectOwner(recoveryPath);
    if (inspected.kind === "missing") return;
    if (inspected.kind === "ambiguous") {
      throw new Error("owner-file-lock-ambiguous-reclaim-gate");
    }
    if (ownerLiveness(inspected.owner, deps) !== "live") {
      throw new Error("owner-file-lock-ambiguous-reclaim-gate");
    }
    retries = sleepOrTimeout(deps, retryMs, deadlineMs, retries, maxRetries);
  }
}

function recoverStaleGate(
  gatePath: string,
  recoveryPath: string,
  deps: OwnerFileLockDeps,
  pid: number,
  processStartId: string,
  retryMs: number,
  deadlineMs: number,
  maxRetries: number,
): void {
  const recovery = acquireUnrecoveredOwnerFileLock(
    recoveryPath,
    deps,
    pid,
    processStartId,
    retryMs,
    deadlineMs,
    maxRetries,
    "owner-file-lock-ambiguous-reclaim-gate",
  );
  try {
    const inspected = inspectOwner(gatePath);
    if (inspected.kind === "missing") return;
    if (inspected.kind === "ambiguous") {
      throw new Error("owner-file-lock-ambiguous-reclaim-gate");
    }
    const liveness = ownerLiveness(inspected.owner, deps);
    if (liveness === "ambiguous") {
      throw new Error("owner-file-lock-ambiguous-reclaim-gate");
    }
    if (liveness === "stale") {
      unlinkSeenOwner(
        gatePath,
        inspected.stat,
        "owner-file-lock-ambiguous-reclaim-gate",
      );
    }
  } finally {
    recovery.release();
  }
}

function acquireReclaimGate(
  lockPath: string,
  deps: OwnerFileLockDeps,
  pid: number,
  processStartId: string,
  retryMs: number,
  deadlineMs: number,
  maxRetries: number,
): HeldOwnerFileLock {
  const gatePath = reclaimGatePath(lockPath);
  const recoveryPath = gateRecoveryPath(gatePath);
  let retries = 0;
  while (true) {
    waitForNoGateRecovery(recoveryPath, deps, retryMs, deadlineMs, maxRetries);
    const acquired = tryLinkOwner(
      gatePath,
      makeOwner(pid, processStartId, deps),
    );
    if (acquired !== null) return acquired;
    const inspected = inspectOwner(gatePath);
    if (inspected.kind === "missing") {
      if (retries >= maxRetries) throw new Error("owner-file-lock-timeout");
      retries += 1;
      continue;
    }
    if (inspected.kind === "ambiguous") {
      throw new Error("owner-file-lock-ambiguous-reclaim-gate");
    }
    const liveness = ownerLiveness(inspected.owner, deps);
    if (liveness === "ambiguous") {
      throw new Error("owner-file-lock-ambiguous-reclaim-gate");
    }
    if (liveness === "stale") {
      recoverStaleGate(
        gatePath,
        recoveryPath,
        deps,
        pid,
        processStartId,
        retryMs,
        deadlineMs,
        maxRetries,
      );
      continue;
    }
    retries = sleepOrTimeout(deps, retryMs, deadlineMs, retries, maxRetries);
  }
}

export function acquireOwnerFileLock(
  lockPath: string,
  options: OwnerFileLockOptions = {},
): HeldOwnerFileLock {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deps = resolveDeps(options.deps);
  const pid = deps.pid();
  if (!validPid(pid)) throw new Error("owner-file-lock-owner-invalid");
  const processStartId = readProcessStartIdentity(deps, pid);
  if (processStartId === null) {
    throw new Error("owner-file-lock-owner-identity-unavailable");
  }
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const retryMs = Math.max(1, options.retryMs ?? DEFAULT_RETRY_MS);
  const maxRetries = Math.max(
    0,
    options.maxRetries ?? Math.ceil(timeoutMs / retryMs) + 1,
  );
  const deadlineMs = deps.now() + timeoutMs;
  let retries = 0;

  while (true) {
    const gate = acquireReclaimGate(
      lockPath,
      deps,
      pid,
      processStartId,
      retryMs,
      deadlineMs,
      maxRetries,
    );
    let sleepForLiveOwner = false;
    try {
      const acquired = tryLinkOwner(
        lockPath,
        makeOwner(pid, processStartId, deps),
      );
      if (acquired !== null) return acquired;

      const inspected = inspectOwner(lockPath);
      if (inspected.kind === "missing") {
        if (retries >= maxRetries) throw new Error("owner-file-lock-timeout");
        retries += 1;
        continue;
      }
      if (inspected.kind === "ambiguous") {
        throw new Error("owner-file-lock-ambiguous-owner");
      }

      const liveness = ownerLiveness(inspected.owner, deps);
      if (liveness === "ambiguous") {
        throw new Error("owner-file-lock-ambiguous-owner");
      }
      if (liveness === "stale") {
        options.hooks?.beforeStaleOwnerUnlink?.({
          lockPath,
          owner: {
            pid: inspected.owner.pid,
            process_start_id: inspected.owner.process_start_id,
            nonce: inspected.owner.nonce,
          },
        });
        const removed = unlinkSeenOwner(
          lockPath,
          inspected.stat,
          "owner-file-lock-unlink-failed",
        );
        if (removed === "unlinked") {
          const reclaimed = tryLinkOwner(
            lockPath,
            makeOwner(pid, processStartId, deps),
          );
          if (reclaimed !== null) return reclaimed;
        }
        if (retries >= maxRetries) throw new Error("owner-file-lock-timeout");
        retries += 1;
        continue;
      }
      sleepForLiveOwner = true;
    } finally {
      gate.release();
    }
    if (sleepForLiveOwner) {
      retries = sleepOrTimeout(deps, retryMs, deadlineMs, retries, maxRetries);
    }
  }
}
