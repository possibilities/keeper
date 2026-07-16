import type { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  defaultBirthDir,
  parseBirthIntent,
  parseBirthRecord,
} from "../birth-record";
import {
  defaultDbPath,
  defaultDeadLetterDir,
  defaultEventsLogDir,
  openDb,
} from "../db";
import { parseDeadLetterLine, parseEventLogLine } from "../dead-letter";
import { extractMutationPath } from "../derivers";
import {
  ATTRIBUTION_FLOOR_PATH,
  ATTRIBUTION_FLOOR_SESSION_ID,
} from "../git-attribution-floor";
import type { GitRunner } from "./git-exec";

export type ClaimLiveness = "live" | "terminal" | "unknown";

export interface OwnershipClaim {
  path: string;
  sessionId: string;
  liveness: ClaimLiveness;
  state?: string | null;
  oid?: string | null;
  mode?: string | null;
  source?: string | null;
  /** Same-snapshot terminal lifecycle event proven later than this mutation. */
  orderedTerminalProof?: true;
}

/**
 * Synchronous observations which have not necessarily reached keeper.db yet.
 * A receipt reader can provide current-session paths plus overlap observations.
 * `complete` means the provider has enough other-session evidence to close the
 * overlap question without the DB; absent/false keeps automatic selection
 * fail-closed when the durable reader is unavailable.
 */
export interface DirectSurfaceEvidence {
  currentSessionPaths?: Iterable<string>;
  claims?: Iterable<OwnershipClaim>;
  complete?: boolean;
}

export interface DirtyPath {
  path: string;
  status: string;
  renamePeer?: string;
}

export interface SurfaceCategory {
  total: number;
  sample: string[];
}

export interface CommitWorkSurfaceSummary {
  dirty_total: number;
  caller_owned_selected: SurfaceCategory;
  adoptable_unattributed: SurfaceCategory;
  observed_adoptable: SurfaceCategory;
  terminal_foreign_adoptable: SurfaceCategory;
  live_foreign_conflict: SurfaceCategory;
  multi_ambiguous: SurfaceCategory;
  excluded: SurfaceCategory;
  ambient_staged_carryover: SurfaceCategory;
}

export type AdoptionRejectionCode =
  | "outside_worktree"
  | "invalid_path"
  | "ignored"
  | "excluded"
  | "clean"
  | "unknown_path"
  | "ownership_conflict"
  | "ownership_unavailable";

export interface AdoptionRejection {
  input: string;
  path?: string;
  code: AdoptionRejectionCode;
  conflicting_sessions?: string[];
}

export interface SurfaceDiscoveryResult {
  selected: string[];
  automatic: string[];
  adopted: string[];
  rejections: AdoptionRejection[];
  summary: CommitWorkSurfaceSummary;
  claimsByPath: Map<string, OwnershipClaim[]>;
  dirtyByPath: Map<string, DirtyPath>;
  evidenceAvailable: boolean;
  dirtyAvailable: boolean;
}

export interface SurfaceDiscoveryOptions {
  worktree: string;
  identity: string | null;
  adoptedPaths: string[];
  git: GitRunner;
  directEvidence?: DirectSurfaceEvidence;
  sampleLimit?: number;
  deps?: SurfaceDiscoveryDeps;
}

export interface SurfaceDiscoveryDeps {
  /** null means the durable identity/evidence surface was unavailable. */
  readClaims?: (worktree: string) => OwnershipClaim[] | null;
  /** Injectable liveness override; throwing/unknown is conservative. */
  classifyClaim?: (claim: OwnershipClaim) => ClaimLiveness;
}

export interface OwnershipClaimsReadTestHooks {
  /** Test-only seam for interleaving a reducer fold after the first snapshot read. */
  afterDurableRead?: () => void;
  /** Test-only seam for moving a receipt into SQLite during the source handoff. */
  afterReceiptRead?: () => void;
  /** Isolated receipt tree; production uses the fixed events-log directory. */
  eventsLogDir?: string;
  /** Isolated dead-letter tree; production uses the fixed recovery directory. */
  deadLetterDir?: string;
  /** Isolated Pi birth tree; production uses the fixed per-user maildir. */
  birthDir?: string;
  /** Test-only seam for a dead-letter append at the final source handoff. */
  afterDeadLetterRead?: () => void;
  /** Test-only seam for a daemon import during a dead-letter disk scan. */
  duringDeadLetterRead?: () => void;
}

const EXCLUDED_PREFIX = ".keeper/";
const DURABLE_CLAIM_LIMIT = 10_000;
const PENDING_DIRECT_CLAIM_LIMIT = 10_000;
const RECEIPT_FILE_LIMIT = 1_024;
const RECEIPT_RECORD_LIMIT = 10_000;
const RECEIPT_BYTE_LIMIT = 8 * 1_048_576;
// Node's fs constants omit O_CLOEXEC; keep descriptor inheritance atomic.
const O_CLOEXEC = process.platform === "darwin" ? 0x1000000 : 0o2000000;

function canonicalMutationPath(
  worktree: string,
  mutationPath: string,
): string | null {
  if (mutationPath.includes("\0")) return null;
  const canonical = canonicalizeAdoptedPath(worktree, mutationPath);
  if ("code" in canonical) return null;

  // Parent canonicalization above preserves a symlink leaf as Git content. For
  // a regular existing leaf, realpath also normalizes case on case-insensitive
  // filesystems so `/repo/Foo` and Git's `foo` cannot become distinct owners.
  try {
    const absolute = isAbsolute(mutationPath)
      ? mutationPath
      : resolve(worktree, mutationPath);
    if (!lstatSync(absolute).isSymbolicLink()) {
      const root = realpathSync(worktree);
      const rel = relative(root, realpathSync(absolute));
      if (
        rel !== "" &&
        rel !== ".." &&
        !rel.startsWith(`..${sep}`) &&
        !isAbsolute(rel)
      ) {
        return rel.split(sep).join("/");
      }
    }
  } catch {
    // Deleted/new files are identified by their canonical existing parent.
  }
  return canonical.path;
}

