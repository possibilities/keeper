// epic create — the byte-parity port of planctl/run_epic_create.py.
//
// Mint one fresh epic (JSON + spec, no tasks) under the global epic-id flock.
// Unlike scaffold (the accumulate-all materializer), create has a single hard
// emit_error failure shape: a foreign-name collision or a local file collision
// emits {success:false, error:<msg>} and exits 1; success emits {epic: epicDef}
// through the standard mutating seam.
//
// THE FLOCK CONTRACT mirrors create.py: scan -> mint id -> global-name check ->
// per-project exists() backstop -> write epic JSON + spec, all INSIDE the lock;
// emit() (the commit seam) runs OUTSIDE so the id-allocation lock and the
// git-commit critical section stay disjoint. The just-minted N is observable to
// the next waiter's scan because the writes land before the lock releases.
// Mid-write raise unwinds any partial tree (both paths are fresh-mint).

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { acquirePlanCommitGuard } from "../commit.ts";
import { checkGlobalNameUnique } from "../discovery.ts";
import { emitFailureEnvelope, emitMutating } from "../emit.ts";
import { withEpicIdLock } from "../flock.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { appendEpicRecord, ledgerMaxEpicNum } from "../id_ledger.ts";
import {
  epicIdsWithNumber,
  generateSuffix,
  scanMaxEpicId,
  slugify,
} from "../ids.ts";
import { resolveProject } from "../project.ts";
import { expandPath } from "../repo_inference.ts";
import { atomicWrite, atomicWriteJson, nowIso } from "../store.ts";

interface EpicCreateArgs {
  title: string;
  branch: string | null;
  specFile: string | null;
  primaryRepo: string | null;
  touchedRepos: string | null;
  format: OutputFormat | null;
}

export function runEpicCreate(args: EpicCreateArgs): void {
  const { title, branch, specFile, format } = args;

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  // Resolve primary_repo: CLI arg (expanded) or default to the cwd project.
  const primaryRepo = args.primaryRepo
    ? expandPath(args.primaryRepo)
    : ctx.projectPath;

  // Resolve touched_repos: CLI comma-list (each expanded) or [primary_repo].
  let touchedRepos: string[];
  if (args.touchedRepos) {
    touchedRepos = args.touchedRepos
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "")
      .map((p) => expandPath(p));
  } else {
    touchedRepos = [primaryRepo];
  }

  let specContent = "";
  if (specFile) {
    specContent = readFileSync(specFile, "utf-8");
  }

  // Merge-window guard + commit-work serialization (commit-work OUTER, epic-id
  // flock INNER): refuse a mid-operation write before touching state, else hold
  // the shared lock across the write -> auto-commit window, released via finally.
  const commitGuard = acquirePlanCommitGuard(ctx.projectPath);
  if (commitGuard.kind === "refused") {
    emitFailureEnvelope("merge_in_progress", commitGuard.message, [
      commitGuard.detail,
    ]);
    process.exit(1);
  }
  try {
    // Allocate the id + write under the global epic-id lock. The lock serializes
    // the global-name uniqueness check so two concurrent creates in different
    // projects can't both pass the check and mint the same fn-N-slug. A failure
    // inside returns a sentinel so the verb emits + exits OUTSIDE the lock; the
    // success path carries epicDef back out for the (post-lock) commit seam.
    type Outcome =
      | { kind: "error"; message: string }
      | { kind: "success"; epicDef: Record<string, unknown>; epicId: string };

    const outcome = withEpicIdLock<Outcome>(() => {
      // max(scan, ledger)+1, never bare scan: the durable id ledger (keyed on the
      // STATE repo) keeps a number burned after its epic's files are destroyed, so
      // the destroy-then-re-mint sequence cannot reuse it on this host.
      const epicNum =
        Math.max(scanMaxEpicId(dataDir), ledgerMaxEpicNum(ctx.projectPath)) + 1;
      const slug = slugify(title);
      const epicId = slug
        ? `fn-${epicNum}-${slug}`
        : `fn-${epicNum}-${generateSuffix()}`;

      const branchName = branch || "main";

      // Same-project bare-number guard: refuse if any existing epic already
      // carries this number under a different slug (an unlocked-degrade race).
      // Reuses id_collision, naming both ids.
      const bareCollisions = epicIdsWithNumber(dataDir, epicNum).filter(
        (id) => id !== epicId,
      );
      if (bareCollisions.length > 0) {
        return {
          kind: "error",
          message: `Epic id ${epicId} collides on number with existing same-project epic ${bareCollisions.join(", ")}`,
        };
      }

      // Global-name uniqueness check across all discovered projects.
      const foreignOwner = checkGlobalNameUnique(epicId, ctx.projectPath);
      if (foreignOwner !== null) {
        return {
          kind: "error",
          message: `Epic id ${epicId} already exists in project ${foreignOwner}`,
        };
      }

      // Collision check (local backstop to the global-name check).
      const epicPath = join(dataDir, "epics", `${epicId}.json`);
      const specPath = join(dataDir, "specs", `${epicId}.md`);
      if (existsSync(epicPath)) {
        return {
          kind: "error",
          message: `File collision: ${epicPath} already exists`,
        };
      }
      if (existsSync(specPath)) {
        return {
          kind: "error",
          message: `File collision: ${specPath} already exists`,
        };
      }

      const now = nowIso();
      const epicDef: Record<string, unknown> = {
        id: epicId,
        title,
        status: "open",
        branch_name: branchName,
        depends_on_epics: [],
        primary_repo: primaryRepo,
        touched_repos: touchedRepos,
        created_at: now,
        updated_at: now,
      };

      // Burn the number in the durable ledger BEFORE any file write, still inside
      // the flock, so a later destroy of these files leaves the number claimed and
      // re-minting allocates strictly higher. Fail-soft (keyed on the state repo).
      appendEpicRecord(ctx.projectPath, epicNum, epicId);

      // Write epic def + spec inside the lock so the minted N is observable to
      // the next waiter's scan. Mid-write raise unwinds any partial tree (both
      // paths are fresh-mint) so scan_max_epic_id stays unchanged.
      const writtenPaths: string[] = [];
      try {
        atomicWriteJson(epicPath, epicDef, dataDir);
        writtenPaths.push(epicPath);
        atomicWrite(specPath, specContent, dataDir);
        writtenPaths.push(specPath);
      } catch (exc) {
        for (const p of writtenPaths) {
          try {
            unlinkSync(p);
          } catch {
            // best-effort cleanup.
          }
        }
        throw exc;
      }

      return { kind: "success", epicDef, epicId };
    });

    if (outcome.kind === "error") {
      emitError(outcome.message, format);
    }

    // Route through the central seam OUTSIDE the (now released) lock. The
    // write-phase unwind above already handled a MID-WRITE crash; a pre-commit
    // raise from the seam leaves the written tree on disk (§10 no-rollback).
    emitMutating(
      { epic: outcome.epicDef },
      {
        verb: "create",
        target: outcome.epicId,
        repoRoot: ctx.projectPath,
        primaryRepo,
      },
    );
  } finally {
    commitGuard.release();
  }
}
