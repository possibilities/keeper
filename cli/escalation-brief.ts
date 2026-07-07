#!/usr/bin/env bun
/**
 * `keeper escalation-brief <unblock::fn-N-slug.M | deconflict::fn-N-slug>` — the
 * read-only context envelope an autopilot escalation session loads at boot, so it
 * resolves the incident without the original creator's session context.
 *
 * The payload spans BOTH stores, which is why the verb lives in keeper core:
 *   - keeper.db (`jobs.transcript_path` / `plan_verb` / `plan_ref`,
 *     `epics.job_links` creator edges, the `dispatch_failures` reason row,
 *     the `resolve::<epic>` resolver jobs);
 *   - the repo's `.keeper` tree (`epics/<id>.json.created_by_close_of` +
 *     `primary_repo`, and the gitignored `state/tasks/<id>.state.json` blocked
 *     overlay). The `.keeper` schema is OWNED by the plan plugin — this verb reads
 *     only the handful of fields it needs, defensively, and never imports the plan
 *     plugin.
 *
 * Output is ONE flat JSON root on stdout — `{schema_version, ok, kind, epic_id,
 * task_id, primary_repo, incident, lineage, degraded}` — deliberately NOT the
 * `{…, data}`-nested one-shot envelope (`cli/envelope.ts`): the consuming skill
 * reads `jq .lineage` / `jq .incident` directly, so the payload spreads at the
 * root the way the plan `emit()` family does. `degraded` is the explicit,
 * machine-matchable list of every field that could not be resolved.
 *
 * Exit model: a FOUND incident whose lineage or transcript is partial still emits
 * `ok:true` at exit 0 with `degraded` flags — a session must always get a brief.
 * Only an unparseable key or an unknown incident (no epic anywhere) is `ok:false`
 * exit 1; a keeper.db open failure is the sole transport `ok:false` exit 1. The
 * verb is strictly READ-ONLY (readonly DB handle, no `.keeper` writes).
 */

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { roleJobIds } from "../src/bus-identity";
import { openDb, resolveDbPath } from "../src/db";
import { parsePlanRef } from "../src/derivers";
import { isMergeEscalationReason } from "../src/dispatch-failure-key";

/** Envelope schema version for `keeper escalation-brief`. */
export const ESCALATION_BRIEF_SCHEMA_VERSION = 1;

/** Cap on the `created_by_close_of` lineage walk — a closer chain deeper than
 *  this is truncated (flagged) rather than followed unbounded. */
export const MAX_LINEAGE_HOPS = 5;

/** The typed escalation categories a worker stamps on a `BLOCKED:` return; the
 *  unblock incident lifts the category out of the blocked reason for the session. */
const ESCALATION_CATEGORY_RE =
  /\b(SPEC_UNCLEAR|DEPENDENCY_BLOCKED|DESIGN_CONFLICT|SCOPE_EXCEEDED|TOOLING_FAILURE|EXTERNAL_BLOCKED|RESUME_EXHAUSTED|SHARED_BASE_BROKEN)\b/;

const HELP = `keeper escalation-brief <key> [options]

Print the read-only context envelope an autopilot escalation session loads at
boot, as ONE flat JSON root on stdout: {schema_version, ok, kind, epic_id,
task_id, primary_repo, incident, lineage, degraded}. Read-only over keeper.db +
the .keeper tree — no daemon, no commit, no lock, no writes.

Keys:
  unblock::<task-id>     A blocked plan task (e.g. unblock::fn-12-add-oauth.3)
  deconflict::<epic-id>  A sticky worktree-merge-conflict close (e.g. deconflict::fn-12-add-oauth)

The incident block is kind-specific (unblock: blocked reason + CATEGORY + other
blocked siblings; deconflict: the merge-conflict reason with source/target branch
and stderr + the resolver jobs). lineage carries the direct creator and — when
the creator is a closer — the original creator resolved by walking
created_by_close_of, each with session_id + transcript_path. A partial lineage
degrades to explicit 'degraded' flags at exit 0; only an unparseable key or an
unknown incident exits non-zero.

Options:
  --help, -h             Show this help
`;