function mutationPathFromReceipt(
  bindings: Record<string, string | number | boolean | null>,
): string | null {
  let mutationPath: string | null = null;
  if (Object.hasOwn(bindings, "mutation_path")) {
    // Forward producers use present NULL to say canonicalization was unavailable.
    // Only truly absent legacy bindings may be reconstructed from tool_input.
    if (typeof bindings.mutation_path !== "string") return null;
    mutationPath = bindings.mutation_path;
  } else if (typeof bindings.data === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bindings.data);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    mutationPath = extractMutationPath(
      typeof bindings.hook_event === "string" ? bindings.hook_event : "",
      typeof bindings.tool_name === "string" ? bindings.tool_name : null,
      parsed as Record<string, unknown>,
    );
  }
  if (mutationPath === null || mutationPath.includes("\0")) return null;
  if (isAbsolute(mutationPath)) return mutationPath;

  // Legacy receipts predate the canonical `mutation_path` column. Their tool
  // path is relative to the producer-recorded cwd, never implicitly to the
  // repository root. Missing/relative cwd is unavailable evidence.
  const cwd = bindings.cwd;
  return typeof cwd === "string" && isAbsolute(cwd) && !cwd.includes("\0")
    ? resolve(cwd, mutationPath)
    : null;
}

function receiptCanonicalizationUnavailable(
  bindings: Record<string, string | number | boolean | null>,
): boolean {
  const toolName = bindings.tool_name;
  return (
    Object.hasOwn(bindings, "mutation_path") &&
    bindings.mutation_path === null &&
    bindings.hook_event === "PostToolUse" &&
    (toolName === "Write" ||
      toolName === "Edit" ||
      toolName === "MultiEdit" ||
      toolName === "NotebookEdit")
  );
}

/**
 * Read every complete event-log tail not covered by this SQLite snapshot's
 * durable ingest offsets. Descriptor-bound regular-file reads plus a second
 * stat/directory pass turn concurrent append/create activity into unavailable
 * evidence rather than a silently incomplete ownership decision.
 */
interface ReceiptClaimsSnapshot {
  claims: OwnershipClaim[];
  /** Sessions with any un-ingested event whose DB ordering is not yet known. */
  unorderedSessions: ReadonlySet<string>;
  /** Exact descriptor/directory identity recheck after the DB snapshot closes. */
  stillStable: () => boolean;
}

function readReceiptClaims(
  db: Database,
  worktree: string,
  dir: string,
): ReceiptClaimsSnapshot | null {
  const list = (): string[] | null => {
    try {
      const names = readdirSync(dir)
        .filter((name) => name.endsWith(".ndjson"))
        .sort();
      return names.length <= RECEIPT_FILE_LIMIT ? names : null;
    } catch {
      return null;
    }
  };
  const beforeNames = list();
  if (beforeNames === null) return null;

  const offsetStmt = db.query(
    "SELECT offset FROM event_ingest_offsets WHERE path = ? AND inode = ?",
  );
  const stateStmt = db.query("SELECT state FROM jobs WHERE job_id = ?");
  const stateBySession = new Map<string, string | null>();
  const claims: OwnershipClaim[] = [];
  const unorderedSessions = new Set<string>();
  const identities = new Map<
    string,
    {
      dev: number;
      ino: number;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    }
  >();
  let totalBytes = 0;
  let totalRecords = 0;

  for (const name of beforeNames) {
    const full = join(dir, name);
    let fd: number;
    try {
      fd = openSync(full, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch {
      return null;
    }
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || !Number.isSafeInteger(before.size)) return null;
      identities.set(name, {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      });
      const stored = offsetStmt.get(full, before.ino) as {
        offset: unknown;
      } | null;
      const storedOffset = stored?.offset ?? 0;
      if (
        typeof storedOffset !== "number" ||
        !Number.isSafeInteger(storedOffset) ||
        storedOffset < 0
      ) {
        return null;
      }
      const start = storedOffset <= before.size ? storedOffset : 0;
      const unreadBytes = before.size - start;
      totalBytes += unreadBytes;
      if (totalBytes > RECEIPT_BYTE_LIMIT) return null;

      const unread = Buffer.alloc(unreadBytes);
      let read = 0;
      while (read < unread.length) {
        const count = readSync(
          fd,
          unread,
          read,
          unread.length - read,
          start + read,
        );
        if (count <= 0) return null;
        read += count;
      }
      const after = fstatSync(fd);
      if (
        !after.isFile() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        return null;
      }
      if (unread.length > 0 && unread[unread.length - 1] !== 0x0a) {
        return null;
      }

      const lines = unread.toString("utf8").split("\n");
      lines.pop(); // a complete tail ends in exactly one consumed delimiter
      for (const line of lines) {
        if (line.trim() === "") continue;
        totalRecords += 1;
        if (totalRecords > RECEIPT_RECORD_LIMIT) return null;
        const record = parseEventLogLine(line);
        if (record === null) return null;
        const sessionId = record.bindings.session_id;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          return null;
        }
        // Receipt order relative to a folded terminal event is unknowable until
        // ingestion assigns an event id. Any unread lifecycle, prompt, tool, or
        // other session event therefore keeps every claim non-terminal. This
        // catches a resume receipt even when it carries no mutation path.
        unorderedSessions.add(sessionId);
        if (receiptCanonicalizationUnavailable(record.bindings)) return null;
        const mutationPath = mutationPathFromReceipt(record.bindings);
        if (mutationPath === null) continue;
        const path = canonicalMutationPath(worktree, mutationPath);
        if (path === null) continue;
        if (!stateBySession.has(sessionId)) {
          const state = stateStmt.get(sessionId) as { state: unknown } | null;
          stateBySession.set(
            sessionId,
            typeof state?.state === "string" ? state.state : null,
          );
        }
        const state = stateBySession.get(sessionId) ?? null;
        claims.push({
          path,
          sessionId,
          // A fresh mutation may precede the resume lifecycle fold. Projection
          // terminality is therefore not positive abandonment evidence here.
          liveness: state === "working" ? "live" : "unknown",
          state,
          oid: null,
          mode: null,
          source: "direct",
        });
      }
    } finally {
      closeSync(fd);
    }
  }

  const stillStable = (): boolean => {
    const afterNames = list();
    if (
      afterNames === null ||
      afterNames.length !== beforeNames.length ||
      afterNames.some((name, index) => name !== beforeNames[index])
    ) {
      return false;
    }
    // Re-probe every descriptor identity after the complete directory pass. An
    // append to an early file while a later file was scanned is therefore not
    // mistaken for a stable, complete receipt set.
    for (const name of afterNames) {
      const expected = identities.get(name);
      if (expected === undefined) return false;
      let fd: number;
      try {
        fd = openSync(
          join(dir, name),
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
      } catch {
        return false;
      }
      try {
        const actual = fstatSync(fd);
        if (
          !actual.isFile() ||
          actual.dev !== expected.dev ||
          actual.ino !== expected.ino ||
          actual.size !== expected.size ||
          actual.mtimeMs !== expected.mtimeMs ||
          actual.ctimeMs !== expected.ctimeMs
        ) {
          return false;
        }
      } finally {
        closeSync(fd);
      }
    }
    return true;
  };
  return stillStable() ? { claims, unorderedSessions, stillStable } : null;
}

