# 23. Durable plan-id reservation and merge-aware plan commits

## Status

Accepted. Extends [ADR 8](0008-plumbing-base-default-merge.md): the working-tree-free
base merge took the daemon's own merges out of the shared checkout, but plan-state
commits still run there, and a mid-merge window could still destroy them.

## Context

Plan ids (`fn-N` epics, `fn-N.M` tasks) are allocated by scanning
`.keeper/{epics,specs}/` listings and taking max+1, so a freshly minted number was
reserved by nothing more durable than working-tree files until the verb's pathspec
auto-commit landed. Git refuses pathspec commits during a merge, the plan committer
retried only git's own lock-contention stderr classes, and the failure arm left the
minted files staged in the shared, merge-contended index — where `git merge --abort`
(`git reset --merge`) deletes files staged during the merge. In the motivating
incident an escalation session's skill-sanctioned abort silently destroyed a freshly
scaffolded epic's staged files and a concurrent close flow re-minted the same number
seconds later; bare `fn-N` resolution silently returned the first match. No lock the
merge machinery respects serialized the two actors.

## Decision

Five coupled moves:

1. **Merge-window fast-fail before writing.** Every mutating plan verb probes the
   state repo's in-progress-operation markers (`MERGE_HEAD`, `CHERRY_PICK_HEAD`,
   `REVERT_HEAD`, `REBASE_HEAD`, non-empty `.git/sequencer/todo`) through the
   PlanVcs facade and refuses with a typed retryable `merge_in_progress` envelope
   before writing anything. The probe is best-effort UX; the commit stays the EAFP
   authority.
2. **The write→commit window serializes on the same per-git-dir
   `keeper-commit-work.lock`** the daemon merges and `keeper commit-work` take — a
   deadline-bounded synchronous poll ported into the plan plugin's own flock module.
   Timeout under contention refuses retryably; environmental unacquirability
   degrades fail-soft-to-unlocked. Lock order: commit-work outer, epic-id inner,
   held only across the write→commit window, never across an LLM turn.
3. **Any remaining commit failure rolls back the verb's own pathspec** — unstage,
   unlink fresh files, restore modified files from HEAD — so a failed mutating verb
   is a working-tree no-op with a retryable envelope.
4. **Number reservation is durable in a host-local append-only id ledger**
   (`~/.local/state/keeper/`, keyed on the project's realpath hash): allocation is
   max(scan, ledger)+1 with the append inside the epic-id flock, fail-soft to
   scan-only. Destroying a working-tree file can no longer free its number.
5. **Residual duplicates are loud.** A mint-time same-project bare-number guard, a
   producer-probed duplicate-`epic_number` distress row, and a typed ambiguity
   refusal in bare `fn-N` resolution replace silent first-match. The recover pass's
   automated merge abort defers its cycle when foreign non-conflict paths are
   staged, closing the crash-between-stage-and-rollback window.

## Alternatives considered

- **Renumber-at-land** ([ADR 20](0020-schema-version-renumber-at-merge-time.md)'s
  shape applied to fn-ids). Rejected: `fn-N` is branch-, dependency-, and
  human-encoded; renumbering at every fan-in rewrites all of that to prevent a
  collision the ledger makes impossible and detection makes loud.
- **A lock the plan commit waits on across the merge window.** Rejected: escalation
  sessions run plan verbs while themselves holding `MERGE_HEAD`; any blocking wait
  deadlocks the session resolving the merge.
- **Plumbing the plan commit off HEAD mid-merge** (ADR 8's shape). Rejected: the
  concluding whole-index merge commit lands a tree without the plan files —
  advancing the ref first deletes them at the merge commit.
- **Quarantining rolled-back files outside the checkout.** Rejected: callers hold
  their inputs and re-run on the retryable envelope.

## Consequences

- A mint either lands as a durable commit or un-happens completely; staged plan
  files no longer rest in the contended index for an abort to destroy.
- Numbers burn on rollback — permanent `fn-N` gaps are accepted; reuse is the
  defect, gaps are not. A fresh clone falls back to scan-only allocation, where the
  loud-detection layer is the remaining net.
- Plan verbs invoked mid-merge fail fast with `merge_in_progress` and are re-driven
  by their callers; close-finalize passes the retryable class through instead of
  folding it into a terminal scaffold failure.
- The commit-work lock gains a second acquirer class (plan verbs); its critical
  section stays milliseconds-wide, and the deconflict-session case cannot deadlock
  because the probe refuses before any lock is taken.
