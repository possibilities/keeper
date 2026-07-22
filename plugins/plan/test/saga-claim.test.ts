// Conformance spec for `planctl claim <task_id>` — translated from
// tests/test_claim.py, every node mapped by a source-comment
// (translated | cited | drop-with-reason).
//
// The core claim machinery — the success-envelope fields, brief_ref handle, the
// bad-id / not-found typed errors, the --force matrix (TASK_DONE never bypassed;
// blocked / deps-unmet bypassed; claimed-by-other takeover), and the
// no-commit guarantee — is CITED to verbs-worker.test.ts (the
// test_worker_verbs.py translation). This file owns the test_claim.py-specific
// surface verbs-worker does not cover: the full on-disk brief schema, the
// null-tier worker_agent, repair-on-reclaim brief regeneration, the
// without-force precondition errors, the takeover claim_note, NOT_A_PROJECT, and
// the cwd-agnostic roots-discovery cluster.
//
// claim resolves the owning project via roots discovery, never cwd — so the
// precondition tests pass --project (the verbs-worker idiom) and the resolution
// cluster drives setRoots over fake projects under one root. The
// brief-gitignored node asserts the brief lands under the state/ subtree the fake
// dirty-discovery excludes. The brief-write-failed node is python_only and dropped.

import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";

import { mergeTaskState } from "../src/models.ts";
import {
  fakeDirtyPaths,
  firstJsonPayload,
  gitInit,
  fakeCommand as installCommandFake,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  scaffoldPlanYaml,
  setRoots,
  withProject,
  withTmpdir,
} from "./harness.ts";

const ALICE = { KEEPER_PLAN_ACTOR: "alice@example.com" };
const BOB = { KEEPER_PLAN_ACTOR: "bob@example.com" };

// Error code off an error envelope.
function errCode(out: string): unknown {
  return (parseCliOutput(out).error as Record<string, unknown>).code;
}

// ---------------------------------------------------------------------------
// Happy path: full on-disk brief schema + the content-blind envelope.
// ---------------------------------------------------------------------------