interface BirthSessionsSnapshot {
  sessions: ReadonlySet<string>;
  stillStable: () => boolean;
}

export function defaultCommitWorkBirthDir(): string {
  return defaultBirthDir();
}

/** Descriptor-stable snapshot of launcher births not yet ordered in SQLite. */
function readBirthSessions(dir: string): BirthSessionsSnapshot | null {
  interface BirthFile {
    key: string;
    full: string;
  }
  // `pending/` is published before spawn and remains visible until the complete
  // birth atomically reaches `new/`; `tmp/` covers the legacy writer's stage.
  const list = (): BirthFile[] | null => {
    const files: BirthFile[] = [];
    for (const bucket of ["pending", "tmp", "new"] as const) {
      const bucketDir = join(dir, bucket);
      let names: string[];
      try {
        names = readdirSync(bucketDir).filter((name) => name.endsWith(".json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return null;
      }
      for (const name of names) {
        files.push({ key: `${bucket}/${name}`, full: join(bucketDir, name) });
      }
    }
    files.sort((left, right) => left.key.localeCompare(right.key));
    return files.length <= RECEIPT_FILE_LIMIT ? files : null;
  };
  const beforeFiles = list();
  if (beforeFiles === null) return null;

  const sessions = new Set<string>();
  const identities = new Map<string, string>();
  let totalBytes = 0;
  for (const file of beforeFiles) {
    const { full, key } = file;
    let fd: number;
    try {
      fd = openSync(
        full,
        constants.O_RDONLY |
          constants.O_NONBLOCK |
          constants.O_NOFOLLOW |
          O_CLOEXEC,
      );
    } catch {
      return null;
    }
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || !Number.isSafeInteger(before.size)) return null;
      totalBytes += before.size;
      if (totalBytes > RECEIPT_BYTE_LIMIT) return null;
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(
          fd,
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (count <= 0) return null;
        offset += count;
      }
      const after = fstatSync(fd);
      const identity = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
      if (
        !after.isFile() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        return null;
      }
      identities.set(key, identity);
      const body = bytes.toString("utf8");
      const record = key.startsWith("pending/")
        ? (parseBirthIntent(body) ?? parseBirthRecord(body))
        : parseBirthRecord(body);
      if (record === null) return null;
      sessions.add(record.session_id);
    } finally {
      closeSync(fd);
    }
  }

  const stillStable = (): boolean => {
    const afterFiles = list();
    if (
      afterFiles === null ||
      afterFiles.length !== beforeFiles.length ||
      afterFiles.some((file, index) => file.key !== beforeFiles[index]?.key)
    ) {
      return false;
    }
    for (const file of afterFiles) {
      let stats: ReturnType<typeof lstatSync>;
      try {
        stats = lstatSync(file.full);
      } catch {
        return false;
      }
      if (
        !stats.isFile() ||
        identities.get(file.key) !==
          `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
      ) {
        return false;
      }
    }
    return true;
  };
  return stillStable() ? { sessions, stillStable } : null;
}

interface DeadLetterImportState {
  dataVersion: number;
}

function deadLetterImportState(db: Database): DeadLetterImportState | null {
  const row = db.query("PRAGMA data_version").get() as {
    data_version: unknown;
  } | null;
  if (
    typeof row?.data_version !== "number" ||
    !Number.isSafeInteger(row.data_version) ||
    row.data_version < 0
  ) {
    return null;
  }
  return { dataVersion: row.data_version };
}

function sameDeadLetterImportState(
  left: DeadLetterImportState,
  right: DeadLetterImportState,
): boolean {
  return left.dataVersion === right.dataVersion;
}

interface DeadLetterEvidence {
  blockingMutation: boolean;
  unorderedSessions: ReadonlySet<string>;
}

function unresolvedDeadLetterEvidence(
  worktree: string,
  dbPath: string,
  dir: string,
  duringRead?: () => void,
): DeadLetterEvidence | null {
  let blockingMutation = false;
  const unorderedSessions = new Set<string>();
  const observe = (
    bindings: Record<string, string | number | boolean | null>,
    fallbackSession: string | null,
  ): void => {
    const boundSession = bindings.session_id;
    const sessionId =
      typeof boundSession === "string" && boundSession.length > 0
        ? boundSession
        : fallbackSession;
    if (sessionId !== null && sessionId.length > 0) {
      unorderedSessions.add(sessionId);
    }
    if (receiptCanonicalizationUnavailable(bindings)) {
      blockingMutation = true;
      return;
    }
    const mutationPath = mutationPathFromReceipt(bindings);
    if (
      mutationPath !== null &&
      canonicalMutationPath(worktree, mutationPath) !== null
    ) {
      blockingMutation = true;
    }
  };
  const evidence = (): DeadLetterEvidence => ({
    blockingMutation,
    unorderedSessions,
  });
  try {
    const { db } = openDb(dbPath, { readonly: true });
    try {
      const importBefore = deadLetterImportState(db);
      if (importBefore === null) return null;
      const unresolved = db
        .query(
          `SELECT bindings, session_id, status
             FROM dead_letters
            WHERE status != 'recovered'
            LIMIT ?`,
        )
        .all(RECEIPT_RECORD_LIMIT + 1) as Array<{
        bindings: unknown;
        session_id: unknown;
        status: unknown;
      }>;
      if (unresolved.length > RECEIPT_RECORD_LIMIT) return null;
      for (const row of unresolved) {
        // Poison means the original event could not be classified at all. Its
        // parked `{raw,…}` envelope cannot prove which session/path it touched,
        // so terminal adoption must fail closed globally until an operator
        // resolves or removes the poison evidence.
        if (row.status !== "waiting") {
          blockingMutation = true;
          continue;
        }
        if (typeof row.bindings !== "string") return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.bindings);
        } catch {
          return null;
        }
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          return null;
        }
        observe(
          parsed as Record<string, string | number | boolean | null>,
          typeof row.session_id === "string" ? row.session_id : null,
        );
      }

      duringRead?.();
      let names: string[];
      try {
        names = readdirSync(dir)
          .filter((name) => name.endsWith(".ndjson"))
          .sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
        const importAfter = deadLetterImportState(db);
        return importAfter !== null &&
          sameDeadLetterImportState(importBefore, importAfter)
          ? evidence()
          : null;
      }
      if (names.length > RECEIPT_FILE_LIMIT) return null;
      const identities = new Map<string, string>();
      let totalBytes = 0;
      let totalRecords = 0;
      const status = db.query(
        "SELECT status, replayed_event_id FROM dead_letters WHERE dl_id = ?",
      );
      for (const name of names) {
        const full = join(dir, name);
        const fd = openSync(full, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const before = fstatSync(fd);
          if (!before.isFile() || !Number.isSafeInteger(before.size))
            return null;
          totalBytes += before.size;
          if (totalBytes > RECEIPT_BYTE_LIMIT) return null;
          const bytes = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < bytes.length) {
            const count = readSync(
              fd,
              bytes,
              offset,
              bytes.length - offset,
              offset,
            );
            if (count <= 0) return null;
            offset += count;
          }
          const after = fstatSync(fd);
          const identity = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
          if (
            !after.isFile() ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          ) {
            return null;
          }
          identities.set(name, identity);
          if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) return null;
          for (const line of bytes.toString("utf8").split("\n")) {
            if (line.trim() === "") continue;
            totalRecords += 1;
            if (totalRecords > RECEIPT_RECORD_LIMIT) return null;
            const record = parseDeadLetterLine(line);
            if (record === null) return null;
            const row = status.get(record.dl_id) as {
              status: unknown;
              replayed_event_id: unknown;
            } | null;
            const recovered =
              row?.status === "recovered" &&
              typeof row.replayed_event_id === "number" &&
              Number.isSafeInteger(row.replayed_event_id);
            if (row !== null && !recovered && row.status !== "waiting") {
              blockingMutation = true;
              continue;
            }
            if (!recovered) observe(record.bindings, record.session_id);
          }
        } finally {
          closeSync(fd);
        }
      }
      // The daemon imports a disk record into SQLite before unlinking it. A
      // stable monotonic import state between the first DB read and this point,
      // followed by an unchanged directory pass, establishes one instant at
      // which neither representation could have hidden the record.
      const importMiddle = deadLetterImportState(db);
      if (
        importMiddle === null ||
        !sameDeadLetterImportState(importBefore, importMiddle)
      ) {
        return null;
      }
      const afterNames = readdirSync(dir)
        .filter((name) => name.endsWith(".ndjson"))
        .sort();
      if (afterNames.join("\0") !== names.join("\0")) return null;
      for (const name of afterNames) {
        const stats = lstatSync(join(dir, name));
        if (
          !stats.isFile() ||
          identities.get(name) !==
            `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
        ) {
          return null;
        }
      }
      const importAfter = deadLetterImportState(db);
      return importAfter !== null &&
        sameDeadLetterImportState(importMiddle, importAfter)
        ? evidence()
        : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

interface OrderedTerminalProofInput {
  mutationEventId: number | null;
  sessionId: string;
  state: string | null;
  terminalEventId: number | null;
  terminalSessionId: string | null;
  terminalHookEvent: string | null;
  sessionTailEventId: number | null;
}

function hasOrderedTerminalProof(row: OrderedTerminalProofInput): boolean {
  return (
    row.mutationEventId !== null &&
    row.terminalEventId !== null &&
    row.terminalEventId > row.mutationEventId &&
    row.terminalEventId === row.sessionTailEventId &&
    row.terminalSessionId === row.sessionId &&
    ((row.state === "ended" && row.terminalHookEvent === "SessionEnd") ||
      (row.state === "killed" && row.terminalHookEvent === "Killed"))
  );
}

/**
 * Read folded claims plus exact tool mutations newer than the root's last Git
 * observation. The pending tail closes the producer-lag window synchronously at
 * commit time: a PostToolUse that landed after a status read remains above
 * `git_status.attribution_event_id` and is an exclusive direct claim even before
 * the next GitSnapshot fold. A path-scoped hard row cap fails evidence closed
 * instead of turning an unexpectedly stale root into an unbounded DB read.
 */
export function readOwnershipClaims(
  worktree: string,
  dbPath = defaultDbPath(),
  testHooks: OwnershipClaimsReadTestHooks = {},
): OwnershipClaim[] | null {
  try {
    const { db } = openDb(dbPath, { readonly: true });
    let transactionOpen = false;
    try {
      // All four reads share one SQLite snapshot. Otherwise a reducer fold can
      // materialize a mutation after the durable read, advance the watermark,
      // and make the later tail read skip the same mutation from both surfaces.
      db.run("BEGIN");
      transactionOpen = true;
      const durable = db
        .query(
          `SELECT fa.file_path, fa.session_id, fa.worktree_oid, fa.worktree_mode,
                  fa.source, fa.last_event_id AS mutation_event_id, j.state,
                  j.last_event_id AS terminal_event_id,
                  terminal.session_id AS terminal_session_id,
                  terminal.hook_event AS terminal_hook_event,
                  (SELECT MAX(tail.id)
                     FROM events tail
                    WHERE tail.session_id = fa.session_id) AS session_tail_event_id
             FROM file_attributions fa
             LEFT JOIN jobs j ON j.job_id = fa.session_id
             LEFT JOIN events terminal ON terminal.id = j.last_event_id
            WHERE fa.project_dir = ?
              AND fa.last_mutation_at > COALESCE(fa.last_commit_at, 0)
            ORDER BY fa.file_path, fa.session_id
            LIMIT ?`,
        )
        .all(worktree, DURABLE_CLAIM_LIMIT + 1) as Array<{
        file_path: string;
        session_id: string;
        worktree_oid: string | null;
        worktree_mode: string | null;
        source: string | null;
        mutation_event_id: number | null;
        state: string | null;
        terminal_event_id: number | null;
        terminal_session_id: string | null;
        terminal_hook_event: string | null;
        session_tail_event_id: number | null;
      }>;
      if (durable.length > DURABLE_CLAIM_LIMIT) {
        db.run("ROLLBACK");
        transactionOpen = false;
        return null;
      }
      testHooks.afterDurableRead?.();

      const floorValue = (
        db
          .query(
            `SELECT MAX(attribution_event_id) AS attribution_event_id
               FROM (
                 SELECT attribution_event_id
                   FROM git_status
                  WHERE project_dir = ?
                 UNION ALL
                 SELECT last_event_id AS attribution_event_id
                   FROM file_attributions
                  WHERE project_dir = ?
                    AND session_id = ?
                    AND file_path = ?
               )`,
          )
          .get(
            worktree,
            worktree,
            ATTRIBUTION_FLOOR_SESSION_ID,
            ATTRIBUTION_FLOOR_PATH,
          ) as { attribution_event_id: unknown } | null
      )?.attribution_event_id;
      // No active row/sentinel means no Git observation has consumed any exact
      // mutation evidence for this root. A genesis scan is conservative and
      // complete over the retained sparse mutation_path column; the hard row
      // cap below returns unavailable rather than truncating a large history.
      const floor = floorValue ?? 0;
      const headValue = (
        db.query("SELECT MAX(id) AS max_id FROM events").get() as {
          max_id: unknown;
        } | null
      )?.max_id;
      const head = headValue ?? 0;
      if (
        typeof floor !== "number" ||
        !Number.isSafeInteger(floor) ||
        floor < 0 ||
        typeof head !== "number" ||
        !Number.isSafeInteger(head) ||
        head < 0 ||
        floor > head
      ) {
        db.run("ROLLBACK");
        transactionOpen = false;
        return null;
      }

      // Scan the bounded global interval, not only a lexical root prefix: a
      // tool path may name this same worktree through a symlink/case/root alias.
      const pending = db
        .query(
          `SELECT e.id AS event_id, e.mutation_path, e.session_id, j.state,
                  j.last_event_id AS terminal_event_id,
                  terminal.session_id AS terminal_session_id,
                  terminal.hook_event AS terminal_hook_event,
                  (SELECT MAX(tail.id)
                     FROM events tail
                    WHERE tail.session_id = e.session_id) AS session_tail_event_id
             FROM events e
             LEFT JOIN jobs j ON j.job_id = e.session_id
             LEFT JOIN events terminal ON terminal.id = j.last_event_id
            WHERE e.id > ?
              AND e.id <= ?
              AND (
                e.mutation_path IS NOT NULL
                OR (
                  e.hook_event = 'PostToolUse'
                  AND e.tool_name IN ('Write', 'Edit', 'MultiEdit', 'NotebookEdit')
                )
              )
            ORDER BY e.id
            LIMIT ?`,
        )
        .all(floor, head, PENDING_DIRECT_CLAIM_LIMIT + 1) as Array<{
        event_id: number;
        mutation_path: string | null;
        session_id: string;
        state: string | null;
        terminal_event_id: number | null;
        terminal_session_id: string | null;
        terminal_hook_event: string | null;
        session_tail_event_id: number | null;
      }>;
      if (pending.length > PENDING_DIRECT_CLAIM_LIMIT) {
        db.run("ROLLBACK");
        transactionOpen = false;
        return null;
      }

      const claims: OwnershipClaim[] = durable.map((row) => {
        const orderedTerminalProof = hasOrderedTerminalProof({
          mutationEventId: row.mutation_event_id,
          sessionId: row.session_id,
          state: row.state,
          terminalEventId: row.terminal_event_id,
          terminalSessionId: row.terminal_session_id,
          terminalHookEvent: row.terminal_hook_event,
          sessionTailEventId: row.session_tail_event_id,
        });
        const claim: OwnershipClaim = {
          path: row.file_path,
          sessionId: row.session_id,
          liveness: row.state === "working" ? "live" : "unknown",
          state: row.state,
          oid: row.worktree_oid,
          mode: row.worktree_mode,
          source: row.source,
          ...(orderedTerminalProof ? { orderedTerminalProof: true } : {}),
        };
        claim.liveness = defaultClaimLiveness(claim);
        return claim;
      });
      for (const row of pending) {
        if (row.mutation_path === null) {
          // A successful mutator with no canonical path is unavailable evidence,
          // not proof that no path was changed.
          db.run("ROLLBACK");
          transactionOpen = false;
          return null;
        }
        const relativePath = canonicalMutationPath(worktree, row.mutation_path);
        if (relativePath === null) continue;
        const terminalAfterMutation = hasOrderedTerminalProof({
          mutationEventId: row.event_id,
          sessionId: row.session_id,
          state: row.state,
          terminalEventId: row.terminal_event_id,
          terminalSessionId: row.terminal_session_id,
          terminalHookEvent: row.terminal_hook_event,
          sessionTailEventId: row.session_tail_event_id,
        });
        claims.push({
          path: relativePath,
          sessionId: row.session_id,
          // A pending mutation can be newer than jobs.state, so a bare
          // non-working projection is never terminal proof. The job reducer's
          // exact last_event_id is sufficient only when it names a matching
          // terminal lifecycle event ordered after this mutation and remains
          // the same session's event-log tail in this SQLite snapshot. That
          // tail check also catches a resume event ingested ahead of its fold.
          liveness:
            row.state === "working"
              ? "live"
              : terminalAfterMutation
                ? "terminal"
                : "unknown",
          state: row.state,
          oid: null,
          mode: null,
          source: "direct",
          ...(terminalAfterMutation ? { orderedTerminalProof: true } : {}),
        });
      }

      const receiptSnapshot = readReceiptClaims(
        db,
        worktree,
        testHooks.eventsLogDir ?? defaultEventsLogDir(),
      );
      if (receiptSnapshot === null) {
        db.run("ROLLBACK");
        transactionOpen = false;
        return null;
      }
      for (const claim of claims) {
        if (!receiptSnapshot.unorderedSessions.has(claim.sessionId)) continue;
        claim.liveness = claim.state === "working" ? "live" : "unknown";
        delete claim.orderedTerminalProof;
      }
      claims.push(...receiptSnapshot.claims);
      const birthSnapshot = readBirthSessions(
        testHooks.birthDir ?? defaultCommitWorkBirthDir(),
      );
      if (birthSnapshot === null) {
        db.run("ROLLBACK");
        transactionOpen = false;
        return null;
      }
      for (const claim of claims) {
        if (!birthSnapshot.sessions.has(claim.sessionId)) continue;
        claim.liveness = claim.state === "working" ? "live" : "unknown";
        delete claim.orderedTerminalProof;
      }
      testHooks.afterReceiptRead?.();
      db.run("COMMIT");
      transactionOpen = false;

      // Close the SQLite↔receipt handoff race. A valid receipt that the daemon
      // inserts and unlinks while the old read snapshot is pinned increments the
      // append-only event head; a receipt that remains outside SQLite changes
      // the exact directory/descriptor snapshot. Check the fresh head FIRST and
      // the receipt tree SECOND: activity wholly after the head read is later
      // than this validation's linearization point, while any pre-existing
      // source move changes at least one of these two observations.
      const freshHeadValue = (
        db.query("SELECT MAX(id) AS max_id FROM events").get() as {
          max_id: unknown;
        } | null
      )?.max_id;
      const freshHead = freshHeadValue ?? 0;
      if (
        typeof freshHead !== "number" ||
        !Number.isSafeInteger(freshHead) ||
        freshHead < 0 ||
        freshHead !== head ||
        !receiptSnapshot.stillStable() ||
        !birthSnapshot.stillStable()
      ) {
        return null;
      }
      const deadLetterEvidence = unresolvedDeadLetterEvidence(
        worktree,
        dbPath,
        testHooks.deadLetterDir ?? defaultDeadLetterDir(),
        testHooks.duringDeadLetterRead,
      );
      if (deadLetterEvidence === null || deadLetterEvidence.blockingMutation) {
        return null;
      }
      testHooks.afterDeadLetterRead?.();
      const postDeadLetterHead =
        (
          db.query("SELECT MAX(id) AS max_id FROM events").get() as {
            max_id: unknown;
          } | null
        )?.max_id ?? 0;
      const finalDeadLetterEvidence = unresolvedDeadLetterEvidence(
        worktree,
        dbPath,
        testHooks.deadLetterDir ?? defaultDeadLetterDir(),
        testHooks.duringDeadLetterRead,
      );
      const finalEventHead =
        (
          db.query("SELECT MAX(id) AS max_id FROM events").get() as {
            max_id: unknown;
          } | null
        )?.max_id ?? 0;
      if (
        postDeadLetterHead !== head ||
        finalEventHead !== head ||
        !receiptSnapshot.stillStable() ||
        !birthSnapshot.stillStable() ||
        finalDeadLetterEvidence === null ||
        finalDeadLetterEvidence.blockingMutation
      ) {
        return null;
      }
      const deadLetterSessions = new Set([
        ...deadLetterEvidence.unorderedSessions,
        ...finalDeadLetterEvidence.unorderedSessions,
      ]);
      for (const claim of claims) {
        if (!deadLetterSessions.has(claim.sessionId)) continue;
        claim.liveness = claim.state === "working" ? "live" : "unknown";
        delete claim.orderedTerminalProof;
      }
      return claims;
    } finally {
      if (transactionOpen) {
        try {
          db.run("ROLLBACK");
        } catch {
          // Closing a read-only connection also releases its snapshot.
        }
      }
      db.close();
    }
  } catch {
    return null;
  }
}

function defaultReadClaims(worktree: string): OwnershipClaim[] | null {
  return readOwnershipClaims(worktree);
}

function defaultClaimLiveness(claim: OwnershipClaim): ClaimLiveness {
  if (claim.state !== undefined) {
    if (claim.state === "working") return "live";
    if (
      claim.orderedTerminalProof === true &&
      (claim.state === "ended" || claim.state === "killed")
    ) {
      return "terminal";
    }
    // A bare missing/stopped/terminal projection can lag an ingested resume.
    // Only the same-snapshot event ordering proof above makes it terminal.
    return "unknown";
  }
  // Injected exact evidence without a jobs row carries its own already-observed
  // verdict. Production DB/receipt claims always include `state` (possibly null).
  return claim.liveness ?? "unknown";
}

function pathAfterTokens(record: string, count: number): string | null {
  let at = 0;
  let spaces = 0;
  while (at < record.length && spaces < count) {
    if (record[at] === " ") {
      spaces += 1;
      at += 1;
    } else {
      at += 1;
    }
  }
  const path = record.slice(at);
  return path.length > 0 ? path : null;
}

/** Parse NUL-framed porcelain v2, retaining both halves of every rename. */
export function parseDirtySurface(raw: string): Map<string, DirtyPath> {
  const result = new Map<string, DirtyPath>();
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const rec = fields[i];
    if (!rec) continue;
    const tag = rec[0];
    if (tag === "1") {
      const path = pathAfterTokens(rec, 8);
      if (path) result.set(path, { path, status: rec.slice(2, 4) });
    } else if (tag === "2") {
      const path = pathAfterTokens(rec, 9);
      const original = fields[i + 1];
      if (path && original) {
        result.set(path, {
          path,
          status: rec.slice(2, 4),
          renamePeer: original,
        });
        result.set(original, {
          path: original,
          status: "D.",
          renamePeer: path,
        });
        i += 1;
      } else if (path) {
        result.set(path, { path, status: rec.slice(2, 4) });
      }
    } else if (tag === "u") {
      const path = pathAfterTokens(rec, 10);
      if (path) result.set(path, { path, status: "UU" });
    } else if (tag === "?" || tag === "!") {
      const path = rec.slice(2);
      if (path) result.set(path, { path, status: tag });
    }
  }
  return result;
}

export async function readDirtySurface(
  worktree: string,
  git: GitRunner,
): Promise<Map<string, DirtyPath> | null> {
  const status = await git(
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    // This reader may be the final ownership linearization immediately before
    // ref CAS. Disable Git's optional index refresh and executable fsmonitor so
    // validation is read-only before any owned-byte baseline exists.
    {
      cwd: worktree,
      env: {
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: "false",
      },
    },
  );
  if (status.code !== 0) return null;
  return parseDirtySurface(status.stdout);
}

/** Canonical repo-relative spelling, without following a symlink leaf. */
export function canonicalizeAdoptedPath(
  worktree: string,
  input: string,
): { path: string } | { code: "outside_worktree" | "invalid_path" } {
  if (!input || input.includes("\0")) return { code: "invalid_path" };
  const absolute = resolve(worktree, input);
  let canonicalRoot = worktree;
  let canonicalAbsolute = absolute;
  try {
    canonicalRoot = realpathSync(worktree);
    // Follow parent directories, but never the leaf: a symlink is itself valid
    // commit content and must not be replaced by its target identity.
    let parent = dirname(absolute);
    const suffix: string[] = [];
    for (;;) {
      try {
        const realParent = realpathSync(parent);
        canonicalAbsolute = join(
          realParent,
          ...suffix.reverse(),
          basename(absolute),
        );
        break;
      } catch {
        const next = dirname(parent);
        if (next === parent) break;
        suffix.push(basename(parent));
        parent = next;
      }
    }
  } catch {
    // A synthetic/injected worktree may not exist. Lexical containment remains
    // deterministic; production's git-resolved worktree takes the real path.
  }
  const rel = relative(canonicalRoot, canonicalAbsolute);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return { code: "outside_worktree" };
  }
  return { path: rel.split(sep).join("/") };
}

