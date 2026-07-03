#!/usr/bin/env bun

/**
 * Merge-resolver end-to-end proof harness (manual tier — NOT the fast suite).
 *
 *   bun scripts/resolver-conflict-harness.ts
 *
 * Proves the two branches of the autopilot merge-resolver on a scratch epic,
 * end to end, against REAL git in a throwaway repo and a REAL sandboxed keeper
 * projection (its own `keeper.db` under an OS tmpdir — never the human's state):
 *
 *   (a) MECHANICALLY-CLEAR fan-in  → the resolver lands the merge keeping BOTH
 *       intents, the epic test passes, `retry close::<epic>` fires, and the
 *       sticky close row clears so the close proceeds.
 *   (b) SCHEMA-SHAPED fan-in       → the resolver stamps BLOCKED (keeping both
 *       is incoherent), the sticky close row REMAINS, and the human escalation
 *       is unchanged (its once-latch and body untouched by the resolver).
 *
 * What is REAL here: the git conflicts (seeded, merged, resolved/aborted with a
 * real `git`), the epic-test gate, the SQL selector `selectPendingResolverDispatches`,
 * the prompt `buildResolverBrief`, the reducer folds (`DispatchFailed` /
 * `ResolverDispatchAttempted` / `MergeEscalationAttempted` / `DispatchCleared`
 * via `drain`), and both daemon sweeps (`runResolverDispatchSweep`,
 * `runMergeEscalationSweep`). What is SIMULATED: the resolver worker's own
 * classify-then-act judgement (a Claude turn, non-deterministic) — the harness
 * plays its hands per the brief's two documented paths, and grounds each choice
 * in the real git outcome (the clear conflict genuinely composes; the schema
 * conflict genuinely cannot). The Claude launch itself is stubbed by a capturing
 * dispatcher so the run is deterministic and re-runnable.
 *
 * Exit 0 iff every check passes; non-zero (with a FAIL list) otherwise.
 */

import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMergeEscalationBody,
  buildResolverBrief,
  type PendingResolverDispatch,
  type PlannerNotifyResult,
  type ResolverDispatchOutcome,
  runMergeEscalationSweep,
  runResolverDispatchSweep,
  selectPendingMergeEscalations,
  selectPendingResolverDispatches,
} from "../src/daemon";
import { openDb } from "../src/db";
import { drain } from "../src/reducer";

// --------------------------------------------------------------------------
// tiny check harness
// --------------------------------------------------------------------------

let passes = 0;
const failures: string[] = [];

function check(label: string, cond: boolean): void {
  if (cond) {
    passes++;
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${label}\n`);
  } else {
    failures.push(label);
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`);
}

// --------------------------------------------------------------------------
// real git
// --------------------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** A git op that MUST succeed — throws (aborting the harness) on non-zero. */
function gitOk(cwd: string, args: string[]): GitResult {
  const r = git(cwd, args);
  if (!r.ok) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${r.stderr || r.stdout}`,
    );
  }
  return r;
}

/**
 * Seed a repo with a common ancestor + two divergent branches that conflict on
 * one line. `mutate` writes each side's version of `file`. Returns the base and
 * source branch names (the epic base branch and the task lane branch, matching
 * the real worktree fan-in the resolver faces).
 */
function seedConflict(
  repo: string,
  epicId: string,
  file: string,
  ancestor: string,
  baseSide: string,
  sourceSide: string,
): { base: string; source: string } {
  const base = `keeper/epic/${epicId}`;
  const source = `${epicId}.2`;
  gitOk(repo, ["init", "-q", "-b", base]);
  gitOk(repo, ["config", "user.email", "harness@keeper.local"]);
  gitOk(repo, ["config", "user.name", "resolver-harness"]);
  writeFileSync(join(repo, file), ancestor);
  gitOk(repo, ["add", "."]);
  gitOk(repo, ["commit", "-qm", "seed: common ancestor"]);

  // The task lane forks the base, then makes its edit.
  gitOk(repo, ["checkout", "-q", "-b", source]);
  writeFileSync(join(repo, file), sourceSide);
  gitOk(repo, ["commit", "-qam", "lane: source-side edit"]);

  // The epic base makes its own edit on the same line.
  gitOk(repo, ["checkout", "-q", base]);
  writeFileSync(join(repo, file), baseSide);
  gitOk(repo, ["commit", "-qam", "base: base-side edit"]);
  return { base, source };
}

// --------------------------------------------------------------------------
// keeper projection driver (real folds through `drain`)
// --------------------------------------------------------------------------

let tsCounter = 1700;

/** Insert a synthetic event and fold it through the real reducer. */
function foldEvent(
  db: Database,
  hookEvent: string,
  sessionId: string,
  data: unknown,
): void {
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, ?, ?, ?)`,
    [
      tsCounter++,
      sessionId,
      hookEvent,
      "dispatch_failures",
      JSON.stringify(data),
    ],
  );
  while (drain(db) > 0) {
    // fold to the cursor head
  }
}

