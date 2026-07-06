#!/usr/bin/env bun
/**
 * `keeper show-job` — fetch ONE job's full metadata row from the `jobs`
 * projection as a pretty JSON envelope (epic fn-840). Read-only over keeper.db
 * so consumers stop hand-writing sqlite against a schema keeper owns.
 *
 * The verb resolves a job by the cheapest available signal: explicit
 * `--job-id` / `--session-title` (the Claude session TITLE) / `--cwd` / `--pane`,
 * or zero-flag auto-detection that (a) shows your own job when run inside a
 * Claude session (`$CLAUDE_CODE_SESSION_ID`), (b) shows the single live agent
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

/** Envelope schema version for `keeper show-job` (versions the `data` payload). */
export const SHOW_JOB_SCHEMA_VERSION = 1;

const HELP = `keeper show-job [selectors] [options]

Fetch a single job's full metadata from the jobs projection as a pretty JSON
envelope. Read-only over keeper.db — no commit, no lock.

With no selector, auto-detects: your own job inside a Claude session
($CLAUDE_CODE_SESSION_ID), else the single live agent in your current tmux
window (split a shell pane beside it), else the job whose cwd contains yours.

Selectors (explicit flags AND together — they narrow):
  --job-id <id>        Match job_id exactly
  --session-title <t>  Match the Claude session title (case-insensitive),
                       current title OR any name_history entry
  --cwd <dir>          Match jobs under <dir>'s git toplevel (default: cwd)
  --cwd-exact          Strict cwd equality instead of toplevel containment
  --pane <%N>          Match backend_exec_pane_id exactly (bare N → %N)

Options:
  --latest             Collapse an ambiguous (>1) match to the top of the
                       deterministic sort (never fabricates from not_found)
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
  /** Exact `job_id` match (== session id). */
  jobId?: string;
  /** Claude session TITLE — current title OR any name_history entry, NOCASE. */
  title?: string;
  /** Git-toplevel containment root (realpath'd) for prefix matching. */
  cwdRoot?: string;
  /** Strict cwd equality target (raw, un-realpath'd to match stored cwd). */
  cwdExact?: string;
  /** `backend_exec_pane_id IN (...)` set — explicit `--pane` or window scope. */
  paneIds?: string[];
  /** Collapse a >1 ambiguity to the deterministic-sort top. */
  latest?: boolean;
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
 *   >1 with exactly 1 live → return the live one
 *   >1 with 0 or ≥2 live → ambiguous (unless --latest collapses to sort top)
 * `--latest` is strictly a >1 tiebreaker — it NEVER turns not_found into a hit.
 */
function applyAmbiguity(
  rows: JobRow[],
  matchedField: string | undefined,
  latest: boolean,
): ResolveResult {
  if (rows.length === 0) return { kind: "not_found" };
  if (rows.length === 1) return { kind: "ok", row: rows[0], matchedField };
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
 * Explicit selectors AND together: they NARROW. A `--job-id` paired with
 * any other selector is a consistency check — a row failing it yields
 * `not_found`, never a blind-trust of the id.
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

  if (sel.title !== undefined) {
    // Current title OR an exact (NOCASE) entry in the name_history JSON array.
    // `json_each` over the default '[]' (or any well-formed array) is safe; a
    // malformed blob is guarded at the producer (default '[]') — but COALESCE
    // to '[]' here too so a NULL never breaks the join.
    where.push(`(title = ? COLLATE NOCASE OR EXISTS (
      SELECT 1 FROM json_each(COALESCE(name_history, '[]')) je
       WHERE je.value = ? COLLATE NOCASE))`);
    params.push(sel.title, sel.title);
    fields.push("title");
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

  // DISTINCT so a row matching on both title and a name_history entry (the
  // EXISTS sub-select can't double it, but a future OR-join could) counts once.
  const sql = `SELECT DISTINCT * FROM jobs WHERE ${where.join(
    " AND ",
  )} ORDER BY ${ORDER_BY}`;
  const rows = db.query(sql).all(...(params as never[])) as JobRow[];

  const matchedField = fields.length === 1 ? fields[0] : undefined;
  return applyAmbiguity(rows, matchedField, sel.latest ?? false);
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

/** The compact candidate-list shape for the ambiguous envelope. */
function candidateView(row: JobRow): JobRow {
  return {
    job_id: row.job_id,
    title: row.title,
    state: row.state,
    cwd: row.cwd,
    backend_exec_pane_id: row.backend_exec_pane_id,
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
  title: string | null;
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
    title: null,
    cwd: null,
    cwdExact: false,
    pane: null,
    latest: false,
    raw: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      p.help = true;
    } else if (a === "--job-id" || a.startsWith("--job-id=")) {
      const r = takeValue(argv, i, "--job-id");
      p.jobId = r.value;
      i = r.next;
    } else if (a === "--session-title" || a.startsWith("--session-title=")) {
      const r = takeValue(argv, i, "--session-title");
      p.title = r.value;
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
): void {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const env = process.env as Record<string, string | undefined>;

  // An explicit PRIMARY selector pins the job; auto-detection runs only when
  // none is given. `--cwd <dir>` / `--cwd-exact` are explicit; bare cwd is auto.
  const hasExplicitPrimary =
    args.jobId !== null ||
    args.title !== null ||
    args.pane !== null ||
    args.cwd !== null ||
    args.cwdExact;

  // Build the explicit narrowing selectors that always apply.
  const baseSelectors: Selectors = { latest: args.latest };
  if (args.jobId !== null) baseSelectors.jobId = args.jobId;
  if (args.title !== null) baseSelectors.title = args.title;
  if (args.pane !== null) baseSelectors.paneIds = [normalizePane(args.pane)];

  if (args.cwd !== null || args.cwdExact) {
    const dir = args.cwd ?? process.cwd();
    if (args.cwdExact) {
      baseSelectors.cwdExact = dir;
    } else {
      const root = resolveGitRoot(dir);
      // A non-repo cwd / missing git degrades — skip the cwd signal (never
      // throw). If it was the ONLY selector, the no-effective-filter guard below
      // catches it as exit 2.
      if (root !== null) baseSelectors.cwdRoot = safeRealpath(root);
    }
  }

  // Open read-only; busy_timeout is set by applyPragmas, no immutable=1.
  let db: Database;
  try {
    db = openDb(resolveDbPath(), { readonly: true }).db;
  } catch {
    // A broken DB ≠ no job — a read failure, distinct from not_found. Emit a
    // clean corrective message (no path / stack leak in an agent-facing error).
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
        baseSelectors.title !== undefined ||
        baseSelectors.paneIds !== undefined ||
        baseSelectors.cwdExact !== undefined ||
        baseSelectors.cwdRoot !== undefined;
      if (!hasFilter) {
        // e.g. `--cwd <non-repo>` with no other selector: no effective filter.
        die("no effective filter (cwd is not inside a git repository)");
      }
      method = explicitMethod(baseSelectors);
      result = resolveJob(db, baseSelectors);
    } else {
      // Auto-detection LADDER. Each rung's matches run through the ambiguity
      // rule; a rung matching ≥1 but ambiguous REPORTS ambiguity; a rung
      // matching 0 falls through to the next.
      const auto = autoDetect(db, env, args.latest);
      result = auto.result;
      method = auto.method;
    }

    envelope = buildEnvelope(result, method, args.raw);
  } catch {
    // A query throw mid-resolution is a read failure, not not_found.
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
  if (sel.title !== undefined) return "session-title";
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
): Envelope<unknown> {
  if (result.kind === "ok") {
    const job = decodeFor(result.row, raw);
    const resolution: Record<string, unknown> = { method };
    if (result.matchedField !== undefined) {
      resolution.matched_field = result.matchedField;
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
  return errorEnvelope(SHOW_JOB_SCHEMA_VERSION, {
    code: "ambiguous",
    message: `the selectors matched ${result.candidates.length} jobs; narrow to one`,
    recovery:
      "Add a narrowing selector (--job-id pins exactly one) or pass " +
      "--latest to take the most recent; the matches are on " +
      "error.details.candidates.",
    details: { candidates: result.candidates.map(candidateView) },
  });
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
