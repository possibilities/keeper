/**
 * The dependency-light CONTRACT for the incident-claim spool: the
 * on-disk request layout and the pure read/write helpers the session-side
 * `keeper incident` CLI (the writer) and the daemon incident-claim producer (the
 * reader/validator) share.
 *
 * A live owning session pulls a merge incident (via the escalation-brief incident
 * surface) and records its ownership through the SAME spool-request contract as the
 * suite-baseline store (docs/adr/0005): the session writes ONE bounded request
 * leaf, the daemon producer validates claimant liveness and mints the synthetic
 * `IncidentClaimed` / `IncidentReleased` event, and the fold records the claim.
 * There is NO socket, NO RPC, and NO session DB write.
 *
 * DEPENDENCY POSTURE: `node:*` plus the pure `derivers` and dep-free
 * `keeper-state-dir` leaves — NEVER `bun:sqlite` / `src/db.ts`. Helpers follow
 * the baseline-store shape: fail-open parse, atomic write, one bounded JSON
 * object per request.
 *
 * SECURITY: the spool is a NEW session-writable surface. Every field is validated
 * and size-capped on both write and parse; a request the producer cannot verify
 * (dead / unverifiable claimant, no matching open incident) is refused and
 * discarded, never trusted.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parsePlanRef } from "./derivers";
import { keeperStateDir } from "./keeper-state-dir";

// ── layout + bounds ──────────────────────────────────────────────────────────

/** `<state-dir>/incident-claims/` — the store root. */
const INCIDENT_CLAIM_DIRNAME = "incident-claims";
/** `<root>/requests/` — the request spool (maildir shape). */
const SPOOL_DIRNAME = "requests";

/** Envelope schema version for an incident-claim spool request. */
export const INCIDENT_CLAIM_REQUEST_SCHEMA_VERSION = 1;

/** Hard cap on a single request document — the spool is session-writable, so the
 *  reader never allocates or parses beyond this many UTF-8 bytes. */
export const MAX_REQUEST_BYTES = 16 * 1024;
/** Max UTF-8 bytes of any single id/session string field. */
export const MAX_ID_BYTES = 512;
/** Per-tick directory-work cap. Remaining entries stay queued for the next tick. */
export const MAX_REQUESTS_PER_SWEEP = 256;

// ── the request record ─────────────────────────────────────────────────────

/** Whether a request claims an incident or releases a prior claim. */
export type IncidentClaimAction = "claim" | "release";

/**
 * One incident-claim spool entry. Sanctioned writer: the `keeper incident`
 * CLI (the owning session). The producer keys idempotency on `(verb, id,
 * instanceEventId, action, claimantSessionId)` — a re-write of the same tuple is
 * consumed as an idempotent no-op once the projection already reflects it.
 *
 * `claimantSessionId` is the session's OWN tracked identity (resolved from its
 * launch env); the producer resolves that session's `jobs` row for the pid +
 * start_time it probes, so the request never carries the process generation the
 * session cannot recycle-safely know about itself.
 */
export interface IncidentClaimRequest {
  schema_version: number;
  action: IncidentClaimAction;
  /** The incident's dispatch-key verb — `work` or `close`. */
  verb: string;
  /** The incident's dispatch-key id — a task id (`work`) or epic id (`close`). */
  id: string;
  /** The incident-fence: the sticky row's first-appearance `instance_event_id`. */
  instance_event_id: number;
  /** The claiming session's tracked identity (job id). */
  claimant_session_id: string;
  /** Unix-ms mint moment (observability only; the producer clocks its own tick). */
  requested_at: number;
}

// ── paths ────────────────────────────────────────────────────────────────────

/** Strip anything an id could not legitimately contain — traversal guard. */
function sanitizeComponent(s: string): string {
  return s.replace(/[^0-9a-zA-Z_-]/g, "").slice(0, 128) || "invalid";
}

/** `<state-dir>/incident-claims/`. */
export function incidentClaimRoot(stateDir: string = keeperStateDir()): string {
  return join(stateDir, INCIDENT_CLAIM_DIRNAME);
}

/** `<root>/requests/` — the request spool dir. */
export function spoolDir(stateDir?: string): string {
  return join(incidentClaimRoot(stateDir), SPOOL_DIRNAME);
}

/** The spool-file path for a request id. */
export function requestPath(requestId: string, stateDir?: string): string {
  return join(spoolDir(stateDir), `${sanitizeComponent(requestId)}.json`);
}

/** Mint a fresh spool-file id. */
export function newRequestId(): string {
  return randomUUID();
}

// ── construction ────────────────────────────────────────────────────────────

/** Build a well-formed claim/release request. */
export function buildRequest(input: {
  action: IncidentClaimAction;
  verb: string;
  id: string;
  instanceEventId: number;
  claimantSessionId: string;
  requestedAt: number;
}): IncidentClaimRequest {
  return {
    schema_version: INCIDENT_CLAIM_REQUEST_SCHEMA_VERSION,
    action: input.action,
    verb: input.verb,
    id: input.id,
    instance_event_id: input.instanceEventId,
    claimant_session_id: input.claimantSessionId,
    requested_at: input.requestedAt,
  };
}

// ── read/write seams ────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function byteLengthWithin(value: string, max: number): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= max;
}