/** Seed a sticky `worktree-merge-conflict` close row via the real DispatchFailed fold. */
function seedStickyClose(
  db: Database,
  epicId: string,
  reason: string,
  dir: string,
): void {
  foldEvent(db, "DispatchFailed", `close::${epicId}`, {
    verb: "close",
    id: epicId,
    reason,
    dir,
    ts: tsCounter,
  });
}

function resolverDispatchedAt(db: Database, epicId: string): number | null {
  const row = db
    .query(
      "SELECT resolver_dispatched_at FROM dispatch_failures WHERE verb = 'close' AND id = ?",
    )
    .get(epicId) as { resolver_dispatched_at: number | null } | null;
  return row?.resolver_dispatched_at ?? null;
}

function mergeEscalatedAt(db: Database, epicId: string): number | null {
  const row = db
    .query(
      "SELECT merge_escalated_at FROM dispatch_failures WHERE verb = 'close' AND id = ?",
    )
    .get(epicId) as { merge_escalated_at: number | null } | null;
  return row?.merge_escalated_at ?? null;
}

function stickyPresent(db: Database, epicId: string): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM dispatch_failures WHERE verb = 'close' AND id = ? LIMIT 1",
      )
      .get(epicId) != null
  );
}

/** The reason string a worktree fan-in close mints (the format the sweep parses). */
function conflictReason(source: string, base: string, stderr: string): string {
  return `worktree-merge-conflict: merging ${source} into ${base} — ${stderr}`;
}

/**
 * Drive ONE real `runResolverDispatchSweep` against the sandboxed projection.
 * The only injected seam is the Claude launch itself (captured, never spawned);
 * the selector / still-pending re-read / attempted-mint all run for real.
 */
async function sweepResolver(
  db: Database,
): Promise<{ briefs: string[]; mints: ResolverDispatchOutcome[] }> {
  const briefs: string[] = [];
  const mints: ResolverDispatchOutcome[] = [];
  await runResolverDispatchSweep({
    selectPending: () => selectPendingResolverDispatches(db),
    stillPending: (id) =>
      db
        .query(
          "SELECT 1 FROM dispatch_failures WHERE verb = 'close' AND id = ? AND resolver_dispatched_at IS NULL LIMIT 1",
        )
        .get(id) != null,
    dispatchResolver: async (row: PendingResolverDispatch) => {
      briefs.push(
        buildResolverBrief({
          epicId: row.id,
          reason: row.reason,
          repoDir: row.dir,
        }),
      );
      return "dispatched";
    },
    mintAttempted: (id, outcome) => {
      mints.push(outcome);
      foldEvent(db, "ResolverDispatchAttempted", id, { id, outcome });
    },
  });
  return { briefs, mints };
}

/** Drive ONE real `runMergeEscalationSweep`, capturing the notify body. */
async function sweepEscalation(db: Database): Promise<string[]> {
  const bodies: string[] = [];
  await runMergeEscalationSweep({
    selectPending: () => selectPendingMergeEscalations(db),
    stillPending: (id) =>
      db
        .query(
          "SELECT 1 FROM dispatch_failures WHERE verb = 'close' AND id = ? AND merge_escalated_at IS NULL LIMIT 1",
        )
        .get(id) != null,
    notifyPlanner: async (_target, body): Promise<PlannerNotifyResult> => {
      bodies.push(body);
      return { outcome: "sent", detail: "harness" };
    },
    mintAttempted: (id, outcome) =>
      foldEvent(db, "MergeEscalationAttempted", id, { id, outcome }),
  });
  return bodies;
}

// --------------------------------------------------------------------------
// scenario A — mechanically-clear fan-in: resolver RESOLVES
// --------------------------------------------------------------------------

