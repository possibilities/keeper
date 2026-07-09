// Conformance spec for the close phase resolving plan STATE to the epic's
// primary repo when the close runs from a worktree LANE — the pure (git-free)
// tier. In worktree mode the close orchestrator is dispatched into the epic's
// lane, but the runtime status overlay + close artifacts live ONLY in the
// primary repo (`.keeper/.gitignore` is `state/`, so state/ is never checked out
// into a lane) while the epic/task JSON defs ARE committed and so appear
// identical in both. A cwd-resolved context therefore reads stale lane state and
// reports TASKS_NOT_DONE; routing every plan-state read through a primary-rooted
// context fixes it.
//
// The lane is simulated by seeding a full .keeper/ tree in a "primary" dir
// (carrying the done runtime overlay), then a second "lane" dir carrying ONLY
// the committed defs (epic/task JSON + specs), with its state/ removed — exactly
// what a real worktree checkout sees. The epic def's primary_repo points back at
// the primary in both. The real-git analogue lives in worktree-lifecycle.test.ts
// (slow tier).

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  briefPath,
  computeCommitSetHash,
  followupPath,
  reportPath,
  verdictPath,
  writeArtifact,
  writeBriefArtifact,
} from "../src/audit_artifacts.ts";
import { selectionBriefPath } from "../src/verbs/selection_brief.ts";
import {
  gitFilesInHead,
  gitInit,
  gitLogCount,
  parseCliOutput,
  runCli,
  seedRuntime,
  seedState,
} from "./harness.ts";

// Dirs minted per test, torn down in afterEach (these tests build their own
// primary/lane/home rather than using withProject's single-root fixture).
const created: string[] = [];

afterEach(() => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
  created.length = 0;
});

function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

interface LaneScenario {
  primary: string;
  lane: string;
  home: string;
  epicId: string;
  taskIds: string[];
}

/** Stand up a primary repo carrying the done runtime overlay + a sibling lane
 * dir holding ONLY the committed defs (no state/). `statuses[i] === "done"`
 * marks task i+1 done in PRIMARY's overlay; the lane never carries any overlay. */
function makeLaneScenario(prefix: string, statuses: string[]): LaneScenario {
  const primary = freshDir(`${prefix}primary-`);
  const lane = freshDir(`${prefix}lane-`);
  const home = freshDir(`${prefix}home-`);
  const epicId = "fn-1-demo";

  // Both are git repos so findCommitGroups (primary) and the cwd-walk (lane)
  // see a `.git` entry; the fake VCS's isGitRepo just probes for it.
  gitInit(primary);
  gitInit(lane);

  const [, taskIds] = seedState(primary, {
    epicId,
    nTasks: statuses.length,
    primaryRepo: primary,
  });
  statuses.forEach((status, i) => {
    if (status === "done") {
      seedRuntime(primary, taskIds[i] as string, { status: "done" });
    }
  });

  // The lane carries the committed defs (identical to primary's) but NO state
  // overlay — exactly a worktree checkout where state/ is gitignored.
  seedState(lane, { epicId, nTasks: statuses.length, primaryRepo: primary });
  rmSync(join(lane, ".keeper", "state"), { recursive: true, force: true });

  return { primary, lane, home, epicId, taskIds };
}

