/**
 * Keeper SQLite layer: schema bootstrap, connection-local PRAGMAs, prepared
 * statements, and the forward-only migration ladder.
 *
 * Connection-local PRAGMAs MUST be re-applied on every open (the hook spawns a
 * fresh connection per invocation). Migrations are forward-only via a
 * `meta(schema_version)` row plus idempotent steps that converge on the table's
 * actual shape; destructive steps (DROP COLUMN) must be idempotent.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  extractBackgroundTaskId,
  extractBashMutation,
  extractCommit,
  extractPlanInvocation,
  extractSkillName,
  parsePlanRef,
  planVerbRefFromSpawnName,
  slashCommandFromPrompt,
} from "./derivers";
import { epicIsCompleted, projectBasename, resolveEpicDep } from "./epic-deps";
import { defaultKeeperAgentPath } from "./keeper-agent-path";
import {
  type ClassifierInvocation,
  deriveEpicLinks,
  deriveJobLinks,
  normalizePlanOp,
} from "./plan-classifier";
import type { ResolutionDiagnostic } from "./readiness-diagnostics";
import type { Epic, ResolvedEpicDep } from "./types";
import { parseUsageModels, type UsageModels } from "./usage-models";

/**
 * The forward-only schema migration ladder: one ordered entry per historical
 * schema version, applied in array order inside migrate()'s single
 * transaction. Each entry records its version EXPLICITLY (never derived from
 * array position, so a reorder can never silently re-key a step) plus a
 * machine-readable `kind` discriminant; every `apply` body is the historical
 * migration block moved verbatim. Duplicate or non-contiguous versions are
 * structural errors the ladder tests catch.
 */
export type StepKind = "additive" | "rewind" | "backfill" | "drop" | "noop";

export interface MigrationContext {
  db: Database;
  preMigrateStoredVersion: number;
  needsEventsRebuild: boolean;
}

export interface SchemaStep {
  version: number;
  kind: StepKind;
  apply: (ctx: MigrationContext) => void;
}

