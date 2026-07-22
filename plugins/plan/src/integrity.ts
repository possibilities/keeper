// Per-epic structural-integrity check — the byte-parity port of
// planctl/integrity.py's _check_epic_tree and its public wrappers.
//
// String parity is the whole game: every error/warning interpolation is matched
// against the Python catalog, including Python repr quoting for the repo
// warnings (single-quoted, backslash/quote/control-char escaped via pyRepr) and
// the TWO distinct path-comparison semantics — os.path.samefile (dev+ino stat
// equality) for the primary_repo mis-location check, and Path.resolve() string
// compare for target_repo touched_repos coverage. The checkFilesystemRepos
// toggle is wired through: the set-*-repo integrity-gate callers pass false (warn-and-
// write on a not-yet-landed path), validate --epic passes true. The
// spec-heading check is NOT forked — validateTaskSpecHeadings from specs.ts is
// reused verbatim.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

import { type DepGraph, detectCycles } from "./deps.ts";
import { discoverProjects, scanEpicIdsGlobal } from "./discovery.ts";
import { epicIdFromTask, isEpicId, isTaskId } from "./ids.ts";
import { mergeTaskState } from "./models.ts";
// The spec-heading check is reused verbatim from specs.ts — never forked here.
import { validateTaskSpecHeadings } from "./specs.ts";
import { resolveDataDir } from "./state_path.ts";
import { LocalFileStateStore, loadJsonSafe } from "./store.ts";
export { validateTaskSpecHeadings };

// Status enums — mirror planctl/models.py EPIC_STATUSES / TASK_STATUSES.
const EPIC_STATUSES = ["open", "done"];
const TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];

/** Reproduce Python's repr() for a string: single-quoted unless the value
 * contains a `'` and no `"` (then double-quoted), with backslash, the chosen
 * quote, and the standard control chars escaped (\n \r \t plus \xNN for other
 * sub-0x20 / 0x7f-0xa0 codes). Filesystem paths are almost always plain
 * single-quoted, but a path carrying a quote or control byte must round-trip the
 * same bytes Python's f"{x!r}" emits. */
function pyRepr(value: string): string {
  // Choose the quote char the way CPython does: prefer ', switch to " only when
  // the string has a ' but no ".
  let quote = "'";
  if (value.includes("'") && !value.includes('"')) {
    quote = '"';
  }
  let out = quote;
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === quote) {
      out += `\\${quote}`;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  out += quote;
  return out;
}

/** Return an error string if `pathStr` is not a valid `.git/`-bearing repo, else
 * null. Mirrors integrity._validate_repo_path — existence first, then `.git`
 * presence; the two messages are pinned verbatim. */
export function validateRepoPath(
  pathStr: string,
  label: string,
): string | null {
  if (!existsSync(pathStr)) {
    return `${label}: path does not exist: ${pathStr}`;
  }
  if (!existsSync(join(pathStr, ".git"))) {
    return `${label}: path exists but contains no .git/: ${pathStr}`;
  }
  return null;
}

/** dev+ino stat equality — the os.path.samefile contract. False on any stat
 * error (a missing path is never "same"). Reproduces samefile's symlink-aware
 * identity so a string-compare shortcut never diverges on symlinked repos. */
function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/** Optional state-store surface the check consults for runtime-aware status. */
interface StatusStore {
  loadRuntime(taskId: string): Record<string, unknown> | null;
}

export interface CheckEpicTreeOptions {
  dataDir: string;
  allEpicIds: Set<string>;
  stateStore: StatusStore | null;
  checkFilesystemRepos?: boolean;
  allEpicDeps?: Record<string, string[]> | null;
  allGlobalEpicIds?: Record<string, string> | null;
  epicSpecContent?: string | null;
  // When true AND the epic's status is "done", missing-repo path failures and
  // dangling cross-epic deps degrade from errors to warnings — a done epic's
  // references are immutable, so an unrepairable one cannot hard-fail. Only the
  // validate verb opts in; every live epic and every gate/in-memory caller keeps
  // hard errors byte-identically.
  tolerateDoneEpicDebris?: boolean;
}