function boundedCategory(
  paths: Iterable<string>,
  limit: number,
): SurfaceCategory {
  const all = [...new Set(paths)].sort();
  return {
    total: all.length,
    sample: all.slice(0, limit).map((path) => path.slice(0, 1024)),
  };
}

export function claimIsExclusiveOwnership(claim: OwnershipClaim): boolean {
  return claim.source !== "bash" && claim.source !== "inferred";
}

function mergeClaims(
  durable: OwnershipClaim[] | null,
  direct: DirectSurfaceEvidence | undefined,
  identity: string | null,
  classify: (claim: OwnershipClaim) => ClaimLiveness,
): Map<string, OwnershipClaim[]> {
  const map = new Map<string, OwnershipClaim[]>();
  const add = (claim: OwnershipClaim): void => {
    let liveness: ClaimLiveness = "unknown";
    try {
      liveness = classify(claim);
    } catch {
      liveness = "unknown";
    }
    const normalized = { ...claim, liveness };
    const bucket = map.get(claim.path) ?? [];
    const duplicateAt = bucket.findIndex(
      (other) => other.sessionId === normalized.sessionId,
    );
    if (duplicateAt < 0) {
      bucket.push(normalized);
    } else {
      const previous = bucket[duplicateAt];
      // Direct observations are added after durable rows. Preserve any exact
      // component the newer observation omits, but let its non-null OID/mode
      // replace a null or stale durable identity.
      bucket[duplicateAt] = {
        ...previous,
        ...normalized,
        oid: normalized.oid ?? previous.oid,
        mode: normalized.mode ?? previous.mode,
      };
    }
    map.set(claim.path, bucket);
  };
  for (const claim of durable ?? []) add(claim);
  for (const claim of direct?.claims ?? []) add(claim);
  if (identity) {
    for (const path of direct?.currentSessionPaths ?? []) {
      add({ path, sessionId: identity, liveness: "live", source: "direct" });
    }
  }
  return map;
}