export const SCHEMA_STEPS: readonly SchemaStep[] = [
  {
    version: 2,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      addColumnIfMissing(db, "jobs", "title", "TEXT");
    },
  },
  {
    version: 3,
    kind: "drop",
    apply: (ctx) => {
      const { db } = ctx;
      dropColumnIfPresent(db, "jobs", "mode");
      dropColumnIfPresent(db, "jobs", "title_history");
    },
  },
  {
    version: 4,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      addColumnIfMissing(db, "events", "spawn_name", "TEXT");
      addColumnIfMissing(db, "jobs", "title_source", "TEXT");
    },
  },
  {
    version: 5,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      addColumnIfMissing(db, "jobs", "transcript_path", "TEXT");
    },
  },
  // v6: bare version bump — no schema-mutating body.
  { version: 6, kind: "noop", apply: () => {} },
  {
    version: 7,
    kind: "drop",
    apply: (ctx) => {
      const { db } = ctx;
      // v6→v7: collapse the standalone `tasks` table into an embedded JSON-array
      // column on `epics`. The backfill + DROP are non-idempotent, so VERSION-
      // GUARDED below; the `tasks` column add is idempotent. The backfill's array
      // ordering MUST equal the reducer's fold sort (ORDER BY task_number,
      // task_id) or a migrated row diverges from a re-folded one.
      addColumnIfMissing(db, "epics", "tasks", "TEXT NOT NULL DEFAULT '[]'");
      const storedVersion = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersion < 7) {
        const tasksTableExists =
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
            )
            .get() != null;
        if (tasksTableExists) {
          db.run(
            `UPDATE epics SET tasks = COALESCE((
             SELECT json_group_array(json_object(
               'task_id', task_id,
               'epic_id', epic_id,
               'task_number', task_number,
               'title', title,
               'target_repo', target_repo,
               'status', status
             ))
               FROM (
                 SELECT * FROM tasks t
                  WHERE t.epic_id = epics.epic_id
                  ORDER BY task_number, task_id
               )
           ), '[]')
           WHERE tasks IS NULL OR tasks = '[]'`,
          );
          db.run("DROP TABLE IF EXISTS tasks");
        }
      }
    },
  },
  {
    version: 8,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      addColumnIfMissing(
        db,
        "epics",
        "depends_on_epics",
        "TEXT NOT NULL DEFAULT '[]'",
      );
    },
  },
  {
    version: 9,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      addColumnIfMissing(db, "events", "start_time", "TEXT");
      addColumnIfMissing(db, "jobs", "start_time", "TEXT");
    },
  },
  {
    version: 10,
    kind: "backfill",
    apply: (ctx) => {
      const { db } = ctx;
      // v9→v10: slash-command / skill-name / spawn-name verb-ref columns +
      // partial indexes + a same-transaction backfill via the SAME pure derivers
      // the hook + reducer use, so migrated rows byte-match steady-state ones.
      addColumnIfMissing(db, "events", "slash_command", "TEXT");
      addColumnIfMissing(db, "events", "skill_name", "TEXT");
      addColumnIfMissing(db, "jobs", "plan_verb", "TEXT");
      addColumnIfMissing(db, "jobs", "plan_ref", "TEXT");

      // Indexes AFTER the ADD COLUMNs they depend on.
      for (const sql of CREATE_V10_INDEXES) {
        db.run(sql);
      }

      // JS-driven backfill (the derivers aren't expressible in SQL without
      // REGEXP); a throw rolls the whole migration back. Version-guarded
      // non-idempotent — runs at most once.
      const storedVersionV10 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV10 < 10) {
        // Backfill writes MUST use uncached `db.run(sql, params)`, NOT
        // `db.prepare(...).run()`: a statement compiled in the same transaction
        // as the ALTER it depends on can pin the pre-ALTER schema metadata
        // (bun:sqlite #1332). Blobs are parsed defensively — a malformed blob
        // would wedge the migration on throw.
        const rows = db
          .prepare(
            `SELECT id, hook_event, tool_name, data
             FROM events
            WHERE hook_event IN ('UserPromptSubmit', 'PreToolUse', 'PostToolUse')`,
          )
          .all() as {
          id: number;
          hook_event: string;
          tool_name: string | null;
          data: string;
        }[];
        for (const row of rows) {
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(row.data) as Record<string, unknown>;
          } catch {
            // malformed blob — skip derivation, columns stay NULL
          }
          let slashCommand: string | null = null;
          let skillName: string | null = null;
          if (parsed != null) {
            if (row.hook_event === "UserPromptSubmit") {
              slashCommand = slashCommandFromPrompt(parsed.prompt);
            }
            skillName = extractSkillName(row.hook_event, row.tool_name, parsed);
          }
          if (slashCommand != null || skillName != null) {
            db.run(
              "UPDATE events SET slash_command = ?, skill_name = ? WHERE id = ?",
              [slashCommand, skillName, row.id],
            );
          }
        }

        // Per job, derive plan_verb/plan_ref from its EARLIEST SessionStart's
        // spawn_name (matches the reducer's first-sight upsert).
        const jobRows = db.prepare("SELECT job_id FROM jobs").all() as {
          job_id: string;
        }[];
        for (const job of jobRows) {
          const ev = db
            .prepare(
              `SELECT spawn_name
               FROM events
              WHERE session_id = ? AND hook_event = 'SessionStart'
              ORDER BY ts ASC, id ASC
              LIMIT 1`,
            )
            .get(job.job_id) as { spawn_name: string | null } | null;
          const { plan_verb, plan_ref } = planVerbRefFromSpawnName(
            ev?.spawn_name ?? null,
          );
          if (plan_verb != null && plan_ref != null) {
            db.run(
              "UPDATE jobs SET plan_verb = ?, plan_ref = ? WHERE job_id = ?",
              [plan_verb, plan_ref, job.job_id],
            );
          }
        }
      }
    },
  },
  {
    version: 11,
    kind: "rewind",
    apply: (ctx) => {
      const { db } = ctx;
      // v10→v11: embed jobs into the `epics` projection via the `syncJobIntoEpic`
      // fan-out.
      addColumnIfMissing(db, "epics", "jobs", "TEXT NOT NULL DEFAULT '[]'");

      // Version-guarded REWIND-AND-REDRAIN: rewind the cursor + clear jobs/epics
      // so the boot drain rebuilds the embedded arrays through the v11 reducer
      // (the single source of truth). Non-idempotent — runs at most once.
      const storedVersionV11 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV11 < 11) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
      }
    },
  },
  // v11→v12: HISTORICAL ONLY. v12 added the `approvals` sidecar table — v13
  // (below) drops it, so a fresh-v13 DB never creates it and a v11/v12 DB
  // gets it dropped via the v12→v13 step. The DROP TABLE IF EXISTS is
  // idempotent, so even a v11 DB skipping directly to v13 converges
  // cleanly.
  { version: 12, kind: "noop", apply: () => {} },
  {
    version: 13,
    kind: "drop",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v12→v13: add `epics.approval` and drop the v12 `approvals` table.
      // VERSION-GUARDED on `preMigrateStoredVersion < 63` (NOT `< 13`): v62→v63
      // drops `approval` again under a `< 63` guard, so an unguarded
      // presence-idempotent re-add would resurrect it forever on a post-v63 DB.
      // The `< 63` bound (not `< 13`) is load-bearing: the v55→v56
      // `default_visible` rewrite references `approval`, so it must be present
      // for any pre-v63 upgrade passing through v56.
      if (preMigrateStoredVersion < 63) {
        addColumnIfMissing(
          db,
          "epics",
          "approval",
          "TEXT NOT NULL DEFAULT 'pending'",
        );
      }

      db.run("DROP TABLE IF EXISTS approvals");
    },
  },
  {
    version: 14,
    kind: "backfill",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v13→v14: planctl_* event columns + `epic_links`/`job_links` projection
      // columns + partial index + a same-transaction backfill via the SAME pure
      // classifier the live reducer fan-out uses. The `planctl_*` adds + their
      // index are spelled as schema history (Decision A) but VERSION-GUARDED: v78
      // renames `planctl_*` → `plan_*`, so an unconditional presence-idempotent
      // re-add would resurrect a zombie `planctl_*` column on every post-v78 boot.
      // The `< 14` guard fires them only while walking up to v14 (fresh DB or a
      // pre-v14 upgrade); the `epic_links`/`job_links` adds are NOT renamed and
      // stay unconditional.
      if (preMigrateStoredVersion < 14) {
        addColumnIfMissing(db, "events", "planctl_op", "TEXT");
        addColumnIfMissing(db, "events", "planctl_target", "TEXT");
        addColumnIfMissing(db, "events", "planctl_epic_id", "TEXT");
        addColumnIfMissing(db, "events", "planctl_task_id", "TEXT");
        addColumnIfMissing(db, "events", "planctl_subject_present", "INTEGER");
        // Index AFTER the ADD COLUMNs it depends on. Guarded with the adds so a
        // post-v78 boot never re-CREATEs the dropped `idx_events_planctl_session`
        // against a renamed-away `planctl_op`.
        for (const sql of CREATE_V14_INDEXES) {
          db.run(sql);
        }
      }
      addColumnIfMissing(
        db,
        "jobs",
        "epic_links",
        "TEXT NOT NULL DEFAULT '[]'",
      );
      addColumnIfMissing(
        db,
        "epics",
        "job_links",
        "TEXT NOT NULL DEFAULT '[]'",
      );

      // JS-driven backfill (uncached `db.run`; a throw rolls back). Version-
      // guarded non-idempotent — the projection re-derive must run at most once.
      const storedVersionV14 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV14 < 14) {
        // Pass 1 — stamp planctl_* on un-backfilled PreToolUse:Bash events. The
        // live deriver now gates on PostToolUse:Bash (v19→v20), so this stamps
        // zero rows on a fresh chain run; kept because removing it would break
        // the version-guarded re-fold contract on already-migrated v14+ DBs.
        const bashRows = db
          .prepare(
            `SELECT id, hook_event, tool_name, data
             FROM events
            WHERE hook_event = 'PreToolUse' AND tool_name = 'Bash'
              AND planctl_op IS NULL`,
          )
          .all() as {
          id: number;
          hook_event: string;
          tool_name: string | null;
          data: string;
        }[];
        for (const row of bashRows) {
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(row.data) as Record<string, unknown>;
          } catch {
            // malformed blob — skip derivation, columns stay NULL.
          }
          if (parsed == null) {
            continue;
          }
          const inv = extractPlanInvocation(
            row.hook_event,
            row.tool_name,
            parsed,
          );
          if (inv == null) {
            continue;
          }
          db.run(
            `UPDATE events SET
             planctl_op = ?,
             planctl_target = ?,
             planctl_epic_id = ?,
             planctl_task_id = ?,
             planctl_subject_present = ?
           WHERE id = ?`,
            [
              inv.op,
              inv.target,
              inv.epic_id,
              inv.task_id,
              inv.subject_present ? 1 : 0,
              row.id,
            ],
          );
        }

        // Pass 2 — per-session projection re-derive, byte-identical to the live
        // `syncPlanLinks` fan-out (both feed the same pure classifier).
        const sessionRows = db
          .prepare(
            `SELECT DISTINCT session_id
             FROM events
            WHERE planctl_op IS NOT NULL`,
          )
          .all() as { session_id: string }[];

        const invocationsBySession = new Map<string, ClassifierInvocation[]>();

        for (const { session_id } of sessionRows) {
          const invRows = db
            .prepare(
              `SELECT id, ts, planctl_op, planctl_target, planctl_epic_id,
                    planctl_task_id, planctl_subject_present
               FROM events
              WHERE session_id = ? AND planctl_op IS NOT NULL
              ORDER BY id ASC`,
            )
            .all(session_id) as {
            id: number;
            ts: number;
            planctl_op: string;
            planctl_target: string | null;
            planctl_epic_id: string | null;
            planctl_task_id: string | null;
            planctl_subject_present: number | null;
          }[];
          const invocations: ClassifierInvocation[] = invRows.map((r) => ({
            ts: r.ts,
            op: normalizePlanOp(r.planctl_op),
            target: r.planctl_target,
            epic_id: r.planctl_epic_id,
            subject_present: r.planctl_subject_present === 1,
            event_id: r.id,
          }));
          invocationsBySession.set(session_id, invocations);
        }

        const touchedEpicIds = new Set<string>();
        for (const session_id of invocationsBySession.keys()) {
          const invocations = invocationsBySession.get(session_id) ?? [];
          const epicLinks = deriveEpicLinks(invocations);
          const epicLinksJson = JSON.stringify(epicLinks);
          const latest = db
            .prepare(
              `SELECT id, ts
               FROM events
              WHERE session_id = ? AND planctl_op IS NOT NULL
              ORDER BY id DESC
              LIMIT 1`,
            )
            .get(session_id) as { id: number; ts: number } | null;
          if (latest == null) {
            continue;
          }
          // UPDATE only — never shell-insert a missing jobs row. The reducer
          // invariant is that jobs rows are created only by SessionStart.
          db.run(
            `UPDATE jobs SET epic_links = ?, last_event_id = ?, updated_at = ?
            WHERE job_id = ?`,
            [epicLinksJson, latest.id, latest.ts, session_id],
          );
          for (const link of epicLinks) {
            touchedEpicIds.add(link.target);
          }
        }

        // Pass 2b — write `epics.job_links` per touched epic; shell-insert the
        // epic row if missing so a from-scratch re-fold reproduces every row.
        for (const epicId of touchedEpicIds) {
          const jobLinks = deriveJobLinks(invocationsBySession, epicId);
          const jobLinksJson = JSON.stringify(jobLinks);
          const latest = db
            .prepare(
              `SELECT MAX(id) AS id, MAX(ts) AS ts
               FROM events
              WHERE planctl_op IS NOT NULL
                AND (planctl_epic_id = ? OR planctl_target = ?)`,
            )
            .get(epicId, epicId) as { id: number | null; ts: number | null };
          const stampId = latest.id ?? 0;
          const stampTs = latest.ts ?? 0;
          const existing = db
            .prepare("SELECT epic_id FROM epics WHERE epic_id = ?")
            .get(epicId) as { epic_id: string } | null;
          if (existing != null) {
            db.run(
              `UPDATE epics SET job_links = ?, last_event_id = ?, updated_at = ?
              WHERE epic_id = ?`,
              [jobLinksJson, stampId, stampTs, epicId],
            );
          } else {
            // Shell-insert (no EpicSnapshot yet): scalars default to their
            // zero-event readings; a later EpicSnapshot fills them and its ON
            // CONFLICT carve-out preserves `job_links`.
            db.run(
              `INSERT INTO epics (
               epic_id, epic_number, title, project_dir, status,
               last_event_id, updated_at, tasks, jobs, job_links
             ) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', ?)`,
              [epicId, stampId, stampTs, jobLinksJson],
            );
          }
        }

        db.run("ANALYZE events");
      }
    },
  },
  // v14→v15: comment-only no-op — `git_status` is created above, no ALTER
  // here, but the version stamp needs a slot per the CLAUDE.md "bump only
  // when adding an ALTER block" invariant.
  { version: 15, kind: "noop", apply: () => {} },
  {
    version: 16,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v15→v16: project `last_validated_at`; the plan-worker's boot re-scan
      // repopulates it.
      addColumnIfMissing(db, "epics", "last_validated_at", "TEXT");
    },
  },
  {
    version: 17,
    kind: "rewind",
    apply: (ctx) => {
      const { db } = ctx;
      // v16→v17: add `events.tool_use_id` + the `subagent_invocations` table +
      // its partial index + a same-transaction backfill.
      addColumnIfMissing(db, "events", "tool_use_id", "TEXT");

      for (const sql of CREATE_V17_INDEXES) {
        db.run(sql);
      }

      // Backfill `events.tool_use_id` via a pure-SQL `json_extract` (uncached
      // `db.run`; a throw rolls back). Version-guarded — the rewind below is
      // non-idempotent.
      const storedVersionV17 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV17 < 17) {
        // `json_valid(data)` gates the extract — a bare `json_extract` raises
        // SQLITE_ERROR on a malformed historical blob and would wedge the
        // migration. The `tool_use_id IS NULL` filter keeps the UPDATE idempotent.
        db.run(
          `UPDATE events
            SET tool_use_id = json_extract(data, '$.tool_use_id')
          WHERE tool_use_id IS NULL
            AND json_valid(data) = 1
            AND json_extract(data, '$.tool_use_id') IS NOT NULL`,
        );

        db.run("ANALYZE events");

        // Rewind-and-redrain: the boot drain rebuilds the projections (incl. the
        // new `subagent_invocations`) from the event log. Non-idempotent.
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  {
    version: 18,
    kind: "rewind",
    apply: (ctx) => {
      const { db } = ctx;
      // v17→v18: add `jobs.rate_limited_at`. The field also rides every embedded
      // `jobs` array entry, so a rewind-and-redrain is REQUIRED: without it,
      // incremental `syncJobIntoEpic` writes would re-serialize touched entries
      // WITH the field while neighbours in the same array stayed WITHOUT it,
      // breaking byte-identical re-fold.
      addColumnIfMissing(db, "jobs", "rate_limited_at", "REAL");

      // Version-guarded rewind-and-redrain — runs at most once.
      const storedVersionV18 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV18 < 18) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  {
    version: 19,
    kind: "rewind",
    apply: (ctx) => {
      const { db } = ctx;
      // v18→v19: rename the embedded `status` key to `worker_phase` + add the
      // `runtime_status` sibling. No schema column — the fields ride the embedded
      // JSON, so a rewind-and-redrain re-emits every element from the v19 reducer
      // (the reducer reads `worker_phase ?? status` so a pre-v19 blob still folds
      // deterministically). Version-guarded.
      const storedVersionV19 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV19 < 19) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  {
    version: 20,
    kind: "backfill",
    apply: (ctx) => {
      const { db } = ctx;
      // v19→v20: re-stamp the planctl_* columns from the authoritative
      // PostToolUse:Bash envelope, superseding the structurally-wrong v13→v14
      // PreToolUse:Bash stamps (that v14 block now no-ops). Pass 0 wipes the
      // wrong stamps, Pass 1 re-stamps, Pass 2 re-derives the projections.
      // Version-guarded; uncached `db.run`.
      const storedVersionV20 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV20 < 20) {
        // Pass 0 — wipe the structurally-wrong PreToolUse:Bash stamps; the
        // reducer's `planctl_op != NULL` gate would otherwise fan out from
        // wrong-shaped data. Idempotent (IS NOT NULL no-ops after the first run).
        db.run(
          `UPDATE events
            SET planctl_op = NULL,
                planctl_target = NULL,
                planctl_epic_id = NULL,
                planctl_task_id = NULL,
                planctl_subject_present = NULL
          WHERE hook_event = 'PreToolUse'
            AND tool_name = 'Bash'
            AND planctl_op IS NOT NULL`,
        );

        // Pass 1 — re-stamp from PostToolUse:Bash rows via the new deriver
        // (`planctl_op IS NULL` filter keeps it resume-safe).
        const bashPostRows = db
          .prepare(
            `SELECT id, hook_event, tool_name, data
             FROM events
            WHERE hook_event = 'PostToolUse' AND tool_name = 'Bash'
              AND planctl_op IS NULL`,
          )
          .all() as {
          id: number;
          hook_event: string;
          tool_name: string | null;
          data: string;
        }[];
        for (const row of bashPostRows) {
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(row.data) as Record<string, unknown>;
          } catch {
            // malformed blob — skip derivation, columns stay NULL.
          }
          if (parsed == null) {
            continue;
          }
          const inv = extractPlanInvocation(
            row.hook_event,
            row.tool_name,
            parsed,
          );
          if (inv == null) {
            continue;
          }
          db.run(
            `UPDATE events SET
             planctl_op = ?,
             planctl_target = ?,
             planctl_epic_id = ?,
             planctl_task_id = ?,
             planctl_subject_present = ?
           WHERE id = ?`,
            [
              inv.op,
              inv.target,
              inv.epic_id,
              inv.task_id,
              inv.subject_present ? 1 : 0,
              row.id,
            ],
          );
        }

        // Pass 2 — per-session projection re-derive, byte-identical to the live
        // `syncPlanLinks` fan-out (same pure classifier).
        const sessionRowsV20 = db
          .prepare(
            `SELECT DISTINCT session_id
             FROM events
            WHERE planctl_op IS NOT NULL`,
          )
          .all() as { session_id: string }[];

        const invocationsBySessionV20 = new Map<
          string,
          ClassifierInvocation[]
        >();

        for (const { session_id } of sessionRowsV20) {
          const invRows = db
            .prepare(
              `SELECT id, ts, planctl_op, planctl_target, planctl_epic_id,
                    planctl_task_id, planctl_subject_present
               FROM events
              WHERE session_id = ? AND planctl_op IS NOT NULL
              ORDER BY id ASC`,
            )
            .all(session_id) as {
            id: number;
            ts: number;
            planctl_op: string;
            planctl_target: string | null;
            planctl_epic_id: string | null;
            planctl_task_id: string | null;
            planctl_subject_present: number | null;
          }[];
          const invocations: ClassifierInvocation[] = invRows.map((r) => ({
            ts: r.ts,
            op: normalizePlanOp(r.planctl_op),
            target: r.planctl_target,
            epic_id: r.planctl_epic_id,
            subject_present: r.planctl_subject_present === 1,
            event_id: r.id,
          }));
          invocationsBySessionV20.set(session_id, invocations);
        }

        const touchedEpicIdsV20 = new Set<string>();
        for (const session_id of invocationsBySessionV20.keys()) {
          const invocations = invocationsBySessionV20.get(session_id) ?? [];
          const epicLinks = deriveEpicLinks(invocations);
          const epicLinksJson = JSON.stringify(epicLinks);
          const latest = db
            .prepare(
              `SELECT id, ts
               FROM events
              WHERE session_id = ? AND planctl_op IS NOT NULL
              ORDER BY id DESC
              LIMIT 1`,
            )
            .get(session_id) as { id: number; ts: number } | null;
          if (latest == null) {
            continue;
          }
          // UPDATE only — jobs rows are created only by SessionStart.
          db.run(
            `UPDATE jobs SET epic_links = ?, last_event_id = ?, updated_at = ?
            WHERE job_id = ?`,
            [epicLinksJson, latest.id, latest.ts, session_id],
          );
          for (const link of epicLinks) {
            touchedEpicIdsV20.add(link.target);
          }
        }

        // Pass 2b — write `epics.job_links` per touched epic; shell-insert a
        // missing epic row (its later EpicSnapshot's ON CONFLICT carve-out
        // preserves `job_links`).
        for (const epicId of touchedEpicIdsV20) {
          const jobLinks = deriveJobLinks(invocationsBySessionV20, epicId);
          const jobLinksJson = JSON.stringify(jobLinks);
          const latest = db
            .prepare(
              `SELECT MAX(id) AS id, MAX(ts) AS ts
               FROM events
              WHERE planctl_op IS NOT NULL
                AND (planctl_epic_id = ? OR planctl_target = ?)`,
            )
            .get(epicId, epicId) as { id: number | null; ts: number | null };
          const stampId = latest.id ?? 0;
          const stampTs = latest.ts ?? 0;
          const existing = db
            .prepare("SELECT epic_id FROM epics WHERE epic_id = ?")
            .get(epicId) as { epic_id: string } | null;
          if (existing != null) {
            db.run(
              `UPDATE epics SET job_links = ?, last_event_id = ?, updated_at = ?
              WHERE epic_id = ?`,
              [jobLinksJson, stampId, stampTs, epicId],
            );
          } else {
            db.run(
              `INSERT INTO epics (
               epic_id, epic_number, title, project_dir, status,
               last_event_id, updated_at, tasks, jobs, job_links
             ) VALUES (?, NULL, NULL, NULL, NULL, ?, ?, '[]', '[]', ?)`,
              [epicId, stampId, stampTs, jobLinksJson],
            );
          }
        }

        db.run("ANALYZE events");
      }
    },
  },
  {
    version: 21,
    kind: "backfill",
    apply: (ctx) => {
      const { db } = ctx;
      // v20→v21: enrich `epics.job_links` entries with `{title, state,
      // rate_limited_at}`. No ALTER (TYPE unchanged); a version-guarded re-derive
      // using the SAME `enrichJobLink`/`sortJobLinks` shape as the live reducer
      // so the result is byte-identical to a from-scratch re-fold. A missing jobs
      // row enriches to `{title:null, state:"stopped", rate_limited_at:null}`.
      const storedVersionV21 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV21 < 21) {
        const epicRowsV21 = db
          .prepare("SELECT epic_id, job_links FROM epics")
          .all() as { epic_id: string; job_links: string | null }[];
        for (const row of epicRowsV21) {
          // Safe parse — a malformed blob folds to []. NEVER throw inside
          // migrate() (rolls back the BEGIN IMMEDIATE and wedges the upgrade).
          let entries: { kind: string; job_id: string }[] = [];
          if (row.job_links != null && row.job_links.length > 0) {
            try {
              const parsed = JSON.parse(row.job_links);
              if (Array.isArray(parsed)) {
                entries = parsed as { kind: string; job_id: string }[];
              }
            } catch {
              // malformed blob — fold to []; the UPDATE below writes '[]'
              // and the entry is gone (matches the zero-event reading).
            }
          }
          const enriched: {
            kind: string;
            job_id: string;
            title: string | null;
            state: string;
            rate_limited_at: number | null;
          }[] = [];
          for (const e of entries) {
            if (
              e == null ||
              typeof e !== "object" ||
              typeof e.kind !== "string" ||
              typeof e.job_id !== "string"
            ) {
              continue; // malformed entry — drop.
            }
            const jobRow = db
              .prepare(
                "SELECT title, state, rate_limited_at FROM jobs WHERE job_id = ?",
              )
              .get(e.job_id) as {
              title: string | null;
              state: string;
              rate_limited_at: number | null;
            } | null;
            if (jobRow == null) {
              // Orphan entry — retain with safe defaults for re-fold determinism.
              enriched.push({
                kind: e.kind,
                job_id: e.job_id,
                title: null,
                state: "stopped",
                rate_limited_at: null,
              });
            } else {
              enriched.push({
                kind: e.kind,
                job_id: e.job_id,
                title: jobRow.title,
                state: jobRow.state,
                rate_limited_at: jobRow.rate_limited_at,
              });
            }
          }
          // Total-order ASC sort on (kind, job_id), mirroring `sortJobLinks` —
          // re-applied so a mis-sorted blob can't diverge from a re-fold.
          enriched.sort((a, b) => {
            if (a.kind < b.kind) return -1;
            if (a.kind > b.kind) return 1;
            if (a.job_id < b.job_id) return -1;
            if (a.job_id > b.job_id) return 1;
            return 0;
          });
          db.run("UPDATE epics SET job_links = ? WHERE epic_id = ?", [
            JSON.stringify(enriched),
            row.epic_id,
          ]);
        }
      }
    },
  },
  {
    version: 22,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v21→v22: add `events.config_dir` (`CLAUDE_CONFIG_DIR` scraped at
      // SessionStart) + `jobs.config_dir` (its projection).
      addColumnIfMissing(db, "events", "config_dir", "TEXT");
      addColumnIfMissing(db, "jobs", "config_dir", "TEXT");
    },
  },
  // v22→v23: comment-only no-op — `usage` is created above; the version stamp
  // needs a slot per the CLAUDE.md "bump only when adding an ALTER" invariant.
  // NO freshness columns: the worker read-and-discards the envelope's
  // `fetched_at` etc., so adding one here would churn every ~90s.
  { version: 23, kind: "noop", apply: () => {} },
  {
    version: 24,
    kind: "rewind",
    apply: (ctx) => {
      const { db } = ctx;
      // v23→v24: replace `jobs.rate_limited_at` with the
      // `last_api_error_at`/`last_api_error_kind` pair. The fields also ride the
      // embedded `jobs`/`job_links` arrays, so a rewind-and-redrain is REQUIRED
      // to harmonize every entry (legacy `RateLimited` events fold to
      // `kind="rate_limit"`). The dual-case `RateLimited | ApiError` fold keeps
      // the historical log re-fold deterministic.
      addColumnIfMissing(db, "jobs", "last_api_error_at", "REAL");
      addColumnIfMissing(db, "jobs", "last_api_error_kind", "TEXT");

      dropColumnIfPresent(db, "jobs", "rate_limited_at");

      // Version-guarded rewind-and-redrain.
      const storedVersionV24 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV24 < 24) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  {
    version: 25,
    kind: "rewind",
    apply: (ctx) => {
      const { db } = ctx;
      // v24→v25: add the `last_input_request_at`/`last_input_request_kind` pair
      // (session blocked on AskUserQuestion). The fields ride the embedded
      // arrays, so a rewind-and-redrain is REQUIRED to harmonize every entry.
      addColumnIfMissing(db, "jobs", "last_input_request_at", "REAL");
      addColumnIfMissing(db, "jobs", "last_input_request_kind", "TEXT");

      // Version-guarded rewind-and-redrain.
      const storedVersionV25 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV25 < 25) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  {
    version: 26,
    kind: "rewind",
    apply: (ctx) => {
      const { db } = ctx;
      // v26: widen the spawn-name regex to accept the `approve` verb. The regex
      // change is data-incompatible (old `approve::...` rows left `plan_verb`
      // NULL), so rewind + redrain re-folds them under the widened regex.
      const storedVersionV26 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV26 < 26) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  {
    version: 27,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v26→v27: add the `usage` `sonnet_week` percent/resets pair. No rewind —
      // pre-feature events re-fold to NULL (the zero-event reading).
      addColumnIfMissing(db, "usage", "sonnet_week_percent", "REAL");
      addColumnIfMissing(db, "usage", "sonnet_week_resets_at", "TEXT");
    },
  },
  {
    version: 28,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v27→v28: denormalize `git_dirty_count`/`git_orphan_count` onto `jobs`
      // (fanned out by `projectGitStatus` + `syncJobIntoEpic`, also onto the
      // embedded arrays).
      addColumnIfMissing(
        db,
        "jobs",
        "git_dirty_count",
        "INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        db,
        "jobs",
        "git_orphan_count",
        "INTEGER NOT NULL DEFAULT 0",
      );

      // NO rewind: pre-v28 rows read 0/0 until the next GitSnapshot re-snapshots
      // (sub-second); from-scratch re-fold re-derives the counts anyway.
    },
  },
  {
    version: 29,
    kind: "rewind",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v28→v29: add `epics.created_by_closer_of` + `sort_path`. `sort_path` is a
      // zero-padded-6 dotted key like `"000003.000007"` — the dot (ASCII 46) is
      // strictly below the digits (48-57), so the prefix-sort invariant
      // `"000003" < "000003.000007" < "000004"` holds under BINARY collation.
      // VERSION-GUARDED (fn-936 v85 DROPS both columns; an unconditional re-add
      // would resurrect them on every post-v85 reboot — the v85 drop runs once).
      if (preMigrateStoredVersion < 29) {
        addColumnIfMissing(db, "epics", "created_by_closer_of", "TEXT");
        addColumnIfMissing(
          db,
          "epics",
          "sort_path",
          "TEXT NOT NULL DEFAULT ''",
        );
      }

      // Version-guarded rewind-and-redrain (both columns derive from the log via
      // `syncPlanLinks`).
      const storedVersionV29 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV29 < 29) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  {
    version: 30,
    kind: "rewind",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v29→v30: add `events.planctl_queue_jump` (the `/plan:queue` signal) +
      // `epics.queue_jump`. `queue_jump` drives the `!`-prefix `sort_path` branch
      // for root epics — `"!"` (ASCII 33) sorts strictly below the digits (48-57)
      // under BINARY collation, lifting queued roots above non-queued ones. The
      // Both adds are VERSION-GUARDED: `planctl_queue_jump` because v78 renames
      // it → `plan_queue_jump` (an unconditional re-add resurrects a zombie
      // post-v78), and `epics.queue_jump` because fn-936 (v85) DROPS it (an
      // unconditional re-add resurrects it on every post-v85 reboot).
      if (preMigrateStoredVersion < 30) {
        addColumnIfMissing(db, "events", "planctl_queue_jump", "INTEGER");
        addColumnIfMissing(
          db,
          "epics",
          "queue_jump",
          "INTEGER NOT NULL DEFAULT 0",
        );
      }

      // Version-guarded rewind-and-redrain (both columns derive from the log).
      const storedVersionV30 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV30 < 30) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  {
    version: 31,
    kind: "rewind",
    apply: (ctx) => {
      const { db } = ctx;
      // v30→v31: per-(session, file) git attribution. Adds the
      // `bash_mutation_kind`/`bash_mutation_targets` event columns + partial
      // index, renames `jobs.git_orphan_count` → `git_unattributed_to_live_count`
      // and adds a fresh `git_orphan_count`, and creates `file_attributions`.
      //
      // Defensive SQLite version check (RENAME COLUMN needs 3.25+), run
      // unconditionally — never-throw-inside-migrate makes a half-applied schema
      // the worse outcome.
      const sqliteVer = (
        db.prepare("SELECT sqlite_version() AS v").get() as { v: string }
      ).v;
      {
        const parts = sqliteVer.split(".").map((n) => Number(n));
        const major = parts[0] ?? 0;
        const minor = parts[1] ?? 0;
        if (major < 3 || (major === 3 && minor < 25)) {
          throw new Error(
            `schema v31 requires SQLite 3.25+ for RENAME COLUMN; found ${sqliteVer}`,
          );
        }
      }

      addColumnIfMissing(db, "events", "bash_mutation_kind", "TEXT");
      addColumnIfMissing(db, "events", "bash_mutation_targets", "TEXT");

      // The rename MUST run BEFORE the fresh `git_orphan_count` add: adding first
      // against a legacy-named column would no-op the add and then drift-fail the
      // rename (`hasOld && hasNew`).
      renameColumnIfPresent(
        db,
        "jobs",
        "git_orphan_count",
        "git_unattributed_to_live_count",
      );
      addColumnIfMissing(
        db,
        "jobs",
        "git_orphan_count",
        "INTEGER NOT NULL DEFAULT 0",
      );

      // Partial index AFTER the column it depends on.
      for (const sql of CREATE_V31_INDEXES) {
        db.run(sql);
      }

      // Same-transaction backfill of the new sparse columns via the SAME pure
      // deriver the hook uses, so historical rows and future writes converge.
      // The bash-attribution fold reads the BACKFILLED `events` rows (not the
      // live deriver), so the events table MUST carry the columns before the boot
      // drain. Version-guarded.
      const storedVersionV31Backfill = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV31Backfill < 31) {
        const rows = db
          .prepare(
            `SELECT id, hook_event, tool_name, cwd, data FROM events
             WHERE tool_name = 'Bash' AND hook_event = 'PostToolUse'`,
          )
          .all() as {
          id: number;
          hook_event: string;
          tool_name: string | null;
          cwd: string | null;
          data: string;
        }[];
        const updateStmt = db.prepare(
          `UPDATE events
            SET bash_mutation_kind = ?, bash_mutation_targets = ?
          WHERE id = ?`,
        );
        for (const row of rows) {
          // Defensive parse — a malformed blob folds to NULL; never throw.
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(row.data) as Record<string, unknown>;
            if (typeof parsed !== "object" || parsed === null) {
              updateStmt.run(null, null, row.id);
              continue;
            }
          } catch {
            updateStmt.run(null, null, row.id);
            continue;
          }
          const mutation = extractBashMutation(
            row.hook_event,
            row.tool_name,
            parsed,
            row.cwd,
          );
          if (mutation === null) {
            updateStmt.run(null, null, row.id);
            continue;
          }
          updateStmt.run(
            mutation.kind,
            JSON.stringify(mutation.targets),
            row.id,
          );
        }
      }

      // Version-guarded rewind-and-redrain: the new `git_orphan_count` and
      // `file_attributions` rows are computed by the new fold, so wipe + re-fold.
      const storedVersionV31 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV31 < 31) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        // Class-aware wipe of the LIVE-ONLY git surface: resets the skip-floor +
        // sets seed_required so the surface repopulates (a bare DELETE would
        // strand it empty below the floor). See `rewindLiveProjection`.
        rewindLiveProjection(db);
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  {
    version: 32,
    kind: "additive",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v31→v32: `epics.default_visible` VIRTUAL generated column materializing
      // the board's default-visibility predicate as a single-column 0/1 a partial
      // index can serve. The CASE-wrap is load-bearing: bare
      // `(status='open' OR approval!='approved')` returns NULL when status IS NULL
      // — violating the column's NOT NULL constraint at scan time. Uses
      // `addGeneratedColumnIfMissing` (reads `table_xinfo`; `table_info` excludes
      // generated columns and would re-fire the ALTER every boot). This literal
      // matches the v55→v56 rewrite so a v31→v56 jump lands it on the first add.
      addGeneratedColumnIfMissing(
        db,
        "epics",
        "default_visible",
        "INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status IS NOT NULL AND (status='open' OR approval!='approved') THEN 1 ELSE 0 END) VIRTUAL",
      );

      // Always-run indexes on epics/jobs/events, placed AFTER the columns they
      // index. `analysis_limit = 400` caps the per-index ANALYZE sample so it
      // stays bounded on a large `events` table (connection-scoped; writes
      // sqlite_stat1 only — re-fold safe).
      db.run("PRAGMA analysis_limit = 400");
      for (const sql of CREATE_EPICS_INDEXES) {
        db.run(sql);
      }
      for (const sql of CREATE_JOBS_INDEXES) {
        db.run(sql);
      }
      // VERSION-GUARDED (not always-run like the two above): v78 DROP/CREATE-
      // renames `idx_events_planctl_epic`/`_target` → `idx_events_plan_*`. An
      // unconditional re-CREATE on a post-v78 boot would resurrect the dropped old
      // index name against the renamed-away `planctl_*` columns and throw. The
      // `< 32` guard (their v31→v32 intro version) fires them only on the walk up.
      if (preMigrateStoredVersion < 32) {
        for (const sql of CREATE_EVENTS_PLANCTL_INDEXES) {
          db.run(sql);
        }
      }
      db.run("ANALYZE epics");
      db.run("ANALYZE jobs");
      db.run("ANALYZE events");
    },
  },
  // v32→v33: comment-only no-op — `profiles` is created above and populates
  // organically from the event log; the version stamp needs a slot.
  { version: 33, kind: "noop", apply: () => {} },
  {
    version: 34,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v33→v34: add `epics.resolved_epic_deps` + the `epic_dep_edges` table. The
      // column's NULL ("not-yet-computed") is load-bearing — DISTINCT from `'[]'`
      // ("computed, no deps"); `decodeRow` returns null (not []) so clients can
      // tell "still converging" from "empty by design".
      addColumnIfMissing(db, "epics", "resolved_epic_deps", "TEXT");
    },
  },
  {
    version: 35,
    kind: "backfill",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v34→v35: colocate rate-limit state into `usage` + add
      // `profiles.profile_name` (the `projectBasename(config_dir)` join key).
      addColumnIfMissing(db, "usage", "last_rate_limit_at", "REAL");
      addColumnIfMissing(db, "usage", "last_rate_limit_session_id", "TEXT");
      addColumnIfMissing(db, "profiles", "profile_name", "TEXT");
      if (preMigrateStoredVersion < 35) {
        // Version-guarded backfill of `profile_name` via the SAME
        // `projectBasename` the SessionStart seed uses, so a re-fold converges.
        const rows = db.prepare("SELECT config_dir FROM profiles").all() as {
          config_dir: string;
        }[];
        const updateStmt = db.prepare(
          "UPDATE profiles SET profile_name = ? WHERE config_dir = ?",
        );
        for (const row of rows) {
          updateStmt.run(projectBasename(row.config_dir), row.config_dir);
        }
      }
    },
  },
  {
    version: 36,
    kind: "backfill",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v35→v36: add `jobs.profile_name` (`projectBasename(config_dir)`).
      // Tracks `config_dir`'s OWN nullability (NULL → NULL, not the `''`-collapse
      // the `profiles` seed uses) so the resume COALESCE precedence stays honest.
      addColumnIfMissing(db, "jobs", "profile_name", "TEXT");
      if (preMigrateStoredVersion < 36) {
        // Version-guarded backfill via the SAME `projectBasename` the fold uses
        // (NULL config_dir → NULL), so a re-fold converges.
        const jobRows = db
          .prepare("SELECT job_id, config_dir FROM jobs")
          .all() as {
          job_id: string;
          config_dir: string | null;
        }[];
        const jobUpdateStmt = db.prepare(
          "UPDATE jobs SET profile_name = ? WHERE job_id = ?",
        );
        for (const row of jobRows) {
          jobUpdateStmt.run(
            row.config_dir == null ? null : projectBasename(row.config_dir),
            row.job_id,
          );
        }
      }
    },
  },
  // v36→v37: comment-only no-op — `dead_letters` is created above and
  // populates only from the daemon's import scan; the version stamp needs a
  // slot. NOT a reducer projection: the re-fold reset path MUST NOT touch it
  // (it records events that never made it into the log).
  { version: 37, kind: "noop", apply: () => {} },
  {
    version: 38,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v37→v38: project the agentusage envelope's status/subscription/error axes
      // onto `usage`. `error_at` is projected but EXCLUDED from the worker
      // change-gate (it advances on every failed scrape, ~90s).
      addColumnIfMissing(db, "usage", "status", "TEXT");
      addColumnIfMissing(db, "usage", "subscription_active", "INTEGER");
      addColumnIfMissing(db, "usage", "error_type", "TEXT");
      addColumnIfMissing(db, "usage", "error_message", "TEXT");
      addColumnIfMissing(db, "usage", "error_at", "TEXT");
    },
  },
  {
    version: 39,
    kind: "rewind",
    apply: (ctx) => {
      const { db } = ctx;
      // v38→v39: re-backfill `bash_mutation_*` via the shared deriver (its OUTPUT
      // changed — `git-rm`/`git-mv`, redirect-token fix) then rewind + redrain so
      // healed attributions re-fold deterministically. No schema-shape change.
      const storedVersionV39Backfill = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV39Backfill < 39) {
        const rows = db
          .prepare(
            `SELECT id, hook_event, tool_name, cwd, data FROM events
             WHERE tool_name = 'Bash' AND hook_event = 'PostToolUse'`,
          )
          .all() as {
          id: number;
          hook_event: string;
          tool_name: string | null;
          cwd: string | null;
          data: string;
        }[];
        const updateStmt = db.prepare(
          `UPDATE events
            SET bash_mutation_kind = ?, bash_mutation_targets = ?
          WHERE id = ?`,
        );
        for (const row of rows) {
          // Defensive parse — a malformed blob folds to NULL; never throw.
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(row.data) as Record<string, unknown>;
            if (typeof parsed !== "object" || parsed === null) {
              updateStmt.run(null, null, row.id);
              continue;
            }
          } catch {
            updateStmt.run(null, null, row.id);
            continue;
          }
          const mutation = extractBashMutation(
            row.hook_event,
            row.tool_name,
            parsed,
            row.cwd,
          );
          if (mutation === null) {
            updateStmt.run(null, null, row.id);
            continue;
          }
          updateStmt.run(
            mutation.kind,
            JSON.stringify(mutation.targets),
            row.id,
          );
        }
      }

      // Version-guarded rewind: the boot drain rebuilds the projections under the
      // new reducer logic.
      const storedVersionV39Rewind = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV39Rewind < 39) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        // Class-aware wipe of the LIVE-ONLY git surface: resets the skip-floor +
        // sets seed_required so the surface repopulates (a bare DELETE would
        // strand it empty below the floor). See `rewindLiveProjection`.
        rewindLiveProjection(db);
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  {
    version: 40,
    kind: "backfill",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v39→v40: add `jobs.name_history` (distinct titles, oldest→newest, capped
      // at 20). A pure function of the persisted cell + incoming title (no
      // `Date.now`, no arrival ordering) so a re-fold is deterministic.
      addColumnIfMissing(
        db,
        "jobs",
        "name_history",
        "TEXT NOT NULL DEFAULT '[]'",
      );
      if (preMigrateStoredVersion < 40) {
        // Version-guarded backfill: seed `["<title>"]` / `[]`.
        const rows = db.prepare("SELECT job_id, title FROM jobs").all() as {
          job_id: string;
          title: string | null;
        }[];
        const updateStmt = db.prepare(
          "UPDATE jobs SET name_history = ? WHERE job_id = ?",
        );
        for (const row of rows) {
          const seed = row.title != null ? JSON.stringify([row.title]) : "[]";
          updateStmt.run(seed, row.job_id);
        }
      }
    },
  },
  {
    version: 41,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v40→v41: add `usage.rate_limit_lifts_at` + `last_usage_fold_at`.
      // `last_usage_fold_at` is the event `ts` of the last SUCCESSFUL usage fold
      // (never an idle/stale or rate-limit fold) — sourced from `ts`, never
      // `Date.now()`, for re-fold determinism. Both are carved out of the
      // rate-limit fan-out's UPDATE (the percentage path owns them).
      addColumnIfMissing(db, "usage", "rate_limit_lifts_at", "TEXT");
      addColumnIfMissing(db, "usage", "last_usage_fold_at", "REAL");

      // Covering indexes for the inferred-attribution window self-join, created
      // HERE (after the v16→v17 `tool_use_id` add) so a pre-v17 migrating DB
      // doesn't fail "no such column". Covering keeps the join off the 64k full
      // bash-event rows (cache-independent). Idempotent — no SCHEMA_VERSION bump.
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_events_bashwin_pre ON events(hook_event, tool_name, ts, tool_use_id, session_id)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx_events_bashwin_post ON events(tool_use_id, hook_event, tool_name, ts, cwd, session_id) WHERE tool_use_id IS NOT NULL",
      );

      // Retire the pre-covering attribution indexes now that idx_events_tool_attr
      // / idx_events_bash_attr cover their scans. Ordered AFTER those CREATEs so
      // an existing DB sheds the uncovered key. Idempotent — no SCHEMA_VERSION bump.
      db.run("DROP INDEX IF EXISTS idx_events_tool_file_path");
      db.run("DROP INDEX IF EXISTS idx_events_bash_mutation_kind");

      // Shed three consumer-less/dead events indexes from already-migrated DBs
      // (the CREATEs were removed from CREATE_EVENTS_INDEXES). Idempotent — no bump.
      db.run("DROP INDEX IF EXISTS idx_events_event_type");
      db.run("DROP INDEX IF EXISTS idx_events_tool_name");
      db.run("DROP INDEX IF EXISTS idx_events_hook_tool");
    },
  },
  {
    version: 42,
    kind: "rewind",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v41→v42: translate keeper's `''` default-profile sentinel ↔ agentusage's
      // `"default"` usage id at the join boundary so a default-account rate limit
      // colocates onto `usage.default`. No schema-shape change — the bump gates
      // the rewind that heals the stranded annotations (the fold output changed).
      // The DELETE adds `usage` + `profiles` to the standard set; MUST NOT touch
      // `dead_letters` (not a reducer projection).
      if (preMigrateStoredVersion < 42) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        // Class-aware wipe of the LIVE-ONLY git surface: resets the skip-floor +
        // sets seed_required so the surface repopulates (a bare DELETE would
        // strand it empty below the floor). See `rewindLiveProjection`.
        rewindLiveProjection(db);
        db.run("DELETE FROM subagent_invocations");
        db.run("DELETE FROM usage");
        db.run("DELETE FROM profiles");
        // Every reducer-owned projection joins this canonical wipe list so any
        // FUTURE rewind stays complete; each is harmless-empty on a pre-feature
        // log.
        db.run("DELETE FROM dispatch_failures");
        db.run("DELETE FROM autopilot_state");
        db.run("DELETE FROM pending_dispatches");
        db.run("DELETE FROM dispatch_never_bound");
        db.run("DELETE FROM block_escalations");
        db.run("DELETE FROM handoffs");
        db.run("DELETE FROM armed_epics");
        db.run("DELETE FROM builds");
      }
    },
  },
  // v42→v43: comment-only no-op — `dispatch_failures` is created above and
  // populates from the reducer's fold arms; the version stamp needs a slot.
  // A reducer projection (in the rewind-and-redrain DELETE list).
  { version: 43, kind: "noop", apply: () => {} },
  {
    version: 44,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v43→v44: add `file_attributions.worktree_oid` (the filter-correct git
      // blob oid frozen into the GitSnapshot payload). Nullable, no backfill
      // (the oid can't be re-derived from stored events); NULL falls back to
      // timestamp discharge ("cannot confirm content equality → keep active").
      addColumnIfMissing(db, "file_attributions", "worktree_oid", "TEXT");
    },
  },
  {
    version: 45,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v44→v45: add `file_attributions.worktree_mode`, paired with
      // `worktree_oid` on the discharge gate so a chmod-only dirty file (equal
      // oid, differing mode) is NOT wrongly discharged. Nullable → timestamp
      // discharge fallback.
      addColumnIfMissing(db, "file_attributions", "worktree_mode", "TEXT");
    },
  },
  {
    version: 46,
    kind: "rewind",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v45→v46: attribute planctl file writes. Adds `events.planctl_files`,
      // widens the `file_attributions.source` CHECK to include `'planctl'` (a
      // row-preserving TABLE REBUILD since SQLite can't ALTER a CHECK), backfills,
      // and rewinds. The CHECK rebuild MUST run BEFORE the rewind (DELETE
      // preserves the new CHECK) and before the boot drain writes
      // `source='planctl'` rows the old CHECK would reject. Version-guarded. The
      // `planctl_files` add is itself VERSION-GUARDED (v78 renames it →
      // `plan_files`, so an unconditional re-add resurrects a zombie post-v78).
      if (preMigrateStoredVersion < 46) {
        addColumnIfMissing(db, "events", "planctl_files", "TEXT");
      }

      const storedVersionV46 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );

      // CHECK rebuild (SQLite can't ALTER a CHECK): create-new + byte-faithful
      // copy + drop-old + rename, then re-create the indexes. The copy MUST stay
      // byte-faithful even though the rewind below wipes the table.
      if (storedVersionV46 < 46) {
        // Drop any leftover temp table from an interrupted prior attempt.
        db.run("DROP TABLE IF EXISTS file_attributions_v46_tmp");
        db.run(`
        CREATE TABLE file_attributions_v46_tmp (
            project_dir TEXT NOT NULL,
            session_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            last_mutation_at REAL NOT NULL,
            last_commit_at REAL,
            op TEXT NOT NULL,
            source TEXT NOT NULL CHECK(source IN ('tool','bash','inferred','planctl')),
            last_event_id INTEGER,
            updated_at REAL NOT NULL DEFAULT 0,
            worktree_oid TEXT,
            worktree_mode TEXT,
            PRIMARY KEY (project_dir, session_id, file_path)
        )
      `);
        // Byte-faithful copy, ORDER BY rowid for stable physical order.
        db.run(`
        INSERT INTO file_attributions_v46_tmp
            (project_dir, session_id, file_path, last_mutation_at,
             last_commit_at, op, source, last_event_id, updated_at,
             worktree_oid, worktree_mode)
          SELECT project_dir, session_id, file_path, last_mutation_at,
                 last_commit_at, op, source, last_event_id, updated_at,
                 worktree_oid, worktree_mode
            FROM file_attributions
        ORDER BY rowid
      `);
        db.run("DROP TABLE file_attributions");
        db.run(
          "ALTER TABLE file_attributions_v46_tmp RENAME TO file_attributions",
        );
        // Re-create the indexes (SQLite drops them with their base table).
        for (const sql of CREATE_FILE_ATTRIBUTIONS_INDEXES) {
          db.run(sql);
        }
      }

      // Backfill `events.planctl_files` via the shared `extractPlanInvocation`
      // deriver (defensive parse; non-planctl rows stay NULL).
      if (storedVersionV46 < 46) {
        const rows = db
          .prepare(
            `SELECT id, hook_event, tool_name, data FROM events
             WHERE tool_name = 'Bash' AND hook_event = 'PostToolUse'`,
          )
          .all() as {
          id: number;
          hook_event: string;
          tool_name: string | null;
          data: string;
        }[];
        const updateStmt = db.prepare(
          "UPDATE events SET planctl_files = ? WHERE id = ?",
        );
        for (const row of rows) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(row.data) as Record<string, unknown>;
            if (typeof parsed !== "object" || parsed === null) {
              continue;
            }
          } catch {
            continue;
          }
          const inv = extractPlanInvocation(
            row.hook_event,
            row.tool_name,
            parsed,
          );
          if (inv === null) continue;
          const json = inv.files === null ? null : JSON.stringify(inv.files);
          updateStmt.run(json, row.id);
        }
      }

      // Cursor-rewind + redrain so historical .planctl orphans re-attribute
      // under the new mint path.
      if (storedVersionV46 < 46) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        // Class-aware wipe of the LIVE-ONLY git surface: resets the skip-floor +
        // sets seed_required so the surface repopulates (a bare DELETE would
        // strand it empty below the floor). See `rewindLiveProjection`.
        rewindLiveProjection(db);
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  // v46→v47: comment-only no-op — `autopilot_state` is created above and
  // populates from the boot-append `AutopilotPaused` fold; the version stamp
  // needs a slot. A reducer projection (in the rewind-and-redrain DELETE
  // list). No migration seed row keeps `created_at` purely event-log-derived.
  { version: 47, kind: "noop", apply: () => {} },
  {
    version: 48,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v47→v48: backend-exec coordinate columns on `events` + `jobs`. Generic
      // `backend_exec_*` naming lets a future tmux/wezterm backend slot in
      // without a schema change. Whitelist-only Python read (see floor item 10:
      // a SCHEMA_VERSION bump MUST add the version to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit, or
      // every keeper-py read fails host-wide; test/schema-version.test.ts
      // enforces this on every later bump too).
      addColumnIfMissing(db, "events", "backend_exec_type", "TEXT");
      addColumnIfMissing(db, "events", "backend_exec_session_id", "TEXT");
      addColumnIfMissing(db, "events", "backend_exec_pane_id", "TEXT");
      addColumnIfMissing(db, "jobs", "backend_exec_type", "TEXT");
      addColumnIfMissing(db, "jobs", "backend_exec_session_id", "TEXT");
      addColumnIfMissing(db, "jobs", "backend_exec_pane_id", "TEXT");
      addColumnIfMissing(db, "jobs", "backend_exec_tab_id", "TEXT");
      addColumnIfMissing(db, "jobs", "backend_exec_tab_name", "TEXT");
    },
  },
  // v48→v49: task→committing-session link. NO new column — the field rides
  // FREE inside the embedded `tasks[].jobs[]` JSON-TEXT cell; pre-v49 stored
  // elements decode it as `undefined` and `buildEmbeddedJob` coerces to null
  // for byte-deterministic re-fold. Whitelist-only Python bump (floor 10).
  { version: 49, kind: "noop", apply: () => {} },
  // v49→v50: comment-only no-op — `pending_dispatches` is created above and
  // populates from the reducer's fold arms; the version stamp needs a slot. A
  // reducer projection (in the rewind-and-redrain DELETE list).
  { version: 50, kind: "noop", apply: () => {} },
  {
    version: 51,
    kind: "backfill",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v50→v51: add `events.background_task_id` + `jobs.monitors` + the partial
      // index. A version-guarded backfill re-derives the column via the SAME pure
      // deriver the hook uses, so a re-fold reproduces byte-identical
      // `jobs.monitors`.
      addColumnIfMissing(db, "events", "background_task_id", "TEXT");
      addColumnIfMissing(db, "jobs", "monitors", "TEXT NOT NULL DEFAULT '[]'");
      for (const sql of CREATE_V51_INDEXES) {
        db.run(sql);
      }

      if (preMigrateStoredVersion < 51) {
        const rows = db
          .prepare(
            `SELECT id, hook_event, tool_name, data FROM events
             WHERE hook_event = 'PostToolUse'
               AND tool_name IN ('Monitor', 'Bash')`,
          )
          .all() as {
          id: number;
          hook_event: string;
          tool_name: string | null;
          data: string;
        }[];
        const updateStmt = db.prepare(
          "UPDATE events SET background_task_id = ? WHERE id = ?",
        );
        for (const row of rows) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(row.data) as Record<string, unknown>;
            if (typeof parsed !== "object" || parsed === null) {
              continue; // schema default NULL already in place.
            }
          } catch {
            continue; // schema default NULL already in place.
          }
          const id = extractBackgroundTaskId(
            row.hook_event,
            row.tool_name,
            parsed,
          );
          if (id !== null) {
            updateStmt.run(id, row.id);
          }
        }
      }
    },
  },
  {
    version: 52,
    kind: "rewind",
    apply: (ctx) => {
      const { db } = ctx;
      // v51→v52: add `jobs.last_permission_prompt_at`/`_kind` (blocked on a
      // permission/elicitation prompt), folded from a REAL `Notification` event
      // (not a synthetic mint), layering on top of `[working]` without flipping
      // state. The fields ride the embedded arrays so a rewind is REQUIRED. Unlike
      // the v25 input-request rewind, the live log ALREADY has historical
      // `permission_prompt` rows, so the rewind WILL fold them — intended; the
      // stamp is a pure function of `event.ts`, so a re-fold is deterministic.
      addColumnIfMissing(db, "jobs", "last_permission_prompt_at", "REAL");
      addColumnIfMissing(db, "jobs", "last_permission_prompt_kind", "TEXT");

      // Version-guarded rewind-and-redrain.
      const storedVersionV52 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV52 < 52) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
      }
    },
  },
  {
    version: 53,
    kind: "rewind",
    apply: (ctx) => {
      const { db } = ctx;
      // v52→v53: `epic_tombstones` guards every epic-shell-INSERT site against
      // the deleted-epic resurrection ghost. A rewind-and-redrain rebuilds
      // existing `epics` ghosts with the tombstone guard engaged.
      const storedVersionV53 = Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      );
      if (storedVersionV53 < 53) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
        db.run("DELETE FROM epic_tombstones");
      }
    },
  },
  // v53→v54: durable commit-derived creator/refiner edges. NO new column —
  // the commit-trailer union rides FREE inside the existing
  // `epics.job_links` / `jobs.epic_links` cells; `foldCommit` TRIGGERS the
  // per-session rebuild (never writes the cells directly — single-writer
  // preserved). No rewind (fix-forward): pre-feature Commit events default the
  // trailer fields to null, so the union is a historical no-op.
  { version: 54, kind: "noop", apply: () => {} },
  {
    version: 55,
    kind: "drop",
    apply: (ctx) => {
      const { db } = ctx;
      // v54→v55: drop the dead `jobs.backend_exec_{tab_id,tab_name}` columns
      // (their fold is a no-op). The live `backend_exec_{type,session_id,pane_id}`
      // coords STAY.
      dropColumnIfPresent(db, "jobs", "backend_exec_tab_id");
      dropColumnIfPresent(db, "jobs", "backend_exec_tab_name");
    },
  },
  {
    version: 56,
    kind: "drop",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v55→v56: rewrite `epics.default_visible` to add the `status IS NOT NULL`
      // materialized gate (status is non-null at exactly the EpicSnapshot UPSERT,
      // so it's an exact "EpicSnapshot folded" discriminator hiding NULL-status
      // shell rows). KEEP the CASE wrap (NOT NULL column, nullable status). SQLite
      // can't ALTER a generated-column expression, so DROP + re-ADD in this one
      // transaction: (1) DROP the index FIRST (it references the column);
      // (2) DROP the VIRTUAL column via a `table_xinfo` check (`table_info`
      // excludes generated columns and would no-op wrongly); (3) re-ADD;
      // (4) recreate the index. Version-guarded; `quick_check` asserts integrity.
      if (preMigrateStoredVersion < 56) {
        const xinfoCols = db.prepare("PRAGMA table_xinfo(epics)").all() as {
          name: string;
        }[];
        if (xinfoCols.some((c) => c.name === "default_visible")) {
          db.run("DROP INDEX IF EXISTS idx_epics_default_visible");
          db.run("ALTER TABLE epics DROP COLUMN default_visible");
        }
        addGeneratedColumnIfMissing(
          db,
          "epics",
          "default_visible",
          "INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status IS NOT NULL AND (status='open' OR approval!='approved') THEN 1 ELSE 0 END) VIRTUAL",
        );
        db.run(
          // fn-936 (v85) dropped `sort_path`; this historical index recreation
          // uses the post-v85 `epic_number` shape so it never references the
          // dropped column (the v85 block DROPs + recreates it regardless).
          "CREATE INDEX IF NOT EXISTS idx_epics_default_visible ON epics(default_visible, epic_number, epic_id) WHERE default_visible = 1",
        );
        const integrity = db.prepare("PRAGMA quick_check").get() as {
          quick_check: string;
        } | null;
        if (integrity?.quick_check !== "ok") {
          throw new Error(
            `v55→v56 default_visible rewrite failed integrity quick_check: ${integrity?.quick_check ?? "no result"}`,
          );
        }
      }
    },
  },
  {
    version: 57,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v56→v57: add the empty `event_blobs` relocation side table. NOT a reducer
      // projection; with it empty every `COALESCE(events.data, event_blobs.data)`
      // returns the inline value, so re-fold is byte-identical.
      db.run(CREATE_EVENT_BLOBS);
    },
  },
  {
    version: 58,
    kind: "drop",
    apply: (ctx) => {
      const { db, needsEventsRebuild } = ctx;
      // v57→v58: relax `events.data` from NOT NULL → nullable so the compaction
      // relocator can NULL it after moving a cold blob.
      //
      // STOP-THE-WORLD TABLE REBUILD, not the O(1) `writable_schema` edit:
      // bun:sqlite's DEFENSIVE mode hard-blocks `UPDATE sqlite_master` even under
      // `writable_schema=ON`, so a full rebuild (new table, copy, DROP, RENAME) is
      // the only mechanism. THE DAEMON MUST BE STOPPED — the rebuild holds the
      // writer lock for minutes on a multi-GB DB, far past the hook's busy_timeout,
      // so a concurrent hook INSERT would dead-letter. One-time, shape-guarded
      // (`needsEventsRebuild` probes the live `data` NOT NULL flag, so fresh/
      // already-migrated DBs skip), OFFLINE. Crash-safe: inside the migrate
      // transaction, so an interrupted rebuild rolls back to the v57 table.
      // Re-fold determinism is untouched — `events` is the immutable log; the copy
      // pins column order via an explicit list and preserves the AUTOINCREMENT
      // high-water.
      if (needsEventsRebuild) {
        // Snapshot index SQL + AUTOINCREMENT high-water BEFORE the rename so the
        // rebuild recreates them exactly (no hardcoded index list to drift).
        // Auto-indexes (`sql IS NULL`) are recreated by CREATE TABLE.
        const eventsIndexSql = (
          db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND sql IS NOT NULL",
            )
            .all() as { sql: string }[]
        ).map((r) => r.sql);
        const seqRow = db
          .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'")
          .get() as { seq: number } | null;

        // Build the relaxed table under a TEMP name, copy, DROP old `events`,
        // RENAME the temp to `events`. This AVOIDS `ALTER events RENAME TO
        // events_old`: a modern-SQLite rename rewrites every REFERENCE to `events`
        // — including `event_blobs`'s FK — leaving it dangling after the old table
        // drops (every later `INSERT INTO event_blobs` then fails `no such table:
        // events_old`). Renaming the NEW table (which nothing references) avoids
        // the rewrite. The DROP of the FK-referenced `events` needs FK enforcement
        // OFF, toggled AROUND the migrate transaction (see `needsEventsRebuild`).
        // The explicit copy column list pins column order.
        db.run(
          CREATE_EVENTS.replace(
            "CREATE TABLE IF NOT EXISTS events",
            "CREATE TABLE events_v58_new",
          ),
        );
        // The v30 queue-jump column is intentionally OMITTED from this copy:
        // fn-936 (v85) dropped it AND removed it from `CREATE_EVENTS`, so the
        // `events_v58_new` table built from that literal has no such column. The
        // source column carries no fold-read value (the boot drain folds only at
        // head=v85, where the column is gone), so not copying it is harmless —
        // v78/v85 would rename-then-drop it anyway.
        db.run(
          `INSERT INTO events_v58_new (
           id, ts, session_id, pid, hook_event, event_type, tool_name, matcher,
           cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
           subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
           planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
           planctl_subject_present, tool_use_id, config_dir,
           bash_mutation_kind, bash_mutation_targets, planctl_files,
           backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
           background_task_id
         )
         SELECT
           id, ts, session_id, pid, hook_event, event_type, tool_name, matcher,
           cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
           subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
           planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
           planctl_subject_present, tool_use_id, config_dir,
           bash_mutation_kind, bash_mutation_targets, planctl_files,
           backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
           background_task_id
         FROM events`,
        );
        db.run("DROP TABLE events");
        db.run("ALTER TABLE events_v58_new RENAME TO events");
        // Recreate every captured non-auto index on the rebuilt table.
        for (const sql of eventsIndexSql) {
          db.run(sql);
        }
        // Preserve the AUTOINCREMENT high-water so a future INSERT never reuses an
        // id. `sqlite_sequence` has no PK/UNIQUE, so UPDATE (not UPSERT).
        if (seqRow != null) {
          db.run("UPDATE sqlite_sequence SET seq = ? WHERE name = 'events'", [
            seqRow.seq,
          ]);
        }
        // Belt-and-suspenders: the rebuild is a destructive structural change, so
        // verify the new table is structurally sound before the transaction
        // COMMITs (a failed check throws → rolls back to the v57 table intact).
        const integrity = db.prepare("PRAGMA quick_check").get() as {
          quick_check: string;
        } | null;
        if (integrity?.quick_check !== "ok") {
          throw new Error(
            `v57→v58 events rebuild failed integrity quick_check: ${integrity?.quick_check ?? "no result"}`,
          );
        }
      }
    },
  },
  // v58→v59: carry a `has_live_worker_monitor` occupancy fact on the embedded
  // `epics.tasks[].jobs[]` element. NO new column — it rides FREE inside the
  // JSON cell; no rewind (fix-forward), with a safe absent ≡ `false` default.
  { version: 59, kind: "noop", apply: () => {} },
  {
    version: 60,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v59→v60: add the nullable `autopilot_state.max_concurrent_jobs` cap
      // (DEFAULT NULL = unlimited). Frozen from config on main at boot-append mint
      // time (never read in the fold). Already in the autopilot_state rewind entry.
      addColumnIfMissing(
        db,
        "autopilot_state",
        "max_concurrent_jobs",
        "INTEGER",
      );
    },
  },
  {
    version: 61,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v60→v61: add the empty `event_ingest_offsets` NDJSON→events ingest cursor.
      // NOT a reducer projection (excluded from the re-fold reset DELETE list).
      db.run(CREATE_EVENT_INGEST_OFFSETS);
    },
  },
  {
    version: 62,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v61→v62: add `autopilot_state.mode` (NOT NULL DEFAULT 'yolo' = today's
      // work-everything baseline, also satisfying NOT NULL for the boot re-arm
      // INSERTs that bind no mode) + the `armed_epics` PRESENCE table (a reducer
      // projection, in the rewind-and-redrain DELETE list).
      addColumnIfMissing(
        db,
        "autopilot_state",
        "mode",
        "TEXT NOT NULL DEFAULT 'yolo'",
      );
      db.run(CREATE_ARMED_EPICS);
    },
  },
  {
    version: 63,
    kind: "drop",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v62→v63: drop the dead `approval` surface — the v55→v56 virtual-column
      // playbook in REVERSE, all in this transaction: (1) DROP the index FIRST (it
      // references the VIRTUAL column); (2) DROP `default_visible` via a
      // `table_xinfo` check (`table_info` excludes generated columns); (3) re-ADD
      // it with an `approval`-free expression; (4) recreate the index; (5) DROP the
      // now-orphaned `approval` column — MUST follow the rewrite (the old
      // expression referenced it); (6) `quick_check`. Version-guarded.
      if (preMigrateStoredVersion < 63) {
        const xinfoCols = db.prepare("PRAGMA table_xinfo(epics)").all() as {
          name: string;
        }[];
        if (xinfoCols.some((c) => c.name === "default_visible")) {
          db.run("DROP INDEX IF EXISTS idx_epics_default_visible");
          db.run("ALTER TABLE epics DROP COLUMN default_visible");
        }
        addGeneratedColumnIfMissing(
          db,
          "epics",
          "default_visible",
          "INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status IS NOT NULL AND status='open' THEN 1 ELSE 0 END) VIRTUAL",
        );
        db.run(
          // fn-936 (v85) dropped `sort_path`; this historical index recreation
          // uses the post-v85 `epic_number` shape so it never references the
          // dropped column (the v85 block DROPs + recreates it regardless).
          "CREATE INDEX IF NOT EXISTS idx_epics_default_visible ON epics(default_visible, epic_number, epic_id) WHERE default_visible = 1",
        );
        dropColumnIfPresent(db, "epics", "approval");
        const integrity = db.prepare("PRAGMA quick_check").get() as {
          quick_check: string;
        } | null;
        if (integrity?.quick_check !== "ok") {
          throw new Error(
            `v62→v63 approval drop / default_visible rewrite failed integrity quick_check: ${integrity?.quick_check ?? "no result"}`,
          );
        }
      }
    },
  },
  {
    version: 64,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v63→v64: add the empty `builds` projection table (the `keeper builds`
      // buildbot dashboard surface). A reducer projection, in the
      // rewind-and-redrain DELETE list; created unconditionally above so it
      // exists before any earlier-version rewind that wipes it. No backfill —
      // the live builds-worker poll repopulates it from the buildbot REST API.
      db.run(CREATE_BUILDS);
    },
  },
  {
    version: 65,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v64→v65: add the folded `jobs.active_since` REAL column — Unix-seconds
      // stamped on the rising edge into `working` (a stopped/terminal→working
      // transition), the recency key for the unified dash AGENTS timeline. NULL
      // default, NO backfill: `updated_at` is bumped on every event ("last
      // touched"), not "run started", so backfilling from it would conflate the
      // two and break re-fold determinism. Whitelist-only Python read (a
      // SCHEMA_VERSION bump MUST add the version to `SUPPORTED_SCHEMA_VERSIONS`
      // in `keeper/api.py` in the SAME commit, or every keeper-py read fails
      // host-wide; test/schema-version.test.ts enforces this).
      addColumnIfMissing(db, "jobs", "active_since", "REAL");
    },
  },
  {
    version: 66,
    kind: "additive",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v65→v66: add the session-anchored partial index for the SubagentStart
      // fold's pending-PreToolUse bridge. Without it the fold seeks the
      // table-wide idx_events_hook_event (every PreToolUse row per SubagentStart),
      // holding main's BEGIN IMMEDIATE writer lock for seconds. CREATE runs
      // unconditionally (idempotent IF NOT EXISTS) so it lands once per DB; the
      // version-guarded ANALYZE refreshes events stats so the planner prefers the
      // new partial index immediately (without it the planner's no-stats heuristic
      // keeps the old plan). CREATE INDEX measured at ~1.7s + ANALYZE ~1.5s on a
      // 2.65GB live-DB copy — bounded, boot won't appear hung. No projection
      // touched, so no rewind: an index changes the plan, never the result set
      // (md5-verified result-equivalence), so re-fold stays byte-identical.
      for (const sql of CREATE_V66_INDEXES) {
        db.run(sql);
      }
      if (preMigrateStoredVersion < 66) {
        db.run("PRAGMA analysis_limit = 400");
        db.run("ANALYZE events");
      }
    },
  },
  {
    version: 67,
    kind: "backfill",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v66→v67: add the `commit_trailer_facts` projection table so the
      // commit-trailer channel of `syncPlanLinks` reads an indexed projection
      // instead of re-scanning every `Commit` blob per swept session (the fn-807
      // fold fan-out). CREATE + indexes run UNCONDITIONALLY (idempotent IF NOT
      // EXISTS) so fresh and migrated DBs are schema-identical; the BACKFILL is
      // version-guarded so it walks the historical `Commit` rows exactly once.
      db.run(CREATE_COMMIT_TRAILER_FACTS);
      for (const sql of CREATE_COMMIT_TRAILER_FACTS_INDEXES) {
        db.run(sql);
      }
      if (preMigrateStoredVersion < 67) {
        // Backfill via the SAME extractCommit + parsePlanRef JS path the live
        // fold uses — NEVER a SQL `INSERT…SELECT json_extract`: a `Commit`
        // carries NULL sparse `planctl_*` columns (the trailer facts live only
        // in the JSON payload), and `parsePlanRef` cannot be replicated in SQL.
        // `COALESCE(events.data, event_blobs.data)` resolves relocated cold
        // blobs (src/compaction.ts) so they backfill too. The row condition —
        // committer_session_id + op + target all non-null — equals the
        // commit-trailer loader / live-fold INSERT condition exactly, so
        // backfilled and re-folded rows are identical by construction. No
        // cursor rewind: the projection derives from `Commit` events alone.
        //
        // ORDERING NOTE (fn-889 v82): this backfill runs HERE (the `< 67` step),
        // BEFORE the v82 Commit-data-key rewrite below flips the historical
        // `events.data` `planctl_op`/`planctl_target` keys → `plan_op`/`plan_target`.
        // `extractCommit` now reads ONLY the `plan_*` spelling (single-path), so
        // a v66-era DB whose Commit data still spells the keys `planctl_*` would
        // backfill ZERO op/target here if we leaned on `extractCommit` for them.
        // We therefore lift the op/target from the raw payload tolerating BOTH
        // spellings (the v82 rewrite hasn't run yet at this point in the ladder),
        // and still use `extractCommit` for the session-id + timestamp gates
        // (those keys never changed). This keeps the one-time historical backfill
        // correct for every upgrade path while the live read stays single-path.
        const commitRows = db
          .prepare(
            `SELECT events.id AS id,
                    COALESCE(events.data, event_blobs.data) AS data
               FROM events
               LEFT JOIN event_blobs ON event_blobs.event_id = events.id
              WHERE hook_event = 'Commit'
              ORDER BY events.id ASC`,
          )
          .all() as { id: number; data: string | null }[];
        const insertFact = db.prepare(
          `INSERT OR IGNORE INTO commit_trailer_facts (
             event_id, committer_session_id, planctl_op, planctl_target,
             planctl_epic_id, committed_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const row of commitRows) {
          if (row.data == null) continue;
          const commit = extractCommit({ data: row.data });
          if (commit == null) continue;
          // Spelling-tolerant op/target read from the raw payload (pre-v82-rewrite
          // bodies spell them `planctl_*`; post-rewrite bodies spell them
          // `plan_*`). Mirror `extractCommit`'s gates: non-empty string for the
          // op, `parsePlanRef`-valid ref for the target.
          let rawData: Record<string, unknown>;
          try {
            rawData = JSON.parse(row.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          const rawOp = rawData.plan_op ?? rawData.planctl_op;
          const op =
            typeof rawOp === "string" && rawOp.length > 0 ? rawOp : null;
          const rawTarget = rawData.plan_target ?? rawData.planctl_target;
          const target =
            typeof rawTarget === "string" && parsePlanRef(rawTarget) !== null
              ? rawTarget
              : null;
          if (
            commit.committer_session_id == null ||
            op == null ||
            target == null
          ) {
            continue;
          }
          insertFact.run(
            row.id,
            commit.committer_session_id,
            op,
            target,
            parsePlanRef(target)?.epic_id ?? null,
            commit.committed_at_ms,
          );
        }
      }
    },
  },
  // v68: bare version bump — no schema-mutating body.
  { version: 68, kind: "noop", apply: () => {} },
  {
    version: 69,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v68→v69: add `subagent_invocations.last_disposition` — the
      // transcript-derived terminal disposition of a subagent's most recent
      // assistant turn ('cut' = stream interrupted mid-turn, stop_reason
      // tool_use/null with no terminal text; 'clean' = end_turn). Fed by the
      // synthetic `SubagentTurn` event the transcript worker mints; read by the
      // SubagentStop fold to recognize SILENT_STREAM_CUT and drive auto-resume.
      // NO cursor rewind: historical events carry no `SubagentTurn`, so a
      // from-scratch re-fold reproduces the column's NULL zero-event default.
      addColumnIfMissing(
        db,
        "subagent_invocations",
        "last_disposition",
        "TEXT",
      );
    },
  },
  {
    version: 70,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v69→v70: add the producer-stamped `jobs.close_kind` TEXT column — WHY a
      // session died, classified by a main-side tmux liveness probe at the two
      // Killed producer sites (boot seed-sweep + main's exit-watcher handler):
      // `server_gone` / `pid_died` (crash-killed → restore) vs.
      // `window_gone_server_alive` (human closed the window → don't restore) vs.
      // `unknown` (probe failure → crash-eligible). The DB-derived crash-restore
      // set reads this per row instead of a frozen restore.json snapshot. The
      // reducer's Killed fold copies it verbatim (opaque string, no liveness in
      // the fold). NULL default, NO cursor rewind: a historical Killed carries no
      // `close_kind` in its payload, so a from-scratch re-fold reproduces the
      // column's NULL zero-event default. Whitelist-only Python read (this bump
      // MUST add 70 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME
      // commit, or every keeper-py read fails host-wide; test/schema-version.test.ts
      // enforces this).
      addColumnIfMissing(db, "jobs", "close_kind", "TEXT");
    },
  },
  {
    version: 71,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v70→v71: add the nullable `jobs.window_index` INTEGER column — the live
      // tmux `#{window_index}` (a window's left-to-right VISUAL position, not its
      // `@N` identity), so the DB-only crash-restore derivation can replay
      // windows in original visual order WITHOUT reading restore.json. The
      // restore-worker probes it per pulse and posts a change-gated
      // `WindowIndexSnapshot` event (gated on a layout hash so a pure reorder,
      // not every pulse, re-fires); the reducer folds it as a pure integer copy
      // keyed by `job_id` — no liveness, no probe in the fold. A killed job
      // KEEPS its last-known value (the fold never nulls a row), so the index
      // survives to restore time when the original tmux server is dead. NULL
      // default, NO cursor rewind: a historical event stream carries no
      // `WindowIndexSnapshot`, so a from-scratch re-fold reproduces the column's
      // NULL zero-event default. Whitelist-only Python read (this bump MUST add
      // 71 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit,
      // or every keeper-py read fails host-wide; test/schema-version.test.ts
      // enforces this).
      addColumnIfMissing(db, "jobs", "window_index", "INTEGER");
    },
  },
  {
    version: 72,
    kind: "drop",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v71→v72: widen the `file_attributions.source` CHECK to accept the
      // renamed `'plan'` alongside legacy `'planctl'` — the cascade-safety
      // keystone so a producer flip to `source='plan'` can't be rejected by an
      // old CHECK once the daemon is bounced onto this fold. SQLite can't ALTER a
      // CHECK, so rebuild the table with a byte-faithful row copy (ORDER BY rowid
      // for stable physical order), drop-old + rename, re-create the indexes.
      // PURELY ADDITIVE: this step changes no row's `source` and carries NO
      // cursor rewind — a from-scratch re-fold reproduces byte-identical rows.
      // (The producer flip to `source='plan'` + the stored-row rewrite land
      // later at v74→v75.) Version-guarded so the rebuild runs once.
      // Whitelist-only Python read (this bump MUST add 72 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit, or
      // every keeper-py read fails host-wide; test/schema-version.test.ts
      // enforces this).
      if (preMigrateStoredVersion < 72) {
        // Drop any leftover temp table from an interrupted prior attempt.
        db.run("DROP TABLE IF EXISTS file_attributions_v72_tmp");
        db.run(`
        CREATE TABLE file_attributions_v72_tmp (
            project_dir TEXT NOT NULL,
            session_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            last_mutation_at REAL NOT NULL,
            last_commit_at REAL,
            op TEXT NOT NULL,
            source TEXT NOT NULL CHECK(source IN ('tool','bash','inferred','planctl','plan')),
            last_event_id INTEGER,
            updated_at REAL NOT NULL DEFAULT 0,
            worktree_oid TEXT,
            worktree_mode TEXT,
            PRIMARY KEY (project_dir, session_id, file_path)
        )
      `);
        // Byte-faithful copy, ORDER BY rowid for stable physical order.
        db.run(`
        INSERT INTO file_attributions_v72_tmp
            (project_dir, session_id, file_path, last_mutation_at,
             last_commit_at, op, source, last_event_id, updated_at,
             worktree_oid, worktree_mode)
          SELECT project_dir, session_id, file_path, last_mutation_at,
                 last_commit_at, op, source, last_event_id, updated_at,
                 worktree_oid, worktree_mode
            FROM file_attributions
        ORDER BY rowid
      `);
        db.run("DROP TABLE file_attributions");
        db.run(
          "ALTER TABLE file_attributions_v72_tmp RENAME TO file_attributions",
        );
        // Re-create the indexes (SQLite drops them with their base table).
        for (const sql of CREATE_FILE_ATTRIBUTIONS_INDEXES) {
          db.run(sql);
        }
      }
    },
  },
  {
    version: 73,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v72→v73 (fn-836.2): add the `events.mutation_path` TEXT column — the
      // lone cross-event fold field of the git-attribution scan
      // (`data.tool_input.file_path`) promoted to a column. The ADD COLUMN is
      // instant (no rebuild); the partial index is KEPT OUT of the unconditional
      // CREATE block and run HERE, after the ALTER, so a migrating DB never
      // references a column that doesn't exist yet. PURELY ADDITIVE + ONLINE: the
      // hook derives it forward and the ingester recomputes it for pre-deriver
      // lines, but the fold's COALESCE dual-read on the blob is UNCHANGED this
      // task (the .3 flip lands later), so there is NO cursor rewind — a
      // from-scratch re-fold reproduces byte-identical projection rows.
      // Whitelist-only Python read (this bump MUST add 73 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit, or
      // every keeper-py read fails host-wide; test/schema-version.test.ts
      // enforces this).
      addColumnIfMissing(db, "events", "mutation_path", "TEXT");
      for (const sql of CREATE_V73_INDEXES) {
        db.run(sql);
      }
    },
  },
  {
    version: 74,
    kind: "drop",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v73→v74 (fn-836.4): the DESTRUCTIVE shed. Restore every keep-set body
      // back inline, then DROP `event_blobs` at the migration TAIL.
      //
      // RESTORE (version-guarded, the one-way data move runs once): copy every
      // RELOCATED (`events.data IS NULL`) keep-set body back into `events.data`.
      // The keep-set is the explicit ALLOW-list of event types whose body a live
      // fold reads (drain → applyEvent, the subagent PreToolUse:Agent bridge,
      // search-history's UserPromptSubmit `$.prompt`); the SHED CLASS is the four
      // PostToolUse mutation tools (Write/Edit/MultiEdit/NotebookEdit) whose ONLY
      // fold consumption is `tool_input.file_path`, already promoted to the
      // `mutation_path` column (.2/.3). So the restore predicate is "relocated AND
      // NOT shed-class" — keep-set bodies come back inline, shed-class bodies stay
      // NULL (their body is the redundant transcript archive being shed). After
      // this, a from-scratch re-fold reads every keep-set body from `events.data`
      // and every shed-class file_path from `mutation_path` — byte-identical
      // projections, with the shed bodies intentionally non-reconstructable.
      // Idempotent + crash-safe: the `EXISTS` guard + `data IS NULL` predicate
      // mean a re-run (or a partially-applied prior attempt) finds nothing to
      // restore; a mid-step crash rolls back the whole migrate transaction to the
      // known-good pre-shed v73 state (the table is still present until the tail
      // DROP commits).
      if (preMigrateStoredVersion < 74) {
        db.run(
          `UPDATE events
              SET data = (
                  SELECT data FROM event_blobs WHERE event_blobs.event_id = events.id
              )
            WHERE events.data IS NULL
              AND EXISTS (
                  SELECT 1 FROM event_blobs WHERE event_blobs.event_id = events.id
              )
              AND NOT (
                  hook_event = 'PostToolUse'
                  AND tool_name IN ('Write', 'Edit', 'MultiEdit', 'NotebookEdit')
              )`,
        );
        // CAPTURE shed-class `mutation_path` from `event_blobs` BEFORE the DROP —
        // the safety the runtime backfill pass CANNOT provide. That pass extracts
        // from inline `events.data` only (post-shed there is no side table to
        // COALESCE), so a RELOCATED shed-class body (`data IS NULL`, file_path only
        // in `event_blobs`) is unrecoverable once the table is gone. On a
        // from-scratch 0->v74 migrate the runtime pass has never run, so every
        // shed-class `mutation_path` is NULL here; dropping `event_blobs` without
        // this step would permanently lose `tool_input.file_path` and break the
        // git-attribution re-fold. `COALESCE(events.data, event_blobs.data)` with
        // the SAME guarded extract the runtime pass + the ARM scan use ⇒ the column
        // value is byte-identical regardless of which populated it. Idempotent: the
        // `mutation_path IS NULL` guard no-ops where the runtime pass already
        // completed before the v74 restart, and a malformed body folds to NULL (the
        // fold reads NULL either way — re-fold-deterministic).
        db.run(
          `UPDATE events
              SET mutation_path = (
                  CASE WHEN json_valid(
                           COALESCE(
                               events.data,
                               (SELECT data FROM event_blobs
                                 WHERE event_blobs.event_id = events.id)
                           )
                       )
                       THEN json_extract(
                           COALESCE(
                               events.data,
                               (SELECT data FROM event_blobs
                                 WHERE event_blobs.event_id = events.id)
                           ),
                           '$.tool_input.file_path'
                       )
                  END
              )
            WHERE hook_event = 'PostToolUse'
              AND tool_name IN ('Write', 'Edit', 'MultiEdit', 'NotebookEdit')
              AND mutation_path IS NULL`,
        );
      }
      // DROP UNCONDITIONALLY at the tail — the `approvals` precedent (v12→v13).
      // The v57 ladder step (`db.run(CREATE_EVENT_BLOBS)`) recreates the table on
      // EVERY boot (it must, for a fresh 0→latest walk through v57/v67), so a
      // version-guarded DROP would let it resurrect empty on a post-shed restart.
      // An unconditional `DROP TABLE IF EXISTS` here converges cleanly: a fresh
      // walk drops the freshly-created empty table, a v73→v74 upgrade drops the
      // restored-and-emptied real table, and a v74 restart drops the empty
      // resurrected table. This is the LAST event_blobs action of the migration,
      // AFTER the v67 read, so the historical ladder still runs against a live
      // table during a from-scratch walk.
      db.run("DROP TABLE IF EXISTS event_blobs");
      db.run("DROP INDEX IF EXISTS idx_event_blobs_tool_attr");
    },
  },
  {
    version: 75,
    kind: "backfill",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v74→v75 (fn-831 task .1): rewrite stored `source='planctl'`
      // `file_attributions` rows to `source='plan'`, matching what the
      // now-flipped planctl_op mint produces. This is the producer-flip
      // companion: minting and this row rewrite land in ONE commit so the
      // projection and a from-scratch re-fold agree — the fold mints `'plan'`
      // AND every pre-flip stored row is migrated to `'plan'`, so a re-fold is
      // byte-identical. In-transaction with the schema_version stamp below (the
      // `.immediate()` tx), so the rewrite + version bump are atomic. No cursor
      // rewind. Idempotent: a re-run finds no `'planctl'` rows. The CHECK already
      // permits `'plan'` (v71→v72). Whitelist-only Python read — keeper-py never
      // reads `file_attributions.source` — so this bump MUST add 75 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit, or
      // every keeper-py read fails host-wide; test/schema-version.test.ts
      // enforces this.
      if (preMigrateStoredVersion < 75) {
        db.run(
          "UPDATE file_attributions SET source = 'plan' WHERE source = 'planctl'",
        );
      }
    },
  },
  // v75→v76 (fn-846 task .1): the never-bound dispatch circuit breaker —
  // comment-only no-op. The `dispatch_never_bound` reducer projection (a
  // per-`(verb, id)` consecutive-`DispatchExpired`-without-bind counter the
  // widened `foldDispatchExpired` increments, minting a sticky
  // `dispatch_failures(reason='never-bound')` at K so the existing
  // `failedKeys` arm suppresses the redispatch loop a never-binding worker
  // would otherwise drive forever) is created above and populates from the
  // fold arms; the version stamp needs a slot. A reducer projection (in the
  // rewind-and-redrain DELETE list). NO cursor rewind: a from-scratch re-fold
  // replays the same `DispatchExpired` / bind / `DispatchCleared` stream and
  // re-derives byte-identical counter rows (empty on a pre-feature log).
  // Whitelist-only Python read (keeper-py never reads this table) — this bump
  // MUST add 76 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME
  // commit, or every keeper-py read fails host-wide; test/schema-version.test.ts
  // enforces this.
  { version: 76, kind: "noop", apply: () => {} },
  {
    version: 77,
    kind: "rewind",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v76→v77 (fn-856 task .1): ungate the plan-link classifier from the
      // `/plan:plan` time-window model. The classifier (`src/plan-classifier.ts`)
      // dropped the window machinery: every epic-MUTATING op now links as
      // `creator` ({create, scaffold} with an epic-shaped target) or `refiner`
      // (any other mutating op naming an epic), regardless of timing — only the
      // read-only (`subject_present=false`) gate survives. That repairs three
      // dropped populations (closers, pre-first-opener scaffolds, /plan:defer +
      // direct-CLI edits): on the live DB `epics.job_links` was empty for ~1013
      // of 1020 epics and `created_by_closer_of` (the `[slotted-after-closer]`
      // pill) had never fired once. Because the FOLD OUTPUT changed, this bump
      // REWINDS the cursor and wipes the canonical projection list so the
      // corrected derive repopulates everything from the event log. ONE
      // `BEGIN IMMEDIATE` (the enclosing `.immediate()` tx) carries the wipe +
      // re-fold trigger + version stamp atomically. The wipe list is the
      // canonical v41→v42 set (every reducer-owned projection; MUST NOT touch
      // `dead_letters` — not a reducer projection). Re-fold determinism holds:
      // the classifier sorts on the `(ts, event_id)` total order, so a migrated
      // DB and a from-scratch re-fold yield byte-identical rows. The two frozen
      // historical backfills (v13→v14, v19→v20) were updated to the windowless
      // signatures in this SAME commit — their recomputed output is overwritten
      // by this wipe + re-fold, so the migrated-vs-refold end state stays
      // byte-identical. Whitelist-only Python read (keeper-py reads `jobs` /
      // `epics` over the socket, not these projection internals) — this bump MUST
      // add 77 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME
      // commit; test/schema-version.test.ts enforces this.
      if (preMigrateStoredVersion < 77) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        // Class-aware wipe of the LIVE-ONLY git surface: resets the skip-floor +
        // sets seed_required so the surface repopulates (a bare DELETE would
        // strand it empty below the floor). See `rewindLiveProjection`.
        rewindLiveProjection(db);
        db.run("DELETE FROM subagent_invocations");
        db.run("DELETE FROM usage");
        db.run("DELETE FROM profiles");
        db.run("DELETE FROM dispatch_failures");
        db.run("DELETE FROM autopilot_state");
        db.run("DELETE FROM pending_dispatches");
        db.run("DELETE FROM dispatch_never_bound");
        db.run("DELETE FROM block_escalations");
        db.run("DELETE FROM handoffs");
        db.run("DELETE FROM armed_epics");
        db.run("DELETE FROM builds");
      }
    },
  },
  {
    version: 78,
    kind: "backfill",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v77→v78 (fn-864 task .1): rename every `planctl_*` schema surface →
      // `plan_*` and rewrite the historical `events.data` `planctl_invocation`
      // envelopes → `plan_invocation`, in ONE atomic `.immediate()` tx. This is a
      // VALUE-PRESERVING rename (the fn-831 pattern) — NO cursor rewind: the
      // column rename keeps every row, `ALTER RENAME COLUMN` is metadata-only and
      // auto-rewrites the partial-index predicates, and the envelope rewrite swaps
      // ONE JSON key while preserving surrounding bytes, so a from-scratch re-fold
      // over the rewritten corpus reproduces byte-identical projection rows. The
      // CREATE-TABLE literals + the frozen `addColumnIfMissing("planctl_*")` ladder
      // steps stay spelled `planctl_*` (schema history, Decision A) but are now
      // version-guarded so a post-v78 reboot never resurrects a zombie `planctl_*`
      // column; this v78 step is the sole forward rename. Whitelist-only Python
      // read (keeper-py reads `jobs`/`epics` over the socket, not these projection
      // internals) — this bump MUST add 78 to `SUPPORTED_SCHEMA_VERSIONS` in
      // `keeper/api.py` in the SAME commit; test/schema-version.test.ts enforces.
      if (preMigrateStoredVersion < 78) {
        // 1. Column renames. `renameColumnIfPresent` is quad-state idempotent: it
        // runs the ALTER on old-present/new-absent (fresh-DB-walk + v77-upgrade)
        // and no-ops every other combination. The rename auto-rewrites each
        // partial index's stored WHERE predicate to the new column name.
        for (const [oldName, newName] of [
          ["planctl_op", "plan_op"],
          ["planctl_target", "plan_target"],
          ["planctl_epic_id", "plan_epic_id"],
          ["planctl_task_id", "plan_task_id"],
          ["planctl_subject_present", "plan_subject_present"],
          ["planctl_queue_jump", "plan_queue_jump"],
          ["planctl_files", "plan_files"],
        ] as const) {
          renameColumnIfPresent(db, "events", oldName, newName);
        }
        for (const [oldName, newName] of [
          ["planctl_op", "plan_op"],
          ["planctl_target", "plan_target"],
          ["planctl_epic_id", "plan_epic_id"],
        ] as const) {
          renameColumnIfPresent(db, "commit_trailer_facts", oldName, newName);
        }

        // 2. Index-identifier renames for the THREE `events` partial indexes. The
        // column rename above already rewrote their predicates; this DROP/CREATE
        // only renames the index IDENTIFIER. Safe because their frozen creates are
        // now version-guarded (never re-run on a post-v78 reboot with the dropped
        // old name + a stale `planctl_*` column ref). The `idx_commit_trailer_facts_epic`
        // identifier is DELIBERATELY left unrenamed — its create is unconditional
        // (in two always-run blocks), so a DROP/rename would make the next boot's
        // `CREATE IF NOT EXISTS idx_commit_trailer_facts_epic` re-evaluate a stale
        // `planctl_epic_id` ref and throw. The column rename auto-rewrites its
        // predicate to `plan_epic_id`, which is the schema surface that matters.
        db.run("DROP INDEX IF EXISTS idx_events_planctl_session");
        db.run(
          "CREATE INDEX IF NOT EXISTS idx_events_plan_session ON events (session_id, id) WHERE plan_op IS NOT NULL",
        );
        db.run("DROP INDEX IF EXISTS idx_events_planctl_epic");
        db.run(
          "CREATE INDEX IF NOT EXISTS idx_events_plan_epic ON events(plan_epic_id, session_id, id) WHERE plan_op IS NOT NULL",
        );
        db.run("DROP INDEX IF EXISTS idx_events_planctl_target");
        db.run(
          "CREATE INDEX IF NOT EXISTS idx_events_plan_target ON events(plan_target, session_id, id) WHERE plan_op IS NOT NULL",
        );

        // 3. Rewrite the historical `events.data` `planctl_invocation` envelopes →
        // `plan_invocation`. The envelope sits inside `tool_response.stdout` (itself
        // a JSON *string*), so this is an app-level parse / swap-key / re-embed —
        // NOT `json_set` (which can't reach into a JSON string) and NOT
        // `serializePlanJson` (which re-sorts keys and would break stdout byte
        // fidelity + the re-fold byte-identity gate). Per-row try/catch: a
        // malformed / oversized body is skipped, never thrown (a throw rolls back
        // the whole v78 tx). Idempotent — a re-run finds no `planctl_invocation`.
        const legacyRows = db
          .prepare(
            `SELECT id, data FROM events
              WHERE data LIKE '%planctl_invocation%'`,
          )
          .all() as { id: number; data: string | null }[];
        const rewriteStmt = db.prepare(
          "UPDATE events SET data = ? WHERE id = ?",
        );
        for (const row of legacyRows) {
          if (row.data == null) continue;
          try {
            const outer = JSON.parse(row.data) as Record<string, unknown>;
            if (typeof outer !== "object" || outer === null) continue;
            const toolResponse = outer.tool_response;
            // Two shapes carry the envelope: the canonical
            // `tool_response.stdout` JSON string (the hook's PostToolUse:Bash
            // shape), and a top-level inlined `planctl_invocation` (synthetic /
            // test rows). Touch ONLY the envelope key — never `tool_input.command`.
            let mutated = false;
            if (typeof toolResponse === "object" && toolResponse !== null) {
              const tr = toolResponse as Record<string, unknown>;
              const stdout = tr.stdout;
              if (typeof stdout === "string" && stdout.length > 0) {
                const inner = JSON.parse(stdout) as Record<string, unknown>;
                if (
                  typeof inner === "object" &&
                  inner !== null &&
                  Object.hasOwn(inner, "planctl_invocation")
                ) {
                  inner.plan_invocation = inner.planctl_invocation;
                  delete inner.planctl_invocation;
                  tr.stdout = JSON.stringify(inner);
                  mutated = true;
                }
              }
            }
            if (Object.hasOwn(outer, "planctl_invocation")) {
              outer.plan_invocation = outer.planctl_invocation;
              delete outer.planctl_invocation;
              mutated = true;
            }
            if (mutated) {
              rewriteStmt.run(JSON.stringify(outer), row.id);
            }
          } catch {
            // Malformed body — leave it; the deriver folds it to NULL anyway.
          }
        }

        // 4. Hard assertion: no event the DERIVER reads as an envelope may still
        // carry the legacy `planctl_invocation` key after the rewrite, or the
        // dropped `?? planctl_invocation` coalesce would silently NULL that event's
        // plan link. The check is SCOPED to the deriver's two envelope read
        // locations — the top-level inlined envelope and the `tool_response.stdout`
        // JSON-string envelope — NOT a raw `data` substring: `planctl_invocation`
        // legitimately survives as incidental TEXT in Bash command lines, file-read
        // bodies, git snapshots, and prompts, none of which the deriver reads as an
        // envelope. A residual > 0 is a real missed envelope shape — throw loud and
        // roll the whole v78 tx back to v77 (boot retries). Malformed/oversized
        // stdout is excluded by the json_valid guard: the deriver can't read it
        // either, so it carries no live plan link.
        const residual = (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM events
                WHERE json_valid(data)
                  AND (
                    json_type(data, '$.planctl_invocation') IS NOT NULL
                    OR (
                      json_valid(json_extract(data, '$.tool_response.stdout'))
                      AND json_type(
                            json_extract(data, '$.tool_response.stdout'),
                            '$.planctl_invocation'
                          ) IS NOT NULL
                    )
                  )`,
            )
            .get() as { n: number }
        ).n;
        if (residual > 0) {
          throw new Error(
            `v78 envelope rewrite incomplete: ${residual} events still carry a planctl_invocation envelope`,
          );
        }
      }
    },
  },
  {
    version: 79,
    kind: "backfill",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v78→v79 (fn-868 task .1): make the git surface a LIVE-ONLY projection.
      // The `git_projection_state` control singleton is created+seeded
      // unconditionally above; this version-guarded step RAISES the skip-floor to
      // the current `max(events.id)` so the very next boot drain NO-OPS every
      // historical `GitSnapshot`/`Commit` git fold (`id <= floor`) instead of
      // replaying 4.3M events through `computeRepoBashWindows`'s ~6-day self-join.
      // The boot-seed producer then re-derives `git_status` + `file_attributions`
      // + the 3 jobs git-counters at full fidelity ABOVE the floor before serving.
      // `seed_required = 1` so the boot-seed fires even on a clean restart.
      //
      // Idempotent + fresh-walk-safe: `max(floor, coalesce(max(events.id), 0))`
      // never lowers the floor (re-run is a no-op) and a fresh 0→79 DB has no
      // events so `max(events.id)` is NULL → floor stays 0 (every git fold runs,
      // and the boot-seed runs anyway). NOT a cursor rewind: the global
      // `reducer_state.last_event_id` is untouched, so the other ~16
      // deterministic projections keep folding the full log byte-identically.
      // This is a PRODUCER/live-owned write — excluded from the re-fold charter.
      if (preMigrateStoredVersion < 79) {
        db.run(
          `UPDATE git_projection_state
              SET floor = max(floor, (SELECT COALESCE(MAX(id), 0) FROM events)),
                  seed_required = 1,
                  updated_at = unixepoch('now', 'subsec')
            WHERE id = 1`,
        );
      }
    },
  },
  {
    version: 80,
    kind: "rewind",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v79→v80 (fn-881 task .1): exclude the worker's `done` op and the
      // closer's `close` op from the plan-link classifier. The classifier
      // (`src/plan-classifier.ts` `classifyEntry`) now returns null for
      // `op === "done"` / `op === "close"` BEFORE the refiner fall-through, so
      // `refiner` means only genuine plan-shaping edits — no longer every
      // autopiloted `/plan:work` worker (`done`) + `/plan:close` closer
      // (`close`). Because the FOLD OUTPUT changed, this MIRRORS the v77 ungate
      // block (`src/db.ts`): inside the enclosing `.immediate()` tx, rewind the
      // cursor + wipe the canonical projection list so the corrected derive
      // repopulates `jobs.epic_links` / `epics.job_links` from the event log.
      // The full re-fold runs via the normal post-migrate boot drain — NOT
      // inline here (avoids holding the writer lock across a full-log replay).
      //
      // DEVIATION FROM v77, deliberate: v77 PREDATES the v79 git skip-floor, so
      // it reset the floor to 0 via `rewindLiveProjection`. Doing that here
      // would re-arm the O(history) `computeRepoBashWindows` time-bomb v79
      // fixed — the cursor-0 re-fold drain would replay every historical
      // `GitSnapshot` through the self-join. Instead, wipe the LIVE-ONLY git
      // surface AND RAISE the floor to `max(events.id)` (the v79 shape), so the
      // re-fold drain no-ops every historical git fold and the boot-seed
      // (`seed_required = 1`) re-derives the surface above the floor. The git
      // surface is charter-excluded; only the deterministic link projections
      // re-fold byte-identically.
      //
      // `commit_trailer_facts` is DELIBERATELY NOT wiped — it matches v77's
      // proven behavior. It is a DERIVE INPUT (the fn-695 commit channel), keyed
      // by the `event_id` PK with an `INSERT OR IGNORE` fold (`foldCommit`), so
      // the cursor-0 re-fold rebuilds it byte-identically from id 0 without a
      // wipe. `dead_letters` is not a reducer projection (never wiped).
      // Whitelist-only Python read (keeper-py reads `jobs` / `epics` over the
      // socket, not these projection internals) — this bump MUST add 80 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces this.
      if (preMigrateStoredVersion < 80) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        // LIVE-ONLY git surface: wipe the tables + zero the embedded jobs
        // git-counters, then RAISE the floor to `max(events.id)` (NOT the
        // floor-0 reset `rewindLiveProjection` does) so the cursor-0 re-fold
        // drain skips the historical git folds. `seed_required = 1` → the
        // boot-seed re-derives the surface above the floor before serving.
        for (const table of LIVE_ONLY_PROJECTIONS) {
          db.run(`DELETE FROM ${table}`);
        }
        db.run(
          `UPDATE jobs SET git_dirty_count = 0, git_unattributed_to_live_count = 0, git_orphan_count = 0`,
        );
        db.run(
          `UPDATE git_projection_state
              SET floor = max(floor, (SELECT COALESCE(MAX(id), 0) FROM events)),
                  seed_required = 1,
                  updated_at = unixepoch('now', 'subsec')
            WHERE id = 1`,
        );
        db.run("DELETE FROM subagent_invocations");
        db.run("DELETE FROM usage");
        db.run("DELETE FROM profiles");
        db.run("DELETE FROM dispatch_failures");
        db.run("DELETE FROM autopilot_state");
        db.run("DELETE FROM pending_dispatches");
        db.run("DELETE FROM dispatch_never_bound");
        db.run("DELETE FROM block_escalations");
        db.run("DELETE FROM handoffs");
        db.run("DELETE FROM armed_epics");
        db.run("DELETE FROM builds");
      }
    },
  },
  {
    version: 81,
    kind: "rewind",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v80→v81 (fn-888 task .2): converge `epics.job_links` under the new
      // CHEAP `syncPlanLinks` fold (task .1). The fold changed from an O(touched_epics
      // × swept_sessions) per-epic full session-sweep into an idempotent per-SESSION
      // replace-by-key merge (`mergeJobLinkSlice`) whose per-event cost is independent
      // of sessions-per-epic AND board size. The new logic is byte-identical to the old
      // PER EVENT, so no live storm — but a rewind-and-redrain is still warranted, for
      // two reasons (NOT "just in case"): it CONVERGES every
      // historical `epics.job_links` cell under the new code path, and it is
      // SELF-VALIDATING — the cursor-0 re-fold that previously took ~15 min (3–4 GB WAL,
      // socket down) now completes in ~1–2 min under the constant-bounded fold, proving
      // the O(board)-per-event time-bomb is disarmed.
      //
      // Modeled EXACTLY on the v80 step above (the v77 rewind/wipe shape with the v79
      // git-floor RAISE, not a floor-0 reset). The full re-fold runs via the normal
      // post-migrate boot drain — NOT inline here (avoids holding the writer lock
      // across a full-log replay).
      //
      // `commit_trailer_facts` is DELIBERATELY NOT wiped — it is a DERIVE INPUT (the
      // fn-695 commit channel), keyed by the `event_id` PK with an `INSERT OR IGNORE`
      // fold (`foldCommit`), so the cursor-0 re-fold rebuilds it byte-identically from
      // id 0 without a wipe. Wiping it would drop the commit-channel edges the new
      // merge reads. The LIVE-ONLY git surface is wiped + its floor RAISED to
      // `max(events.id)` (NOT reset to 0 — that re-arms the O(history)
      // `computeRepoBashWindows` time-bomb v79 fixed), `seed_required = 1` so the
      // boot-seed re-derives it above the floor. The ephemeral / autopilot tables are
      // replicated from v80's list so the cursor-0 re-fold cannot resurrect a phantom
      // `pending_dispatches` dispatch jam (test/refold-equivalence.test.ts guards it).
      //
      // Whitelist-only Python read (keeper-py reads `jobs` / `epics` over the socket,
      // not these projection internals) — this bump MUST add 81 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces this.
      if (preMigrateStoredVersion < 81) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        // LIVE-ONLY git surface: wipe the tables + zero the embedded jobs
        // git-counters, then RAISE the floor to `max(events.id)` (NOT the
        // floor-0 reset `rewindLiveProjection` does) so the cursor-0 re-fold
        // drain skips the historical git folds. `seed_required = 1` → the
        // boot-seed re-derives the surface above the floor before serving.
        for (const table of LIVE_ONLY_PROJECTIONS) {
          db.run(`DELETE FROM ${table}`);
        }
        db.run(
          `UPDATE jobs SET git_dirty_count = 0, git_unattributed_to_live_count = 0, git_orphan_count = 0`,
        );
        db.run(
          `UPDATE git_projection_state
              SET floor = max(floor, (SELECT COALESCE(MAX(id), 0) FROM events)),
                  seed_required = 1,
                  updated_at = unixepoch('now', 'subsec')
            WHERE id = 1`,
        );
        db.run("DELETE FROM subagent_invocations");
        db.run("DELETE FROM usage");
        db.run("DELETE FROM profiles");
        db.run("DELETE FROM dispatch_failures");
        db.run("DELETE FROM autopilot_state");
        db.run("DELETE FROM pending_dispatches");
        db.run("DELETE FROM dispatch_never_bound");
        db.run("DELETE FROM block_escalations");
        db.run("DELETE FROM handoffs");
        db.run("DELETE FROM armed_epics");
        db.run("DELETE FROM builds");
      }
    },
  },
  {
    version: 82,
    kind: "drop",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v81→v82 (fn-889 task .3): retire the last live `planctl` residue in the
      // event stream + schema — the synthetic `Commit`-event `events.data` keys
      // `planctl_op` / `planctl_target` and the `file_attributions.source` badge
      // CHECK's `'planctl'` member. Two version-guarded steps, both
      // VALUE-PRESERVING (NO cursor rewind):
      //
      // 1. Rewrite the historical `Commit` records' top-level `events.data`
      //    `planctl_op` / `planctl_target` keys → `plan_op` / `plan_target`
      //    (mirrors the v78 envelope rewrite at the top of this block). The
      //    daemon already emits the new keys (the `CommitMessage` field rename)
      //    and `extractCommit` already reads ONLY `obj.plan_op` / `obj.plan_target`
      //    single-path, so this rewrite is the migration that makes the historical
      //    corpus match the flipped producer/reader. The deriver lifts the SAME
      //    plan op/target value from the new key as it did from the old, so
      //    `commit_trailer_facts` (deterministic-replayed) re-folds byte-identical
      //    — no rewind. App-level parse / swap-key / re-embed (NOT `json_set`, to
      //    preserve surrounding byte order); per-row try/catch (a malformed body
      //    is skipped, never thrown — a throw rolls back the whole tx).
      //    Idempotent: a re-run finds no top-level `planctl_op`. SCOPED to
      //    `hook_event = 'Commit'` so incidental `planctl_op` TEXT in Bash command
      //    lines / file bodies is never touched. The frozen git-log trailer scrape
      //    (`src/git-worker.ts` `%(trailers:key=Planctl-Op...)`) reads immutable
      //    git history and is UNCHANGED.
      // 2. Narrow the `file_attributions.source` CHECK to drop `'planctl'` via a
      //    table rebuild (mirrors the v72 rebuild). 0 live `'planctl'` rows (the
      //    fold mints `'plan'` post-fn-831; no fold path can mint `'planctl'` under
      //    the narrowed CHECK), so the byte-faithful copy can't violate it.
      //
      // Whitelist-only Python read (keeper-py reads `jobs` / `epics` over the
      // socket, not these projection internals) — this bump MUST add 82 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces this.
      if (preMigrateStoredVersion < 82) {
        // Step 1 — rewrite the historical Commit-event data keys.
        const commitRows = db
          .prepare(
            `SELECT id, data FROM events
              WHERE hook_event = 'Commit'
                AND data LIKE '%planctl_op%'`,
          )
          .all() as { id: number; data: string | null }[];
        const commitRewriteStmt = db.prepare(
          "UPDATE events SET data = ? WHERE id = ?",
        );
        for (const row of commitRows) {
          if (row.data == null) continue;
          try {
            const obj = JSON.parse(row.data) as Record<string, unknown>;
            if (typeof obj !== "object" || obj === null) continue;
            let mutated = false;
            if (Object.hasOwn(obj, "planctl_op")) {
              obj.plan_op = obj.planctl_op;
              delete obj.planctl_op;
              mutated = true;
            }
            if (Object.hasOwn(obj, "planctl_target")) {
              obj.plan_target = obj.planctl_target;
              delete obj.planctl_target;
              mutated = true;
            }
            if (mutated) {
              commitRewriteStmt.run(JSON.stringify(obj), row.id);
            }
          } catch {
            // Malformed body — leave it; `extractCommit` folds it to null anyway.
          }
        }
        // Hard assertion: no `Commit` event the DERIVER reads may still carry the
        // legacy top-level `plan` keys' old spelling after the rewrite, or the
        // single-path `obj.plan_op` read would silently NULL that commit's plan
        // link. SCOPED to the deriver's read location (`json_extract($.planctl_op)`
        // on a valid-JSON Commit body) — NOT a raw `data` substring, which would
        // false-positive on incidental command-line / file-body text. A residual
        // > 0 is a real missed shape: throw and roll the whole v82 tx back to v81.
        const commitResidual = (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM events
                WHERE hook_event = 'Commit'
                  AND json_valid(data)
                  AND (
                    json_type(data, '$.planctl_op') IS NOT NULL
                    OR json_type(data, '$.planctl_target') IS NOT NULL
                  )`,
            )
            .get() as { n: number }
        ).n;
        if (commitResidual > 0) {
          throw new Error(
            `v82 Commit-event key rewrite incomplete: ${commitResidual} Commit events still carry a planctl_op/planctl_target data key`,
          );
        }

        // Step 2 — narrow the `file_attributions.source` CHECK (drop 'planctl').
        // Table rebuild (the only way to change a CHECK in SQLite). Drop any
        // leftover temp from an interrupted prior attempt.
        db.run("DROP TABLE IF EXISTS file_attributions_v82_tmp");
        db.run(`
        CREATE TABLE file_attributions_v82_tmp (
            project_dir TEXT NOT NULL,
            session_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            last_mutation_at REAL NOT NULL,
            last_commit_at REAL,
            op TEXT NOT NULL,
            source TEXT NOT NULL CHECK(source IN ('tool','bash','inferred','plan')),
            last_event_id INTEGER,
            updated_at REAL NOT NULL DEFAULT 0,
            worktree_oid TEXT,
            worktree_mode TEXT,
            PRIMARY KEY (project_dir, session_id, file_path)
        )
      `);
        // Byte-faithful copy, ORDER BY rowid for stable physical order. 0 live
        // 'planctl' rows, so the narrowed CHECK can't reject a copied row.
        db.run(`
        INSERT INTO file_attributions_v82_tmp
            (project_dir, session_id, file_path, last_mutation_at,
             last_commit_at, op, source, last_event_id, updated_at,
             worktree_oid, worktree_mode)
          SELECT project_dir, session_id, file_path, last_mutation_at,
                 last_commit_at, op, source, last_event_id, updated_at,
                 worktree_oid, worktree_mode
            FROM file_attributions
        ORDER BY rowid
      `);
        db.run("DROP TABLE file_attributions");
        db.run(
          "ALTER TABLE file_attributions_v82_tmp RENAME TO file_attributions",
        );
        // Re-create the indexes (SQLite drops them with their base table).
        for (const sql of CREATE_FILE_ATTRIBUTIONS_INDEXES) {
          db.run(sql);
        }
      }
    },
  },
  {
    version: 83,
    kind: "backfill",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v82→v83 (fn-907 task .1): the schema foundation for tracking a worker
      // pane's LIVE tmux location (session NAME + window index) after an
      // out-of-band `break-pane`/`move-window`. The two location columns flip
      // from deterministic-replayed to LIVE-ONLY (boot-seeded + skip-floored like
      // the git surface), and the FROZEN launch env is demoted to a forensic
      // `backend_exec_birth_session_id`. No producer/fold logic here — just the
      // columns, the `tmux_projection_state` control table, and the one-time
      // birth-session backfill the later tasks build on.
      //
      // Whitelist-only Python read (keeper-py reads `jobs` / `epics` over the
      // socket, not these projection internals) — this bump MUST add 83 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces this.
      //
      // NO cursor rewind-and-redrain: the two columns become live-only
      // (boot-seeded, not replayed), so history is never re-folded for them — the
      // backfill below + the boot-seed cover the existing rows. This deliberately
      // avoids re-arming the `computeRepoBashWindows` O(history) re-fold time-bomb.
      //
      // The two column adds are idempotent (`addColumnIfMissing`), so they run
      // unconditionally; `CREATE_TMUX_PROJECTION_STATE` is `IF NOT EXISTS` and
      // also runs unconditionally so an upgraded DB gets the table even though the
      // fresh-schema block above only fires on a cold first boot. The seed +
      // backfill are NON-idempotent (the backfill would re-clobber a later live
      // value), so they are VERSION-GUARDED to fire once per upgrade.
      addColumnIfMissing(db, "jobs", "backend_exec_generation_id", "TEXT");
      addColumnIfMissing(db, "jobs", "backend_exec_birth_session_id", "TEXT");
      db.run(CREATE_TMUX_PROJECTION_STATE);
      if (preMigrateStoredVersion < 83) {
        // Seed the control singleton with `seed_required = 1` so the boot-seed
        // re-derives the live location surface on the very next boot. `floor`
        // stays 0 here — the boot-seed raises it to current `max(events.id)` once
        // it runs (mirrors the v79 git floor-init's deferral to the boot-seed).
        db.run(
          "INSERT OR IGNORE INTO tmux_projection_state (id, floor, seed_required, updated_at) VALUES (1, 0, 1, unixepoch('now', 'subsec'))",
        );
        db.run(
          `UPDATE tmux_projection_state
              SET seed_required = 1, updated_at = unixepoch('now', 'subsec')
            WHERE id = 1`,
        );
        // One-time backfill: the FROZEN `backend_exec_session_id` IS the launch
        // (birth) session env for every pre-v83 row — copy it into the forensic
        // birth column so consumers can fall back to it once the live session
        // becomes the authoritative (and possibly-relocated) value. Scoped to
        // rows whose birth column is still NULL so a re-run is a no-op.
        db.run(
          `UPDATE jobs
              SET backend_exec_birth_session_id = backend_exec_session_id
            WHERE backend_exec_birth_session_id IS NULL`,
        );
      }
    },
  },
  // v83→v84 (fn-924 task .1): carry the existing `jobs.active_since` fact on
  // the embedded `epics.jobs` / `epics.tasks[].jobs[]` element. NO new column
  // — like the v58→v59 `has_live_worker_monitor` add, it rides FREE inside
  // the JSON cell, fix-forward (no rewind), with a safe absent ≡ `null`
  // default. `buildEmbeddedJob` lifts it fresh on every job-tick re-sync, so
  // live rows heal forward without a re-fold. Readiness reads it to keep a
  // freshly-bound `stopped` worker holding its root across the bind →
  // first-activity handoff (`bound-pending`) without over-holding a
  // stopped-after-working one.
  //
  // Whitelist-only Python read — this bump MUST add 84 to
  // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
  // test/schema-version.test.ts enforces this.
  { version: 84, kind: "noop", apply: () => {} },
  {
    version: 85,
    kind: "rewind",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v84→v85 (fn-936 task .1): strip all static priority/ordering machinery
      // from the plan fold + state. DROP the `epics.sort_path` / `queue_jump` /
      // `created_by_closer_of` columns + the `events.plan_queue_jump` column;
      // the backend now returns epics in plain `epic_number ASC` creation order
      // (a neutral seed clients order through `orderEpicsForScheduling`). The
      // orderless `epics` fold re-folds byte-identically minus the dropped
      // columns, so this does the FULL v81-style cursor-0 rewind-and-redrain to
      // CONVERGE every historical `epics` row under the new code (and to
      // self-validate the orderless fold's determinism).
      //
      // Whitelist-only Python read (keeper-py reads `jobs` / `epics` over the
      // socket, not these projection internals) — this bump MUST add 85 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces this.
      if (preMigrateStoredVersion < 85) {
        // 1. `epics` column drop via the v82-style table rebuild (the only way to
        // drop the 3 cols AND re-declare the `default_visible` VIRTUAL generated
        // column with its new `(default_visible, epic_number, epic_id)` index
        // shape). DROP both epics indexes first (SQLite drops them with the base
        // table anyway, but the explicit DROP keeps the rebuild self-contained
        // and clears the now-stale `idx_epics_sort_path`).
        db.run("DROP INDEX IF EXISTS idx_epics_sort_path");
        db.run("DROP INDEX IF EXISTS idx_epics_default_visible");
        db.run("DROP TABLE IF EXISTS epics_v85_tmp");
        db.run(`
        CREATE TABLE epics_v85_tmp (
            epic_id TEXT PRIMARY KEY,
            epic_number INTEGER,
            title TEXT,
            project_dir TEXT,
            status TEXT,
            last_event_id INTEGER,
            updated_at REAL NOT NULL DEFAULT 0,
            tasks TEXT NOT NULL DEFAULT '[]',
            depends_on_epics TEXT NOT NULL DEFAULT '[]',
            jobs TEXT NOT NULL DEFAULT '[]',
            job_links TEXT NOT NULL DEFAULT '[]',
            last_validated_at TEXT,
            resolved_epic_deps TEXT,
            default_visible INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status IS NOT NULL AND status='open' THEN 1 ELSE 0 END) VIRTUAL
        )
      `);
        // Copy the KEPT columns ORDER BY rowid for stable physical order. The
        // VIRTUAL `default_visible` is omitted (it can't be inserted into; it
        // recomputes from `status`). The cursor-0 re-fold below rebuilds every
        // row regardless, but the faithful copy keeps the table non-empty across
        // the rebuild for any concurrent boot read.
        db.run(`
        INSERT INTO epics_v85_tmp
            (epic_id, epic_number, title, project_dir, status, last_event_id,
             updated_at, tasks, depends_on_epics, jobs, job_links,
             last_validated_at, resolved_epic_deps)
          SELECT epic_id, epic_number, title, project_dir, status, last_event_id,
                 updated_at, tasks, depends_on_epics, jobs, job_links,
                 last_validated_at, resolved_epic_deps
            FROM epics
        ORDER BY rowid
      `);
        db.run("DROP TABLE epics");
        db.run("ALTER TABLE epics_v85_tmp RENAME TO epics");
        // Recreate the kept epics index(es) with the new `sort_path`-free shape
        // (SQLite drops indexes with their base table).
        for (const sql of CREATE_EPICS_INDEXES) {
          db.run(sql);
        }

        // 2. Drop `events.plan_queue_jump`. No index references it (it was a
        // plain INTEGER column), so a direct DROP COLUMN suffices — heavier than
        // the epics drop (the events table is large) but in-place. Idempotent: a
        // fresh DB never created the column, so `dropColumnIfPresent` no-ops.
        dropColumnIfPresent(db, "events", "plan_queue_jump");

        // 3. FULL v81-style rewind-and-redrain. Rewind the cursor to 0 and wipe
        // every DETERMINISTIC-replayed projection so the boot drain re-folds them
        // from id 0 under the orderless `epics` fold. `commit_trailer_facts` is
        // DELIBERATELY NOT wiped (a derive input, keyed by `event_id` PK with an
        // `INSERT OR IGNORE` fold — it re-folds byte-identically from id 0
        // without a wipe). The LIVE-ONLY git surface is wiped + its floor RAISED
        // to `max(events.id)` (NOT reset to 0 — that re-arms the
        // `computeRepoBashWindows` O(history) re-fold time-bomb v79 fixed),
        // `seed_required = 1` so the boot-seed re-derives it above the floor. The
        // ephemeral / autopilot tables are wiped so the cursor-0 re-fold can't
        // resurrect a phantom `pending_dispatches` dispatch jam. Modeled EXACTLY
        // on the v80/v81 steps above. The re-fold runs via the normal
        // post-migrate boot drain, NOT inline here (avoids holding the writer
        // lock across a full-log replay).
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        for (const table of LIVE_ONLY_PROJECTIONS) {
          db.run(`DELETE FROM ${table}`);
        }
        db.run(
          `UPDATE jobs SET git_dirty_count = 0, git_unattributed_to_live_count = 0, git_orphan_count = 0`,
        );
        db.run(
          `UPDATE git_projection_state
              SET floor = max(floor, (SELECT COALESCE(MAX(id), 0) FROM events)),
                  seed_required = 1,
                  updated_at = unixepoch('now', 'subsec')
            WHERE id = 1`,
        );
        db.run("DELETE FROM subagent_invocations");
        db.run("DELETE FROM usage");
        db.run("DELETE FROM profiles");
        db.run("DELETE FROM dispatch_failures");
        db.run("DELETE FROM autopilot_state");
        db.run("DELETE FROM pending_dispatches");
        db.run("DELETE FROM dispatch_never_bound");
        db.run("DELETE FROM block_escalations");
        db.run("DELETE FROM handoffs");
        db.run("DELETE FROM armed_epics");
        db.run("DELETE FROM builds");
      }
    },
  },
  // v85→v86 (fn-941 task .2): the daemon block-escalation latch —
  // comment-only no-op. The `block_escalations` reducer projection (the
  // escalate-once latch the `TaskSnapshot` fold sets on the transition into
  // `runtime_status='blocked'` and deletes on the transition out, advanced
  // pending→requested→attempted by the producer's `BlockEscalationRequested`
  // / `BlockEscalationAttempted` events) is created above and populates from
  // the fold arms; the version stamp needs a slot. A reducer projection (in
  // the rewind-and-redrain DELETE list). NO cursor rewind: a from-scratch
  // re-fold replays the same `TaskSnapshot` / `BlockEscalation*` stream and
  // re-derives byte-identical latch rows (empty on a pre-feature log; a task
  // blocked across the upgrade re-arms on its next blocked transition, the
  // `dispatch_never_bound` pre-feature-empty tolerance). Whitelist-only Python
  // read (keeper-py never reads this table) — this bump MUST add 86 to
  // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit, or every
  // keeper-py read fails host-wide; test/schema-version.test.ts enforces this.
  { version: 86, kind: "noop", apply: () => {} },
  // v86→v87 (fn-946 task .1): the `keeper handoff` foundation — comment-only
  // no-op. The `handoffs` reducer projection (the durable `HandoffRequested`
  // → row + the dispatcher's transactional-outbox lifecycle, keyed on
  // `handoff_id`) is created above via `CREATE_HANDOFFS` in the steady-state
  // schema-setup block and populates from the fold arms (tasks .2/.3); the
  // version stamp needs a slot. A DETERMINISTIC-replayed reducer projection
  // (in every rewind-and-redrain DELETE list). NO cursor rewind: a
  // from-scratch re-fold replays the same `HandoffRequested` / dispatcher /
  // bind stream and re-derives byte-identical rows (empty on a pre-feature
  // log; the doc body rides inline in `events.data`, capped at WRITE time in
  // task .2). Whitelist-only Python read (keeper-py never reads this table) —
  // this bump MUST add 87 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py`
  // in the SAME commit, or every keeper-py read fails host-wide;
  // test/schema-version.test.ts enforces this.
  { version: 87, kind: "noop", apply: () => {} },
  {
    version: 88,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v87→v88 (fn-946 task .2): the `jobs.handoff_links` column — the per-job
      // home for the rendered handoff edge (sibling of `epic_links`). The
      // `HandoffRequested` fold writes the `handoff-from` `HandoffLinkEntry` onto
      // the initiator job here; the `SessionStart` bind fold (task .3) writes the
      // `handoff-to` entry onto the callee. APPEND-via-ALTER (NOT in the
      // `CREATE_JOBS` literal — mirrors `window_index`/v71): the ALTER appends it
      // LAST on BOTH the fresh and migrated paths, so the `PRAGMA table_info`
      // column-shape parity tests stay byte-identical. Default `'[]'` matches the
      // zero-event projection — a re-fold over a pre-feature log re-derives `'[]'`
      // for every job that never initiated/received a handoff, so re-fold stays
      // byte-identical. Whitelist-only Python read (keeper-py never reads this
      // column) — this bump MUST add 88 to `SUPPORTED_SCHEMA_VERSIONS` in
      // `keeper/api.py` in the SAME commit; test/schema-version.test.ts enforces.
      addColumnIfMissing(
        db,
        "jobs",
        "handoff_links",
        "TEXT NOT NULL DEFAULT '[]'",
      );
    },
  },
  // v88→v89 (fn-952 task .2): the `tmux_client_focus` LIVE-ONLY singleton —
  // the current real tmux client's focused session/window/pane, observed by
  // keeperd's persistent `tmux -C` control worker. Comment-only no-op: the
  // table is created above via `CREATE_TMUX_CLIENT_FOCUS` in the steady-state
  // schema-setup block (`IF NOT EXISTS`, so both fresh and migrated paths
  // converge) and folds from the `TmuxClientFocusSnapshot` arm (the producer
  // worker lands in task .3). NO seed row, NO floor, NO boot-seed — a pure
  // live-only singleton with no replay-worthy history; the worker is the sole
  // source of truth and re-bootstraps focus on every connect, so a cold DB
  // simply has no row. LIVE-ONLY (in `LIVE_ONLY_PROJECTIONS`): a rewinding
  // migration wipes it via `rewindLiveProjection`, never a bare DELETE, and it
  // is excluded from the byte-identical re-fold charter (an empty log re-folds
  // to an empty table). Whitelist-only Python read (keeper-py never reads this
  // table) — this bump MUST add 89 to `SUPPORTED_SCHEMA_VERSIONS` in
  // `keeper/api.py` in the SAME commit, or every keeper-py read fails
  // host-wide; test/schema-version.test.ts enforces this.
  { version: 89, kind: "noop", apply: () => {} },
  {
    version: 90,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v89→v90 (fn-954 task .1): add the nullable
      // `autopilot_state.max_concurrent_per_root` config column (DEFAULT NULL =
      // the in-memory `DEFAULT_MAX_CONCURRENT_PER_ROOT` = 1, byte-identical to
      // today's hardcoded one-task-per-root mutex). Runtime-settable via the
      // generic `set_autopilot_config` RPC → `AutopilotConfigSet` fold (NOT
      // config-file-frozen); each singleton fold preserves the columns it does
      // not own on conflict, so a pause/mode/cap patch never clobbers it.
      // FIX-FORWARD (no rewind): the fold never READS this column (it is resolved
      // at read time by the reconciler/board), so an addColumnIfMissing append is
      // re-fold-safe — a from-scratch re-fold re-derives byte-identical rows and
      // leaves the new column NULL (= DEFAULT). APPEND-via-ALTER keeps the
      // `PRAGMA table_info` column-shape parity tests stable. Whitelist-only
      // Python read (keeper-py never reads this column) — this bump MUST add 90
      // to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces this.
      addColumnIfMissing(
        db,
        "autopilot_state",
        "max_concurrent_per_root",
        "INTEGER",
      );
    },
  },
  {
    version: 91,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v90→v91 (fn-959 task .1): add the nullable `autopilot_state.worktree_mode`
      // config column (INTEGER: NULL/0 = OFF, 1 = ON; DEFAULT NULL = OFF, the
      // byte-identical no-worktree behavior). Runtime-settable via the generic
      // `set_autopilot_config` RPC → `AutopilotConfigSet` fold (NOT
      // config-file-frozen); each singleton fold preserves the columns it does not
      // own on conflict, so a pause/mode/cap/per-root patch never clobbers it.
      // FIX-FORWARD (no rewind): the fold never READS this column (the reconciler
      // resolves it `?? OFF` at read time), so an addColumnIfMissing append is
      // re-fold-safe — a from-scratch re-fold re-derives byte-identical rows and
      // leaves the new column NULL (= OFF). APPEND-via-ALTER keeps the
      // `PRAGMA table_info` column-shape parity tests stable. Whitelist-only Python
      // read (keeper-py never reads this column) — this bump MUST add 91 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces this.
      addColumnIfMissing(db, "autopilot_state", "worktree_mode", "INTEGER");
    },
  },
  {
    version: 92,
    kind: "backfill",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v91→v92 (fn-977 task .2): NULL `backend_exec_pane_id` +
      // `backend_exec_generation_id` on EXISTING terminal (ended/killed) jobs.
      // tmux recycles a pane id `%N`, so a long-dead job that keeps its stale
      // pane id could be mis-attributed as owning the fresh window that later
      // inherits it. The reducer's terminal fold arms now clear these coords
      // going forward; this one-time pass brings the ~113 already-terminal rows
      // (pane ids spanning %0-%519) in line so the recycle-guard (fn-977 task .1)
      // has no stale pane → job mapping to trip over.
      //
      // VERSION-GUARDED (`preMigrateStoredVersion < 92`): the clear is a data
      // fix, not a column add. It is also naturally idempotent (the WHERE matches
      // zero rows once cleared), but the guard avoids re-scanning `jobs` on every
      // boot. NO cursor rewind: `backend_exec_pane_id` is a deterministic-replayed
      // column whose post-change fold output for a terminal job is NULL, and
      // `backend_exec_generation_id` is live-only (boot-seeded for LIVE jobs only),
      // so a terminal row stays NULL on both axes without a re-fold — this pass
      // simply converges the existing rows the daemon will not re-fold.
      //
      // Whitelist-only Python read (keeper-py reads `jobs` / `epics` over the
      // socket, not these projection internals) — this bump MUST add 92 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces this.
      if (preMigrateStoredVersion < 92) {
        db.run(
          `UPDATE jobs
              SET backend_exec_pane_id = NULL,
                  backend_exec_generation_id = NULL
            WHERE state IN ('ended', 'killed')
              AND (backend_exec_pane_id IS NOT NULL
                   OR backend_exec_generation_id IS NOT NULL)`,
        );
      }
    },
  },
  {
    version: 93,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v92→v93: add the nullable codex-spark quota bucket columns to `usage`.
      // Codex `/status` can render a second GPT-5.3-Codex-Spark limit section
      // with its own 5h + weekly windows. The agentusage envelope carries them
      // as `usage.codex_spark_session` / `usage.codex_spark_week`, the worker
      // flattens them here, and `keeper usage` renders them as additional body
      // rows. APPEND-via-ALTER keeps existing rows NULL (zero-event shape) and
      // a fresh scrape re-emits one UsageSnapshot to populate the columns; no
      // cursor rewind is needed. Whitelist-only Python read (keeper-py does not
      // inspect these columns) — this bump MUST add 93 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit.
      addColumnIfMissing(db, "usage", "codex_spark_session_percent", "REAL");
      addColumnIfMissing(db, "usage", "codex_spark_session_resets_at", "TEXT");
      addColumnIfMissing(db, "usage", "codex_spark_week_percent", "REAL");
      addColumnIfMissing(db, "usage", "codex_spark_week_resets_at", "TEXT");
    },
  },
  {
    version: 94,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v93→v94 (fn-997.1): add the durable per-job worktree-lane BRANCH marker
      // to `events` (captured by the hook at SessionStart from
      // `KEEPER_PLAN_WORKTREE_BRANCH`) and its `jobs` projection (folded set-once
      // via COALESCE). Both nullable TEXT, NO default — a `DEFAULT ''` would
      // poison the NULL=absent invariant the COALESCE fold + pill rely on.
      // APPEND-via-ALTER keeps existing rows NULL (the zero-event shape) and is
      // re-fold-safe: a pre-v94 event has no worktree value, so a from-scratch
      // re-fold leaves `jobs.worktree` NULL byte-identically. NO cursor rewind —
      // do NOT add to the rewind-and-redrain DELETE list (mirrors the prior
      // usage-column add). Whitelist-only Python read (keeper-py never reads
      // these columns) — this bump MUST add 94 to `SUPPORTED_SCHEMA_VERSIONS` in
      // `keeper/api.py` in the SAME commit; test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "events", "worktree", "TEXT");
      addColumnIfMissing(db, "jobs", "worktree", "TEXT");
    },
  },
  {
    version: 95,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v94→v95 (fn-1000.1): add the nullable `usage.error_kind` classification
      // column. The usage-scraper worker now stamps a stable failure kind
      // (`format_changed` / `panel_missing` / `scrape_failed` /
      // `upstream_limited` / `runner_failed`) on a stale envelope's `error.kind`;
      // the consumer folds it onto this column so `keeper usage` can label WHAT
      // kind of failure is blocking freshness. APPEND-via-ALTER keeps existing
      // rows NULL (the zero-event shape) and is re-fold-safe: a pre-v95 event
      // carries no `error_kind`, so a from-scratch re-fold leaves the column NULL
      // byte-identically. NO cursor rewind — do NOT add to the rewind-and-redrain
      // DELETE list (mirrors the prior usage-column adds). Whitelist-only Python
      // read (keeper-py never reads `usage`) — this bump MUST add 95 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "usage", "error_kind", "TEXT");
    },
  },
  {
    version: 96,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v95→v96 (fn-1003.2): add the nullable `handoffs.target_dir` column — the
      // resolved ABSOLUTE directory a `keeper handoff --cwd <path>` launches the
      // handoff-ee in (default = the caller's cwd, resolved CLI-side). The
      // dispatcher reads it per-row as the launch cwd, coalescing NULL/empty to
      // keeperd's cwd. APPEND-via-ALTER keeps existing rows NULL (the zero-event
      // shape) and is re-fold-safe: a pre-v96 `HandoffRequested` event carries no
      // `target_dir`, so a from-scratch re-fold leaves the column NULL
      // byte-identically. NO cursor rewind — do NOT add to the rewind-and-redrain
      // DELETE list (mirrors the prior column adds). Whitelist-only Python read
      // (keeper-py never reads `handoffs`) — this bump MUST add 96 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "handoffs", "target_dir", "TEXT");
    },
  },
  {
    version: 97,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v96→v97 (fn-1007.1): add the nullable `usage.account_state` axis. The
      // usage-scraper worker now derives an orthogonal account-state reason
      // (`signed_out` / `no_subscription`) onto the envelope; the consumer folds
      // it onto this column so `keeper usage` can tell apart a logged-out profile
      // from a confirmed no-subscription one (both distinct from a scrape error).
      // APPEND-via-ALTER keeps existing rows NULL (the zero-event shape) and is
      // re-fold-safe: a pre-v97 event carries no `account_state`, so a
      // from-scratch re-fold leaves the column NULL byte-identically. NO cursor
      // rewind — do NOT add to the rewind-and-redrain DELETE list (mirrors the
      // prior usage-column adds). Whitelist-only Python read (keeper-py never
      // reads `usage`) — this bump MUST add 97 to `SUPPORTED_SCHEMA_VERSIONS` in
      // `keeper/api.py` in the SAME commit; test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "usage", "account_state", "TEXT");
    },
  },
  {
    version: 98,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v97→v98 (fn-1009.1): add the nullable `dispatch_failures.merge_escalated_at`
      // once-marker (REAL, epoch seconds). The daemon merge-escalation sweep stamps
      // it via a `MergeEscalationAttempted` synthetic event when it notifies
      // `planner@<epic>` of a sticky `worktree-merge-conflict` close failure, so the
      // notify fires exactly once; the sweep is read-only wrt the sticky row (only
      // `retry_dispatch` clears it). APPEND-via-ALTER keeps existing rows NULL (the
      // zero-event shape) and is re-fold-safe: a pre-v98 stream carries no
      // `MergeEscalationAttempted` event, so a from-scratch re-fold leaves the column
      // NULL byte-identically; `foldDispatchFailed` preserves it across the
      // `ON CONFLICT` UPSERT and `DispatchCleared` drops it with the row. NO cursor
      // rewind — do NOT add to the rewind-and-redrain DELETE list (mirrors the prior
      // column adds). Whitelist-only Python read (keeper-py never reads
      // `dispatch_failures`) — this bump MUST add 98 to `SUPPORTED_SCHEMA_VERSIONS` in
      // `keeper/api.py` in the SAME commit; test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "dispatch_failures", "merge_escalated_at", "REAL");
    },
  },
  // v98→v99: add the LIVE-ONLY `lane_merged` projection table — the
  // durable merge-landed observable. CREATEd idempotently in the always-run base
  // schema block above (`CREATE_LANE_MERGED`, `IF NOT EXISTS`), so an existing DB
  // gains the empty table on this boot and the live producer repopulates it; no
  // ALTER / backfill / cursor rewind (a LIVE-ONLY table is excluded from the
  // re-fold charter and rewound by `rewindLiveProjection`, never a bare DELETE).
  // This bump MUST add 99 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the
  // SAME commit (keeper-py never reads `lane_merged`, but the whitelist is a hard
  // membership set); test/schema-version.test.ts enforces it.
  { version: 99, kind: "noop", apply: () => {} },
  {
    version: 100,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v99→v100 (fn-1024.1): add the six nullable per-session telemetry columns
      // to `jobs` — the CURRENT model / reasoning effort / context-window usage
      // projected from the Claude Code statusLine payload (folded onto the row by
      // a later `SessionTelemetry` synthetic-event arm). All nullable, NO default:
      // a `DEFAULT` would poison the NULL=absent invariant the display render
      // reads and break re-fold byte-identity. APPEND-via-ALTER keeps existing
      // rows NULL (the zero-event shape) and is re-fold-safe: a pre-v100 stream
      // carries no `SessionTelemetry` event, so a from-scratch re-fold leaves the
      // columns NULL byte-identically. Kept OUT of the `CREATE_JOBS` literal (the
      // :834 rule) so fresh-vs-migrated `PRAGMA table_info(jobs)` stays
      // byte-identical. NO cursor rewind — do NOT add to the rewind-and-redrain
      // DELETE list (mirrors the prior display-column adds). Whitelist-only Python
      // read (keeper-py never reads these columns) — this bump MUST add 100 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "jobs", "current_model_id", "TEXT");
      addColumnIfMissing(db, "jobs", "current_model_display", "TEXT");
      addColumnIfMissing(db, "jobs", "current_effort", "TEXT");
      addColumnIfMissing(db, "jobs", "context_used_percentage", "REAL");
      addColumnIfMissing(db, "jobs", "context_input_tokens", "INTEGER");
      addColumnIfMissing(db, "jobs", "context_window_size", "INTEGER");
    },
  },
  {
    version: 101,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v100→v101 (fn-1034 task .1): add the nullable
      // `autopilot_state.worktree_multi_repo` rollout flag (INTEGER: NULL/0 = OFF,
      // 1 = ON; DEFAULT NULL = OFF, the byte-identical `>1`-toplevel reject).
      // Behind it, a worktree-mode epic whose tasks span more than one git
      // toplevel provisions per-repo lane groups instead of the whole-epic
      // `worktree-multi-repo` reject. Runtime-settable via the generic
      // `set_autopilot_config` RPC → `AutopilotConfigSet` fold (NOT
      // config-file-frozen); each singleton fold preserves the columns it does not
      // own on conflict, so a pause/mode/cap/per-root/worktree patch never clobbers
      // it. FIX-FORWARD (no rewind): the fold never READS this column (the
      // reconciler resolves it `?? OFF` at read time), so an addColumnIfMissing
      // append is re-fold-safe — a from-scratch re-fold re-derives byte-identical
      // rows and leaves the new column NULL (= OFF). APPEND-via-ALTER keeps the
      // `PRAGMA table_info` column-shape parity tests stable. Whitelist-only Python
      // read (keeper-py never reads this column) — this bump MUST add 101 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces this.
      addColumnIfMissing(
        db,
        "autopilot_state",
        "worktree_multi_repo",
        "INTEGER",
      );
    },
  },
  // v101→v102 (fn-1061 task .1): add the DURABLE producer-owned
  // `dispatch_mint_gate` table — the rate-limit gate that squashes N
  // same-instant `Dispatched` rows for one logical dispatch down to one durable
  // record. CREATEd idempotently in the always-run base schema block above
  // (`CREATE_DISPATCH_MINT_GATE`, `IF NOT EXISTS`), so an existing DB gains the
  // empty table on this boot and the mint site populates it; no ALTER /
  // backfill / cursor rewind. Producer state (same class as `dead_letters`), NOT
  // a reducer projection — so it is DELIBERATELY excluded from
  // `EPHEMERAL_PROJECTIONS`, from the rewinding-migration DELETE list, and from
  // the re-fold-equivalence charter. Whitelist-only Python read (keeper-py never
  // reads `dispatch_mint_gate`, but the whitelist is a hard membership set) —
  // this bump MUST add 102 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in
  // the SAME commit; test/schema-version.test.ts enforces it.
  { version: 102, kind: "noop", apply: () => {} },
  {
    version: 103,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v102→v103 (fn-1075 task .2): add the nullable `jobs.kill_reason` TEXT
      // column — WHY keeper reaped a job (which producer arm minted the synthetic
      // `Killed`), stamped by the two Killed producers (main's exit-watcher →
      // `exit_watched`; the boot seed sweep → `boot_unwatchable`/`boot_pid_dead`/
      // `boot_pid_recycled`) and folded on verbatim as an opaque string copy.
      // Orthogonal to `close_kind` (HOW the session died); this is WHY keeper
      // acted. Nullable, NO default: a `DEFAULT` would poison the NULL=absent
      // invariant and break re-fold byte-identity. APPEND-via-ALTER keeps existing
      // rows NULL (the zero-event shape) and is re-fold-safe: a historical Killed
      // payload carries no `reason`, so a from-scratch re-fold folds the column to
      // NULL byte-identically (deterministic-replayed, NOT live-only — do NOT add
      // to `LIVE_ONLY_JOBS_COLUMNS`, and NO cursor rewind). Kept OUT of the
      // `CREATE_JOBS` literal (the :852 rule) so fresh-vs-migrated
      // `PRAGMA table_info(jobs)` stays byte-identical. Whitelist-only Python read
      // (keeper-py never reads this column) — this bump MUST add 103 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "jobs", "kill_reason", "TEXT");
    },
  },
  {
    version: 104,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v103→v104 (fn-1083 task .2): add the nullable `epics.question` TEXT
      // column — the epic-level parked-closer question, the board-visible home
      // for a stuck closer's judgement call (`keeper plan epic-question`). Folded
      // from the `EpicSnapshot` synthetic event's `question` field, mirroring
      // `runtime_status` on tasks: the plan-worker caches the value observed in
      // the gitignored `<state>/epics/<epic_id>.state.json` overlay and re-emits
      // a full EpicSnapshot (def fields + cached question) on either a def or
      // overlay change. Nullable, NO default: NULL = no parked question (the
      // zero-event reading) and a `DEFAULT` would poison that invariant. A
      // historical EpicSnapshot payload carries no `question` key, so a
      // from-scratch re-fold folds the column to NULL byte-identically
      // (deterministic-replayed, NO cursor rewind needed — migration and re-fold
      // agree at NULL until a fresh post-upgrade EpicSnapshot lands). Declared in
      // the `CREATE_EPICS` literal too (unlike the jobs `:852` convention) —
      // placed AFTER the VIRTUAL `default_visible` column so `ALTER TABLE ADD
      // COLUMN` (which always appends) keeps fresh-vs-migrated
      // `PRAGMA table_info`/`table_xinfo(epics)` byte-identical (test/db.test.ts
      // parity asserts). The fixed epics SELECT list in `keeper/api.py` names only
      // `epic_id, project_dir, tasks, jobs`, so this bump MUST add 104 to
      // `SUPPORTED_SCHEMA_VERSIONS` there in the SAME commit;
      // test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "epics", "question", "TEXT");
    },
  },
  // v104→v105 (fn-1086 task .1): add the `dispatch_instant_death` reducer
  // projection table — the instant-death circuit breaker's per-`(verb, id)`
  // consecutive-instant-post-bind-death counter, the reducer-side sibling of
  // `dispatch_never_bound`. CREATEd idempotently in the always-run base schema
  // block above (`CREATE_DISPATCH_INSTANT_DEATH`, `IF NOT EXISTS`), so an
  // existing DB gains the empty table on this boot and the terminal folds
  // populate it forward — no ALTER / backfill / cursor rewind (a normal
  // upgrade folds forward from empty; only a from-scratch re-fold replays
  // historical deaths, which is the correct deterministic-replayed projection).
  // A DETERMINISTIC-REPLAYED projection (like `dispatch_never_bound`), so a
  // future rewinding migration wipes-and-refolds it; this bump adds no rewind.
  // Whitelist-only Python read (keeper-py never reads `dispatch_instant_death`)
  // — this bump MUST add 105 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py`
  // in the SAME commit; test/schema-version.test.ts enforces it.
  { version: 105, kind: "noop", apply: () => {} },
  {
    version: 106,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v105→v106 (fn-1088.1): add the nullable `dispatch_failures.resolver_dispatched_at`
      // once-marker (REAL, epoch seconds), the sibling of `merge_escalated_at`. The
      // daemon resolver-dispatch sweep stamps it via a `ResolverDispatchAttempted`
      // synthetic event when it dispatches ONE `resolve::<epic>` worker against a
      // sticky `worktree-merge-conflict` close failure, so the resolver fires exactly
      // once per condition instance (never a per-cycle re-dispatch loop). Independent
      // of `merge_escalated_at`: the human escalation notify and the resolver dispatch
      // are two consumers of the SAME sticky, each latched on its own column.
      // APPEND-via-ALTER keeps existing rows NULL (the zero-event shape) and is
      // re-fold-safe: a pre-v106 stream carries no `ResolverDispatchAttempted` event,
      // so a from-scratch re-fold leaves the column NULL byte-identically;
      // `foldDispatchFailed` preserves it across the `ON CONFLICT` UPSERT and
      // `DispatchCleared` drops it with the row so a fresh conflict re-arms at NULL.
      // NO cursor rewind (mirrors the `merge_escalated_at` add). Whitelist-only Python
      // read (keeper-py never reads `dispatch_failures`) — this bump MUST add 106 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces it.
      addColumnIfMissing(
        db,
        "dispatch_failures",
        "resolver_dispatched_at",
        "REAL",
      );
    },
  },
  {
    version: 107,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v106→v107 (fn-1102.1): add the `events.tmux_generation_id` VIRTUAL
      // generated column + its partial covering index — the indexed key the
      // bounded generation-summary walk (`src/restore-set.ts`) GROUPs on to rank
      // dead tmux-server generations by richness instead of "single newest"
      // (the defect that restored a 1-pane skeleton over a 9-pane session).
      // Expression: the snapshot's `generation_id` extracted from `data`, NULL
      // on every non-`TmuxTopologySnapshot` row and on a malformed blob
      // (`json_valid` gates the extract so it never raises mid-scan). A generated
      // column indexed as a plain column removes SQLite's exact-expression-text
      // index-matching footgun (a bare expression index matches only a
      // byte-identical query expression). VIRTUAL because SQLite's ALTER accepts
      // only VIRTUAL generated columns — it re-derives on read from the already-
      // immutable `data`, adding no stored bytes and no re-fold concern (nothing
      // folds it; it is read-only derivation). `addGeneratedColumnIfMissing`
      // (reads `table_xinfo`, idempotent) + `IF NOT EXISTS` index run
      // unconditionally on BOTH the fresh-CREATE and migrated paths, so the two
      // end schemas are byte-identical (no separate CREATE_EVENTS literal to keep
      // in lockstep). No cursor rewind, no backfill (the column materializes on
      // read). Whitelist-only Python read (keeper-py never reads the column) —
      // this bump MUST add 107 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py`
      // in the SAME commit; test/schema-version.test.ts enforces it.
      addGeneratedColumnIfMissing(
        db,
        "events",
        "tmux_generation_id",
        "TEXT GENERATED ALWAYS AS (CASE WHEN hook_event = 'TmuxTopologySnapshot' AND json_valid(data) THEN json_extract(data, '$.generation_id') END) VIRTUAL",
      );
      for (const sql of CREATE_V107_INDEXES) {
        db.run(sql);
      }
    },
  },
  {
    version: 108,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v107→v108 (fn-1107.1): add the nullable `jobs.dispatch_origin` TEXT
      // column — the airtight autopilot-vs-manual provenance discriminator the
      // autoclose worker scopes on. Stamped `'autopilot'` in the reducer's
      // SessionStart discharge-on-bind seam ONLY when the pending_dispatches
      // DELETE actually removes a row (a real autopilot Dispatched intent
      // materialized into this job); a manual `keeper dispatch work::fn-N.M` is
      // plan-form but mints no Dispatched event and therefore no pending row, so
      // it folds NULL. NULL, NO default: a `DEFAULT` would poison the NULL=manual
      // invariant and break re-fold byte-identity. APPEND-via-ALTER keeps existing
      // rows NULL (the zero-event shape) and is re-fold-safe: the Dispatched event
      // that mints the pending row precedes the binding SessionStart in the log,
      // so a from-scratch re-fold reproduces the same discharge and the same stamp
      // byte-identically (deterministic-replayed like `kill_reason`, NOT live-only
      // — do NOT add to `LIVE_ONLY_JOBS_COLUMNS`, NO cursor rewind). Kept OUT of
      // the `CREATE_JOBS` literal (the :852 rule) so fresh-vs-migrated
      // `PRAGMA table_info(jobs)` stays byte-identical. Whitelist-only Python read
      // (keeper-py never reads this column) — this bump MUST add 108 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "jobs", "dispatch_origin", "TEXT");
    },
  },
  {
    version: 109,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v108->v109 (fn-1103.3): add the nullable `harness` + `resume_target` TEXT
      // columns to BOTH the events and jobs surfaces, in ONE forward-only bump.
      // TWO different column disciplines meet here, so keep them straight:
      //
      //   - EVENTS is a FIVE-place lockstep per column — `harness`/`resume_target`
      //     are ALSO declared in the CREATE_EVENTS literal (after `worktree`),
      //     KNOWN_EVENT_COLUMNS, the hook insertBindings, INGEST_EVENTS_COLUMNS,
      //     and the prepared `insertEvent`. These ALTERs are the migrated-path
      //     append; the CREATE literal is the fresh path, and the two column
      //     lockstep tests (events-writer + events-ingest-worker) pin them equal.
      //   - JOBS is migration-ONLY (the `:852` convention) — NOT in CREATE_JOBS.
      //     Appended here AFTER `kill_reason` (the current final jobs column) so
      //     fresh-vs-migrated `PRAGMA table_info(jobs)` stays byte-identical
      //     (test/db.test.ts tail parity asserts).
      //
      // NULL rule: nullable, NO default (a DEFAULT would poison the NULL=absent
      // invariant and break re-fold byte-identity). NO backfill — legacy rows stay
      // NULL and read as claude everywhere; the fold copies the event's harness
      // verbatim and never synthesizes a value, so a from-scratch re-fold folds
      // both columns to NULL byte-identically on any pre-v109 stream. NO cursor
      // rewind (mirrors `worktree`/`kill_reason`). Whitelist-only Python read
      // (keeper-py reads neither new column) — this bump MUST add 109 to
      // `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit;
      // test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "events", "harness", "TEXT");
      addColumnIfMissing(db, "events", "resume_target", "TEXT");
      addColumnIfMissing(db, "jobs", "harness", "TEXT");
      addColumnIfMissing(db, "jobs", "resume_target", "TEXT");
    },
  },
  {
    version: 110,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v109→v110 (fn-1129.1): add the nullable `human_notified_at` once-marker
      // (REAL, epoch seconds) to BOTH escalation surfaces — the terminal
      // "human notified" stage of the two escalation paths, each stamped exactly
      // once when its escalation session (deconflict::<epic> / unblock::<task>)
      // declines or dies:
      //
      //   - `dispatch_failures.human_notified_at` — the DECONFLICT path, sibling
      //     of `merge_escalated_at` / `resolver_dispatched_at` on the sticky
      //     `worktree-merge-conflict` close row. Stamped by a terminal
      //     `MergeHumanNotified` event, gated `IS NULL`; `foldDispatchFailed`
      //     preserves it across the `ON CONFLICT` UPSERT and `DispatchCleared`
      //     (retry_dispatch) drops it with the row so a fresh conflict re-arms.
      //   - `block_escalations.human_notified_at` — the UNBLOCK path, on the
      //     per-(epic_id, task_id) block latch. Stamped by a terminal
      //     `BlockHumanNotified` event, gated `IS NULL`; the leave-blocked latch
      //     DELETE drops it with the row so an unblock→re-block re-arms at NULL.
      //
      // APPEND-via-ALTER keeps existing rows NULL (the zero-event shape) and is
      // re-fold-safe: a pre-v110 stream carries no `MergeHumanNotified` /
      // `BlockHumanNotified` event, so a from-scratch re-fold leaves both columns
      // NULL byte-identically (both folds read only the payload + `event.ts`).
      // Kept OUT of the CREATE literals (mirrors the sibling marker adds) so a
      // fresh DB gains the columns via this same idempotent ALTER on boot. NO
      // cursor rewind. Whitelist-only Python read (keeper-py reads neither table)
      // — this bump MUST add 110 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py`
      // in the SAME commit; test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "dispatch_failures", "human_notified_at", "REAL");
      addColumnIfMissing(db, "block_escalations", "human_notified_at", "REAL");
    },
  },
  {
    version: 111,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v110→v111 (fn-1131.1): the harness-session ADOPTION primitive — TWO
      // surfaces, ONE bump.
      //
      //   - `events.adopted` + `jobs.adopted` (INTEGER): the harness-agnostic
      //     "a NON-launcher path minted this session" marker. `events.adopted`
      //     rides the SAME FIVE-place lockstep as harness/resume_target (CREATE
      //     literal, KNOWN_EVENT_COLUMNS, the hook insertBindings,
      //     INGEST_EVENTS_COLUMNS, the insertEvent prepared statement); the two
      //     events-column lockstep tests pin them equal. `jobs.adopted` is
      //     migration-ONLY (the `:1012` convention) — NOT in CREATE_JOBS,
      //     appended here AFTER `resume_target` (the current final jobs column)
      //     so fresh-vs-migrated `PRAGMA table_info(jobs)` stays byte-identical.
      //     The SessionStart fold binds `events.adopted` into the INSERT and
      //     COALESCE-preserves it on the ON-CONFLICT set (like worktree), so a
      //     later resume or launcher re-mint never clobbers the marker; the claude
      //     hook + every birth mint bind it NULL (launcher-owned by definition).
      //   - `autopilot_state.codex_adoption` (INTEGER: NULL/0 = OFF, 1 = ON): the
      //     durable codex rollout-adoption knob, the FIFTH scalar config column
      //     riding the generic `AutopilotConfigSet` fold (mirrors
      //     `worktree_multi_repo`). Declared in CREATE_AUTOPILOT_STATE too; the
      //     reconciler/producer resolve `?? OFF` at read time — never in a fold.
      //
      // NULL rule: all three nullable, NO default (a DEFAULT poisons the
      // NULL=absent invariant and breaks re-fold byte-identity). NO backfill — the
      // folds copy `events.adopted` verbatim and never synthesize, and no fold
      // reads `codex_adoption`, so a from-scratch re-fold over any pre-v111 stream
      // leaves all three NULL byte-identically. NO cursor rewind (mirrors
      // `worktree`/`harness`). Whitelist-only Python read (keeper-py reads none of
      // the three) — this bump MUST add 111 to `SUPPORTED_SCHEMA_VERSIONS` in
      // `keeper/api.py` in the SAME commit; test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "events", "adopted", "INTEGER");
      addColumnIfMissing(db, "jobs", "adopted", "INTEGER");
      addColumnIfMissing(db, "autopilot_state", "codex_adoption", "INTEGER");
    },
  },
  // v112: bare version bump — no schema-mutating body.
  { version: 112, kind: "noop", apply: () => {} },
  {
    version: 113,
    kind: "rewind",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v112→v113 (fn-1164 task .1): the jobs lifecycle stamp. Add the nullable
      // `jobs.last_lifecycle_ts` REAL column — the per-row event-time high-water
      // mark a lifecycle transition may not regress behind (ADR 0013), so a stale
      // out-of-order event annotates but never resurrects state (the
      // phantom-working root cause). Nullable, NO default: a `DEFAULT` would
      // poison the "NULL always applies" fresh-row invariant AND break re-fold
      // byte-identity. Migration-ONLY (kept OUT of the CREATE_JOBS literal, NOT in
      // LIVE_ONLY_JOBS_COLUMNS — it is deterministic-replayed), appended after
      // every prior jobs ALTER so fresh-vs-migrated `PRAGMA table_info(jobs)` stays
      // byte-identical.
      addColumnIfMissing(db, "jobs", "last_lifecycle_ts", "REAL");

      // REWINDING migration: the stamp is back-derived PURELY BY REPLAY (never a
      // SQL back-fill — an UPDATE cannot reconstruct the per-transition high-water
      // mark), so rewind the cursor to 0 and wipe the FULL current
      // deterministic-replayed projection set; the post-migrate boot drain
      // re-folds them under the v113 gated reducer, self-healing every existing
      // phantom-working row on deploy (a Stop that lost to a later-ingested
      // straggler now wins by ts). Version-guarded — the rewind is non-idempotent.
      //
      // The DELETE list is enumerated FRESH from the current schema, NOT copied
      // from the v80/v81/v85 blocks (those PREDATE `dispatch_instant_death`,
      // `epic_dep_edges`, `epic_tombstones`, `scheduled_tasks`, so they are
      // provably incomplete for v113 — the risk the census surfaced). Every
      // reducer-folded projection is wiped EXCEPT `commit_trailer_facts` (below);
      // the NON-projections stay: `events` / `event_ingest_offsets` (the log + its
      // ingest cursor), `dead_letters` + `dispatch_mint_gate` (durable PRODUCER
      // state, never folded), and the control singletons `meta` / `reducer_state`
      // / `git_projection_state` / `tmux_projection_state`.
      //
      // `commit_trailer_facts` is DELIBERATELY NOT wiped, matching v80/v81/v85: it
      // is a DERIVE INPUT keyed by the `event_id` PK with an `INSERT OR IGNORE`
      // fold (`foldCommit`) reading `Commit` events alone, and the `syncPlanLinks`
      // commit-trailer channel reads it clamped `event_id <= maxEventId`, so a
      // cursor-0 re-fold rebuilds it byte-identically WITHOUT a wipe (a bare
      // DELETE would only drop the commit-channel edges the merge reads). Its
      // survival across a rewind is a fixed contract (test/db.test.ts v77).
      //
      // The LIVE-ONLY git surface is wiped + its floor RAISED to `max(events.id)`
      // (NOT reset to 0 — that would re-arm the O(history) `computeRepoBashWindows`
      // re-fold time-bomb v79 fixed; this deliberately does NOT call
      // `rewindLiveProjection`, whose floor-0 reset is only safe on a small/early
      // DB), `seed_required = 1` so the boot-seed re-derives it above the floor.
      // The ephemeral `pending_dispatches` is wiped so the cursor-0 re-fold cannot
      // resurrect a phantom dispatch jam (the boot-truncate also clears it).
      //
      // Whitelist-only Python read (keeper-py reads none of these projection
      // internals) — this bump MUST add 113 to `SUPPORTED_SCHEMA_VERSIONS` in
      // `keeper/api.py` in the SAME commit; test/schema-version.test.ts enforces it.
      if (preMigrateStoredVersion < 113) {
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
        db.run("DELETE FROM usage");
        db.run("DELETE FROM profiles");
        db.run("DELETE FROM dispatch_failures");
        db.run("DELETE FROM dispatch_instant_death");
        db.run("DELETE FROM dispatch_never_bound");
        db.run("DELETE FROM autopilot_state");
        db.run("DELETE FROM block_escalations");
        db.run("DELETE FROM handoffs");
        db.run("DELETE FROM armed_epics");
        db.run("DELETE FROM builds");
        db.run("DELETE FROM epic_dep_edges");
        db.run("DELETE FROM epic_tombstones");
        db.run("DELETE FROM scheduled_tasks");
        // Ephemeral (boot-truncated) — wiped so the cursor-0 re-fold cannot
        // resurrect a phantom `pending_dispatches` row before serving.
        db.run("DELETE FROM pending_dispatches");
        // LIVE-ONLY git surface: wipe the tables + zero the embedded jobs
        // git-counters, then RAISE the floor to `max(events.id)` (never a floor-0
        // reset) so the cursor-0 re-fold drain skips the historical git folds and
        // the boot-seed re-derives the surface above the floor.
        for (const table of LIVE_ONLY_PROJECTIONS) {
          db.run(`DELETE FROM ${table}`);
        }
        db.run(
          `UPDATE jobs SET git_dirty_count = 0, git_unattributed_to_live_count = 0, git_orphan_count = 0`,
        );
        db.run(
          `UPDATE git_projection_state
              SET floor = max(floor, (SELECT COALESCE(MAX(id), 0) FROM events)),
                  seed_required = 1,
                  updated_at = unixepoch('now', 'subsec')
            WHERE id = 1`,
        );
      }
    },
  },
  {
    version: 114,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v113→v114 (fn-1171 task .2): bind each escalation session to its block
      // INSTANCE, jobs-side. TWO nullable INTEGER columns, no DEFAULT, one bump.
      //
      //   - `jobs.escalation_instance` — the block-instance id an
      //     `unblock`/`deconflict`/`resolve` escalation SESSION is bound to at its
      //     binding SessionStart, stamped TOGETHER with `dispatch_origin`
      //     ='escalation' only when the spawn name corroborates against the prior
      //     projection (the unblock latch dispatched / the merge sticky escalated /
      //     resolver-dispatched); a corroboration miss leaves BOTH NULL. Set-once,
      //     COALESCE-preserved on resume. Migration-ONLY (kept OUT of the
      //     CREATE_JOBS literal, NOT in LIVE_ONLY_JOBS_COLUMNS — it is
      //     deterministic-replayed), appended AFTER every prior jobs ALTER so
      //     fresh-vs-migrated `PRAGMA table_info(jobs)` stays byte-identical.
      //   - `dispatch_failures.instance_event_id` — the sticky row's FIRST-
      //     appearance event id, stamped on the first INSERT and preserved across
      //     every UPSERT re-emit of the same open row (excluded from the ON-CONFLICT
      //     SET, same as `created_at`/`merge_escalated_at`), reborn fresh only when
      //     a `DispatchCleared` DELETE + re-mint opens a new incident instance. It
      //     is the fencing token the deconflict/resolve corroboration reads to
      //     identify the instance. Kept OUT of the CREATE_DISPATCH_FAILURES literal
      //     (mirrors the sibling `merge_escalated_at`/`resolver_dispatched_at`/
      //     `human_notified_at` marker adds), appended here so its column order is
      //     fresh-vs-migrated identical.
      //
      // NULL rule: both nullable, NO DEFAULT — a DEFAULT poisons the NULL=absent
      // invariant and breaks re-fold byte-identity. NO backfill: the jobs stamp is
      // only ever written by the binding-SessionStart fold (COALESCE-preserved) and
      // `instance_event_id` copies the event's own id, so a from-scratch re-fold
      // over any pre-v114 stream reproduces every stamp (and every corroboration
      // miss) byte-identically. NO cursor rewind (a plain additive ALTER, unlike the
      // v113 stamp). Whitelist-only Python read (keeper-py reads neither column) —
      // this bump MUST add 114 to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in
      // the SAME commit; test/schema-version.test.ts enforces it.
      addColumnIfMissing(db, "jobs", "escalation_instance", "INTEGER");
      addColumnIfMissing(
        db,
        "dispatch_failures",
        "instance_event_id",
        "INTEGER",
      );
    },
  },
  {
    version: 115,
    kind: "additive",
    apply: (ctx) => {
      const { db } = ctx;
      // v114→v115 (fn-1173 task .4): add the nullable
      // `dispatch_failures.repair_dispatched_at` once-marker (REAL, epoch
      // seconds) — the dispatch-once latch of the REPAIR escalation path, the
      // fourth marker on a `dispatch_failures` row and the sibling of
      // `merge_escalated_at` / `resolver_dispatched_at`. It hangs on the sticky
      // `repair::<repo-token>` row (verb `repair`, id the repo token) the daemon
      // SHARED_BASE_BROKEN sweep mints; a terminal `RepairDispatched` event stamps
      // it (gated `IS NULL`) once the `repair::<token>` session launches, so the
      // repair dispatches ONCE per condition instance, and the reused
      // `human_notified_at` marker pages the decline exactly once. `foldDispatchFailed`
      // preserves it across the `ON CONFLICT` UPSERT (a re-failure must not reset the
      // marker) and `DispatchCleared` (retry_dispatch OR the sweep's positive-evidence
      // clear) drops it with the row so a fresh breakage re-arms at NULL. APPEND-via-
      // ALTER keeps existing rows NULL (the zero-event shape) and is re-fold-safe: a
      // pre-v115 stream carries no `RepairDispatched` event, so a from-scratch re-fold
      // leaves the column NULL byte-identically (the fold reads only the payload +
      // `event.ts`). Kept OUT of the CREATE literal (mirrors the sibling marker adds).
      // NO cursor rewind. Whitelist-only Python read (keeper-py never reads
      // `dispatch_failures`) — this bump MUST add 115 to `SUPPORTED_SCHEMA_VERSIONS`
      // in `keeper/api.py` in the SAME commit; test/schema-version.test.ts enforces it.
      addColumnIfMissing(
        db,
        "dispatch_failures",
        "repair_dispatched_at",
        "REAL",
      );
    },
  },
  {
    version: 116,
    kind: "rewind",
    apply: (ctx) => {
      const { db, preMigrateStoredVersion } = ctx;
      // v115→v116 (fn-1172 task .3): retire the epic-level close-time
      // selection-review record. `epics.selection_review` is a plain leaf TEXT
      // column (no index, no generated-column reference), so a direct DROP COLUMN
      // suffices — no table rebuild. The reducer's epics upsert no longer writes
      // it and a historical EpicSnapshot's `selection_review` key folds away
      // unread, so a from-scratch re-fold produces the narrower row shape.
      //
      // REWINDING migration (the fn-936 v85 `plan_queue_jump` drop is the
      // precedent): rewind the cursor to 0 and wipe the FULL deterministic-replayed
      // projection set so the post-migrate boot drain re-folds them under the v116
      // reducer into the narrower `epics` shape. The DELETE list MIRRORS the v113
      // block above (enumerated fresh from the current schema, NOT an older block).
      // `commit_trailer_facts` is DELIBERATELY NOT wiped (a derive input keyed by
      // the `event_id` PK with an `INSERT OR IGNORE` fold — it re-folds
      // byte-identically from id 0 without a wipe). The LIVE-ONLY git surface is
      // wiped + its floor RAISED to `max(events.id)` (never a floor-0 reset — that
      // re-arms the `computeRepoBashWindows` O(history) re-fold time-bomb v79
      // fixed), `seed_required = 1` so the boot-seed re-derives it above the floor.
      // The ephemeral `pending_dispatches` is wiped so the cursor-0 re-fold cannot
      // resurrect a phantom dispatch jam. Version-guarded — non-idempotent.
      //
      // Whitelist-only Python read (keeper-py reads no epics selection-review
      // surface) — this bump MUST add 116 to `SUPPORTED_SCHEMA_VERSIONS` in
      // `keeper/api.py` in the SAME commit; test/schema-version.test.ts enforces it.
      if (preMigrateStoredVersion < 116) {
        dropColumnIfPresent(db, "epics", "selection_review");
        db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
        db.run("DELETE FROM jobs");
        db.run("DELETE FROM epics");
        db.run("DELETE FROM subagent_invocations");
        db.run("DELETE FROM usage");
        db.run("DELETE FROM profiles");
        db.run("DELETE FROM dispatch_failures");
        db.run("DELETE FROM dispatch_instant_death");
        db.run("DELETE FROM dispatch_never_bound");
        db.run("DELETE FROM autopilot_state");
        db.run("DELETE FROM block_escalations");
        db.run("DELETE FROM handoffs");
        db.run("DELETE FROM armed_epics");
        db.run("DELETE FROM builds");
        db.run("DELETE FROM epic_dep_edges");
        db.run("DELETE FROM epic_tombstones");
        db.run("DELETE FROM scheduled_tasks");
        // Ephemeral (boot-truncated) — wiped so the cursor-0 re-fold cannot
        // resurrect a phantom `pending_dispatches` row before serving.
        db.run("DELETE FROM pending_dispatches");
        // LIVE-ONLY git surface: wipe the tables + zero the embedded jobs
        // git-counters, then RAISE the floor to `max(events.id)` (never a floor-0
        // reset) so the cursor-0 re-fold drain skips the historical git folds and
        // the boot-seed re-derives the surface above the floor.
        for (const table of LIVE_ONLY_PROJECTIONS) {
          db.run(`DELETE FROM ${table}`);
        }
        db.run(
          `UPDATE jobs SET git_dirty_count = 0, git_unattributed_to_live_count = 0, git_orphan_count = 0`,
        );
        db.run(
          `UPDATE git_projection_state
              SET floor = max(floor, (SELECT COALESCE(MAX(id), 0) FROM events)),
                  seed_required = 1,
                  updated_at = unixepoch('now', 'subsec')
            WHERE id = 1`,
        );
      }
    },
  },
];

