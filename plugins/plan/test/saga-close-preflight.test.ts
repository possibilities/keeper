// Conformance spec for `planctl close-preflight <epic_id>` — the close-phase
// brief handoff, translated from tests/test_close_preflight.py, every node
// mapped by a source-comment (translated | cited | drop-with-reason).
//
// The verb assembles the audit brief (source commit groups, ordinal task list +
// done summaries, the canonical commit_set_hash), persists it commit-free under
// gitignored audits/<epic_id>/brief.json, and emits a content-blind envelope
// {primary_repo, tasks, all_done, brief_ref, commit_set_hash, phase_resume} —
// commit_groups prose lives ONLY in the brief. The verb-level tests drive the verb in a
// withProject repo (git-free); the trailer-scan tests seed fake source commits
// through the VCS fixture.
//
// The TestCommitLookup unit class targets the shared commit_lookup.findCommitGroups
// seam directly. Variants already pinned by src-git-lookup.test.ts are CITED;
// the variants it does not cover (is_task_id gate, multi-valued keys, sha dedup,
// touched_repos tri-state, first-seen order, one-broken-skip) translate here as
// direct findCommitGroups unit tests (a new file, not an extension of the
// citation target). The all-repos-broken verb path is python_only (drop).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ArtifactSchemaTooNewError,
  AUDIT_SCHEMA_VERSION,
  auditsRoot,
  briefPath,
  computeCommitSetHash,
  followupMetaPath,
  followupPath,
  readArtifactJson,
  reportMetaPath,
  reportPath,
  setAuditSchemaVersion,
  verdictPath,
  writeArtifact,
} from "../src/audit_artifacts.ts";
import {
  AllReposBrokenError,
  findCommitGroups,
  laneBranchFor,
} from "../src/commit_lookup.ts";
import { SELECTION_SCHEMA_VERSION } from "../src/selection_sidecar.ts";
import { resetVcs, setVcs } from "../src/vcs.ts";
import {
  deriveDepthBand,
  readAuditPolicyDoc,
} from "../src/verbs/close_preflight.ts";
import { SELECTION_BRIEF_SCHEMA_VERSION } from "../src/verbs/selection_brief.ts";
import {
  initRepo as fakeInitRepo,
  fakeVcs,
  setNumstatError,
} from "./fake-vcs.ts";
import {
  fakeSourceCommit,
  gitHeadSha,
  gitInit,
  gitLogCount,
  fakeCommand as installCommandFake,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

// Seed a fake source commit carrying `body` in `repo`; return the fake sha.
function seedCommit(repo: string, taskId: string, body?: string): string {
  return fakeSourceCommit(repo, body ?? `feat: work\n\nTask: ${taskId}\n`);
}

// Scaffold an epic with N tasks, driving `statuses[i] === "done"` to done.
function makeEpic(
  proj: { root: string; home: string },
  statuses: string[],
): { epicId: string; taskIds: string[] } {
  const { epicId, taskIds } = scaffoldEpic(
    { root: proj.root, home: proj.home },
    { title: "Demo epic", nTasks: statuses.length },
  );
  statuses.forEach((status, i) => {
    if (status === "done") {
      const tid = taskIds[i] as string;
      const r = runCli(
        ["done", tid, "--summary", `summary for ${tid}`, "--force"],
        {
          cwd: proj.root,
          home: proj.home,
        },
      );
      if (r.code !== 0) {
        throw new Error(`done failed for ${tid}:\n${r.output}`);
      }
    }
  });
  return { epicId, taskIds };
}

function loadBrief(root: string, epicId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(briefPath(root, epicId), "utf-8"));
}

// ---------------------------------------------------------------------------
// Success envelope + brief shape.
// ---------------------------------------------------------------------------

