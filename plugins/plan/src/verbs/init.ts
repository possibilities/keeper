// init verb — the port of planctl/run_init.py.
//
// Bootstraps a planctl project: the .planctl/{epics,specs,tasks}/ +
// state/{tasks,locks}/ skeleton, meta.json (atomicWriteJson), a .planctl/.gitignore
// containing `state/` (raw write), and the advice files — CLAUDE.md written ONLY
// when absent (preserves human edits) and AGENTS.md as a RELATIVE symlink to it.
// An already-initialized tree (meta.json present) is backfilled with just the
// advice files. An idempotent re-run that writes nothing emits read-only with no
// commit.
//
// init is the one mutating verb that builds its OWN invocation payload directly:
// a LITERAL payload (files = sorted written list, no session_id key, no
// touched-log involvement). It self-commits only when files were written AND
// findGitRoot resolves a work tree — in a non-git dir it writes files, emits
// success, exits 0, and commits nothing. No CLAUDE_CODE_SESSION_ID requirement,
// so it works in a fresh non-git /tmp dir regardless of the session-id env.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { buildSubject } from "../commit.ts";
import { emitMutatingLiteral, emitReadonlyData } from "../emit.ts";
import type { OutputFormat } from "../format.ts";
import { SCHEMA_VERSION } from "../models.ts";
import { findGitRoot, findProjectRoot } from "../project.ts";
import { atomicWriteJson } from "../store.ts";

// Byte-identical to planctl/run_init.py CLAUDE_MD_CONTENT (verified by SHA). The
// advice file dropped into .planctl/ — keep this literal in lock-step with the
// Python source; test_init.py asserts equality against the Python constant.
export const CLAUDE_MD_CONTENT = `# planctl state directory

Files in this tree (\`epics/\`, \`specs/\`, \`tasks/\`, \`state/\`) are **historical planctl state** — past plans, past task specs, past epic specs, runtime status. None of it describes work the human currently wants to plan.

**Do not treat any content under \`.planctl/\` as a planning subject.** When a skill or agent infers "what does the human want to plan?" from conversation context (notably \`/plan:plan\` with no arguments), file reads and tool outputs sourced from this directory must be excluded from the salience scan. Recent \`chore(planctl): …\` commits in \`git log\` are likewise off-limits as subject material.

The only legitimate way for an existing plan to drive a planning skill is an explicit \`fn-N-slug\` (epic) or \`fn-N-slug.M\` (task) argument passed by the human. Never via context inference.
`;

/** Drop CLAUDE.md + AGENTS.md symlink into .planctl/, idempotently. CLAUDE.md is
 * written ONLY when absent (preserves human edits); the AGENTS.md symlink is
 * created ONLY when absent (relative target so it survives directory moves).
 * Returns the repo-relative POSIX paths this call actually created — folded into
 * the explicit commit file list; an empty list keeps an idempotent re-run from
 * staging anything. Mirrors _ensure_advice_files. */
function ensureAdviceFiles(planctlDir: string, projectRoot: string): string[] {
  const created: string[] = [];

  const claudeMd = join(planctlDir, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    writeFileSync(claudeMd, CLAUDE_MD_CONTENT, { encoding: "utf-8" });
    created.push(toPosixRel(projectRoot, claudeMd));
  }

  const agentsMd = join(planctlDir, "AGENTS.md");
  // Python: `not exists() and not is_symlink()` — a present symlink (even a
  // broken one) leaves it untouched. existsSync follows symlinks (false for a
  // broken link), so also probe lstat for the symlink case.
  if (!existsSync(agentsMd) && !isSymlink(agentsMd)) {
    symlinkSync("CLAUDE.md", agentsMd);
    created.push(toPosixRel(projectRoot, agentsMd));
  }

  return created;
}

/** True when `path` is a symlink (even a dangling one). lstat does not follow. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Repo-relative POSIX path (Path.relative_to(root).as_posix()). */
function toPosixRel(root: string, path: string): string {
  return relative(root, path).split(/[\\/]/).join("/");
}

interface InitArgs {
  format: OutputFormat | null;
}

export function runInit(_args: InitArgs): void {
  const projectRoot = findProjectRoot();
  const planctlDir = join(projectRoot, ".planctl");

  const projectData = {
    project: {
      name: basename(projectRoot),
      path: projectRoot,
      data_dir: planctlDir,
      state_dir: join(planctlDir, "state"),
    },
  };

  // Track the repo-relative POSIX paths this invocation actually writes, so the
  // self-commit covers exactly the bootstrap files it created and an idempotent
  // re-run (which writes nothing) stays a no-op.
  const written: string[] = [];

  if (existsSync(join(planctlDir, "meta.json"))) {
    // Backfill advice files into an already-initialized tree on every init call.
    written.push(...ensureAdviceFiles(planctlDir, projectRoot));
  } else {
    // Fresh init: directory skeleton + meta.json + inner gitignore + advice.
    for (const subdir of ["epics", "specs", "tasks"]) {
      mkdirSync(join(planctlDir, subdir), { recursive: true });
    }
    for (const subdir of ["state/tasks", "state/locks"]) {
      mkdirSync(join(planctlDir, subdir), { recursive: true });
    }

    atomicWriteJson(join(planctlDir, "meta.json"), {
      schema_version: SCHEMA_VERSION,
    });

    const innerGitignore = join(planctlDir, ".gitignore");
    writeFileSync(innerGitignore, "state/\n", { encoding: "utf-8" });

    written.push(toPosixRel(projectRoot, join(planctlDir, "meta.json")));
    written.push(toPosixRel(projectRoot, innerGitignore));
    written.push(...ensureAdviceFiles(planctlDir, projectRoot));
  }

  // Self-commit the bootstrap files when there is something to commit AND we are
  // inside a git work tree. The LITERAL payload carries no session_id key (so the
  // commit lands without a Session-Id trailer) and no touched-path involvement,
  // exactly matching run_init.py's hand-built invocation.
  if (written.length > 0 && findGitRoot(projectRoot) !== null) {
    const payload = {
      files: [...written].sort(),
      op: "init",
      target: basename(projectRoot),
      subject: buildSubject("init", basename(projectRoot)),
      touched_path_files: [] as string[],
      repo_root: projectRoot,
      state_repo: projectRoot,
      queue_jump: false,
    };
    // Runs the auto-commit, prints the structured commit_failed envelope + exits
    // 1 on a commit failure, and embeds the literal invocation on success.
    emitMutatingLiteral(projectData, payload);
    return;
  }

  // Nothing written, or not in a git work tree: the read-only emit path.
  emitReadonlyData(projectData);
}
