// refine-apply verb — the byte-parity port of planctl/run_refine_apply.py.
//
// scaffold's mutating equivalent over an epic that ALREADY exists: one YAML
// delta describing four change kinds (epic.spec / add_tasks / rewrite_specs /
// rewire_deps) applied in a single transactional, assert-all, collect-all call.
//
// Two envelope shapes, routed EXPLICITLY (mirroring scaffold):
//  - pre-commit failures (bad_yaml, epic_not_found, spec_invalid, repo_invalid,
//    tier_invalid, target_invalid, dep_invalid, dep_cycle, id_collision,
//    integrity_failed) -> emitFailureEnvelope / the integrity gate's own
//    integrity_failed line, returning 1;
//  - success -> emitMutating ({epic_id, added_task_ids, rewritten_specs,
//    rewired_deps, epic_spec_rewritten}).
//
// THE ASYMMETRY WITH SCAFFOLD (do not collapse it):
//  - the flock guards ONLY task-id allocation (scanMaxTaskId, two-pass ordinals,
//    target/dep/cycle checks, the delta writes); the integrity gate runs OUTSIDE.
//  - refine-apply IS an INTEGRITY_GATE_VERBS member — Phase 4.5 re-validates the
//    post-write tree via integrityGateOrFail(verb refine-apply,
//    checkFilesystemRepos=true). It never touches last_validated_at: the marker
//    is an arm-exclusive latch, so refine-apply leaves the (invalidate-nulled)
//    epic a ghost for the trailing `validate --epic` arm to flip.
//  - the mid-write / Phase-4.5 unwind unlinks ONLY the FRESH-MINT new-task paths
//    (recorded in writtenPaths); existing-file rewrites (epic JSON, epic spec,
//    rewrite_/rewire_ targets) are atomic_write rename-based and intentionally
//    OMITTED from the unwind — unlinking them would destroy the user's data.
//
// Bun-specific seam: integrityGateOrFail prints integrity_failed and
// process.exit(1) directly (it does NOT throw a catchable SystemExit the way
// Python's does), so the Phase-4.5 fresh-mint unwind threads through its
// `onFailure` hook (the same hook add-dep uses for rollback) — fires BEFORE the
// exit.

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { detectCycles } from "../deps.ts";
import { emitFailureEnvelope, emitMutating } from "../emit.ts";
import { withEpicIdLock } from "../flock.ts";
import { appendTaskRecord, ledgerMaxTaskNum } from "../id_ledger.ts";
import { isEpicId, isTaskId, parseId, scanMaxTaskId } from "../ids.ts";
import { integrityGateOrFail } from "../integrity_gate.ts";
import { configuredEfforts, configuredModels } from "../models.ts";
import { resolveProject } from "../project.ts";
import { expandPath } from "../repo_inference.ts";
import { ensureValidTaskSpec } from "../specs.ts";
import { atomicWrite, atomicWriteJson, loadJson, nowIso } from "../store.ts";
import {
  parseYamlInput,
  readYamlBytes,
  YamlInputError,
} from "../yaml_input.ts";

interface RefineApplyArgs {
  epicId: string;
  file: string;
}

/** YAML implicit-typing guard: an actual string, not a bool/number/Date the
 * eemeli 1.1 parser coerces a norway boolean / numeric / ISO-date scalar into.
 * Mirrors run_refine_apply._is_str. */
function isStr(v: unknown): v is string {
  return typeof v === "string";
}