describe("claim happy path + brief schema", () => {
  const getProj = withProject("planctl-claim-");
  const getLane = withTmpdir("planctl-claim-lane-");

  test("envelope is content-blind; brief file carries the full schema", () => {
    // test_claim.py::test_claim_happy_path_envelope
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, {
      title: "Claim epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const keeper = installCommandFake("keeper", {
      stdout: JSON.stringify({
        ok: true,
        kind: "deconflict",
        incident: {
          conflict: {
            instance_event_id: 71,
            attempt_id: 12,
            claim: null,
          },
          grant_ref: "/state/grants/grant-work.json",
        },
      }),
    });

    const r = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: ALICE,
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    expect(payload.task_id).toBe(taskId);
    expect(payload.epic_id).toBe(epicId);
    expect(payload.target_repo).toBeTruthy();
    expect(payload.primary_repo).toBeTruthy();
    expect("tier" in payload).toBe(true);
    // worker_agent still carries the composed cell name, but post-cutover only
    // its null-ness gates /plan:work — which spawns the constant work:worker
    // (the launcher selects the cell via --plugin-dir). The value is vestigial
    // for the spawn; the composition is asserted as the null-gate contract.
    expect(payload.worker_agent).toBe("plan:worker-opus-medium");
    expect("dispatched_model" in payload).toBe(false);
    expect("dispatched_tier" in payload).toBe(false);
    expect("dispatch_constraint" in payload).toBe(false);
    expect(payload.incident).toEqual({
      incident_id: `work::${taskId}`,
      kind: "deconflict",
      instance_event_id: 71,
      attempt_id: 12,
      brief_ref: `work::${taskId}`,
      grant_ref: "/state/grants/grant-work.json",
      claim: null,
    });
    expect(keeper.calls()).toEqual([["escalation-brief", `work::${taskId}`]]);

    const resumed = runCli(["worker", "resume", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(resumed.code).toBe(0);
    const resumePayload = parseCliOutput(resumed.stdout);
    expect("dispatched_model" in resumePayload).toBe(false);
    expect("dispatched_tier" in resumePayload).toBe(false);
    expect("dispatch_constraint" in resumePayload).toBe(false);

    const resolved = runCli(["resolve-task", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(resolved.code).toBe(0);
    const resolvePayload = parseCliOutput(resolved.output);
    expect("dispatched_model" in resolvePayload).toBe(false);
    expect("dispatched_tier" in resolvePayload).toBe(false);
    expect("dispatch_constraint" in resolvePayload).toBe(false);

    const ts = payload.task_state as Record<string, unknown>;
    expect(ts.status).toBe("in_progress");
    expect(ts.assignee).toBe("alice@example.com");
    expect(ts.outcome).toBe("CLAIMED");
    expect((payload.epic_state as Record<string, unknown>).id).toBe(epicId);

    // The three prose fields are GONE from the envelope.
    expect("task_spec_md" in payload).toBe(false);
    expect("epic_spec_md" in payload).toBe(false);
    expect("snippet_context" in payload).toBe(false);

    // brief_ref is absolute, pointing at state/briefs/<task_id>.json.
    const briefRef = payload.brief_ref as string;
    expect(briefRef).toBeTruthy();
    expect(briefRef.startsWith("/")).toBe(true);
    expect(briefRef.endsWith(`${taskId}.json`)).toBe(true);
    expect(existsSync(briefRef)).toBe(true);

    // The on-disk brief parses with the full schema.
    const brief = JSON.parse(readFileSync(briefRef, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(brief.schema_version).toBe(1);
    expect(typeof brief.schema_version).toBe("number");
    expect(brief.generated_at).toBeTruthy();
    expect(brief.task_id).toBe(taskId);
    expect(brief.epic_id).toBe(epicId);
    expect(brief.target_repo).toBe(payload.target_repo);
    expect(brief.primary_repo).toBe(payload.primary_repo);
    // state_repo = epic.primary_repo falling back to repo_root.
    expect(brief.state_repo).toBe(payload.primary_repo);
    expect("tier" in brief).toBe(true);
    expect("task_spec_md" in brief).toBe(true);
    expect("epic_spec_md" in brief).toBe(true);
    // snippet_context is a dormant slot — always present as "".
    expect(brief.snippet_context).toBe("");

    // claim stays readonly — NULL subject/files.
    const inv = payload.plan_invocation as Record<string, unknown>;
    expect(inv.op).toBe("claim");
    expect(inv.subject).toBeNull();
    expect(inv.files).toBeNull();
  });

  test("KEEPER_PLAN_WORKTREE routes target_repo to the lane, plan-state to the primary repo", () => {
    // claim is the FIRST call /plan:work makes and the source of the worker's
    // TARGET_REPO. In worktree mode it MUST honor the lane override (like
    // resolve-task / worker-resume) or the worker cds into the shared main
    // checkout and the lane stays empty. plan STATE (primary_repo) stays primary.
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Claim epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    const lane = getLane();

    const r = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: { ...ALICE, KEEPER_PLAN_WORKTREE: lane },
    });
    expect(r.code).toBe(0);
    // The warning now rides stderr, so parse the JSON off stdout alone.
    const payload = parseCliOutput(r.stdout);
    // target_repo follows the lane...
    expect(payload.target_repo).toBe(lane);
    // ...primary_repo (and the brief's state_repo) stay in the primary repo.
    const mainRepo = realpathSync(proj.root);
    expect(payload.primary_repo).toBe(mainRepo);
    expect(payload.primary_repo).not.toBe(lane);

    const brief = JSON.parse(
      readFileSync(payload.brief_ref as string, "utf-8"),
    ) as Record<string, unknown>;
    expect(brief.target_repo).toBe(lane);
    expect(brief.primary_repo).toBe(mainRepo);
    expect(brief.state_repo).toBe(mainRepo);

    // Gap 2 regression (i) — the canonical production shape: explicit --project
    // from the shared main WITH a KEEPER_PLAN_WORKTREE lane keys the warning on
    // the TARGET (the lane), and --project never suppresses it. The persisted
    // brief and stderr carry the same value.
    const warning = payload.source_staleness_warning as string;
    expect(warning).toContain(lane);
    expect(warning).toContain(mainRepo);
    expect(warning).toContain("may predate");
    expect(brief.source_staleness_warning).toBe(warning);
    expect(r.stderr).toContain("may predate");
  });

  test("null persisted tier -> worker_agent null (claimability is the contract)", () => {
    // test_claim.py::test_claim_null_tier_emits_null_worker_agent
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Claim epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    // Hand-null to simulate a legacy on-disk record.
    const taskPath = join(proj.root, ".keeper", "tasks", `${taskId}.json`);
    const def = JSON.parse(readFileSync(taskPath, "utf-8")) as Record<
      string,
      unknown
    >;
    def.tier = null;
    writeFileSync(taskPath, JSON.stringify(def), "utf-8");

    const r = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: ALICE,
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    expect(payload.tier).toBeNull();
    expect(payload.worker_agent).toBeNull();
  });

  test("brief lands under gitignored state/ — never tracked", () => {
    // test_claim.py::test_claim_brief_file_is_gitignored
    // The inner `.gitignore` excludes `.keeper/state/`; the brief lands there,
    // so it is never tracked. The fake's dirty-discovery mirrors that exclusion
    // (state/ is skipped), so the brief never shows up dirty.
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Claim epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const r = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: ALICE,
    });
    expect(r.code).toBe(0);
    const briefRef = parseCliOutput(r.output).brief_ref as string;
    expect(existsSync(briefRef)).toBe(true);
    // The brief lives under the gitignored state/ subtree.
    expect(
      briefRef.includes(`${sep}.keeper${sep}state${sep}briefs${sep}`),
    ).toBe(true);
    // The fake dirty-discovery (mirroring the inner .gitignore) never reports it.
    expect(fakeDirtyPaths(proj.root).some((p) => p.startsWith("state/"))).toBe(
      false,
    );
  });

  test("ALREADY_MINE re-claim regenerates a missing brief (repair-on-reclaim)", () => {
    // test_claim.py::test_claim_already_mine_regenerates_brief
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Claim epic", nTasks: 1 });
    const taskId = taskIds[0] as string;

    const r1 = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: ALICE,
    });
    expect(r1.code).toBe(0);
    const briefRef = parseCliOutput(r1.output).brief_ref as string;
    unlinkSync(briefRef);
    expect(existsSync(briefRef)).toBe(false);

    const r2 = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: ALICE,
    });
    expect(r2.code).toBe(0);
    const payload2 = parseCliOutput(r2.output);
    expect((payload2.task_state as Record<string, unknown>).outcome).toBe(
      "ALREADY_MINE",
    );
    expect(existsSync(briefRef)).toBe(true);
    expect(payload2.brief_ref).toBe(briefRef);
  });
});

