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

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export const GRANT_LEAF_SCHEMA_VERSION = 1 as const;
export const TRUNK_LEASE_SCHEMA_VERSION = 1 as const;
export const TRUNK_LEASE_REQUEST_SCHEMA_VERSION = 1 as const;
export const TRUNK_LEASE_TTL_MS = 120_000;

export interface TrunkLeaseRequest {
  schema_version: number;
  action: "acquire" | "release";
  epic_id: string;
  repo_root: string;
  source_branch: string;
  claimant_session_id: string;
  request_id: string;
  fencing_token: number | null;
  requested_at: number;
}

export interface TrunkLeaseLeaf {
  schema_version: number;
  active: boolean;
  epic_id: string;
  claimant_session_id: string;
  claimant_pid: number;
  claimant_start_time: string;
  acquisition_id: string;
  repo_root: string;
  writable_root: string;
  source_branch: string;
  default_branch: string;
  observed_default_tip: string;
  expires_at: number;
  fencing_token: number;
}

export interface SpooledTrunkLeaseRequest {
  path: string;
  request: TrunkLeaseRequest;
}

const TRUNK_LEASE_DIRNAME = "trunk-leases";
const TRUNK_LEASE_REQUEST_DIRNAME = "requests";
const TRUNK_LEASE_LEAF_DIRNAME = "leases";
const MAX_TRUNK_LEASE_BYTES = 16 * 1024;
const MAX_TRUNK_LEASE_REQUESTS = 256;
const MAX_GRANT_REAP_INSPECTIONS = 256;

function trunkLeaseRepoDigest(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 32);
}

export function trunkLeaseRoot(stateDir: string): string {
  return join(stateDir, TRUNK_LEASE_DIRNAME);
}

export function trunkLeaseRequestDir(stateDir: string): string {
  return join(trunkLeaseRoot(stateDir), TRUNK_LEASE_REQUEST_DIRNAME);
}

export function trunkLeaseLeafDir(stateDir: string): string {
  return join(trunkLeaseRoot(stateDir), TRUNK_LEASE_LEAF_DIRNAME);
}

export function deriveTrunkLeaseLeafPath(
  stateDir: string,
  repoRoot: string,
): string {
  return join(
    trunkLeaseLeafDir(stateDir),
    `lease-${trunkLeaseRepoDigest(repoRoot)}.json`,
  );
}

export function newTrunkLeaseRequestPath(stateDir: string): string {
  return join(trunkLeaseRequestDir(stateDir), `${randomUUID()}.json`);
}

function validTrunkLeaseIdentity(
  epicId: string,
  sourceBranch: string,
): boolean {
  return (
    /^fn-[0-9]+-[0-9a-z][0-9a-z-]*$/.test(epicId) &&
    sourceBranch === `keeper/epic/${epicId}`
  );
}

function parseTrunkLeaseRequest(raw: string): TrunkLeaseRequest | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_TRUNK_LEASE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const r = value as Record<string, unknown>;
  if (
    r.schema_version !== TRUNK_LEASE_REQUEST_SCHEMA_VERSION ||
    (r.action !== "acquire" && r.action !== "release") ||
    typeof r.epic_id !== "string" ||
    typeof r.repo_root !== "string" ||
    !isAbsolute(r.repo_root) ||
    typeof r.source_branch !== "string" ||
    !validTrunkLeaseIdentity(r.epic_id, r.source_branch) ||
    typeof r.claimant_session_id !== "string" ||
    r.claimant_session_id.length === 0 ||
    Buffer.byteLength(r.claimant_session_id, "utf8") > 512 ||
    typeof r.request_id !== "string" ||
    !/^[0-9a-f]{32}$/.test(r.request_id) ||
    typeof r.requested_at !== "number" ||
    !Number.isFinite(r.requested_at)
  ) {
    return null;
  }
  const token = r.fencing_token;
  if (
    !(
      (r.action === "acquire" && token === null) ||
      (r.action === "release" &&
        typeof token === "number" &&
        Number.isSafeInteger(token) &&
        token > 0)
    )
  ) {
    return null;
  }
  return {
    schema_version: TRUNK_LEASE_REQUEST_SCHEMA_VERSION,
    action: r.action,
    epic_id: r.epic_id,
    repo_root: r.repo_root,
    source_branch: r.source_branch,
    claimant_session_id: r.claimant_session_id,
    request_id: r.request_id,
    fencing_token: token as number | null,
    requested_at: r.requested_at,
  };
}