// ── Envelope payload types ─────────────────────────────────────────────────

/** A resolved creator edge — a session_id from `epics.job_links` enriched with
 *  its `jobs` row. `is_closer` is true iff the session's `plan_verb` is `close`
 *  (it created this epic by closing another). `job_row_present` is false when the
 *  edge names a session with no `jobs` row (dead / never-recorded). */
export interface CreatorRef {
  session_id: string;
  transcript_path: string | null;
  is_closer: boolean;
  plan_verb: string | null;
  plan_ref: string | null;
  state: string | null;
  job_row_present: boolean;
}

/** One hop of the lineage walk: the epic and its resolved creator (null when the
 *  epic carries no creator edge at all). */
export interface LineageLink {
  epic_id: string;
  creator: CreatorRef | null;
}

/** The lineage block: the direct creator, the walked-back original creator (equal
 *  to the direct creator when it is not a closer), and the full chain. */
export interface Lineage {
  creator: CreatorRef | null;
  original_creator: CreatorRef | null;
  chain: LineageLink[];
}

/** The deconflict incident: the parsed merge-conflict + the resolver jobs. */
export interface DeconflictIncident {
  conflict: {
    reason: string;
    source_branch: string | null;
    base_branch: string | null;
    stderr: string | null;
    repo_dir: string | null;
    merge_escalated_at: number | null;
    resolver_dispatched_at: number | null;
  } | null;
  resolver_jobs: Array<{
    session_id: string;
    state: string | null;
    transcript_path: string | null;
  }>;
}

/** The unblock incident: the blocked task's reason + category + other blocked
 *  siblings in the same epic. */
export interface UnblockIncident {
  task_id: string;
  status: string | null;
  blocked_reason: string | null;
  category: string | null;
  blocked_siblings: string[];
}

/** The assembled brief (minus `schema_version`/`ok`, added by the emitter). */
export interface EscalationBrief {
  kind: "unblock" | "deconflict";
  epic_id: string;
  task_id: string | null;
  primary_repo: string | null;
  incident: DeconflictIncident | UnblockIncident;
  lineage: Lineage;
  degraded: string[];
}

export type EscalationBriefResult =
  | { kind: "ok"; brief: EscalationBrief }
  | {
      kind: "error";
      code: "unparseable_key" | "unknown_incident";
      message: string;
      recovery: string;
    };

// ── Key parsing ────────────────────────────────────────────────────────────

type ParsedKey =
  | { kind: "deconflict"; epic_id: string }
  | { kind: "unblock"; epic_id: string; task_id: string };

/** Parse an escalation key into its kind + ids. `deconflict::` requires an
 *  epic-form ref, `unblock::` a task-form ref (a shape mismatch is unparseable).
 *  Returns null for anything not a valid key. */
export function parseEscalationKey(key: string): ParsedKey | null {
  const m = /^(unblock|deconflict)::(.+)$/.exec(key);
  if (m == null) {
    return null;
  }
  const ref = parsePlanRef(m[2]);
  if (ref == null) {
    return null;
  }
  if (m[1] === "deconflict") {
    return ref.kind === "epic"
      ? { kind: "deconflict", epic_id: ref.epic_id }
      : null;
  }
  return ref.kind === "task"
    ? { kind: "unblock", epic_id: ref.epic_id, task_id: ref.task_id }
    : null;
}

// ── Defensive `.keeper` + keeper.db reads ──────────────────────────────────

/** Parse a JSON object off disk; a missing file, a parse failure, or a non-object
 *  payload all yield null (never throws) — the read-boundary convention. */
