#!/usr/bin/env bun
/**
 * `keeper show-job` — fetch ONE job's full metadata row from the `jobs`
 * projection as a pretty JSON envelope (epic fn-840). Read-only over keeper.db
 * so consumers stop hand-writing sqlite against a schema keeper owns.
 *
 * A positional/`--session` reference resolves through the shared Session
 * catalog before selecting one associated job. Exact job-only/cwd/pane filters
 * remain orthogonal, plus zero-flag auto-detection that (a) shows your own job
 * when run inside a Claude session (`$CLAUDE_CODE_SESSION_ID`), (b) shows the single live agent
 * in your current tmux WINDOW when you split a shell pane beside it, else
 * (c) the git-toplevel containing your cwd.
 *
 * Architecture: impure I/O lives in `main` (DB open, env/tmux/cwd reads, exit
 * codes); the resolver `resolveJob(db, selectors)` is PURE over a db handle +
 * fully-resolved plain-data selectors, so every path is unit-testable in-process
 * via `freshMemDb()` with no tmux/env/fs. NO schema-version guard (in-binary
 * readers deliberately skip it).
 *
 * Output rides the shared one-shot envelope (`cli/envelope.ts`):
 * `{schema_version, ok, error, data}`. A resolved job is `data:{job, resolution}`
 * (exit 0); a `not_found` / `ambiguous` domain miss and a keeper.db read failure
 * are `ok:false` with `error.{code,message,recovery}` (exit 1) — the ambiguous
 * case carries its candidate list on `error.details.candidates`. Argument-usage
 * errors stay on stderr (exit 2), never the envelope.
 */

import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { resolveSessionId } from "../src/commit-work/session-id";
import { openDb, resolveDbPath } from "../src/db";
import {
  buildTmuxListPanesArgs,
  execBackendEnvMeta,
  localeDefaultedEnv,
} from "../src/exec-backend";
import {
  type Envelope,
  type EnvelopeSink,
  emitEnvelope,
  errorEnvelope,
  processEnvelopeSink,
  RECOVERY_DB_READ,
  successEnvelope,
} from "./envelope";
import {
  resolveTrackedCliSession,
  type SessionReferenceCliDeps,
  trackedSessionProblem,
} from "./session-reference";

/** Envelope schema version for `keeper show-job` (versions the `data` payload). */
export const SHOW_JOB_SCHEMA_VERSION = 1;

const HELP = `keeper show-job [<session-reference>] [selectors] [options]

Fetch one job's full metadata. A positional or --session reference resolves by
qualified native id, exact job/native id, or exact current/historical title,
then requires exactly one associated Keeper job. Native-only Sessions return
not_tracked; multiple associated jobs return bounded candidates.

With no selector, auto-detects: your own job inside a Claude session
($CLAUDE_CODE_SESSION_ID), else the single live agent in your current tmux
window (split a shell pane beside it), else the job whose cwd contains yours.

Selectors (explicit flags AND together — they narrow):
  --session <ref>      Shared Session reference (alternative to positional)
  --session-title <t>  Compatibility alias of --session
  --job-id <id>        Exact job-only filter; also narrows a Session's jobs
  --cwd <dir>          Match jobs under <dir>'s git toplevel (default: cwd)
  --cwd-exact          Strict cwd equality instead of toplevel containment
  --pane <%N>          Match backend_exec_pane_id exactly (bare N → %N)

Options:
  --latest             Collapse an ambiguous job-only cwd/pane query; ignored
                       for Session references, which never recency-collapse
  --raw                Leave JSON-TEXT columns (name_history/epic_links/
                       monitors) as raw TEXT instead of decoding them
  --help, -h           Show this help
`;

/**
 * Live (non-terminal) job states. LOCAL mirror of `src/reducer.ts`'s
 * `LIVE_STATES` ({working, stopped}) — copied deliberately so the re-fold-sacred
 * reducer stays untouched; terminal states are `ended` / `killed`.
 */
const LIVE_STATES = new Set(["working", "stopped"]);

// ---------------------------------------------------------------------------
// Selectors — plain data handed to the pure resolver
// ---------------------------------------------------------------------------

/**
 * Fully-resolved selector set. `main` performs ALL impure resolution (env,
 * tmux, cwd → git toplevel) and hands the resolver only plain data, so every
 * resolution path is unit-testable in-process.
 */