function parseTrunkLeaseLeaf(raw: string): TrunkLeaseLeaf | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_TRUNK_LEASE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const l = value as Record<string, unknown>;
  if (
    l.schema_version !== TRUNK_LEASE_SCHEMA_VERSION ||
    typeof l.active !== "boolean" ||
    typeof l.epic_id !== "string" ||
    typeof l.source_branch !== "string" ||
    !validTrunkLeaseIdentity(l.epic_id, l.source_branch) ||
    typeof l.claimant_session_id !== "string" ||
    l.claimant_session_id.length === 0 ||
    typeof l.claimant_pid !== "number" ||
    !Number.isSafeInteger(l.claimant_pid) ||
    l.claimant_pid <= 0 ||
    typeof l.claimant_start_time !== "string" ||
    l.claimant_start_time.length === 0 ||
    typeof l.acquisition_id !== "string" ||
    !/^[0-9a-f]{32}$/.test(l.acquisition_id) ||
    typeof l.repo_root !== "string" ||
    !isAbsolute(l.repo_root) ||
    typeof l.writable_root !== "string" ||
    !isAbsolute(l.writable_root) ||
    typeof l.default_branch !== "string" ||
    l.default_branch.length === 0 ||
    typeof l.observed_default_tip !== "string" ||
    !/^[0-9a-f]{7,64}$/.test(l.observed_default_tip) ||
    typeof l.expires_at !== "number" ||
    !Number.isFinite(l.expires_at) ||
    typeof l.fencing_token !== "number" ||
    !Number.isSafeInteger(l.fencing_token) ||
    l.fencing_token <= 0
  ) {
    return null;
  }
  return l as unknown as TrunkLeaseLeaf;
}

function readBoundedPrivateJson(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC);
    const st = fstatSync(fd);
    const getuid = process.getuid;
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      (st.mode & 0o077) !== 0 ||
      (getuid !== undefined && st.uid !== getuid.call(process))
    ) {
      return null;
    }
    const buf = Buffer.allocUnsafe(MAX_TRUNK_LEASE_BYTES + 1);
    let offset = 0;
    while (offset < buf.length) {
      const count = readSync(fd, buf, offset, buf.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    return offset <= MAX_TRUNK_LEASE_BYTES
      ? buf.subarray(0, offset).toString("utf8")
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // unreadable is non-authoritative
      }
    }
  }
}

function plainPrivateDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    const getuid = process.getuid;
    return (
      st.isDirectory() &&
      !st.isSymbolicLink() &&
      (st.mode & 0o077) === 0 &&
      (getuid === undefined || st.uid === getuid.call(process))
    );
  } catch {
    return false;
  }
}

function ensureTrunkLeaseDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!plainPrivateDir(path)) {
    throw new Error("trunk lease directory is not owner-private");
  }
}

function writeAtomicPrivateJson(path: string, value: unknown): boolean {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_TRUNK_LEASE_BYTES) return false;
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    ensureTrunkLeaseDir(dir);
    fd = openSync(
      tmp,
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
    renameSync(tmp, path);
    let dirFd: number | null = null;
    try {
      dirFd = openSync(dir, constants.O_RDONLY | O_CLOEXEC);
      fsyncSync(dirFd);
    } catch {
      // The published rename remains authoritative on filesystems without dir fsync.
    } finally {
      if (dirFd !== null) {
        try {
          closeSync(dirFd);
        } catch {
          // the rename is already published
        }
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // preserve the publication verdict
    }
  }
}