/**
 * Current schema version — DERIVED from the ladder tail, never hand-typed.
 * Forward-only: never reduce, never branch. A new step (a bumped tail version)
 * MUST add that version to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in
 * the same commit (test/schema-version.test.ts enforces it).
 */
export const SCHEMA_VERSION = SCHEMA_STEPS[SCHEMA_STEPS.length - 1].version;

/**
 * Pinned sha256 of the fully-migrated schema shape (see
 * {@link computeSchemaFingerprint}), version-prefixed. Every schema change —
 * a new migration block, a CREATE-literal edit, or a bare SCHEMA_VERSION bump —
 * must re-pin this constant (test/db.test.ts recomputes and compares).
 *
 * The point is the git merge rule: two lanes that each change this ONE line to
 * DIFFERENT hashes always conflict, so two concurrent schema edits can never
 * silently fuse the way two identical "next version" integers merge clean.
 * The schema is a singleton resource; this line is its lock file.
 */
export const SCHEMA_FINGERPRINT =
  "v116:b2caf5d9c6fa05f9f1f85ce6819ac3234205a2dab3c0b131df878f3122b465b9";

/**
 * Compute the live schema fingerprint: sha256 over the sorted `sqlite_master`
 * DDL (tables + indexes, internal `sqlite_*` rows excluded — ALTERed columns
 * appear in the stored CREATE text, so the dump covers migration-only columns
 * too), prefixed with the binary's SCHEMA_VERSION so even a shape-preserving
 * bump (a pure rewind) moves the pinned constant. Pure read; deterministic for
 * a given migrated database.
 */
