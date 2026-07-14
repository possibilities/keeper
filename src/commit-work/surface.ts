import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { openDb, resolveDbPath } from "../db";
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
  | "ownership_conflict";

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

const EXCLUDED_PREFIX = ".keeper/";

function defaultReadClaims(worktree: string): OwnershipClaim[] | null {
  try {
    const { db } = openDb(resolveDbPath(), { readonly: true });
    try {
      const rows = db
        .query(
          `SELECT fa.file_path, fa.session_id, fa.worktree_oid, fa.worktree_mode,
                  fa.source, j.state
             FROM file_attributions fa
             LEFT JOIN jobs j ON j.job_id = fa.session_id
            WHERE fa.project_dir = ?
              AND fa.last_mutation_at > COALESCE(fa.last_commit_at, 0)
            ORDER BY fa.file_path, fa.session_id`,
        )
        .all(worktree) as Array<{
        file_path: string;
        session_id: string;
        worktree_oid: string | null;
        worktree_mode: string | null;
        source: string | null;
        state: string | null;
      }>;
      return rows.map((row) => ({
        path: row.file_path,
        sessionId: row.session_id,
        liveness: defaultClaimLiveness({ state: row.state } as OwnershipClaim),
        state: row.state,
        oid: row.worktree_oid,
        mode: row.worktree_mode,
        source: row.source,
      }));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function defaultClaimLiveness(claim: OwnershipClaim): ClaimLiveness {
  if (claim.state === "working") return "live";
  if (claim.state === "ended" || claim.state === "killed") return "terminal";
  // A durable row with a missing/stopped/unrecognized job state is not positive
  // terminal evidence. Direct evidence omits `state` and carries its already-
  // observed liveness explicitly.
  if (claim.state !== undefined) return "unknown";
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
    { cwd: worktree },
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
            claim.sessionId !== identity && claim.liveness !== "terminal",
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
 * path-by-path and is allowed to continue when durable evidence is unavailable.
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
  const dirtyRead = await readDirtySurface(worktree, git);
  const dirtyAvailable = dirtyRead !== null;
  const dirtyByPath = dirtyRead ?? new Map();

  const caller: string[] = [];
  const unattributed: string[] = [];
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
    const mine = identity
      ? claims.filter((claim) => claim.sessionId === identity)
      : [];
    const foreign = claims.filter((claim) => claim.sessionId !== identity);
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

  const resolvedAutomatic = [...automaticSet].sort();
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
