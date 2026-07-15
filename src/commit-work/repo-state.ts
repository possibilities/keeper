/**
 * Pre-commit repo-state guards for `keeper commit-work`, layered around the
 * index-purity flow (three gates, ordered cheap-to-expensive):
 *
 *   1. {@link detectInProgressOperation} — a repo mid-merge / -cherry-pick /
 *      -revert / -rebase / -bisect. A full `git commit` mid-merge silently
 *      creates a two-parent merge commit (the shape that propagated the
 *      incident's stale blobs through an auto-merge). Pure git via the injected
 *      {@link GitRunner} seam; worktree-portable (`.git` is a FILE in a linked
 *      lane, so every path resolves through `rev-parse --git-path`).
 *   2. {@link sharedCheckoutJamActive} — a live shared-checkout dirty/desync
 *      distress row matching this repo. A jam means the working tree may trail
 *      landed history; committing risks sweeping stale content. Read-only
 *      keeper.db probe, FAIL-OPEN (a repo with no keeper state commits fine).
 *   3. {@link analyzeReversionSweep} + {@link isMassReversion} — the mass-reversion
 *      signature: a staged path whose post-stage index blob equals an ancestor
 *      blob while differing from HEAD's. The incident swept ~96 paths back to
 *      stale content; this trips before that lands.
 *
 * Git access is the injected {@link GitRunner} seam throughout, so the whole
 * module is exercised with zero real git.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { defaultDbPath, openDb } from "../db";
import {
  SHARED_DESYNC_DISTRESS_ID_PREFIX,
  SHARED_DIRTY_DISTRESS_ID_PREFIX,
  SHARED_DIRTY_DISTRESS_VERB,
} from "../dispatch-failure-key";
import type { GitRunner } from "./git-exec";

// ---------------------------------------------------------------------------
// Gate 1 — in-progress operation refusal (pure git, pre-lock, no override)
// ---------------------------------------------------------------------------

/** The sequencer/merge operations a commit must not run on top of. */
export type InProgressOperation =
  | "merge"
  | "cherry-pick"
  | "revert"
  | "rebase"
  | "bisect";

/**
 * The pseudo-refs whose PRESENCE marks a sequencer op in flight, probed by ref
 * existence (`git rev-parse -q --verify <ref>` — exit 0 + a sha when present).
 * Mirrors git's own `wt_status_get_state`.
 */
const IN_PROGRESS_REF_PROBES: ReadonlyArray<{
  ref: string;
  op: InProgressOperation;
}> = [
  { ref: "MERGE_HEAD", op: "merge" },
  { ref: "CHERRY_PICK_HEAD", op: "cherry-pick" },
  { ref: "REVERT_HEAD", op: "revert" },
];

/**
 * The git-dir-relative paths whose PRESENCE marks an op in flight, probed by
 * file/dir existence at the `rev-parse --git-path`-resolved location — the
 * worktree-portable resolve (`.git` is a FILE in a linked lane and the state
 * lives in the per-worktree gitdir, so `.git/` is never hardcoded). Both rebase
 * backends (`rebase-merge` interactive/merge, `rebase-apply` am) collapse to
 * `rebase`, matching git's status.
 */
const IN_PROGRESS_PATH_PROBES: ReadonlyArray<{
  name: string;
  op: InProgressOperation;
}> = [
  { name: "rebase-merge", op: "rebase" },
  { name: "rebase-apply", op: "rebase" },
  { name: "BISECT_LOG", op: "bisect" },
];

/**
 * Resolve the first in-progress merge/sequencer operation, or `null` when the
 * repo is quiescent. `pathExists` is injectable (defaults to {@link existsSync})
 * so the directory/bisect probes are exercised without touching the filesystem.
 * Every git call is worktree-portable and fail-safe: a git error on any probe is
 * treated as "not in that state" rather than a hard failure (the caller's own
 * commit would surface a genuine repo fault).
 */