export function computeSchemaFingerprint(db: Database): string {
  const rows = db
    .query(
      `SELECT type, name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all() as { type: string; name: string; sql: string }[];
  const dump = rows.map((r) => `${r.type}\t${r.name}\t${r.sql}`).join("\n");
  const hash = createHash("sha256")
    .update(`v${SCHEMA_VERSION}\n${dump}`)
    .digest("hex");
  return `v${SCHEMA_VERSION}:${hash}`;
}

/** `KEEPER_DB` env wins; else `~/.local/state/keeper/keeper.db`. */
export function resolveDbPath(): string {
  const override = process.env.KEEPER_DB;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "keeper.db");
}

/** `KEEPER_SOCK` env wins; else `~/.local/state/keeper/keeperd.sock`. Pure. */
export function resolveSockPath(): string {
  const override = process.env.KEEPER_SOCK;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "keeperd.sock");
}

/**
 * `KEEPER_BUS_DB` env wins; else `~/.local/state/keeper/bus.db`. Pure.
 *
 * The Agent Bus's OWN SQLite store, PHYSICALLY separate from keeper.db so the
 * bus adds no keeper event/projection/RPC/schema-version. Mirrors
 * {@link resolveDbPath}; never passed to `openDb`/`migrate` (bus.db runs its own
 * `PRAGMA user_version` ladder in `src/bus-db.ts`).
 */
export function resolveBusDbPath(): string {
  const override = process.env.KEEPER_BUS_DB;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "bus.db");
}

/** `KEEPER_BUS_SOCK` env wins; else `~/.local/state/keeper/bus.sock`. Pure. */
export function resolveBusSockPath(): string {
  const override = process.env.KEEPER_BUS_SOCK;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "bus.sock");
}

/** `KEEPER_RESTORE_FILE` env wins; else `~/.local/state/keeper/restore.json`. Pure. */
export function resolveRestorePath(): string {
  const override = process.env.KEEPER_RESTORE_FILE;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "restore.json");
}

/**
 * The durable revive-script side-file — `revive.sh` in the SAME directory as the
 * JSON restore mirror ({@link resolveRestorePath}), so a `KEEPER_RESTORE_FILE`
 * override relocates both together. A runnable snapshot of the current live
 * keeper agents the restore-worker maintains next to `restore.json` on the same
 * `data_version` pulse; dump-only (nothing reads it back — crash-restore still
 * derives from `keeper.db`). Pure. */
export function resolveRevivePath(): string {
  return join(dirname(resolveRestorePath()), "revive.sh");
}

/**
 * The handoff doc-spill directory: `<state>/handoff/`. `KEEPER_HANDOFF_SPILL_DIR`
 * overrides it for tests. A `keeper handoff` brief (up to 64KB) is spilled here as
 * a small file; the CLI sends only the path over the wire (control frames stay
 * small — see `cli/control-rpc.ts`'s size guard), and the daemon reads it back to
 * inline the doc into the `HandoffRequested` event. Same-host only (UDS implies
 * shared filesystem). Pure. */
export function resolveHandoffSpillDir(): string {
  const override = process.env.KEEPER_HANDOFF_SPILL_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "handoff");
}

const DEFAULT_PLAN_ROOTS = ["~/code"];

export const DEFAULT_REPO_CREATE_ROOT = "~/code";
export const DEFAULT_REPO_CLONE_ROOT = "~/src";
export const DEFAULT_REPO_FORK_ROOT = "~/src";

const DEFAULT_CLAUDE_PROJECTS_ROOT = "~/.claude/projects";

const DEFAULT_AGENTUSAGE_ROOT = "~/.local/state/agentusage";

/**
 * Parsed keeper daemon config. Keys are INDEPENDENT — a malformed/missing one
 * never disturbs the others. Unknown keys are ignored.
 */
export interface KeeperConfig {
  roots: string[];
  // Destination roots for `keeper repo` lifecycle verbs. Parsed independently
  // from plan roots: project discovery watches `roots`, while repo clone/fork
  // default to a source checkout area.
  repoCreateRoot: string;
  repoCloneRoot: string;
  repoForkRoot: string;
  claudeProjectsRoot?: string;
  agentusageRoot?: string;
  // Buildbot master base URL (e.g. `http://localhost:8010`) for the `keeper
  // builds` dashboard's poller. Independent best-effort key with NO default:
  // absent/empty/garbage → undefined → the builds worker is not spawned.
  buildbotUrl?: string;
  // Global prompt prefix for `keeper dispatch` FREE-FORM dispatches: when set
  // (e.g. `/hack`), it is prepended with a single space to a free-form prompt
  // so the worker launches with `<prefix> <prompt>`. Independent best-effort key
  // with NO default: absent/empty/garbage → undefined → no prefix applied.
  // Plan-form dispatches are never prefixed.
  dispatchPromptPrefix?: string;
  // Global prompt prefix for `keeper handoff` dispatches: when set (e.g.
  // `/hack`), it boots each fire-and-forget handoff-ee worker into the prefix
  // skill before it reads its brief. Independent best-effort key with NO
  // default: absent/empty/garbage → undefined → no prefix applied. Mirrors
  // `dispatchPromptPrefix`.
  handoffPromptPrefix?: string;
  // Absolute path to the keeper CLI entry the detached tmux pane re-execs to
  // reach the folded launcher (`<bun> <keeperAgentPath> agent <agent> …`).
  // Independent best-effort key with NO default at the parse layer (absent →
  // undefined here); `resolveKeeperAgentPath()` supplies the derived default +
  // the `KEEPER_AGENT_PATH` env override + tilde-expansion.
  keeperAgentPath?: string;
  // The autoclose worker's off-switch (default TRUE = on). Parsed from
  // `autoclose_enabled`. Because it gates a WINDOW-KILLING feature the disable
  // set is deliberately GENEROUS: boolean `false`, OR any of the trimmed,
  // case-insensitive strings `"false"` / `"off"` / `"no"` / `"0"`, disables.
  // Absent or ANY other value → enabled (a mistyped off-switch must never
  // silently keep killing windows). Re-read on every `resolveConfig` call so a
  // flip lands without a daemon restart.
  autocloseEnabled: boolean;
  // Grace period (SECONDS) the autoclose worker waits after an agent is proven
  // done-and-idle before closing its window. Parsed from
  // `autoclose_grace_seconds`; a positive FINITE number overrides, anything else
  // (absent / non-number / NaN / <= 0 / Infinity) → 30. Re-read on every
  // `resolveConfig` call.
  autocloseGraceSeconds: number;
  // The `usage_models` registry — the single declaration of which models the
  // usage scraper produces envelopes for (keys) and their cosmetic TUI aliases
  // (values). Parsed fail-open + id-validated via {@link parseUsageModels}; never
  // folded, never changes a row's identity. Empty map ≡ no declared models.
  usageModels: UsageModels;
}

/** Default for {@link KeeperConfig.autocloseEnabled} — the feature ships ON. */
export const DEFAULT_AUTOCLOSE_ENABLED = true;

/** Default for {@link KeeperConfig.autocloseGraceSeconds} — 30s of proven
 *  done-and-idle before a window is closed. */
export const DEFAULT_AUTOCLOSE_GRACE_SECONDS = 30;

/** The generous disable set for `autoclose_enabled` (trimmed, case-insensitive).
 *  A boolean `false` OR any of these strings disables; anything else enables. */
const AUTOCLOSE_DISABLE_STRINGS: ReadonlySet<string> = new Set([
  "false",
  "off",
  "no",
  "0",
]);

/**
 * Resolve the generous `autoclose_enabled` key. Boolean `false` OR a trimmed,
 * case-insensitive `"false"`/`"off"`/`"no"`/`"0"` string disables; absent
 * (`undefined`) or ANY other value → enabled (default TRUE). Pure. */
export function resolveAutocloseEnabled(raw: unknown): boolean {
  if (raw === false) {
    return false;
  }
  if (typeof raw === "string") {
    return !AUTOCLOSE_DISABLE_STRINGS.has(raw.trim().toLowerCase());
  }
  return DEFAULT_AUTOCLOSE_ENABLED;
}

/**
 * Resolve the `autoclose_grace_seconds` key: a positive FINITE number wins;
 * anything else (non-number / NaN / <= 0 / Infinity / absent) → 30. Pure. */
export function resolveAutocloseGraceSeconds(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_AUTOCLOSE_GRACE_SECONDS;
}

/**
 * The IN-MEMORY default for the runtime-settable autopilot concurrency cap —
 * used until a `set_autopilot_config` sets `autopilot_state.max_concurrent_jobs`
 * (the cap is NO LONGER config-file-frozen). `null` = unlimited. `null` (not
 * `Infinity`) at rest — `Infinity` serializes to `null` via JSON and fails
 * SQLite, so the unlimited sentinel stays `null` end-to-end and becomes a
 * fast-path bypass only at the budget gate. The reconciler + viewer resolve
 * `column ?? DEFAULT_MAX_CONCURRENT_JOBS`.
 */
export const DEFAULT_MAX_CONCURRENT_JOBS: number | null = null;

/**
 * The IN-MEMORY default for the runtime-settable PER-ROOT dispatch concurrency
 * count — used until a `set_autopilot_config` sets
 * `autopilot_state.max_concurrent_per_root`. `1` = today's hardcoded
 * one-task-per-root mutex (N=1 is byte-identical to the pre-feature board);
 * a positive integer N grants up to N concurrent tasks per root, distributed
 * fairly across the root's epics (the allocator lands in task .2). Unlike the
 * global cap, this has NO unlimited sentinel — the stored column is durable
 * intent, and the EFFECTIVE cap consumers dispatch against is derived through
 * {@link effectivePerRootCap} (worktree off ⇒ 1; worktree on ⇒ the stored
 * positive integer, else this default).
 */
export const DEFAULT_MAX_CONCURRENT_PER_ROOT = 1;

/**
 * Derive the EFFECTIVE per-root dispatch concurrency cap from the durable STORED
 * intent and the live worktree-mode toggle — the SINGLE derivation seam every
 * dispatch-relevant consumer routes through (none re-interprets the raw column
 * inline, so per-seam derivations can never drift). Worktree mode is the safety
 * boundary: with it OFF every worker of a root shares the one main checkout, so
 * the effective cap is ALWAYS 1 (concurrent same-checkout workers would corrupt
 * each other's working tree + index); with it ON each task forks its own lane, so
 * the stored intent is honored. The stored value is durable — it survives a
 * worktree toggle untouched, so an OFF→ON flip restores the prior cap with no
 * re-set. Fails closed: a missing / null / non-integer / non-positive stored
 * value derives to 1, never permissive. No upper clamp — the ceiling is
 * unbounded. Pure.
 */
export function effectivePerRootCap(
  stored: unknown,
  worktreeOn: boolean,
): number {
  if (!worktreeOn) {
    return DEFAULT_MAX_CONCURRENT_PER_ROOT;
  }
  return typeof stored === "number" && Number.isInteger(stored) && stored > 0
    ? stored
    : DEFAULT_MAX_CONCURRENT_PER_ROOT;
}

/** `KEEPER_CONFIG` env wins; else `~/.config/keeper/config.yaml`. Pure. */
export function resolveConfigPath(): string {
  const override = process.env.KEEPER_CONFIG;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".config", "keeper", "config.yaml");
}