async function scenarioClear(root: string, db: Database): Promise<void> {
  section("Scenario A — mechanically-clear fan-in (resolver RESOLVES)");
  const epicId = "fn-9001-clear-fanin";
  const repo = join(root, "repo-clear");
  mkdirp(repo);

  const file = "install.sh";
  const { base, source } = seedConflict(
    repo,
    epicId,
    file,
    'ENABLED_STEPS="core"\n',
    'ENABLED_STEPS="core base_feature"\n',
    'ENABLED_STEPS="core source_feature"\n',
  );

  // --- real git: recreate the fan-in conflict (the brief's step 2) ---
  const merge = git(repo, ["merge", "--no-ff", source]);
  check(
    "clear: git merge --no-ff conflicts (a real fan-in conflict)",
    !merge.ok,
  );
  const conflicted = readFileSync(join(repo, file), "utf8");
  check(
    "clear: conflict markers present in the working tree",
    conflicted.includes("<<<<<<<") && conflicted.includes(">>>>>>>"),
  );

  // --- play the resolver's CLEAR hands: keep BOTH intents, test, commit ---
  const resolved = 'ENABLED_STEPS="core base_feature source_feature"\n';
  writeFileSync(join(repo, file), resolved);
  gitOk(repo, ["add", file]);
  const bothIntents =
    resolved.includes("base_feature") && resolved.includes("source_feature");
  check(
    "clear: resolution preserves BOTH intents (epic-test gate)",
    bothIntents,
  );
  check(
    "clear: resolution carries no residual conflict markers",
    !resolved.includes("<<<<<<<") && !resolved.includes(">>>>>>>"),
  );
  gitOk(repo, ["commit", "-qm", "resolve: fan-in keeping both steps"]);
  const contains = git(repo, ["branch", "--contains", source]);
  check(
    "clear: source is now an ancestor of base (retry merge no-ops)",
    contains.ok && contains.stdout.includes(base),
  );

  // --- real keeper machinery on the sandboxed projection ---
  const reason = conflictReason(
    source,
    base,
    "CONFLICT (content): Merge conflict in install.sh",
  );
  seedStickyClose(db, epicId, reason, repo);
  check(
    "clear: sticky worktree-merge-conflict close row selected as pending",
    selectPendingResolverDispatches(db).some((r) => r.id === epicId),
  );

  const first = await sweepResolver(db);
  check("clear: exactly ONE resolver dispatched", first.briefs.length === 1);
  check(
    "clear: attempt minted the terminal 'dispatched' outcome",
    first.mints.length === 1 && first.mints[0] === "dispatched",
  );
  const brief = first.briefs[0] ?? "";
  check(
    "clear: brief carries the clear path (merge --no-ff, BOTH, tests, retry+play)",
    brief.includes(`git merge --no-ff ${source}`) &&
      brief.includes("BOTH") &&
      brief.includes("tests") &&
      brief.includes(`keeper autopilot retry close::${epicId}`) &&
      brief.includes("keeper autopilot play"),
  );
  check(
    "clear: brief also carries the BLOCKED fallback with the unstick sentence",
    brief.includes("BLOCKED") && brief.includes("to proceed, tell me exactly:"),
  );
  check(
    "clear: resolver_dispatched_at once-marker now stamped",
    resolverDispatchedAt(db, epicId) != null,
  );

  const second = await sweepResolver(db);
  check(
    "clear: a second sweep dispatches NOTHING (dispatch-once, no churn loop)",
    second.briefs.length === 0 && second.mints.length === 0,
  );

  // --- the resolver fires `retry close::<epic>` on the clear path ---
  foldEvent(db, "DispatchCleared", `close::${epicId}`, {
    verb: "close",
    id: epicId,
  });
  check(
    "clear: retry cleared the sticky close row — the close proceeds",
    !stickyPresent(db, epicId) &&
      selectPendingResolverDispatches(db).every((r) => r.id !== epicId),
  );
}

// --------------------------------------------------------------------------
// scenario B — schema-shaped fan-in: resolver BLOCKS
// --------------------------------------------------------------------------

