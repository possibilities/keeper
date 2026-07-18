// Owner-private escalation grant leaf — the dep-free confinement primitive the
// grant-guard hook and its sibling guards read to authorize an in-session
// escalation subagent's mutations (ADR 0089). A grant is daemon-minted, owner-
// private, and carries the whole tuple a mutating call must satisfy: the parent
// job that owns the subagent, the exact escalation agent type, the incident
// instance plus its fencing identities, the writable root, the role, an expiry,
// and a monotonic fencing token. Every consumer validates the WHOLE tuple at the
// mutation — a grant that merely EXISTS is bypassable.
//
// node:* only (node:crypto for the path hash) so a PreToolUse hook may import it
// with no bun:sqlite / db surface. The leaf lives under a 0o700 owner-private
// directory; the reader validates the descriptor it read from (anti-TOCTOU
// fstat), never a re-stat of the path.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export const GRANT_LEAF_SCHEMA_VERSION = 1 as const;

/** The four confined escalation roles and their agent types. Role names match the
 *  legacy escalation vocabulary (`unblock`/`resolve`/`deconflict`/`repair`); agent
 *  types are the `agent_type` the hook payload carries for each Task subagent. */
export type EscalationRole = "unblock" | "resolve" | "deconflict" | "repair";
export type EscalationAgentType =
  | "unblocker"
  | "merge-resolver"
  | "deconflicter"
  | "repairer";

export const ESCALATION_AGENT_ROLE: Readonly<
  Record<EscalationAgentType, EscalationRole>
> = {
  unblocker: "unblock",
  "merge-resolver": "resolve",
  deconflicter: "deconflict",
  repairer: "repair",
};

/** The roles permitted to write source under a valid grant. `unblock` is
 *  DIAGNOSIS-only: an unblocker never writes source, even holding a grant. */
const WRITE_CAPABLE_ROLES: ReadonlySet<EscalationRole> = new Set([
  "resolve",
  "deconflict",
  "repair",
]);

/** Resolve a payload `agent_type` to its escalation role, or null when it is not
 *  one of the four confined agents (outside the grant guard's jurisdiction). */
export function escalationRoleFor(
  agentType: string | undefined,
): EscalationRole | null {
  if (agentType === undefined) return null;
  return Object.hasOwn(ESCALATION_AGENT_ROLE, agentType)
    ? ESCALATION_AGENT_ROLE[agentType as EscalationAgentType]
    : null;
}

export function roleIsWriteCapable(role: EscalationRole): boolean {
  return WRITE_CAPABLE_ROLES.has(role);
}

/** The daemon-minted grant, serialized as the leaf's JSON body. */
export interface GrantLeaf {
  schema_version: number;
  parent_job_id: string;
  agent_type: EscalationAgentType;
  incident_id: string;
  /** Fencing identities per the incident-fenced-clear discipline (ADR 0070). */
  attempt_id: string;
  instance_event_id: number;
  writable_root: string;
  role: EscalationRole;
  /** Epoch-ms deadline; a call at or past it is `expired`. */
  expires_at: number;
  /** Daemon-minted monotonic token; the running subagent's launch env pins the
   *  value it may honor, so a resurrected older leaf never validates. */
  fencing_token: number;
}

/** What a consumer independently knows about the call it is validating — the
 *  running subagent's launch identity (env) plus its payload `agent_type`. The
 *  reader rejects any leaf whose tuple does not match this exactly. */
export interface GrantExpectation {
  parentJobId: string;
  agentType: string;
  incidentId: string;
  fencingToken: number;
  attemptId?: string;
  instanceEventId?: number;
}

export type GrantVerdict =
  | { kind: "valid"; grant: GrantLeaf }
  | { kind: "absent" }
  | { kind: "expired" }
  | { kind: "tuple-mismatch"; detail: string }
  | { kind: "malformed"; detail: string };

// ---------------------------------------------------------------------------
// Leaf-path derivation — the ONE function every consumer shares.
// ---------------------------------------------------------------------------