/**
 * Read + parse the keeper config YAML. Best-effort — must never throw past this
 * resolver; every key falls back to its default independently.
 */
export function resolveConfig(): KeeperConfig {
  const path = resolveConfigPath();
  let roots: string[] = [...DEFAULT_PLAN_ROOTS];
  let repoCreateRoot = DEFAULT_REPO_CREATE_ROOT;
  let repoCloneRoot = DEFAULT_REPO_CLONE_ROOT;
  let repoForkRoot = DEFAULT_REPO_FORK_ROOT;
  let claudeProjectsRoot: string = DEFAULT_CLAUDE_PROJECTS_ROOT;
  let agentusageRoot: string = DEFAULT_AGENTUSAGE_ROOT;
  // No default — absent leaves `buildbotUrl` undefined so the builds worker
  // never spawns.
  let buildbotUrl: string | undefined;
  // No default — absent leaves `dispatchPromptPrefix` undefined so no prefix is
  // applied to free-form `keeper dispatch` prompts.
  let dispatchPromptPrefix: string | undefined;
  // No default — absent leaves `handoffPromptPrefix` undefined so no prefix is
  // applied to `keeper handoff` dispatches.
  let handoffPromptPrefix: string | undefined;
  // No default at the parse layer — absent leaves `keeperAgentPath` undefined so
  // `resolveKeeperAgentPath()` derives the `cli/keeper.ts` default.
  let keeperAgentPath: string | undefined;
  // The autoclose keys default independently to ON / 30s; a malformed value for
  // either falls back through the pure resolvers below.
  let autocloseEnabled: boolean = DEFAULT_AUTOCLOSE_ENABLED;
  let autocloseGraceSeconds: number = DEFAULT_AUTOCLOSE_GRACE_SECONDS;
  let usageModels: UsageModels = {};
  try {
    if (!existsSync(path)) {
      return {
        roots,
        repoCreateRoot,
        repoCloneRoot,
        repoForkRoot,
        claudeProjectsRoot,
        agentusageRoot,
        autocloseEnabled,
        autocloseGraceSeconds,
        usageModels,
      };
    }
    const raw = Bun.YAML.parse(readFileSync(path, "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      if (Array.isArray((raw as { roots?: unknown }).roots)) {
        const parsed = (raw as { roots: unknown[] }).roots.filter(
          (r): r is string => typeof r === "string" && r.length > 0,
        );
        if (parsed.length > 0) {
          roots = parsed;
        }
      }
      const rcr = (raw as { repo_create_root?: unknown }).repo_create_root;
      if (typeof rcr === "string" && rcr.length > 0) {
        repoCreateRoot = rcr;
      }
      const rclr = (raw as { repo_clone_root?: unknown }).repo_clone_root;
      if (typeof rclr === "string" && rclr.length > 0) {
        repoCloneRoot = rclr;
      }
      const rfr = (raw as { repo_fork_root?: unknown }).repo_fork_root;
      if (typeof rfr === "string" && rfr.length > 0) {
        repoForkRoot = rfr;
      }
      const cpr = (raw as { claude_projects_root?: unknown })
        .claude_projects_root;
      if (typeof cpr === "string" && cpr.length > 0) {
        claudeProjectsRoot = cpr;
      }
      const aur = (raw as { agentusage_root?: unknown }).agentusage_root;
      if (typeof aur === "string" && aur.length > 0) {
        agentusageRoot = aur;
      }
      // Independent best-effort key — non-empty string only; garbage/absent
      // leaves `buildbotUrl` undefined and the builds worker un-spawned.
      const bbu = (raw as { buildbot_url?: unknown }).buildbot_url;
      if (typeof bbu === "string" && bbu.length > 0) {
        buildbotUrl = bbu;
      }
      // Independent best-effort key — non-empty string only; garbage/absent
      // leaves `dispatchPromptPrefix` undefined and no free-form prompt prefix
      // is applied.
      const dpp = (raw as { dispatch_prompt_prefix?: unknown })
        .dispatch_prompt_prefix;
      if (typeof dpp === "string" && dpp.length > 0) {
        dispatchPromptPrefix = dpp;
      }
      // Independent best-effort key — non-empty string only; garbage/absent
      // leaves `handoffPromptPrefix` undefined and no handoff prompt prefix is
      // applied.
      const hpp = (raw as { handoff_prompt_prefix?: unknown })
        .handoff_prompt_prefix;
      if (typeof hpp === "string" && hpp.length > 0) {
        handoffPromptPrefix = hpp;
      }
      // Independent best-effort key — non-empty string only; garbage/absent
      // leaves `keeperAgentPath` undefined and `resolveKeeperAgentPath()` falls
      // back to the derived default. NOT tilde-expanded here — resolution
      // happens in `resolveKeeperAgentPath()`.
      const kap = (raw as { keeper_agent_path?: unknown }).keeper_agent_path;
      if (typeof kap === "string" && kap.length > 0) {
        keeperAgentPath = kap;
      }
      // Autoclose keys — resolved through the generous pure resolvers so a
      // mistyped off-switch never silently keeps killing windows, and each key
      // falls back to its default independently of the other.
      autocloseEnabled = resolveAutocloseEnabled(
        (raw as { autoclose_enabled?: unknown }).autoclose_enabled,
      );
      autocloseGraceSeconds = resolveAutocloseGraceSeconds(
        (raw as { autoclose_grace_seconds?: unknown }).autoclose_grace_seconds,
      );
      // The `usage_models` registry — fail-open + id-validated in one place so
      // the SQLite-side config and the dep-free picker never diverge. The retired
      // `account_aliases` key is no longer parsed; a lingering copy is ignored.
      usageModels = parseUsageModels(
        (raw as { usage_models?: unknown }).usage_models,
      );
    }
  } catch (err) {
    console.error(
      `[keeper] config parse failed (${path}); using defaults:`,
      err,
    );
    return {
      roots: [...DEFAULT_PLAN_ROOTS],
      repoCreateRoot: DEFAULT_REPO_CREATE_ROOT,
      repoCloneRoot: DEFAULT_REPO_CLONE_ROOT,
      repoForkRoot: DEFAULT_REPO_FORK_ROOT,
      claudeProjectsRoot: DEFAULT_CLAUDE_PROJECTS_ROOT,
      agentusageRoot: DEFAULT_AGENTUSAGE_ROOT,
      autocloseEnabled: DEFAULT_AUTOCLOSE_ENABLED,
      autocloseGraceSeconds: DEFAULT_AUTOCLOSE_GRACE_SECONDS,
      usageModels: {},
    };
  }
  return {
    roots,
    repoCreateRoot,
    repoCloneRoot,
    repoForkRoot,
    claudeProjectsRoot,
    agentusageRoot,
    buildbotUrl,
    dispatchPromptPrefix,
    handoffPromptPrefix,
    keeperAgentPath,
    autocloseEnabled,
    autocloseGraceSeconds,
    usageModels,
  };
}