export function writeTrunkLeaseRequest(
  stateDir: string,
  request: TrunkLeaseRequest,
): string | null {
  if (parseTrunkLeaseRequest(JSON.stringify(request)) === null) return null;
  const path = newTrunkLeaseRequestPath(stateDir);
  return writeAtomicPrivateJson(path, request) ? path : null;
}

export function readTrunkLeaseRequests(
  stateDir: string,
): SpooledTrunkLeaseRequest[] {
  const dirPath = trunkLeaseRequestDir(stateDir);
  if (!plainPrivateDir(dirPath)) return [];
  const out: SpooledTrunkLeaseRequest[] = [];
  let dir: ReturnType<typeof opendirSync> | null = null;
  try {
    dir = opendirSync(dirPath);
    for (let n = 0; n < MAX_TRUNK_LEASE_REQUESTS; n += 1) {
      const entry = dir.readSync();
      if (entry === null) break;
      if (!entry.name.endsWith(".json")) continue;
      const path = join(dirPath, entry.name);
      const raw = readBoundedPrivateJson(path);
      const request = raw === null ? null : parseTrunkLeaseRequest(raw);
      if (request === null) {
        removeTrunkLeaseRequest(path);
      } else {
        out.push({ path, request });
      }
    }
  } catch {
    return out;
  } finally {
    try {
      dir?.closeSync();
    } catch {
      // no request semantics depend on closing the directory descriptor
    }
  }
  return out.sort(
    (a, b) =>
      a.request.requested_at - b.request.requested_at ||
      a.path.localeCompare(b.path),
  );
}

export function removeTrunkLeaseRequest(path: string): void {
  try {
    if (!plainPrivateDir(dirname(path))) return;
    unlinkSync(path);
  } catch {
    // idempotent removal
  }
}

export function readTrunkLeaseLeaf(
  stateDir: string,
  repoRoot: string,
): TrunkLeaseLeaf | null {
  const raw = readBoundedPrivateJson(
    deriveTrunkLeaseLeafPath(stateDir, repoRoot),
  );
  return raw === null ? null : parseTrunkLeaseLeaf(raw);
}

export function listTrunkLeaseLeaves(stateDir: string): TrunkLeaseLeaf[] {
  const dirPath = trunkLeaseLeafDir(stateDir);
  if (!plainPrivateDir(dirPath)) return [];
  const out: TrunkLeaseLeaf[] = [];
  let dir: ReturnType<typeof opendirSync> | null = null;
  try {
    dir = opendirSync(dirPath);
    for (let n = 0; n < MAX_TRUNK_LEASE_REQUESTS; n += 1) {
      const entry = dir.readSync();
      if (entry === null) break;
      if (!entry.name.startsWith("lease-") || !entry.name.endsWith(".json")) {
        continue;
      }
      const raw = readBoundedPrivateJson(join(dirPath, entry.name));
      const leaf = raw === null ? null : parseTrunkLeaseLeaf(raw);
      if (leaf !== null) out.push(leaf);
    }
  } catch {
    return out;
  } finally {
    try {
      dir?.closeSync();
    } catch {
      // bounded scan is complete
    }
  }
  return out.sort((a, b) => a.repo_root.localeCompare(b.repo_root));
}

export function writeTrunkLeaseLeaf(
  stateDir: string,
  leaf: TrunkLeaseLeaf,
): boolean {
  const canonical = realpathNearest(leaf.writable_root);
  if (canonical === null) return false;
  const published: TrunkLeaseLeaf = {
    ...leaf,
    repo_root: canonical,
    writable_root: canonical,
  };
  if (parseTrunkLeaseLeaf(JSON.stringify(published)) === null) return false;
  return writeAtomicPrivateJson(
    deriveTrunkLeaseLeafPath(stateDir, canonical),
    published,
  );
}

