// Shared restamp pipeline — the byte-parity port of planctl/validation_restamp.py.
//
// VALIDATION_RESTAMP_VERBS is the canonical in-wave member list; restampEpicOrFail
// is the post-write gate every member rides AFTER its structural write lands:
// re-load the on-disk tree, extend the epic universe across discovered projects
// (fail-soft → empty global map), run the integrity check, and on a clean result
// return nowIso() for the caller to stamp. On any error it prints the compact
// integrity_failed envelope and exits 1, leaving the structural write on disk
// (fail-FORWARD) — except add-dep, whose runSetter rollback hook restores prior
// state BEFORE the exit. runSetter factors the load→gate→apply→write→pre-restamp
// →restamp→stamp-write→emit spine with the two special-case hooks as callbacks.

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

/** Verbs that re-stamp last_validated_at on a structural mutation. The canonical
 * in-wave member list — mirrors validation_restamp.VALIDATION_RESTAMP_VERBS. */
export const VALIDATION_RESTAMP_VERBS: readonly string[] = [
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
];

/** The compact integrity_failed envelope shape the restamp gate prints. */
interface IntegrityFailure {
  success: false;
  error: {
    code: "integrity_failed";
    message: string;
    details: string[];
  };
}

/** Build the compact integrity_failed envelope — message exactly
 * "<verb> on <epic_id> produced an invalid epic tree; last_validated_at NOT
 * re-stamped". Mirrors _emit_restamp_failure's payload. */
function buildRestampFailure(
  verb: string,
  epicId: string,
  errors: string[],
): IntegrityFailure {
  return {
    success: false,
    error: {
      code: "integrity_failed",
      message: `${verb} on ${epicId} produced an invalid epic tree; last_validated_at NOT re-stamped`,
      details: errors,
    },
  };
}

/** Print the compact integrity_failed envelope and exit 1 — the structural write
 * already landed, so a success envelope would mislead. An optional `onFailure`
 * hook fires BEFORE the print/exit so a caller (add-dep) can roll its write back
 * first; this is the Bun analogue of Python's catchable SystemExit, which add-dep
 * intercepts to restore prior state. Mirrors _emit_restamp_failure. */
function emitRestampFailure(
  verb: string,
  epicId: string,
  errors: string[],
  onFailure?: () => void,
): never {
  if (onFailure !== undefined) {
    onFailure();
  }
  process.stdout.write(
    `${compactJson(buildRestampFailure(verb, epicId, errors))}\n`,
  );
  process.exit(1);
}

/** Re-validate the epic on disk post-write and return a fresh stamp, or print the
 * integrity_failed envelope and exit 1. The shared post-write gate the restamp
 * members ride: loads the on-disk tree, builds the project-local all-epics set +
 * dep map from one glob, extends the existence/cycle universe across discovered
 * projects (fail-soft → empty global map), runs the integrity check, and returns
 * nowIso() on a clean result. On error, `onFailure` (when supplied) fires before
 * the exit so add-dep can roll back. Mirrors restamp_epic_or_fail. */
export function restampEpicOrFail(
  epicId: string,
  dataDir: string,
  opts: {
    verb: string;
    checkFilesystemRepos?: boolean;
    onFailure?: () => void;
  },
): string {
  const { verb, checkFilesystemRepos = false, onFailure } = opts;

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicData = loadJsonSafe(epicPath);
  if (epicData === null) {
    emitRestampFailure(
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
    emitRestampFailure(verb, epicId, errors, onFailure);
  }
  return nowIso();
}

/** A setter's per-verb behaviour plugged into the shared runSetter spine. */
export interface SetterHooks {
  /** Apply the structural change + write it to disk (task JSON, spec file, or
   * the epic JSON itself). The spine re-loads the epic from disk after the
   * restamp gate, so an apply that wrote the epic stays the source of truth. */
  apply: () => void;
  /** Pre-restamp hook — runs after `apply`, before the restamp gate. Used by
   * set-target-repo to recompute + write epic.touched_repos so the recompute
   * is covered by the same post-write integrity check. Optional. */
  preRestamp?: () => void;
  /** Rollback handler — fires (via restampEpicOrFail's onFailure) before the
   * integrity_failed exit so add-dep restores its pre-write epic JSON. Optional. */
  rollback?: () => void;
}

/** The shared setter spine: apply the structural write, run the optional
 * pre-restamp hook, gate through restampEpicOrFail (which exits 1 on integrity
 * failure, firing `rollback` first when supplied), then stamp last_validated_at
 * + updated_at on the epic JSON and write it back. Returns the fresh stamp so the
 * caller can fold it into its emit payload. The setter verb owns the emit itself
 * (each carries a distinct payload + verb/target), so this spine stops at the
 * stamp-write. Mirrors the load→gate→apply→write→restamp→stamp-write spine the
 * setter family shares; the two hooks are the only divergences. */
export function runSetter(
  epicId: string,
  dataDir: string,
  opts: {
    verb: string;
    checkFilesystemRepos?: boolean;
    stampUpdatedAt?: boolean;
    hooks: SetterHooks;
  },
): string {
  const {
    verb,
    checkFilesystemRepos = false,
    stampUpdatedAt = true,
    hooks,
  } = opts;

  hooks.apply();
  if (hooks.preRestamp !== undefined) {
    hooks.preRestamp();
  }

  const newStamp = restampEpicOrFail(epicId, dataDir, {
    verb,
    checkFilesystemRepos,
    onFailure: hooks.rollback,
  });

  // Stamp last_validated_at onto the post-restamp epic JSON. updated_at rides
  // the same write for the section/repo setters (their apply did not touch the
  // epic JSON); add-dep already stamped updated_at in its apply, so it opts out
  // via stampUpdatedAt=false to keep its post-restamp write last_validated_at-only.
  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  const epicDef = loadJsonSafe(epicPath) ?? {};
  if (stampUpdatedAt) {
    epicDef.updated_at = nowIso();
  }
  epicDef.last_validated_at = newStamp;
  atomicWriteJson(epicPath, epicDef, dataDir);

  return newStamp;
}