/** A list whose every element is a string. Mirrors _is_list_of_str. */
function isListOfStr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function runRefineApply(args: RefineApplyArgs): number {
  const { epicId, file: fileArg } = args;

  // ------------------------------------------------------------------
  // Phase 0: epic id shape + existence (the delta targets an existing tree).
  // ------------------------------------------------------------------
  if (!isEpicId(epicId)) {
    emitFailureEnvelope("bad_yaml", `Invalid epic id: ${epicId}`, [
      `epic_id: ${epicId}`,
    ]);
    return 1;
  }

  const ctx = resolveProject(null);
  const dataDir = ctx.dataDir;
  const primaryRepo = ctx.projectPath;

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicSpecPath = join(dataDir, "specs", `${epicId}.md`);
  if (!existsFile(epicPath)) {
    emitFailureEnvelope(
      "epic_not_found",
      `Epic not found in ${ctx.projectPath}: ${epicId}`,
      [`epic_id: ${epicId}`],
    );
    return 1;
  }

  // ------------------------------------------------------------------
  // Phase 1: read (1 MiB cap) + parse YAML (pyyaml-safe_load parity).
  // ------------------------------------------------------------------
  let doc: unknown;
  try {
    const rawBytes = readYamlBytes(fileArg);
    doc = parseYamlInput(rawBytes, fileArg);
  } catch (exc) {
    if (exc instanceof YamlInputError) {
      emitFailureEnvelope(exc.code, exc.message, exc.details);
      return 1;
    }
    throw exc;
  }

  // ------------------------------------------------------------------
  // Phase 2: validate shape — accumulate ALL errors before returning.
  // ------------------------------------------------------------------
  const errors: string[] = [];

  if (!isPlainObject(doc)) {
    emitFailureEnvelope(
      "bad_yaml",
      "Top-level YAML must be a mapping (any of `epic:`, `add_tasks:`, " +
        "`rewrite_specs:`, `rewire_deps:`)",
      [`got: ${typeName(doc)}`],
    );
    return 1;
  }

  let epicNode = "epic" in doc ? doc.epic : {};
  let addTasksNode = "add_tasks" in doc ? doc.add_tasks : [];
  let rewriteSpecsNode = "rewrite_specs" in doc ? doc.rewrite_specs : [];
  let rewireDepsNode = "rewire_deps" in doc ? doc.rewire_deps : [];

  if (!isPlainObject(epicNode)) {
    errors.push("epic: must be a mapping when present");
    epicNode = {};
  }
  if (!Array.isArray(addTasksNode)) {
    errors.push("add_tasks: must be a list when present");
    addTasksNode = [];
  }
  if (!Array.isArray(rewriteSpecsNode)) {
    errors.push("rewrite_specs: must be a list when present");
    rewriteSpecsNode = [];
  }
  if (!Array.isArray(rewireDepsNode)) {
    errors.push("rewire_deps: must be a list when present");
    rewireDepsNode = [];
  }

  if (errors.length > 0) {
    emitFailureEnvelope("bad_yaml", "Invalid refine-apply YAML shape", errors);
    return 1;
  }

  const epic = epicNode as Record<string, unknown>;
  const addTasks = addTasksNode as unknown[];
  const rewriteSpecsList = rewriteSpecsNode as unknown[];
  const rewireDepsListNode = rewireDepsNode as unknown[];

  const epicSpecVal = "spec" in epic ? epic.spec : undefined;
  if (
    !epicSpecVal &&
    addTasks.length === 0 &&
    rewriteSpecsList.length === 0 &&
    rewireDepsListNode.length === 0
  ) {
    emitFailureEnvelope(
      "bad_yaml",
      "Delta is empty — supply at least one of `epic.spec`, `add_tasks`, " +
        "`rewrite_specs`, `rewire_deps`",
      [],
    );
    return 1;
  }

  // --- Epic spec rewrite (optional) ---------------------------------
  let epicSpecRewrite: string | null = null;
  if ("spec" in epic) {
    const epicSpec = epic.spec;
    if (!isStr(epicSpec)) {
      errors.push("epic: `spec` must be a string (use a `|` block scalar)");
    } else {
      epicSpecRewrite = epicSpec;
    }
  }

  // --- Enumerate existing task ids (for target + dep existence checks) ---
  const existingTaskIds = new Set<string>();
  const tasksDir = join(dataDir, "tasks");
  for (const stem of globTaskStems(tasksDir, epicId)) {
    existingTaskIds.add(stem);
  }

  // --- add_tasks validation (per-entry) -----------------------------
  const nNew = addTasks.length;
  const newTitles: string[] = [];
  const newSpecs: string[] = [];
  const newSnippetsList: unknown[][] = [];
  const newBundlesList: unknown[][] = [];
  // Raw deps: each entry mixes existing-id strings + new-ordinal ints.
  const newDepsRaw: (string | number)[][] = [];
  // null => omitted -> defaults to epic.primary_repo at mutate time.
  const newTargetRepos: (string | null)[] = [];
  // Tier + model are REQUIRED on every add_tasks entry — mirrors scaffold's
  // enforcement.
  const newTiers: string[] = [];
  const newModels: string[] = [];

  const specErrors: string[] = [];
  const depErrors: string[] = [];
  const repoErrors: string[] = [];
  const tierErrors: string[] = [];
  const modelErrors: string[] = [];

  for (let idx = 0; idx < nNew; idx += 1) {
    const i = idx + 1;
    const prefix = `add_tasks #${i}`;
    const entry = addTasks[idx];
    if (!isPlainObject(entry)) {
      errors.push(`${prefix}: must be a mapping`);
      newTitles.push("");
      newSpecs.push("");
      newSnippetsList.push([]);
      newBundlesList.push([]);
      newDepsRaw.push([]);
      newTargetRepos.push(null);
      newTiers.push("");
      newModels.push("");
      continue;
    }

    let title = entry.title;
    if (!isStr(title) || title.trim() === "") {
      errors.push(`${prefix}: \`title\` must be a non-empty string`);
      title = "";
    }
    newTitles.push(isStr(title) ? title : "");

    let spec = entry.spec;
    if (!isStr(spec) || spec.trim() === "") {
      specErrors.push(`${prefix}: \`spec\` must be a non-empty string`);
      spec = "";
    } else {
      try {
        ensureValidTaskSpec(spec);
      } catch (exc) {
        specErrors.push(`${prefix}: spec invalid: ${errMessage(exc)}`);
      }
    }
    newSpecs.push(isStr(spec) ? spec : "");

    // Dormant-seam pass-through: snippets/bundles persist verbatim, unvalidated.
    newSnippetsList.push(toArray("snippets" in entry ? entry.snippets : []));
    newBundlesList.push(toArray("bundles" in entry ? entry.bundles : []));

    let deps = "deps" in entry ? entry.deps : [];
    if (!Array.isArray(deps)) {
      depErrors.push(
        `${prefix}: \`deps\` must be a list of existing task ids (str) ` +
          "and/or 1-based new-ordinal integers",
      );
      deps = [];
    } else {
      for (const d of deps) {
        // Bools are NOT valid ordinals (Python rejects bool, an int subtype).
        if (
          typeof d === "boolean" ||
          !(
            typeof d === "string" ||
            (typeof d === "number" && Number.isInteger(d))
          )
        ) {
          depErrors.push(
            `${prefix}: dep ${pyRepr(d)} must be an existing task id (str) ` +
              "or a 1-based new-ordinal int",
          );
        }
      }
    }
    newDepsRaw.push(
      Array.isArray(deps) ? [...(deps as (string | number)[])] : [],
    );

    const targetRepoRaw = "target_repo" in entry ? entry.target_repo : null;
    if (targetRepoRaw === null || targetRepoRaw === undefined) {
      newTargetRepos.push(null);
    } else if (!isStr(targetRepoRaw)) {
      errors.push(`${prefix}: \`target_repo\` must be a string when present`);
      newTargetRepos.push(null);
    } else {
      const stripped = targetRepoRaw.trim();
      if (stripped === "") {
        repoErrors.push(
          `${prefix}: \`target_repo\` must be non-empty after strip`,
        );
        newTargetRepos.push(null);
      } else if (!(stripped.startsWith("/") || stripped.startsWith("~"))) {
        repoErrors.push(
          `${prefix}: \`target_repo\` ${pyReprStr(targetRepoRaw)} must be an ` +
            "absolute path (starts with / or ~)",
        );
        newTargetRepos.push(null);
      } else {
        try {
          newTargetRepos.push(expandPath(stripped));
        } catch (exc) {
          repoErrors.push(
            `${prefix}: \`target_repo\` ${pyReprStr(targetRepoRaw)} could not ` +
              `be expanded: ${errMessage(exc)}`,
          );
          newTargetRepos.push(null);
        }
      }
    }

    const efforts = configuredEfforts();
    const tierRaw = "tier" in entry ? entry.tier : null;
    if (tierRaw === null || tierRaw === undefined) {
      tierErrors.push(
        `${prefix}: \`tier\` is required (missing) — must be one of ` +
          `${efforts.join(", ")}`,
      );
      newTiers.push("");
    } else if (!isStr(tierRaw)) {
      errors.push(`${prefix}: \`tier\` must be a string`);
      newTiers.push("");
    } else if (!efforts.includes(tierRaw)) {
      tierErrors.push(
        `${prefix}: \`tier\` ${pyReprStr(tierRaw)} is not one of ${efforts.join(", ")}`,
      );
      newTiers.push("");
    } else {
      newTiers.push(tierRaw);
    }

    const models = configuredModels();
    const modelRaw = "model" in entry ? entry.model : null;
    if (modelRaw === null || modelRaw === undefined) {
      modelErrors.push(
        `${prefix}: \`model\` is required (missing) — must be one of ` +
          `${models.join(", ")}`,
      );
      newModels.push("");
    } else if (!isStr(modelRaw)) {
      errors.push(`${prefix}: \`model\` must be a string`);
      newModels.push("");
    } else if (!models.includes(modelRaw)) {
      modelErrors.push(
        `${prefix}: \`model\` ${pyReprStr(modelRaw)} is not one of ${models.join(", ")}`,
      );
      newModels.push("");
    } else {
      newModels.push(modelRaw);
    }
  }

  // --- rewrite_specs validation (per-entry) -------------------------
  const rewriteTargets: string[] = [];
  const rewriteSpecMd: string[] = [];
  const seenRewrite = new Set<string>();
  for (let idx = 0; idx < rewriteSpecsList.length; idx += 1) {
    const i = idx + 1;
    const prefix = `rewrite_specs #${i}`;
    const entry = rewriteSpecsList[idx];
    if (!isPlainObject(entry)) {
      errors.push(`${prefix}: must be a mapping`);
      continue;
    }
    let tid: string | null = null;
    const tidRaw = entry.task_id;
    if (!isStr(tidRaw) || !isTaskId(tidRaw)) {
      errors.push(`${prefix}: \`task_id\` must be a valid task id`);
    } else {
      tid = tidRaw;
    }
    let spec = entry.spec;
    if (!isStr(spec) || spec.trim() === "") {
      specErrors.push(`${prefix}: \`spec\` must be a non-empty string`);
      spec = "";
    } else {
      try {
        ensureValidTaskSpec(spec);
      } catch (exc) {
        specErrors.push(`${prefix}: spec invalid: ${errMessage(exc)}`);
      }
    }
    if (tid !== null) {
      if (seenRewrite.has(tid)) {
        errors.push(`${prefix}: duplicate rewrite target ${tid}`);
      }
      seenRewrite.add(tid);
      rewriteTargets.push(tid);
      rewriteSpecMd.push(isStr(spec) ? spec : "");
    }
  }

  // --- rewire_deps validation (per-entry) ---------------------------
  const rewireTargets: string[] = [];
  const rewireDepsLists: string[][] = [];
  const seenRewire = new Set<string>();
  for (let idx = 0; idx < rewireDepsListNode.length; idx += 1) {
    const i = idx + 1;
    const prefix = `rewire_deps #${i}`;
    const entry = rewireDepsListNode[idx];
    if (!isPlainObject(entry)) {
      errors.push(`${prefix}: must be a mapping`);
      continue;
    }
    let tid: string | null = null;
    const tidRaw = entry.task_id;
    if (!isStr(tidRaw) || !isTaskId(tidRaw)) {
      errors.push(`${prefix}: \`task_id\` must be a valid task id`);
    } else {
      tid = tidRaw;
    }
    let deps = "deps" in entry ? entry.deps : [];
    if (!isListOfStr(deps)) {
      depErrors.push(
        `${prefix}: \`deps\` must be a list of task id strings ` +
          "(empty list clears deps)",
      );
      deps = [];
    }
    if (tid !== null) {
      if (seenRewire.has(tid)) {
        errors.push(`${prefix}: duplicate rewire target ${tid}`);
      }
      seenRewire.add(tid);
      rewireTargets.push(tid);
      rewireDepsLists.push(isListOfStr(deps) ? [...deps] : []);
    }
  }

  // Shape/type errors short-circuit (bad_yaml) — graph integrity below is
  // meaningless when the basic shape is wrong. Failure-code priority order
  // matches run_refine_apply's: bad_yaml -> spec_invalid -> repo_invalid ->
  // tier_invalid -> model_invalid (then dep_invalid / dep_cycle inside the flock).
  if (errors.length > 0) {
    emitFailureEnvelope("bad_yaml", "Invalid refine-apply YAML shape", errors);
    return 1;
  }
  if (specErrors.length > 0) {
    emitFailureEnvelope(
      "spec_invalid",
      "One or more task specs failed validation",
      [...specErrors, ...repoErrors, ...tierErrors, ...modelErrors],
    );
    return 1;
  }
  if (repoErrors.length > 0) {
    emitFailureEnvelope(
      "repo_invalid",
      "One or more add_tasks `target_repo` values are invalid",
      [...repoErrors, ...tierErrors, ...modelErrors],
    );
    return 1;
  }
  if (tierErrors.length > 0) {
    emitFailureEnvelope(
      "tier_invalid",
      "One or more add_tasks `tier` values are invalid",
      [...tierErrors, ...modelErrors],
    );
    return 1;
  }
  if (modelErrors.length > 0) {
    emitFailureEnvelope(
      "model_invalid",
      "One or more add_tasks `model` values are invalid",
      modelErrors,
    );
    return 1;
  }

  // ------------------------------------------------------------------
  // Phase 3: allocate new-task ids under the global flock, resolve the
  // post-delta graph, write the delta. The flock guards scanMaxTaskId against a
  // concurrent task add to the same epic (the suffix is epic-scoped). On a
  // failure the closure returns a sentinel so the verb can emit + return OUTSIDE
  // the lock; success carries out the fields Phase 4.5 + emit() need. The
  // integrity gate / emit NEVER run inside the lock.
  // ------------------------------------------------------------------
  type FlockOutcome =
    | { kind: "failure"; code: string; message: string; details: string[] }
    | {
        kind: "success";
        newTaskIds: string[];
        writtenPaths: string[];
      };

  const outcome = withEpicIdLock<FlockOutcome>(() => {
    // max(scan, ledger)+1, never bare scan: the durable id ledger (per-epic task
    // scope) keeps a task number burned after its files are destroyed, so the
    // destroy-then-re-mint sequence cannot reuse it on this host.
    const maxTask = Math.max(
      scanMaxTaskId(dataDir, epicId),
      ledgerMaxTaskNum(primaryRepo, epicId),
    );
    // Two-pass: ordinal i (1-based into add_tasks) -> id `epic_id.{max+i}`.
    const newIdByOrdinal = new Map<number, string>();
    for (let i = 1; i <= nNew; i += 1) {
      newIdByOrdinal.set(i, `${epicId}.${maxTask + i}`);
    }
    const newTaskIds: string[] = [];
    for (let i = 1; i <= nNew; i += 1) {
      newTaskIds.push(newIdByOrdinal.get(i) as string);
    }

    // The full set of task ids that exist AFTER the delta lands.
    const postDeltaIds = new Set<string>([...existingTaskIds, ...newTaskIds]);

    // --- target existence: rewrites/rewires must hit existing tasks ----
    const targetErrors: string[] = [];
    for (const tid of rewriteTargets) {
      if (!existingTaskIds.has(tid)) {
        targetErrors.push(
          `rewrite_specs: task ${tid} does not exist in epic ${epicId}`,
        );
      }
    }
    for (const tid of rewireTargets) {
      if (!existingTaskIds.has(tid)) {
        targetErrors.push(
          `rewire_deps: task ${tid} does not exist in epic ${epicId}`,
        );
      }
    }
    if (targetErrors.length > 0) {
      return {
        kind: "failure",
        code: "target_invalid",
        message: "One or more rewrite/rewire targets are invalid",
        details: targetErrors,
      };
    }

    // --- resolve new-task deps (existing id str OR new-ordinal int) ----
    const resolvedNewDeps: string[][] = [];
    for (let i = 1; i <= nNew; i += 1) {
      const resolved: string[] = [];
      for (const d of newDepsRaw[i - 1] as (string | number)[]) {
        if (typeof d === "string") {
          if (!postDeltaIds.has(d)) {
            depErrors.push(
              `add_tasks #${i}: dep ${pyReprStr(d)} references a task absent ` +
                "after the delta",
            );
          } else {
            resolved.push(d);
          }
        } else {
          // int ordinal into add_tasks
          if (d < 1 || d > nNew) {
            depErrors.push(
              `add_tasks #${i}: dep ordinal ${d} out of range ` +
                `(must be 1..${nNew})`,
            );
          } else if (d === i) {
            depErrors.push(
              `add_tasks #${i}: dep ordinal ${d} is self-referential`,
            );
          } else {
            resolved.push(newIdByOrdinal.get(d) as string);
          }
        }
      }
      resolvedNewDeps.push(resolved);
    }

    // --- validate rewired dep targets exist post-delta -----------------
    for (let idx = 0; idx < rewireTargets.length; idx += 1) {
      const tid = rewireTargets[idx] as string;
      for (const d of rewireDepsLists[idx] as string[]) {
        if (!isTaskId(d)) {
          depErrors.push(
            `rewire_deps ${tid}: dep ${pyReprStr(d)} is not a valid task id`,
          );
        } else if (!postDeltaIds.has(d)) {
          depErrors.push(
            `rewire_deps ${tid}: dep ${pyReprStr(d)} references a task absent ` +
              "after the delta",
          );
        } else if (d === tid) {
          depErrors.push(
            `rewire_deps ${tid}: dep ${pyReprStr(d)} is self-referential`,
          );
        }
      }
    }

    if (depErrors.length > 0) {
      return {
        kind: "failure",
        code: "dep_invalid",
        message: "One or more task dependencies are invalid",
        details: depErrors,
      };
    }

    // --- build the POST-delta graph and detect cycles ------------------
    // Load existing tasks' current dep lists, then overlay rewires + adds.
    // Also capture each existing task's target_repo (if any) for the
    // touched_repos rollup. detectCycles iteration order decides which cycle
    // surfaces; sort node ids + adjacency lists for cross-engine determinism.
    const graph: Record<string, { depends_on: string[] }> = {};
    const existingTargetRepos: string[] = [];
    for (const tid of [...existingTaskIds].sort()) {
      const tdef = loadJson(join(dataDir, "tasks", `${tid}.json`));
      graph[tid] = {
        depends_on: [...((tdef.depends_on as string[] | undefined) ?? [])],
      };
      const etr = tdef.target_repo;
      if (etr) {
        existingTargetRepos.push(etr as string);
      }
    }
    for (let idx = 0; idx < rewireTargets.length; idx += 1) {
      const tid = rewireTargets[idx] as string;
      graph[tid] = { depends_on: [...(rewireDepsLists[idx] as string[])] };
    }
    for (let i = 1; i <= nNew; i += 1) {
      graph[newIdByOrdinal.get(i) as string] = {
        depends_on: resolvedNewDeps[i - 1] as string[],
      };
    }

    const cycle = detectCycles(graph);
    if (cycle) {
      return {
        kind: "failure",
        code: "dep_cycle",
        message: "Post-delta task dependency graph contains a cycle",
        details: [`cycle: ${cycle.join(" -> ")}`],
      };
    }

    // --- backstop collision check on new-task paths --------------------
    const collisions: string[] = [];
    for (let i = 1; i <= nNew; i += 1) {
      const tid = newIdByOrdinal.get(i) as string;
      const tp = join(dataDir, "tasks", `${tid}.json`);
      const sp = join(dataDir, "specs", `${tid}.md`);
      if (existsFile(tp)) {
        collisions.push(`task JSON exists: ${tp}`);
      }
      if (existsFile(sp)) {
        collisions.push(`task spec exists: ${sp}`);
      }
    }
    if (collisions.length > 0) {
      return {
        kind: "failure",
        code: "id_collision",
        message: `Allocated new-task ids under ${epicId} would overwrite existing files`,
        details: collisions,
      };
    }

    // --------------------------------------------------------------
    // Phase 4: mutate — assert-all is done; write the delta.
    // --------------------------------------------------------------
    const now = nowIso();

    const epicDef = loadJson(epicPath);
    epicDef.updated_at = now;
    const epicTargetRepo = epicDef.primary_repo as string | null | undefined;

    // Resolve per-new-task target_repos: each null defaults to epic.primary_repo.
    // touched_repos is recomputed on EVERY invocation as the sorted-uniq rollup
    // of every task's resolved target_repo. Falsy values are filtered so the
    // sort never compares str <-> null.
    const resolvedNewTargetRepos: (string | null)[] = newTargetRepos.map(
      (tr) => (tr !== null ? tr : (epicTargetRepo ?? null)),
    );
    const touchedSet = new Set<string>();
    for (const tr of existingTargetRepos) {
      if (tr) {
        touchedSet.add(tr);
      }
    }
    for (const tr of resolvedNewTargetRepos) {
      if (tr) {
        touchedSet.add(tr);
      }
    }
    epicDef.touched_repos = [...touchedSet].sort();

    // Burn each new task number in the durable ledger BEFORE any file write,
    // still inside the flock, so a later destroy leaves the numbers claimed and
    // re-minting allocates strictly higher. Fail-soft (keyed on the state repo).
    const epicNum = parseId(epicId)[0] ?? 0;
    for (let i = 1; i <= nNew; i += 1) {
      const tid = newIdByOrdinal.get(i) as string;
      appendTaskRecord(primaryRepo, epicNum, epicId, maxTask + i, tid);
    }

    // Track FRESH-MINT writes for the mid-write / Phase-4.5 unwind. CRITICAL:
    // existing-file rewrites (epic JSON, epic spec, rewrite_/rewire_ targets)
    // are OMITTED — atomicWrite is rename-based, so a mid-write failure leaves
    // their previous bytes intact; unlinking them would destroy user data.
    const writtenPaths: string[] = [];
    try {
      // Existing-file rewrite — NOT recorded for unwind.
      atomicWriteJson(epicPath, epicDef, dataDir);
      if (epicSpecRewrite !== null) {
        // Existing-file rewrite — NOT recorded for unwind.
        atomicWrite(epicSpecPath, epicSpecRewrite, dataDir);
      }

      // New tasks (two-pass id allocation already resolved deps to ids).
      // FRESH-MINT paths — recorded for unwind.
      for (let i = 1; i <= nNew; i += 1) {
        const tid = newIdByOrdinal.get(i) as string;
        const taskDef: Record<string, unknown> = {
          id: tid,
          epic: epicId,
          title: newTitles[i - 1],
          priority: null,
          depends_on: resolvedNewDeps[i - 1],
          target_repo: resolvedNewTargetRepos[i - 1],
          tier: newTiers[i - 1],
          model: newModels[i - 1],
          snippets: toArray(newSnippetsList[i - 1]),
          bundles: toArray(newBundlesList[i - 1]),
          created_at: now,
          updated_at: now,
        };
        const tp = join(dataDir, "tasks", `${tid}.json`);
        const sp = join(dataDir, "specs", `${tid}.md`);
        atomicWriteJson(tp, taskDef, dataDir);
        writtenPaths.push(tp);
        atomicWrite(sp, newSpecs[i - 1] as string, dataDir);
        writtenPaths.push(sp);
      }

      // Spec rewrites on existing tasks (spec md + bump task updated_at).
      // Existing files — NOT recorded for unwind (rename-atomic).
      for (let idx = 0; idx < rewriteTargets.length; idx += 1) {
        const tid = rewriteTargets[idx] as string;
        const sp = join(dataDir, "specs", `${tid}.md`);
        atomicWrite(sp, rewriteSpecMd[idx] as string, dataDir);
        const tdef = loadJson(join(dataDir, "tasks", `${tid}.json`));
        tdef.updated_at = now;
        atomicWriteJson(join(dataDir, "tasks", `${tid}.json`), tdef, dataDir);
      }

      // Dep rewires on existing tasks (full replacement of depends_on).
      // Existing files — NOT recorded for unwind (rename-atomic).
      for (let idx = 0; idx < rewireTargets.length; idx += 1) {
        const tid = rewireTargets[idx] as string;
        const tdef = loadJson(join(dataDir, "tasks", `${tid}.json`));
        tdef.depends_on = [...(rewireDepsLists[idx] as string[])];
        tdef.updated_at = now;
        atomicWriteJson(join(dataDir, "tasks", `${tid}.json`), tdef, dataDir);
      }
    } catch (exc) {
      // Mid-write raise inside the lock: unlink the FRESH-MINT files only.
      for (const p of writtenPaths) {
        unlinkQuiet(p);
      }
      throw exc;
    }

    return { kind: "success", newTaskIds, writtenPaths };
  });

  if (outcome.kind === "failure") {
    emitFailureEnvelope(outcome.code, outcome.message, outcome.details);
    return 1;
  }

  const { newTaskIds, writtenPaths } = outcome;

  // ------------------------------------------------------------------
  // Phase 4.5: post-write integrity gate (OUTSIDE the lock).
  // ------------------------------------------------------------------
  // refine-apply IS an INTEGRITY_GATE_VERBS member: re-validate the post-mutation
  // tree (checkFilesystemRepos=true so the repo paths are re-probed). It never
  // touches last_validated_at — the marker is an arm-exclusive latch, so
  // refine-apply leaves the (Phase-R1-invalidated) epic a ghost for the trailing
  // `validate --epic` arm to flip. On integrity FAILURE integrityGateOrFail prints
  // integrity_failed + process.exit(1); the `onFailure` hook fires BEFORE the exit
  // and unwinds the FRESH-MINT new-task files (the epic / rewrite / rewire updates
  // are OMITTED — rewrites of existing user data). This threads the Python
  // try/except unwind through the hook, since the Bun gate exits rather than
  // throwing.
  integrityGateOrFail(epicId, dataDir, {
    verb: "refine-apply",
    checkFilesystemRepos: true,
    onFailure: () => {
      for (const p of writtenPaths) {
        unlinkQuiet(p);
      }
    },
  });

  // ------------------------------------------------------------------
  // Phase 5: emit ONE envelope covering the whole delta (OUTSIDE the lock).
  // ------------------------------------------------------------------
  emitMutating(
    {
      epic_id: epicId,
      added_task_ids: newTaskIds,
      rewritten_specs: [...rewriteTargets],
      rewired_deps: [...rewireTargets],
      epic_spec_rewritten: epicSpecRewrite !== null,
    },
    {
      verb: "refine-apply",
      target: epicId,
      repoRoot: ctx.projectPath,
      primaryRepo,
    },
  );
  return 0;
}