export type TrunkIntegrationFenceDecision =
  | { kind: "already-integrated" }
  | { kind: "merge" }
  | {
      kind: "defer";
      reason: "lease-invalid" | "ancestry-inconclusive" | "tip-drift";
    };

export function decideTrunkIntegrationFence(input: {
  leaseValid: boolean;
  ancestry: "ancestor" | "not-ancestor" | "inconclusive";
  observedDefaultTip: string;
  liveDefaultTip: string | null;
}): TrunkIntegrationFenceDecision {
  if (!input.leaseValid) return { kind: "defer", reason: "lease-invalid" };
  if (input.ancestry === "inconclusive") {
    return { kind: "defer", reason: "ancestry-inconclusive" };
  }
  if (input.ancestry === "ancestor") return { kind: "already-integrated" };
  if (
    input.liveDefaultTip === null ||
    input.liveDefaultTip !== input.observedDefaultTip
  ) {
    return { kind: "defer", reason: "tip-drift" };
  }
  return { kind: "merge" };
}

export function trunkLeaseIsValid(
  leaf: TrunkLeaseLeaf,
  expected: {
    epicId: string;
    repoRoot: string;
    sourceBranch: string;
    claimantSessionId: string;
    fencingToken?: number;
  },
  now: number,
): boolean {
  return (
    leaf.active &&
    now < leaf.expires_at &&
    leaf.epic_id === expected.epicId &&
    leaf.repo_root === expected.repoRoot &&
    leaf.writable_root === expected.repoRoot &&
    leaf.source_branch === expected.sourceBranch &&
    leaf.claimant_session_id === expected.claimantSessionId &&
    (expected.fencingToken === undefined ||
      leaf.fencing_token === expected.fencingToken)
  );
}

/** The four confined escalation roles and their agent types. Role names match the
 *  escalation vocabulary (`unblock`/`resolve`/`deconflict`/`repair`); agent types
 *  are the bare and plugin-qualified `agent_type` values the hook payload carries
 *  for each Task subagent. */
export type EscalationRole = "unblock" | "resolve" | "deconflict" | "repair";
type BareEscalationAgentType =
  | "unblocker"
  | "merge-resolver"
  | "deconflicter"
  | "repairer";

export type EscalationAgentType =
  | BareEscalationAgentType
  | `plan:${BareEscalationAgentType}`;

export const ESCALATION_AGENT_ROLE: Readonly<
  Record<EscalationAgentType, EscalationRole>
> = {
  unblocker: "unblock",
  "merge-resolver": "resolve",
  deconflicter: "deconflict",
  repairer: "repair",
  "plan:unblocker": "unblock",
  "plan:merge-resolver": "resolve",
  "plan:deconflicter": "deconflict",
  "plan:repairer": "repair",
};

/** The roles permitted to write source under a valid grant. `unblock` is
 *  DIAGNOSIS-only: an unblocker never writes source, even holding a grant. */
const WRITE_CAPABLE_ROLES: ReadonlySet<EscalationRole> = new Set([
  "resolve",
  "deconflict",
  "repair",
]);

