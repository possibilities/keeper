// epic close verb — the byte-parity port of planctl/run_epic_close.py.
//
// The ONLY self-committing verb in the close-saga wave: it stamps the epic done
// (status / updated_at / closer_done_at / optional close_reason) and routes
// through the mutating seam, landing a `chore(plan): close <epic>` data-dir
// commit. NOT an integrity-gate member — last_validated_at is left untouched.
//
// Gate order is load-bearing for message parity: not-found → "Epic not found:
// <id>"; already-done → "Epic <id> is already done"; not-all-done without
// --force → "Cannot close <id>: N task(s) not done: <id (status)>, …". --force
// overrides only the not-all-done gate. Errors ride the plain emit_error shape
// ({success:false, error:msg}, exit 1).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { emitMutating } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { mergeTaskState } from "../models.ts";
import { resolvePlanStateContext } from "../project.ts";
import {
  atomicWriteJson,
  LocalFileStateStore,
  loadJson,
  loadJsonSafe,
  nowIso,
} from "../store.ts";

export interface EpicCloseArgs {
  epicId: string;
  force: boolean;
  reason: string | null;
  project: string | null;
  format: OutputFormat | null;
}

export function runEpicClose(args: EpicCloseArgs): void {
  const { epicId, force, reason, project, format } = args;

  // Route the tally + the def write/commit through the central state seam so a
  // close run from a worktree lane tallies PRIMARY's runtime overlay (never the
  // lane's absent state, which would spuriously refuse TASKS_NOT_DONE) and lands
  // the irreversible close in primary. `--project` stays authoritative.
  const ctx = resolvePlanStateContext(epicId, project, format);
  const dataDir = ctx.dataDir;
  const stateStore = new LocalFileStateStore(ctx.stateDir);

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitError(`Epic not found: ${epicId}`, format);
  }

  const epicDef = loadJson(epicPath);
  if (epicDef.status === "done") {
    emitError(`Epic ${epicId} is already done`, format);
  }

  // Tally tasks with runtime state merged in. The glob `<epic_id>.*.json` is
  // emulated via a prefix filter; load_json_safe skips a half-written file.
  const tasksDir = join(dataDir, "tasks");
  let tasksDone = 0;
  let tasksTotal = 0;
  const notDone: string[] = [];

  if (existsSync(tasksDir)) {
    const prefix = `${epicId}.`;
    const names = readdirSync(tasksDir).filter(
      (n) => n.startsWith(prefix) && n.endsWith(".json"),
    );
    for (const name of names) {
      const taskDef = loadJsonSafe(join(tasksDir, name));
      if (!taskDef) {
        continue;
      }
      tasksTotal += 1;
      const tid =
        typeof taskDef.id === "string"
          ? taskDef.id
          : name.slice(0, -".json".length);
      const runtime = stateStore.loadRuntime(tid);
      const merged = mergeTaskState(taskDef, runtime);
      if (merged.status === "done") {
        tasksDone += 1;
      } else {
        notDone.push(`${tid} (${(merged.status as string) ?? "todo"})`);
      }
    }
  }

  if (!force && notDone.length > 0) {
    const msg =
      `Cannot close ${epicId}: ${notDone.length} task(s) not done: ` +
      notDone.join(", ");
    emitError(msg, format);
  }

  const now = nowIso();
  epicDef.status = "done";
  epicDef.updated_at = now;
  // closer_done_at is the epic-level completion signal keeper folds: a closed
  // epic with closer_done_at set is complete.
  epicDef.closer_done_at = now;
  if (reason !== null) {
    epicDef.close_reason = reason;
  }
  atomicWriteJson(epicPath, epicDef, dataDir);

  emitMutating(
    {
      epic_id: epicId,
      status: "done",
      tasks_done: tasksDone,
      tasks_total: tasksTotal,
      close_reason: reason,
    },
    { verb: "close", target: epicId, repoRoot: ctx.projectPath },
  );
}