export interface Selectors {
  /** Exact `job_id` match. */
  jobId?: string;
  /** Candidate job ids from one already-resolved Session. */
  jobIds?: string[];
  /** Git-toplevel containment root (realpath'd) for prefix matching. */
  cwdRoot?: string;
  /** Strict cwd equality target (raw, un-realpath'd to match stored cwd). */
  cwdExact?: string;
  /** `backend_exec_pane_id IN (...)` set — explicit `--pane` or window scope. */
  paneIds?: string[];
  /** Collapse a >1 ambiguity to the deterministic-sort top. */
  latest?: boolean;
  /** Session-derived candidates never use the live/latest collapse rules. */
  strictAmbiguity?: boolean;
  /** Resolution method label echoed back in the success envelope. */
  method?: string;
}

/** A full `jobs` row. JSON-TEXT columns arrive as TEXT; decode happens later. */
export type JobRow = Record<string, unknown>;

export type ResolveResult =
  | { kind: "ok"; row: JobRow; matchedField?: string }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: JobRow[] };

/**
 * Deterministic total order over the candidate set → byte-stable candidate
 * lists and a stable `--latest` pick: live jobs first, then most-recent by
 * active_since/updated_at/created_at, then job_id ASC as the final tiebreak.
 */
const ORDER_BY = `
  CASE WHEN state IN ('working','stopped') THEN 0 ELSE 1 END,
  COALESCE(active_since, updated_at, created_at) DESC,
  updated_at DESC,
  job_id ASC`;

/** Escape LIKE wildcards so a path with `%`/`_`/`\` matches literally. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Apply the ambiguity rule to an ORDER-BY-sorted candidate set:
 *   0 matches            → not_found
 *   exactly 1            → return it (a lone TERMINAL job IS returned)
 *   >1 Session-derived     → ambiguous (strict; no liveness/recency collapse)
 *   >1 job-only, 1 live    → return the live one
 *   >1 job-only otherwise  → ambiguous (unless --latest selects sort top)
 * `--latest` is strictly a job-only >1 tiebreaker and never fabricates a hit.
 */
function applyAmbiguity(
  rows: JobRow[],
  matchedField: string | undefined,
  latest: boolean,
  strictAmbiguity: boolean,
): ResolveResult {
  if (rows.length === 0) return { kind: "not_found" };
  if (rows.length === 1) return { kind: "ok", row: rows[0], matchedField };
  if (strictAmbiguity) return { kind: "ambiguous", candidates: rows };
  const live = rows.filter((r) => LIVE_STATES.has(String(r.state)));
  if (live.length === 1) return { kind: "ok", row: live[0], matchedField };
  if (latest) return { kind: "ok", row: rows[0], matchedField };
  return { kind: "ambiguous", candidates: rows };
}

/**
 * PURE resolver over `(db handle, resolved selectors)`. Builds a bound-param
 * query (NEVER string-interpolated), runs it through the ambiguity rule, and
 * returns a discriminated result. No env / tmux / cwd / `Date.now()` reads —
 * those happen in `main` and arrive as plain data.
 *
 * Explicit job-only selectors AND together: they NARROW. Session/title
 * matching happens before this query in the shared catalog resolver.
 */
export function resolveJob(db: Database, sel: Selectors): ResolveResult {
  const where: string[] = [];
  const params: unknown[] = [];
  const fields: string[] = [];

  if (sel.jobId !== undefined) {
    where.push("job_id = ?");
    params.push(sel.jobId);
    fields.push("job_id");
  }

  if (sel.jobIds !== undefined) {
    if (sel.jobIds.length === 0) return { kind: "not_found" };
    where.push(`job_id IN (${sel.jobIds.map(() => "?").join(",")})`);
    params.push(...sel.jobIds);
    fields.push("job_id");
  }

  if (sel.cwdExact !== undefined) {
    where.push("cwd = ?");
    params.push(sel.cwdExact);
    fields.push("cwd");
  } else if (sel.cwdRoot !== undefined) {
    // Path-boundary guard: match the root itself OR a path under it. The LIKE
    // prefix carries a TRAILING SLASH so `/repo/foo` never matches
    // `/repo/foobar`; wildcards in the root are escaped to match literally.
    where.push("(cwd = ? OR cwd LIKE ? ESCAPE '\\')");
    params.push(sel.cwdRoot, `${escapeLike(sel.cwdRoot)}/%`);
    fields.push("cwd");
  }

  if (sel.paneIds !== undefined && sel.paneIds.length > 0) {
    const placeholders = sel.paneIds.map(() => "?").join(",");
    where.push(`backend_exec_pane_id IN (${placeholders})`);
    params.push(...sel.paneIds);
    fields.push("backend_exec_pane_id");
  }

  // No effective filter — caller (main) must guard this before calling, but a
  // pure resolver stays total: an empty WHERE would scan every job, so treat it
  // as not_found rather than returning an arbitrary row.
  if (where.length === 0) return { kind: "not_found" };

  // DISTINCT keeps future join-based narrowing from duplicating a job row.
  const sql = `SELECT DISTINCT * FROM jobs WHERE ${where.join(
    " AND ",
  )} ORDER BY ${ORDER_BY}`;
  const rows = db.query(sql).all(...(params as never[])) as JobRow[];

  const matchedField = fields.length === 1 ? fields[0] : undefined;
  return applyAmbiguity(
    rows,
    matchedField,
    sel.latest ?? false,
    sel.strictAmbiguity ?? false,
  );
}