function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed != null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read `<keeperRoot>/.keeper/epics/<epicId>.json` defensively. */
function readEpicJson(
  keeperRoot: string,
  epicId: string,
): Record<string, unknown> | null {
  return readJsonSafe(join(keeperRoot, ".keeper", "epics", `${epicId}.json`));
}

/** The source epic named by an epic's `created_by_close_of` field (the follow-up
 *  edge), or null when absent / not a close-born epic / unreadable. */
function createdByCloseOf(keeperRoot: string, epicId: string): string | null {
  const epic = readEpicJson(keeperRoot, epicId);
  const v = epic?.created_by_close_of;
  return typeof v === "string" && v.length > 0 ? v : null;
}

interface JobRow {
  job_id: string;
  transcript_path: string | null;
  plan_verb: string | null;
  plan_ref: string | null;
  state: string | null;
  updated_at: number;
}

function loadJobRow(db: Database, jobId: string): JobRow | null {
  return db
    .query(
      "SELECT job_id, transcript_path, plan_verb, plan_ref, state, updated_at FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as JobRow | null;
}

// ── Lineage resolution ─────────────────────────────────────────────────────

interface CreatorResolution {
  creator: CreatorRef | null;
  jobRowMissing: boolean;
  transcriptMissing: boolean;
}

/** Resolve the creator session for one epic from its `epics.job_links` creator
 *  edges. Picks the newest resolvable `jobs` row (mirrors `pickCreatorJob`);
 *  degrades to the bare edge id when the edge names a session with no `jobs` row. */
function resolveCreatorForEpic(
  db: Database,
  epicId: string,
): CreatorResolution {
  const ids = roleJobIds(db, "creator", epicId);
  if (ids.length === 0) {
    return { creator: null, jobRowMissing: false, transcriptMissing: false };
  }
  const rows = ids
    .map((id) => loadJobRow(db, id))
    .filter((r): r is JobRow => r != null);
  if (rows.length === 0) {
    // Edges exist but no `jobs` row (dead / never-recorded session): still report
    // the session id so the brief carries a pointer, flagged degraded.
    const sessionId = [...ids].sort()[0];
    return {
      creator: {
        session_id: sessionId,
        transcript_path: null,
        is_closer: false,
        plan_verb: null,
        plan_ref: null,
        state: null,
        job_row_present: false,
      },
      jobRowMissing: true,
      transcriptMissing: true,
    };
  }
  rows.sort(
    (a, b) => b.updated_at - a.updated_at || a.job_id.localeCompare(b.job_id),
  );
  const row = rows[0];
  return {
    creator: {
      session_id: row.job_id,
      transcript_path: row.transcript_path,
      is_closer: row.plan_verb === "close",
      plan_verb: row.plan_verb,
      plan_ref: row.plan_ref,
      state: row.state,
      job_row_present: true,
    },
    jobRowMissing: false,
    transcriptMissing: row.transcript_path == null,
  };
}

interface LineageResult extends Lineage {
  degraded: string[];
}

/** Walk the creator lineage from the incident epic back to the original creator.
 *  Each hop resolves the epic's creator; when that creator is a closer (or the
 *  epic records a `created_by_close_of` source), the walk continues to the source
 *  epic. Bounded by {@link MAX_LINEAGE_HOPS} and cycle-guarded. */
function resolveLineage(
  db: Database,
  keeperRoot: string,
  incidentEpicId: string,
): LineageResult {
  const chain: LineageLink[] = [];
  const degraded: string[] = [];
  const visited = new Set<string>();
  let currentEpic = incidentEpicId;
  let truncated = true;

  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop++) {
    if (visited.has(currentEpic)) {
      degraded.push(`lineage_cycle:${currentEpic}`);
      truncated = false;
      break;
    }
    visited.add(currentEpic);

    const res = resolveCreatorForEpic(db, currentEpic);
    if (res.creator == null) {
      degraded.push(`lineage_creator_missing:${currentEpic}`);
      chain.push({ epic_id: currentEpic, creator: null });
      truncated = false;
      break;
    }
    if (res.jobRowMissing) {
      degraded.push(
        `lineage_creator_job_row_missing:${res.creator.session_id}`,
      );
    } else if (res.transcriptMissing) {
      degraded.push(`lineage_transcript_missing:${res.creator.session_id}`);
    }
    chain.push({ epic_id: currentEpic, creator: res.creator });

    // Walk to the source epic when this epic was born from a close. The
    // authoritative signal is the epic's `created_by_close_of` field; the closer
    // job's `plan_ref` is the equivalent fallback.
    const source =
      createdByCloseOf(keeperRoot, currentEpic) ??
      (res.creator.is_closer ? res.creator.plan_ref : null);
    if (source == null) {
      truncated = false;
      break;
    }
    currentEpic = source;
  }
  if (truncated) {
    degraded.push("lineage_walk_truncated");
  }

  const creator = chain.length > 0 ? chain[0].creator : null;
  let original: CreatorRef | null = null;
  for (const link of chain) {
    if (link.creator != null) {
      original = link.creator;
    }
  }
  return { creator, original_creator: original, chain, degraded };
}