/** Pure structural-integrity check returning [errors, warnings]. The single
 * linear port of integrity._check_epic_tree — see that function for the full
 * parameter contract. Every string is byte-matched against the Python catalog. */
export function checkEpicTree(
  eid: string,
  epicData: Record<string, unknown>,
  taskDefs: Record<string, Record<string, unknown>>,
  taskSpecContents: Record<string, string | null>,
  opts: CheckEpicTreeOptions,
): [string[], string[]] {
  const {
    dataDir,
    allEpicIds,
    stateStore,
    checkFilesystemRepos = true,
    allEpicDeps = null,
    allGlobalEpicIds = null,
    epicSpecContent = null,
    tolerateDoneEpicDebris = false,
  } = opts;

  const errors: string[] = [];
  const warnings: string[] = [];

  // Missing-repo path failures and dangling cross-epic deps on a DONE epic are
  // unfixable; route them here so the validate verb's tolerance demotes them to
  // warnings while every live epic keeps them as hard errors.
  const demoteDebris = tolerateDoneEpicDebris && epicData.status === "done";
  const debrisSink = (msg: string): void => {
    (demoteDebris ? warnings : errors).push(msg);
  };

  // --- Epic meta -------------------------------------------------------
  for (const field of ["id", "title", "status"]) {
    if (!(field in epicData)) {
      errors.push(`Epic ${eid}: missing required field '${field}'`);
    }
  }

  const status = (epicData.status as string | undefined) ?? "";
  if (!EPIC_STATUSES.includes(status)) {
    errors.push(`Epic ${eid}: invalid status '${status}'`);
  }

  // Epic spec presence: on-disk by default; in-memory when epicSpecContent set.
  if (epicSpecContent === null) {
    const specPath = join(dataDir, "specs", `${eid}.md`);
    if (!existsSync(specPath)) {
      errors.push(`Epic ${eid}: spec file missing at specs/${eid}.md`);
    }
  }

  // --- Epic-level depends_on_epics -------------------------------------
  const epicDeps = (epicData.depends_on_epics as string[] | undefined) ?? [];
  for (const depEid of epicDeps) {
    if (depEid === eid) {
      errors.push(`Epic ${eid}: self-referential dependency`);
    } else if (!isEpicId(depEid)) {
      errors.push(
        `Epic ${eid}: invalid epic ID in depends_on_epics: ${depEid}`,
      );
    } else if (
      !allEpicIds.has(depEid) &&
      (allGlobalEpicIds === null || !(depEid in allGlobalEpicIds))
    ) {
      debrisSink(`Epic ${eid}: dependency ${depEid} does not exist`);
    }
  }

  // --- Cycle detection across the epic-dep graph -----------------------
  if (allEpicDeps !== null) {
    const epicDepGraph: DepGraph = {};
    // Sort node ids before building so the DFS start order is deterministic
    // across engines (readdir/object-key order is arbitrary in both).
    for (const epId of Object.keys(allEpicDeps).sort()) {
      epicDepGraph[epId] = {
        depends_on: [...((allEpicDeps[epId] as string[]) ?? [])].sort(),
      };
    }
    // Overlay the post-mutation dep list for the epic under check.
    epicDepGraph[eid] = { depends_on: [...epicDeps].sort() };
    const epicCycle = detectCycles(epicDepGraph);
    if (epicCycle !== null && epicCycle.length > 0) {
      errors.push(
        `Epic ${eid}: epic-dep cycle detected: ${epicCycle.join(" -> ")}`,
      );
    }
  }

  // --- Multi-repo fields -----------------------------------------------
  const primaryRepo = epicData.primary_repo;
  if (primaryRepo !== null && primaryRepo !== undefined) {
    const primaryRepoStr = primaryRepo as string;
    if (checkFilesystemRepos) {
      const err = validateRepoPath(primaryRepoStr, `Epic ${eid}: primary_repo`);
      if (err !== null) {
        debrisSink(err);
      } else if (!sameFile(primaryRepoStr, dirname(dataDir))) {
        debrisSink(
          `Epic ${eid}: primary_repo ${pyRepr(primaryRepoStr)} does not match ` +
            `the epic's data directory parent ${pyRepr(dirname(dataDir))} — epic is mis-located`,
        );
      }
    }

    const touchedRepos = epicData.touched_repos;
    if (
      touchedRepos !== null &&
      touchedRepos !== undefined &&
      checkFilesystemRepos
    ) {
      for (const tr of touchedRepos as string[]) {
        const err = validateRepoPath(tr, `Epic ${eid}: touched_repos entry`);
        if (err !== null) {
          debrisSink(err);
        }
      }
    }
  }

  // --- Per-task checks -------------------------------------------------
  const epicTaskIds = new Set(Object.keys(taskDefs));
  const taskGraph: Record<string, Record<string, unknown>> = {};

  for (const [tid, taskData] of Object.entries(taskDefs)) {
    for (const field of ["id", "epic", "title"]) {
      if (!(field in taskData)) {
        errors.push(`Task ${tid}: missing required field '${field}'`);
      }
    }

    // Status: runtime-aware when a state store is provided, else spec-side.
    let taskStatus: string;
    if (stateStore !== null) {
      const runtime = stateStore.loadRuntime(tid);
      const merged = mergeTaskState(taskData, runtime);
      taskStatus = (merged.status as string | undefined) ?? "todo";
    } else {
      taskStatus = (taskData.status as string | undefined) ?? "todo";
    }
    if (!TASK_STATUSES.includes(taskStatus)) {
      errors.push(`Task ${tid}: invalid status '${taskStatus}'`);
    }

    // Task spec validation — reuse the shared heading check, never fork it.
    const specText = taskSpecContents[tid];
    if (specText === null || specText === undefined) {
      errors.push(`Task ${tid}: spec file missing at specs/${tid}.md`);
    } else {
      for (const he of validateTaskSpecHeadings(specText)) {
        errors.push(`Task ${tid}: ${he}`);
      }
    }

    // Task dependency shape + cross-epic check.
    for (const depTid of (taskData.depends_on as string[] | undefined) ?? []) {
      if (depTid === tid) {
        errors.push(`Task ${tid}: self-referential dependency`);
      } else if (!isTaskId(depTid)) {
        errors.push(`Task ${tid}: invalid task ID in depends_on: ${depTid}`);
      } else {
        try {
          const depEpic = epicIdFromTask(depTid);
          if (depEpic !== eid) {
            errors.push(
              `Task ${tid}: dependency ${depTid} is in different epic ${depEpic}`,
            );
          }
        } catch {
          errors.push(`Task ${tid}: invalid dependency ID: ${depTid}`);
        }
      }
    }

    // target_repo validation (new-style tasks only — null skips).
    const targetRepo = taskData.target_repo;
    if (targetRepo !== null && targetRepo !== undefined) {
      const targetRepoStr = targetRepo as string;
      if (checkFilesystemRepos) {
        const err = validateRepoPath(targetRepoStr, `Task ${tid}: target_repo`);
        if (err !== null) {
          debrisSink(err);
        }
      }
      // Warn (not error) when target_repo is absent from epic.touched_repos —
      // a pure-string check via Path.resolve(), fires under either toggle mode.
      const touchedRepos = epicData.touched_repos;
      if (touchedRepos !== null && touchedRepos !== undefined) {
        const resolvedTarget = resolvePath(targetRepoStr);
        const resolvedTouched = (touchedRepos as string[]).map((tr) =>
          resolvePath(tr),
        );
        if (!resolvedTouched.includes(resolvedTarget)) {
          warnings.push(
            `Task ${tid}: target_repo ${pyRepr(targetRepoStr)} is not in ` +
              `epic.touched_repos — this may indicate a misconfiguration`,
          );
        }
      }
    }

    taskGraph[tid] = taskData;
  }

  // --- Cross-task dep existence ----------------------------------------
  // Canonical task and dependency order keeps the error catalog stable for
  // both filesystem-loaded and in-memory callers.
  for (const tid of Object.keys(taskGraph).sort()) {
    const tdata = taskGraph[tid] as Record<string, unknown>;
    const deps = [...((tdata.depends_on as string[] | undefined) ?? [])].sort();
    for (const depTid of deps) {
      if (!epicTaskIds.has(depTid)) {
        errors.push(`Task ${tid}: dependency ${depTid} does not exist`);
      }
    }
  }

  // --- Cycle detection across the task graph ---------------------------
  // Preserve the dependency values; detectCycles owns canonical node and edge
  // traversal, so the surfaced path is deterministic independently of loading.
  const rawTaskGraph: DepGraph = {};
  for (const [tid, tdata] of Object.entries(taskGraph)) {
    rawTaskGraph[tid] = {
      depends_on: [...((tdata.depends_on as string[] | undefined) ?? [])],
    };
  }
  const cycle = detectCycles(rawTaskGraph);
  if (cycle !== null && cycle.length > 0) {
    errors.push(
      `Epic ${eid}: dependency cycle detected: ${cycle.join(" -> ")}`,
    );
  }

  // --- Epic-done coherence (every task must be done) -------------------
  if (epicData.status === "done") {
    for (const tid of [...epicTaskIds].sort()) {
      const tdata =
        (taskGraph[tid] as Record<string, unknown> | undefined) ?? {};
      let tstatus: unknown;
      if (stateStore !== null) {
        const runtime = stateStore.loadRuntime(tid);
        const merged = mergeTaskState(tdata, runtime);
        tstatus = merged.status;
      } else {
        tstatus = tdata.status;
      }
      if (tstatus !== "done") {
        errors.push(
          `Epic ${eid}: status is 'done' but task ${tid} has status '${String(tstatus)}'`,
        );
      }
    }
  }

  return [errors, warnings];
}