/**
 * Resolve the absolute keeper CLI entry the detached tmux pane re-execs to reach
 * the folded launcher (`<bun> <this path> agent <agent> …`). Config-aware sibling
 * of {@link resolveKeeperAgentPathDepFree} (the cold-start/pair variant in
 * `src/keeper-agent-path.ts`): it folds the `keeper_agent_path` config key on top
 * of the same env-override + derived default.
 *
 * Precedence: `KEEPER_AGENT_PATH` env > `keeper_agent_path` config > the derived
 * `cli/keeper.ts` default. A leading `~` on a config/env value is expanded via
 * `homedir()` AT RESOLVE TIME (`execvp`/the shell re-exec do not expand `~`). The
 * DERIVED default is already absolute + `realpath`'d. No existence check — a bad
 * path fails the launch loudly at spawn.
 */
export function resolveKeeperAgentPath(): string {
  const cfg = resolveConfig();
  const entry =
    firstNonEmpty(process.env.KEEPER_AGENT_PATH, cfg.keeperAgentPath) ?? null;
  if (entry === null) {
    return defaultKeeperAgentPath();
  }
  const home = homedir();
  if (entry === "~") {
    return home;
  }
  if (entry.startsWith("~/")) {
    return join(home, entry.slice(2));
  }
  return entry;
}

/** First non-empty string among the candidates, or undefined. */
function firstNonEmpty(
  ...candidates: (string | undefined)[]
): string | undefined {
  for (const c of candidates) {
    if (c !== undefined && c.length > 0) {
      return c;
    }
  }
  return undefined;
}

/**
 * Resolve the buildbot master base URL for the `keeper builds` poller, or null
 * when it is unconfigured. Independent best-effort key with NO default — the
 * builds worker spawn is gated on a non-null return here. No tilde-expansion or
 * existence check (it's a URL, validated by the poller degrading to silent
 * staleness on any fetch failure).
 */
export function resolveBuildbotUrl(): string | null {
  return resolveConfig().buildbotUrl ?? null;
}

/** Expand a leading `~`/`~/` via `homedir()`; pass an absolute path through. */
function expandTilde(entry: string): string {
  const home = homedir();
  if (entry === "~") {
    return home;
  }
  if (entry.startsWith("~/")) {
    return join(home, entry.slice(2));
  }
  return entry;
}

/**
 * Resolve configured plan roots to absolute paths: tilde-expand, then
 * skip-and-log any non-existent/non-directory root so one bad root never
 * silences the others. Re-resolving picks up a root once it appears.
 */
export function resolvePlanRoots(): string[] {
  const home = homedir();
  const out: string[] = [];
  for (const entry of resolveConfig().roots) {
    const expanded =
      entry === "~"
        ? home
        : entry.startsWith("~/")
          ? join(home, entry.slice(2))
          : entry;
    try {
      if (statSync(expanded).isDirectory()) {
        out.push(expanded);
        continue;
      }
      console.error(
        `[keeper] plan root is not a directory, skipping: ${expanded}`,
      );
    } catch {
      console.error(`[keeper] plan root does not exist, skipping: ${expanded}`);
    }
  }
  return out;
}

/** Resolve `keeper repo create`'s destination root. Env wins, then config, then
 * `~/code`. Tilde is expanded; existence is not required because the verb can
 * create the destination parent. */
export function resolveRepoCreateRoot(): string {
  return expandTilde(
    firstNonEmpty(
      process.env.KEEPER_REPO_CREATE_ROOT,
      resolveConfig().repoCreateRoot,
    ) ?? DEFAULT_REPO_CREATE_ROOT,
  );
}

/** Resolve `keeper repo clone`'s destination root. Env wins, then config, then
 * `~/src`. Tilde is expanded; existence is not required. */
export function resolveRepoCloneRoot(): string {
  return expandTilde(
    firstNonEmpty(
      process.env.KEEPER_REPO_CLONE_ROOT,
      resolveConfig().repoCloneRoot,
    ) ?? DEFAULT_REPO_CLONE_ROOT,
  );
}

/** Resolve `keeper repo fork`'s destination root. Env wins, then config, then
 * `~/src`. Tilde is expanded; existence is not required. */
export function resolveRepoForkRoot(): string {
  return expandTilde(
    firstNonEmpty(
      process.env.KEEPER_REPO_FORK_ROOT,
      resolveConfig().repoForkRoot,
    ) ?? DEFAULT_REPO_FORK_ROOT,
  );
}

/**
 * Resolve the transcript watch root to an absolute path: tilde-expand only, NO
 * existence-filter (the root may not exist yet; the worker tolerates absence).
 */
export function resolveClaudeProjectsRoot(): string {
  const home = homedir();
  const entry =
    resolveConfig().claudeProjectsRoot ?? DEFAULT_CLAUDE_PROJECTS_ROOT;
  if (entry === "~") {
    return home;
  }
  if (entry.startsWith("~/")) {
    return join(home, entry.slice(2));
  }
  return entry;
}

/**
 * Resolve the agentusage state root to an absolute path. `KEEPER_AGENTUSAGE_ROOT`
 * env wins (the test-isolation seam — sandboxes the state dir + picker ledger so
 * a scrape/spawn test never touches the real `~/.local/state/agentusage/`); else
 * the `agentusage_root` config key; else the default. Tilde-expand only, NO
 * existence-filter (the usage-worker + scraper tolerate absence). Both the
 * consumer (usage-worker watch root) and the producer (scraper write dir + the
 * vendored picker's `setStateDir`) resolve through here so one override moves the
 * whole tree.
 */
export function resolveUsageRoot(): string {
  const override = process.env.KEEPER_AGENTUSAGE_ROOT;
  const entry =
    override && override.length > 0
      ? override
      : (resolveConfig().agentusageRoot ?? DEFAULT_AGENTUSAGE_ROOT);
  return expandTilde(entry);
}

/**
 * Resolve the statusLine leaf directory (fn-1024) — where `keeper statusline`
 * writes one `<token>.json` per session and the `statusline-worker` watches for
 * telemetry snapshots. `KEEPER_STATUSLINE_DIR` env wins (hermetic tests point it
 * at a tmpdir; the sink reads the same override); else
 * `~/.local/state/keeper/statusline/`, a sibling of the other keeper state dirs.
 * MUST resolve byte-for-byte to `resolveStatuslineDir` in
 * `cli/statusline.ts` — the command writes the leaves, the worker reads them;
 * the sink keeps its own copy because it cannot import `bun:sqlite`/`src/db.ts`.
 */
export function resolveStatuslineRoot(): string {
  const override = process.env.KEEPER_STATUSLINE_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "statusline");
}

/**
 * `KEEPER_DEAD_LETTER_DIR` env wins; else `~/.local/state/keeper/dead-letters`.
 * MUST match `resolveDeadLetterDir` in
 * `plugins/keeper/plugin/hooks/events-writer.ts` byte-for-byte (hook writes the
 * NDJSON, daemon reads it) — the hook keeps its own copy because it cannot
 * import `bun:sqlite`.
 */
export function resolveDeadLetterDir(): string {
  const override = process.env.KEEPER_DEAD_LETTER_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "dead-letters");
}

/**
 * `KEEPER_EVENTS_LOG` env wins; else `~/.local/state/keeper/events-log`. The
 * hook appends a per-pid `<pid>.ndjson` line here; the daemon's ingester tails
 * the files into `events` rows. MUST match `resolveEventsLogDir` in
 * `plugins/keeper/plugin/hooks/events-writer.ts` byte-for-byte (the hook cannot
 * import `bun:sqlite`).
 */
export function resolveEventsLogDir(): string {
  const override = process.env.KEEPER_EVENTS_LOG;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "events-log");
}

/**
 * `KEEPER_BACKSTOP_LOG` env wins; else `~/.local/state/keeper/backstop.ndjson`.
 * Main is the SOLE writer; never read by the reducer, never feeds a projection.
 * Pure — does no I/O.
 */
export function resolveBackstopLogPath(): string {
  const override = process.env.KEEPER_BACKSTOP_LOG;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "backstop.ndjson");
}

/**
 * `KEEPER_RESTART_LEDGER` env wins; else `~/.local/state/keeper/restart-ledger.json`.
 * The durable crash-loop restart ledger: main appends each boot's timestamp here so a
 * self-restart storm is detectable from the NEXT boot. Deliberately a plain state-dir
 * sidecar, NOT keeper.db and NOT a fold — it must survive the very crash it measures.
 * Main is the SOLE reader/writer; never touches a projection or the reducer. Pure.
 */
export function resolveRestartLedgerPath(): string {
  const override = process.env.KEEPER_RESTART_LEDGER;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "restart-ledger.json");
}

/**
 * SQLite `SQLITE_MAX_VARIABLE_NUMBER` — `IN (?,?,...)` binds one variable per
 * id, so callers of `selectByIds` must chunk past this cap or cap their input.
 */
export const MAX_IN_PARAMS = 999;

const CREATE_EVENTS = `
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    session_id TEXT NOT NULL,
    pid INTEGER,
    hook_event TEXT NOT NULL,
    event_type TEXT NOT NULL,
    tool_name TEXT,
    matcher TEXT,
    cwd TEXT,
    permission_mode TEXT,
    agent_id TEXT,
    agent_type TEXT,
    stop_hook_active INTEGER,
    -- fn-717.2: data relaxed from NOT NULL to nullable. The hook still always
    -- writes a non-null data inline (single INSERT, must-exit-0 contract
    -- unchanged); nullability exists so the daemon-side compaction relocator
    -- (src/compaction.ts) can NULL the hot column AFTER copying the cold blob
    -- into the event_blobs side table. Every reducer data VALUE read resolves
    -- via COALESCE(events.data, event_blobs.data), so a relocated (now-NULL
    -- inline) blob folds byte-identically. A migrating pre-v58 DB gets the same
    -- relax via the stop-the-world rebuild in the v57->v58 migrate block
    -- (bun:sqlite hard-blocks the O(1) writable_schema schema-text edit, so the
    -- only mechanism is a full table rebuild -- a one-time, version-guarded,
    -- daemon-must-be-stopped migration; see the v57->v58 block for the measured
    -- multi-minute writer-lock hold on a ~1.6 GB DB).
    data TEXT,
    subagent_agent_id TEXT,
    spawn_name TEXT,
    start_time TEXT,
    slash_command TEXT,
    skill_name TEXT,
    planctl_op TEXT,
    planctl_target TEXT,
    planctl_epic_id TEXT,
    planctl_task_id TEXT,
    planctl_subject_present INTEGER,
    tool_use_id TEXT,
    config_dir TEXT,
    bash_mutation_kind TEXT,
    bash_mutation_targets TEXT,
    planctl_files TEXT,
    backend_exec_type TEXT,
    backend_exec_session_id TEXT,
    backend_exec_pane_id TEXT,
    background_task_id TEXT,
    -- v72->v73 (fn-836.2): the lone cross-event fold field of the git-attribution
    -- scan (data.tool_input.file_path) promoted to a column so the fold reads the
    -- column instead of parsing the JSON body. Hook-derived forward + ingester-
    -- recomputed for pre-deriver lines; NULL on every non-(PostToolUse, Write/Edit/
    -- MultiEdit/NotebookEdit) row. The expression index + COALESCE dual-read stay
    -- until .3 flips attribution onto this column.
    mutation_path TEXT,
    -- v93->v94 (fn-997.1): durable per-job worktree-lane BRANCH captured by the
    -- hook at SessionStart from KEEPER_PLAN_WORKTREE_BRANCH (NULL on every
    -- non-SessionStart / non-worktree row). Folded set-once onto jobs.worktree.
    worktree TEXT,
    -- v106->v107 (fn-1103.3): the launching harness ("claude"/"codex"/"pi"/
    -- "hermes") and its native resume target, both nullable TEXT. Part of the
    -- FIVE-place events lockstep (this literal, KNOWN_EVENT_COLUMNS, the hook
    -- insertBindings, INGEST_EVENTS_COLUMNS, the insertEvent prepared statement).
    -- The claude hook stamps harness "claude" at SessionStart; the fold copies
    -- the event's harness verbatim and NEVER synthesizes a value, so a legacy
    -- NULL-harness row reads as claude at every consumer. resume_target rides the
    -- SessionStart arm (claude/pi pin it at seed) OR a late ResumeTargetResolved
    -- back-fill (codex/hermes). Declared AFTER worktree so a fresh CREATE and a
    -- migrated ALTER (which appends) keep table_info byte-identical.
    harness TEXT,
    resume_target TEXT,
    -- v109->v110 (fn-1131.1): the harness-agnostic ADOPTED marker — 1 on a
    -- SessionStart a NON-launcher path minted (the hand-started hermes self-seed
    -- or the codex rollout-adoption mint), NULL otherwise. INTEGER, nullable, NO
    -- default (the NULL=absent + re-fold byte-identity invariant). Part of the
    -- SAME FIVE-place events lockstep as harness/resume_target (this literal,
    -- KNOWN_EVENT_COLUMNS, the hook insertBindings, INGEST_EVENTS_COLUMNS, the
    -- insertEvent prepared statement). The claude hook + every birth mint bind it
    -- NULL (launcher-owned by definition); the fold copies the value verbatim and
    -- never synthesizes one. Declared AFTER resume_target so a fresh CREATE and a
    -- migrated ALTER (which appends) keep table_info byte-identical.
    adopted INTEGER
)
`;

const CREATE_EVENTS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_hook_event ON events(hook_event)",
  "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_pid_hook_tool ON events(pid, hook_event, tool_name)",
  "CREATE INDEX IF NOT EXISTS idx_events_hook_tool_ts ON events(hook_event, tool_name, ts)",
  // Covering expression index for the explicit-attribution scan. The partial
  // WHERE + expression must match the consumer query EXACTLY so SQLite turns
  // the scan into a sub-ms covering SEEK. Pure perf — no SCHEMA_VERSION bump.
  "CREATE INDEX IF NOT EXISTS idx_events_tool_attr ON events(json_extract(data, '$.tool_input.file_path'), ts, session_id, tool_name, hook_event) WHERE hook_event = 'PostToolUse' AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')",
  // Partial index on the sparse subagent bridge column; the WHERE must match
  // consumer queries exactly.
  "CREATE INDEX IF NOT EXISTS idx_events_subagent_agent_id ON events(subagent_agent_id) WHERE subagent_agent_id IS NOT NULL",
];

/**
 * Indexes on columns added by the v9→v10 ALTER. KEPT OUT of
 * {@link CREATE_EVENTS_INDEXES} so the unconditional CREATE block never
 * references a column that doesn't exist yet on a migrating DB; `migrate()`
 * runs them after the matching ADD COLUMNs.
 */
const CREATE_V10_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_slash_command ON events(slash_command) WHERE slash_command IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_skill_name ON events(skill_name) WHERE skill_name IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_jobs_plan_ref ON jobs(plan_ref) WHERE plan_ref IS NOT NULL",
];

/**
 * Index on the `planctl_op` column added by the v13→v14 ALTER (KEPT OUT of the
 * unconditional CREATE block; see {@link CREATE_V10_INDEXES}). The composite
 * `(session_id, id) WHERE planctl_op IS NOT NULL` serves `syncPlanLinks`'s
 * per-session ordered scan; the WHERE must match consumer queries syntactically.
 */
const CREATE_V14_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_planctl_session ON events (session_id, id) WHERE planctl_op IS NOT NULL",
];

/**
 * Index on the `tool_use_id` column added by the v16→v17 ALTER (KEPT OUT of the
 * unconditional CREATE block; see {@link CREATE_V10_INDEXES}). Serves the
 * SubagentStart/Stop fold's `WHERE tool_use_id = ?` bridge join.
 */
const CREATE_V17_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_tool_use_id ON events(tool_use_id) WHERE tool_use_id IS NOT NULL",
];

/**
 * Index on the `background_task_id` column added by the v50→v51 ALTER (KEPT OUT
 * of the unconditional CREATE block; see {@link CREATE_V10_INDEXES}). The
 * composite `(session_id, background_task_id, id, tool_name)` partial index
 * serves the reducer's Stop-arm provenance scan; trailing `tool_name` makes it
 * covering.
 */
const CREATE_V51_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_background_task_id ON events(session_id, background_task_id, id, tool_name) WHERE background_task_id IS NOT NULL",
];

/**
 * Session-anchored partial index for the SubagentStart fold's pending-PreToolUse
 * bridge (`findPendingPreToolUseForStart` / `findBridgePreToolUse` in
 * `subagent-invocations.ts`). Without it the planner seeks the table-wide
 * `idx_events_hook_event (hook_event=?)` — every PreToolUse row in the DB per
 * SubagentStart — and folds the WHERE/ORDER cost onto main's writer lock.
 *
 * Leading `session_id` is the seek key; `id` next gives the `ORDER BY e.id ASC`
 * total order for free (no temp B-tree); trailing `tool_use_id` covers the
 * `tool_use_id IS NOT NULL` filter and the NOT-EXISTS anti-join correlation. The
 * `WHERE hook_event='PreToolUse' AND tool_name='Agent'` partial predicate keeps
 * the index tiny (the PreToolUse:Agent slice, not the full table), so the
 * planner prefers it decisively once stats land — the v65→v66 step runs
 * `ANALYZE events` after the CREATE so the migrating DB picks it up immediately.
 */
const CREATE_V66_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_pretooluse_agent_session ON events(session_id, id, tool_use_id) WHERE hook_event = 'PreToolUse' AND tool_name = 'Agent'",
];

/**
 * Partial index on the v72→v73 `events.mutation_path` column (KEPT OUT of the
 * unconditional CREATE block; see {@link CREATE_V10_INDEXES} — the column
 * doesn't exist yet on a migrating DB until the matching ADD COLUMN runs). The
 * leading-column layout mirrors `idx_events_tool_attr` (the existing expression
 * index): `(mutation_path, ts, session_id, tool_name, hook_event)` covers the
 * git-attribution exact-match SEEK that `.3` will flip onto the column. The
 * `WHERE mutation_path IS NOT NULL` partial predicate keeps it small (only the
 * file-mutating tool slice). Built alongside the expression index — both stay
 * + dual-read until `.3` flips the fold off the blob.
 */
const CREATE_V73_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_mutation_path ON events(mutation_path, ts, session_id, tool_name, hook_event) WHERE mutation_path IS NOT NULL",
];

/**
 * Partial COVERING index on the v106→v107 `events.tmux_generation_id` VIRTUAL
 * generated column (KEPT OUT of the unconditional CREATE block; see
 * {@link CREATE_V10_INDEXES} — the generated column doesn't exist yet on a
 * migrating DB until the matching ALTER runs). Serves the bounded
 * generation-summary walk in `src/restore-set.ts` (`GENERATION_SUMMARY_SQL`):
 * `GROUP BY tmux_generation_id ORDER BY MAX(id) DESC` over the
 * `TmuxTopologySnapshot` slice. The leading `tmux_generation_id` gives the
 * GROUP BY its ordered walk (no temp b-tree); trailing `id`, `ts` cover every
 * aggregate the walk reads (MIN/MAX id, MIN/MAX ts) so it stays index-only
 * (`SCAN ... USING COVERING INDEX`, never a table SCAN). Indexing a generated
 * column as a plain column removes SQLite's exact-expression-text
 * index-matching footgun — any column-name query hits it. The
 * `WHERE hook_event = 'TmuxTopologySnapshot'` partial predicate keeps it tiny
 * (the snapshot slice only) and lets the covering read skip re-checking
 * `hook_event` from the row.
 */
const CREATE_V107_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_tmux_generation ON events(tmux_generation_id, id, ts) WHERE hook_event = 'TmuxTopologySnapshot'",
];

/**
 * `subagent_invocations` projection table. `turn_seq` is the per-job monotone
 * turn counter so re-entrant subagents in a session land on distinct rows.
 * Defaults match the zero-event projection.
 */
const CREATE_SUBAGENT_INVOCATIONS = `
CREATE TABLE IF NOT EXISTS subagent_invocations (
    job_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    turn_seq INTEGER NOT NULL,
    ts REAL NOT NULL,
    tool_use_id TEXT,
    subagent_type TEXT,
    description TEXT,
    prompt_chars INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    duration_ms INTEGER,
    last_disposition TEXT,
    last_event_id INTEGER NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (job_id, agent_id, turn_seq)
)
`;

const CREATE_SUBAGENT_INVOCATIONS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_subagent_invocations_job ON subagent_invocations(job_id)",
];

/**
 * `scheduled_tasks` projection table (schema v68 / fn-813). One row per cron a
 * Claude session armed via `CronCreate`, keyed `(job_id, cron_id)`. Folded from
 * the `CronCreate` / `CronDelete` `PostToolUse` pair; `CREATE TABLE IF NOT
 * EXISTS` is idempotent so no version guard (v57 `event_blobs` precedent).
 * Defaults match the zero-event projection.
 */