// ---------------------------------------------------------------------------
// JSON-TEXT column decoding
// ---------------------------------------------------------------------------

const JSON_TEXT_COLUMNS = ["name_history", "epic_links", "monitors"];

/**
 * Return a copy of the row with the JSON-TEXT columns decoded — UNLESS `raw` is
 * set, in which case the row passes through untouched (columns stay TEXT). A
 * malformed blob folds to `[]` (never throws). Exported so the unit test drives
 * the same decode the envelope emits.
 */
export function decodeFor(row: JobRow, raw: boolean): JobRow {
  if (raw) return row;
  const out: JobRow = { ...row };
  for (const col of JSON_TEXT_COLUMNS) {
    if (!(col in out)) continue;
    const val = out[col];
    if (typeof val !== "string") continue;
    try {
      out[col] = JSON.parse(val);
    } catch {
      out[col] = [];
    }
  }
  return out;
}

const SHOW_JOB_CANDIDATES_MAX = 25;
const SHOW_JOB_CANDIDATE_TEXT_MAX = 512;
const SHOW_JOB_SESSION_FILTER_IDS_MAX = 500;

function boundedCandidateValue(value: unknown): unknown {
  return typeof value === "string" && value.length > SHOW_JOB_CANDIDATE_TEXT_MAX
    ? value.slice(0, SHOW_JOB_CANDIDATE_TEXT_MAX)
    : value;
}

