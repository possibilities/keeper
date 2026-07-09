// Shared post-write integrity gate for the structural mutation verbs.
//
// INTEGRITY_GATE_VERBS is the canonical member list; integrityGateOrFail is the
// gate every member rides AFTER its structural write lands: re-load the on-disk
// tree, extend the epic universe across discovered projects (fail-soft → empty
// global map), and run the integrity check. On a clean result it returns; on any
// error it prints the compact integrity_failed envelope and exits 1, leaving the
// structural write on disk (fail-FORWARD) — except add-dep, whose runSetter
// rollback hook restores prior state BEFORE the exit. The gate NEVER reads or
// writes last_validated_at: the marker is an arm-exclusive one-way latch owned
// solely by armEpicValidated (arm) and the two invalidate paths (un-arm), so a
// mutation verb can never arm a ghost or refresh an armed epic. runSetter factors
// the apply→pre-gate→gate→updated_at spine with the two special-case hooks as
// callbacks.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverProjects, scanEpicIdsGlobal } from "./discovery.ts";
import { compactJson } from "./format.ts";
import { checkEpicTree } from "./integrity.ts";
import { resolveDataDir } from "./state_path.ts";
import {
  atomicWriteJson,
  LocalFileStateStore,
  loadJsonSafe,
  nowIso,
} from "./store.ts";

/** The verbs that run the post-write integrity gate on a structural mutation.
 * The canonical member list — none of them touch last_validated_at. */
export const INTEGRITY_GATE_VERBS: readonly string[] = [
  "set-description",
  "set-acceptance",
  "reset",
  "add-dep",
  "add-deps",
  "rm-dep",
  "set-primary-repo",
  "set-touched-repos",
  "set-target-repo",
  "mv-repo",
  "refine-apply",
  "assign-cells",
  "apply-selection",
];

/** The compact integrity_failed envelope shape the gate prints. */
interface IntegrityFailure {
  success: false;
  error: {
    code: "integrity_failed";
    message: string;
    details: string[];
  };
}

/** Build the compact integrity_failed envelope — message exactly
 * "<verb> on <epic_id> produced an invalid epic tree". The marker is left
 * untouched on both the pass and fail paths, so the message names only the
 * structural violation. */
function buildIntegrityFailure(
  verb: string,
  epicId: string,
  errors: string[],
): IntegrityFailure {
  return {
    success: false,
    error: {
      code: "integrity_failed",
      message: `${verb} on ${epicId} produced an invalid epic tree`,
      details: errors,
    },
  };
}

/** Print the compact integrity_failed envelope and exit 1 — the structural write
 * already landed, so a success envelope would mislead. An optional `onFailure`
 * hook fires BEFORE the print/exit so a caller (add-dep) can roll its write back
 * first. */
function emitIntegrityFailure(
  verb: string,
  epicId: string,
  errors: string[],
  onFailure?: () => void,
): never {
  if (onFailure !== undefined) {
    onFailure();
  }
  process.stdout.write(
    `${compactJson(buildIntegrityFailure(verb, epicId, errors))}\n`,
  );
  process.exit(1);
}

/** Re-validate the epic on disk post-write, or print the integrity_failed
 * envelope and exit 1. The shared post-write gate the members ride: loads the
 * on-disk tree, builds the project-local all-epics set + dep map from one glob,
 * extends the existence/cycle universe across discovered projects (fail-soft →
 * empty global map), and runs the integrity check. Returns on a clean result;
 * NEVER touches last_validated_at. On error, `onFailure` (when supplied) fires
 * before the exit so add-dep can roll back. */
export function integrityGateOrFail(
  epicId: string,
  dataDir: string,
  opts: {
    verb: string;
    checkFilesystemRepos?: boolean;
    onFailure?: () => void;
  },
): void {
  const { verb, checkFilesystemRepos = false, onFailure } = opts;

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicData = loadJsonSafe(epicPath);
  if (epicData === null) {
    emitIntegrityFailure(
      verb,
      epicId,
      [`Epic ${epicId}: definition file is missing or invalid JSON`],
      onFailure,
    );
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
    for (const entry of readdirSync(tasksDir).sort()) {
      if (!entry.startsWith(prefix) || !entry.endsWith(".json")) {
        continue;
      }
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

  const stateStore = new LocalFileStateStore(join(dataDir, "state"));

  const [coreErrors] = checkEpicTree(
    epicId,
    epicData,
    taskDefs,
    taskSpecContents,
    {
      dataDir,
      allEpicIds,
      stateStore,
      checkFilesystemRepos,
      allEpicDeps,
      allGlobalEpicIds,
    },
  );
  const errors = [...loadErrors, ...coreErrors];
  if (errors.length > 0) {
    emitIntegrityFailure(verb, epicId, errors, onFailure);
  }
}

/** A setter's per-verb behaviour plugged into the shared runSetter spine. */
export interface SetterHooks {
  /** Apply the structural change + write it to disk (task JSON, spec file, or
   * the epic JSON itself). The spine re-loads the epic from disk after the
   * gate, so an apply that wrote the epic stays the source of truth. */
  apply: () => void;
  /** Pre-gate hook — runs after `apply`, before the integrity gate. Used by
   * set-target-repo to recompute + write epic.touched_repos so the recompute
   * is covered by the same post-write integrity check. Optional. */
  preGate?: () => void;
  /** Rollback handler — fires (via integrityGateOrFail's onFailure) before the
   * integrity_failed exit so add-dep restores its pre-write epic JSON. Optional. */
  rollback?: () => void;
}

/** The shared setter spine: apply the structural write, run the optional
 * pre-gate hook, gate through integrityGateOrFail (which exits 1 on integrity
 * failure, firing `rollback` first when supplied), then bump updated_at on the
 * epic JSON for the setters whose apply did not touch it. NEVER writes
 * last_validated_at — the marker is an arm-exclusive one-way latch, so a
 * structural edit to an armed epic leaves the marker byte-identical and a ghost
 * stays a ghost. The setters that bump updated_at in their own apply / pre-gate
 * (add-dep, rm-dep, the repo setters, set-target-repo) pass stampUpdatedAt=false,
 * so the tail is a no-op for them. The setter verb owns the emit itself. */
export function runSetter(
  epicId: string,
  dataDir: string,
  opts: {
    verb: string;
    checkFilesystemRepos?: boolean;
    stampUpdatedAt?: boolean;
    hooks: SetterHooks;
  },
): void {
  const {
    verb,
    checkFilesystemRepos = false,
    stampUpdatedAt = true,
    hooks,
  } = opts;

  hooks.apply();
  if (hooks.preGate !== undefined) {
    hooks.preGate();
  }

  integrityGateOrFail(epicId, dataDir, {
    verb,
    checkFilesystemRepos,
    onFailure: hooks.rollback,
  });

  // Bump updated_at on the post-gate epic JSON for the section/repo setters whose
  // apply did not touch the epic JSON. The setters that already stamped updated_at
  // in their apply / pre-gate opt out via stampUpdatedAt=false.
  if (stampUpdatedAt) {
    const epicPath = join(dataDir, "epics", `${epicId}.json`);
    const epicDef = loadJsonSafe(epicPath) ?? {};
    epicDef.updated_at = nowIso();
    atomicWriteJson(epicPath, epicDef, dataDir);
  }
}
