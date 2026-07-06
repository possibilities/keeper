// task set-description / set-acceptance — both ride the shared post-write
// integrity gate: read the new section body from --file (or stdin), validate the
// current spec, patch the named H2 section byte-stably, write the spec + bump the
// task JSON's updated_at, then runSetter re-validates the tree and bumps the
// parent epic's updated_at (the marker is never touched) before the verb owns its
// emit. The only difference between the two verbs is the section heading + the
// emitted `section` field.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { emitMutating } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { epicIdFromTask } from "../ids.ts";
import { runSetter } from "../integrity_gate.ts";
import { resolveProject } from "../project.ts";
import { ensureValidTaskSpec, patchTaskSection } from "../specs.ts";
import {
  atomicWrite,
  atomicWriteJson,
  loadJson,
  nowIso,
  readFileOrStdin,
} from "../store.ts";

interface SetSectionArgs {
  taskId: string;
  file: string | null;
  format: OutputFormat | null;
}

/** Run a section setter for the given H2 heading. `verb`/`section` differ per
 * call (set-description → "## Description"/"Description"; set-acceptance →
 * "## Acceptance"/"Acceptance"). */
function runSetSection(
  args: SetSectionArgs,
  opts: { verb: string; heading: string; sectionLabel: string },
): void {
  const { taskId, file, format } = args;
  const { verb, heading, sectionLabel } = opts;

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  const taskPath = join(dataDir, "tasks", `${taskId}.json`);
  if (!existsSync(taskPath)) {
    emitError(`Task not found: ${taskId}`, format);
  }

  const taskDef = loadJson(taskPath);
  const newContent = readFileOrStdin(file);

  const specPath = join(dataDir, "specs", `${taskId}.md`);
  if (!existsSync(specPath)) {
    emitError(`Spec file not found: ${specPath}`, format);
  }
  const currentSpec = readFileSync(specPath, "utf-8");
  try {
    ensureValidTaskSpec(currentSpec);
  } catch (e) {
    emitError(
      `Task spec is malformed for ${taskId}: ${(e as Error).message}`,
      format,
    );
  }

  let patched: string;
  try {
    patched = patchTaskSection(currentSpec, heading, newContent);
    ensureValidTaskSpec(patched);
  } catch (e) {
    emitError((e as Error).message, format);
  }

  const epicId = epicIdFromTask(taskId);

  runSetter(epicId, dataDir, {
    verb,
    hooks: {
      apply: () => {
        atomicWrite(specPath, patched, dataDir);
        taskDef.updated_at = nowIso();
        atomicWriteJson(taskPath, taskDef, dataDir);
      },
    },
  });

  emitMutating(
    { task_id: taskId, section: sectionLabel },
    { verb, target: taskId, repoRoot: ctx.projectPath },
  );
}

export function runTaskSetDescription(args: SetSectionArgs): void {
  runSetSection(args, {
    verb: "set-description",
    heading: "## Description",
    sectionLabel: "Description",
  });
}

export function runTaskSetAcceptance(args: SetSectionArgs): void {
  runSetSection(args, {
    verb: "set-acceptance",
    heading: "## Acceptance",
    sectionLabel: "Acceptance",
  });
}
