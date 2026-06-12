// Read-only invocation payload — the port of
// planctl/invocation.py:build_planctl_invocation_readonly. Field order is the
// wire contract: files, op, target, subject, touched_path_files, repo_root,
// state_repo. Read-only verbs touch nothing, so files/subject are null and
// touched_path_files is empty; repo_root === state_repo === the project root.

export interface ReadonlyInvocation {
  files: null;
  op: string;
  target: string | null;
  subject: null;
  touched_path_files: never[];
  repo_root: string;
  state_repo: string;
}

export function buildPlanctlInvocationReadonly(
  verb: string,
  repoRoot: string,
  target: string | null = null,
): ReadonlyInvocation {
  return {
    files: null,
    op: verb,
    target,
    subject: null,
    touched_path_files: [],
    repo_root: repoRoot,
    state_repo: repoRoot,
  };
}