/** Whether `(verb, id)` is one of the two claimable natural incident keys. */
export function isClaimableIncidentIdentity(verb: string, id: string): boolean {
  if (!byteLengthWithin(verb, MAX_ID_BYTES)) return false;
  if (!byteLengthWithin(id, MAX_ID_BYTES)) return false;
  const ref = parsePlanRef(id);
  return (
    (verb === "work" && ref?.kind === "task") ||
    (verb === "close" && ref?.kind === "epic")
  );
}

/**
 * FAIL-OPEN parse of a spool body → a typed request or `null`. Any malformed body
 * (not JSON, wrong shape, wrong schema version, oversized, bad action/key) yields
 * `null` so the producer discards it rather than acting on an untrusted request.
 * Oversized fields REJECT rather than truncate: truncating a claimant or incident
 * id could turn an invalid request into a different valid identity.
 */
export function parseRequest(raw: string): IncidentClaimRequest | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.schema_version !== INCIDENT_CLAIM_REQUEST_SCHEMA_VERSION) {
    return null;
  }
  if (parsed.action !== "claim" && parsed.action !== "release") return null;
  if (
    typeof parsed.verb !== "string" ||
    typeof parsed.id !== "string" ||
    !isClaimableIncidentIdentity(parsed.verb, parsed.id)
  ) {
    return null;
  }
  if (
    typeof parsed.instance_event_id !== "number" ||
    !Number.isSafeInteger(parsed.instance_event_id) ||
    parsed.instance_event_id <= 0
  ) {
    return null;
  }
  if (
    typeof parsed.claimant_session_id !== "string" ||
    !byteLengthWithin(parsed.claimant_session_id, MAX_ID_BYTES)
  ) {
    return null;
  }
  if (
    typeof parsed.requested_at !== "number" ||
    !Number.isFinite(parsed.requested_at)
  ) {
    return null;
  }
  return {
    schema_version: INCIDENT_CLAIM_REQUEST_SCHEMA_VERSION,
    action: parsed.action,
    verb: parsed.verb,
    id: parsed.id,
    instance_event_id: parsed.instance_event_id,
    claimant_session_id: parsed.claimant_session_id,
    requested_at: parsed.requested_at,
  };
}

/**
 * Bounded read + fail-open parse of one spool entry. The descriptor is opened
 * `O_NOFOLLOW`, fstat-checked as a regular file, and read into a fixed
 * `MAX_REQUEST_BYTES + 1` buffer, so a size-race cannot turn the spool into an
 * unbounded allocation. Missing, symlinked, oversized, or malformed → `null`.
 */
export function readRequest(path: string): IncidentClaimRequest | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return null;
    const bytes = Buffer.allocUnsafe(MAX_REQUEST_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (n === 0) break;
      offset += n;
    }
    if (offset > MAX_REQUEST_BYTES) return null;
    return parseRequest(bytes.subarray(0, offset).toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // A failed close cannot make an unreadable request authoritative.
      }
    }
  }
}

/** One spooled request, with its own file path for a post-process unlink. */
export interface SpooledRequest {
  path: string;
  request: IncidentClaimRequest;
}

function isPlainDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isSafeSpoolDirectory(path: string): boolean {
  return isPlainDirectory(path) && isPlainDirectory(dirname(path));
}

/**
 * List a bounded batch of readable requests. Fail-open: an absent, unreadable,
 * or symlinked spool reads as empty. Malformed JSON entries are removed only
 * after the parent directory passes the no-symlink confinement check; valid
 * entries remain until the producer mints or deliberately refuses them. Every
 * directory entry consumes the per-tick budget, so unrelated files cannot make
 * one sweep unbounded.
 */
export function readSpool(stateDir?: string): SpooledRequest[] {
  const dirPath = spoolDir(stateDir);
  if (!isSafeSpoolDirectory(dirPath)) return [];
  let dir: ReturnType<typeof opendirSync> | null = null;
  const out: SpooledRequest[] = [];
  let inspected = 0;
  try {
    dir = opendirSync(dirPath);
    while (inspected < MAX_REQUESTS_PER_SWEEP) {
      const entry = dir.readSync();
      if (entry === null) break;
      inspected += 1;
      if (!entry.name.endsWith(".json")) continue;
      const path = join(dirPath, entry.name);
      const request = readRequest(path);
      if (request === null) {
        removeRequest(path);
      } else {
        out.push({ path, request });
      }
    }
    return out.sort(
      (a, b) =>
        a.request.requested_at - b.request.requested_at ||
        a.path.localeCompare(b.path),
    );
  } catch {
    return out;
  } finally {
    try {
      dir?.closeSync();
    } catch {
      // A failed directory close changes no request semantics.
    }
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isSafeSpoolDirectory(dir)) {
    throw new Error("incident-claim spool directory is not confined");
  }
}

/** Atomically persist one validated, size-bounded spool entry. Sole writer:
 *  the `keeper incident` CLI. Invalid input throws before touching the spool. */
export function writeRequest(
  path: string,
  request: IncidentClaimRequest,
): void {
  const body = JSON.stringify(request);
  if (parseRequest(body) === null) {
    throw new TypeError("invalid incident-claim request");
  }
  ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Swallow — the original write error is what the caller cares about.
    }
    throw err;
  }
}

/** Remove a processed spool entry only beneath a non-symlink directory.
 *  Idempotent — a missing or unconstrained parent is a no-op. */
export function removeRequest(path: string): void {
  try {
    if (!isSafeSpoolDirectory(dirname(path))) return;
    unlinkSync(path);
  } catch {
    // Already gone (a concurrent producer, or never written) — nothing to do.
  }
}
