// Shared apply core for the two selector-cell write verbs — `assign-cells` (a
// YAML batch) and `apply-selection` (a validated selector verdict). Both land the
// SAME {tier, model} cell writes + `audit_required` stamps + committed selection
// sidecar under the epic flock, run the post-write integrity gate, and emit the
// SAME mutating auto-commit. The verbs differ only in how they parse + validate
// their input and pin provenance; the write/commit spine lives here once.
//
// The IN-LOCK todo-status re-read is the core's guarantee: a task claimed between
// a caller's outer read and this lock still rejects the batch. `resolveCells`
// runs INSIDE the flock so it observes that live todo set — the guided callers
// re-assert axis/membership/coverage there via `validateSelectionCells`, the
// degrade caller re-asserts each todo task's own stamped cell.
//
// The audit-policy read is degrade-SOFT: a cell whose selected tier is
// policy-flagged gets `audit_required: true`, else false. An absent or malformed
// policy degrades to no task flagged, recorded in the sidecar's `audit_policy`
// provenance block. KEEPER_PLAN_AUDIT_POLICY overrides the policy path.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquirePlanCommitGuard,
  type RollbackEntry,
  restoreForRollback,
  snapshotForRollback,
} from "../commit.ts";
import { emitFailureEnvelope, emitMutating } from "../emit.ts";
import { withEpicIdLock } from "../flock.ts";
import { integrityGateOrFail } from "../integrity_gate.ts";
import { mergeTaskState } from "../models.ts";
import type { ProjectContext } from "../project.ts";
import {
  SELECTION_SCHEMA_VERSION,
  type SelectionSidecar,
  type SidecarAuditPolicy,
  selectionSidecarPath,
  writeSelectionSidecar,
} from "../selection_sidecar.ts";
import {
  atomicWriteJson,
  LocalFileStateStore,
  loadJson,
  loadJsonSafe,
  nowIso,
} from "../store.ts";
import { parseYamlInput, readYamlBytes } from "../yaml_input.ts";

/** A cell resolved for the write: the {tier, model} to set on a task plus the
 * selector's per-cell provenance (rationale / confidence / label_source). Axis /
 * membership / coverage may still be re-checked in-lock by the caller. */
export interface SelectionCoreCell {
  taskId: string;
  tier: string;
  model: string;
  rationale: string | null;
  confidence: number | string | null;
  labelSource: string;
}

/** The selector-run provenance the sidecar records — synthesized/pinned by the
 * verb, never transcribed from the untrusted verdict. */
export interface SelectionCoreProvenance {
  harness: string;
  model: string;
  configHash: string;
  inputHash: string;
  shuffleSeed: number | null;
  outcome: string;
  verdictRaw: string | null;
}

/** The in-lock cell resolution: the final cells to write, or a typed validation
 * failure the core routes to `emitFailureEnvelope`. */
export type CellResolution =
  | { kind: "ok"; cells: SelectionCoreCell[] }
  | { kind: "invalid"; code: string; message: string; details: string[] };

/** YAML implicit-typing guard: an actual string, not a bool/number/Date the
 * parser coerced from a norway boolean / numeric / ISO-date scalar. */