// ---------------------------------------------------------------------------
// Dispatched-cell runtime capture — the KEEPER_PLAN_DISPATCHED_* contract
// shared with the dispatch seam.
// ---------------------------------------------------------------------------

describe("claim captures the dispatched cell", () => {
  const getProj = withProject("planctl-claim-dispatched-");

  function runtimeStatePath(root: string, taskId: string): string {
    return join(root, ".keeper", "state", "tasks", `${taskId}.state.json`);
  }

  function readRuntime(root: string, taskId: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(runtimeStatePath(root, taskId), "utf-8"),
    ) as Record<string, unknown>;
  }

  function taskDef(root: string, taskId: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(root, ".keeper", "tasks", `${taskId}.json`), "utf-8"),
    ) as Record<string, unknown>;
  }

  test("non-empty constraint env lands all three runtime keys", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Claim epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    const defBefore = taskDef(proj.root, taskId);

    const r = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: {
        ...ALICE,
        KEEPER_PLAN_DISPATCHED_MODEL: "sonnet",
        KEEPER_PLAN_DISPATCHED_TIER: "low",
        KEEPER_PLAN_DISPATCH_CONSTRAINT: "worker_provider=claude",
      },
    });
    expect(r.code).toBe(0);

    const runtime = readRuntime(proj.root, taskId);
    expect(runtime.dispatched_model).toBe("sonnet");
    expect(runtime.dispatched_tier).toBe("low");
    expect(runtime.dispatch_constraint).toBe("worker_provider=claude");

    // Merged reads surface the dispatched_* keys — mergeTaskState round-trips
    // the unknown runtime keys through normalizeTask untouched.
    const merged = mergeTaskState(taskDef(proj.root, taskId), runtime);
    expect(merged.dispatched_model).toBe("sonnet");
    expect(merged.dispatched_tier).toBe("low");
    expect(merged.dispatch_constraint).toBe("worker_provider=claude");

    const payload = parseCliOutput(r.output);
    expect(payload.dispatched_model).toBe("sonnet");
    expect(payload.dispatched_tier).toBe("low");
    expect(payload.dispatch_constraint).toBe("worker_provider=claude");
    const briefRef = payload.brief_ref as string;
    expect(existsSync(briefRef)).toBe(true);

    const resumed = runCli(["worker", "resume", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(resumed.code).toBe(0);
    const resumePayload = parseCliOutput(resumed.stdout);
    expect(resumePayload.dispatched_model).toBe("sonnet");
    expect(resumePayload.dispatched_tier).toBe("low");
    expect(resumePayload.dispatch_constraint).toBe("worker_provider=claude");

    const resolved = runCli(["resolve-task", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(resolved.code).toBe(0);
    const resolvePayload = parseCliOutput(resolved.output);
    expect(resolvePayload.dispatched_model).toBe("sonnet");
    expect(resolvePayload.dispatched_tier).toBe("low");
    expect(resolvePayload.dispatch_constraint).toBe("worker_provider=claude");

    // The definition cells (task.model / task.tier) and the selection sidecar
    // never change.
    const defAfter = taskDef(proj.root, taskId);
    expect(defAfter.model).toBe(defBefore.model);
    expect(defAfter.tier).toBe(defBefore.tier);
  });

  test("an ALREADY_MINE re-claim preserves the prior dispatched cell", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Claim epic", nTasks: 1 });
    const taskId = taskIds[0] as string;

    const r1 = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: {
        ...ALICE,
        KEEPER_PLAN_DISPATCHED_MODEL: "sonnet",
        KEEPER_PLAN_DISPATCHED_TIER: "low",
        KEEPER_PLAN_DISPATCH_CONSTRAINT: "worker_provider=claude",
      },
    });
    expect(r1.code).toBe(0);
    expect(readRuntime(proj.root, taskId).dispatched_model).toBe("sonnet");

    const r2 = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: ALICE,
    });
    expect(r2.code).toBe(0);
    expect(
      (parseCliOutput(r2.output).task_state as Record<string, unknown>).outcome,
    ).toBe("ALREADY_MINE");

    const runtime = readRuntime(proj.root, taskId);
    expect(runtime.dispatched_model).toBe("sonnet");
    expect(runtime.dispatched_tier).toBe("low");
    expect(runtime.dispatch_constraint).toBe("worker_provider=claude");
    const payload = parseCliOutput(r2.output);
    expect(payload.dispatched_model).toBe("sonnet");
    expect(payload.dispatched_tier).toBe("low");
    expect(payload.dispatch_constraint).toBe("worker_provider=claude");
  });

  test("empty-string constraint env is treated as absent (clears, not writes)", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Claim epic", nTasks: 1 });
    const taskId = taskIds[0] as string;

    const r = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: {
        ...ALICE,
        KEEPER_PLAN_DISPATCHED_MODEL: "",
        KEEPER_PLAN_DISPATCHED_TIER: "",
        KEEPER_PLAN_DISPATCH_CONSTRAINT: "",
      },
    });
    expect(r.code).toBe(0);
    const runtime = readRuntime(proj.root, taskId);
    expect("dispatched_model" in runtime).toBe(false);
    expect("dispatched_tier" in runtime).toBe(false);
    expect("dispatch_constraint" in runtime).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Typed errors test_claim.py owns beyond the verbs-worker citations.