describe("close-preflight resolves plan-state to primary from a lane", () => {
  test("a done epic reads ready-to-close from the lane (state resolved to primary)", () => {
    const { primary, lane, home, epicId, taskIds } = makeLaneScenario(
      "planctl-wcs-ok-",
      ["done", "done"],
    );

    const r = runCli(["close-preflight", epicId], { cwd: lane, home });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.all_done).toBe(true);
    // The envelope's primary_repo is the epic's primary, not the lane cwd.
    expect(env.primary_repo).toBe(primary);
    const tasks = env.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id)).toEqual(taskIds);
    expect(tasks.map((t) => t.status)).toEqual(["done", "done"]);

    // The brief landed in PRIMARY, never the lane (state always resolves to
    // primary — the invariant this honors).
    expect(existsSync(briefPath(primary, epicId))).toBe(true);
    expect(existsSync(briefPath(lane, epicId))).toBe(false);
  });

  test("primary's actual not-done state is read truthfully from the lane", () => {
    // The fix reads primary's REAL state, not a blanket pass: one task done +
    // one todo in primary still surfaces TASKS_NOT_DONE naming the open task.
    const { lane, home, epicId, taskIds } = makeLaneScenario(
      "planctl-wcs-nd-",
      ["done", "todo"],
    );

    const r = runCli(["close-preflight", epicId], { cwd: lane, home });
    expect(r.code).toBe(1);
    const error = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(error.code).toBe("TASKS_NOT_DONE");
    expect((error.details as Record<string, unknown>).not_done).toEqual([
      taskIds[1],
    ]);
  });

  test("non-worktree path is unchanged: --project==cwd resolves identically", () => {
    // When cwd is the primary (the non-worktree close path), contextForRoot of
    // the primary is a no-op over the cwd ctx — the success envelope is the same.
    const { primary, home, epicId } = makeLaneScenario("planctl-wcs-np-", [
      "done",
    ]);
    const r = runCli(["close-preflight", epicId, "--project", primary], {
      cwd: primary,
      home,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.all_done).toBe(true);
    expect(env.primary_repo).toBe(primary);
    expect(existsSync(briefPath(primary, epicId))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// apply-selection re-roots plan-state through the epic's primary_repo, same
// invariant as close-preflight/submit above: a brief written under primary's
// gitignored state/ must be found (and the verdict landed) from a worktree
// lane cwd, never degrading to the lane's stale/empty copy.
// ---------------------------------------------------------------------------

/** Seed a minimal live selection brief directly under PRIMARY's gitignored
 * state/ (bypassing the selection-brief verb, which needs a real scaffold
 * tree) — just enough for apply-selection's brief + enum-clamp layers:
 * exact task_id coverage plus a {model, tier} candidate axis wide enough for
 * the verdict cells below. */
function seedLiveSelectionBrief(
  primary: string,
  epicId: string,
  taskIds: string[],
): void {
  const briefRef = selectionBriefPath(
    join(primary, ".keeper", "state"),
    epicId,
  );
  writeArtifact(
    briefRef,
    JSON.stringify({
      schema_version: 1,
      epic_id: epicId,
      primary_repo: primary,
      from_followup: false,
      selector_config_hash: "cfg-hash",
      input_hash: "input-hash",
      shuffle_seed: 1,
      tasks: taskIds.map((id) => ({ task_id: id })),
      models: ["opus", "sonnet"],
      efforts: ["medium", "high", "max"],
    }),
  );
}

function readTaskCell(
  root: string,
  taskId: string,
): { tier: string; model: string } {
  const def = JSON.parse(
    readFileSync(join(root, ".keeper", "tasks", `${taskId}.json`), "utf-8"),
  ) as Record<string, unknown>;
  return { tier: def.tier as string, model: def.model as string };
}

describe("apply-selection resolves plan-state to primary from a lane", () => {
  test("a guided apply from a lane cwd with --project=primary finds the brief and lands researched cells, not defaults", () => {
    const { primary, lane, home, epicId, taskIds } = makeLaneScenario(
      "planctl-was-ok-",
      ["todo", "todo"],
    );
    seedLiveSelectionBrief(primary, epicId, taskIds);

    const verdict = JSON.stringify({
      cells: [
        { task_id: taskIds[0], tier: "high", model: "sonnet", rationale: "r1" },
        { task_id: taskIds[1], tier: "max", model: "opus" },
      ],
    });
    const before = gitLogCount(primary);
    const r = runCli(
      ["apply-selection", epicId, "--project", primary, "--file", "-"],
      { cwd: lane, home, input: verdict },
    );
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.success).toBe(true);
    expect(env.assigned_task_ids).toEqual(taskIds);

    // The researched cells landed in PRIMARY — not the scaffold-default
    // medium/opus the mechanical scaffold stamped every task.
    expect(readTaskCell(primary, taskIds[0] as string)).toEqual({
      tier: "high",
      model: "sonnet",
    });
    expect(readTaskCell(primary, taskIds[1] as string)).toEqual({
      tier: "max",
      model: "opus",
    });
    // The lane's committed def was never touched.
    expect(readTaskCell(lane, taskIds[0] as string)).toEqual({
      tier: "medium",
      model: "opus",
    });

    // The auto-commit landed in PRIMARY, never the lane.
    expect(gitLogCount(primary)).toBe(before + 1);
    expect(gitLogCount(lane)).toBe(0);
    expect(gitFilesInHead(primary)).toContain(
      `.keeper/tasks/${taskIds[0]}.json`,
    );
  });

  test("without --project, cwd-first locate still re-roots state through primary_repo", () => {
    // Same fix, no --project: the lane carries a byte-identical committed def
    // (epic.primary_repo) so cwd-first locate finds it, then re-roots to
    // primary regardless — the belt-and-suspenders case close's 3.5c beat
    // does not rely on, but the seam covers uniformly.
    const { primary, lane, home, epicId, taskIds } = makeLaneScenario(
      "planctl-was-noproj-",
      ["todo"],
    );
    seedLiveSelectionBrief(primary, epicId, taskIds);

    const verdict = JSON.stringify({
      cells: [{ task_id: taskIds[0], tier: "high", model: "sonnet" }],
    });
    const r = runCli(["apply-selection", epicId, "--file", "-"], {
      cwd: lane,
      home,
      input: verdict,
    });
    expect(r.code).toBe(0);
    expect(readTaskCell(primary, taskIds[0] as string)).toEqual({
      tier: "high",
      model: "sonnet",
    });
  });

  test("a lane cwd with no --project and no brief in primary still degrades to brief_missing (never a silent lane read)", () => {
    const { lane, home, epicId, taskIds } = makeLaneScenario(
      "planctl-was-missing-",
      ["todo"],
    );
    // No brief seeded anywhere — the pre-fix bug would have silently read the
    // lane's own (also brief-less) state/ and reported the same error, hiding
    // the real cross-cwd defect; the assertion here is on the CODE, not the
    // behavior change itself (a same-shape brief_missing is expected either
    // way once no brief exists anywhere).
    const r = runCli(["apply-selection", epicId, "--file", "-"], {
      cwd: lane,
      home,
      input: JSON.stringify({
        cells: [{ task_id: taskIds[0], tier: "high", model: "sonnet" }],
      }),
    });
    expect(r.code).toBe(1);
    const error = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(error.code).toBe("brief_missing");
  });
});

describe("close-phase submits resolve artifacts to primary from a lane", () => {
  // resolveAuditContext is the shared brief-finding seam every submit verb
  // (audit / verdict / followup) routes through resolvePlanStateContext, so a
  // submit from a lane cwd — WITH or WITHOUT --project — roots state at the epic's
  // primary_repo and finds the brief in primary. Audit submit is the canonical
  // lock; a verdict submit confirms the same seam from a second verb entry.

  function seedBriefViaPreflight(s: LaneScenario): void {
    const pre = runCli(["close-preflight", s.epicId], {
      cwd: s.lane,
      home: s.home,
    });
    expect(pre.code).toBe(0);
    expect(existsSync(briefPath(s.primary, s.epicId))).toBe(true);
  }

  test("audit submit from a lane with --project=primary finds the brief", () => {
    const s = makeLaneScenario("planctl-wcs-sub-", ["done"]);
    seedBriefViaPreflight(s);

    const ok = runCli(
      [
        "audit",
        "submit",
        s.epicId,
        "--project",
        s.primary,
        "--file",
        "-",
        "--risk",
        "Low",
      ],
      { cwd: s.lane, home: s.home, input: "# report\n" },
    );
    expect(ok.code).toBe(0);
    expect(parseCliOutput(ok.output).success).toBe(true);
  });

  test("audit submit from a lane WITHOUT --project auto-routes to primary's brief", () => {
    // The robustness the resolver buys: a lane-cwd submit with no --project
    // locates the committed def in the lane, reads epic.primary_repo, and roots
    // state at primary — finding the brief there and writing the report there.
    const s = makeLaneScenario("planctl-wcs-miss-", ["done"]);
    seedBriefViaPreflight(s);

    const ok = runCli(
      ["audit", "submit", s.epicId, "--file", "-", "--risk", "Low"],
      { cwd: s.lane, home: s.home, input: "# report\n" },
    );
    expect(ok.code).toBe(0);
    expect(parseCliOutput(ok.output).success).toBe(true);
    // The report landed in PRIMARY, never the lane.
    expect(existsSync(reportPath(s.primary, s.epicId))).toBe(true);
    expect(existsSync(reportPath(s.lane, s.epicId))).toBe(false);
  });

  test("verdict submit from a lane with --project=primary clears brief resolution", () => {
    const s = makeLaneScenario("planctl-wcs-vsub-", ["done"]);
    seedBriefViaPreflight(s);

    // A `{}` payload fails verdict validation, but the point is that --project
    // routes past the shared brief-finding seam: the error is NOT BRIEF_MISSING.
    const r = runCli(
      ["verdict", "submit", s.epicId, "--project", s.primary, "--file", "-"],
      { cwd: s.lane, home: s.home, input: "{}\n" },
    );
    expect(r.code).toBe(1);
    const error = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(error.code).not.toBe("BRIEF_MISSING");
  });
});

// ---------------------------------------------------------------------------
// close-finalize routes the IRREVERSIBLE epic-close tally + the follow-up mint
// to primary from a lane (no --project). The tally lives inside runEpicClose
// (force:false), which reads the runtime overlay; a lane-resolved close would
// tally the lane's empty overlay (TASKS_NOT_DONE) and orphan any follow-up into
// the lane. Threading contextForRoot(primaryRepo) into closeEpic + scaffoldFollowup
// lands both in primary even from a lane.
// ---------------------------------------------------------------------------

/** The empty-set canonical hash the verb re-derives for an epic whose seeded
 * tasks carry no `Task:` source-commit trailers. */
function emptySetHash(): string {
  return computeCommitSetHash([]);
}

/** Seed the close brief + verdict in PRIMARY's gitignored state (where they
 * live). `decisions` drives the outcome: empty → closed_clean; one kept → needs
 * a follow-up. */
function seedCloseArtifacts(
  s: LaneScenario,
  decisions: Array<Record<string, unknown>>,
): void {
  const hash = emptySetHash();
  writeBriefArtifact(s.primary, s.epicId, {
    schema_version: 1,
    epic_id: s.epicId,
    primary_repo: s.primary,
    commit_set_hash: hash,
    commit_groups: [],
    snippet_context: "",
    tasks: [],
  });
  writeArtifact(
    verdictPath(s.primary, s.epicId),
    `${JSON.stringify(
      {
        schema_version: 1,
        commit_set_hash: hash,
        fatal: false,
        fatal_reason: "",
        decisions,
      },
      null,
      2,
    )}\n`,
  );
}

/** A valid scaffold-plan followup.yaml wiring back to the source epic. */
function seedFollowupYaml(s: LaneScenario, nTasks: number): void {
  const blocks: string[] = [];
  for (let i = 1; i <= nTasks; i++) {
    const spec =
      "      ## Description\n      follow-up\n\n" +
      "      ## Acceptance\n      - [ ] x\n\n" +
      "      ## Done summary\n\n      ## Evidence\n";
    blocks.push(
      `  - title: Follow task ${i}\n    tier: medium\n    model: opus\n    spec: |\n${spec}`,
    );
  }
  const yaml =
    `epic:\n  title: Follow-up of ${s.epicId}\n` +
    `  depends_on_epics: [${s.epicId}]\n` +
    "  spec: |\n    ## Overview\n    follow overview\n" +
    `tasks:\n${blocks.join("\n")}\n`;
  writeArtifact(followupPath(s.primary, s.epicId), yaml);
}

function epicStatus(root: string, epicId: string): string {
  return (
    JSON.parse(
      readFileSync(join(root, ".keeper", "epics", `${epicId}.json`), "utf-8"),
    ) as Record<string, unknown>
  ).status as string;
}

describe("close-finalize tallies + mints to primary from a lane", () => {
  test("closed_clean: the irreversible close reads primary's done overlay", () => {
    const s = makeLaneScenario("planctl-wcf-clean-", ["done", "done"]);
    seedCloseArtifacts(s, []);

    // No --project: a lane-resolved tally would see the lane's empty overlay and
    // refuse TASKS_NOT_DONE. The fix tallies primary's done overlay and closes.
    const r = runCli(["close-finalize", s.epicId], {
      cwd: s.lane,
      home: s.home,
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).outcome).toBe("closed_clean");
    // The epic closed in PRIMARY...
    expect(epicStatus(s.primary, s.epicId)).toBe("done");
    // ...and the lane's committed def was never stamped done.
    expect(epicStatus(s.lane, s.epicId)).toBe("open");
  });

  test("followup-adoption read resolves to PRIMARY: an existing follow-up is adopted, not re-scaffolded", () => {
    // The :537 followup-adoption check must read the SAME primary-rooted context
    // as the close write. A follow-up epic already minted in PRIMARY (from a
    // prior close) is invisible to a lane-cwd read — pre-fix the lane scan finds
    // nothing and falls through to scaffold a duplicate; primary-rooted it finds
    // and ADOPTS the existing follow-up.
    const s = makeLaneScenario("planctl-wcf-adopt-", ["done"]);
    seedCloseArtifacts(s, [
      { fid: "f1", action: "kept", task: 1, rationale: "real" },
    ]);

    // Pre-seed the existing follow-up epic in PRIMARY only (never the lane):
    // status open + created_by_close_of==source + one task → actualTasks matches
    // the single surviving cluster, so the verb adopts it.
    const followupId = "fn-9-existing-followup";
    seedState(s.primary, {
      epicId: followupId,
      nTasks: 1,
      primaryRepo: s.primary,
    });
    const fePath = join(s.primary, ".keeper", "epics", `${followupId}.json`);
    const feDef = JSON.parse(readFileSync(fePath, "utf-8")) as Record<
      string,
      unknown
    >;
    feDef.created_by_close_of = s.epicId;
    writeArtifact(fePath, `${JSON.stringify(feDef, null, 2)}\n`);

    const r = runCli(["close-finalize", s.epicId], {
      cwd: s.lane,
      home: s.home,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.outcome).toBe("closed_with_followup");
    // The EXISTING follow-up was adopted — not a freshly-scaffolded id.
    expect(env.new_epic_id).toBe(followupId);
    expect(epicStatus(s.primary, s.epicId)).toBe("done");
    expect(epicStatus(s.lane, s.epicId)).toBe("open");
  });

  test("closed_with_followup: the follow-up tree mints into PRIMARY, not the lane", () => {
    const s = makeLaneScenario("planctl-wcf-followup-", ["done"]);
    seedCloseArtifacts(s, [
      { fid: "f1", action: "kept", task: 1, rationale: "real" },
    ]);
    seedFollowupYaml(s, 1);

    const r = runCli(["close-finalize", s.epicId], {
      cwd: s.lane,
      home: s.home,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.outcome).toBe("closed_with_followup");
    const newEpicId = env.new_epic_id as string;
    expect(newEpicId).toBeTruthy();
    expect(newEpicId).not.toBe(s.epicId);
    // The minted follow-up landed in PRIMARY, never orphaned into the lane.
    expect(
      existsSync(join(s.primary, ".keeper", "epics", `${newEpicId}.json`)),
    ).toBe(true);
    expect(
      existsSync(join(s.lane, ".keeper", "epics", `${newEpicId}.json`)),
    ).toBe(false);
    expect(epicStatus(s.primary, s.epicId)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// The STANDALONE `epic close` verb routes its tally + irreversible close to
// primary from a lane (no --project), same as the close-finalize delegation
// path. A lane-resolved tally would read the lane's empty overlay and refuse
// TASKS_NOT_DONE.
// ---------------------------------------------------------------------------

describe("epic close (standalone) resolves to primary from a lane", () => {
  const ENV = { CLAUDE_CODE_SESSION_ID: "test-epic-close-lane" };

  test("a done epic closes in primary, never stamping the lane's def", () => {
    const s = makeLaneScenario("planctl-ecl-ok-", ["done", "done"]);

    const r = runCli(["epic", "close", s.epicId], {
      cwd: s.lane,
      home: s.home,
      env: ENV,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.success).toBe(true);
    expect(env.status).toBe("done");
    expect(epicStatus(s.primary, s.epicId)).toBe("done");
    expect(epicStatus(s.lane, s.epicId)).toBe("open");
  });

  test("force:false refusal is intact: primary's open task blocks the close", () => {
    const s = makeLaneScenario("planctl-ecl-nd-", ["done", "todo"]);

    const r = runCli(["epic", "close", s.epicId], {
      cwd: s.lane,
      home: s.home,
      env: ENV,
    });
    expect(r.code).not.toBe(0);
    const error = parseCliOutput(r.output).error as string;
    expect(error).toContain("Cannot close");
    expect(error).toContain("not done");
    // Neither repo's def was stamped done.
    expect(epicStatus(s.primary, s.epicId)).toBe("open");
    expect(epicStatus(s.lane, s.epicId)).toBe("open");
  });

  test("--project stays authoritative from a lane", () => {
    const s = makeLaneScenario("planctl-ecl-proj-", ["done"]);

    const r = runCli(["epic", "close", s.epicId, "--project", s.primary], {
      cwd: s.lane,
      home: s.home,
      env: ENV,
    });
    expect(r.code).toBe(0);
    expect(epicStatus(s.primary, s.epicId)).toBe("done");
  });
});