/** Resolve a payload `agent_type` to its escalation role, or null when it is not
 *  one of the confined agent identities (outside the grant guard's jurisdiction). */
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
  /** The blocked task whose work owner may consume a repo-scoped repair grant. */
  owner_task_id?: string;
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
  const expectedRole =
    typeof agentType === "string" ? escalationRoleFor(agentType) : null;
  if (
    g.schema_version !== GRANT_LEAF_SCHEMA_VERSION ||
    typeof g.parent_job_id !== "string" ||
    g.parent_job_id === "" ||
    typeof agentType !== "string" ||
    expectedRole === null ||
    typeof g.incident_id !== "string" ||
    g.incident_id === "" ||
    (g.owner_task_id !== undefined &&
      (typeof g.owner_task_id !== "string" || g.owner_task_id === "")) ||
    typeof g.attempt_id !== "string" ||
    g.attempt_id === "" ||
    typeof g.instance_event_id !== "number" ||
    !Number.isFinite(g.instance_event_id) ||
    typeof g.writable_root !== "string" ||
    !isAbsolute(g.writable_root) ||
    typeof role !== "string" ||
    role !== expectedRole ||
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

interface GrantLeafRecord {
  path: string;
  grant: GrantLeaf;
}

function scanGrantLeafRecords(grantsDir: string): {
  complete: boolean;
  records: GrantLeafRecord[];
} {
  if (
    grantsDir === "" ||
    !isAbsolute(grantsDir) ||
    !plainPrivateDir(grantsDir)
  ) {
    return { complete: false, records: [] };
  }
  const records: GrantLeafRecord[] = [];
  let complete = false;
  let dir: ReturnType<typeof opendirSync> | null = null;
  try {
    dir = opendirSync(grantsDir);
    while (true) {
      const entry = dir.readSync();
      if (entry === null) break;
      if (!entry.name.startsWith("grant-") || !entry.name.endsWith(".json")) {
        continue;
      }
      const path = join(grantsDir, entry.name);
      const read = readOwnerPrivateLeaf(path);
      if ("verdict" in read) continue;
      const grant = parseGrant(read.bytes);
      if (grant !== null) records.push({ path, grant });
    }
    complete = true;
  } catch {
    // A partial scan remains useful to read-only callers, never to the reaper.
  } finally {
    try {
      dir?.closeSync();
    } catch {
      // Directory closure does not change the completed snapshot.
    }
  }
  return { complete, records };
}

/** Read every valid owner-private grant leaf. Malformed, raced, or insecure
 *  leaves are omitted; callers still apply incident/expiry filters before
 *  treating a leaf as authority. */
export function listGrantLeaves(grantsDir: string): GrantLeaf[] {
  return scanGrantLeafRecords(grantsDir)
    .records.map(({ grant }) => grant)
    .sort(
      (a, b) =>
        a.fencing_token - b.fencing_token ||
        a.parent_job_id.localeCompare(b.parent_job_id),
    );
}

export interface GrantReapCursor {
  fencingToken: number;
  path: string;
}

export interface GrantReapResult {
  reaped: number;
  nextCursor: GrantReapCursor | null;
}

/** Reap at most one bounded batch while retaining the greatest fencing token
 *  as the crash-safe floor for the next grant publication. */
export function reapGrantLeaves(
  grantsDir: string,
  shouldReap: (grant: GrantLeaf) => boolean,
  cursor: GrantReapCursor | null = null,
): GrantReapResult {
  const scanned = scanGrantLeafRecords(grantsDir);
  if (!scanned.complete) return { reaped: 0, nextCursor: cursor };
  if (scanned.records.length === 0) return { reaped: 0, nextCursor: null };
  const fencingFloor = scanned.records.reduce(
    (max, { grant }) => Math.max(max, grant.fencing_token),
    0,
  );
  const records = scanned.records.sort(
    (a, b) =>
      a.grant.fencing_token - b.grant.fencing_token ||
      a.path.localeCompare(b.path),
  );
  let start = 0;
  if (cursor !== null) {
    start = records.findIndex(
      (record) =>
        record.grant.fencing_token > cursor.fencingToken ||
        (record.grant.fencing_token === cursor.fencingToken &&
          record.path.localeCompare(cursor.path) > 0),
    );
    if (start < 0) return { reaped: 0, nextCursor: null };
  }
  const end = Math.min(start + MAX_GRANT_REAP_INSPECTIONS, records.length);
  let reaped = 0;
  for (let index = start; index < end; index += 1) {
    const record = records[index] as GrantLeafRecord;
    if (record.grant.fencing_token >= fencingFloor) continue;
    if (
      record.path !==
      deriveGrantLeafPath(
        grantsDir,
        record.grant.parent_job_id,
        record.grant.agent_type,
      )
    ) {
      continue;
    }
    const read = readOwnerPrivateLeaf(record.path);
    if ("verdict" in read) continue;
    const current = parseGrant(read.bytes);
    if (
      current === null ||
      current.fencing_token !== record.grant.fencing_token
    ) {
      continue;
    }
    let eligible = false;
    try {
      eligible = shouldReap(current);
    } catch {
      continue;
    }
    if (!eligible) continue;
    try {
      unlinkSync(record.path);
      reaped += 1;
    } catch {
      // A raced or failed reap retries on a later sweep.
    }
  }
  const last = records[end - 1] as GrantLeafRecord;
  return {
    reaped,
    nextCursor:
      end < records.length
        ? { fencingToken: last.grant.fencing_token, path: last.path }
        : null,
  };
}

/** Publish `grant` under `grantsDir` (created 0o700 if absent). Writes a fresh
 *  O_EXCL|O_NOFOLLOW temp leaf, fsyncs, then atomically renames it onto the
 *  derived path so a reader never observes a partial or inode-swapped leaf.
 *  Returns false (never throws) on any failure — the daemon is the sole caller. */
export function writeGrantLeaf(grantsDir: string, grant: GrantLeaf): boolean {
  if (grantsDir === "" || !isAbsolute(grantsDir)) return false;
  const expectedRole = escalationRoleFor(grant.agent_type);
  if (
    expectedRole === null ||
    grant.role !== expectedRole ||
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
  KEEPER_STATE_DIR?: string;
  KEEPER_JOB_ID?: string;
  CLAUDE_CODE_SESSION_ID?: string;
  HOME?: string;
}

/** Build the launch-anchored expectation for `agentType`, or null when the env
 *  lacks a core field (no launch identity → no grant can validate). */
export function grantExpectationFromEnv(
  env: GrantEnv,
  agentType: string,
): GrantExpectation | null {
  const explicitParent = (env.KEEPER_GRANT_PARENT_JOB ?? "").trim();
  const incidentId = (env.KEEPER_GRANT_INCIDENT ?? "").trim();
  const tokenRaw = (env.KEEPER_GRANT_FENCING_TOKEN ?? "").trim();
  if (explicitParent !== "" && incidentId !== "" && tokenRaw !== "") {
    const fencingToken = Number(tokenRaw);
    if (!Number.isFinite(fencingToken)) return null;
    const attempt = (env.KEEPER_GRANT_ATTEMPT ?? "").trim();
    const instanceRaw = (env.KEEPER_GRANT_INSTANCE_EVENT ?? "").trim();
    const expectation: GrantExpectation = {
      parentJobId: explicitParent,
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

  const parentJobId = (
    env.KEEPER_JOB_ID ??
    env.CLAUDE_CODE_SESSION_ID ??
    ""
  ).trim();
  const grantsDir = grantsDirOf(env);
  if (parentJobId === "" || grantsDir === "") return null;
  const read = readOwnerPrivateLeaf(
    deriveGrantLeafPath(grantsDir, parentJobId, agentType),
  );
  if ("verdict" in read) return null;
  const grant = parseGrant(read.bytes);
  if (
    grant === null ||
    grant.parent_job_id !== parentJobId ||
    grant.agent_type !== agentType
  ) {
    return null;
  }
  return {
    parentJobId,
    agentType,
    incidentId: grant.incident_id,
    fencingToken: grant.fencing_token,
    attemptId: grant.attempt_id,
    instanceEventId: grant.instance_event_id,
  };
}

export function grantsDirOf(env: GrantEnv): string {
  const explicit = (env.KEEPER_GRANT_DIR ?? "").trim();
  if (explicit !== "") return explicit;
  const stateDir = (env.KEEPER_STATE_DIR ?? "").trim();
  if (stateDir !== "") return join(stateDir, "grants");
  const home = (env.HOME ?? "").trim() || homedir();
  return join(home, ".local", "state", "keeper", "grants");
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