describe("close-preflight success envelope + brief", () => {
  const getProj = withProject("planctl-cpf-");

  test("envelope is content-blind (handle + hash, no prose)", () => {
    // test_close_preflight.py::TestSuccessEnvelope::test_envelope_is_content_blind
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done", "done"]);
    const keeper = installCommandFake("keeper", {
      stdout: JSON.stringify({
        ok: true,
        kind: "deconflict",
        incident: {
          conflict: {
            instance_event_id: 81,
            attempt_id: 13,
            claim: {
              session_id: "session-closer",
              pid: 8181,
              start_time: "proc:8181:1",
              claimed_at: 1_700_000_001,
            },
          },
          grant_ref: "/state/grants/grant-close.json",
        },
      }),
    });
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.all_done).toBe(true);
    expect(env.brief_ref).toBe(briefPath(proj.root, epicId));
    expect(typeof env.commit_set_hash).toBe("string");
    expect(env.commit_set_hash).toBeTruthy();
    const tasks = env.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id)).toEqual(taskIds);
    expect(tasks.map((t) => t.status)).toEqual(["done", "done"]);
    expect("snippet_context" in env).toBe(false);
    expect("commit_groups" in env).toBe(false);
    expect(env.incident).toEqual({
      incident_id: `close::${epicId}`,
      kind: "deconflict",
      instance_event_id: 81,
      attempt_id: 13,
      brief_ref: `close::${epicId}`,
      grant_ref: "/state/grants/grant-close.json",
      claim: {
        session_id: "session-closer",
        pid: 8181,
        start_time: "proc:8181:1",
        claimed_at: 1_700_000_001,
      },
    });
    expect(keeper.calls()).toEqual([["escalation-brief", `close::${epicId}`]]);
  });

  test("envelope hash matches the brief's hash (canonical over groups)", () => {
    // test_close_preflight.py::TestSuccessEnvelope::test_envelope_hash_matches_brief
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    const brief = loadBrief(proj.root, epicId);
    expect(env.commit_set_hash).toBe(brief.commit_set_hash);
    expect(brief.commit_set_hash).toBe(
      computeCommitSetHash(brief.commit_groups as never),
    );
  });

  test("brief carries the full shape (schema, repo, tasks, done summaries)", () => {
    // test_close_preflight.py::TestBriefShape::test_brief_has_full_shape
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done", "done"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const brief = loadBrief(proj.root, epicId);
    expect(brief.schema_version).toBe(1);
    expect(brief.epic_id).toBe(epicId);
    expect(brief.primary_repo).toBe(realpathSync(proj.root));
    expect(brief.snippet_context).toBe("");
    expect(brief.commit_groups).toEqual([]);
    const tasks = brief.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id)).toEqual(taskIds);
    expect(tasks.map((t) => t.status)).toEqual(["done", "done"]);
    expect(tasks[0]?.done_summary).toBe(`summary for ${taskIds[0]}`);
    expect(tasks[1]?.done_summary).toBe(`summary for ${taskIds[1]}`);
  });

  test("brief carries per-task target_repo + epic touched_repos (the close-planner repo map)", () => {
    // The close-planner routes each follow-up task by these fields. Scaffold
    // resolves an omitted per-task target_repo to the epic primary, so a
    // single-repo source carries the realpath-normalized primary on every task
    // and touched_repos = [primary].
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done", "done"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const brief = loadBrief(proj.root, epicId);
    const primary = realpathSync(proj.root);
    expect(brief.touched_repos).toEqual([primary]);
    const tasks = brief.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id)).toEqual(taskIds);
    for (const t of tasks) {
      expect("target_repo" in t).toBe(true);
      expect(t.target_repo).toBe(primary);
    }
  });

  test("brief write is commit-free: HEAD unmoved, nothing tracked", () => {
    // test_close_preflight.py::TestBriefShape::test_brief_no_commit_lands
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    const before = gitHeadSha(proj.root);
    const beforeCount = gitLogCount(proj.root);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(gitHeadSha(proj.root)).toBe(before);
    expect(gitLogCount(proj.root)).toBe(beforeCount);
    // The brief lands under gitignored state/audits/, never in the data-dir
    // commit scope.
    expect(existsSync(join(proj.root, ".keeper", "state", "audits"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Durable close-phase resume grading.
// ---------------------------------------------------------------------------

const EMPTY_COMMIT_SET_HASH =
  "1d9ebf5514067028b750fb8f1ec6dff67d94515b5224186200ee4331f6d2a029";

function writeJsonArtifact(path: string, value: Record<string, unknown>): void {
  writeArtifact(path, `${JSON.stringify(value, null, 2)}\n`);
}

function seedAuditPhase(
  root: string,
  epicId: string,
  hash: string,
  findings: number,
  schemaVersion = AUDIT_SCHEMA_VERSION,
): void {
  writeArtifact(reportPath(root, epicId), "# Audit report\n");
  writeJsonArtifact(reportMetaPath(root, epicId), {
    schema_version: schemaVersion,
    epic_id: epicId,
    commit_set_hash: hash,
    findings,
    risk: "Low",
  });
}

function seedPlanPhase(
  root: string,
  epicId: string,
  hash: string,
  opts: { fatal?: boolean; followup?: boolean } = {},
): string | null {
  writeJsonArtifact(verdictPath(root, epicId), {
    schema_version: AUDIT_SCHEMA_VERSION,
    commit_set_hash: hash,
    fatal: opts.fatal ?? false,
    fatal_reason: opts.fatal ? "ship block" : "",
    decisions: opts.followup
      ? [{ fid: "f1", action: "kept", task: 1, rationale: "real" }]
      : [],
  });
  if (!opts.followup) {
    return null;
  }
  const text =
    "epic:\n  title: Follow-up\n  spec: |\n    follow-up\n" +
    "tasks:\n  - title: Fix finding\n    tier: medium\n    model: opus\n";
  writeArtifact(followupPath(root, epicId), text);
  writeJsonArtifact(followupMetaPath(root, epicId), {
    schema_version: AUDIT_SCHEMA_VERSION,
    epic_id: epicId,
    commit_set_hash: hash,
    task_count: 1,
  });
  return text;
}

function seedSelectionPhase(
  root: string,
  epicId: string,
  followupText: string,
): string {
  const inputHash = createHash("sha256").update(followupText).digest("hex");
  const dir = join(root, ".keeper", "state", "selections", epicId);
  mkdirSync(dir, { recursive: true });
  const brief = join(dir, "followup-brief.json");
  const verdict = join(dir, "followup-verdict.json");
  writeJsonArtifact(brief, {
    schema_version: SELECTION_BRIEF_SCHEMA_VERSION,
    epic_id: epicId,
    from_followup: true,
    input_hash: inputHash,
  });
  writeJsonArtifact(verdict, {
    schema_version: SELECTION_SCHEMA_VERSION,
    cells: { "1": { tier: "medium", model: "opus" } },
    selection: {
      harness: "subagent",
      model: "plan:model-selector",
      config_hash: "fixture-config",
      input_hash: inputHash,
      shuffle_seed: 7,
      outcome: "completed",
      verdict_raw: "fixture",
    },
  });
  return verdict;
}

describe("close-preflight durable phase resume", () => {
  const getProj = withProject("planctl-cpf-resume-");

  function preflight(
    proj: { root: string; home: string },
    epicId: string,
  ): Record<string, unknown> {
    const result = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(result.code).toBe(0);
    return parseCliOutput(result.output);
  }

  test("all fresh phases are satisfied and emit the selection verdict path", () => {
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    seedAuditPhase(proj.root, epicId, EMPTY_COMMIT_SET_HASH, 1);
    const followup = seedPlanPhase(proj.root, epicId, EMPTY_COMMIT_SET_HASH, {
      followup: true,
    }) as string;
    const selectionVerdict = seedSelectionPhase(proj.root, epicId, followup);

    expect(preflight(proj, epicId).phase_resume).toEqual({
      audit: "satisfied",
      plan: "satisfied",
      selection: "satisfied",
      findings: 1,
      fatal: false,
      followup_present: true,
      selection_verdict_path: selectionVerdict,
    });
  });

  test("selection artifacts accept their family schema ceilings", () => {
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    seedAuditPhase(proj.root, epicId, EMPTY_COMMIT_SET_HASH, 1);
    const followup = seedPlanPhase(proj.root, epicId, EMPTY_COMMIT_SET_HASH, {
      followup: true,
    }) as string;
    const verdict = seedSelectionPhase(proj.root, epicId, followup);
    const brief = join(
      proj.root,
      ".keeper",
      "state",
      "selections",
      epicId,
      "followup-brief.json",
    );
    const auditCeiling = AUDIT_SCHEMA_VERSION;

    expect(preflight(proj, epicId).phase_resume?.selection).toBe("satisfied");

    try {
      setAuditSchemaVersion(0);
      expect(readArtifactJson(brief, SELECTION_BRIEF_SCHEMA_VERSION)).toEqual({
        schema_version: SELECTION_BRIEF_SCHEMA_VERSION,
        epic_id: epicId,
        from_followup: true,
        input_hash:
          "c55d4ed083a013f6038d9447b772f982db45b7ae75190004345544c084bded61",
      });
      expect(readArtifactJson(verdict, SELECTION_SCHEMA_VERSION)).toEqual({
        schema_version: SELECTION_SCHEMA_VERSION,
        cells: { "1": { tier: "medium", model: "opus" } },
        selection: {
          harness: "subagent",
          model: "plan:model-selector",
          config_hash: "fixture-config",
          input_hash:
            "c55d4ed083a013f6038d9447b772f982db45b7ae75190004345544c084bded61",
          shuffle_seed: 7,
          outcome: "completed",
          verdict_raw: "fixture",
        },
      });
      expect(() => readArtifactJson(brief)).toThrow(ArtifactSchemaTooNewError);
    } finally {
      setAuditSchemaVersion(auditCeiling);
    }
  });

  test("selection is unfinished when its input hash does not match the follow-up", () => {
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    seedAuditPhase(proj.root, epicId, EMPTY_COMMIT_SET_HASH, 1);
    const followup = seedPlanPhase(proj.root, epicId, EMPTY_COMMIT_SET_HASH, {
      followup: true,
    }) as string;
    const verdict = seedSelectionPhase(proj.root, epicId, followup);
    const parsed = JSON.parse(readFileSync(verdict, "utf-8")) as Record<
      string,
      unknown
    >;
    (parsed.selection as Record<string, unknown>).input_hash = "stale-input";
    writeJsonArtifact(verdict, parsed);

    expect(preflight(proj, epicId).phase_resume).toEqual({
      audit: "satisfied",
      plan: "satisfied",
      selection: "unfinished",
      findings: 1,
      fatal: false,
      followup_present: true,
      selection_verdict_path: null,
    });
  });

  test("a moved commit set invalidates audit and every downstream phase", () => {
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done"]);
    seedAuditPhase(proj.root, epicId, EMPTY_COMMIT_SET_HASH, 1);
    const followup = seedPlanPhase(proj.root, epicId, EMPTY_COMMIT_SET_HASH, {
      followup: true,
    }) as string;
    seedSelectionPhase(proj.root, epicId, followup);
    seedCommit(proj.root, taskIds[0] as string);

    expect(preflight(proj, epicId).phase_resume).toEqual({
      audit: "unfinished",
      plan: "unfinished",
      selection: "unfinished",
      findings: null,
      fatal: null,
      followup_present: false,
      selection_verdict_path: null,
    });
  });

  test("findings=0 makes plan and selection not needed", () => {
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    seedAuditPhase(proj.root, epicId, EMPTY_COMMIT_SET_HASH, 0);

    expect(preflight(proj, epicId).phase_resume).toEqual({
      audit: "satisfied",
      plan: "not_needed",
      selection: "not_needed",
      findings: 0,
      fatal: false,
      followup_present: false,
      selection_verdict_path: null,
    });
  });

  test("a fresh fatal verdict satisfies plan and makes selection not needed", () => {
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    seedAuditPhase(proj.root, epicId, EMPTY_COMMIT_SET_HASH, 1);
    seedPlanPhase(proj.root, epicId, EMPTY_COMMIT_SET_HASH, { fatal: true });

    expect(preflight(proj, epicId).phase_resume).toEqual({
      audit: "satisfied",
      plan: "satisfied",
      selection: "not_needed",
      findings: 1,
      fatal: true,
      followup_present: false,
      selection_verdict_path: null,
    });
  });

  test("a torn audit with report.md but no meta is unfinished", () => {
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    writeArtifact(reportPath(proj.root, epicId), "# Torn report\n");

    expect(preflight(proj, epicId).phase_resume).toMatchObject({
      audit: "unfinished",
      plan: "unfinished",
      selection: "unfinished",
    });
  });

  test("a too-new artifact schema degrades to unfinished without failing", () => {
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    seedAuditPhase(
      proj.root,
      epicId,
      EMPTY_COMMIT_SET_HASH,
      1,
      AUDIT_SCHEMA_VERSION + 1,
    );

    const env = preflight(proj, epicId);
    expect(env.success).toBe(true);
    expect(env.phase_resume).toMatchObject({
      audit: "unfinished",
      plan: "unfinished",
      selection: "unfinished",
    });
  });

  test("an empty artifact set emits null", () => {
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    expect(preflight(proj, epicId).phase_resume).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// all_done false → TASKS_NOT_DONE; no brief written.
// ---------------------------------------------------------------------------

describe("close-preflight tasks-not-done", () => {
  const getProj = withProject("planctl-cpf-nd-");

  test("not all done -> TASKS_NOT_DONE naming the not_done set", () => {
    // test_close_preflight.py::TestTasksNotDone::test_not_all_done_is_typed_error
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done", "todo"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(1);
    const env = parseCliOutput(r.output);
    expect(env.success).toBe(false);
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe("TASKS_NOT_DONE");
    expect((error.details as Record<string, unknown>).not_done).toEqual([
      taskIds[1],
    ]);
  });

  test("a not-ready epic leaves no stale brief on disk", () => {
    // test_close_preflight.py::TestTasksNotDone::test_not_done_writes_no_brief
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["todo"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(1);
    expect(existsSync(briefPath(proj.root, epicId))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// commit_groups inside the brief (verb-level, real git).
// ---------------------------------------------------------------------------

describe("close-preflight commit_groups", () => {
  const getProj = withProject("planctl-cpf-cg-");

  test("no seeded commits -> empty commit set", () => {
    // test_close_preflight.py::TestCommitGroups::test_empty_commit_set
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(loadBrief(proj.root, epicId).commit_groups).toEqual([]);
  });

  test("native scan groups both tasks' source commits in primary", () => {
    // test_close_preflight.py::TestCommitGroups::test_groups_real_commits_in_primary_repo
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done", "done"]);
    const sha0 = seedCommit(proj.root, taskIds[0] as string);
    const sha1 = seedCommit(proj.root, taskIds[1] as string);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    const brief = loadBrief(proj.root, epicId);
    const primary = realpathSync(proj.root);
    expect(brief.commit_groups).toEqual([
      { repo: primary, shas: [sha0, sha1] },
    ]);
    expect(env.commit_set_hash).toBe(
      computeCommitSetHash(brief.commit_groups as never),
    );
  });

  test("prose Task: mention dropped by the post-filter", () => {
    // test_close_preflight.py::TestCommitGroups::test_prose_false_match_is_dropped
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done"]);
    seedCommit(
      proj.root,
      taskIds[0] as string,
      `chore: note\n\nfixes the Task: ${taskIds[0]} issue in prose\n`,
    );
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(loadBrief(proj.root, epicId).commit_groups).toEqual([]);
  });

  // test_close_preflight.py::TestCommitGroups::test_all_repos_broken_is_fail_loud
  //   -> DROP (python_only): monkeypatches planctl.api.load_epic in-process to
  //      inject an all-broken touched_repos — cannot cross the subprocess
  //      boundary. The AllReposBrokenError -> COMMIT_LOOKUP_FAILED path is
  //      covered by the direct AllReposBrokenError unit below + the verb's
  //      typed-error mapping shared across engines.
});

// ---------------------------------------------------------------------------
// id / existence gates.
// ---------------------------------------------------------------------------

describe("close-preflight gates", () => {
  const getProj = withProject("planctl-cpf-gate-");

  test("malformed id -> BAD_EPIC_ID", () => {
    // test_close_preflight.py::TestGates::test_bad_epic_id
    const proj = getProj();
    const r = runCli(["close-preflight", "not-an-id", "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(1);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("BAD_EPIC_ID");
  });

  test("task-shaped id -> BAD_EPIC_ID pointing at the parent epic", () => {
    // test_close_preflight.py::TestGates::test_task_id_names_parent_epic
    const proj = getProj();
    const r = runCli(
      ["close-preflight", "fn-1-demo.2", "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).toBe(1);
    const error = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(error.code).toBe("BAD_EPIC_ID");
    expect((error.message as string).includes("fn-1-demo")).toBe(true);
    const details = error.details as Record<string, unknown>;
    expect(details.parent_epic).toBe("fn-1-demo");
    expect(details.task_id).toBe("fn-1-demo.2");
  });

  test("unknown epic -> EPIC_NOT_FOUND", () => {
    // test_close_preflight.py::TestGates::test_epic_not_found
    const proj = getProj();
    const r = runCli(
      ["close-preflight", "fn-99-missing", "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).toBe(1);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("EPIC_NOT_FOUND");
  });

  // test_close_preflight.py::test_run_directly_no_click_context
  //   -> DROP (python_only-shaped): calls run_close_preflight.run(SimpleNamespace)
  //      directly to exercise the no-click-context sentinel no-op — an in-process
  //      direct-call seam with no CLI subprocess analogue; the bun verb has no
  //      click-context coupling (the success path is the same code the
  //      CLI tests above already drive end-to-end).
});

// ---------------------------------------------------------------------------
// --project resolution.
// ---------------------------------------------------------------------------

describe("close-preflight --project flag", () => {
  const getProj = withProject("planctl-cpf-proj-");

  test("--project resolves from outside cwd", () => {
    // test_close_preflight.py::TestProjectFlag::test_project_resolves_from_outside_cwd
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    // cwd is an unrelated dir; --project carries the resolution.
    const elsewhere = mkdtempSync(join(tmpdir(), "planctl-cpf-elsewhere-"));
    try {
      const r = runCli(["close-preflight", epicId, "--project", proj.root], {
        cwd: elsewhere,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      const env = parseCliOutput(r.output);
      expect(env.success).toBe(true);
      expect("brief_ref" in env).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("relative --project -> usage error (exit 2)", () => {
    // test_close_preflight.py::TestProjectFlag::test_project_relative_raises_usage_error
    const proj = getProj();
    const r = runCli(
      ["close-preflight", "fn-1-bogus", "--project", "relative/path"],
      { cwd: proj.root, home: proj.home },
    );
    expect(r.code).toBe(2);
    expect(r.output.includes("absolute path")).toBe(true);
  });

  test("--project unset falls back to cwd-walk", () => {
    // test_close_preflight.py::TestProjectFlag::test_project_unset_falls_back_to_cwd_walk
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    const r = runCli(["close-preflight", epicId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).success).toBe(true);
  });

  test("tilde --project from non-project cwd: no spurious missing-project error", () => {
    // The verb expands a `~`-form --project before resolving it, so a tilde
    // --project from an unrelated cwd resolves through the project root rather
    // than re-resolving from cwd into a spurious missing-project error envelope.
    const proj = getProj();
    // A project under the binary's HOME, so a `~/<name>` --project resolves to it.
    const projName = "tilde-cpf-proj";
    const tildeRoot = join(proj.home, projName);
    mkdirSync(tildeRoot, { recursive: true });
    gitInit(tildeRoot);
    const initRes = runCli(["init"], { cwd: tildeRoot, home: proj.home });
    expect(initRes.code).toBe(0);
    const { epicId } = makeEpic({ root: tildeRoot, home: proj.home }, ["done"]);

    // cwd is an unrelated, non-project dir; only the tilde --project carries it.
    const elsewhere = mkdtempSync(
      join(tmpdir(), "planctl-cpf-tilde-elsewhere-"),
    );
    try {
      const r = runCli(
        ["close-preflight", epicId, "--project", `~/${projName}`],
        { cwd: elsewhere, home: proj.home },
      );
      expect(r.code).toBe(0);
      expect(r.output.includes("No plan project found")).toBe(false);
      const env = parseCliOutput(r.output);
      expect(env.success).toBe(true);
      expect("brief_ref" in env).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Direct findCommitGroups unit coverage — the variants src-git-lookup.test.ts
// does not pin. (CITED variants: clean-miss, prose-drop, touched_repos=[],
// all-broken-raises, first-flatten-order — owned by src-git-lookup.test.ts.)
// ---------------------------------------------------------------------------

describe("findCommitGroups unit (test_close_preflight.py TestCommitLookup)", () => {
  let repoRoot: string;
  beforeEach(() => {
    setVcs(fakeVcs);
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "planctl-cpf-lookup-")));
  });
  afterEach(() => {
    resetVcs();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function gitRepo(name: string): string {
    const p = join(repoRoot, name);
    mkdirSync(p, { recursive: true });
    fakeInitRepo(p);
    return realpathSync(p);
  }

  // test_close_preflight.py::TestCommitLookup::test_clean_miss_returns_empty
  //   -> CITED src-git-lookup.test.ts findCommitGroups "clean miss → empty result"
  // test_close_preflight.py::TestCommitLookup::test_prose_false_match_dropped_by_post_filter
  //   -> CITED src-git-lookup.test.ts findCommitGroups
  //      "a prose Task: mention is dropped by the trailer post-filter"

  test("is_task_id gate: a confirmed trailer whose value is an epic id never matches", () => {
    // test_close_preflight.py::TestCommitLookup::test_is_task_id_rejected_trailer_value_dropped
    const repo = gitRepo("r");
    seedCommit(repo, "fn-1-foo", "feat: x\n\nTask: fn-1-foo\n");
    expect(findCommitGroups(["fn-1-foo"], repo, null)).toEqual([]);
  });

  test("multi-valued Task: trailers — each task query finds the shared commit", () => {
    // test_close_preflight.py::TestCommitLookup::test_multi_valued_task_keys
    const repo = gitRepo("r");
    const sha = seedCommit(
      repo,
      "fn-1-foo.1",
      "feat: x\n\nTask: fn-1-foo.1\nTask: fn-1-foo.2\n",
    );
    expect(findCommitGroups(["fn-1-foo.1", "fn-1-foo.2"], repo, null)).toEqual([
      { repo, shas: [sha] },
    ]);
  });

  test("sha dedup within a repo (duplicate trailer for the same task)", () => {
    // test_close_preflight.py::TestCommitLookup::test_sha_dedup_within_repo
    const repo = gitRepo("r");
    const sha = seedCommit(
      repo,
      "fn-1-foo.1",
      "feat: x\n\nTask: fn-1-foo.1\nTask: fn-1-foo.1\n",
    );
    expect(findCommitGroups(["fn-1-foo.1"], repo, null)).toEqual([
      { repo, shas: [sha] },
    ]);
  });

  test("touched_repos=null scans primary", () => {
    // test_close_preflight.py::TestCommitLookup::test_touched_repos_none_scans_primary
    const primary = gitRepo("primary");
    const sha = seedCommit(primary, "fn-1-foo.1");
    expect(findCommitGroups(["fn-1-foo.1"], primary, null)).toEqual([
      { repo: primary, shas: [sha] },
    ]);
  });

  // test_close_preflight.py::TestCommitLookup::test_touched_repos_empty_scans_nothing
  //   -> CITED src-git-lookup.test.ts findCommitGroups "touched_repos=[] returns []"

  test("touched_repos first-seen order (not discovery order)", () => {
    // test_close_preflight.py::TestCommitLookup::test_touched_repos_first_seen_order
    const repoB = gitRepo("b");
    const repoA = gitRepo("a");
    const shaB = seedCommit(repoB, "fn-1-foo.1");
    const shaA = seedCommit(repoA, "fn-1-foo.1");
    expect(findCommitGroups(["fn-1-foo.1"], repoA, [repoB, repoA])).toEqual([
      { repo: repoB, shas: [shaB] },
      { repo: repoA, shas: [shaA] },
    ]);
  });

  test("epic-close multi-repo mixed: primary lane-only + secondary HEAD both group", () => {
    // The worktree-epic close geometry: the primary's source commit lives ONLY on
    // the epic lane `keeper/epic/<id>` (pre-merge), a secondary repo has no lane
    // so its commit is on HEAD. The epicId-scoped scan probes each repo: lane ref
    // in the primary, HEAD fallback in the secondary — neither is dropped.
    const epicId = "fn-1-foo";
    const primary = gitRepo("primary");
    const secondary = gitRepo("secondary");
    const shaP = fakeSourceCommit(primary, "feat: p\n\nTask: fn-1-foo.1\n", {
      refs: [laneBranchFor(epicId)],
    });
    const shaS = seedCommit(secondary, "fn-1-foo.2");
    // HEAD-only (no epicId) is blind to the primary's lane-only commit.
    expect(
      findCommitGroups(["fn-1-foo.1", "fn-1-foo.2"], primary, [
        primary,
        secondary,
      ]),
    ).toEqual([{ repo: secondary, shas: [shaS] }]);
    // Lane-aware close scan surfaces both, in touched_repos order.
    expect(
      findCommitGroups(
        ["fn-1-foo.1", "fn-1-foo.2"],
        primary,
        [primary, secondary],
        epicId,
      ),
    ).toEqual([
      { repo: primary, shas: [shaP] },
      { repo: secondary, shas: [shaS] },
    ]);
  });

  test("one broken repo is skipped; the good repo still yields its group", () => {
    // test_close_preflight.py::TestCommitLookup::test_one_broken_repo_is_skipped
    const good = gitRepo("good");
    const broken = join(repoRoot, "broken");
    mkdirSync(broken, { recursive: true });
    const sha = seedCommit(good, "fn-1-foo.1");
    expect(
      findCommitGroups(["fn-1-foo.1"], good, [realpathSync(broken), good]),
    ).toEqual([{ repo: good, shas: [sha] }]);
  });

  test("all repos broken -> AllReposBrokenError with broken_repos", () => {
    // test_close_preflight.py::TestCommitLookup::test_all_repos_broken_raises
    //   (the raise itself is also CITED src-git-lookup.test.ts "every repo
    //    missing/non-git → AllReposBrokenError"; the broken_repos accessor is
    //    pinned here)
    const missing = join(repoRoot, "missing");
    const notGit = join(repoRoot, "not-git");
    mkdirSync(notGit, { recursive: true });
    let caught: AllReposBrokenError | null = null;
    try {
      findCommitGroups(["fn-1-foo.1"], missing, [missing, notGit]);
    } catch (e) {
      caught = e as AllReposBrokenError;
    }
    expect(caught).toBeInstanceOf(AllReposBrokenError);
    expect((caught as AllReposBrokenError).brokenRepos).toEqual([
      missing,
      realpathSync(notGit),
    ]);
  });
});

// ---------------------------------------------------------------------------
// commit-set numstat facade (fake twin) — the aggregate the depth signal reads,
// no test touches real git.
// ---------------------------------------------------------------------------

describe("commitSetNumstat fake twin", () => {
  let repo: string;
  beforeEach(() => {
    setVcs(fakeVcs);
    repo = realpathSync(mkdtempSync(join(tmpdir(), "planctl-cpf-numstat-")));
    fakeInitRepo(repo);
  });
  afterEach(() => {
    resetVcs();
    rmSync(repo, { recursive: true, force: true });
  });

  test("sums per-commit numstat across the set (a path in two commits counts twice)", () => {
    const shaA = fakeSourceCommit(repo, "feat: a\n\nTask: fn-1-x.1\n", {
      numstat: [
        { path: "src/a.ts", insertions: 10, deletions: 2 },
        { path: "src/b.ts", insertions: 5, deletions: 0 },
      ],
    });
    const shaB = fakeSourceCommit(repo, "feat: b\n\nTask: fn-1-x.2\n", {
      numstat: [{ path: "src/a.ts", insertions: 3, deletions: 1 }],
    });
    // Hand-summed: insertions 10+5+3, deletions 2+0+1, rows 2+1.
    expect(fakeVcs.commitSetNumstat([shaA, shaB], repo)).toEqual({
      insertions: 18,
      deletions: 3,
      files: 3,
      error: false,
    });
  });

  test("empty sha list is a clean zero, never an error", () => {
    expect(fakeVcs.commitSetNumstat([], repo)).toEqual({
      insertions: 0,
      deletions: 0,
      files: 0,
      error: false,
    });
  });

  test("an unknown sha contributes nothing (skipped, not an error)", () => {
    const sha = fakeSourceCommit(repo, "feat: a\n\nTask: fn-1-x.1\n", {
      numstat: [{ path: "src/a.ts", insertions: 4, deletions: 4 }],
    });
    expect(fakeVcs.commitSetNumstat([sha, "f".repeat(40)], repo)).toEqual({
      insertions: 4,
      deletions: 4,
      files: 1,
      error: false,
    });
  });

  test("an armed numstat error reports error:true with zero totals", () => {
    const sha = fakeSourceCommit(repo, "feat: a\n\nTask: fn-1-x.1\n", {
      numstat: [{ path: "src/a.ts", insertions: 9, deletions: 9 }],
    });
    setNumstatError(repo, true);
    expect(fakeVcs.commitSetNumstat([sha], repo)).toEqual({
      insertions: 0,
      deletions: 0,
      files: 0,
      error: true,
    });
  });
});

// ---------------------------------------------------------------------------
// deriveDepthBand — the pure policy → band derivation, fixture-driven.
// ---------------------------------------------------------------------------

describe("deriveDepthBand (pure policy derivation)", () => {
  // Richest-first, mirroring the committed audit-policy.yaml's own
  // depth_bands list shape and ordering convention.
  const policy = {
    depth_bands: [
      {
        depth: "deep",
        min_task_count: 8,
        min_diff_loc: 2000,
        min_touched_repos: 2,
      },
      {
        depth: "standard",
        min_task_count: 3,
        min_diff_loc: 400,
        min_touched_repos: 1,
      },
    ],
  };

  test("null policy → lean, no reason (the file reason is the caller's)", () => {
    expect(
      deriveDepthBand(
        { task_count: 99, diff_lines: 99999, touched_repo_count: 9 },
        null,
      ),
    ).toEqual({ band: "lean", reasons: [] });
  });

  test("policy without a depth_bands list → lean, policy_no_depth_bands", () => {
    expect(
      deriveDepthBand(
        { task_count: 99, diff_lines: 99999, touched_repo_count: 9 },
        { unrelated: true },
      ),
    ).toEqual({ band: "lean", reasons: ["policy_no_depth_bands"] });
  });

  test("signals below every band → lean (legitimate, not degraded)", () => {
    expect(
      deriveDepthBand(
        { task_count: 2, diff_lines: 100, touched_repo_count: 1 },
        policy,
      ),
    ).toEqual({ band: "lean", reasons: [] });
  });

  test("signals meeting standard but not deep → standard", () => {
    expect(
      deriveDepthBand(
        { task_count: 4, diff_lines: 500, touched_repo_count: 1 },
        policy,
      ),
    ).toEqual({ band: "standard", reasons: [] });
  });

  test("signals meeting deep → deep (deepest-first wins)", () => {
    expect(
      deriveDepthBand(
        { task_count: 10, diff_lines: 3000, touched_repo_count: 3 },
        policy,
      ),
    ).toEqual({ band: "deep", reasons: [] });
  });

  test("one unmet minimum drops a band (AND within a band): deep's repo count fails → standard", () => {
    expect(
      deriveDepthBand(
        { task_count: 20, diff_lines: 5000, touched_repo_count: 1 },
        policy,
      ),
    ).toEqual({ band: "standard", reasons: [] });
  });

  test("a present-but-non-numeric threshold makes its band never match (bias lean)", () => {
    const bad = {
      depth_bands: [
        { depth: "standard", min_task_count: "lots", min_diff_loc: 1 },
      ],
    };
    expect(
      deriveDepthBand(
        { task_count: 100, diff_lines: 100, touched_repo_count: 100 },
        bad,
      ),
    ).toEqual({ band: "lean", reasons: [] });
  });

  test("an empty band never matches", () => {
    const empty = {
      depth_bands: [{ depth: "standard" }, { depth: "deep" }],
    };
    expect(
      deriveDepthBand(
        { task_count: 100, diff_lines: 100000, touched_repo_count: 50 },
        empty,
      ),
    ).toEqual({ band: "lean", reasons: [] });
  });
});

// ---------------------------------------------------------------------------
// deriveDepthBand over the REAL committed audit-policy.yaml: every fixture
// above is hand-built, so a consumer/config shape mismatch would never
// surface there. This threads the real on-disk depth_bands list the same
// way close-preflight does.
// ---------------------------------------------------------------------------

describe("deriveDepthBand over the real committed audit-policy.yaml", () => {
  const PLAN_ROOT = resolve(import.meta.dir, "..");
  const { doc: realPolicy, reason: realPolicyReason } = readAuditPolicyDoc(
    join(PLAN_ROOT, "audit-policy.yaml"),
  );

  test("the committed policy loads cleanly (no degrade reason)", () => {
    expect(realPolicyReason).toBeNull();
    expect(realPolicy).not.toBeNull();
  });

  test("a deep-sized signal set (>=8 tasks, >=2000 diff loc, >=2 repos) → deep, non-degraded", () => {
    expect(
      deriveDepthBand(
        { task_count: 8, diff_lines: 2000, touched_repo_count: 2 },
        realPolicy,
      ),
    ).toEqual({ band: "deep", reasons: [] });
  });

  test("a standard-sized signal set → standard, non-degraded", () => {
    expect(
      deriveDepthBand(
        { task_count: 3, diff_lines: 400, touched_repo_count: 1 },
        realPolicy,
      ),
    ).toEqual({ band: "standard", reasons: [] });
  });

  test("a small signal set → lean, non-degraded (legitimate, not a policy failure)", () => {
    expect(
      deriveDepthBand(
        { task_count: 1, diff_lines: 10, touched_repo_count: 1 },
        realPolicy,
      ),
    ).toEqual({ band: "lean", reasons: [] });
  });
});

// ---------------------------------------------------------------------------
// readAuditPolicyDoc — best-effort policy read, each degrade arm.
// ---------------------------------------------------------------------------

describe("readAuditPolicyDoc (best-effort policy read)", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "planctl-cpf-policy-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("absent file → policy_missing", () => {
    const res = readAuditPolicyDoc(join(dir, "nope.yaml"));
    expect(res.doc).toBeNull();
    expect(res.reason).toBe("policy_missing");
  });

  test("valid YAML mapping → parsed doc, no reason", () => {
    const p = join(dir, "audit-policy.yaml");
    writeFileSync(
      p,
      "depth_bands:\n  - depth: deep\n    min_task_count: 8\n",
      "utf-8",
    );
    const res = readAuditPolicyDoc(p);
    expect(res.reason).toBeNull();
    expect(res.doc).toEqual({
      depth_bands: [{ depth: "deep", min_task_count: 8 }],
    });
  });

  test("syntactically invalid YAML → policy_malformed", () => {
    const p = join(dir, "audit-policy.yaml");
    writeFileSync(p, "depth_bands: [1, 2\n", "utf-8");
    const res = readAuditPolicyDoc(p);
    expect(res.doc).toBeNull();
    expect(res.reason).toBe("policy_malformed");
  });

  test("a non-mapping document (a bare list) → policy_malformed", () => {
    const p = join(dir, "audit-policy.yaml");
    writeFileSync(p, "- a\n- b\n", "utf-8");
    const res = readAuditPolicyDoc(p);
    expect(res.doc).toBeNull();
    expect(res.reason).toBe("policy_malformed");
  });
});

// ---------------------------------------------------------------------------
// Verb-level depth enrichment + degrade arms.
// ---------------------------------------------------------------------------

describe("close-preflight depth enrichment", () => {
  const getProj = withProject("planctl-cpf-depth-");

  function setTaskTier(root: string, taskId: string, tier: string): void {
    const p = join(root, ".keeper", "tasks", `${taskId}.json`);
    const t = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    t.tier = tier;
    writeFileSync(p, JSON.stringify(t, null, 2), "utf-8");
  }

  function setEpicTouchedRepos(
    root: string,
    epicId: string,
    repos: string[],
  ): void {
    const p = join(root, ".keeper", "epics", `${epicId}.json`);
    const e = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    e.touched_repos = repos;
    writeFileSync(p, JSON.stringify(e, null, 2), "utf-8");
  }

  function writeFindingArtifact(
    root: string,
    epicId: string,
    taskId: string,
    content: string,
  ): string {
    const p = join(auditsRoot(root), epicId, "tasks", `${taskId}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf-8");
    return p;
  }

  test("brief carries tier, per-repo diff stats, finding refs, and a depth band; schema unchanged", () => {
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done", "done"]);
    setTaskTier(proj.root, taskIds[0] as string, "xhigh");
    setTaskTier(proj.root, taskIds[1] as string, "low");
    fakeSourceCommit(proj.root, `feat: a\n\nTask: ${taskIds[0]}\n`, {
      numstat: [
        { path: "src/a.ts", insertions: 20, deletions: 5 },
        { path: "src/b.ts", insertions: 10, deletions: 0 },
      ],
    });
    fakeSourceCommit(proj.root, `feat: b\n\nTask: ${taskIds[1]}\n`, {
      numstat: [{ path: "src/c.ts", insertions: 7, deletions: 3 }],
    });
    const findingPath = writeFindingArtifact(
      proj.root,
      epicId,
      taskIds[0] as string,
      JSON.stringify({ status: "open", findings: [{ id: "f1" }] }),
    );

    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const brief = loadBrief(proj.root, epicId);

    // Additive fields only — the audit schema version is unchanged.
    expect(brief.schema_version).toBe(1);

    const briefTasks = brief.tasks as Array<Record<string, unknown>>;
    expect(briefTasks.map((t) => t.tier)).toEqual(["xhigh", "low"]);
    expect(briefTasks[0]?.finding_ref).toEqual({
      path: findingPath,
      status: "open",
    });
    expect(briefTasks[1]?.finding_ref).toBeNull();

    const primary = realpathSync(proj.root);
    // Hand-summed over both source commits in the one repo: insertions
    // 20+10+7, deletions 5+0+3, rows 3, commit_count 2.
    expect(brief.diff_stats_by_repo).toEqual([
      {
        repo: primary,
        commit_count: 2,
        insertions: 37,
        deletions: 8,
        files: 3,
      },
    ]);

    const depth = brief.depth as Record<string, unknown>;
    expect(["lean", "standard", "deep"]).toContain(depth.band);
    expect(depth.signals).toEqual({
      task_count: 2,
      diff_lines: 45,
      touched_repo_count: 1,
    });
    expect(Array.isArray(depth.degrade_reasons)).toBe(true);
    expect(typeof depth.degraded).toBe("boolean");
  });

  test("a numstat git error degrades to lean with the reason; close still succeeds", () => {
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done"]);
    fakeSourceCommit(proj.root, `feat: a\n\nTask: ${taskIds[0]}\n`, {
      numstat: [{ path: "src/a.ts", insertions: 5000, deletions: 5000 }],
    });
    setNumstatError(proj.root, true);

    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const depth = loadBrief(proj.root, epicId).depth as Record<string, unknown>;
    expect(depth.band).toBe("lean");
    expect(depth.degraded).toBe(true);
    const primary = realpathSync(proj.root);
    expect(depth.degrade_reasons).toContain(`numstat_error:${primary}`);
    // The errored read contributes zero churn — never the un-read 10000.
    expect((depth.signals as Record<string, unknown>).diff_lines).toBe(0);
  });

  test("an unreadable finding artifact degrades with a reason; the ref still surfaces", () => {
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done"]);
    writeFindingArtifact(proj.root, epicId, taskIds[0] as string, "{not json");

    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const brief = loadBrief(proj.root, epicId);
    const depth = brief.depth as Record<string, unknown>;
    expect(depth.degraded).toBe(true);
    expect(depth.degrade_reasons).toContain(
      `finding_ref_unreadable:${taskIds[0]}`,
    );
    const briefTasks = brief.tasks as Array<Record<string, unknown>>;
    const ref = briefTasks[0]?.finding_ref as Record<string, unknown>;
    expect(ref.status).toBeNull();
    expect(typeof ref.path).toBe("string");
  });

  test("a deep-sized epic (>=8 done tasks, >=2 touched repos, >=2000 diff loc) stamps a non-degraded deep band", () => {
    const proj = getProj();
    const primary = realpathSync(proj.root);
    const secondary = realpathSync(
      mkdtempSync(join(tmpdir(), "planctl-cpf-depth-secondary-")),
    );
    fakeInitRepo(secondary);

    const { epicId, taskIds } = makeEpic(proj, Array(8).fill("done"));
    setEpicTouchedRepos(proj.root, epicId, [primary, secondary]);
    fakeSourceCommit(proj.root, `feat: big\n\nTask: ${taskIds[0]}\n`, {
      numstat: [{ path: "src/big.ts", insertions: 2000, deletions: 0 }],
    });
    seedCommit(secondary, taskIds[1] as string);

    try {
      const r = runCli(["close-preflight", epicId, "--project", proj.root], {
        cwd: proj.root,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      const depth = loadBrief(proj.root, epicId).depth as Record<
        string,
        unknown
      >;
      expect(depth.band).toBe("deep");
      expect(depth.degraded).toBe(false);
      expect(depth.degrade_reasons).toEqual([]);
    } finally {
      rmSync(secondary, { recursive: true, force: true });
    }
  });
});