function unsafeForeignSessions(
  claims: OwnershipClaim[],
  identity: string | null,
): string[] {
  // Adoption needs positive terminal evidence for every foreign claimant.
  // Missing job rows, stopped rows, classifier failures, and any other unknown
  // verdict remain conflicts rather than being interpreted as abandonment.
  return [
    ...new Set(
      claims
        .filter(
          (claim) =>
            claimIsExclusiveOwnership(claim) &&
            claim.sessionId !== identity &&
            claim.liveness !== "terminal",
        )
        .map((claim) => claim.sessionId),
    ),
  ].sort();
}

async function ignoredPaths(
  worktree: string,
  paths: string[],
  git: GitRunner,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const res = await git(["check-ignore", "-z", "--stdin"], {
    cwd: worktree,
    stdin: new TextEncoder().encode(`${paths.join("\0")}\0`),
    env: { GIT_LITERAL_PATHSPECS: "1" },
  });
  if (res.code !== 0) return new Set();
  return new Set(res.stdout.split("\0").filter(Boolean));
}

/**
 * Discover and explain the complete dirty surface. Automatic ownership is
 * conservative on unavailable/unknown evidence; exact adoption is validated
 * path-by-path and requires either durable evidence or a complete direct
 * overlap observation.
 */
export async function discoverCommitWorkSurface(
  options: SurfaceDiscoveryOptions,
): Promise<SurfaceDiscoveryResult> {
  const {
    worktree,
    identity,
    adoptedPaths,
    git,
    directEvidence,
    deps = {},
  } = options;
  const limit = options.sampleLimit ?? 20;
  const dirtyRead = await readDirtySurface(worktree, git);
  const dirtyAvailable = dirtyRead !== null;
  const dirtyByPath = dirtyRead ?? new Map();

  const canonical: Array<{ input: string; path: string }> = [];
  const rejections: AdoptionRejection[] = [];
  for (const input of adoptedPaths) {
    const result = canonicalizeAdoptedPath(worktree, input);
    if ("code" in result) {
      rejections.push({ input, code: result.code });
      continue;
    }
    canonical.push({ input, path: result.path });
  }
  const missing = canonical
    .map((entry) => entry.path)
    .filter((path) => !dirtyByPath.has(path));
  const ignored = await ignoredPaths(worktree, missing, git);

  // Keep the ownership snapshot as this discovery's final external read. The
  // caller may use discovery as the publication linearization immediately
  // before ref CAS; all classification below is pure in-memory work.
  let durable: OwnershipClaim[] | null = null;
  try {
    durable = (deps.readClaims ?? defaultReadClaims)(worktree);
  } catch {
    durable = null;
  }
  const evidenceAvailable =
    durable !== null || directEvidence?.complete === true;
  const classify = deps.classifyClaim ?? defaultClaimLiveness;
  const claimsByPath = mergeClaims(durable, directEvidence, identity, classify);

  const caller: string[] = [];
  const unattributed: string[] = [];
  const observed: string[] = [];
  const terminalForeign: string[] = [];
  const liveForeign: string[] = [];
  const ambiguous: string[] = [];
  const excluded: string[] = [];
  const automatic: string[] = [];

  for (const path of [...dirtyByPath.keys()].sort()) {
    if (path === ".keeper" || path.startsWith(EXCLUDED_PREFIX)) {
      excluded.push(path);
      continue;
    }
    const claims = claimsByPath.get(path) ?? [];
    const observations = claims.filter(
      (claim) => !claimIsExclusiveOwnership(claim),
    );
    if (observations.length > 0) observed.push(path);
    const ownershipClaims = claims.filter(claimIsExclusiveOwnership);
    const mine = identity
      ? ownershipClaims.filter(
          (claim) => claim.sessionId === identity && claim.liveness === "live",
        )
      : [];
    const foreign = ownershipClaims.filter(
      (claim) => claim.sessionId !== identity,
    );
    const live = foreign.filter((claim) => claim.liveness === "live");
    const terminal = foreign.filter((claim) => claim.liveness === "terminal");
    const unknown = foreign.filter((claim) => claim.liveness === "unknown");

    if (
      !evidenceAvailable ||
      unknown.length > 0 ||
      (mine.length > 0 && live.length > 0)
    ) {
      ambiguous.push(path);
    } else if (mine.length > 0) {
      caller.push(path);
      automatic.push(path);
    } else if (live.length > 0) {
      if (live.length > 1 || terminal.length > 0) ambiguous.push(path);
      else liveForeign.push(path);
    } else if (terminal.length > 0) {
      terminalForeign.push(path);
    } else {
      unattributed.push(path);
    }
  }

  // Automatic ownership also treats a rename as one operation. If either half
  // has unknown/live-foreign evidence (or crosses into the excluded board),
  // neither half is silently selected.
  const automaticSet = new Set(automatic);
  for (const path of [...automaticSet]) {
    const peer = dirtyByPath.get(path)?.renamePeer;
    if (!peer || automaticSet.has(peer)) continue;
    const peerClaims = claimsByPath.get(peer) ?? [];
    const peerUnsafe = peerClaims.some(
      (claim) =>
        claimIsExclusiveOwnership(claim) &&
        claim.sessionId !== identity &&
        (claim.liveness === "live" || claim.liveness === "unknown"),
    );
    if (peerUnsafe || peer === ".keeper" || peer.startsWith(EXCLUDED_PREFIX)) {
      automaticSet.delete(path);
      for (let i = caller.length - 1; i >= 0; i -= 1) {
        if (caller[i] === path) caller.splice(i, 1);
      }
      ambiguous.push(path, peer);
      continue;
    }
    automaticSet.add(peer);
    caller.push(peer);
  }

  const adopted = new Set<string>();
  for (const entry of canonical) {
    const { input, path } = entry;
    if (path === ".keeper" || path.startsWith(EXCLUDED_PREFIX)) {
      rejections.push({ input, path, code: "excluded" });
      continue;
    }
    if (!dirtyByPath.has(path)) {
      rejections.push({
        input,
        path,
        code: !dirtyAvailable
          ? "unknown_path"
          : ignored.has(path)
            ? "ignored"
            : "clean",
      });
      continue;
    }
    if (!evidenceAvailable) {
      rejections.push({ input, path, code: "ownership_unavailable" });
      continue;
    }
    const conflicts = unsafeForeignSessions(
      claimsByPath.get(path) ?? [],
      identity,
    );
    if (conflicts.length > 0) {
      rejections.push({
        input,
        path,
        code: "ownership_conflict",
        conflicting_sessions: conflicts.slice(0, limit),
      });
      continue;
    }
    adopted.add(path);
    const peer = dirtyByPath.get(path)?.renamePeer;
    if (peer) {
      if (peer === ".keeper" || peer.startsWith(EXCLUDED_PREFIX)) {
        adopted.delete(path);
        rejections.push({ input, path: peer, code: "excluded" });
        continue;
      }
      const peerConflicts = unsafeForeignSessions(
        claimsByPath.get(peer) ?? [],
        identity,
      );
      if (peerConflicts.length > 0) {
        adopted.delete(path);
        rejections.push({
          input,
          path: peer,
          code: "ownership_conflict",
          conflicting_sessions: peerConflicts.slice(0, limit),
        });
      } else {
        adopted.add(peer);
      }
    }
  }

  // An explicit adoption intentionally binds current bytes instead of the
  // caller's stale automatic OID/mode evidence; foreign conflicts still block
  // above. Keep the path in adopted, not both decision classes.
  const resolvedAutomatic = [...automaticSet]
    .filter((path) => !adopted.has(path))
    .sort();
  const selected = [...new Set([...resolvedAutomatic, ...adopted])].sort();
  // Selected adoption joins the caller-owned/selected explanation while its
  // original category remains as diagnostic provenance (notably a terminal
  // foreign claimant, which must remain visible after adoption).
  caller.push(...adopted);
  return {
    selected,
    automatic: resolvedAutomatic,
    adopted: [...adopted].sort(),
    rejections,
    summary: {
      dirty_total: dirtyByPath.size,
      caller_owned_selected: boundedCategory(caller, limit),
      adoptable_unattributed: boundedCategory(unattributed, limit),
      observed_adoptable: boundedCategory(observed, limit),
      terminal_foreign_adoptable: boundedCategory(terminalForeign, limit),
      live_foreign_conflict: boundedCategory(liveForeign, limit),
      multi_ambiguous: boundedCategory(ambiguous, limit),
      excluded: boundedCategory(excluded, limit),
      ambient_staged_carryover: { total: 0, sample: [] },
    },
    claimsByPath,
    dirtyByPath,
    evidenceAvailable,
    dirtyAvailable,
  };
}