// --- Local helpers ---------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

/** Python type(doc).__name__ for the top-level shape error. Only the common YAML
 * top-level scalars need exact parity. */
function typeName(v: unknown): string {
  if (v === null || v === undefined) {
    return "NoneType";
  }
  if (Array.isArray(v)) {
    return "list";
  }
  if (typeof v === "boolean") {
    return "bool";
  }
  if (typeof v === "number") {
    return Number.isInteger(v) ? "int" : "float";
  }
  if (typeof v === "string") {
    return "str";
  }
  if (v instanceof Date) {
    return "datetime.date";
  }
  return "dict";
}

function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? [...v] : [];
}

function errMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Python `!r` for a string scalar — single-quoted. Mirrors scaffold.pyReprStr. */
function pyReprStr(v: string): string {
  return `'${v}'`;
}

/** Python `!r` for an arbitrary dep scalar in the bad-ordinal message. A string
 * is single-quoted; a number / bool renders plain (True/False for booleans,
 * matching Python's repr). */
function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    return pyReprStr(v);
  }
  if (typeof v === "boolean") {
    return v ? "True" : "False";
  }
  return String(v);
}

function existsFile(path: string): boolean {
  return existsSync(path);
}

/** Stems of `tasks/<epicId>.<m>.json` files (one directory glob). */
function globTaskStems(tasksDir: string, epicId: string): string[] {
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
      // Only direct children `<epicId>.<m>` (no nested dots).
      const middle = stem.slice(prefix.length);
      if (middle.length > 0 && !middle.includes(".")) {
        out.push(stem);
      }
    }
  }
  return out;
}

/** Unlink `path`, swallowing any error (best-effort fresh-mint unwind). */
function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore — best-effort cleanup.
  }
}