// ---------------------------------------------------------------------------

describe("claim typed errors (test_claim-specific)", () => {
  const getProj = withProject("planctl-claim-err-");

  // test_claim.py::test_claim_bad_task_id        -> CITED verbs-worker.test.ts "bad task id"
  // test_claim.py::test_claim_task_not_found     -> CITED verbs-worker.test.ts "task not found"
  // test_claim.py::test_claim_task_done          -> CITED verbs-worker.test.ts
  //   "TASK_DONE is never bypassed, even with --force"
  // test_claim.py::test_claim_task_done_force_does_not_override -> CITED (same node, both
  //   force/no-force arms asserted in the verbs-worker test_claim_task_done_never_bypassed loop)
  // test_claim.py::test_claim_blocked_bypassed_by_force -> CITED verbs-worker.test.ts
  //   "TASK_BLOCKED then --force bypasses"
  // test_claim.py::test_claim_deps_unmet_bypassed_by_force -> CITED verbs-worker.test.ts
  //   "DEPS_UNMET names the unmet dep then --force bypasses"
  // test_claim.py::test_claim_by_other_errors -> CITED verbs-worker.test.ts
  //   "CLAIMED_BY_OTHER then --force takes over" (the CLAIMED_BY_OTHER error arm)

  test("--project at a non-project dir -> NOT_A_PROJECT", () => {
    // test_claim.py::test_claim_not_a_project
    const proj = getProj();
    const bare = join(proj.root, "bare");
    mkdirSync(bare, { recursive: true });
    const r = runCli(["claim", "fn-1-x.1", "--project", bare], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(errCode(r.output)).toBe("NOT_A_PROJECT");
  });

  test("blocked task without --force -> TASK_BLOCKED", () => {
    // test_claim.py::test_claim_task_blocked
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Claim epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    const b = runCli(["block", taskId, "--reason", "waiting"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(b.code).toBe(0);

    const r = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(errCode(r.output)).toBe("TASK_BLOCKED");
  });

  test("deps unmet without --force -> DEPS_UNMET names the unmet dep", () => {
    // test_claim.py::test_claim_deps_unmet
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Deps epic",
      nTasks: 2,
      taskDeps: { 2: [1] },
    });
    const [t1, t2] = taskIds as [string, string];

    const r = runCli(["claim", t2, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: ALICE,
    });
    expect(r.code).not.toBe(0);
    expect(errCode(r.output)).toBe("DEPS_UNMET");
    const details = (parseCliOutput(r.output).error as Record<string, unknown>)
      .details as Record<string, unknown>;
    expect(details.unmet).toEqual([t1]);
  });
});

// ---------------------------------------------------------------------------
// CAS outcomes test_claim.py owns beyond the verbs-worker citations.
// ---------------------------------------------------------------------------

describe("claim CAS outcomes (test_claim-specific)", () => {
  const getProj = withProject("planctl-claim-cas-");

  test("ALREADY_MINE is idempotent — preserves claimed_at", () => {
    // test_claim.py::test_claim_already_mine_idempotent
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Claim epic", nTasks: 1 });
    const taskId = taskIds[0] as string;

    const r1 = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: ALICE,
    });
    expect(r1.code).toBe(0);
    const first = parseCliOutput(r1.output).task_state as Record<
      string,
      unknown
    >;
    expect(first.outcome).toBe("CLAIMED");
    const firstClaimedAt = first.claimed_at;

    const r2 = runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: ALICE,
    });
    expect(r2.code).toBe(0);
    const second = parseCliOutput(r2.output);
    expect(second.success).toBe(true);
    const ts2 = second.task_state as Record<string, unknown>;
    expect(ts2.outcome).toBe("ALREADY_MINE");
    expect(ts2.claimed_at).toBe(firstClaimedAt);
  });

  test("--force takeover reassigns + records the takeover claim_note", () => {
    // test_claim.py::test_claim_force_takeover
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Claim epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    runCli(["claim", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: ALICE,
    });

    const r = runCli(["claim", taskId, "--project", proj.root, "--force"], {
      cwd: proj.root,
      home: proj.home,
      env: BOB,
    });
    expect(r.code).toBe(0);
    const ts = parseCliOutput(r.output).task_state as Record<string, unknown>;
    expect(ts.assignee).toBe("bob@example.com");
    expect(ts.outcome).toBe("CLAIMED");
    expect(
      (ts.claim_note as string).includes("Taken over from alice@example.com"),
    ).toBe(true);
  });

  // test_claim.py::test_claim_brief_write_failed_leaves_in_progress
  //   -> DROP (python_only): monkeypatches planctl.brief.write_brief to raise an
  //      OSError mid-claim — an in-process injection that cannot cross the
  //      subprocess boundary. The repair-on-reclaim recovery it proves (state
  //      write survives a failed brief write, re-claim regenerates the brief) is
  //      covered behaviorally by "ALREADY_MINE re-claim regenerates a missing
  //      brief" above.
});