// ── Incident assembly ──────────────────────────────────────────────────────

interface IncidentResult<D> {
  data: D;
  degraded: string[];
}

/** Split a `worktree-merge-conflict: merging <source> into <base> — <stderr>`
 *  reason into its branches + stderr tail. Splits on the FIRST em-dash so a
 *  stderr containing one can't poison the branch parse. Returns null on a
 *  structural miss. */
function parseMergeConflictReason(
  reason: string,
): { source: string; base: string; stderr: string | null } | null {
  const dash = reason.indexOf(" — ");
  const head = dash >= 0 ? reason.slice(0, dash) : reason;
  const stderr = dash >= 0 ? reason.slice(dash + 3) : null;
  const m = head.match(
    /^\s*worktree-merge-conflict:\s*merging\s+(\S.*?)\s+into\s+(\S.*?)\s*$/,
  );
  if (m == null) {
    return null;
  }
  return { source: m[1], base: m[2], stderr };
}

/** Assemble the deconflict incident: the sticky `close::<epic>`
 *  worktree-merge-conflict `dispatch_failures` row + the `resolve::<epic>`
 *  resolver jobs. */
function buildDeconflictIncident(
  db: Database,
  epicId: string,
): IncidentResult<DeconflictIncident> {
  const degraded: string[] = [];
  const row = db
    .query(
      `SELECT reason, dir, merge_escalated_at, resolver_dispatched_at
         FROM dispatch_failures WHERE verb = 'close' AND id = ?`,
    )
    .get(epicId) as {
    reason: string;
    dir: string | null;
    merge_escalated_at: number | null;
    resolver_dispatched_at: number | null;
  } | null;

  let conflict: DeconflictIncident["conflict"] = null;
  if (row == null || !isMergeEscalationReason(row.reason)) {
    degraded.push("incident_merge_conflict_row_missing");
  } else {
    const parsed = parseMergeConflictReason(row.reason);
    if (parsed == null) {
      degraded.push("incident_reason_unparsed");
    }
    conflict = {
      reason: row.reason,
      source_branch: parsed?.source ?? null,
      base_branch: parsed?.base ?? null,
      stderr: parsed?.stderr ?? null,
      repo_dir: row.dir,
      merge_escalated_at: row.merge_escalated_at,
      resolver_dispatched_at: row.resolver_dispatched_at,
    };
  }

  const resolverRows = db
    .query(
      "SELECT job_id, state, transcript_path FROM jobs WHERE plan_verb = 'resolve' AND plan_ref = ?",
    )
    .all(epicId) as Array<{
    job_id: string;
    state: string | null;
    transcript_path: string | null;
  }>;
  if (resolverRows.length === 0) {
    degraded.push("incident_resolver_job_missing");
  }
  const resolver_jobs = resolverRows.map((r) => ({
    session_id: r.job_id,
    state: r.state,
    transcript_path: r.transcript_path,
  }));

  return { data: { conflict, resolver_jobs }, degraded };
}

