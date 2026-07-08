// scaffold verb — the byte-parity port of planctl/run_scaffold.py.
//
// The program's biggest single port: materialize a whole epic tree from one YAML
// in a single transactional call. Strict assert-all -> mutate -> emit.
//
// Three envelope shapes, routed EXPLICITLY:
//  - pre-commit failures (missing_session_id, bad_yaml, spec_invalid,
//    dep_invalid, epic_dep_invalid, repo_invalid, tier_invalid, dep_cycle,
//    id_collision, duplicate_epic, integrity_failed) -> emitFailureEnvelope (the
//    accumulate-all path), the verb returns 1, ZERO disk side-effect except the
//    §10 no-rollback carve-out below;
//  - the commit-boundary carve-out (commit_failed) -> emitMutating's own failure
//    line, leaving the written tree on disk uncommitted;
//  - success -> emitMutating ({epic_id, task_ids, repo_distribution}).
//
// Correctness, not style: the flock spans dup-guard through ALL atomic writes (a
// write outside the lock reopens the mint race); the mid-write unwind unlinks
// SPECS BEFORE JSONs (the orphan-spec invariant — scanMaxEpicId scans specs/ too,
// so a JSON-before-spec unwind would leave a spec that poisons the id counter).

import { existsSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { join, resolve as resolveAbs } from "node:path";

import { acquirePlanCommitGuard } from "../commit.ts";
import { detectCycles } from "../deps.ts";
import {
  checkGlobalNameUnique,
  discoverProjects,
  resolveEpicGlobally,
  scanEpicIdsGlobal,
} from "../discovery.ts";
import { emitFailureEnvelope, emitMutating } from "../emit.ts";
import { withEpicIdLock } from "../flock.ts";
import { appendEpicRecord, ledgerMaxEpicNum } from "../id_ledger.ts";
import {
  epicIdsWithNumber,
  generateSuffix,
  isEpicId,
  scanMaxEpicId,
  slugify,
} from "../ids.ts";
import { checkEpicTreeInMemory } from "../integrity.ts";
import { configuredEfforts, configuredModels } from "../models.ts";
import { resolveProject } from "../project.ts";
import { expandPath } from "../repo_inference.ts";
import { ensureValidTaskSpec } from "../specs.ts";
import { resolveDataDir } from "../state_path.ts";
import {
  atomicWrite,
  atomicWriteJson,
  loadJson,
  loadJsonSafe,
  nowIso,
} from "../store.ts";
import {
  MAX_YAML_BYTES,
  parseYamlInput,
  readYamlBytes,
} from "../yaml_input.ts";

interface ScaffoldArgs {
  file: string;
  allowDuplicate: boolean;
  createdByCloseOf: string | null;
}

/** YAML implicit-typing guard: an actual string, not a bool/number/Date the
 * eemeli 1.1 parser coerces a norway boolean / numeric / ISO-date scalar into.
 * Mirrors run_scaffold._is_str. */
function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function isListOfStr(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** A list of integers, excluding booleans. The eemeli parser yields plain JS
 * numbers for octal / underscore numerics, so the range check sees the COERCED
 * value. Mirrors run_scaffold._is_list_of_int (which rejects Python bool, an int
 * subtype). */
function isListOfInt(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.every((x) => typeof x === "number" && Number.isInteger(x))
  );
}

/** Render a value the way the Python ``!r`` conversion does for the messages the
 * conformance suite pins (string -> single-quoted; everything else -> its plain
 * form). Only strings reach the !r sites in scaffold's emitted details. */
function pyReprStr(v: string): string {
  return `'${v}'`;
}

/** The fail-loud cross-repo follow-up guard for a `created_by_close_of` mint:
 * when the SOURCE epic touches more than one repo, every follow-up task MUST
 * carry an explicit, in-set `target_repo` — silently defaulting to primary_repo
 * would dispatch a worker into the wrong tree. `multiRepo` is true iff the
 * source's `touched_repos` is a strict superset of `{primary_repo}` (a
 * single-repo source has a deterministic answer and never gates). `allowed` is
 * the realpath-normalized member set the per-task `target_repo` must belong to.
 * Both seams (the dry-run + the mint) compute the check from this one shape so
 * the planner can reproduce any reject. */
export interface SourceRepoGuard {
  multiRepo: boolean;
  allowed: Set<string>;
}

/** Normalize a repo path the one way the guard compares both sides: absolute +
 * realpath, falling back to the absolute form when the path can't be resolved.
 * Equivalent to expandPath's resolution for an already-absolute input, so a
 * `target_repo` (expandPath-normalized) and a source `touched_repos` member
 * compare equal when they name the same tree. */
function normalizeRepo(p: string): string {
  const abs = resolveAbs(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Build the cross-repo guard from a source epic's `touched_repos` +
 * `primary_repo`. Pure: the caller supplies the source-of-truth (the brief on
 * the dry-run seam, the on-disk source epic on the mint seam). multiRepo fires
 * only when at least one normalized touched repo is NOT the primary — a strict
 * superset of `{primary}`. */
export function buildSourceRepoGuard(
  touchedRepos: string[] | null | undefined,
  primaryRepo: string,
): SourceRepoGuard {
  const allowed = new Set<string>();
  const normalizedPrimary = normalizeRepo(primaryRepo);
  if (Array.isArray(touchedRepos)) {
    for (const tr of touchedRepos) {
      if (typeof tr === "string" && tr) {
        allowed.add(normalizeRepo(tr));
      }
    }
  }
  // Strict superset of {primary}: a member outside the primary exists.
  let multiRepo = false;
  for (const member of allowed) {
    if (member !== normalizedPrimary) {
      multiRepo = true;
      break;
    }
  }
  return { multiRepo, allowed };
}

/** Load the cross-repo guard for the mint seam: resolve the source epic named
 * by `createdByCloseOf` and build the guard from its on-disk `touched_repos` +
 * `primary_repo` — the SAME source-of-truth the dry-run reads off the brief.
 * Returns null for a non-close mint (createdByCloseOf null) or an
 * unresolvable/unreadable source epic (fail-open: a source that can't be read
 * cannot prove multi-repo, so the existing default-to-primary path stands). */
function loadSourceRepoGuard(
  createdByCloseOf: string | null,
): SourceRepoGuard | null {
  if (createdByCloseOf === null) {
    return null;
  }
  const resolution = resolveEpicGlobally(createdByCloseOf);
  if (!resolution.resolved || resolution.epicPath === null) {
    return null;
  }
  const sourceEpic = loadJsonSafe(resolution.epicPath);
  if (sourceEpic === null) {
    return null;
  }
  const touchedRepos = sourceEpic.touched_repos as string[] | null | undefined;
  const primaryRepo =
    (sourceEpic.primary_repo as string | null | undefined) ?? "";
  return buildSourceRepoGuard(touchedRepos, primaryRepo);
}

/** Per-task `repo_required` offenders for a multi-repo source follow-up. Each
 * task's `target_repo` (the raw entry value, null when omitted) must be present
 * AND a member of the source's `touched_repos`. A single-repo source (or no
 * guard) yields no offenders — the existing default-to-primary path is
 * untouched. Pure + deterministic: reads only the guard's member set, never
 * findings/clock/fs inference. */
function repoRequiredErrors(
  taskTargetRepos: (string | null)[],
  guard: SourceRepoGuard | null,
): string[] {
  if (guard === null || !guard.multiRepo) {
    return [];
  }
  const offenders: string[] = [];
  for (let idx = 0; idx < taskTargetRepos.length; idx += 1) {
    const prefix = `task #${idx + 1}`;
    const tr = taskTargetRepos[idx];
    if (tr === null || tr === undefined) {
      offenders.push(
        `${prefix}: \`target_repo\` is required — the source epic is ` +
          "multi-repo, so a follow-up task cannot default to primary_repo",
      );
      continue;
    }
    if (!guard.allowed.has(normalizeRepo(tr))) {
      offenders.push(
        `${prefix}: \`target_repo\` ${pyReprStr(tr)} is not in the source ` +
          "epic's touched_repos",
      );
    }
  }
  return offenders;
}

/** The dry-run validation verdict from validateScaffoldYaml — scaffold's
 * structural verdict WITHOUT minting. On success `ok` is true and `nTasks`
 * carries the task count; on failure `ok` is false and the
 * code/message/details triplet describes the dominant error class in
 * scaffold's exact priority order. `taskTargetRepos` carries the per-task
 * collected target_repo (null when omitted, validated-but-unexpanded string
 * otherwise) so the dry-run seam can apply the cross-repo guard against the
 * source's touched_repos. Mirrors ScaffoldValidation. */
export interface ScaffoldValidation {
  ok: boolean;
  nTasks: number;
  code: string;
  message: string;
  details: string[];
  taskTargetRepos: (string | null)[];
}

function validationFailure(
  code: string,
  message: string,
  details: string[],
): ScaffoldValidation {
  return { ok: false, nTasks: 0, code, message, details, taskTargetRepos: [] };
}

/** Run scaffold's read-cap + parse + Phase-2 validation, NO mutation — the
 * validate half of scaffold's assert-all -> mutate -> emit flow, factored so a
 * caller that wants scaffold's structural verdict WITHOUT minting anything
 * (followup submit's dry-run) shares the exact leaf checkers (isStr,
 * isListOfStr, isListOfInt, ensureValidTaskSpec, detectCycles, the tier
 * validator) and the exact failure-code priority order scaffold itself uses.
 *
 * Does NOT allocate ids and does NOT run the filesystem integrity gate — those
 * are mint-only steps. `checkEpicDeps` controls the lazy resolveEpicGlobally
 * existence pass for declared depends_on_epics. Mirrors validate_scaffold_yaml;
 * runScaffold keeps its own inline flow (it threads parsed forward-data into the
 * mutate phase), the two kept behavior-identical by the divergence conformance
 * tests rather than a shared parsed-data return. */
export function validateScaffoldYaml(
  rawBytes: Buffer,
  fileLabel: string,
  checkEpicDeps = true,
  sourceRepoGuard: SourceRepoGuard | null = null,
): ScaffoldValidation {
  if (rawBytes.length > MAX_YAML_BYTES) {
    return validationFailure(
      "bad_yaml",
      `YAML exceeds ${MAX_YAML_BYTES} bytes (got ${rawBytes.length})`,
      [`file: ${fileLabel}`],
    );
  }

  let doc: unknown;
  try {
    doc = parseYamlInput(rawBytes, fileLabel);
  } catch (exc) {
    if (isYamlInputError(exc)) {
      return validationFailure("bad_yaml", exc.message, exc.details);
    }
    throw exc;
  }

  const errors: string[] = [];
  if (!isPlainObject(doc)) {
    return validationFailure(
      "bad_yaml",
      "Top-level YAML must be a mapping with `epic:` and `tasks:` keys",
      [`got: ${typeName(doc)}`],
    );
  }

  let epicNode = doc.epic;
  let tasksNode = doc.tasks;
  if (!isPlainObject(epicNode)) {
    errors.push("epic: must be a mapping");
    epicNode = {};
  }
  if (!Array.isArray(tasksNode)) {
    errors.push("tasks: must be a list");
    tasksNode = [];
  }
  if (errors.length > 0) {
    return validationFailure("bad_yaml", "Invalid scaffold YAML shape", errors);
  }

  const epic = epicNode as Record<string, unknown>;
  const tasks = tasksNode as unknown[];

  // --- Epic-level validation (mirrors runScaffold Phase 2) ----------------
  const epicTitle = epic.title;
  if (!isStr(epicTitle) || epicTitle.trim() === "") {
    errors.push("epic: `title` must be a non-empty string");
  }

  const epicBranch = epic.branch;
  if (epicBranch !== undefined && epicBranch !== null && !isStr(epicBranch)) {
    errors.push("epic: `branch` must be a string when present");
  }

  const epicSpec = "spec" in epic ? epic.spec : "";
  if (!isStr(epicSpec)) {
    errors.push("epic: `spec` must be a string (use a `|` block scalar)");
  }

  const epicDepErrors: string[] = [];
  let dependsOnEpics: string[] = [];
  const dependsOnRaw = "depends_on_epics" in epic ? epic.depends_on_epics : [];
  if (!isListOfStr(dependsOnRaw)) {
    epicDepErrors.push("epic: `depends_on_epics` must be a list of strings");
    dependsOnEpics = [];
  } else {
    dependsOnEpics = dependsOnRaw;
    const seenDeps = new Set<string>();
    for (const depId of dependsOnEpics) {
      if (!isEpicId(depId)) {
        epicDepErrors.push(
          `epic: depends_on_epics id ${pyReprStr(depId)} is not a valid epic id`,
        );
      }
      if (seenDeps.has(depId)) {
        epicDepErrors.push(
          `epic: depends_on_epics id ${pyReprStr(depId)} is duplicated`,
        );
      }
      seenDeps.add(depId);
    }
  }

  // --- Task-level validation ----------------------------------------------
  const nTasks = tasks.length;
  if (nTasks === 0) {
    errors.push("tasks: must contain at least one entry");
  }

  const taskDepsList: number[][] = [];
  const taskTargetRepos: (string | null)[] = [];
  const specErrors: string[] = [];
  const depErrors: string[] = [];
  const repoErrors: string[] = [];
  const tierErrors: string[] = [];
  const modelErrors: string[] = [];

  for (let idx = 0; idx < nTasks; idx += 1) {
    const i = idx + 1;
    const prefix = `task #${i}`;
    const entry = tasks[idx];
    if (!isPlainObject(entry)) {
      errors.push(`${prefix}: must be a mapping`);
      taskDepsList.push([]);
      taskTargetRepos.push(null);
      continue;
    }

    const title = entry.title;
    if (!isStr(title) || title.trim() === "") {
      errors.push(`${prefix}: \`title\` must be a non-empty string`);
    }

    const spec = entry.spec;
    if (!isStr(spec) || spec.trim() === "") {
      specErrors.push(`${prefix}: \`spec\` must be a non-empty string`);
    } else {
      try {
        ensureValidTaskSpec(spec);
      } catch (exc) {
        specErrors.push(`${prefix}: spec invalid: ${errMessage(exc)}`);
      }
    }

    let deps = "deps" in entry ? entry.deps : [];
    if (!isListOfInt(deps)) {
      depErrors.push(
        `${prefix}: \`deps\` must be a list of 1-based ordinal integers`,
      );
      deps = [];
    } else {
      for (const ordVal of deps) {
        if (ordVal < 1 || ordVal > nTasks) {
          depErrors.push(
            `${prefix}: dep ordinal ${ordVal} out of range (must be 1..${nTasks})`,
          );
        } else if (ordVal === i) {
          depErrors.push(
            `${prefix}: dep ordinal ${ordVal} is self-referential`,
          );
        }
      }
    }
    taskDepsList.push(isListOfInt(deps) ? [...deps] : []);

    const targetRepoRaw = "target_repo" in entry ? entry.target_repo : null;
    if (targetRepoRaw === null || targetRepoRaw === undefined) {
      taskTargetRepos.push(null);
    } else if (!isStr(targetRepoRaw)) {
      errors.push(`${prefix}: \`target_repo\` must be a string when present`);
      taskTargetRepos.push(null);
    } else {
      const stripped = targetRepoRaw.trim();
      if (stripped === "") {
        repoErrors.push(
          `${prefix}: \`target_repo\` must be non-empty after strip`,
        );
        taskTargetRepos.push(null);
      } else if (!(stripped.startsWith("/") || stripped.startsWith("~"))) {
        repoErrors.push(
          `${prefix}: \`target_repo\` ${pyReprStr(targetRepoRaw)} must be an ` +
            "absolute path (starts with / or ~)",
        );
        taskTargetRepos.push(null);
      } else {
        taskTargetRepos.push(stripped);
      }
    }

    const efforts = configuredEfforts();
    const tierRaw = "tier" in entry ? entry.tier : null;
    if (tierRaw === null || tierRaw === undefined) {
      tierErrors.push(
        `${prefix}: \`tier\` is required (missing) — must be one of ` +
          `${efforts.join(", ")}`,
      );
    } else if (!isStr(tierRaw)) {
      errors.push(`${prefix}: \`tier\` must be a string`);
    } else if (!efforts.includes(tierRaw)) {
      tierErrors.push(
        `${prefix}: \`tier\` ${pyReprStr(tierRaw)} is not one of ${efforts.join(", ")}`,
      );
    }

    const models = configuredModels();
    const modelRaw = "model" in entry ? entry.model : null;
    if (modelRaw === null || modelRaw === undefined) {
      modelErrors.push(
        `${prefix}: \`model\` is required (missing) — must be one of ` +
          `${models.join(", ")}`,
      );
    } else if (!isStr(modelRaw)) {
      errors.push(`${prefix}: \`model\` must be a string`);
    } else if (!models.includes(modelRaw)) {
      modelErrors.push(
        `${prefix}: \`model\` ${pyReprStr(modelRaw)} is not one of ${models.join(", ")}`,
      );
    }
  }

  // The cross-repo follow-up guard: a multi-repo source REQUIRES an explicit,
  // in-set target_repo per task. Single-repo source / non-close mint → no-op.
  const repoRequired = repoRequiredErrors(taskTargetRepos, sourceRepoGuard);

  // Failure-code priority order — identical to scaffold's run().
  if (errors.length > 0) {
    return validationFailure("bad_yaml", "Invalid scaffold YAML shape", [
      ...errors,
      ...specErrors,
      ...depErrors,
      ...epicDepErrors,
      ...repoErrors,
      ...tierErrors,
      ...modelErrors,
    ]);
  }

  if (
    checkEpicDeps &&
    dependsOnEpics.length > 0 &&
    epicDepErrors.length === 0
  ) {
    for (const depId of dependsOnEpics) {
      const depResolution = resolveEpicGlobally(depId);
      if (depResolution.ambiguous) {
        const owners = depResolution.owners.join(", ");
        epicDepErrors.push(
          `epic: depends_on_epics id ${pyReprStr(depId)} resolves to ` +
            `multiple projects: ${owners}`,
        );
      } else if (!depResolution.resolved) {
        epicDepErrors.push(
          `epic: depends_on_epics id ${pyReprStr(depId)} does not exist`,
        );
      }
    }
  }

  if (specErrors.length > 0) {
    return validationFailure(
      "spec_invalid",
      "One or more task specs failed validation",
      [
        ...specErrors,
        ...depErrors,
        ...epicDepErrors,
        ...repoErrors,
        ...tierErrors,
        ...modelErrors,
      ],
    );
  }
  if (depErrors.length > 0) {
    return validationFailure(
      "dep_invalid",
      "One or more task dependencies are invalid",
      [
        ...depErrors,
        ...epicDepErrors,
        ...repoErrors,
        ...tierErrors,
        ...modelErrors,
      ],
    );
  }
  if (epicDepErrors.length > 0) {
    return validationFailure(
      "epic_dep_invalid",
      "One or more epic-level dependencies are invalid",
      [...epicDepErrors, ...repoErrors, ...tierErrors, ...modelErrors],
    );
  }
  if (repoErrors.length > 0) {
    return validationFailure(
      "repo_invalid",
      "One or more task `target_repo` values are invalid",
      [...repoErrors, ...tierErrors, ...modelErrors],
    );
  }
  if (tierErrors.length > 0) {
    return validationFailure(
      "tier_invalid",
      "One or more task `tier` values are invalid",
      [...tierErrors, ...modelErrors],
    );
  }
  if (modelErrors.length > 0) {
    return validationFailure(
      "model_invalid",
      "One or more task `model` values are invalid",
      modelErrors,
    );
  }
  if (repoRequired.length > 0) {
    return validationFailure(
      "repo_required",
      "One or more follow-up tasks need an explicit in-set `target_repo` " +
        "because the source epic is multi-repo",
      repoRequired,
    );
  }

  // --- Cycle detection on the in-memory ordinal graph ---------------------
  const graph: Record<string, { depends_on: string[] }> = {};
  for (let i = 1; i <= nTasks; i += 1) {
    graph[String(i)] = {
      depends_on: (taskDepsList[i - 1] as number[]).map((d) => String(d)),
    };
  }
  const cycle = detectCycles(graph);
  if (cycle) {
    return validationFailure(
      "dep_cycle",
      "Task dependency graph contains a cycle",
      [`cycle: ${cycle.join(" -> ")}`],
    );
  }

  return {
    ok: true,
    nTasks,
    code: "",
    message: "",
    details: [],
    taskTargetRepos,
  };
}

export function runScaffold(args: ScaffoldArgs): number {
  const { file: fileArg, allowDuplicate, createdByCloseOf } = args;

  // Fail closed on a missing CLAUDE_CODE_SESSION_ID BEFORE any write — without
  // it scaffold could not build its commit envelope, so it refuses up front
  // rather than writing a tree it could not commit. The invocation builder
  // re-checks this and stays the authoritative raise; this is the early guard.
  if (!process.env.CLAUDE_CODE_SESSION_ID) {
    emitFailureEnvelope(
      "missing_session_id",
      "CLAUDE_CODE_SESSION_ID is unset; scaffold cannot build its commit " +
        "envelope and refuses to write a tree it could not commit. The claude " +
        "binary ships it intrinsically inside a Claude harness; tests and " +
        "manual invocations must set it themselves.",
      [],
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
    if (isYamlInputError(exc)) {
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
      "Top-level YAML must be a mapping with `epic:` and `tasks:` keys",
      [`got: ${typeName(doc)}`],
    );
    return 1;
  }

  let epicNode = doc.epic;
  let tasksNode = doc.tasks;

  if (!isPlainObject(epicNode)) {
    errors.push("epic: must be a mapping");
    epicNode = {};
  }
  if (!Array.isArray(tasksNode)) {
    errors.push("tasks: must be a list");
    tasksNode = [];
  }
  if (errors.length > 0) {
    emitFailureEnvelope("bad_yaml", "Invalid scaffold YAML shape", errors);
    return 1;
  }

  const epic = epicNode as Record<string, unknown>;
  const tasks = tasksNode as unknown[];

  // --- Epic-level validation ----------------------------------------
  let epicTitle = epic.title;
  if (!isStr(epicTitle) || epicTitle.trim() === "") {
    errors.push("epic: `title` must be a non-empty string");
    epicTitle = "";
  }

  const epicBranch = epic.branch;
  if (epicBranch !== undefined && epicBranch !== null && !isStr(epicBranch)) {
    errors.push("epic: `branch` must be a string when present");
  }

  const epicSpec = "spec" in epic ? epic.spec : "";
  if (!isStr(epicSpec)) {
    errors.push("epic: `spec` must be a string (use a `|` block scalar)");
  }

  // Dormant-seam pass-through: snippets/bundles persist verbatim, unvalidated.
  const epicSnippets = "snippets" in epic ? epic.snippets : [];
  const epicBundles = "bundles" in epic ? epic.bundles : [];

  // --- Epic-dep validation (type / id-shape / dup; existence deferred) ----
  const epicDepErrors: string[] = [];
  let dependsOnEpics: string[] = [];
  const dependsOnRaw = "depends_on_epics" in epic ? epic.depends_on_epics : [];
  if (!isListOfStr(dependsOnRaw)) {
    epicDepErrors.push("epic: `depends_on_epics` must be a list of strings");
    dependsOnEpics = [];
  } else {
    dependsOnEpics = dependsOnRaw;
    const seenDeps = new Set<string>();
    for (const depId of dependsOnEpics) {
      if (!isEpicId(depId)) {
        epicDepErrors.push(
          `epic: depends_on_epics id ${pyReprStr(depId)} is not a valid epic id`,
        );
      }
      if (seenDeps.has(depId)) {
        epicDepErrors.push(
          `epic: depends_on_epics id ${pyReprStr(depId)} is duplicated`,
        );
      }
      seenDeps.add(depId);
    }
  }

  // --- Task-level validation (per-entry, all errors accumulated) ----
  const nTasks = tasks.length;
  if (nTasks === 0) {
    errors.push("tasks: must contain at least one entry");
  }

  const taskTitles: string[] = [];
  const taskSpecs: string[] = [];
  const taskSnippetsList: unknown[][] = [];
  const taskBundlesList: unknown[][] = [];
  const taskDepsList: number[][] = []; // 1-based ordinals
  const taskTargetRepos: (string | null)[] = [];
  const taskTiers: string[] = [];
  const taskModels: string[] = [];

  const specErrors: string[] = [];
  const depErrors: string[] = [];
  const repoErrors: string[] = [];
  const tierErrors: string[] = [];
  const modelErrors: string[] = [];

  for (let idx = 0; idx < nTasks; idx += 1) {
    const i = idx + 1;
    const prefix = `task #${i}`;
    const entry = tasks[idx];
    if (!isPlainObject(entry)) {
      errors.push(`${prefix}: must be a mapping`);
      taskTitles.push("");
      taskSpecs.push("");
      taskSnippetsList.push([]);
      taskBundlesList.push([]);
      taskDepsList.push([]);
      taskTargetRepos.push(null);
      taskTiers.push("");
      taskModels.push("");
      continue;
    }

    let title = entry.title;
    if (!isStr(title) || title.trim() === "") {
      errors.push(`${prefix}: \`title\` must be a non-empty string`);
      title = "";
    }
    taskTitles.push(isStr(title) ? title : "");

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
    taskSpecs.push(isStr(spec) ? spec : "");

    taskSnippetsList.push(toArray(entry.snippets));
    taskBundlesList.push(toArray(entry.bundles));

    let deps = "deps" in entry ? entry.deps : [];
    if (!isListOfInt(deps)) {
      depErrors.push(
        `${prefix}: \`deps\` must be a list of 1-based ordinal integers`,
      );
      deps = [];
    } else {
      for (const ordVal of deps) {
        if (ordVal < 1 || ordVal > nTasks) {
          depErrors.push(
            `${prefix}: dep ordinal ${ordVal} out of range (must be 1..${nTasks})`,
          );
        } else if (ordVal === i) {
          depErrors.push(
            `${prefix}: dep ordinal ${ordVal} is self-referential`,
          );
        }
      }
    }
    taskDepsList.push(isListOfInt(deps) ? [...deps] : []);

    const targetRepoRaw = "target_repo" in entry ? entry.target_repo : null;
    if (targetRepoRaw === null || targetRepoRaw === undefined) {
      taskTargetRepos.push(null);
    } else if (!isStr(targetRepoRaw)) {
      errors.push(`${prefix}: \`target_repo\` must be a string when present`);
      taskTargetRepos.push(null);
    } else {
      const stripped = targetRepoRaw.trim();
      if (stripped === "") {
        repoErrors.push(
          `${prefix}: \`target_repo\` must be non-empty after strip`,
        );
        taskTargetRepos.push(null);
      } else if (!(stripped.startsWith("/") || stripped.startsWith("~"))) {
        repoErrors.push(
          `${prefix}: \`target_repo\` ${pyReprStr(targetRepoRaw)} must be an ` +
            "absolute path (starts with / or ~)",
        );
        taskTargetRepos.push(null);
      } else {
        try {
          taskTargetRepos.push(expandPath(stripped));
        } catch (exc) {
          repoErrors.push(
            `${prefix}: \`target_repo\` ${pyReprStr(targetRepoRaw)} could not be ` +
              `expanded: ${errMessage(exc)}`,
          );
          taskTargetRepos.push(null);
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
      taskTiers.push("");
    } else if (!isStr(tierRaw)) {
      errors.push(`${prefix}: \`tier\` must be a string`);
      taskTiers.push("");
    } else if (!efforts.includes(tierRaw)) {
      tierErrors.push(
        `${prefix}: \`tier\` ${pyReprStr(tierRaw)} is not one of ${efforts.join(", ")}`,
      );
      taskTiers.push("");
    } else {
      taskTiers.push(tierRaw);
    }

    const models = configuredModels();
    const modelRaw = "model" in entry ? entry.model : null;
    if (modelRaw === null || modelRaw === undefined) {
      modelErrors.push(
        `${prefix}: \`model\` is required (missing) — must be one of ` +
          `${models.join(", ")}`,
      );
      taskModels.push("");
    } else if (!isStr(modelRaw)) {
      errors.push(`${prefix}: \`model\` must be a string`);
      taskModels.push("");
    } else if (!models.includes(modelRaw)) {
      modelErrors.push(
        `${prefix}: \`model\` ${pyReprStr(modelRaw)} is not one of ${models.join(", ")}`,
      );
      taskModels.push("");
    } else {
      taskModels.push(modelRaw);
    }
  }

  // Failure-code priority order — identical to scaffold's run().
  if (errors.length > 0) {
    const allErrors = [
      ...errors,
      ...specErrors,
      ...depErrors,
      ...epicDepErrors,
      ...repoErrors,
      ...tierErrors,
      ...modelErrors,
    ];
    emitFailureEnvelope("bad_yaml", "Invalid scaffold YAML shape", allErrors);
    return 1;
  }

  // Lazy epic-dep existence check: only touch disk when deps are declared.
  if (dependsOnEpics.length > 0 && epicDepErrors.length === 0) {
    const normalizedDeps: string[] = [];
    for (const depId of dependsOnEpics) {
      const depResolution = resolveEpicGlobally(depId);
      if (depResolution.ambiguous) {
        const owners = depResolution.owners.join(", ");
        epicDepErrors.push(
          `epic: depends_on_epics id ${pyReprStr(depId)} resolves to ` +
            `multiple projects: ${owners}`,
        );
      } else if (!depResolution.resolved) {
        epicDepErrors.push(
          `epic: depends_on_epics id ${pyReprStr(depId)} does not exist`,
        );
      } else {
        normalizedDeps.push(depResolution.resolvedId as string);
      }
    }
    if (epicDepErrors.length === 0) {
      dependsOnEpics = normalizedDeps;
    }
  }

  if (specErrors.length > 0) {
    emitFailureEnvelope(
      "spec_invalid",
      "One or more task specs failed validation",
      [
        ...specErrors,
        ...depErrors,
        ...epicDepErrors,
        ...repoErrors,
        ...tierErrors,
        ...modelErrors,
      ],
    );
    return 1;
  }
  if (depErrors.length > 0) {
    emitFailureEnvelope(
      "dep_invalid",
      "One or more task dependencies are invalid",
      [
        ...depErrors,
        ...epicDepErrors,
        ...repoErrors,
        ...tierErrors,
        ...modelErrors,
      ],
    );
    return 1;
  }
  if (epicDepErrors.length > 0) {
    emitFailureEnvelope(
      "epic_dep_invalid",
      "One or more epic-level dependencies are invalid",
      [...epicDepErrors, ...repoErrors, ...tierErrors, ...modelErrors],
    );
    return 1;
  }
  if (repoErrors.length > 0) {
    emitFailureEnvelope(
      "repo_invalid",
      "One or more task `target_repo` values are invalid",
      [...repoErrors, ...tierErrors, ...modelErrors],
    );
    return 1;
  }
  if (tierErrors.length > 0) {
    emitFailureEnvelope(
      "tier_invalid",
      "One or more task `tier` values are invalid",
      [...tierErrors, ...modelErrors],
    );
    return 1;
  }
  if (modelErrors.length > 0) {
    emitFailureEnvelope(
      "model_invalid",
      "One or more task `model` values are invalid",
      modelErrors,
    );
    return 1;
  }

  // The cross-repo follow-up guard: a multi-repo source REQUIRES an explicit,
  // in-set target_repo per task. Reads the SOURCE epic's touched_repos off disk
  // — the same source-of-truth the dry-run reads off the brief. Single-repo
  // source / non-close mint → no-op (the default-to-primary path below stands).
  const repoRequired = repoRequiredErrors(
    taskTargetRepos,
    loadSourceRepoGuard(createdByCloseOf),
  );
  if (repoRequired.length > 0) {
    emitFailureEnvelope(
      "repo_required",
      "One or more follow-up tasks need an explicit in-set `target_repo` " +
        "because the source epic is multi-repo",
      repoRequired,
    );
    return 1;
  }

  // Resolve the owning project before the persistence phase consumes it.
  const ctx = resolveProject(null);

  // --- Cycle detection on the full in-memory graph (ordinal-keyed) ------
  const graph: Record<string, { depends_on: string[] }> = {};
  for (let i = 1; i <= nTasks; i += 1) {
    graph[String(i)] = {
      depends_on: (taskDepsList[i - 1] as number[]).map((d) => String(d)),
    };
  }
  const cycle = detectCycles(graph);
  if (cycle) {
    emitFailureEnvelope("dep_cycle", "Task dependency graph contains a cycle", [
      `cycle: ${cycle.join(" -> ")}`,
    ]);
    return 1;
  }

  // ------------------------------------------------------------------
  // Phase 3+4: allocate ids under the flock, integrity-gate, write tree.
  // ------------------------------------------------------------------
  const dataDir = ctx.dataDir;
  const primaryRepo = ctx.projectPath;
  const epicTitleStr = epicTitle as string;
  const epicSpecStr = epicSpec as string;

  // Resolve per-task target_repos: each None defaults to primary_repo.
  const resolvedTaskTargetRepos: string[] = taskTargetRepos.map((tr) =>
    tr === null ? primaryRepo : tr,
  );
  const touchedRepos = [...new Set(resolvedTaskTargetRepos)].sort();

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
    // The flock spans dup-guard through ALL atomic writes. A failure inside
    // returns a sentinel so the verb can emit + return outside the lock; the
    // success path carries the fields emit() needs back out. NEVER emit() inside.
    type FlockOutcome =
      | { kind: "failure"; code: string; message: string; details: string[] }
      | { kind: "success"; epicId: string };

    const outcome = withEpicIdLock<FlockOutcome>(() => {
      // Dup guard: reject a same-slug sibling epic up front. Runs BEFORE id
      // allocation / any write so a rejected dup leaves scanMaxEpicId unchanged.
      const slug = slugify(epicTitleStr);
      if (slug && !allowDuplicate) {
        const epicsDir = join(dataDir, "epics");
        if (existsSync(epicsDir)) {
          // The glob fn-*-{slug}.json false-matches any epic whose slug ENDS with
          // -{slug}; pin exact-slug equivalence with a fullmatch on the stem.
          const exactStemRe = new RegExp(`^fn-\\d+-${escapeRegex(slug)}$`);
          const dupMatches = readdirSync(epicsDir)
            .filter((entry) => {
              if (!entry.endsWith(".json")) {
                return false;
              }
              const stem = entry.slice(0, -".json".length);
              return exactStemRe.test(stem) && matchesSlugGlob(stem, slug);
            })
            .sort();
          if (dupMatches.length > 0) {
            const details: string[] = [];
            for (const match of dupMatches) {
              const existingId = match.slice(0, -".json".length);
              let existingStatus: string;
              const existing = loadJsonSafe(join(epicsDir, match));
              if (existing === null) {
                existingStatus = "<unreadable>";
              } else {
                existingStatus = (existing.status as string) ?? "<unknown>";
              }
              details.push(`${existingId} (status: ${existingStatus})`);
            }
            return {
              kind: "failure",
              code: "duplicate_epic",
              message:
                `An epic with slug ${pyReprStr(slug)} already exists in this ` +
                "project; pass --allow-duplicate to mint a distinct fn-N anyway",
              details,
            };
          }
        }
      }

      // max(scan, ledger)+1, never bare scan: the durable id ledger keeps a
      // number burned even after its epic's working-tree files are destroyed, so
      // the destroy-then-re-mint sequence cannot reuse it on this host.
      const epicNum =
        Math.max(scanMaxEpicId(dataDir), ledgerMaxEpicNum(primaryRepo)) + 1;
      const epicId = slug
        ? `fn-${epicNum}-${slug}`
        : `fn-${epicNum}-${generateSuffix()}`;
      const branchName = (isStr(epicBranch) ? epicBranch : "") || "main";

      // Same-project bare-number guard: refuse if any existing epic already
      // carries this number under a different slug (an unlocked-degrade race that
      // wrote a sibling after our scan). Reuses id_collision, naming both ids.
      const bareCollisions = epicIdsWithNumber(dataDir, epicNum).filter(
        (id) => id !== epicId,
      );
      if (bareCollisions.length > 0) {
        return {
          kind: "failure",
          code: "id_collision",
          message: `Allocated epic id ${epicId} collides on number with an existing same-project epic`,
          details: bareCollisions.map((id) => `existing: ${id}`),
        };
      }

      // Global-name uniqueness check across all discovered projects.
      const foreignOwner = checkGlobalNameUnique(epicId, primaryRepo);
      if (foreignOwner !== null) {
        return {
          kind: "failure",
          code: "id_collision",
          message: `Allocated epic id ${epicId} already exists in another project`,
          details: [`existing owner: ${foreignOwner}`],
        };
      }

      // Backstop collision check before any write.
      const epicPath = join(dataDir, "epics", `${epicId}.json`);
      const epicSpecPath = join(dataDir, "specs", `${epicId}.md`);
      const collisions: string[] = [];
      if (existsSync(epicPath)) {
        collisions.push(`epic JSON exists: ${epicPath}`);
      }
      if (existsSync(epicSpecPath)) {
        collisions.push(`epic spec exists: ${epicSpecPath}`);
      }
      const taskPaths: [string, string][] = [];
      for (let i = 1; i <= nTasks; i += 1) {
        const taskId = `${epicId}.${i}`;
        const tp = join(dataDir, "tasks", `${taskId}.json`);
        const sp = join(dataDir, "specs", `${taskId}.md`);
        if (existsSync(tp)) {
          collisions.push(`task JSON exists: ${tp}`);
        }
        if (existsSync(sp)) {
          collisions.push(`task spec exists: ${sp}`);
        }
        taskPaths.push([tp, sp]);
      }
      if (collisions.length > 0) {
        return {
          kind: "failure",
          code: "id_collision",
          message: `Allocated epic id ${epicId} would overwrite existing files`,
          details: collisions,
        };
      }

      // ----- Assemble the in-memory tree -> integrity gate -> write -----
      const now = nowIso();
      const epicDef: Record<string, unknown> = {
        id: epicId,
        title: epicTitleStr,
        status: "open",
        branch_name: branchName,
        depends_on_epics: [...dependsOnEpics],
        primary_repo: primaryRepo,
        touched_repos: touchedRepos,
        snippets: toArray(epicSnippets),
        bundles: toArray(epicBundles),
        last_validated_at: null,
        created_at: now,
        updated_at: now,
      };
      if (createdByCloseOf !== null) {
        epicDef.created_by_close_of = createdByCloseOf;
      }

      const inMemTaskDefs: Record<string, Record<string, unknown>> = {};
      const inMemTaskSpecs: Record<string, string> = {};
      for (let i = 1; i <= nTasks; i += 1) {
        const taskId = `${epicId}.${i}`;
        const depOrdinals = taskDepsList[i - 1] as number[];
        const dependsOn = depOrdinals.map((d) => `${epicId}.${d}`);
        inMemTaskDefs[taskId] = {
          id: taskId,
          epic: epicId,
          title: taskTitles[i - 1],
          priority: null,
          depends_on: dependsOn,
          target_repo: resolvedTaskTargetRepos[i - 1],
          tier: taskTiers[i - 1],
          model: taskModels[i - 1],
          snippets: toArray(taskSnippetsList[i - 1]),
          bundles: toArray(taskBundlesList[i - 1]),
          created_at: now,
          updated_at: now,
        };
        inMemTaskSpecs[taskId] = taskSpecs[i - 1] as string;
      }

      // All-epic-ids set + {epic_id: depends_on_epics} map for the integrity
      // helper's existence + cycle check, with the newly-minted epic overlaid.
      const existingEpicIds = new Set<string>();
      const existingEpicDeps: Record<string, string[]> = {};
      const epicsGlobDir = join(dataDir, "epics");
      if (existsSync(epicsGlobDir)) {
        for (const f of readdirSync(epicsGlobDir)) {
          if (!f.endsWith(".json")) {
            continue;
          }
          const stem = f.slice(0, -".json".length);
          existingEpicIds.add(stem);
          const ep = loadJson(join(epicsGlobDir, f));
          existingEpicDeps[stem] = [
            ...((ep.depends_on_epics as string[] | undefined) ?? []),
          ];
        }
      }
      existingEpicIds.add(epicId);
      existingEpicDeps[epicId] = [
        ...((epicDef.depends_on_epics as string[] | undefined) ?? []),
      ];

      // Extend the existence + cycle universe across every discovered project.
      let discovered: string[];
      try {
        discovered = discoverProjects();
      } catch {
        discovered = [];
      }
      const globalEpicIds =
        discovered.length > 0 ? scanEpicIdsGlobal(discovered) : {};
      if (discovered.length > 0) {
        for (const project of discovered) {
          const otherDataDir = resolveDataDir(project);
          if (otherDataDir === null) {
            continue;
          }
          const otherEpics = join(otherDataDir, "epics");
          if (!existsSync(otherEpics)) {
            continue;
          }
          for (const f of readdirSync(otherEpics)) {
            if (!f.endsWith(".json")) {
              continue;
            }
            const stem = f.slice(0, -".json".length);
            if (stem in existingEpicDeps) {
              continue;
            }
            const ep = loadJson(join(otherEpics, f));
            existingEpicDeps[stem] = [
              ...((ep.depends_on_epics as string[] | undefined) ?? []),
            ];
          }
        }
      }

      // The inline integrity gate asserts filesystem-repo validity in-process, so
      // the trailing `validate --epic` arm never re-checks integrity — it only
      // flips the ghost marker to ready. epicSpecContent lets the helper assert
      // epic-spec presence from RAM — NO spec file is written before this passes.
      const [integErrors] = checkEpicTreeInMemory(
        epicId,
        epicDef,
        inMemTaskDefs,
        inMemTaskSpecs,
        {
          dataDir,
          allEpicIds: existingEpicIds,
          allEpicDeps: existingEpicDeps,
          allGlobalEpicIds: globalEpicIds,
          checkFilesystemRepos: true,
          epicSpecContent: epicSpecStr,
        },
      );
      if (integErrors.length > 0) {
        // Nothing written before the gate — pure no-op on disk.
        return {
          kind: "failure",
          code: "integrity_failed",
          message: "Scaffold integrity check failed against the in-memory tree",
          details: integErrors,
        };
      }

      // Integrity passed — write the whole tree. The epic mints as a not-ready
      // ghost (last_validated_at stays null from assembly: blocked by autopilot
      // readiness predicate 2, rendered dashed) so no dep-free task folds to
      // [ready] before the create/defer/close flow's trailing `validate --epic`
      // arms it once deps are wired.
      // Burn the number in the durable ledger BEFORE any file write, still inside
      // the flock: a subsequent destroy of these files leaves the ledger holding
      // the number, so re-minting allocates strictly higher. Fail-soft.
      appendEpicRecord(primaryRepo, epicNum, epicId);

      // The mid-write unwind unlinks SPECS BEFORE JSONs (orphan-spec invariant).
      const writtenPaths: string[] = [];
      try {
        atomicWriteJson(epicPath, epicDef, dataDir);
        writtenPaths.push(epicPath);
        atomicWrite(epicSpecPath, epicSpecStr, dataDir);
        writtenPaths.push(epicSpecPath);
        for (let i = 1; i <= nTasks; i += 1) {
          const taskId = `${epicId}.${i}`;
          const [tp, sp] = taskPaths[i - 1] as [string, string];
          atomicWrite(sp, taskSpecs[i - 1] as string, dataDir);
          writtenPaths.push(sp);
          atomicWriteJson(
            tp,
            inMemTaskDefs[taskId] as Record<string, unknown>,
            dataDir,
          );
          writtenPaths.push(tp);
        }
      } catch (exc) {
        for (const p of writtenPaths) {
          unlinkQuiet(p);
        }
        throw exc;
      }

      return { kind: "success", epicId };
    });

    if (outcome.kind === "failure") {
      emitFailureEnvelope(outcome.code, outcome.message, outcome.details);
      return 1;
    }

    // ------------------------------------------------------------------
    // Phase 5: emit ONE envelope covering the whole tree (OUTSIDE the lock).
    // ------------------------------------------------------------------
    const epicId = outcome.epicId;
    const taskIds: string[] = [];
    for (let i = 1; i <= nTasks; i += 1) {
      taskIds.push(`${epicId}.${i}`);
    }
    // repo_distribution = sorted {repo_path: count} counter object.
    const counts: Record<string, number> = {};
    for (const repo of resolvedTaskTargetRepos) {
      counts[repo] = (counts[repo] ?? 0) + 1;
    }
    const repoDistribution: Record<string, number> = {};
    for (const key of Object.keys(counts).sort()) {
      repoDistribution[key] = counts[key] as number;
    }

    emitMutating(
      {
        epic_id: epicId,
        task_ids: taskIds,
        repo_distribution: repoDistribution,
      },
      {
        verb: "scaffold",
        target: epicId,
        repoRoot: ctx.projectPath,
        primaryRepo,
      },
    );
    return 0;
  } finally {
    commitGuard.release();
  }
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

/** Python type(doc).__name__ for the top-level shape error: dict/list/str/int/
 * float/bool/NoneType, else the JS constructor name. Only the common YAML
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Unlink `path`, swallowing any error (best-effort mid-write unwind — a partial
 * write may have failed before rename). Mirrors the contextlib.suppress(OSError)
 * + unlink(missing_ok=True) of run_scaffold's except arm. */
function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore — best-effort cleanup.
  }
}

/** fnmatch-equivalence to the Python `fn-*-{slug}.json` glob prefilter: the stem
 * must end with `-{slug}` (or equal `fn-...-{slug}`). The exactStemRe already
 * enforces `^fn-\d+-{slug}$`, so this is belt-and-suspenders parity with the
 * Python two-step (glob then fullmatch). */
function matchesSlugGlob(stem: string, slug: string): boolean {
  return stem.endsWith(`-${slug}`);
}

interface YamlInputErrorShape {
  code: string;
  message: string;
  details: string[];
}

function isYamlInputError(exc: unknown): exc is YamlInputErrorShape {
  return (
    typeof exc === "object" &&
    exc !== null &&
    (exc as { name?: string }).name === "YamlInputError"
  );
}