// ---------------------------------------------------------------------------
// Cwd-agnostic project resolution via real roots discovery.
// ---------------------------------------------------------------------------

describe("claim roots discovery", () => {
  const getRoot = withTmpdir("planctl-claim-root-");
  const getHome = withTmpdir("planctl-claim-home-");
  const getElsewhere = withTmpdir("planctl-claim-elsewhere-");

  // git+planctl init a project at `proj`, scaffold an epic+task, return the task
  // id. Mirrors _init_project_with_task.
  function initProjectWithTask(proj: string, home: string): string {
    mkdirSync(proj, { recursive: true });
    gitInit(proj);
    const init = runCli(["init"], { cwd: proj, home, env: ALICE });
    if (init.code !== 0) {
      throw new Error(`init failed in ${proj}:\n${init.output}`);
    }
    const planPath = join(proj, "_seed_plan.yaml");
    writeFileSync(
      planPath,
      scaffoldPlanYaml({ title: "Discovery epic", nTasks: 1 }),
      "utf-8",
    );
    const sc = runCli(["scaffold", "--file", planPath], {
      cwd: proj,
      home,
      env: ALICE,
    });
    if (sc.code !== 0) {
      throw new Error(`scaffold failed in ${proj}:\n${sc.output}`);
    }
    return (firstJsonPayload(sc.output).task_ids as string[])[0] as string;
  }

  test("zero-arg claim resolves the owning project via roots, not cwd", () => {
    // test_claim.py::test_claim_zero_arg_resolves_non_cwd_project
    const root = getRoot();
    const home = getHome();
    const proj = join(root, "alpha");
    const taskId = initProjectWithTask(proj, home);
    setRoots(home, [root]);

    // Run from an unrelated cwd — discovery, not cwd, locates the project.
    const r = runCli(["claim", taskId], {
      cwd: getElsewhere(),
      home,
      env: ALICE,
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    expect(payload.task_id).toBe(taskId);
    expect((payload.task_state as Record<string, unknown>).status).toBe(
      "in_progress",
    );
    expect((payload.target_repo as string).includes(realpathSync(proj))).toBe(
      true,
    );
  });

  test("--project bypasses discovery even when roots exclude it", () => {
    // test_claim.py::test_claim_project_override_bypasses_discovery
    const root = getRoot();
    const home = getHome();
    const proj = join(root, "out-of-roots", "alpha");
    const taskId = initProjectWithTask(proj, home);
    // Roots point somewhere that does NOT contain the project.
    const emptyRoot = join(root, "empty-root");
    mkdirSync(emptyRoot, { recursive: true });
    setRoots(home, [emptyRoot]);

    const r = runCli(["claim", taskId, "--project", proj], {
      cwd: emptyRoot,
      home,
      env: ALICE,
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.task_id).toBe(taskId);
    expect((payload.task_state as Record<string, unknown>).status).toBe(
      "in_progress",
    );
  });

  test("--project at a real project missing the task -> TASK_NOT_FOUND", () => {
    // test_claim.py::test_claim_project_override_task_not_found
    const root = getRoot();
    const home = getHome();
    const proj = join(root, "alpha");
    initProjectWithTask(proj, home);
    const r = runCli(["claim", "fn-999-absent.1", "--project", proj], {
      cwd: proj,
      home,
    });
    expect(r.code).not.toBe(0);
    expect(errCode(r.output)).toBe("TASK_NOT_FOUND");
  });

  // Copy alpha's epic + task JSON/spec into beta so the same id collides.
  function collideInto(projA: string, projB: string, taskId: string): void {
    const epicId = taskId.slice(0, taskId.lastIndexOf("."));
    for (const [sub, name] of [
      ["epics", `${epicId}.json`],
      ["tasks", `${taskId}.json`],
      ["specs", `${epicId}.md`],
      ["specs", `${taskId}.md`],
    ] as const) {
      const src = join(projA, ".keeper", sub, name);
      if (existsSync(src)) {
        const dst = join(projB, ".keeper", sub, name);
        mkdirSync(join(dst, ".."), { recursive: true });
        copyFileSync(src, dst);
      }
    }
  }

  test("same claimable id in two projects -> AMBIGUOUS_TASK_ID; --project resolves", () => {
    // test_claim.py::test_claim_ambiguous_task_id
    const root = getRoot();
    const home = getHome();
    const projA = join(root, "alpha");
    const projB = join(root, "beta");
    const taskId = initProjectWithTask(projA, home);
    initProjectWithTask(projB, home);
    collideInto(projA, projB, taskId);
    setRoots(home, [root]);

    const r = runCli(["claim", taskId], { cwd: root, home, env: ALICE });
    expect(r.code).not.toBe(0);
    expect(errCode(r.output)).toBe("AMBIGUOUS_TASK_ID");
    const candidates = (
      (parseCliOutput(r.output).error as Record<string, unknown>)
        .details as Record<string, unknown>
    ).candidates as string[];
    expect(candidates).toContain(realpathSync(projA));
    expect(candidates).toContain(realpathSync(projB));

    // The --project escape hatch resolves the ambiguity.
    const r2 = runCli(["claim", taskId, "--project", projA], {
      cwd: root,
      home,
      env: ALICE,
    });
    expect(r2.code).toBe(0);
  });

  test("ambiguity resolved silently when only one project is claimable", () => {
    // test_claim.py::test_claim_ambiguous_resolved_by_claimable_filter
    const root = getRoot();
    const home = getHome();
    const projA = join(root, "alpha");
    const projB = join(root, "beta");
    const taskId = initProjectWithTask(projA, home);
    initProjectWithTask(projB, home);
    collideInto(projA, projB, taskId);
    // Mark beta's epic closed → not claimable there.
    const epicId = taskId.slice(0, taskId.lastIndexOf("."));
    const betaEpic = join(projB, ".keeper", "epics", `${epicId}.json`);
    const ep = JSON.parse(readFileSync(betaEpic, "utf-8")) as Record<
      string,
      unknown
    >;
    ep.status = "closed";
    writeFileSync(betaEpic, JSON.stringify(ep), "utf-8");
    setRoots(home, [root]);

    const r = runCli(["claim", taskId], { cwd: root, home, env: ALICE });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect((payload.task_state as Record<string, unknown>).status).toBe(
      "in_progress",
    );
    expect((payload.target_repo as string).includes(realpathSync(projA))).toBe(
      true,
    );
  });
});