const CREATE_SCHEDULED_TASKS = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
    job_id TEXT NOT NULL,
    cron_id TEXT NOT NULL,
    cron TEXT NOT NULL DEFAULT '',
    human_schedule TEXT NOT NULL DEFAULT '',
    recurring INTEGER NOT NULL DEFAULT 0,
    durable INTEGER NOT NULL DEFAULT 0,
    prompt_summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    ts REAL NOT NULL,
    last_event_id INTEGER NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (job_id, cron_id)
)
`;

const CREATE_SCHEDULED_TASKS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_job ON scheduled_tasks(job_id)",
];

/**
 * Always-run indexes on `epics`. `idx_epics_default_visible` (partial on the
 * v32 `default_visible` VIRTUAL generated column) serves the default
 * no-wire-filter query — `epic_number ASC, epic_id` creation order — without a
 * SCAN or temp B-tree for the ORDER BY.
 */
const CREATE_EPICS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_epics_default_visible ON epics(default_visible, epic_number, epic_id) WHERE default_visible = 1",
];

/**
 * Partial composite indexes on `events` for `syncPlanLinks`'s cross-session
 * sweep. Paired with the UNION query rewrite in `src/reducer.ts`: the planner
 * picks ONE index per cross-column OR, so the UNION form SEARCHes both the
 * `_epic` and `_target` index instead of SCANning. Trailing `(session_id, id)`
 * keeps them covering. Pure perf — no SCHEMA_VERSION bump.
 */
const CREATE_EVENTS_PLANCTL_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_planctl_epic ON events(planctl_epic_id, session_id, id) WHERE planctl_op IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_planctl_target ON events(planctl_target, session_id, id) WHERE planctl_op IS NOT NULL",
];

/**
 * Index serving the default jobs query (`WHERE state NOT IN (...) ORDER BY
 * created_at DESC, job_id`). Shape is `(created_at DESC, job_id, state)` — a
 * `state`-leading key can't serve the `NOT IN` (negation isn't a contiguous
 * range), so `created_at DESC` leads to serve the ORDER BY and trailing `state`
 * makes it covering.
 */
const CREATE_JOBS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_jobs_created_state ON jobs(created_at DESC, job_id, state)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_pid ON jobs(pid)",
];

const CREATE_JOBS = `
CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    created_at REAL NOT NULL,
    cwd TEXT,
    pid INTEGER,
    state TEXT NOT NULL DEFAULT 'stopped',
    last_event_id INTEGER,
    updated_at REAL NOT NULL,
    title TEXT,
    title_source TEXT,
    transcript_path TEXT,
    start_time TEXT,
    plan_verb TEXT,
    plan_ref TEXT,
    epic_links TEXT NOT NULL DEFAULT '[]',
    last_api_error_at REAL,
    last_api_error_kind TEXT,
    last_input_request_at REAL,
    last_input_request_kind TEXT,
    config_dir TEXT,
    git_dirty_count INTEGER NOT NULL DEFAULT 0,
    git_unattributed_to_live_count INTEGER NOT NULL DEFAULT 0,
    git_orphan_count INTEGER NOT NULL DEFAULT 0,
    profile_name TEXT,
    name_history TEXT NOT NULL DEFAULT '[]',
    backend_exec_type TEXT,
    backend_exec_session_id TEXT,
    backend_exec_pane_id TEXT,
    monitors TEXT NOT NULL DEFAULT '[]',
    last_permission_prompt_at REAL,
    last_permission_prompt_kind TEXT,
    active_since REAL
)
`;
// NOTE: every jobs column added after `active_since` (close_kind, window_index,
// backend_exec_{generation,birth_session}_id, and v94 `worktree`) is
// migration-ONLY via addColumnIfMissing — NOT in this CREATE literal — so the
// fresh and migrated paths both append them in identical migration order and
// PRAGMA table_info stays byte-identical (test/db.test.ts parity asserts).

const CREATE_EPICS = `
CREATE TABLE IF NOT EXISTS epics (
    epic_id TEXT PRIMARY KEY,
    epic_number INTEGER,
    title TEXT,
    project_dir TEXT,
    status TEXT,
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0,
    tasks TEXT NOT NULL DEFAULT '[]',
    depends_on_epics TEXT NOT NULL DEFAULT '[]',
    jobs TEXT NOT NULL DEFAULT '[]',
    job_links TEXT NOT NULL DEFAULT '[]',
    last_validated_at TEXT,
    resolved_epic_deps TEXT,
    default_visible INTEGER NOT NULL GENERATED ALWAYS AS (CASE WHEN status IS NOT NULL AND status='open' THEN 1 ELSE 0 END) VIRTUAL,
    -- question: nullable TEXT, the epic-level parked-closer question (the
    -- keeper plan epic-question runtime overlay, folded like any other plan
    -- snapshot field). NULL = no parked question (the zero-event reading).
    -- Declared AFTER the VIRTUAL default_visible column so a fresh CREATE and
    -- a migrated ALTER TABLE ... ADD COLUMN (which always appends) produce
    -- byte-identical table_info/table_xinfo column order.
    question TEXT
)
`;

/**
 * `worktree_repo_status` projection table — the LIVE-ONLY operator surface for
 * the per-epic worktree-eligibility verdict (fn-1013). One row per epic the
 * autopilot reconciler marked `disabled` (a worktree-friendliness heuristic
 * downgrade → sequential shared-checkout dispatch), folded from a synthetic
 * `WorktreeRepoStatus` event the autopilot worker posts when the disabled set
 * changes.
 *
 * LIVE-ONLY by construction (in {@link LIVE_ONLY_PROJECTIONS}): the verdict is
 * fs-derived (a per-cycle filesystem probe), so it is DELIBERATELY excluded from
 * the deterministic-replayed byte-identical re-fold charter and wiped by
 * {@link rewindLiveProjection}; the reconciler re-emits it each cycle, so a wipe
 * is repopulated by the live producer (no boot-seed / skip-floor of its own — the
 * fold is a cheap full-set replace bounded by board size, never O(history)).
 *
 * `mode` is the dispatch shape (`serial` for a disabled repo); `reason` names the
 * disabling signal (a `worktree-disabled:*` string). The row carries NO
 * `dispatch_failures` involvement — `disabled` is a neutral, NON-error fallback.
 */
const CREATE_WORKTREE_REPO_STATUS = `
CREATE TABLE IF NOT EXISTS worktree_repo_status (
    epic_id TEXT PRIMARY KEY,
    repo_dir TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'serial',
    reason TEXT NOT NULL DEFAULT '',
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

/**
 * `lane_merged` projection table — the LIVE-ONLY "merge-landed observable".
 * One row per epic whose worktree lane branch (`keeper/epic/<id>`) the
 * autopilot reconciler probed as merged into the LOCAL default branch (an ancestor
 * of default, OR torn-down after the merge), folded from a synthetic `LaneMerged`
 * event the worker posts when the merged set changes. The durable signal the
 * planning daisy-chain needs ("author B against A's MERGED reality"), which
 * `complete` (done-AND-idle) does not guarantee in worktree mode — a dependent
 * lane is cut before the upstream's finalize merge lands.
 *
 * LIVE-ONLY by construction (in {@link LIVE_ONLY_PROJECTIONS}): the verdict is
 * git-derived (a per-cycle ancestry probe), so it is DELIBERATELY excluded from
 * the deterministic-replayed byte-identical re-fold charter and wiped by
 * {@link rewindLiveProjection}; the reconciler re-emits it each cycle, so a wipe
 * is repopulated by the live producer (no boot-seed / skip-floor of its own — the
 * fold is a cheap full-set replace bounded by board size, never O(history)).
 * Mirrors {@link CREATE_WORKTREE_REPO_STATUS}.
 */
const CREATE_LANE_MERGED = `
CREATE TABLE IF NOT EXISTS lane_merged (
    epic_id TEXT PRIMARY KEY,
    repo_dir TEXT NOT NULL DEFAULT '',
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

const CREATE_GIT_STATUS = `
CREATE TABLE IF NOT EXISTS git_status (
    project_dir TEXT PRIMARY KEY,
    branch TEXT,
    head_oid TEXT,
    upstream TEXT,
    ahead INTEGER,
    behind INTEGER,
    dirty_count INTEGER NOT NULL DEFAULT 0,
    orphaned_count INTEGER NOT NULL DEFAULT 0,
    dirty_files TEXT NOT NULL DEFAULT '[]',
    orphaned_files TEXT NOT NULL DEFAULT '[]',
    jobs TEXT NOT NULL DEFAULT '[]',
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

/**
 * `usage` projection table — one row per agentusage profile, folded from
 * `UsageSnapshot` / `UsageDeleted` events via a single-row UPSERT.
 *
 * Freshness fields (`fetched_at` etc.) are intentionally absent: both this
 * projection and the worker's change-gate ignore them so a fetch-only refresh
 * produces zero churn. Do NOT add a freshness column without re-reading the
 * freshness-exclusion discipline in `src/usage-worker.ts`.
 *
 * `last_rate_limit_at` / `last_rate_limit_session_id` are populated server-side
 * from `profiles` (joined on `profile_name = projectBasename(config_dir)`) and
 * are CARVED OUT of `projectUsageRow`'s ON CONFLICT clause so a `UsageSnapshot`
 * re-fold can't clobber a `RateLimited` fan-out. Symmetrically,
 * `rate_limit_lifts_at` / `last_usage_fold_at` ride the percentage path and are
 * carved out of the rate-limit fan-out's UPDATE. `last_usage_fold_at` is set
 * from the event `ts` (never `Date.now()`) only on successful-usage snapshots.
 */
const CREATE_USAGE = `
CREATE TABLE IF NOT EXISTS usage (
    id TEXT PRIMARY KEY,
    target TEXT,
    multiplier INTEGER,
    session_percent REAL,
    session_resets_at TEXT,
    week_percent REAL,
    week_resets_at TEXT,
    sonnet_week_percent REAL,
    sonnet_week_resets_at TEXT,
    codex_spark_session_percent REAL,
    codex_spark_session_resets_at TEXT,
    codex_spark_week_percent REAL,
    codex_spark_week_resets_at TEXT,
    last_rate_limit_at REAL,
    last_rate_limit_session_id TEXT,
    status TEXT,
    subscription_active INTEGER,
    account_state TEXT,
    error_type TEXT,
    error_message TEXT,
    error_at TEXT,
    error_kind TEXT,
    rate_limit_lifts_at TEXT,
    last_usage_fold_at REAL,
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

/**
 * `profiles` projection table — one row per Claude profile directory, keyed by
 * `config_dir`. The `''` sentinel collapses NULL `config_dir` → default
 * `~/.claude`; the PK is NOT NULL because SQLite treats multiple NULL PKs as
 * distinct (a nullable PK + `INSERT OR IGNORE` would not dedupe). Maintained by
 * the SessionStart seed fan-out and the `RateLimited`/`ApiError` fan-out, both
 * using `COALESCE(config_dir,'')` so a NULL-config rate limit lands on its seeded
 * row. `profile_name` is the `projectBasename(config_dir)` join key against
 * `usage.id` (the `!= ''` guard keeps sentinel rows out of the join). Both
 * fan-outs read only event payload + in-transaction `jobs.config_dir`.
 */
const CREATE_PROFILES = `
CREATE TABLE IF NOT EXISTS profiles (
    config_dir TEXT NOT NULL PRIMARY KEY,
    profile_name TEXT,
    last_rate_limit_at REAL,
    last_rate_limit_session_id TEXT,
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

/**
 * `epic_dep_edges` — the reverse adjacency list of `epics.depends_on_epics`,
 * one row per `(consumer_id, dep_token)` edge. `dep_token` is the RAW token
 * (not the resolved id), so the reverse lookup is resolution-independent and
 * handles ambiguity flips: a re-resolve finds every consumer whose dep could
 * match the new candidate. A from-scratch re-fold rebuilds it deterministically.
 */
const CREATE_EPIC_DEP_EDGES = `
CREATE TABLE IF NOT EXISTS epic_dep_edges (
    consumer_id TEXT NOT NULL,
    dep_token TEXT NOT NULL,
    PRIMARY KEY (consumer_id, dep_token)
)
`;

/**
 * Reverse-lookup index on `epic_dep_edges.dep_token`. The composite PK leads on
 * `consumer_id`; the reverse fan-out keys off `dep_token` alone, so it needs a
 * dedicated `dep_token`-first index or it would SCAN on every upstream snapshot.
 */
const CREATE_EPIC_DEP_EDGES_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_epic_dep_edges_dep_token ON epic_dep_edges(dep_token)",
];

/**
 * `dead_letters` OPERATIONAL sidecar table — one row per recovered hook-INSERT
 * failure. NOT a reducer projection: populated by the daemon's import scan of
 * the per-pid NDJSON files the hook writes on a dropped INSERT, never folded.
 * Records events that NEVER MADE IT into the event log, so a from-scratch
 * re-fold MUST NOT touch it. `dl_id` (the hook-generated UUID) is the import
 * idempotency key. The replay verb is the only `waiting → recovered` path: it
 * appends a real event from the saved `bindings` (re-using the dropped event's
 * `ts`) and flips status + stamps `recovered_at`/`replayed_event_id` in ONE
 * transaction.
 */
const CREATE_DEAD_LETTERS = `
CREATE TABLE IF NOT EXISTS dead_letters (
    dl_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    hook_event TEXT NOT NULL,
    ts REAL NOT NULL,
    dl_written_at REAL NOT NULL,
    pid INTEGER,
    bindings TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting',
    recovered_at REAL,
    replayed_event_id INTEGER,
    source_file TEXT
)
`;

/**
 * Index on `dead_letters(status, dl_written_at)` — serves both the board's
 * `status='waiting'` warn-count and the replay verb's oldest-waiting-first pick.
 */
const CREATE_DEAD_LETTERS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_dead_letters_status_written_at ON dead_letters(status, dl_written_at)",
];

/**
 * `dispatch_failures` projection table — durable stickiness for a failed
 * `(verb, id)` dispatch until a human retries (the reconciler is otherwise
 * stateless across restarts). A reducer projection (folded from synthetic
 * `DispatchFailed` / `DispatchCleared` events in the cursor-advance
 * transaction), so it goes in the re-fold reset DELETE list. `DispatchCleared`
 * (from the `retry_dispatch` RPC) is the only legal clear — never a direct
 * DELETE. `ts` / `created_at` are lifted from the event PAYLOAD (not `event.ts`,
 * not `Date.now()`) so the fold is re-fold-deterministic.
 */
const CREATE_DISPATCH_FAILURES = `
CREATE TABLE IF NOT EXISTS dispatch_failures (
    verb TEXT NOT NULL,
    id TEXT NOT NULL,
    reason TEXT NOT NULL,
    dir TEXT,
    ts REAL NOT NULL,
    last_event_id INTEGER NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (verb, id)
)
`;

/**
 * `pending_dispatches` projection table — launch-window double-dispatch
 * suppression. The reconciler mints a synthetic `Dispatched{verb,id,dir}` BEFORE
 * `ExecBackend.launch()` (a crash between mint and launch leaves a phantom row
 * that TTL'd-clears, preferable to double-dispatch); the reducer UPSERTs keyed
 * on `(verb, id)`. Discharged by SessionStart bind, `DispatchFailed`, or
 * `DispatchExpired`. Row PRESENCE is the signal — no status column. `dispatched_at`
 * is lifted from the event PAYLOAD (not `event.ts`/`Date.now()`); the TTL sweep
 * compares it against `Date.now()` IN MAIN, never in the fold.
 *
 * EPHEMERAL projection (`EPHEMERAL_PROJECTIONS`, fn-870) — in-flight launch-window
 * state, NOT replayed from history. The boot drain still folds historical
 * `Dispatched`/`DispatchExpired` events (the global cursor must advance for the
 * deterministic projections), but a `DELETE FROM pending_dispatches` runs AFTER
 * the drain and BEFORE serving, so the in-flight set starts empty every boot. This
 * is correct: the autopilot re-derives genuine in-flight launches from live
 * `jobs`/tmux panes, and empty-at-boot subsumes clearing any phantom row a
 * rewinding migration's full re-fold would otherwise resurrect (the v76→v79 jam:
 * weeks-old phantoms consumed the dispatch budget + per-root mutex). Because the
 * boot-truncate discards the folded set, this table is DELIBERATELY excluded from
 * the byte-identical re-fold charter. The sibling `dispatch_failures` /
 * `dispatch_never_bound` tables stay DETERMINISTIC-REPLAYED (genuinely re-fold-
 * deterministic + sticky-failure durability is intentional).
 */
const CREATE_PENDING_DISPATCHES = `
CREATE TABLE IF NOT EXISTS pending_dispatches (
    verb TEXT NOT NULL,
    id TEXT NOT NULL,
    dir TEXT,
    dispatched_at REAL NOT NULL,
    last_event_id INTEGER NOT NULL,
    PRIMARY KEY (verb, id)
)
`;

/**
 * `dispatch_never_bound` projection table — the never-bound circuit breaker's
 * per-`(verb, id)` consecutive-`DispatchExpired`-without-bind counter. A worker
 * the reconciler dispatches that spawns but never binds (no SessionStart for the
 * pair) TTL-expires, re-dispatches, expires again — forever. This row holds the
 * consecutive-expire count: `foldDispatchExpired` increments it (the
 * `pending_dispatches` DELETE that releases the re-dispatch slot is UNCHANGED, so
 * the count CANNOT live on that deleted row), and at K mints a sticky
 * `dispatch_failures(reason='never-bound')` the existing `failedKeys` arm
 * suppresses. RESET to zero (DELETE) on a successful bind (the SessionStart
 * discharge-on-bind gate) and on `DispatchCleared` (the `keeper autopilot retry`
 * clear path) — so a bind between expires never trips the breaker, and a retry
 * clears both the failure and the count. A reducer projection (re-fold reset
 * DELETE list); `last_event_id` is an event id, never wallclock, so the fold is
 * re-fold-deterministic. Row PRESENCE is incidental — the count is the signal.
 */
const CREATE_DISPATCH_NEVER_BOUND = `
CREATE TABLE IF NOT EXISTS dispatch_never_bound (
    verb TEXT NOT NULL,
    id TEXT NOT NULL,
    consecutive_expired INTEGER NOT NULL,
    last_event_id INTEGER NOT NULL,
    PRIMARY KEY (verb, id)
)
`;

/**
 * `dispatch_instant_death` projection table — the instant-death circuit breaker's
 * per-`(verb, id)` consecutive-instant-post-bind-death counter, the reducer-side
 * SIBLING of `dispatch_never_bound`. A dispatched worker that BINDS and reaches a
 * terminal `Killed` within a sub-minute post-bind lifetime (the wall the
 * never-bound breaker misses — a bind RESETS never-bound, so a bind-then-instant-
 * death re-dispatch loop never trips it) increments this count; at
 * {@link import("./reducer").INSTANT_DEATH_THRESHOLD} the fold mints a sticky
 * `dispatch_failures(reason='instant-death-breaker')` the `failedKeys` arm
 * suppresses, pausing that key's re-dispatch until `retry_dispatch`. Detection is
 * cause-AGNOSTIC (post-bind lifetime from event `ts` deltas only — no transcript
 * parsing, no `close_kind`/`kill_reason` filter). RESET to zero (DELETE) on any
 * NON-instant terminal for the key (a clean `SessionEnd`, or a long-lived
 * `Killed` — the worker did real work, the consecutive-fast-death streak is
 * broken) and on `DispatchCleared` (the retry clear path). A worker's SUCCESSFUL
 * bind is NOT a reset (unlike never-bound): the whole signal IS bind-then-die, so
 * the count must persist across the re-dispatch's bind. A reducer projection
 * (re-fold reset DELETE list); `last_event_id` is an event id, never wall-clock,
 * so the fold is re-fold-deterministic. Row PRESENCE is incidental — the count is
 * the signal.
 */
const CREATE_DISPATCH_INSTANT_DEATH = `
CREATE TABLE IF NOT EXISTS dispatch_instant_death (
    verb TEXT NOT NULL,
    id TEXT NOT NULL,
    consecutive_deaths INTEGER NOT NULL,
    last_event_id INTEGER NOT NULL,
    PRIMARY KEY (verb, id)
)
`;

/**
 * `dispatch_mint_gate` — the DURABLE producer-owned rate-limit gate at the
 * `Dispatched` mint site. One logical dispatch attempt can otherwise amplify into
 * N same-instant `Dispatched` event rows (pre-launch abort loops, restart storms,
 * the insert→fold gap). This table records the wall-clock (`minted_at`, unix-epoch
 * SECONDS) of the last minted event per `verb::id` `dispatch_key`; the mint site
 * reads it in the SAME transaction as the event insert and SUPPRESSES a re-mint of
 * the same key inside the gate window (`DISPATCH_MINT_GATE_WINDOW_MS`), so one
 * logical dispatch = one durable record.
 *
 * PRODUCER STATE, NOT a reducer projection — same class as `dead_letters`: it is
 * NEVER folded from events, so it is DELIBERATELY absent from
 * {@link EPHEMERAL_PROJECTIONS} (durable across restarts — the in-memory cooldown
 * is what stays ephemeral), from the rewinding-migration DELETE list, and from the
 * re-fold-equivalence comparison. `minted_at` is wall-clock a PRODUCER stamps, not
 * an event `ts`, so it never enters a fold. Rows age out via the producer TTL
 * sweep (`evictStaleDispatchMintGate`), and `retry_dispatch` clears a key's row so
 * the human fast-path is never swallowed.
 */
const CREATE_DISPATCH_MINT_GATE = `
CREATE TABLE IF NOT EXISTS dispatch_mint_gate (
    dispatch_key TEXT PRIMARY KEY,
    minted_at REAL NOT NULL
)
`;

/**
 * Read the `minted_at` (unix-epoch seconds) of the last minted `Dispatched` event
 * for `dispatchKey`, or `null` when the gate has no row. Producer helper — call it
 * INSIDE the mint transaction on main's writable connection so the read + the
 * conditional event insert are atomic.
 */
export function readDispatchMintGate(
  db: Database,
  dispatchKey: string,
): number | null {
  const row = db
    .query("SELECT minted_at FROM dispatch_mint_gate WHERE dispatch_key = ?")
    .get(dispatchKey) as { minted_at: number } | undefined;
  return row ? row.minted_at : null;
}

/**
 * Stamp (`INSERT ... ON CONFLICT DO UPDATE`) the gate row for `dispatchKey` with
 * `mintedAtSec` (unix-epoch seconds). Called only on the FRESH-mint branch, in the
 * same transaction as the event insert.
 */
export function upsertDispatchMintGate(
  db: Database,
  dispatchKey: string,
  mintedAtSec: number,
): void {
  db.query(
    `INSERT INTO dispatch_mint_gate (dispatch_key, minted_at)
     VALUES (?, ?)
     ON CONFLICT(dispatch_key) DO UPDATE SET minted_at = excluded.minted_at`,
  ).run(dispatchKey, mintedAtSec);
}

/**
 * DELETE the gate row for `dispatchKey` — the `retry_dispatch` / `DispatchCleared`
 * fast-path so a human retry (or a recover auto-clear) re-dispatches immediately
 * without waiting out the gate window.
 */
export function clearDispatchMintGate(db: Database, dispatchKey: string): void {
  db.query("DELETE FROM dispatch_mint_gate WHERE dispatch_key = ?").run(
    dispatchKey,
  );
}

/**
 * Prune every gate row older than `cutoffSec` (unix-epoch seconds). A row past the
 * window has long since stopped suppressing; this producer sweep bounds the table.
 * Returns the number of rows evicted.
 */
export function evictStaleDispatchMintGate(
  db: Database,
  cutoffSec: number,
): number {
  const res = db
    .query("DELETE FROM dispatch_mint_gate WHERE minted_at < ?")
    .run(cutoffSec);
  return Number(res.changes ?? 0);
}

/**
 * The transactional core of the `Dispatched` mint gate. Reads the gate row and,
 * INSIDE one `BEGIN IMMEDIATE` transaction on `db`, either SUPPRESSES (a re-mint of
 * `dispatchKey` whose frozen `minted_at` is within `windowMs` of `nowMs` — no gate
 * write, `onFreshMint` NOT called) or MINTS (stamps the gate at `nowMs` AND runs
 * `onFreshMint` — the event insert — atomically). Returns `{ suppressed }`.
 *
 * Suppression NEVER re-stamps the gate, so the window is absolute from the frozen
 * first mint. A throw from `onFreshMint` rolls back BOTH the gate stamp and the
 * insert (atomicity) and propagates — the caller treats it as a real failure, not
 * a suppression. `nowMs` and `windowMs` are milliseconds; `minted_at` is seconds.
 */
export function runDispatchMintGate(
  db: Database,
  dispatchKey: string,
  nowMs: number,
  windowMs: number,
  onFreshMint: () => void,
): { suppressed: boolean } {
  let suppressed = false;
  db.transaction(() => {
    const mintedAt = readDispatchMintGate(db, dispatchKey);
    if (mintedAt !== null && nowMs - mintedAt * 1000 < windowMs) {
      suppressed = true;
      return;
    }
    upsertDispatchMintGate(db, dispatchKey, nowMs / 1000);
    onFreshMint();
  }).immediate();
  return { suppressed };
}

/**
 * `block_escalations` projection table — the escalate-once LATCH for the daemon
 * block-escalation producer. A row exists for as long as a plan task is in
 * `runtime_status='blocked'`: the `TaskSnapshot` fold INSERTs the latch
 * (`status='pending'`, `blocked_since=event.id`) on the transition INTO blocked
 * and DELETEs it on the transition OUT, so an unblock→re-block re-arms the latch
 * exactly once — the `dispatch_never_bound` bind/clear reset analog. The producer
 * (task 3) walks the `pending` rows, mints `BlockEscalationRequested` (→
 * `status='requested'`) then `BlockEscalationAttempted` (→ `status='attempted'`,
 * `outcome` recorded), so the latch advances pending→requested→attempted and the
 * escalation fires exactly once per block instance.
 *
 * Category-AGNOSTIC: the fold tracks only the blocked transition + the escalation
 * events; the `TOOLING_FAILURE`-skip category gate lives in the PRODUCER, never
 * here. A reducer projection (DETERMINISTIC-replayed — in every rewind-and-redrain
 * DELETE list; NOT live-only, so a plain `DELETE`, never `rewindLiveProjection`).
 * `blocked_since` / `last_event_id` are event ids, never wall-clock, so the fold
 * is re-fold-deterministic.
 */
const CREATE_BLOCK_ESCALATIONS = `
CREATE TABLE IF NOT EXISTS block_escalations (
    epic_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    blocked_since INTEGER NOT NULL,
    status TEXT NOT NULL,
    outcome TEXT,
    last_event_id INTEGER NOT NULL,
    PRIMARY KEY (epic_id, task_id)
)
`;

/**
 * `epic_tombstones` projection table — a permanent "this epic was deleted"
 * record minted by `EpicDeleted` and cleared by a re-creating `EpicSnapshot`.
 * Every epic-shell-INSERT site consults it and skips the resurrection when a
 * tombstone is active, preventing the headerless scalar-NULL ghost row a later
 * job-side shell-INSERT would otherwise recreate. The full-scalar `EpicSnapshot`
 * INSERT is the CLEAR site, not a shell site. `deleted_at_event_id` is an
 * event-id, not wallclock, for re-fold determinism. Mint is ON CONFLICT DO
 * NOTHING (preserve first-observed); clear sits OUTSIDE the scalar carve-out so
 * it fires on every re-create deterministically. A reducer projection (re-fold
 * reset DELETE list).
 *
 * No GC: never drop a tombstone while the append-only log can still replay
 * events referencing that id — a re-fold without it would replay the
 * resurrection.
 */
const CREATE_EPIC_TOMBSTONES = `
CREATE TABLE IF NOT EXISTS epic_tombstones (
    epic_id TEXT PRIMARY KEY,
    deleted_at_event_id INTEGER NOT NULL
)
`;

/**
 * `handoffs` projection table — the durable record of a `keeper handoff`
 * enqueue (`HandoffRequested` → this row) plus the dispatcher's transactional-
 * outbox lifecycle. One row per handoff, keyed on `handoff_id`. `doc` carries
 * the contextful brief the dispatched fire-and-forget worker reads back via
 * `keeper handoff show <id>` — it rides inline in `events.data` (the canonical
 * fold source), so it MUST be capped at WRITE time (task .2), never re-truncated
 * here. `target_session` is the resolved tmux session the handoff-ee launches
 * into; `initiator_session` / `initiator_pane` are the raw initiator coords.
 * `initiator_job_id` / `callee_job_id` model the job→job handoff edge (NOT
 * epic-anchored): the callee is filled from the `handoff::<id>` `SessionStart`
 * bind. `claimed_at` is lifted from the dispatcher's marker event TS (an event
 * ts, never wall-clock) so the fold stays re-fold-deterministic;
 * `never_bound_count` is the consecutive-dispatch-without-bind counter the
 * level-triggered boot-recovery bind check (`handoff::<id>` SessionStart exists?)
 * resets on a successful bind.
 *
 * DETERMINISTIC-REPLAYED reducer projection: in EVERY rewind-and-redrain DELETE
 * block, NOT in `EPHEMERAL_PROJECTIONS` or `LIVE_ONLY_PROJECTIONS`. A
 * from-scratch re-fold replays the same `HandoffRequested` / dispatcher / bind
 * stream and re-derives byte-identical rows (empty on a pre-feature log).
 * `claimed_at` / `last_event_id` are event ids/ts, never wall-clock.
 */
const CREATE_HANDOFFS = `
CREATE TABLE IF NOT EXISTS handoffs (
    handoff_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    doc TEXT NOT NULL,
    title TEXT,
    target_session TEXT,
    target_dir TEXT,
    initiator_session TEXT,
    initiator_pane TEXT,
    initiator_job_id TEXT,
    callee_job_id TEXT,
    claimed_at REAL,
    never_bound_count INTEGER NOT NULL DEFAULT 0,
    last_event_id INTEGER NOT NULL
)
`;

/**
 * `event_blobs` cold-blob relocation side table — HISTORICAL (fn-836.4 shed it).
 * Created at v57 and read by the v67 Commit-trailer backfill, so a 0→latest
 * from-scratch walk still materializes it transiently; the v74 tail then DROPs
 * it (unconditionally, the `approvals` precedent) after restoring every keep-set
 * body back inline. No steady-state schema-setup CREATE references it anymore —
 * it exists ONLY during the historical ladder walk, never at head. Kept here
 * because the v57 ladder step still runs `db.run(CREATE_EVENT_BLOBS)`; do NOT
 * resurrect it in the unconditional CREATE block. `event_id` was a 1:1 FK to
 * `events(id)`.
 */
const CREATE_EVENT_BLOBS = `
CREATE TABLE IF NOT EXISTS event_blobs (
    event_id INTEGER PRIMARY KEY REFERENCES events(id),
    data TEXT NOT NULL
)
`;

/**
 * `autopilot_state` SINGLETON projection (`CHECK (id = 1)`) carrying the
 * autopilot pause flag + concurrency cap + mode as durable, viewer-readable
 * state. A reducer projection (re-fold reset DELETE list). The `CHECK (id = 1)`
 * makes a stray non-singleton write fail loudly instead of letting the viewer
 * read whichever row sorts first. `created_at` is preserved on UPSERT and
 * sourced from `event.ts` for re-fold determinism. `max_concurrent_jobs` is
 * RUNTIME-settable via the `set_autopilot_config` RPC → `AutopilotConfigSet`
 * event (NOT config-file-frozen); each singleton fold
 * (`foldAutopilotPaused`/`Mode`/`ConfigSet`, plus the legacy `CapSet`) preserves
 * the columns it does not own on conflict, so a toggle never clobbers a sibling.
 * No migration seed row, and NO boot-append: a fresh board simply has NO row,
 * which is correct — the reconciler/viewer resolve `max_concurrent_jobs ?? DEFAULT`
 * (unlimited) and the in-memory boots-paused default carries `paused`. The row
 * materializes lazily on the first pause/play/mode/config event; its INSERT path
 * defaults `paused=1`. The daemon does NOT re-pause at boot — it resumes the
 * durable `paused` flag — so an existing row's `paused` survives a restart
 * untouched (every fold's ON CONFLICT branch preserves it).
 */
const CREATE_AUTOPILOT_STATE = `
CREATE TABLE IF NOT EXISTS autopilot_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    paused INTEGER NOT NULL,
    last_event_id INTEGER NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    max_concurrent_jobs INTEGER,
    mode TEXT NOT NULL DEFAULT 'yolo',
    max_concurrent_per_root INTEGER,
    worktree_mode INTEGER,
    worktree_multi_repo INTEGER,
    codex_adoption INTEGER
)
`;

/**
 * `armed_epics` PRESENCE table — per-epic "armed" flag for autopilot `armed`
 * mode. Row PRESENCE means armed. Written by the `EpicArmed` fold (`armed:true`
 * INSERTs, `armed:false` DELETEs) AND pruned by the `EpicSnapshot` fold when an
 * epic folds to `status='done'`. A reducer projection (re-fold reset DELETE
 * list); starts empty on a fresh DB.
 */
const CREATE_ARMED_EPICS = `
CREATE TABLE IF NOT EXISTS armed_epics (
    epic_id TEXT PRIMARY KEY,
    last_event_id INTEGER NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
)
`;

/**
 * `builds` projection table — one row per registered buildbot builder, the
 * `keeper builds` dashboard surface. Keyed by builder NAME (`project`), stable
 * across master DB rebuilds where the numeric `builder_id` is not. Produced by
 * synthetic `BuildSnapshot` (UPSERT) / `BuildDeleted` (tombstone DELETE) events
 * the builds-worker mints from the buildbot REST API. A reducer projection
 * (re-fold deterministic, in the rewind-and-redrain DELETE list); starts empty
 * on a fresh DB — no backfill, the live poll repopulates it.
 *
 * `results` is NULL while a build is running (`complete:false`); `complete_at`
 * is NULL until the build finishes. `state_string` is projected for display but
 * EXCLUDED from the worker change-gate so a running→finished transition emits
 * exactly two events (start, finish). `updated_at` is the event `ts`, never a
 * wall-clock read (re-fold determinism).
 */
const CREATE_BUILDS = `
CREATE TABLE IF NOT EXISTS builds (
    project TEXT PRIMARY KEY,
    builder_id INTEGER,
    build_number INTEGER,
    complete INTEGER,
    results INTEGER,
    state_string TEXT,
    started_at REAL,
    complete_at REAL,
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0
)
`;

/**
 * `commit_trailer_facts` projection table — one row per `Commit` event whose
 * frozen payload carries a planctl trailer (`committer_session_id` +
 * `planctl_op` + `planctl_target` all non-null). The commit-trailer channel of
 * `syncPlanLinks` reads this `ORDER BY event_id ASC` instead of re-scanning
 * every `Commit` blob per swept session (the fn-807 fold fan-out). `event_id` is
 * the PK so the live fold's INSERT is idempotent under a re-fold; the two
 * composite indexes serve the per-session load and the per-epic sweep.
 *
 * A reducer projection (re-fold deterministic): {@link foldCommit} INSERTs the
 * row inside its own transaction whenever {@link extractCommit} yields the three
 * non-null facts — the SAME condition the commit-trailer loader / migration
 * backfill use, so live-fold and backfill rows are identical by construction. It
 * derives from `Commit` events ALONE (no cursor rewind needed at v66→v67).
 *
 * `committed_at_ms` is stored in MILLISECONDS as named (git's `%ct` * 1000); the
 * loader derives the classifier `ts = committed_at_ms / 1000`. `planctl_epic_id`
 * is `parsePlanRef(planctl_target)?.epic_id ?? null` — a task-form target folds
 * up to its epic, an epic-form target carries itself, an unparseable target
 * (which never survives `extractCommit`'s `planctl_target` gate) would be null.
 *
 * FORWARD-FACING: this is a reducer projection but is NOT in any
 * rewind-and-redrain DELETE list because it derives from `Commit` events alone
 * (a from-scratch re-fold reproduces it identically). Any FUTURE
 * rewind-and-redrain DELETE block that wipes link projections MUST add a
 * `DELETE FROM commit_trailer_facts` so the re-fold rebuilds it from id 0.
 */
const CREATE_COMMIT_TRAILER_FACTS = `
CREATE TABLE IF NOT EXISTS commit_trailer_facts (
    event_id INTEGER PRIMARY KEY,
    committer_session_id TEXT NOT NULL,
    planctl_op TEXT NOT NULL,
    planctl_target TEXT NOT NULL,
    planctl_epic_id TEXT,
    committed_at_ms INTEGER NOT NULL
)
`;

const CREATE_COMMIT_TRAILER_FACTS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_commit_trailer_facts_session ON commit_trailer_facts(committer_session_id, event_id)",
  "CREATE INDEX IF NOT EXISTS idx_commit_trailer_facts_epic ON commit_trailer_facts(planctl_epic_id, committer_session_id, event_id)",
];

/**
 * `event_ingest_offsets` — the NDJSON→events ingest cursor, one row per per-pid
 * `<pid>.ndjson` file. The offset advance commits in the SAME `BEGIN IMMEDIATE`
 * as the `events` INSERT — that atomic pairing is exactly-once across watcher
 * re-fires and daemon restarts. NOT a reducer projection (never folded, excluded
 * from the re-fold reset DELETE list); a daemon-side cursor UPSTREAM of the fold,
 * distinct from `reducer_state.last_event_id`. Keyed on `(path, inode)` because
 * APFS recycles inodes and pids reuse filenames; the size-vs-offset check in
 * `scanEventsLogDir` falls the offset to 0 on a truncate/replace. The offset
 * advances only past the last COMPLETE parseable line (strict torn-tail).
 */
const CREATE_EVENT_INGEST_OFFSETS = `
CREATE TABLE IF NOT EXISTS event_ingest_offsets (
    path TEXT NOT NULL,
    inode INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (path, inode)
)
`;

/**
 * `file_attributions` projection — one row per `(project_dir, session_id,
 * file_path)` triple recording an un-discharged mutation claim. A reducer
 * projection (re-fold deterministic). The discharge rule lives in the column
 * shape: a session is attributed iff `last_commit_at IS NULL OR last_commit_at <
 * last_mutation_at`; the row stays for the historical record and the readiness
 * pass filters by the inequality. The three-axis PK makes multi-attribution per
 * file (different worktrees / different sessions) distinct rows by design.
 *
 * `worktree_oid` / `worktree_mode` are the filter-correct git blob oid + mode of
 * the WORKTREE bytes, frozen into the event payload (no fold-time git probe) so
 * a re-fold is deterministic. A NULL on either (pre-feature row or a producer
 * hash/observe failure) falls back to timestamp discharge in `foldCommit`. The
 * mode pairs with the oid so a chmod-only dirty file isn't wrongly discharged.
 */
const CREATE_FILE_ATTRIBUTIONS = `
CREATE TABLE IF NOT EXISTS file_attributions (
    project_dir TEXT NOT NULL,
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    last_mutation_at REAL NOT NULL,
    last_commit_at REAL,
    op TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('tool','bash','inferred','plan')),
    last_event_id INTEGER,
    updated_at REAL NOT NULL DEFAULT 0,
    worktree_oid TEXT,
    worktree_mode TEXT,
    PRIMARY KEY (project_dir, session_id, file_path)
)
`;

/**
 * Indexes on `file_attributions`: `_file (project_dir, file_path)` serves the
 * per-file multi-attribution read; `_session (session_id)` serves the
 * per-session retraction walk on a `GitRootDropped`.
 */
const CREATE_FILE_ATTRIBUTIONS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_file_attributions_file ON file_attributions(project_dir, file_path)",
  "CREATE INDEX IF NOT EXISTS idx_file_attributions_session ON file_attributions(session_id)",
];

/**
 * Index on the `bash_mutation_kind` column added by the v30→v31 ALTER (KEPT OUT
 * of the unconditional CREATE block; see {@link CREATE_V10_INDEXES}). Covering
 * for the reducer's bash-attribution scan; the `IS NOT NULL` partial still
 * serves the equality/`IN` probes.
 */
const CREATE_V31_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_bash_attr ON events(bash_mutation_kind, bash_mutation_targets, ts, session_id) WHERE bash_mutation_kind IS NOT NULL",
];

const CREATE_REDUCER_STATE = `
CREATE TABLE IF NOT EXISTS reducer_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_event_id INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
)
`;

/**
 * Control row for the LIVE-ONLY git projection surface (`git_status` +
 * `file_attributions` + the 3 `jobs` git-counter columns). Singleton
 * (`CHECK id = 1`), mirroring {@link CREATE_REDUCER_STATE}.
 *
 * - `floor` — a monotonic `events.id` SKIP-FLOOR. Every git fold
 *   (`projectGitStatus` / `retractGitStatus` / `mintPlanFileAttributions` / the
 *   `foldCommit` discharge sub-blocks) NO-OPS for `event.id <= floor`. The global
 *   cursor still advances past those events (the other ~16 projections fold
 *   normally), so this is NOT a drain-SQL gate — it lives INSIDE `applyEvent` by
 *   event type. The boot-seed producer re-derives the whole surface ABOVE the
 *   floor, so replaying the 4.3M historical `GitSnapshot`/`Commit` events (the
 *   ~6-day `computeRepoBashWindows` self-join time-bomb) is skipped entirely.
 * - `seed_required` — 1 while the boot-seed is mid-flight (set before the
 *   per-root delete+reseed, cleared after the synthetic snapshot folds). On boot
 *   a stuck `seed_required = 1` (crash mid-seed, or a degraded git scan) forces a
 *   re-seed before serving so the surface is never left permanently empty.
 *
 * Both columns are PRODUCER/live-owned — they are DELIBERATELY excluded from the
 * re-fold byte-identical charter (see `LIVE_ONLY_PROJECTIONS`). A class-aware
 * rewind that wipes a live projection MUST reset `floor` to 0 and set
 * `seed_required = 1` (enforced by {@link rewindLiveProjection}), or the
 * historical GitSnapshots self-gate below the stale floor and the surface stays
 * empty forever.
 */
const CREATE_GIT_PROJECTION_STATE = `
CREATE TABLE IF NOT EXISTS git_projection_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    floor INTEGER NOT NULL DEFAULT 0,
    seed_required INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
)
`;

/**
 * LIVE-ONLY tmux topology skip-floor + seed flag (fn-907) — the twin of
 * {@link CREATE_GIT_PROJECTION_STATE}, governing the two live-owned `jobs`
 * location columns `backend_exec_session_id` + `window_index`. A keeperd
 * timer-poll producer reads `tmux list-panes -a` and mints one
 * `TmuxTopologySnapshot`; the live fold overwrites the two columns for events
 * `id > floor` only, while the boot-seed re-derives the surface and raises the
 * floor to the current `max(events.id)`.
 *
 * Both columns are PRODUCER/live-owned — DELIBERATELY excluded from the re-fold
 * byte-identical charter (they join {@link LIVE_ONLY_JOBS_COLUMNS}). A class-aware
 * rewind that wipes the live surface MUST reset `floor` to 0 and set
 * `seed_required = 1` (enforced by {@link rewindLiveProjection}), or the
 * historical snapshots self-gate below the stale floor and the location stays
 * frozen forever.
 */
const CREATE_TMUX_PROJECTION_STATE = `
CREATE TABLE IF NOT EXISTS tmux_projection_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    floor INTEGER NOT NULL DEFAULT 0,
    seed_required INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL
)
`;

/**
 * LIVE-ONLY singleton (fn-952) holding the current real (non-control) tmux
 * client's focused session/window/pane, as observed by keeperd's persistent
 * `tmux -C` control client. Singleton (`CHECK id = 1`), mirroring
 * {@link CREATE_REDUCER_STATE}.
 *
 * Pure LIVE-ONLY — NO floor, NO seed flag, NO boot-seed singleton row. Unlike
 * the git/tmux-topology surfaces, focus has NO replay-worthy history: the
 * control worker is the SOLE source of truth and re-bootstraps the whole focus
 * read on EVERY connect, so a cold DB simply has no row (the collection emits
 * `rows: []` and `keeper jobs` renders `[focus: none]`). The fold last-write-wins
 * UPSERTs id=1 from the worker's `TmuxClientFocusSnapshot` events; an empty log
 * leaves the table empty. Registered in {@link LIVE_ONLY_PROJECTIONS} so a
 * rewinding migration wipes it via {@link rewindLiveProjection}, never a bare
 * DELETE, and it is excluded from the byte-identical re-fold charter.
 *
 * `generation_id` is the tmux server generation the focus was read under
 * (discarded + re-read on every reconnect); `window_index` is the focused window's position;
 * `status` carries the worker's connection liveness ('connected' / 'disconnected'
 * / 'none'). `last_event_id` / `updated_at` are event id/ts, never wall-clock.
 */
const CREATE_TMUX_CLIENT_FOCUS = `
CREATE TABLE IF NOT EXISTS tmux_client_focus (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT,
    generation_id TEXT,
    session_name TEXT,
    window_index INTEGER,
    pane_id TEXT,
    last_event_id INTEGER,
    updated_at REAL
)
`;

/**
 * Projection-class taxonomy (Marten's "Live projection lifecycle"). The central
 * source of truth for which projection tables are LIVE-PRODUCER-FED — re-derived
 * by a boot-seed producer + kept current by incremental folds ABOVE a skip-floor,
 * NOT replayed from history, and DELIBERATELY excluded from the re-fold
 * byte-identical charter.
 *
 * Everything NOT listed here is **deterministic-replayed** (the sacred default —
 * `jobs`/`epics`/`commit_trailer_facts`/… reproduce byte-identical projection
 * rows on a from-scratch re-fold). The two `git_projection_state` control columns
 * (`floor`, `seed_required`) are **control** state, also charter-excluded.
 *
 * The carve-out exists because `projectGitStatus`'s `computeRepoBashWindows`
 * self-joins the WHOLE event log per `GitSnapshot` — an O(history)-per-event fold
 * whose replay cost grows without bound (the fn-856 incident: ~6 days over 4.3M
 * events). The general rule this codifies: any projection whose per-event fold
 * cost grows with history length is a replay time-bomb — model it live-only or
 * constant-bounded, never O(history)-per-event.
 *
 * Charter tests (`test/refold-equivalence.test.ts`) MUST exclude every table here
 * AND the 3 `jobs` git-counter columns enumerated in `LIVE_ONLY_JOBS_COLUMNS`
 * (the columns live INSIDE the otherwise-deterministic `jobs` table).
 */
export const LIVE_ONLY_PROJECTIONS = [
  "git_status",
  "file_attributions",
  // fn-952 — the tmux client-focus singleton. NO floor/seed of its own: the
  // control worker re-bootstraps focus on every connect, so a bare wipe (the
  // `rewindLiveProjection` loop's `DELETE FROM`) leaving the table empty is the
  // correct rewind — no floor to reset, no seed flag to raise.
  "tmux_client_focus",
  // fn-1013 — the per-epic worktree-eligibility operator surface. The verdict is
  // fs-derived (a per-cycle filesystem probe), so it must NOT be deterministic-
  // replayed; the autopilot reconciler re-emits it each cycle, so the bare
  // `rewindLiveProjection` wipe (no floor/seed of its own) is repopulated by the
  // live producer — the same shape as `tmux_client_focus`.
  "worktree_repo_status",
  // The merge-landed observable. The verdict is git-derived (a per-cycle
  // lane-is-ancestor-of-default probe), so it must NOT be deterministic-replayed;
  // the reconciler re-emits it each cycle, so the bare `rewindLiveProjection` wipe
  // (no floor/seed of its own) is repopulated by the live producer — the same
  // shape as `worktree_repo_status`.
  "lane_merged",
] as const;

/**
 * EPHEMERAL projection tables (fn-870) — in-flight RUNTIME state rebuilt from
 * current reality at boot, NEVER replayed from history. Distinct from the
 * LIVE-ONLY git surface above: an ephemeral table is folded by the boot drain
 * like any reducer projection (the global cursor must advance for the
 * deterministic projections), but a `DELETE FROM <table>` runs AFTER the drain
 * and BEFORE serving, so the runtime set starts empty every boot.
 *
 * `pending_dispatches` is the launch-window double-dispatch suppression set: the
 * autopilot re-derives genuine in-flight launches from live `jobs`/tmux panes, so
 * empty-at-boot is correct and subsumes clearing any phantom row a rewinding
 * migration's full re-fold would otherwise resurrect (the v76→v79 dispatch jam).
 *
 * Single source of truth shared by the daemon boot-truncate slot and the re-fold
 * charter exclusion (`test/refold-equivalence.test.ts`): every table here is
 * DELIBERATELY excluded from the byte-identical re-fold comparison because the
 * boot-truncate discards the folded set.
 */
export const EPHEMERAL_PROJECTIONS = ["pending_dispatches"] as const;

/**
 * Truncate every {@link EPHEMERAL_PROJECTIONS} table. Call this in the daemon boot
 * AFTER the boot drain (so live folds have applied) and BEFORE serving (so no
 * consumer ever observes a resurrected phantom). Idempotent.
 */
export function truncateEphemeralProjections(db: Database): void {
  for (const table of EPHEMERAL_PROJECTIONS) {
    db.run(`DELETE FROM ${table}`);
  }
}

/**
 * The live-producer-fed columns embedded in the otherwise-deterministic `jobs`
 * projection, so the charter byte-identical comparison of `jobs` MUST blank these
 * columns before comparing. Two live surfaces share the list:
 *   - the 3 git-derived counters (fn-867: display-only since the readiness
 *     predicate that read them was deleted), re-seeded by the git boot-seed's
 *     per-root reset; and
 *   - the 2 tmux LOCATION columns (fn-907): `backend_exec_session_id` +
 *     `window_index`, re-derived by the `TmuxTopologySnapshot` live fold above
 *     `tmux_projection_state.floor` + the tmux boot-seed. These were
 *     deterministic-replayed before v83; flipping them live-only takes them OUT
 *     of the byte-identical charter (the frozen launch env now writes the
 *     forensic `backend_exec_birth_session_id` instead).
 */
export const LIVE_ONLY_JOBS_COLUMNS = [
  "git_dirty_count",
  "git_unattributed_to_live_count",
  "git_orphan_count",
  "backend_exec_session_id",
  "window_index",
] as const;

