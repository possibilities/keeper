// cat verb. Format-free by contract: emits the raw spec markdown bytes to stdout
// regardless of --format, with no trailing provenance line (cat owns its whole
// stdout). An invalid id or a missing spec writes an `Error: ...` line to stderr
// and exits 1 — the missing-spec message names the resolved absolute spec path.
//
// Resolution is cwd-then-global (tryResolveOwningProjectForId): a globally-
// unique id cat's the board that owns it regardless of cwd, so a cross-repo
// worker can read a spec owned by another repo's board. The non-emitting
// resolver keeps cat's `Error:` stderr contract (no JSON envelope); --project
// bypasses discovery for a legacy ambiguous id.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isEpicId, isTaskId } from "../ids.ts";
import {
  annotateIdReadVantage,
  tryResolveOwningProjectForId,
} from "../project.ts";

/** Run cat. Returns the process exit code (0 on success, 1 on error). The
 * dispatcher must NOT fire the generic trailer for this verb. */
export function runCat(idStr: string, project: string | null): number {
  if (!isEpicId(idStr) && !isTaskId(idStr)) {
    process.stderr.write(`Error: Invalid ID format: ${idStr}\n`);
    return 1;
  }

  // Surface the weaker-vantage note the id-bearing resolution would drop (a lane
  // cwd keeps cwd resolution for a lane_no_state / inconclusive vantage but never
  // annotates). No-op under --project or a non-lane cwd.
  annotateIdReadVantage(project);

  // requireLeaf=false: resolve only to the owning EPIC, deferring the leaf
  // existence to cat's own SPEC check below (so a missing task spec still
  // reports `Spec not found` by absolute path, not a `Task not found`).
  const res = tryResolveOwningProjectForId(idStr, project, false);
  if (!res.ok) {
    if (res.reason === "no_project") {
      process.stderr.write(
        `Error: No plan project found at ${res.projectRoot}. ` +
          "Run 'keeper plan init' first.\n",
      );
    } else if (res.reason === "ambiguous") {
      process.stderr.write(
        `Error: ${res.kind} ${res.id} exists in multiple projects; ` +
          `pass --project <path>. Candidates: ${res.owners.join(", ")}\n`,
      );
    } else {
      process.stderr.write(`Error: ${res.kind} not found: ${res.id}\n`);
    }
    return 1;
  }

  const specPath = join(res.ctx.dataDir, "specs", `${idStr}.md`);
  if (!existsSync(specPath)) {
    process.stderr.write(`Error: Spec not found: ${specPath}\n`);
    return 1;
  }

  process.stdout.write(readFileSync(specPath, "utf-8"));
  return 0;
}