async function scenarioSchema(root: string, db: Database): Promise<void> {
  section("Scenario B — schema-shaped fan-in (resolver BLOCKS)");
  const epicId = "fn-9002-schema-fanin";
  const repo = join(root, "repo-schema");
  mkdirp(repo);

  const file = "schema.ts";
  const { base, source } = seedConflict(
    repo,
    epicId,
    file,
    "export const SCHEMA_VERSION = 106;\n",
    "export const SCHEMA_VERSION = 107;\n",
    "export const SCHEMA_VERSION = 108;\n",
  );

  // --- real git: recreate the conflict, then prove BOTH-intents is incoherent ---
  const merge = git(repo, ["merge", "--no-ff", source]);
  check(
    "schema: git merge --no-ff conflicts (a real fan-in conflict)",
    !merge.ok,
  );
  const conflicted = readFileSync(join(repo, file), "utf8");
  check(
    "schema: conflict markers present in the working tree",
    conflicted.includes("<<<<<<<") && conflicted.includes(">>>>>>>"),
  );
  // Keeping BOTH sides = two SCHEMA_VERSION declarations with two values: a
  // redeclaration, and a decision (which schema wins) the resolver may NOT make.
  const bothKept =
    "export const SCHEMA_VERSION = 107;\nexport const SCHEMA_VERSION = 108;\n";
  const declCount = (bothKept.match(/export const SCHEMA_VERSION/g) ?? [])
    .length;
  check(
    "schema: keeping both intents is incoherent (a double declaration) — epic-test would fail",
    declCount === 2,
  );
  // The brief's BLOCKED path leaves the lane CLEAN.
  gitOk(repo, ["merge", "--abort"]);
  const status = git(repo, ["status", "--porcelain"]);
  check(
    "schema: lane left CLEAN after git merge --abort",
    status.stdout.trim() === "",
  );

  // --- real keeper machinery: escalate the human FIRST (the existing path) ---
  const reason = conflictReason(
    source,
    base,
    "CONFLICT (content): Merge conflict in schema.ts",
  );
  seedStickyClose(db, epicId, reason, repo);
  const escBodies = await sweepEscalation(db);
  check("schema: human merge-escalation sent ONCE", escBodies.length === 1);
  const escalationBody = escBodies[0] ?? "";
  const escalatedMark = mergeEscalatedAt(db, epicId);
  check(
    "schema: merge_escalated_at once-marker stamped",
    escalatedMark != null,
  );

  // --- resolver dispatched on the SAME sticky (independent latch) ---
  const swept = await sweepResolver(db);
  check("schema: exactly ONE resolver dispatched", swept.briefs.length === 1);
  const brief = swept.briefs[0] ?? "";
  check(
    "schema: brief names the guardrail classes + defaults UNSURE to BLOCKED",
    brief.includes("schema") &&
      brief.includes("state machine") &&
      brief.includes("security") &&
      brief.includes("transaction-boundary") &&
      brief.includes("UNSURE") &&
      brief.includes("BLOCKED"),
  );
  check(
    "schema: brief carries the literal unstick sentence for the human",
    brief.includes(
      "to proceed, tell me exactly: whether to keep both sides, pick one, or how to reconcile them",
    ),
  );
  check(
    "schema: brief's BLOCKED path aborts to a clean lane (git merge --abort)",
    brief.includes("git merge --abort"),
  );

  // --- the resolver BLOCKS: it fires NO retry. Sticky + escalation unchanged. ---
  check(
    "schema: sticky close row REMAINS (no retry, no auto-clear on BLOCKED)",
    stickyPresent(db, epicId),
  );
  check(
    "schema: merge_escalated_at UNCHANGED by the resolver dispatch (independent latch)",
    mergeEscalatedAt(db, epicId) === escalatedMark,
  );
  const reEsc = await sweepEscalation(db);
  check(
    "schema: re-running the escalation sweep sends NO second notify (escalation unchanged)",
    reEsc.length === 0,
  );
  check(
    "schema: escalation body is byte-identical to the first send (escalation unchanged)",
    buildMergeEscalationBody({ epicId, reason, repoDir: repo }) ===
      escalationBody,
  );
}

// --------------------------------------------------------------------------
// misc
// --------------------------------------------------------------------------

function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      "bun scripts/resolver-conflict-harness.ts\n\n" +
        "Prove the merge-resolver's two branches (mechanically-clear resolves;\n" +
        "schema-shaped BLOCKS) end to end against real git + a sandboxed keeper\n" +
        "projection. Exits non-zero on any failed check.\n",
    );
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "keeper-resolver-harness-"));
  const dbPath = join(root, "keeper.db");
  const { db } = openDb(dbPath, { readonly: false });
  try {
    await scenarioClear(root, db);
    await scenarioSchema(root, db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }

  section("Summary");
  process.stdout.write(`  ${passes} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stdout.write(`    - ${f}\n`);
    process.exit(1);
  }
  process.stdout.write("\n\x1b[32mAll checks passed.\x1b[0m\n");
}

await main();