/** Run the integrity check against a pre-assembled in-memory tree (no disk
 * round-trip). state_store is hardcoded null and checkFilesystemRepos defaults
 * false — fresh-mint trees carry spec-side status and may reference repo paths
 * not yet present as .git/ dirs locally. Mirrors integrity.check_epic_tree_in_memory. */
export function checkEpicTreeInMemory(
  eid: string,
  epicData: Record<string, unknown>,
  taskDefs: Record<string, Record<string, unknown>>,
  taskSpecContents: Record<string, string | null>,
  opts: {
    dataDir: string;
    allEpicIds: Set<string>;
    checkFilesystemRepos?: boolean;
    allEpicDeps?: Record<string, string[]> | null;
    allGlobalEpicIds?: Record<string, string> | null;
    epicSpecContent?: string | null;
  },
): [string[], string[]] {
  return checkEpicTree(eid, epicData, taskDefs, taskSpecContents, {
    dataDir: opts.dataDir,
    allEpicIds: opts.allEpicIds,
    stateStore: null,
    checkFilesystemRepos: opts.checkFilesystemRepos ?? false,
    allEpicDeps: opts.allEpicDeps ?? null,
    allGlobalEpicIds: opts.allGlobalEpicIds ?? null,
    epicSpecContent: opts.epicSpecContent ?? null,
  });
}