/** Every OTHER blocked task in the same epic — scanned from the gitignored
 *  runtime overlay `<keeperRoot>/.keeper/state/tasks/<taskId>.state.json`. A
 *  missing overlay dir yields `[]`. */
function scanBlockedSiblings(
  keeperRoot: string,
  epicId: string,
  excludeTaskId: string,
): string[] {
  const dir = join(keeperRoot, ".keeper", "state", "tasks");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  const suffix = ".state.json";
  for (const name of names) {
    if (!name.endsWith(suffix)) {
      continue;
    }
    const taskId = name.slice(0, -suffix.length);
    if (taskId === excludeTaskId || !taskId.startsWith(`${epicId}.`)) {
      continue;
    }
    const state = readJsonSafe(join(dir, name));
    if (state != null && state.status === "blocked") {
      out.push(taskId);
    }
  }
  return out.sort();
}

/** Assemble the unblock incident: the blocked task's runtime overlay
 *  (`status` / `blocked_reason` / extracted CATEGORY) + the other blocked
 *  siblings in the epic. */
function buildUnblockIncident(
  db: Database,
  keeperRoot: string,
  epicId: string,
  taskId: string,
): IncidentResult<UnblockIncident> {
  // `db` is unused here (the blocked overlay is gitignored fs state, not folded
  // into keeper.db) but kept in the signature to mirror buildDeconflictIncident.
  void db;
  const degraded: string[] = [];
  const state = readJsonSafe(
    join(keeperRoot, ".keeper", "state", "tasks", `${taskId}.state.json`),
  );

  let status: string | null = null;
  let blocked_reason: string | null = null;
  let category: string | null = null;
  if (state == null) {
    degraded.push("incident_blocked_state_missing");
  } else {
    status = typeof state.status === "string" ? state.status : null;
    blocked_reason =
      typeof state.blocked_reason === "string" ? state.blocked_reason : null;
    if (status !== "blocked") {
      degraded.push(`incident_task_not_blocked:${status ?? "unknown"}`);
    }
    if (blocked_reason != null) {
      const m = ESCALATION_CATEGORY_RE.exec(blocked_reason);
      category = m != null ? m[1] : null;
      if (category == null) {
        degraded.push("incident_category_unparsed");
      }
    }
  }

  return {
    data: {
      task_id: taskId,
      status,
      blocked_reason,
      category,
      blocked_siblings: scanBlockedSiblings(keeperRoot, epicId, taskId),
    },
    degraded,
  };
}

// ── Orchestration ──────────────────────────────────────────────────────────

/** Assemble the escalation brief for `key`. PURE over `(db, cwd)` — no clock, no
 *  process env — so a fixture drives every path. `cwd` is the fallback `.keeper`
 *  root when the epic has no `project_dir` in keeper.db. */
