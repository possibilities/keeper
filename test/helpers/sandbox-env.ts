/**
 * Shared sandboxed-env builder for tests that spawn the real hook / CLI.
 *
 * Per the CLAUDE.md "Test isolation" invariant every such spawn MUST override
 * ALL state-bearing `KEEPER_*` paths under the per-test `tmpDir`, or it strands
 * the unset ones at their production `~/.local/state/keeper/` defaults and
 * pollutes the user's real feed (the leak class fn-657 closed).
 *
 * Two shape-families existed inline across the suite, reconciled here into one
 * parameterized core:
 *
 *  - **Family A** (id-clearing CLI-spawn — commit-work / find-task-commit /
 *    session-state): clears the ambient `CLAUDE_CODE_SESSION_ID` /
 *    `JOBCTL_SESSION_ID` / `JOBCTL_JOB_ID` so attribution + the Job-Id trailer
 *    are fully test-controlled, and sets the SIX state paths. No zellij var.
 *    Reproduce with `clearAmbientIds: true` (the default).
 *
 *  - **Family B** (hook-spawn — events-writer / integration): does NOT clear
 *    ambient ids and adds a SEVENTH var `KEEPER_ZELLIJ_EVENTS_DIR` (fn-684).
 *    Reproduce with `{ clearAmbientIds: false, includeZellij: true }`.
 *
 * INVARIANT: the state paths are applied LAST — after the `extra` merge AND the
 * undefined-clear pass — so a caller's `extra` (which may use `undefined` to
 * delete keys) can never re-strand a state key back at its production default.
 */

import { join } from "node:path";

export interface SandboxEnvOptions {
  /** Per-test tmpdir; all derived state paths live under it. */
  tmpDir: string;
  /** Path to the sandboxed `keeper.db` (usually `join(tmpDir, "keeper.db")`). */
  dbPath: string;
  /**
   * Clear `CLAUDE_CODE_SESSION_ID` / `JOBCTL_SESSION_ID` / `JOBCTL_JOB_ID`
   * (Family A). Default `true`. Set `false` for hook-spawn tests (Family B)
   * that rely on the ambient ids.
   */
  clearAmbientIds?: boolean;
  /**
   * Add `KEEPER_ZELLIJ_EVENTS_DIR` (fn-684). Default `false`. Set `true` for
   * the hook/launcher-spawn tests that exercise the zellij plugin NDJSON feed
   * (Family B).
   */
  includeZellij?: boolean;
  /**
   * Extra env entries merged BEFORE the state paths are applied. An `undefined`
   * value clears that key. State paths always win over `extra`.
   */
  extra?: Record<string, string | undefined>;
}

/**
 * Build a process-env-derived env object with every keeper state path
 * sandboxed under `tmpDir`. See the module doc for the two families.
 */
export function sandboxEnv(opts: SandboxEnvOptions): Record<string, string> {
  const {
    tmpDir,
    dbPath,
    clearAmbientIds = true,
    includeZellij = false,
    extra = {},
  } = opts;

  const env: Record<string, string | undefined> = {
    ...(process.env as Record<string, string>),
  };

  // Family A: clear ambient id sources so the test fully controls attribution
  // + the Job-Id trailer. A real Claude session sets CLAUDE_CODE_SESSION_ID.
  if (clearAmbientIds) {
    env.CLAUDE_CODE_SESSION_ID = undefined;
    env.JOBCTL_SESSION_ID = undefined;
    env.JOBCTL_JOB_ID = undefined;
  }

  // Caller overlay (an `undefined` value deletes the key).
  for (const [k, v] of Object.entries(extra)) env[k] = v;

  // State paths LAST so `extra` can never strand them at production defaults
  // (CLAUDE.md isolation rule; the leak class fn-657 closed).
  env.KEEPER_DB = dbPath;
  env.KEEPER_DEAD_LETTER_DIR = join(tmpDir, "dead-letters");
  env.KEEPER_EVENTS_LOG = join(tmpDir, "events-log");
  env.KEEPER_DROP_LOG = join(tmpDir, "hook-drops.ndjson");
  env.KEEPER_RESTORE_FILE = join(tmpDir, "restore.json");
  env.KEEPER_BACKSTOP_LOG = join(tmpDir, "backstop.ndjson");
  if (includeZellij) {
    env.KEEPER_ZELLIJ_EVENTS_DIR = join(tmpDir, "zellij-events");
  }

  // Drop any key whose value was cleared to undefined.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}