/** The deterministic owner-private path a `(parentJob, agentType)` grant lives
 *  at. A hash keeps the name fixed-length and filesystem-safe regardless of the
 *  ids' characters; a consumer derives the exact path from the identity it is
 *  validating, so a subagent cannot redirect the lookup at a forged leaf. */
export function deriveGrantLeafPath(
  grantsDir: string,
  parentJobId: string,
  agentType: string,
): string {
  const digest = createHash("sha256")
    .update(parentJobId)
    .update("\n")
    .update(agentType)
    .digest("hex")
    .slice(0, 32);
  return join(grantsDir, `grant-${digest}.json`);
}

// ---------------------------------------------------------------------------
// Path predicates shared by the grant guard and its siblings.
// ---------------------------------------------------------------------------

function segmentsOf(canonical: string): string[] {
  return canonical.split(sep).filter((s) => s.length > 0);
}

/** True when `canonical` is at or beneath `root` (both already canonical). */
export function writableRootCovers(root: string, canonical: string): boolean {
  if (root === "" || !isAbsolute(root)) return false;
  const rel = relative(root, canonical);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** Paths a grant NEVER authorizes — denied even under a valid grant: git repo
 *  config and hook scripts (repo-config / hook injection), credential files, and
 *  harness hook/MCP configuration (which could re-arm or disarm the guards). */
export function isGrantProtectedPath(canonical: string): boolean {
  const segs = segmentsOf(canonical);
  for (let i = 0; i + 1 < segs.length; i++) {
    const a = segs[i] as string;
    const b = segs[i + 1] as string;
    if (a === ".git" && (b === "config" || b === "hooks")) return true;
    if (a === ".aws" && b === "credentials") return true;
    if (
      a === ".claude" &&
      (b === "settings.json" || b === "settings.local.json")
    )
      return true;
  }
  if (segs.includes(".ssh")) return true;
  if (segs.includes(".claude-plugin")) return true;
  const base = segs.length > 0 ? (segs[segs.length - 1] as string) : "";
  return (
    base === ".git-credentials" ||
    base === ".netrc" ||
    base === ".mcp.json" ||
    base === "hooks.json"
  );
}

// ---------------------------------------------------------------------------
// Reader — anti-TOCTOU fstat, typed verdicts.
// ---------------------------------------------------------------------------

// O_CLOEXEC differs by platform; mirror wrapped-guard's resolution.
const O_CLOEXEC = process.platform === "darwin" ? 0x1000000 : 0o2000000;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Open + validate a single leaf's descriptor, returning its bytes or a verdict.
 *  The descriptor we fstat is the one we read, so no path re-resolution window
 *  exists: a symlink swap (O_NOFOLLOW), a hardlink (nlink !== 1), a foreign owner
 *  (uid), or a group/world-accessible mode all reject as malformed/absent. */
function readOwnerPrivateLeaf(
  path: string,
): { bytes: string } | { verdict: GrantVerdict } {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC);
  } catch (error) {
    if (isEnoent(error)) return { verdict: { kind: "absent" } };
    // ELOOP (symlink), EACCES, etc. — cannot positively clear → malformed.
    return { verdict: { kind: "malformed", detail: "leaf unopenable" } };
  }
  try {
    const st = fstatSync(fd);
    const getuid = process.getuid;
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      (st.mode & 0o077) !== 0 ||
      (getuid !== undefined && st.uid !== getuid.call(process))
    ) {
      return {
        verdict: { kind: "malformed", detail: "leaf not owner-private" },
      };
    }
    return { bytes: readFileSync(fd, "utf8") };
  } catch {
    return { verdict: { kind: "malformed", detail: "leaf unreadable" } };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function parseGrant(bytes: string): GrantLeaf | null {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  const agentType = g.agent_type;
  const role = g.role;
  if (
    g.schema_version !== GRANT_LEAF_SCHEMA_VERSION ||
    typeof g.parent_job_id !== "string" ||
    g.parent_job_id === "" ||
    typeof agentType !== "string" ||
    escalationRoleFor(agentType) === null ||
    typeof g.incident_id !== "string" ||
    g.incident_id === "" ||
    typeof g.attempt_id !== "string" ||
    g.attempt_id === "" ||
    typeof g.instance_event_id !== "number" ||
    !Number.isFinite(g.instance_event_id) ||
    typeof g.writable_root !== "string" ||
    !isAbsolute(g.writable_root) ||
    typeof role !== "string" ||
    role !== ESCALATION_AGENT_ROLE[agentType as EscalationAgentType] ||
    typeof g.expires_at !== "number" ||
    !Number.isFinite(g.expires_at) ||
    typeof g.fencing_token !== "number" ||
    !Number.isFinite(g.fencing_token)
  ) {
    return null;
  }
  return g as unknown as GrantLeaf;
}

/** Read the grant for `expected` from `grantsDir` and validate the whole tuple.
 *  `now` is epoch-ms (the caller's clock — a producer probes time, never a fold).
 *  Returns exactly one typed verdict. */
export function readGrantLeaf(
  grantsDir: string,
  expected: GrantExpectation,
  now: number,
): GrantVerdict {
  if (grantsDir === "" || !isAbsolute(grantsDir)) return { kind: "absent" };
  const path = deriveGrantLeafPath(
    grantsDir,
    expected.parentJobId,
    expected.agentType,
  );
  const read = readOwnerPrivateLeaf(path);
  if ("verdict" in read) return read.verdict;
  const grant = parseGrant(read.bytes);
  if (grant === null)
    return { kind: "malformed", detail: "leaf shape invalid" };

  if (grant.parent_job_id !== expected.parentJobId)
    return { kind: "tuple-mismatch", detail: "parent job" };
  if (grant.agent_type !== expected.agentType)
    return { kind: "tuple-mismatch", detail: "agent type" };
  if (grant.incident_id !== expected.incidentId)
    return { kind: "tuple-mismatch", detail: "incident" };
  if (grant.fencing_token !== expected.fencingToken)
    return { kind: "tuple-mismatch", detail: "fencing token" };
  if (
    expected.attemptId !== undefined &&
    grant.attempt_id !== expected.attemptId
  )
    return { kind: "tuple-mismatch", detail: "attempt" };
  if (
    expected.instanceEventId !== undefined &&
    grant.instance_event_id !== expected.instanceEventId
  )
    return { kind: "tuple-mismatch", detail: "instance event" };
  if (now >= grant.expires_at) return { kind: "expired" };
  return { kind: "valid", grant };
}

// ---------------------------------------------------------------------------
// Writer — owner-private directory, fresh leaf per write, atomic publish.
// ---------------------------------------------------------------------------

const MAX_GRANT_BYTES = 8192;

/** Publish `grant` under `grantsDir` (created 0o700 if absent). Writes a fresh
 *  O_EXCL|O_NOFOLLOW temp leaf, fsyncs, then atomically renames it onto the
 *  derived path so a reader never observes a partial or inode-swapped leaf.
 *  Returns false (never throws) on any failure — the daemon is the sole caller. */
export function writeGrantLeaf(grantsDir: string, grant: GrantLeaf): boolean {
  if (grantsDir === "" || !isAbsolute(grantsDir)) return false;
  if (
    escalationRoleFor(grant.agent_type) === null ||
    grant.role !== ESCALATION_AGENT_ROLE[grant.agent_type] ||
    !isAbsolute(grant.writable_root)
  ) {
    return false;
  }
  const canonicalWritableRoot = realpathNearest(grant.writable_root);
  if (canonicalWritableRoot === null) return false;
  const publishedGrant: GrantLeaf = {
    ...grant,
    writable_root: canonicalWritableRoot,
  };
  const bytes = Buffer.from(`${JSON.stringify(publishedGrant)}\n`, "utf8");
  if (bytes.byteLength > MAX_GRANT_BYTES) return false;
  const finalPath = deriveGrantLeafPath(
    grantsDir,
    grant.parent_job_id,
    grant.agent_type,
  );
  const tmpPath = join(
    grantsDir,
    `.${basename(finalPath)}.tmp.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  let fd: number | null = null;
  try {
    mkdirSync(grantsDir, { recursive: true, mode: 0o700 });
    fd = openSync(
      tmpPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        O_CLOEXEC,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (count <= 0) return false;
      offset += count;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, finalPath);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed / never opened
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Grant-override primitive — the ONE predicate the sibling guards share.
// ---------------------------------------------------------------------------

/** The env keys a consumer reads to build its `GrantExpectation`. The daemon
 *  injects these into an escalation subagent's owning session at launch. */
export interface GrantEnv {
  KEEPER_GRANT_DIR?: string;
  KEEPER_GRANT_PARENT_JOB?: string;
  KEEPER_GRANT_INCIDENT?: string;
  KEEPER_GRANT_FENCING_TOKEN?: string;
  KEEPER_GRANT_ATTEMPT?: string;
  KEEPER_GRANT_INSTANCE_EVENT?: string;
}

/** Build the launch-anchored expectation for `agentType`, or null when the env
 *  lacks a core field (no launch identity → no grant can validate). */
export function grantExpectationFromEnv(
  env: GrantEnv,
  agentType: string,
): GrantExpectation | null {
  const parentJobId = (env.KEEPER_GRANT_PARENT_JOB ?? "").trim();
  const incidentId = (env.KEEPER_GRANT_INCIDENT ?? "").trim();
  const tokenRaw = (env.KEEPER_GRANT_FENCING_TOKEN ?? "").trim();
  if (parentJobId === "" || incidentId === "" || tokenRaw === "") return null;
  const fencingToken = Number(tokenRaw);
  if (!Number.isFinite(fencingToken)) return null;
  const attempt = (env.KEEPER_GRANT_ATTEMPT ?? "").trim();
  const instanceRaw = (env.KEEPER_GRANT_INSTANCE_EVENT ?? "").trim();
  const expectation: GrantExpectation = {
    parentJobId,
    agentType,
    incidentId,
    fencingToken,
  };
  if (attempt !== "") expectation.attemptId = attempt;
  if (instanceRaw !== "") {
    const n = Number(instanceRaw);
    if (Number.isFinite(n)) expectation.instanceEventId = n;
  }
  return expectation;
}

export function grantsDirOf(env: GrantEnv): string {
  return (env.KEEPER_GRANT_DIR ?? "").trim();
}

/** The shared grant-override decision: does a valid, unexpired, write-capable
 *  grant for THIS escalation subagent cover a source write to `canonicalTarget`?
 *  False for any non-escalation agent, the diagnosis-only unblocker, a protected
 *  path, a target outside the writable root, or any non-valid verdict. The
 *  sibling guards call this before emitting a would-be deny; grant-guard shares
 *  the same tuple/expiry/role/root logic. */
export function grantCoversWrite(
  env: GrantEnv,
  agentType: string | undefined,
  canonicalTarget: string,
  now: number,
): boolean {
  const role = escalationRoleFor(agentType);
  if (role === null || !roleIsWriteCapable(role)) return false;
  if (isGrantProtectedPath(canonicalTarget)) return false;
  const expectation = grantExpectationFromEnv(env, agentType as string);
  if (expectation === null) return false;
  const verdict = readGrantLeaf(grantsDirOf(env), expectation, now);
  if (verdict.kind !== "valid") return false;
  return writableRootCovers(verdict.grant.writable_root, canonicalTarget);
}

/** Canonicalize `abs`, falling back to the nearest existing ancestor + missing
 *  tail for a create-new path; null when nothing on the chain resolves. Shared
 *  create-new-safe realpath used by the guards' production probes. */
export function realpathNearest(abs: string): string | null {
  try {
    return realpathSync(abs);
  } catch {
    const tail: string[] = [];
    let cur = abs;
    for (let guard = 0; guard < 4096; guard++) {
      const parent = dirname(cur);
      if (parent === cur) return null;
      tail.unshift(basename(cur));
      cur = parent;
      try {
        return join(realpathSync(cur), ...tail);
      } catch {
        // keep walking up
      }
    }
    return null;
  }
}