export async function detectInProgressOperation(
  cwd: string,
  run: GitRunner,
  pathExists: (p: string) => boolean = existsSync,
): Promise<InProgressOperation | null> {
  for (const { ref, op } of IN_PROGRESS_REF_PROBES) {
    const res = await run(["rev-parse", "-q", "--verify", ref], { cwd });
    if (res.code === 0 && res.stdout.trim().length > 0) return op;
  }
  for (const { name, op } of IN_PROGRESS_PATH_PROBES) {
    const res = await run(["rev-parse", "--git-path", name], { cwd });
    if (res.code !== 0) continue;
    const raw = res.stdout.trim();
    if (raw.length === 0) continue;
    const resolved = isAbsolute(raw) ? raw : join(cwd, raw);
    if (pathExists(resolved)) return op;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gate 2 — shared-checkout jam refusal (keeper.db read, pre-lock, override)
// ---------------------------------------------------------------------------

/**
 * Normalize a repo dir for the jam-row dir compare: realpath (converges a
 * symlinked producer path against git's realpath'd toplevel — e.g. macOS
 * `/var/…` vs `/private/var/…`) then strip a trailing slash. A path that cannot
 * be realpath'd (a torn-down worktree the distress row still names) degrades to
 * the lexical trailing-slash-stripped form — never throws.
 */
export function normalizeRepoDir(p: string): string {
  let s = p;
  try {
    s = realpathSync(p);
  } catch {
    // Keep the lexical form when the path no longer exists on disk.
  }
  return s.replace(/\/+$/, "");
}

/**
 * True iff a LIVE shared-checkout dirty/desync distress row matches this repo —
 * an open `dispatch_failures` row with the synthetic `daemon` verb whose id
 * carries the dirty/desync prefix and whose `dir` normalizes to `worktree`. The
 * gate fires on row PRESENCE (independent of any notified marker — presence means
 * the tree is in a bad state).
 *
 * FAIL-OPEN by construction: the read-only `openDb` throws on a missing file, and
 * commit-work carries no `NotadbTolerance` — so the whole probe is wrapped, and
 * ANY fault (missing, locked, NOTADB, malformed) proceeds WITHOUT the gate so
 * commit-work keeps working in a repo with no keeper state. `dbPath` is
 * injectable for the parity/no-DB tests.
 */
export function sharedCheckoutJamActive(
  worktree: string,
  dbPath: string = defaultDbPath(),
): boolean {
  try {
    const { db } = openDb(dbPath, { readonly: true });
    let rows: Array<{ dir: string | null }>;
    try {
      rows = db
        .query(
          "SELECT dir FROM dispatch_failures WHERE verb = ? " +
            "AND (id LIKE ? OR id LIKE ?)",
        )
        .all(
          SHARED_DIRTY_DISTRESS_VERB,
          `${SHARED_DIRTY_DISTRESS_ID_PREFIX}%`,
          `${SHARED_DESYNC_DISTRESS_ID_PREFIX}%`,
        ) as Array<{ dir: string | null }>;
    } finally {
      db.close();
    }
    const target = normalizeRepoDir(worktree);
    return rows.some(
      (r) =>
        r.dir != null && r.dir !== "" && normalizeRepoDir(r.dir) === target,
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Gate 3 — mass-reversion tripwire (in-lock, post-stage, override)
// ---------------------------------------------------------------------------

/**
 * The reversion thresholds — a staged set trips only when the candidate count
 * clears BOTH a floor AND a fraction, so a small intentional revert and a large
 * legitimate refactor both stay under. First-guess policy; retuning is a
 * one-line change here.
 */
export const REVERSION_MIN_COUNT = 5;
export const REVERSION_MIN_FRACTION = 0.3;
/** How many ancestors back (HEAD~1..HEAD~N) a reverted blob is looked for. */
export const REVERSION_ANCESTOR_DEPTH = 30;

/**
 * Regenerated/oscillating surfaces excluded from the reversion numerator — an
 * intentional revert, lockfile churn, and formatting round-trips are the
 * false-positive profile. THIS repo's set; a future task extends the constant.
 * Semantics: a `<dir>/**` entry matches that subtree, a `*.<ext>` entry matches
 * any path ending in `.<ext>`, everything else is an exact repo-relative match.
 */
export const REVERSION_EXCLUDE_GLOBS: readonly string[] = [
  "plugins/prompt/corpus/**",
  "plugins/prompt/test/oracle/**",
  "bun.lockb",
  "package-lock.json",
  "*.lock",
];

/** Whether `path` is a regenerated surface excluded from the reversion sweep. */
export function isReversionExcluded(path: string): boolean {
  for (const glob of REVERSION_EXCLUDE_GLOBS) {
    if (glob.endsWith("/**")) {
      const base = glob.slice(0, -3);
      if (path === base || path.startsWith(`${base}/`)) return true;
    } else if (glob.startsWith("*.")) {
      if (path.endsWith(glob.slice(1))) return true;
    } else if (path === glob) {
      return true;
    }
  }
  return false;
}

/** The git mode marking a submodule gitlink — excluded from blob probing. */
const GITLINK_MODE = "160000";

interface IndexEntry {
  mode: string;
  oid: string;
  stage: string;
}

/**
 * Parse `git ls-files -s -z` output into a repo-relative path → index entry map.
 * Records are NUL-delimited; each is `<mode> <oid> <stage>\t<path>` (the tab
 * survives `-z`). A path that appears with more than one stage (an unmerged
 * entry) surfaces its non-zero stage so the caller can refuse.
 */
function parseLsFiles(stdout: string): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  for (const rec of stdout.split("\0")) {
    if (rec.length === 0) continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(" ");
    const path = rec.slice(tab + 1);
    if (meta.length < 3 || path.length === 0) continue;
    const [mode, oid, stage] = meta;
    // Keep the first stage>0 entry visible (unmerged); an ordinary stage-0 entry
    // overwrites nothing meaningful since a path is either fully merged or not.
    const existing = map.get(path);
    if (existing === undefined || existing.stage === "0") {
      map.set(path, { mode, oid, stage });
    }
  }
  return map;
}

/**
 * Parse `git cat-file --batch-check` output into the per-spec object id (in
 * input order), `""` for a missing object. A found object echoes
 * `<oid> <type> <size>`; a missing one echoes `<input> missing` — so key on the
 * trailing token, never assume field 1 is a sha. Returns `null` when the line
 * count does not match the spec count (a mis-correlation would be a false trip,
 * so bail safe).
 */
function parseBatchCheck(stdout: string, expected: number): string[] | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length !== expected) return null;
  return lines.map((line) => {
    if (line.endsWith(" missing")) return "";
    const oid = line.split(" ")[0];
    return oid ?? "";
  });
}

/** The mass-reversion analysis over a staged set. */
export interface ReversionSweep {
  /** Unmerged (stage 1/2/3) staged paths — a refuse condition of its own. */
  unmergedPaths: string[];
  /** Paths whose index blob reverts to an ancestor while differing from HEAD. */
  reversionCandidates: string[];
  /** The denominator: the full attributed staged set size. */
  stagedCount: number;
}

/**
 * Detect the mass-reversion signature over `stagedNames` (the attributed staged
 * set). A path is a reversion candidate when its post-stage INDEX blob equals
 * some `HEAD~1..HEAD~{@link REVERSION_ANCESTOR_DEPTH}` ancestor blob while
 * differing from HEAD's blob. Gitlinks and the {@link REVERSION_EXCLUDE_GLOBS}
 * surfaces are excluded from the numerator; the denominator stays the full set.
 *
 * Two git calls only: one `ls-files -s -z` for index blobs (pathspec-limited,
 * literal-pathspecs) and ONE buffered `cat-file --batch-check` feeding every
 * `<rev>:<path>` spec on stdin. A history shorter than the window degrades to
 * fewer ancestors probed (missing lines → no blob → no match) — never an error,
 * never a false trip. Rename-blind (a rename inside the window suppresses the
 * signal) is an accepted limitation.
 */
export async function analyzeReversionSweep(
  stagedNames: string[],
  cwd: string,
  run: GitRunner,
): Promise<ReversionSweep> {
  const empty: ReversionSweep = {
    unmergedPaths: [],
    reversionCandidates: [],
    stagedCount: stagedNames.length,
  };
  if (stagedNames.length === 0) return empty;

  const ls = await run(["ls-files", "-s", "-z", "--", ...stagedNames], {
    cwd,
    env: { GIT_LITERAL_PATHSPECS: "1" },
  });
  if (ls.code !== 0) return empty;
  const index = parseLsFiles(ls.stdout);

  const unmergedPaths = [...index.entries()]
    .filter(([, e]) => e.stage !== "0")
    .map(([p]) => p)
    .sort();
  if (unmergedPaths.length > 0) {
    return {
      unmergedPaths,
      reversionCandidates: [],
      stagedCount: empty.stagedCount,
    };
  }

  // Blob-comparable candidate paths: staged, non-gitlink, non-excluded.
  const candidates = stagedNames.filter((p) => {
    const e = index.get(p);
    return (
      e !== undefined && e.mode !== GITLINK_MODE && !isReversionExcluded(p)
    );
  });
  if (candidates.length === 0) return empty;

  // One buffered cat-file: per candidate, HEAD:P then HEAD~1:P..HEAD~DEPTH:P.
  const specsPerPath = REVERSION_ANCESTOR_DEPTH + 1;
  const specs: string[] = [];
  for (const p of candidates) {
    specs.push(`HEAD:${p}`);
    for (let k = 1; k <= REVERSION_ANCESTOR_DEPTH; k++)
      specs.push(`HEAD~${k}:${p}`);
  }
  const batch = await run(["cat-file", "--batch-check"], {
    cwd,
    stdin: new TextEncoder().encode(`${specs.join("\n")}\n`),
  });
  if (batch.code !== 0) return { ...empty };
  const oids = parseBatchCheck(batch.stdout, specs.length);
  if (oids === null) return { ...empty };

  const reversionCandidates: string[] = [];
  candidates.forEach((p, i) => {
    const base = i * specsPerPath;
    const headOid = oids[base];
    const indexOid = index.get(p)?.oid ?? "";
    if (indexOid === "" || indexOid === headOid) return;
    for (let k = 1; k <= REVERSION_ANCESTOR_DEPTH; k++) {
      if (oids[base + k] === indexOid) {
        reversionCandidates.push(p);
        return; // short-circuit at the first ancestor match
      }
    }
  });

  return {
    unmergedPaths: [],
    reversionCandidates: reversionCandidates.sort(),
    stagedCount: empty.stagedCount,
  };
}

/**
 * Whether a candidate count trips the mass-reversion tripwire: at or past BOTH
 * the count floor AND the staged-set fraction (a concluded-then-committed
 * intentional revert trips by design; `--allow-mass-reversion` is its escape).
 */
export function isMassReversion(
  candidateCount: number,
  stagedCount: number,
): boolean {
  return (
    candidateCount >= REVERSION_MIN_COUNT &&
    candidateCount >= REVERSION_MIN_FRACTION * stagedCount
  );
}