export function buildEscalationBrief(
  db: Database,
  key: string,
  cwd: string,
): EscalationBriefResult {
  const parsed = parseEscalationKey(key);
  if (parsed == null) {
    return {
      kind: "error",
      code: "unparseable_key",
      message: `not a valid escalation key: '${key}'`,
      recovery:
        "Pass an 'unblock::<task-id>' or 'deconflict::<epic-id>' key " +
        "(e.g. deconflict::fn-12-add-oauth or unblock::fn-12-add-oauth.3).",
    };
  }

  const epicId = parsed.epic_id;
  const epicRow = db
    .query("SELECT project_dir FROM epics WHERE epic_id = ?")
    .get(epicId) as { project_dir: string | null } | null;
  const keeperRoot =
    epicRow?.project_dir != null && epicRow.project_dir.length > 0
      ? epicRow.project_dir
      : cwd;
  const epicJson = readEpicJson(keeperRoot, epicId);

  // Unknown incident: the epic exists NOWHERE (no keeper.db row, no .keeper file).
  // A found epic with partial data degrades at exit 0 instead.
  if (epicRow == null && epicJson == null) {
    return {
      kind: "error",
      code: "unknown_incident",
      message: `no epic '${epicId}' in keeper.db or the .keeper tree`,
      recovery:
        "Confirm the escalation key names a real epic (see `keeper status` / " +
        "`keeper query epics`); this read never mutates state.",
    };
  }

  const primaryRepo =
    typeof epicJson?.primary_repo === "string" &&
    epicJson.primary_repo.length > 0
      ? epicJson.primary_repo
      : (epicRow?.project_dir ?? null);

  const lineage = resolveLineage(db, keeperRoot, epicId);
  const incident =
    parsed.kind === "deconflict"
      ? buildDeconflictIncident(db, epicId)
      : buildUnblockIncident(db, keeperRoot, epicId, parsed.task_id);

  const degraded = [...lineage.degraded, ...incident.degraded];
  if (primaryRepo == null) {
    degraded.push("primary_repo_missing");
  }

  return {
    kind: "ok",
    brief: {
      kind: parsed.kind,
      epic_id: epicId,
      task_id: parsed.kind === "unblock" ? parsed.task_id : null,
      primary_repo: primaryRepo,
      incident: incident.data,
      lineage: {
        creator: lineage.creator,
        original_creator: lineage.original_creator,
        chain: lineage.chain,
      },
      degraded,
    },
  };
}

// ── CLI wiring ─────────────────────────────────────────────────────────────

interface Sink {
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  exit: (code: number) => never;
}

/** Emit a successful (possibly degraded) brief as the flat JSON root, exit 0. */
function emitBrief(brief: EscalationBrief, sink: Sink): void {
  sink.writeStdout(
    `${JSON.stringify(
      {
        schema_version: ESCALATION_BRIEF_SCHEMA_VERSION,
        ok: true,
        ...brief,
      },
      null,
      2,
    )}\n`,
  );
  sink.exit(0);
}

/** Emit a typed failure envelope (flat root, `error` sub-object), exit 1. */
function emitError(
  error: { code: string; message: string; recovery: string },
  sink: Sink,
): void {
  sink.writeStdout(
    `${JSON.stringify(
      {
        schema_version: ESCALATION_BRIEF_SCHEMA_VERSION,
        ok: false,
        error,
      },
      null,
      2,
    )}\n`,
  );
  sink.exit(1);
}

export function main(argv: string[]): void {
  const sink: Sink = {
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
  };

  let key: string | null = null;
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      sink.writeStdout(HELP);
      return;
    }
    if (a.startsWith("-")) {
      sink.writeStderr(`keeper escalation-brief: unexpected argument '${a}'\n`);
      sink.exit(2);
    } else if (key === null) {
      key = a;
    } else {
      sink.writeStderr(`keeper escalation-brief: unexpected argument '${a}'\n`);
      sink.exit(2);
    }
  }
  if (key === null) {
    sink.writeStderr("keeper escalation-brief: <key> is required\n\n");
    sink.writeStderr(HELP);
    sink.exit(2);
  }

  let db: Database;
  try {
    db = openDb(resolveDbPath(), { readonly: true }).db;
  } catch (e) {
    emitError(
      {
        code: "read_failed",
        message: e instanceof Error ? e.message : String(e),
        recovery:
          "keeper.db could not be opened read-only. Confirm keeper is installed " +
          "and the DB path ($KEEPER_DB / default) exists; this read never mutates state.",
      },
      sink,
    );
    return;
  }

  try {
    const result = buildEscalationBrief(db, key, process.cwd());
    if (result.kind === "error") {
      emitError(
        {
          code: result.code,
          message: result.message,
          recovery: result.recovery,
        },
        sink,
      );
      return;
    }
    emitBrief(result.brief, sink);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
