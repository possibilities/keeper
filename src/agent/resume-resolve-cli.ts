#!/usr/bin/env bun
/**
 * Standalone `resolveResumeDecision` runner, reached ONLY by subprocess spawn —
 * NEVER by import. `resolveResumeDecision` (`./resume-policy`) transitively
 * pulls `src/server-worker.ts` → `src/db.ts` (bun:sqlite) for its liveness
 * probe, a cost the `keeper agent` launcher cold path must never pay (the
 * `cold-start import-graph guard` in `test/agent-presets.test.ts` pins
 * `cli/agent.ts`'s bundle bun:sqlite-free — a dynamic `import()` is bundled
 * inline just like a static one, so isolation must be a PROCESS boundary, not
 * a lazy-import one). `main.ts`'s `resolveResumeDecisionFn` spawns this script
 * and reads its one-line JSON off stdout instead of importing `./resume-policy`
 * directly.
 *
 * Usage: bun resume-resolve-cli.ts <target> [require-harness]
 * The optional second positional restricts the match to one harness (the
 * `agent run <cli> --resume` path passes its `<cli>`), so a same-name match on a
 * different harness resolves `harness-mismatch` rather than the wrong session; an
 * unrecognized harness token is a tool-error. Prints exactly one JSON line — a
 * `ResumeDecision` on success, or `{"kind":"tool-error","message":string}` on a
 * tool-level failure (bad target, db open failure, …) — and exits 0 whenever
 * resolution itself completed (including a non-"ok" decision:
 * refuse-live/ambiguous/unknown/no-target ARE successful resolutions), 1 only on
 * tool-error.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { openDb, resolveDbPath } from "../db";
import { type HarnessName, isHarnessName } from "./harness";
import { resolveResumeDecision } from "./resume-policy";

/** Mirrors `codex-trust.ts`'s `resolveCodexHome`: an explicit non-empty
 *  CODEX_HOME wins, else `~/.codex`. Reimplemented here (not imported) since
 *  that helper is private to its module. */
function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  return (env.CODEX_HOME ?? "").trim() || join(homedir(), ".codex");
}

function writeDecision(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main(): void {
  const target = (process.argv[2] ?? "").trim();
  if (target === "") {
    writeDecision({ kind: "tool-error", message: "missing resume target" });
    process.exit(1);
  }
  // Optional harness restriction (the `agent run <cli> --resume` path). Absent →
  // harness-agnostic (the plain `resume` verb); a present-but-unknown token is a
  // tool-error rather than a silently-ignored filter.
  const harnessArg = (process.argv[3] ?? "").trim();
  let requireHarness: HarnessName | undefined;
  if (harnessArg !== "") {
    if (!isHarnessName(harnessArg)) {
      writeDecision({
        kind: "tool-error",
        message: `unknown require-harness: ${harnessArg}`,
      });
      process.exit(1);
    }
    requireHarness = harnessArg;
  }

  // `process.exit()` terminates immediately — it never returns to run a later
  // `finally`, so each branch below closes the connection itself before exiting.
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath(), { readonly: true, prepareStmts: false });
    const decision = resolveResumeDecision(target, db.db, requireHarness, {
      codexHome: resolveCodexHome(process.env),
    });
    writeDecision(decision);
    closeQuietly(db);
    process.exit(0);
  } catch (err) {
    closeQuietly(db);
    writeDecision({
      kind: "tool-error",
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

function closeQuietly(db: ReturnType<typeof openDb> | null): void {
  try {
    db?.db.close();
  } catch {
    // best-effort
  }
}

main();