/**
 * Class-aware rewind of the LIVE-ONLY git surface. ENFORCES the coupling that a
 * raw `DELETE FROM git_status` cannot: wiping the live tables WITHOUT resetting
 * the skip-floor would leave the surface permanently empty — every historical
 * `GitSnapshot` self-gates below the stale floor, so nothing repopulates it.
 *
 * This helper:
 *   1. wipes every `LIVE_ONLY_PROJECTIONS` table + zeroes the 3 jobs git-counters,
 *   2. resets `floor = 0` so a subsequent re-fold's git folds run again, AND
 *   3. sets `seed_required = 1` so the boot-seed re-derives the surface even if
 *      the re-fold path doesn't cover every currently-dirty root.
 *
 * Call this anywhere a migration rewinds-and-redrains a step that wipes the git
 * surface (in place of the bare `DELETE FROM git_status; DELETE FROM
 * file_attributions` pair). Idempotent. The caller still owns the cursor rewind
 * (`reducer_state.last_event_id = 0`) for the DETERMINISTIC projections — that is
 * a separate concern from the live surface and stays explicit at the call site.
 */
function rewindLiveProjection(db: Database): void {
  for (const table of LIVE_ONLY_PROJECTIONS) {
    db.run(`DELETE FROM ${table}`);
  }
  // Zero the embedded live-only jobs columns (the boot-seed/live folds re-derive
  // them). A `jobs` rewind that DELETEs the whole table covers this too, but the
  // columns are live-owned so we reset them explicitly here for the case where
  // `jobs` is NOT being wiped alongside. The 3 git counters live in `CREATE_JOBS`
  // (always present) and reset to 0.
  db.run(
    `UPDATE jobs SET git_dirty_count = 0, git_unattributed_to_live_count = 0, git_orphan_count = 0`,
  );
  // The 2 tmux location columns (fn-907) are added by LATER migration ALTERs
  // (`backend_exec_session_id` at v48, `window_index` at v71), so an EARLY
  // rewinding step in the 0→latest ladder runs this helper BEFORE they exist.
  // Reset them only when present — NULL is the "unknown location" zero-value the
  // boot-seed + `TmuxTopologySnapshot` fold overwrite. Same guard for
  // `tmux_projection_state` (created at v83): a pre-v83 rewind step must not throw
  // on a missing control table.
  const jobsCols = new Set(
    (db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (jobsCols.has("backend_exec_session_id")) {
    db.run(`UPDATE jobs SET backend_exec_session_id = NULL`);
  }
  if (jobsCols.has("window_index")) {
    db.run(`UPDATE jobs SET window_index = NULL`);
  }
  db.run(
    `UPDATE git_projection_state
        SET floor = 0, seed_required = 1, updated_at = unixepoch('now', 'subsec')
      WHERE id = 1`,
  );
  // The tmux live surface is reset in lockstep with the git surface: a rewind
  // that wipes the live location columns WITHOUT resetting the tmux floor would
  // leave them frozen — every historical TmuxTopologySnapshot self-gates below
  // the stale floor. Guarded on table existence for the same pre-v83-ladder reason.
  const tmuxStateExists =
    (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tmux_projection_state'",
        )
        .all() as { name: string }[]
    ).length > 0;
  if (tmuxStateExists) {
    db.run(
      `UPDATE tmux_projection_state
          SET floor = 0, seed_required = 1, updated_at = unixepoch('now', 'subsec')
        WHERE id = 1`,
    );
  }
}

/**
 * Read the LIVE-ONLY git-projection skip-floor. Every git fold no-ops for
 * `event.id <= floor`. Returns 0 when the control row is missing (a pre-v79 /
 * mid-migrate read) so folds run unconditionally rather than silently gating —
 * fail-open on the floor, never fail-empty.
 */
export function readGitProjectionFloor(db: Database): number {
  const row = db
    .query("SELECT floor FROM git_projection_state WHERE id = 1")
    .get() as { floor: number } | null;
  return row?.floor ?? 0;
}

/**
 * Read whether the boot-seed must (re-)derive the git surface before serving.
 * `true` when the control row says so OR when the row is absent (treat a missing
 * control row as "needs seeding" — fail-safe toward re-deriving). The daemon
 * boot-seed checks this and the migration sets it on every v→v79 upgrade.
 */
export function readGitProjectionSeedRequired(db: Database): boolean {
  const row = db
    .query("SELECT seed_required FROM git_projection_state WHERE id = 1")
    .get() as { seed_required: number } | null;
  return row == null ? true : row.seed_required !== 0;
}

/**
 * Set `seed_required`. The boot-seed producer sets it `true` before its per-root
 * delete+reseed and clears it `false` after the synthetic snapshot folds, so a
 * crash mid-seed leaves it set and the next boot re-seeds.
 */
export function setGitProjectionSeedRequired(
  db: Database,
  required: boolean,
): void {
  db.run(
    `UPDATE git_projection_state
        SET seed_required = ?, updated_at = unixepoch('now', 'subsec')
      WHERE id = 1`,
    [required ? 1 : 0],
  );
}

/**
 * Raise the skip-floor to `max(floor, newFloor)`. Monotonic — never lowers the
 * floor (a stale producer can't reopen the historical replay). The boot-seed
 * reads `max(events.id)` BEFORE its git scan and persists THAT as the floor in
 * the same step it clears `seed_required`, so events that arrived DURING the scan
 * (id > the captured floor) re-apply idempotently via the live fold.
 */
export function raiseGitProjectionFloor(db: Database, newFloor: number): void {
  db.run(
    `UPDATE git_projection_state
        SET floor = max(floor, ?), updated_at = unixepoch('now', 'subsec')
      WHERE id = 1`,
    [newFloor],
  );
}

/**
 * Read the LIVE-ONLY tmux-projection skip-floor (fn-907). The `TmuxTopologySnapshot`
 * fold no-ops for `event.id <= floor`. Returns 0 when the control row is missing
 * (a pre-v83 / mid-migrate read) so folds run unconditionally rather than silently
 * gating — fail-open on the floor, never fail-empty. Twin of
 * {@link readGitProjectionFloor}.
 */
export function readTmuxProjectionFloor(db: Database): number {
  const row = db
    .query("SELECT floor FROM tmux_projection_state WHERE id = 1")
    .get() as { floor: number } | null;
  return row?.floor ?? 0;
}

/**
 * Read whether the boot-seed must (re-)derive the tmux location surface before
 * serving. `true` when the control row says so OR when the row is absent (treat a
 * missing control row as "needs seeding" — fail-safe toward re-deriving). Twin of
 * {@link readGitProjectionSeedRequired}.
 */
export function readTmuxProjectionSeedRequired(db: Database): boolean {
  const row = db
    .query("SELECT seed_required FROM tmux_projection_state WHERE id = 1")
    .get() as { seed_required: number } | null;
  return row == null ? true : row.seed_required !== 0;
}

/**
 * Set the tmux `seed_required` flag. The boot-seed producer sets it `true` before
 * its re-derive and clears it `false` after the synthetic snapshot folds, so a
 * crash mid-seed leaves it set and the next boot re-seeds. Twin of
 * {@link setGitProjectionSeedRequired}.
 */
export function setTmuxProjectionSeedRequired(
  db: Database,
  required: boolean,
): void {
  db.run(
    `UPDATE tmux_projection_state
        SET seed_required = ?, updated_at = unixepoch('now', 'subsec')
      WHERE id = 1`,
    [required ? 1 : 0],
  );
}

/**
 * Raise the tmux skip-floor to `max(floor, newFloor)`. Monotonic — never lowers
 * the floor (a stale producer can't reopen the historical replay). Twin of
 * {@link raiseGitProjectionFloor}.
 */
export function raiseTmuxProjectionFloor(db: Database, newFloor: number): void {
  db.run(
    `UPDATE tmux_projection_state
        SET floor = max(floor, ?), updated_at = unixepoch('now', 'subsec')
      WHERE id = 1`,
    [newFloor],
  );
}

const CREATE_META = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)
`;

/**
 * Prepared statements pre-bound on the hot paths. Keep these tiny — the hook's
 * cold-start latency is part of the SessionEnd timeout budget.
 */
export interface Stmts {
  insertEvent: ReturnType<Database["prepare"]>;
  selectWorldRev: ReturnType<Database["prepare"]>;
}

export interface OpenDbOptions {
  readonly?: boolean;
  /**
   * Run `migrate(db)` after opening. Defaults `true` for writers; readers always
   * skip. The hook passes `false` — the daemon is the SOLE migrator.
   */
  migrate?: boolean;
  /**
   * Connection-local `busy_timeout` in ms. Set FIRST in {@link applyPragmas} so
   * the WAL switch waits instead of failing under contention. The hook passes a
   * tighter value to stay inside its SessionEnd budget.
   */
  busyTimeoutMs?: number;
  /**
   * Per-connection page-cache cap in KB (negative `PRAGMA cache_size`). The
   * daemon passes a large value to retain hot pages across folds; omit on the
   * short-lived hook.
   */
  cacheSizeKb?: number;
  /**
   * Build the {@link Stmts} bundle. Defaults `true`. The hook passes `false`
   * because the static `insertEvent` names every events column, which throws on
   * a schema-skewed live DB before the daemon migrates; the hook builds a
   * column-adaptive INSERT instead.
   */
  prepareStmts?: boolean;
  /**
   * Bounded retry of the WHOLE open span on a transient BOOT-class error
   * ({@link isTransientBootOpenError}), with a FRESH {@link Database} per
   * attempt. Workers pass `true`: ~9 threads construct a `Database` on the
   * just-migrated file at once, exercising bun:sqlite's known concurrent-open
   * race (#29277) and the WAL/shm recovery path. Defaults `false` — main never
   * sets it (a failure there is real). NOT in-process self-heal: bounded,
   * initial-open-only, transient-class-only, still fails loud after exhaustion.
   * `true` uses the defaults; pass `{ attempts, baseMs }` to override.
   */
  bootRetry?: boolean | { attempts?: number; baseMs?: number };
  /**
   * TEST-ONLY seam. Fires at the START of every open-span attempt with the
   * 1-based attempt number, BEFORE the Database is constructed. The only
   * deterministic way to exercise the `bootRetry` transient-then-success path
   * (a test creates the schema on attempt 2, turning a "no such table" failure
   * into a success) and to count attempts. Never set in production.
   */
  _beforeAttempt?: (attempt: number) => void;
}

export interface KeeperDb {
  db: Database;
  stmts: Stmts;
}

/**
 * Apply connection-local PRAGMAs. Called on every open (writer + reader). WAL +
 * `synchronous = NORMAL` is the only safe mode for the hook+daemon pattern;
 * `foreign_keys = ON` because bun:sqlite does not auto-enable. `busy_timeout`
 * MUST be re-set per connection (the hook re-spawns each invocation).
 */
export function applyPragmas(
  db: Database,
  busyTimeoutMs = 5000,
  cacheSizeKb?: number,
): void {
  // busy_timeout FIRST — the WAL switch below needs a brief write lock and
  // would fail INSTANTLY with SQLITE_BUSY under any concurrent writer at the
  // SQLite default of 0.
  db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA temp_store = MEMORY");
  // mmap serves resident pages from the OS page cache (removes read() syscall
  // overhead, not the first cold read), so it pairs with cache_size below.
  db.run("PRAGMA mmap_size = 4294967296");
  // Large per-connection page cache (negative = KB cap). Only the daemon passes
  // this so it retains hot pages across folds; the hook keeps the small default.
  if (cacheSizeKb != null && cacheSizeKb > 0) {
    db.run(`PRAGMA cache_size = -${cacheSizeKb}`);
  }
}

/**
 * Add a column only if absent. The migrate block runs every boot and a fresh
 * DB's CREATE TABLE already defines new columns, so a `PRAGMA table_info` check
 * makes the ALTER an idempotent no-op when the column exists.
 */
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  columnDef: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (cols.some((c) => c.name === column)) {
    return;
  }
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
}

/**
 * {@link addColumnIfMissing} for a GENERATED ALWAYS column. The presence check
 * MUST read `PRAGMA table_xinfo` (not `table_info`, which excludes generated
 * columns) or the ALTER re-fires every boot and throws "duplicate column".
 * SQLite allows only `VIRTUAL` via ALTER, so `columnDef` must carry the
 * `GENERATED ALWAYS AS (...) VIRTUAL` clause.
 */
function addGeneratedColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  columnDef: string,
): void {
  const cols = db.prepare(`PRAGMA table_xinfo(${table})`).all() as {
    name: string;
  }[];
  if (cols.some((c) => c.name === column)) {
    return;
  }
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
}

/**
 * Drop a column only if present — the idempotent mirror of
 * {@link addColumnIfMissing} (no-ops once the column is gone).
 */
function dropColumnIfPresent(
  db: Database,
  table: string,
  column: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    return;
  }
  db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

/**
 * Rename a column only if the OLD name is present AND the NEW name is not.
 * Quad-state idempotent: old-present/new-absent runs the ALTER; every other
 * combination no-ops — including old-present/new-present, which is the fresh-DB
 * lockstep case (the CREATE_TABLE literal already carries both names).
 */
function renameColumnIfPresent(
  db: Database,
  table: string,
  oldName: string,
  newName: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  const hasOld = cols.some((c) => c.name === oldName);
  const hasNew = cols.some((c) => c.name === newName);
  if (!hasOld) {
    return;
  }
  if (hasNew) {
    return; // fresh-DB lockstep: CREATE_TABLE literal already carries both
  }
  db.run(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`);
}

/**
 * Chunked backfill for `resolved_epic_deps` + `epic_dep_edges` on existing
 * `epics` rows, run OUTSIDE the main migrate transaction so the WAL writer lock
 * is released between chunks (concurrent hook INSERTs never starve). Idempotent
 * (the resolver is a pure function of the live `epics` table) and version-guarded
 * to fire only on the upgrade boot. Produces the SAME projection a from-scratch
 * re-fold would: the resolver's `now` is each epic's persisted `updated_at`
 * (never `Date.now()`/env), and only affects a diagnostic ts that isn't written.
 */
const BACKFILL_CHUNK_SIZE = 200;

function backfillResolvedEpicDeps(db: Database): void {
  // LIMIT/OFFSET pagination is stable: the backfill writes only columns outside
  // the ORDER BY and never inserts/deletes epics rows.
  const epicIdsRow = db
    .prepare("SELECT epic_id FROM epics ORDER BY epic_id ASC")
    .all() as { epic_id: string }[];
  if (epicIdsRow.length === 0) {
    return;
  }
  const allEpicIds = epicIdsRow.map((r) => r.epic_id);

  // Build the all-epics index ONCE: the resolver-relevant columns are stable
  // across the backfill (the chunked UPDATEs touch only columns the resolver
  // doesn't read). Re-implemented inline (not the reducer's `buildEpicIndex`) so
  // db.ts stays cycle-free, but field-for-field identical so a re-fold matches.
  type BackfillEpicRow = {
    epic_id: string;
    epic_number: number | null;
    project_dir: string | null;
    status: string | null;
    depends_on_epics: string | null;
    updated_at: number;
  };
  const indexRows = db
    .prepare(
      `SELECT epic_id, epic_number, project_dir, status
         FROM epics`,
    )
    .all() as Omit<BackfillEpicRow, "depends_on_epics" | "updated_at">[];
  const epicById = new Map<string, Epic>();
  const epicsByNumber = new Map<number, Epic[]>();
  for (const row of indexRows) {
    const epic: Epic = {
      epic_id: row.epic_id,
      epic_number: row.epic_number,
      title: null,
      project_dir: row.project_dir,
      status: row.status,
      last_event_id: null,
      updated_at: 0,
      depends_on_epics: [],
      tasks: [],
      jobs: [],
      job_links: [],
      last_validated_at: null,
      resolved_epic_deps: null,
      question: null,
    };
    epicById.set(row.epic_id, epic);
    if (row.epic_number != null) {
      const bucket = epicsByNumber.get(row.epic_number);
      if (bucket == null) {
        epicsByNumber.set(row.epic_number, [epic]);
      } else {
        bucket.push(epic);
      }
    }
  }
  for (const bucket of epicsByNumber.values()) {
    bucket.sort((a, b) =>
      a.epic_id < b.epic_id ? -1 : a.epic_id > b.epic_id ? 1 : 0,
    );
  }

  let offset = 0;
  while (offset < allEpicIds.length) {
    const slice = allEpicIds.slice(offset, offset + BACKFILL_CHUNK_SIZE);
    db.transaction(() => {
      const placeholders = slice.map(() => "?").join(",");
      const chunkRows = db
        .prepare(
          `SELECT epic_id, epic_number, project_dir, status,
                  depends_on_epics, updated_at
             FROM epics
            WHERE epic_id IN (${placeholders})`,
        )
        .all(...slice) as BackfillEpicRow[];
      for (const row of chunkRows) {
        const consumerEpic: Epic = {
          epic_id: row.epic_id,
          epic_number: row.epic_number,
          title: null,
          project_dir: row.project_dir,
          status: row.status,
          last_event_id: null,
          updated_at: 0,
          depends_on_epics: [],
          tasks: [],
          jobs: [],
          job_links: [],
          last_validated_at: null,
          resolved_epic_deps: null,
          question: null,
        };
        let depTokens: string[] = [];
        if (row.depends_on_epics != null && row.depends_on_epics.length > 0) {
          try {
            const parsed = JSON.parse(row.depends_on_epics);
            if (Array.isArray(parsed)) {
              depTokens = parsed.filter(
                (t): t is string => typeof t === "string",
              );
            }
          } catch {
            // malformed → empty deps
          }
        }

        // Wipe + insert this consumer's edges. Idempotent — depTokens is a pure
        // function of `depends_on_epics`.
        db.prepare("DELETE FROM epic_dep_edges WHERE consumer_id = ?").run(
          row.epic_id,
        );
        const insertEdge = db.prepare(
          "INSERT OR IGNORE INTO epic_dep_edges (consumer_id, dep_token) VALUES (?, ?)",
        );
        for (const tok of depTokens) {
          insertEdge.run(row.epic_id, tok);
        }

        // `now` is the row's persisted `updated_at` (epoch fallback), not
        // `Date.now()` — it only affects the dropped diagnostic ts.
        const nowIso =
          row.updated_at > 0
            ? new Date(row.updated_at * 1000).toISOString()
            : new Date(0).toISOString();
        const diagnosticsSink: ResolutionDiagnostic[] = [];
        const enriched: ResolvedEpicDep[] = depTokens.map((tok) => {
          const resolved = resolveEpicDep(
            tok,
            consumerEpic,
            epicById,
            epicsByNumber,
            diagnosticsSink,
            nowIso,
          );
          if (resolved.kind === "dangling") {
            return {
              dep_token: tok,
              resolved_epic_id: null,
              epic_number: null,
              project_basename: null,
              cross_project: false,
              state: "dangling",
            };
          }
          const upstream = resolved.epic;
          return {
            dep_token: tok,
            resolved_epic_id: upstream.epic_id,
            epic_number: upstream.epic_number,
            project_basename: projectBasename(upstream.project_dir),
            cross_project: resolved.cross_project !== null,
            state: epicIsCompleted(upstream)
              ? "satisfied"
              : "blocked-incomplete",
          };
        });

        // Preserve the row's existing `last_event_id` + `updated_at` — the
        // backfill is NOT a fold and must stay invisible to the wire diff.
        const cur = db
          .prepare("SELECT last_event_id FROM epics WHERE epic_id = ?")
          .get(row.epic_id) as { last_event_id: number | null } | null;
        db.prepare(
          "UPDATE epics SET resolved_epic_deps = ?, last_event_id = ?, updated_at = ? WHERE epic_id = ?",
        ).run(
          JSON.stringify(enriched),
          cur?.last_event_id ?? null,
          row.updated_at,
          row.epic_id,
        );
      }
    }).immediate();
    offset += BACKFILL_CHUNK_SIZE;
  }
}

/**
 * Run schema bootstrap + forward-only ALTER block. Writer-only, wrapped in a
 * single transaction so a half-applied schema can never persist across a crash.
 * Post-commit, a chunked backfill runs OUTSIDE the transaction (see
 * {@link backfillResolvedEpicDeps}) to avoid a mega-transaction WAL lock.
 */
function migrate(db: Database): void {
  // Pre-read storedVersion BEFORE the transaction so the post-commit backfill
  // can branch on whether this is the upgrade boot. A fresh DB has no `meta`
  // table, so probe `sqlite_master` first and read a missing table as version 0.
  const metaTableExists =
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
      )
      .get() != null;
  const preMigrateStoredVersion = metaTableExists
    ? Number(
        (
          db
            .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .get() as { value: string } | null
        )?.value ?? "0",
      )
    : 0;

  // Runtime downgrade guard: refuse to run an old binary against a DB a newer
  // keeperd already migrated. Thrown BEFORE the transaction so no version-guarded
  // ALTER runs against a newer schema and the unconditional meta stamp can't
  // regress it. Strictly-greater so a fresh (v0) or same-version DB passes. The
  // uncaught throw + LaunchAgent restart loop until the newer binary deploys is
  // INTENDED — no fatalExit wrapper, no read-only fallback.
  if (preMigrateStoredVersion > SCHEMA_VERSION) {
    throw new Error(
      `DB schema v${preMigrateStoredVersion} is newer than this binary's v${SCHEMA_VERSION} — deploy the newer keeperd (or restore the matching binary); refusing to run rather than silently downgrade`,
    );
  }

  // Decide BEFORE the transaction whether the v57→v58 `events.data` rebuild runs,
  // so `PRAGMA foreign_keys` can be toggled AROUND it: the rebuild DROPs the
  // FK-referenced `events` table (needs FK enforcement OFF), and the PRAGMA is a
  // no-op inside a transaction. Shape-driven (live `events.data` actually NOT
  // NULL) so a fresh/already-migrated DB skips it.
  const eventsTableExists =
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'",
      )
      .get() != null;
  const needsEventsRebuild =
    eventsTableExists &&
    (
      db.prepare("PRAGMA table_info('events')").all() as {
        name: string;
        notnull: number;
      }[]
    ).find((c) => c.name === "data")?.notnull === 1;
  // FK enforcement OFF only for the rebuild's DROP; restored in `finally` so a
  // mid-migrate throw never leaves it disabled.
  if (needsEventsRebuild) {
    db.run("PRAGMA foreign_keys = OFF");
  }
  try {
    db.transaction(() => {
      db.run(CREATE_EVENTS);
      for (const sql of CREATE_EVENTS_INDEXES) {
        db.run(sql);
      }
      db.run(CREATE_JOBS);
      db.run(CREATE_EPICS);
      db.run(CREATE_GIT_STATUS);
      db.run(CREATE_WORKTREE_REPO_STATUS);
      db.run(CREATE_LANE_MERGED);
      db.run(CREATE_USAGE);
      db.run(CREATE_REDUCER_STATE);
      db.run(CREATE_GIT_PROJECTION_STATE);
      db.run(CREATE_TMUX_PROJECTION_STATE);
      db.run(CREATE_TMUX_CLIENT_FOCUS);
      db.run(CREATE_META);
      db.run(CREATE_SUBAGENT_INVOCATIONS);
      for (const sql of CREATE_SUBAGENT_INVOCATIONS_INDEXES) {
        db.run(sql);
      }
      db.run(CREATE_FILE_ATTRIBUTIONS);
      for (const sql of CREATE_FILE_ATTRIBUTIONS_INDEXES) {
        db.run(sql);
      }
      db.run(CREATE_PROFILES);
      db.run(CREATE_EPIC_DEP_EDGES);
      for (const sql of CREATE_EPIC_DEP_EDGES_INDEXES) {
        db.run(sql);
      }
      db.run(CREATE_DEAD_LETTERS);
      for (const sql of CREATE_DEAD_LETTERS_INDEXES) {
        db.run(sql);
      }
      db.run(CREATE_DISPATCH_FAILURES);
      db.run(CREATE_AUTOPILOT_STATE);
      db.run(CREATE_ARMED_EPICS);
      db.run(CREATE_BUILDS);
      db.run(CREATE_COMMIT_TRAILER_FACTS);
      for (const sql of CREATE_COMMIT_TRAILER_FACTS_INDEXES) {
        db.run(sql);
      }
      db.run(CREATE_EVENT_INGEST_OFFSETS);
      db.run(CREATE_PENDING_DISPATCHES);
      db.run(CREATE_DISPATCH_NEVER_BOUND);
      db.run(CREATE_DISPATCH_INSTANT_DEATH);
      db.run(CREATE_DISPATCH_MINT_GATE);
      db.run(CREATE_BLOCK_ESCALATIONS);
      db.run(CREATE_EPIC_TOMBSTONES);
      db.run(CREATE_HANDOFFS);
      // `event_blobs` is HISTORICAL (fn-836.4 shed): NOT created in the
      // steady-state schema-setup block, so a post-shed boot never resurrects
      // it. A fresh 0→latest walk still materializes it transiently at the v57
      // ladder step (read by the v67 backfill) and the v74 tail DROPs it.
      db.run(CREATE_SCHEDULED_TASKS);
      for (const sql of CREATE_SCHEDULED_TASKS_INDEXES) {
        db.run(sql);
      }

      // Seed singleton cursor on first boot.
      db.run(
        "INSERT OR IGNORE INTO reducer_state (id, last_event_id, updated_at) VALUES (1, 0, unixepoch('now', 'subsec'))",
      );
      // Seed the live-only git-projection control singleton. `floor = 0` +
      // `seed_required = 1` on a cold first boot so the boot-seed producer
      // re-derives the git surface before serving (a fresh DB has no prior floor;
      // a 0 floor means every git fold runs, but the boot-seed runs anyway and
      // the floor moves up to current `max(events.id)` once it does).
      db.run(
        "INSERT OR IGNORE INTO git_projection_state (id, floor, seed_required, updated_at) VALUES (1, 0, 1, unixepoch('now', 'subsec'))",
      );
      // Seed the live-only tmux-projection control singleton (fn-907), mirroring
      // the git seed above: `floor = 0` + `seed_required = 1` so the boot-seed
      // re-derives the live pane location surface before serving.
      db.run(
        "INSERT OR IGNORE INTO tmux_projection_state (id, floor, seed_required, updated_at) VALUES (1, 0, 1, unixepoch('now', 'subsec'))",
      );

      // Forward-only schema changes run on EVERY boot, NOT gated on the stored
      // schema_version: each idempotent step converges on the table's actual
      // shape, so a version stamped ahead of the real schema can't skip its ALTERs
      // forever. Non-idempotent steps (data backfills, destructive changes) need a
      // LOCAL version guard.
      const migrationCtx: MigrationContext = {
        db,
        preMigrateStoredVersion,
        needsEventsRebuild,
      };
      for (const step of SCHEMA_STEPS) {
        step.apply(migrationCtx);
      }

      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(SCHEMA_VERSION));
      // `.immediate()` grabs the writer lock at BEGIN, so a CREATE/ALTER/INSERT
      // can't lose the upgrade-to-writer race and leave migrate half-applied.
    }).immediate();
  } finally {
    // Restore FK enforcement after the v57→v58 rebuild toggled it OFF; the
    // `finally` guards against a mid-migrate throw leaving it disabled.
    if (needsEventsRebuild) {
      db.run("PRAGMA foreign_keys = ON");
    }
  }

  // Chunked backfill OUTSIDE the migrate transaction (one short BEGIN IMMEDIATE
  // per chunk) so the WAL writer lock isn't held across the whole scan.
  // Version-guarded to run once per upgrade.
  if (preMigrateStoredVersion < 34) {
    backfillResolvedEpicDeps(db);
  }
}

/**
 * Build the prepared-statement bundle. The reducer folds with inline SQL, so it
 * binds nothing here.
 */
export function prepareStmts(db: Database): Stmts {
  return {
    // Named bindings (`$col`), not positional `?`: a positional list is a
    // column-shift hazard — a missed call site silently shifts `null` into the
    // next column without throwing.
    insertEvent: db.prepare(`
      INSERT INTO events (
        ts, session_id, pid, hook_event, event_type, tool_name, matcher,
        cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
        subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
        plan_op, plan_target, plan_epic_id, plan_task_id,
        plan_subject_present, tool_use_id, config_dir,
        bash_mutation_kind, bash_mutation_targets, plan_files,
        backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
        background_task_id, mutation_path, worktree, harness, resume_target,
        adopted
      ) VALUES (
        $ts, $session_id, $pid, $hook_event, $event_type, $tool_name, $matcher,
        $cwd, $permission_mode, $agent_id, $agent_type, $stop_hook_active, $data,
        $subagent_agent_id, $spawn_name, $start_time, $slash_command, $skill_name,
        $plan_op, $plan_target, $plan_epic_id, $plan_task_id,
        $plan_subject_present, $tool_use_id, $config_dir,
        $bash_mutation_kind, $bash_mutation_targets, $plan_files,
        $backend_exec_type, $backend_exec_session_id, $backend_exec_pane_id,
        $background_task_id, $mutation_path, $worktree, $harness, $resume_target,
        $adopted
      )
    `),
    selectWorldRev: db.prepare(
      "SELECT last_event_id FROM reducer_state WHERE id = 1",
    ),
  };
}

/** Read the singleton world rev (`reducer_state.last_event_id`); 0 if no row. */
export function selectWorldRev(stmts: Stmts): number {
  const row = stmts.selectWorldRev.get() as { last_event_id: number } | null;
  return row ? row.last_event_id : 0;
}

/**
 * Classify an error caught anywhere in the open span (new Database →
 * applyPragmas → migrate-if-writer → prepareStmts) as the transient BOOT class
 * that {@link openDb}'s `bootRetry` retries. This classifier is PRIVATE to the
 * open-span retry and MUST NOT be used elsewhere: "no such table" is retryable
 * ONLY at initial open on a known-migrated path; in a fold or a live query it
 * is fatal. Deliberately NOT `daemon.ts:isTransientBusyError` — that fence's
 * CORRUPT-is-fatal contract must stand and is scoped to the steady-state busy
 * retry, not boot.
 *
 * The retryable boot classes:
 *   - SQLITE_BUSY / SQLITE_LOCKED — concurrent writer/recovery contention.
 *   - "no such table" / "no such column" surfaced while preparing statements —
 *     a worker raced main's just-committed migration; a fresh open sees it.
 *   - SQLITE_CANTOPEN — bun:sqlite's concurrent dlopen/dlsym open race
 *     (oven-sh/bun#29277); a fresh Database construction clears it.
 */
export function isTransientBootOpenError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    code === "SQLITE_CANTOPEN"
  ) {
    return true;
  }
  const errno = (err as { errno?: unknown }).errno;
  if (errno === 5 || errno === 6) {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") {
    return (
      message.includes("no such table") || message.includes("no such column")
    );
  }
  return false;
}

/** `bootRetry` defaults: 4 attempts, 50ms base, exponential + jitter, 1s cap. */
const BOOT_RETRY_DEFAULT_ATTEMPTS = 4;
const BOOT_RETRY_DEFAULT_BASE_MS = 50;
const BOOT_RETRY_CAP_MS = 1000;

/**
 * Run the full open span ONCE: construct a fresh Database, apply pragmas,
 * migrate (writers only), and build the statement bundle. The span is a single
 * unit so a transient failure anywhere within it re-runs from a clean handle.
 */
function openDbSpan(
  path: string,
  options: OpenDbOptions,
  attempt: number,
): KeeperDb {
  options._beforeAttempt?.(attempt);
  const readonly = options.readonly ?? false;

  if (!readonly) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  let db: Database | undefined;
  try {
    db = new Database(path, readonly ? { readonly: true } : { create: true });
    applyPragmas(db, options.busyTimeoutMs ?? 5000, options.cacheSizeKb);

    if ((options.migrate ?? true) && !readonly) {
      migrate(db);
    }

    // A READONLY connection never INSERTs, so it has no business preparing the
    // static write-statement bundle — and MUST NOT, because the static
    // `insertEvent` names every events column and would throw "no such column"
    // when a reader opens a live DB the sole-migrator daemon hasn't yet bumped
    // (the schema-bump-deploy-skew window: a new `keeper` binary's reader path
    // runs against the old on-disk schema until keeperd restarts). Readers
    // destructure `{ db }` only — none touch `stmts` — so the throwing stub is
    // safe. The hook's explicit `prepareStmts: false` rides the same stub for
    // the same reason (it builds a column-adaptive INSERT instead).
    const wantStmts = (options.prepareStmts ?? true) && !readonly;
    const stmts = wantStmts ? prepareStmts(db) : noStmts();
    return { db, stmts };
  } catch (err) {
    // Close the partially-constructed handle best-effort before re-throwing: a
    // Database that survived a native race is suspect, and the bootRetry driver
    // constructs a fresh one. Never reuse this handle.
    try {
      db?.close();
    } catch {
      // best-effort; the original error is what matters
    }
    throw err;
  }
}

/**
 * Open a keeper DB connection. Writers migrate + auto-create the parent dir;
 * readers (`readonly: true`) skip migration and fail loudly on a missing file.
 *
 * `bootRetry` wraps the open span in a bounded retry of the transient BOOT
 * class ({@link isTransientBootOpenError}) for the racy worker-spawn window: a
 * FRESH Database is constructed per attempt (a handle that survived a native
 * race is suspect — never reuse it), with synchronous exponential backoff +
 * jitter between attempts. This is boot ROBUSTNESS, NOT in-process self-heal:
 * it is bounded, initial-open-only, transient-class-only, and after exhaustion
 * it RETHROWS so the worker's existing fail-loud path (exit 1 → fatalExit →
 * LaunchAgent restart) is preserved. Worker main()s are synchronous, so the
 * backoff is `Bun.sleepSync`, never an un-awaited promise.
 */
export function openDb(path: string, options: OpenDbOptions = {}): KeeperDb {
  const bootRetry = options.bootRetry ?? false;
  if (!bootRetry) {
    return openDbSpan(path, options, 1);
  }

  const cfg = bootRetry === true ? {} : bootRetry;
  const attempts = cfg.attempts ?? BOOT_RETRY_DEFAULT_ATTEMPTS;
  const baseMs = cfg.baseMs ?? BOOT_RETRY_DEFAULT_BASE_MS;

  for (let attempt = 1; ; attempt++) {
    try {
      // Re-run the WHOLE span with caller options preserved VERBATIM (the writer
      // open keeps `migrate: false`; the reader keeps `readonly: true`); only
      // `bootRetry` itself is consumed by the driver.
      return openDbSpan(path, options, attempt);
    } catch (err) {
      if (attempt >= attempts || !isTransientBootOpenError(err)) {
        throw err;
      }
      // Exponential backoff with full jitter, capped. Synchronous because the
      // worker main() that calls this is synchronous.
      const window = Math.min(baseMs * 2 ** (attempt - 1), BOOT_RETRY_CAP_MS);
      Bun.sleepSync(Math.floor(Math.random() * window));
    }
  }
}

/**
 * Throwing-stub {@link Stmts} for `openDb({ prepareStmts: false })`. Accessing
 * either statement is a programming error (only the hook opts out, and it never
 * reads them) — fail loudly instead of handing back a typed `null`.
 */
function noStmts(): Stmts {
  const trap = (): never => {
    throw new Error(
      "openDb({ prepareStmts: false }) — statement bundle is unavailable on this connection",
    );
  };
  return {
    get insertEvent(): never {
      return trap();
    },
    get selectWorldRev(): never {
      return trap();
    },
  };
}

/**
 * Canonical planctl JSON serializer — MUST match
 * `json.dumps(data, indent=2, sort_keys=True) + "\n"` byte-for-byte. Two writers
 * (planctl + keeperd) hit the same files; any byte diff causes a round-trip
 * ping-pong. Sorts object keys, ASCII-escapes non-ASCII (`ensure_ascii=True`),
 * appends one trailing `\n`.
 */
export function serializePlanJson(data: unknown): string {
  const sorted = sortObjectKeys(data);
  const body = JSON.stringify(sorted, null, 2);
  return `${escapeNonAscii(body)}\n`;
}

/**
 * Recursively sort object keys lexicographically. Arrays preserve order;
 * primitives pass through.
 */
export function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) {
    out[k] = sortObjectKeys((value as Record<string, unknown>)[k]);
  }
  return out;
}

/**
 * Escape every non-ASCII code unit to `\uXXXX` to match Python's
 * `ensure_ascii=True`. `JSON.stringify` already escapes 0x00-0x1f identically,
 * so only 0x7f and >= 0x80 need escaping here (operates on the post-stringify
 * UTF-16 code units, mirroring Python's per-BMP-codepoint escape).
 */
function escapeNonAscii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      out += s[i];
    } else if (code <= 0x1f) {
      out += s[i];
    } else {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}

/**
 * Atomically write `content` to `path` via a same-directory temp file →
 * `renameSync` (POSIX rename atomicity only holds intra-filesystem). The temp
 * file is best-effort unlinked on any throw so a partial file never lingers.
 *
 * When `mode` is passed, the permission bits land on the TEMP file (via an
 * explicit `chmodSync` that defeats umask) BEFORE the rename, so the final path
 * is never briefly world-readable — the revive-script side-file rides agent
 * titles and cwds and is written `0600`. Omitting `mode` keeps the default
 * umask-derived permissions (existing call sites are unaffected).
 */
export function atomicWriteFile(
  path: string,
  content: string,
  mode?: number,
): void {
  const dir = dirname(path);
  const tmp = join(
    dir,
    `${path.slice(dir.length + 1)}.tmp.${process.pid}.${crypto.randomUUID()}`,
  );
  try {
    writeFileSync(tmp, content, { encoding: "utf8" });
    if (mode !== undefined) {
      // chmod the temp file explicitly: writeFileSync's `mode` option is masked
      // by umask, so a bare write can't guarantee an exact 0600.
      chmodSync(tmp, mode);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) {
        unlinkSync(tmp);
      }
    } catch {
      // swallow — the original error is what the caller cares about
    }
    throw err;
  }
}