/** The compact, field- and count-bounded ambiguous-candidate shape. */
function candidateView(row: JobRow): JobRow {
  return {
    job_id: boundedCandidateValue(row.job_id),
    title: boundedCandidateValue(row.title),
    state: boundedCandidateValue(row.state),
    cwd: boundedCandidateValue(row.cwd),
    backend_exec_pane_id: boundedCandidateValue(row.backend_exec_pane_id),
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Impure resolution (main only) — env / tmux / cwd → git toplevel
// ---------------------------------------------------------------------------

/**
 * Resolve a cwd to its containing git toplevel via a one-shot
 * `git -C <dir> --no-optional-locks rev-parse --show-toplevel`. Returns `null`
 * when the dir isn't inside a worktree (or the spawn fails / times out). Mirrors
 * `cli/await.ts`'s local git-toplevel shell-out — a LOCAL copy rather than
 * exporting the non-exported `defaultGitRoot`. Side-effecting: `main` only.
 */
function resolveGitRoot(dir: string): string | null {
  try {
    const res = Bun.spawnSync(
      ["git", "-C", dir, "--no-optional-locks", "rev-parse", "--show-toplevel"],
      { stdout: "pipe", stderr: "ignore", timeout: 2000 },
    );
    if (!res.success || res.exitCode !== 0) return null;
    const root = res.stdout.toString().trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/** realpathSync that degrades to the input on failure (never throws). */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Read the current shell's `$TMUX_PANE` (fallback `$KEEPER_TMUX_PANE`; names via
 * `execBackendEnvMeta()`), then ask tmux for the set of pane ids sharing that
 * pane's WINDOW. Returns `null` (skip the signal) when not in tmux, tmux isn't
 * running, the sweep is degraded, or our pane isn't found. NEVER throws.
 */
function tmuxWindowPaneIds(
  env: Record<string, string | undefined>,
): string[] | null {
  const meta = execBackendEnvMeta();
  const ourPane = env[meta.paneIdEnvVar] || env[meta.paneIdCarrierEnvVar];
  if (!ourPane) return null;
  let out: string;
  try {
    const res = Bun.spawnSync(buildTmuxListPanesArgs(), {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000,
      env: localeDefaultedEnv(
        process.env as Record<string, string | undefined>,
      ),
    });
    if (!res.success || res.exitCode !== 0) return null;
    out = res.stdout.toString();
  } catch {
    return null;
  }
  // Each line is `pane_id\twindow_id\twindow_name`. Find our pane's window, then
  // collect every pane id in that window.
  let ourWindow: string | null = null;
  const byWindow = new Map<string, string[]>();
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const parts = line.split("\t");
    const paneId = parts[0];
    const windowId = parts[1];
    if (paneId === undefined || windowId === undefined) continue;
    const list = byWindow.get(windowId) ?? [];
    list.push(paneId);
    byWindow.set(windowId, list);
    if (paneId === ourPane) ourWindow = windowId;
  }
  if (ourWindow === null) return null;
  return byWindow.get(ourWindow) ?? null;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  help: boolean;
  jobId: string | null;
  sessionReference: string | null;
  cwd: string | null;
  cwdExact: boolean;
  pane: string | null;
  latest: boolean;
  raw: boolean;
}

function die(msg: string): never {
  process.stderr.write(`keeper show-job: ${msg}\n`);
  process.exit(2);
}

/** Read `--flag value` or `--flag=value`; `process.exit(2)` on a missing value. */
function takeValue(
  argv: string[],
  i: number,
  flag: string,
): { value: string; next: number } {
  const a = argv[i];
  const eq = `${flag}=`;
  if (a.startsWith(eq)) return { value: a.slice(eq.length), next: i };
  const v = argv[i + 1];
  if (v === undefined) die(`${flag} requires a value`);
  return { value: v, next: i + 1 };
}

function parseArgs(argv: string[]): ParsedArgs {
  const p: ParsedArgs = {
    help: false,
    jobId: null,
    sessionReference: null,
    cwd: null,
    cwdExact: false,
    pane: null,
    latest: false,
    raw: false,
  };
  const setReference = (value: string, spelling: string): void => {
    if (value.length === 0) die(`${spelling} requires a value`);
    if (p.sessionReference !== null) {
      die("specify the Session reference only once");
    }
    p.sessionReference = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") {
      p.help = true;
    } else if (a === "--job-id" || a.startsWith("--job-id=")) {
      const r = takeValue(argv, i, "--job-id");
      p.jobId = r.value;
      i = r.next;
    } else if (
      a === "--session" ||
      a.startsWith("--session=") ||
      a === "--session-title" ||
      a.startsWith("--session-title=")
    ) {
      const flag = a.startsWith("--session-title")
        ? "--session-title"
        : "--session";
      const r = takeValue(argv, i, flag);
      setReference(r.value, flag);
      i = r.next;
    } else if (a === "--cwd" || a.startsWith("--cwd=")) {
      const r = takeValue(argv, i, "--cwd");
      p.cwd = r.value;
      i = r.next;
    } else if (a === "--cwd-exact") {
      p.cwdExact = true;
    } else if (a === "--pane" || a.startsWith("--pane=")) {
      const r = takeValue(argv, i, "--pane");
      p.pane = r.value;
      i = r.next;
    } else if (a === "--latest") {
      p.latest = true;
    } else if (a === "--raw") {
      p.raw = true;
    } else if (!a.startsWith("-")) {
      setReference(a, "<session-reference>");
    } else {
      die(`unexpected argument '${a}'`);
    }
  }
  return p;
}

/** Normalize a bare pane number (`3`) to tmux's `%N` form; pass `%N` through. */
function normalizePane(raw: string): string {
  return raw.startsWith("%") ? raw : `%${raw}`;
}

// ---------------------------------------------------------------------------
// main — all impure resolution + envelope + exit codes
// ---------------------------------------------------------------------------

export function main(
  argv: string[],
  sink: EnvelopeSink = processEnvelopeSink,
  referenceDeps: SessionReferenceCliDeps = {},
): void {
  const args = parseArgs(argv);
  if (args.help) {
    sink.writeStdout(HELP);
    return;
  }

  const env = (referenceDeps.env ?? process.env) as Record<
    string,
    string | undefined
  >;
  const sessionMode = args.sessionReference !== null;

  // An explicit PRIMARY selector pins the job; auto-detection runs only when
  // none is given. `--cwd <dir>` / `--cwd-exact` are explicit; bare cwd is auto.
  const hasExplicitPrimary =
    sessionMode ||
    args.jobId !== null ||
    args.pane !== null ||
    args.cwd !== null ||
    args.cwdExact;

  // Build job-only filters first. Session resolution below supplies either one
  // exact job id or the complete associated-job candidate set.
  const baseSelectors: Selectors = {
    latest: sessionMode ? false : args.latest,
    strictAmbiguity: sessionMode,
  };
  if (!sessionMode && args.jobId !== null) baseSelectors.jobId = args.jobId;
  if (args.pane !== null) baseSelectors.paneIds = [normalizePane(args.pane)];

  if (args.cwd !== null || args.cwdExact) {
    const dir = args.cwd ?? process.cwd();
    if (args.cwdExact) {
      baseSelectors.cwdExact = dir;
    } else {
      const root = resolveGitRoot(dir);
      if (root !== null) baseSelectors.cwdRoot = safeRealpath(root);
    }
  }

  let sessionMatch: string | undefined;
  if (args.sessionReference !== null) {
    const tracked = resolveTrackedCliSession(
      args.sessionReference,
      referenceDeps,
      args.jobId === null ? {} : { jobId: args.jobId },
    );
    if (tracked.kind === "resolved") {
      baseSelectors.jobId = tracked.job.jobId;
      sessionMatch = tracked.match;
    } else if (
      (tracked.kind === "job_ambiguous" ||
        tracked.kind === "session_ambiguous") &&
      (baseSelectors.paneIds !== undefined ||
        baseSelectors.cwdExact !== undefined ||
        baseSelectors.cwdRoot !== undefined)
    ) {
      const candidateJobIds = [
        ...new Set(
          tracked.kind === "job_ambiguous"
            ? tracked.candidates.map((candidate) => candidate.jobId)
            : tracked.candidates.flatMap((candidate) => candidate.jobIds),
        ),
      ];
      if (
        candidateJobIds.length === 0 ||
        candidateJobIds.length > SHOW_JOB_SESSION_FILTER_IDS_MAX
      ) {
        emitEnvelope(
          errorEnvelope(
            SHOW_JOB_SCHEMA_VERSION,
            trackedSessionProblem(tracked),
          ),
          sink,
        );
        return;
      }
      baseSelectors.jobIds = candidateJobIds;
      sessionMatch = tracked.match;
    } else {
      emitEnvelope(
        errorEnvelope(SHOW_JOB_SCHEMA_VERSION, trackedSessionProblem(tracked)),
        sink,
      );
      return;
    }
  }

  // Open read-only; busy_timeout is set by applyPragmas, no immutable=1.
  let db: Database;
  try {
    db = openDb(referenceDeps.dbPath ?? resolveDbPath(), {
      readonly: true,
    }).db;
  } catch {
    emitEnvelope(
      errorEnvelope(SHOW_JOB_SCHEMA_VERSION, {
        code: "read_failed",
        message: "could not open the keeper database for reading",
        recovery: RECOVERY_DB_READ,
      }),
      sink,
    );
    return;
  }

  let envelope: Envelope<unknown>;
  try {
    let result: ResolveResult;
    let method: string;

    if (hasExplicitPrimary) {
      const hasFilter =
        baseSelectors.jobId !== undefined ||
        baseSelectors.jobIds !== undefined ||
        baseSelectors.paneIds !== undefined ||
        baseSelectors.cwdExact !== undefined ||
        baseSelectors.cwdRoot !== undefined;
      if (!hasFilter) {
        die("no effective filter (cwd is not inside a git repository)");
      }
      method = sessionMode
        ? "session-reference"
        : explicitMethod(baseSelectors);
      result = resolveJob(db, baseSelectors);
    } else {
      const auto = autoDetect(db, env, args.latest);
      result = auto.result;
      method = auto.method;
    }

    envelope = buildEnvelope(result, method, args.raw, {
      sessionReference: sessionMode,
      sessionMatch,
    });
  } catch {
    envelope = errorEnvelope(SHOW_JOB_SCHEMA_VERSION, {
      code: "read_failed",
      message: "could not read from the keeper database",
      recovery: RECOVERY_DB_READ,
    });
  } finally {
    db.close();
  }

  emitEnvelope(envelope, sink);
}

/** Label the resolution method for an explicit-selector run. */
function explicitMethod(sel: Selectors): string {
  if (sel.jobId !== undefined) return "job-id";
  if (sel.paneIds !== undefined) return "pane";
  if (sel.cwdExact !== undefined) return "cwd-exact";
  return "cwd";
}

/**
 * Run the zero-flag precedence ladder. Returns the first rung that matches ≥1
 * (reporting its ambiguity verdict); a rung matching 0 falls through. When no
 * rung produces any candidate at all, `not_found` with the last attempted
 * method. A rung that cannot be ATTEMPTED (no session id, not in tmux, non-repo
 * cwd) is SKIPPED entirely.
 */
function autoDetect(
  db: Database,
  env: Record<string, string | undefined>,
  latest: boolean,
): { result: ResolveResult; method: string } {
  let attempted = false;

  // Rung 1: ambient $CLAUDE_CODE_SESSION_ID → own job_id.
  const sid = resolveSessionId(null, env);
  if (sid !== null) {
    attempted = true;
    const r = resolveJob(db, { jobId: sid, latest });
    if (r.kind !== "not_found") return { result: r, method: "ambient-session" };
  }

  // Rung 2: tmux current-WINDOW scope → single live agent.
  const paneIds = tmuxWindowPaneIds(env);
  if (paneIds !== null && paneIds.length > 0) {
    attempted = true;
    const r = resolveJob(db, { paneIds, latest });
    if (r.kind !== "not_found") return { result: r, method: "tmux-window" };
  }

  // Rung 3: cwd → git-toplevel containment.
  const root = resolveGitRoot(process.cwd());
  if (root !== null) {
    attempted = true;
    const r = resolveJob(db, { cwdRoot: safeRealpath(root), latest });
    if (r.kind !== "not_found") return { result: r, method: "cwd" };
  }

  if (!attempted) {
    // No signal could even be attempted — exit 2 (no effective filter).
    die(
      "no effective filter (not in a Claude session or tmux window, and cwd is not a git repository)",
    );
  }
  return { result: { kind: "not_found" }, method: "auto" };
}

/** Build the one-shot envelope for a resolved result. A hit is `data`
 *  (ok:true); `not_found` / `ambiguous` are `ok:false` with a stable error code
 *  and actionable recovery — the ambiguous case carries its candidate list on
 *  `error.details.candidates`. Exported for the mapping unit test. */
export function buildEnvelope(
  result: ResolveResult,
  method: string,
  raw: boolean,
  options: {
    sessionReference?: boolean;
    sessionMatch?: string;
  } = {},
): Envelope<unknown> {
  if (result.kind === "ok") {
    const job = decodeFor(result.row, raw);
    const resolution: Record<string, unknown> = { method };
    if (result.matchedField !== undefined) {
      resolution.matched_field = result.matchedField;
    }
    if (options.sessionMatch !== undefined) {
      resolution.session_match = options.sessionMatch;
    }
    return successEnvelope(SHOW_JOB_SCHEMA_VERSION, { job, resolution });
  }
  if (result.kind === "not_found") {
    return errorEnvelope(SHOW_JOB_SCHEMA_VERSION, {
      code: "not_found",
      message: "no job matched the given selectors",
      recovery:
        "Widen or correct the selector (--job-id / --session-title / --cwd / " +
        "--pane), or run with no selector to auto-detect; this read never " +
        "mutates state.",
    });
  }
  // ambiguous
  const candidates = result.candidates.slice(0, SHOW_JOB_CANDIDATES_MAX);
  const sessionReference = options.sessionReference === true;
  return errorEnvelope(SHOW_JOB_SCHEMA_VERSION, {
    code: sessionReference ? "job_ambiguous" : "ambiguous",
    message: `the selectors matched ${result.candidates.length} jobs; narrow to one`,
    recovery: sessionReference
      ? "Add --job-id with one exact candidate; Session references never choose the newest associated job."
      : "Add a narrowing selector (--job-id pins exactly one) or pass --latest for this job-only query.",
    details: {
      candidate_count: result.candidates.length,
      candidates_truncated: candidates.length < result.candidates.length,
      candidates: candidates.map(candidateView),
    },
  });
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