export function isStr(v: unknown): v is string {
  return typeof v === "string";
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

/** Python `!r` for a string scalar — single-quoted, for the out-of-axis message. */
function pyReprStr(v: string): string {
  return `'${v}'`;
}

/** Validate a cell set against the LIVE axes + the in-lock todo set: out-of-axis
 * tier/model, unknown / non-todo task id, duplicate cells, and the full-set
 * coverage contract (every todo task covered exactly once). Returns the
 * accumulate-all `cell_invalid` detail list (empty on a clean set). Shared by
 * both guided callers so the assign-cells regression net covers apply-selection's
 * final axis gate too. */
export function validateSelectionCells(
  parsedCells: readonly SelectionCoreCell[],
  opts: {
    epicId: string;
    verb: string;
    todo: ReadonlySet<string>;
    epicTaskIds: ReadonlySet<string>;
    efforts: readonly string[];
    models: readonly string[];
  },
): string[] {
  const { epicId, verb, todo, epicTaskIds, efforts, models } = opts;
  const cellErrors: string[] = [];
  const seen = new Set<string>();
  for (let idx = 0; idx < parsedCells.length; idx += 1) {
    const c = parsedCells[idx] as SelectionCoreCell;
    const prefix = `cells #${idx + 1} (${c.taskId})`;
    if (!efforts.includes(c.tier)) {
      cellErrors.push(
        `${prefix}: tier ${pyReprStr(c.tier)} is not one of ${efforts.join(", ")}`,
      );
    }
    if (!models.includes(c.model)) {
      cellErrors.push(
        `${prefix}: model ${pyReprStr(c.model)} is not one of ${models.join(", ")}`,
      );
    }
    if (!epicTaskIds.has(c.taskId)) {
      cellErrors.push(
        `${prefix}: unknown task id — not a task of epic ${epicId}`,
      );
    } else if (!todo.has(c.taskId)) {
      cellErrors.push(
        `${prefix}: task is not in \`todo\` status — ${verb} targets ` +
          "todo tasks only",
      );
    }
    if (seen.has(c.taskId)) {
      cellErrors.push(`${prefix}: duplicate cell for task ${c.taskId}`);
    }
    seen.add(c.taskId);
  }

  // Full-set contract: every todo task must be covered by exactly one cell.
  for (const tid of [...todo].sort()) {
    if (!seen.has(tid)) {
      cellErrors.push(
        `coverage: todo task ${tid} is not covered by any cell ` +
          "(full-set contract — choosing the default is an explicit cell)",
      );
    }
  }
  return cellErrors;
}

/** Land a resolved cell set: acquire the commit guard, then under the epic flock
 * re-read the todo status, resolve + validate the cells, snapshot-then-mutate the
 * task JSONs (tier/model + audit_required), write the committed sidecar; then run
 * the integrity gate, bump the epic's updated_at, and emit the mutating
 * auto-commit. Returns 0 on success (envelope self-emitted) or 1 on a
 * merge_in_progress / resolution failure (envelope already printed). The verb
 * name drives the integrity gate + commit subject; the marker is left untouched
 * (an INTEGRITY_GATE_VERBS member never arms a ghost). */
export function landSelectionCells(opts: {
  verb: string;
  epicId: string;
  ctx: ProjectContext;
  provenance: SelectionCoreProvenance;
  resolveCells: (args: {
    todo: ReadonlySet<string>;
    epicTaskIds: ReadonlySet<string>;
    loadTaskDef: (taskId: string) => Record<string, unknown>;
  }) => CellResolution;
}): number {
  const { verb, epicId, ctx, provenance, resolveCells } = opts;
  const dataDir = ctx.dataDir;
  const primaryRepo = ctx.projectPath;
  const epicPath = join(dataDir, "epics", `${epicId}.json`);

  // Load the audit policy degrade-SOFT (outside the lock — a pure disk read).
  const auditLoad = loadAuditFlags();

  // Merge-window guard + commit-work serialization (commit-work OUTER, epic-id
  // flock INNER): refuse a mid-operation write before touching state, else hold
  // the shared lock across the write -> auto-commit window, released via finally.
  const commitGuard = acquirePlanCommitGuard(primaryRepo);
  if (commitGuard.kind === "refused") {
    emitFailureEnvelope("merge_in_progress", commitGuard.message, [
      commitGuard.detail,
    ]);
    return 1;
  }
  try {
    type FlockOutcome =
      | { kind: "failure"; code: string; message: string; details: string[] }
      | { kind: "success"; taskIds: string[]; rollback: RollbackEntry[] };

    const outcomeResult = withEpicIdLock<FlockOutcome>(() => {
      const stateStore = new LocalFileStateStore(ctx.stateDir);

      // Enumerate the epic's tasks + their live status (re-read INSIDE the lock).
      const epicTaskIds = new Set(epicTaskStems(dataDir, epicId));
      const todo = new Set<string>();
      for (const tid of epicTaskIds) {
        const def = loadJsonSafe(join(dataDir, "tasks", `${tid}.json`)) ?? {};
        const status = mergeTaskState(def, stateStore.loadRuntime(tid)).status;
        if (status === "todo") {
          todo.add(tid);
        }
      }

      const resolution = resolveCells({
        todo,
        epicTaskIds,
        loadTaskDef: (taskId) =>
          loadJson(join(dataDir, "tasks", `${taskId}.json`)),
      });
      if (resolution.kind === "invalid") {
        return {
          kind: "failure",
          code: resolution.code,
          message: resolution.message,
          details: resolution.details,
        };
      }
      const cells = resolution.cells;

      // Snapshot every path this verb writes BEFORE mutating — the per-cell task
      // JSONs + the selection sidecar (both here) and the epic JSON (its
      // updated_at bump lands outside the lock, but the commit covers it). A
      // commit-failure rollback restores each one's prior bytes (or unlinks a
      // fresh sidecar) and unstages the set.
      const rollbackPaths: string[] = [
        epicPath,
        selectionSidecarPath(dataDir, epicId),
      ];
      for (const c of cells) {
        rollbackPaths.push(join(dataDir, "tasks", `${c.taskId}.json`));
      }
      const rollback = snapshotForRollback(rollbackPaths);

      // --- mutate: overwrite tier/model + stamp audit_required per cell ------
      // audit_required is written explicitly (true or false) on every cell so a
      // re-run after a policy change correctly flips a stale flag.
      const now = nowIso();
      const flaggedTaskIds: string[] = [];
      for (const c of cells) {
        const tp = join(dataDir, "tasks", `${c.taskId}.json`);
        const tdef = loadJson(tp);
        tdef.tier = c.tier;
        tdef.model = c.model;
        const flagged = auditLoad.ok && auditLoad.flags[c.tier] === true;
        tdef.audit_required = flagged;
        if (flagged) {
          flaggedTaskIds.push(c.taskId);
        }
        tdef.updated_at = now;
        atomicWriteJson(tp, tdef, dataDir);
      }

      const auditPolicy: SidecarAuditPolicy = auditLoad.ok
        ? { status: "applied", reason: null, flagged_task_ids: flaggedTaskIds }
        : {
            status: "degraded",
            reason: auditLoad.reason,
            flagged_task_ids: [],
          };

      // --- sidecar: schema-versioned provenance, REPLACE (no append) --
      const sidecar: SelectionSidecar = {
        schema_version: SELECTION_SCHEMA_VERSION,
        epic_id: epicId,
        created_at: now,
        selector: { harness: provenance.harness, model: provenance.model },
        config_hash: provenance.configHash,
        input_hash: provenance.inputHash,
        shuffle_seed: provenance.shuffleSeed,
        outcome: provenance.outcome,
        verdict_raw: provenance.verdictRaw,
        cells: cells.map((c) => ({
          task_id: c.taskId,
          tier: c.tier,
          model: c.model,
          rationale: c.rationale,
          confidence: c.confidence,
          label_source: c.labelSource,
        })),
        audit_policy: auditPolicy,
      };
      writeSelectionSidecar(dataDir, sidecar);

      return {
        kind: "success",
        taskIds: cells.map((c) => c.taskId),
        rollback,
      };
    });

    if (outcomeResult.kind === "failure") {
      emitFailureEnvelope(
        outcomeResult.code,
        outcomeResult.message,
        outcomeResult.details,
      );
      return 1;
    }

    // Post-write integrity gate (OUTSIDE the lock). Re-validate the post-mutation
    // tree and bump the epic's updated_at on a clean result — the marker stays
    // untouched. checkFilesystemRepos stays false — only tier/model changed.
    integrityGateOrFail(epicId, dataDir, { verb });
    const epicDefAfter = loadJson(epicPath);
    epicDefAfter.updated_at = nowIso();
    atomicWriteJson(epicPath, epicDefAfter, dataDir);

    // Emit ONE envelope covering the whole batch (OUTSIDE the lock). The
    // auto-commit stages the mutated task JSONs, the epic updated_at bump, AND the
    // sidecar (a non-gitignored `selections/` path) in one commit before printing.
    emitMutating(
      {
        epic_id: epicId,
        assigned_task_ids: outcomeResult.taskIds,
        outcome: provenance.outcome,
      },
      {
        verb,
        target: epicId,
        repoRoot: ctx.projectPath,
        primaryRepo,
        onCommitFailure: () =>
          restoreForRollback(outcomeResult.rollback, primaryRepo),
      },
    );
    return 0;
  } finally {
    commitGuard.release();
  }
}

// --- Local helpers ---------------------------------------------------------

/** The audit-policy path: KEEPER_PLAN_AUDIT_POLICY override, else the committed
 * plugin-root audit-policy.yaml. Resolved off import.meta.url so it works from
 * the interpreted plan CLI at an arbitrary cwd (mirrors selection-brief). */
function auditPolicyPath(): string {
  const override = process.env.KEEPER_PLAN_AUDIT_POLICY;
  if (override !== undefined && override !== "") {
    return override;
  }
  const planRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  return join(planRoot, "audit-policy.yaml");
}

/** Degrade-SOFT read of the tier→audit-flag map. An absent file, unparseable
 * YAML, or a missing / non-mapping `tier_audit` all degrade (no flags); a present
 * mapping yields its boolean entries (a non-boolean or unmapped tier reads
 * unflagged). Fail-loud validation is the drift gate's job (audit-policy-check),
 * never the runtime stamp. */
type AuditFlagLoad =
  | { ok: true; flags: Record<string, boolean> }
  | { ok: false; reason: string };

function loadAuditFlags(): AuditFlagLoad {
  const path = auditPolicyPath();
  if (!existsSync(path)) {
    return { ok: false, reason: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = parseYamlInput(readYamlBytes(path), path);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.tier_audit)) {
    return { ok: false, reason: "malformed" };
  }
  const flags: Record<string, boolean> = {};
  for (const [tier, value] of Object.entries(parsed.tier_audit)) {
    if (typeof value === "boolean") {
      flags[tier] = value;
    }
  }
  return { ok: true, flags };
}

/** Stems of direct-child `tasks/<epicId>.<m>.json` files (one directory glob),
 * excluding nested-dot ids. Mirrors refine-apply's globTaskStems. */
function epicTaskStems(dataDir: string, epicId: string): string[] {
  const tasksDir = join(dataDir, "tasks");
  let entries: string[];
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return [];
  }
  const prefix = `${epicId}.`;
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(prefix) && entry.endsWith(".json")) {
      const stem = entry.slice(0, -".json".length);
      const middle = stem.slice(prefix.length);
      if (middle.length > 0 && !middle.includes(".")) {
        out.push(stem);
      }
    }
  }
  return out;
}
