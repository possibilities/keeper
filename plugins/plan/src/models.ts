// Data-normalization spine — the port of planctl/models.py's normalize/merge
// helpers. The read-only verbs consume mergeTaskState (absent runtime overlay
// -> status "todo") for status counting; normalizeEpic/normalizeTask land as
// spine utilities applying the same optional-field defaults Python does, so a
// later mutating-verb wave inherits the shape rather than re-deriving it.

import { effectiveMatrix } from "./host_matrix.ts";
import { composeWorkerAgent } from "./subagents_config.ts";

export const SCHEMA_VERSION = 1;

/** Apply defaults for optional epic fields. Mirrors normalize_epic: scrub the
 * dead keys, then default every additive field. Mutates and returns `data`. */
export function normalizeEpic(
  data: Record<string, unknown>,
): Record<string, unknown> {
  for (const dead of ["draft", "audited_into", "auditor_done_at"]) {
    delete data[dead];
  }
  if (!("branch_name" in data)) {
    data.branch_name = "main";
  }
  if (!("depends_on_epics" in data)) {
    data.depends_on_epics = [];
  }
  if (!("last_validated_at" in data)) {
    data.last_validated_at = null;
  }
  if (!("primary_repo" in data)) {
    data.primary_repo = null;
  }
  if (!("touched_repos" in data)) {
    data.touched_repos = null;
  }
  if (!("closer_done_at" in data)) {
    data.closer_done_at = null;
  }
  if (!("close_reason" in data)) {
    data.close_reason = null;
  }
  if (!("snippets" in data)) {
    data.snippets = [];
  }
  if (!("bundles" in data)) {
    data.bundles = [];
  }
  if (!("created_by_close_of" in data)) {
    data.created_by_close_of = null;
  }
  if (!("blocks_closing_of" in data)) {
    data.blocks_closing_of = null;
  }
  return data;
}

/** Apply defaults for optional task fields. Mirrors normalize_task. Mutates
 * and returns `data`. */
export function normalizeTask(
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!("priority" in data)) {
    data.priority = null;
  }
  if (!("depends_on" in data)) {
    data.depends_on = data.deps ?? [];
  }
  if (!("target_repo" in data)) {
    data.target_repo = null;
  }
  if (!("worker_done_at" in data)) {
    data.worker_done_at = null;
  }
  if (!("tier" in data)) {
    data.tier = null;
  }
  if (!("model" in data)) {
    data.model = null;
  }
  if (!("audit_required" in data)) {
    data.audit_required = false;
  }
  if (!("snippets" in data)) {
    data.snippets = [];
  }
  if (!("bundles" in data)) {
    data.bundles = [];
  }
  return data;
}

/** Merge a task definition with its runtime sidecar. Absent runtime defaults to
 * {status: "todo"}; runtime fields overwrite definition fields, then the merged
 * dict is normalized. Mirrors merge_task_state. */
export function mergeTaskState(
  definition: Record<string, unknown>,
  runtime: Record<string, unknown> | null,
): Record<string, unknown> {
  const overlay = runtime ?? { status: "todo" };
  const merged = { ...definition, ...overlay };
  normalizeTask(merged);
  return merged;
}

/** Merge an epic definition with its runtime sidecar. Epics have no status
 * overlay, so an absent sidecar makes the merge a pure normalize pass over the
 * def; the call-shape is kept symmetric with mergeTaskState. Mirrors
 * merge_epic_state. */
export function mergeEpicState(
  definition: Record<string, unknown>,
  epicRuntime: Record<string, unknown> | null,
): Record<string, unknown> {
  const merged = { ...definition, ...(epicRuntime ?? {}) };
  normalizeEpic(merged);
  return merged;
}

/** Sort priority for a task (null / unparseable -> 999). Mirrors task_priority:
 * a missing/None priority is 999, else `int(value)` with a 999 fallback on the
 * except branch. Reproduces Python int() faithfully — a finite number truncates
 * toward zero (int(3.9) == 3); a string must be a base-10 integer literal
 * (int("3.9") raises, so non-integer strings fall through to 999). */
export function taskPriority(taskData: Record<string, unknown>): number {
  const raw = taskData.priority;
  if (raw === null || raw === undefined) {
    return 999;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.trunc(raw) : 999;
  }
  if (typeof raw === "boolean") {
    return raw ? 1 : 0; // Python int(True) == 1, int(False) == 0
  }
  if (typeof raw === "string" && /^[+-]?\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  return 999;
}

/** The canonical worker reasoning tiers (efforts), sourced from the REQUIRED v2
 * host matrix (`matrix.yaml`) — its top-level effort axis. This is the single
 * validation seam every membership-checking verb (assign-cells, scaffold,
 * refine-apply, close-finalize) inherits, so the effort axis lands without each
 * verb re-reading the config. Read lazily (never at module eval) so an absent or
 * malformed matrix surfaces the typed four-state error at a verb call site, and
 * re-read per call so an operator matrix edit lands with no rebuild. */
export function configuredEfforts(): readonly string[] {
  return effectiveMatrix().efforts;
}

/** The canonical worker models — the `subagent_models` cell axis of the required
 * v2 host matrix. Same seam and lazy/per-call contract as configuredEfforts. */
export function configuredModels(): readonly string[] {
  return effectiveMatrix().models;
}

/** Derive a task's worker null-gate signal from its {tier, model}, validated
 * against the required v2 host matrix. The composed string is
 * `plan:worker-<model>-<effort>`, but only its NULL-NESS is load-bearing:
 * /plan:work spawns the constant `work:worker` (the launcher selects the matching
 * cell at launch via --plugin-dir), so the composed value is vestigial for the
 * spawn. Returns null when EITHER axis is null — the null return is what stops
 * /plan:work cleanly. Throws for a non-null value outside the matrix
 * efforts/models: the corrupt-state backstop behind dispatch's graceful no-route
 * reject, which fires first on any unroutable cell and gates claim. The reconcile
 * verdict path uses the embedded-only sibling (`embeddedWorkerAgentFor`) so its
 * host read stays off the pure core. */
export function workerAgentFor(
  tier: string | null,
  model: string | null,
): string | null {
  const matrix = effectiveMatrix();
  return composeWorkerAgent(
    (m) => matrix.effortsFor(m),
    matrix.models,
    tier,
    model,
  );
}