/** Load the on-disk tree for `epicId` under `dataDir` and run the integrity
 * check, returning [errors, warnings]. The disk-loading public surface — builds
 * the project-local all-epics set + dep map from one epics/ glob, then extends
 * the existence/cycle universe across every discovered project (fail-soft on
 * discovery → empty global map). Mirrors integrity.validate_epic_integrity_with_warnings. */
export function validateEpicIntegrityWithWarnings(
  epicId: string,
  dataDir: string,
  opts: {
    checkFilesystemRepos?: boolean;
    tolerateDoneEpicDebris?: boolean;
  } = {},
): [string[], string[]] {
  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicData = loadJsonSafe(epicPath);
  if (epicData === null) {
    return [[`Epic ${epicId}: definition file is missing or invalid JSON`], []];
  }

  // Project-local all-epics set + {epic_id: depends_on_epics} map (one glob).
  const epicsDir = join(dataDir, "epics");
  const allEpicIds = new Set<string>();
  const allEpicDeps: Record<string, string[]> = {};
  if (existsSync(epicsDir)) {
    for (const entry of readdirSync(epicsDir).sort()) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const stem = entry.slice(0, -".json".length);
      allEpicIds.add(stem);
      const ep = loadJsonSafe(join(epicsDir, entry));
      if (ep === null) {
        continue;
      }
      allEpicDeps[stem] = [
        ...((ep.depends_on_epics as string[] | undefined) ?? []),
      ];
    }
  }
  allEpicDeps[epicId] = [
    ...((epicData.depends_on_epics as string[] | undefined) ?? []),
  ];

  // Extend the existence + cycle universe across discovered projects, fail-soft.
  let discovered: string[];
  try {
    discovered = discoverProjects();
  } catch {
    discovered = [];
  }
  const allGlobalEpicIds =
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
      for (const entry of readdirSync(otherEpics).sort()) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        const stem = entry.slice(0, -".json".length);
        if (stem in allEpicDeps) {
          continue;
        }
        const ep = loadJsonSafe(join(otherEpics, entry));
        if (ep === null) {
          continue;
        }
        allEpicDeps[stem] = [
          ...((ep.depends_on_epics as string[] | undefined) ?? []),
        ];
      }
    }
  }

  // Load tasks belonging to this epic + their spec contents.
  const taskDefs: Record<string, Record<string, unknown>> = {};
  const taskSpecContents: Record<string, string | null> = {};
  const loadErrors: string[] = [];
  const prefix = `${epicId}.`;
  const tasksDir = join(dataDir, "tasks");
  if (existsSync(tasksDir)) {
    // Canonical loading stabilizes all task-scoped diagnostics, not only the
    // cycle path normalized by detectCycles.
    for (const entry of readdirSync(tasksDir).sort()) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".json")) {
        continue;
      }
      // Match Python's glob(f"{epic_id}.*.json"): single ordinal segment only.
      const middle = entry.slice(prefix.length, -".json".length);
      if (middle.length === 0 || middle.includes(".")) {
        continue;
      }
      const stem = entry.slice(0, -".json".length);
      const taskData = loadJsonSafe(join(tasksDir, entry));
      if (taskData === null) {
        loadErrors.push(`Task ${stem}: definition file is invalid JSON`);
        continue;
      }
      const tid = typeof taskData.id === "string" ? taskData.id : stem;
      taskDefs[tid] = taskData;
      const taskSpecPath = join(dataDir, "specs", `${tid}.md`);
      taskSpecContents[tid] = existsSync(taskSpecPath)
        ? readFileSync(taskSpecPath, "utf-8")
        : null;
    }
  }

  // Resolve a state-store for runtime-aware status — the state dir is the
  // standard <dataDir>/state. A missing dir yields null overlays (read-never-
  // creates), so no resolve_project round-trip is needed for the read.
  const stateStore: StatusStore = new LocalFileStateStore(
    join(dataDir, "state"),
  );

  const [coreErrors, coreWarnings] = checkEpicTree(
    epicId,
    epicData,
    taskDefs,
    taskSpecContents,
    {
      dataDir,
      allEpicIds,
      stateStore,
      checkFilesystemRepos: opts.checkFilesystemRepos ?? true,
      allEpicDeps,
      allGlobalEpicIds,
      tolerateDoneEpicDebris: opts.tolerateDoneEpicDebris ?? false,
    },
  );
  return [[...loadErrors, ...coreErrors], coreWarnings];
}

/** Errors-only disk-loading surface — the simpler pass/fail bit most callers
 * want. Mirrors integrity.validate_epic_integrity. */
export function validateEpicIntegrity(
  epicId: string,
  dataDir: string,
  opts: {
    checkFilesystemRepos?: boolean;
    tolerateDoneEpicDebris?: boolean;
  } = {},
): string[] {
  return validateEpicIntegrityWithWarnings(epicId, dataDir, opts)[0];
}
