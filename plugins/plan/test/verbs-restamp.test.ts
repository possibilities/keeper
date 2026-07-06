// Engine-agnostic conformance spec for the integrity-gate mutating verbs — the
// mutating-side companion to verbs-query. Each structural verb runs its post-write
// integrity gate but leaves last_validated_at an arm-exclusive one-way latch: a
// ghost stays a ghost and an armed marker stays byte-identical (only the trailing
// `validate --epic` arm flips null→timestamp). Covers the setters (set-description
// / set-acceptance from file AND stdin, reset incl. --cascade, set-target-repo's
// touched_repos recompute, the warn-and-write set-primary-repo / set-touched-repos),
// the plain non-gate setters (set-branch, set-title), the short-circuiting
// invalidate paths (invalidate / refine-context --invalidate), the dep editors
// (add-dep fn-N normalization, cross-project via roots, cycle rollback, idempotent
// rm-dep), add-deps (skip-invalid statuses, error priority), mv-repo, and the
// fail-forward integrity failure.
//
// Every fixture is seedState + gitBaseline; commit subjects + two-file scope read
// off git log. Assertions on envelopes, .keeper/ files, git — never internals.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { atomicWriteJson, loadJson } from "../src/store.ts";
import {
  gitBaseline,
  gitFilesInHead,
  gitHeadMessage,
  gitLogCount,
  parseCliOutput,
  runCli,
  seedRuntime,
  seedState,
  setRoots,
  withTmpdir,
} from "./harness.ts";

const SID = { CLAUDE_CODE_SESSION_ID: "test-restamp-verbs" };
const FROZEN = "2026-06-06T00:00:00.000000Z";
const STALE = "2026-01-01T00:00:00.000000Z";

function epicDef(root: string, epicId: string): Record<string, unknown> {
  return loadJson(join(root, ".keeper", "epics", `${epicId}.json`));
}
function taskDef(root: string, taskId: string): Record<string, unknown> {
  return loadJson(join(root, ".keeper", "tasks", `${taskId}.json`));
}
function specText(root: string, specId: string): string {
  return readFileSync(join(root, ".keeper", "specs", `${specId}.md`), "utf-8");
}
function runtime(root: string, taskId: string): Record<string, unknown> | null {
  const p = join(root, ".keeper", "state", "tasks", `${taskId}.state.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
}
// Head commit subject (%s). The harness exposes gitHeadMessage (%B) — take its
// first line for the subject.
function headSubject(root: string): string {
  return gitHeadMessage(root).split("\n")[0] as string;
}
// Overwrite last_validated_at directly on the epic JSON (the _stamp_marker seam).
function stampMarker(root: string, epicId: string, value: unknown): void {
  const p = join(root, ".keeper", "epics", `${epicId}.json`);
  const ed = loadJson(p);
  ed.last_validated_at = value;
  atomicWriteJson(p, ed);
}
// First JSON object that is not the sole-key invocation trailer, tolerant of a
// trailing stderr WARN line. Port of _first_obj.
function firstObj(output: string): Record<string, unknown> {
  let i = 0;
  while (i < output.length) {
    if (output[i] !== "{") {
      i += 1;
      continue;
    }
    for (let end = output.length; end > i; end--) {
      if (output[end - 1] !== "}") {
        continue;
      }
      try {
        const v = JSON.parse(output.slice(i, end));
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const keys = Object.keys(v);
          if (!(keys.length === 1 && keys[0] === "plan_invocation")) {
            return v as Record<string, unknown>;
          }
        }
      } catch {
        // shrink
      }
    }
    i += 1;
  }
  throw new Error(`no JSON object in output:\n${output}`);
}

let root: string;
const getTmp = withTmpdir("planctl-restamp-");
beforeEach(() => {
  root = getTmp();
});

// ---------------------------------------------------------------------------
// set-description / set-acceptance — section patch, ghost stays a ghost (file + stdin)
// ---------------------------------------------------------------------------

describe("set-description / set-acceptance leave the ghost null", () => {
  test("set-description from --file patches without arming the ghost", () => {
    // test_restamp_verbs.py::test_set_description_from_file_patches_and_restamps
    seedState(root, { epicId: "fn-1-sd", nTasks: 1 });
    expect(epicDef(root, "fn-1-sd").last_validated_at).toBeNull();
    const descFile = join(root, "desc.md");
    writeFileSync(descFile, "brand new description body\n");

    const r = runCli(
      ["task", "set-description", "fn-1-sd.1", "--file", descFile],
      {
        cwd: root,
        env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
      },
    );
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.task_id).toBe("fn-1-sd.1");
    expect(payload.section).toBe("Description");
    expect(specText(root, "fn-1-sd.1")).toContain("brand new description body");
    expect(epicDef(root, "fn-1-sd").last_validated_at).toBeNull();
  });

  test("set-acceptance from stdin patches without arming the ghost", () => {
    // test_restamp_verbs.py::test_set_acceptance_from_stdin_patches_and_restamps
    seedState(root, { epicId: "fn-1-sa", nTasks: 1 });
    const r = runCli(["task", "set-acceptance", "fn-1-sa.1"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
      input: "- [ ] new criterion from stdin\n",
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).section).toBe("Acceptance");
    expect(specText(root, "fn-1-sa.1")).toContain("new criterion from stdin");
    expect(epicDef(root, "fn-1-sa").last_validated_at).toBeNull();
  });

  test("set-description commit subject", () => {
    // test_restamp_verbs.py::test_set_description_commit_subject
    seedState(root, { epicId: "fn-2-sd", nTasks: 1 });
    gitBaseline(root);
    const before = gitLogCount(root);
    const r = runCli(["task", "set-description", "fn-2-sd.1"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
      input: "body\n",
    });
    expect(r.code).toBe(0);
    expect(gitLogCount(root)).toBe(before + 1);
    expect(headSubject(root)).toBe("chore(plan): set-description fn-2-sd.1");
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("reset", () => {
  test("clears runtime + spec + worker_done_at, ghost stays null", () => {
    // test_restamp_verbs.py::test_reset_clears_runtime_and_spec_and_done_stamp
    seedState(root, { epicId: "fn-1-rst", nTasks: 1 });
    seedRuntime(root, "fn-1-rst.1", {
      status: "done",
      assignee: "test@example.com",
    });
    const tp = join(root, ".keeper", "tasks", "fn-1-rst.1.json");
    const td = loadJson(tp);
    td.worker_done_at = STALE;
    atomicWriteJson(tp, td);
    writeFileSync(
      join(root, ".keeper", "specs", "fn-1-rst.1.md"),
      "## Description\nx\n\n## Acceptance\n- [ ] x\n\n" +
        "## Done summary\nall shipped\n\n## Evidence\nlots\n",
    );

    const r = runCli(["task", "reset", "fn-1-rst.1"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    expect(
      (runtime(root, "fn-1-rst.1") as Record<string, unknown>).status,
    ).toBe("todo");
    expect(taskDef(root, "fn-1-rst.1").worker_done_at).toBeNull();
    const spec = specText(root, "fn-1-rst.1");
    expect(spec).not.toContain("all shipped");
    expect(spec).not.toContain("lots");
    expect(epicDef(root, "fn-1-rst").last_validated_at).toBeNull();
  });

  test("--cascade resets dependents", () => {
    // test_restamp_verbs.py::test_reset_cascade_resets_dependents
    seedState(root, { epicId: "fn-2-rst", nTasks: 2, taskDeps: { 2: [1] } });
    for (const tid of ["fn-2-rst.1", "fn-2-rst.2"]) {
      seedRuntime(root, tid, { status: "done", assignee: "test@example.com" });
    }
    const r = runCli(["task", "reset", "fn-2-rst.1", "--cascade"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).cascade_reset).toEqual(["fn-2-rst.2"]);
    expect(
      (runtime(root, "fn-2-rst.1") as Record<string, unknown>).status,
    ).toBe("todo");
    expect(
      (runtime(root, "fn-2-rst.2") as Record<string, unknown>).status,
    ).toBe("todo");
  });
});

// ---------------------------------------------------------------------------
// set-target-repo — touched_repos recompute + two-file commit
// ---------------------------------------------------------------------------

describe("set-target-repo", () => {
  test("recomputes touched_repos, ghost stays null", () => {
    // test_restamp_verbs.py::test_set_target_repo_recomputes_touched_repos
    const repoA = realpathSync(mkdirRepo(join(root, "repo_a")));
    const repoB = realpathSync(mkdirRepo(join(root, "repo_b")));
    seedState(root, { epicId: "fn-1-str", nTasks: 2, primaryRepo: repoA });

    const r = runCli(
      ["task", "set-target-repo", "fn-1-str.1", "--path", repoB],
      { cwd: root, env: { ...SID, KEEPER_PLAN_NOW: FROZEN } },
    );
    expect(r.code).toBe(0);
    expect(taskDef(root, "fn-1-str.1").target_repo).toBe(repoB);
    const epic = epicDef(root, "fn-1-str");
    expect(epic.touched_repos).toEqual([repoA, repoB].sort());
    expect(epic.last_validated_at).toBeNull();
  });

  test("commit scopes the task JSON + epic JSON in one commit", () => {
    // test_restamp_verbs.py::test_set_target_repo_commit_scopes_two_files
    const repoB = realpathSync(mkdirRepo(join(root, "repo_b")));
    seedState(root, { epicId: "fn-2-str", nTasks: 1, primaryRepo: root });
    mkdirSync(join(root, ".git"), { recursive: true });
    gitBaseline(root);

    const before = gitLogCount(root);
    const r = runCli(
      ["task", "set-target-repo", "fn-2-str.1", "--path", repoB],
      { cwd: root, env: SID },
    );
    expect(r.code).toBe(0);
    expect(gitLogCount(root)).toBe(before + 1);
    expect(headSubject(root)).toBe("chore(plan): set-target-repo fn-2-str.1");
    const files = new Set(gitFilesInHead(root));
    expect(files.has(".keeper/tasks/fn-2-str.1.json")).toBe(true);
    expect(files.has(".keeper/epics/fn-2-str.json")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// set-primary-repo / set-touched-repos — warn-and-write
// ---------------------------------------------------------------------------

describe("set-primary-repo / set-touched-repos", () => {
  test("set-primary-repo valid, ghost stays null", () => {
    // test_restamp_verbs.py::test_set_primary_repo_valid_restamps
    const repo = realpathSync(mkdirRepo(join(root, "real_repo")));
    seedState(root, { epicId: "fn-1-spr", nTasks: 1, primaryRepo: root });
    mkdirSync(join(root, ".git"), { recursive: true });

    const r = runCli(["epic", "set-primary-repo", "fn-1-spr", "--path", repo], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.primary_repo).toBe(repo);
    expect(payload.warnings).toEqual([]);
    expect(epicDef(root, "fn-1-spr").last_validated_at).toBeNull();
  });

  test("set-touched-repos bad path warns and still writes", () => {
    // test_restamp_verbs.py::test_set_touched_repos_bad_path_warns_and_writes
    const missing = realpathSync(mkdirRepo(join(root, "not_a_repo"), false));
    seedState(root, { epicId: "fn-1-stp", nTasks: 1, primaryRepo: root });
    mkdirSync(join(root, ".git"), { recursive: true });

    const r = runCli(
      ["epic", "set-touched-repos", "fn-1-stp", "--paths", missing],
      {
        cwd: root,
        env: SID,
      },
    );
    expect(r.code).toBe(0);
    expect(r.output).toContain("WARN:");
    const payload = firstObj(r.output);
    expect(payload.touched_repos).toEqual([missing]);
    expect((payload.warnings as unknown[]).length).toBe(1);
    expect(epicDef(root, "fn-1-stp").touched_repos).toEqual([missing]);
  });
});

// ---------------------------------------------------------------------------
// mv-repo — board-wide path rewrite for a renamed repo (one commit)
// ---------------------------------------------------------------------------

describe("mv-repo", () => {
  test("rewrites primary_repo + target_repo + touched_repos in one commit", () => {
    // Seed with the OLD repo path on disk so the seeded canonical strings match
    // what mv-repo canonicalizes; rename old -> new on disk, then rewrite.
    const oldRepo = realpathSync(mkdirRepo(join(root, "r_old")));
    seedState(root, { epicId: "fn-1-mv", nTasks: 2, primaryRepo: oldRepo });
    // touched_repos defaults to null; set it explicitly to exercise the rewrite.
    const ep = join(root, ".keeper", "epics", "fn-1-mv.json");
    const ed = loadJson(ep);
    ed.touched_repos = [oldRepo];
    atomicWriteJson(ep, ed);
    mkdirSync(join(root, ".git"), { recursive: true });
    gitBaseline(root);

    // The rename: old dir gone, new dir is a real git repo.
    const newRepo = realpathSync(mkdirRepo(join(root, "r_new")));
    rmSync(join(root, "r_old"), { recursive: true, force: true });

    const before = gitLogCount(root);
    const r = runCli(["mv-repo", oldRepo, newRepo], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r.code).toBe(0);

    expect(epicDef(root, "fn-1-mv").primary_repo).toBe(newRepo);
    expect(epicDef(root, "fn-1-mv").touched_repos).toEqual([newRepo]);
    expect(taskDef(root, "fn-1-mv.1").target_repo).toBe(newRepo);
    expect(taskDef(root, "fn-1-mv.2").target_repo).toBe(newRepo);
    expect(epicDef(root, "fn-1-mv").last_validated_at).toBeNull();

    // Exactly one commit, scoping every rewritten file.
    expect(gitLogCount(root)).toBe(before + 1);
    expect(headSubject(root)).toBe(`chore(plan): mv-repo ${newRepo}`);
    const files = new Set(gitFilesInHead(root));
    expect(files.has(".keeper/epics/fn-1-mv.json")).toBe(true);
    expect(files.has(".keeper/tasks/fn-1-mv.1.json")).toBe(true);
    expect(files.has(".keeper/tasks/fn-1-mv.2.json")).toBe(true);
  });

  test("idempotent re-run is a no-op (zero commits)", () => {
    const oldRepo = realpathSync(mkdirRepo(join(root, "r_old2")));
    seedState(root, { epicId: "fn-2-mv", nTasks: 1, primaryRepo: oldRepo });
    mkdirSync(join(root, ".git"), { recursive: true });
    gitBaseline(root);
    const newRepo = realpathSync(mkdirRepo(join(root, "r_new2")));
    rmSync(join(root, "r_old2"), { recursive: true, force: true });

    const first = runCli(["mv-repo", oldRepo, newRepo], {
      cwd: root,
      env: SID,
    });
    expect(first.code).toBe(0);
    expect(epicDef(root, "fn-2-mv").primary_repo).toBe(newRepo);
    const afterFirst = gitLogCount(root);

    // Nothing matches <old> anymore — a re-run rewrites nothing.
    const second = runCli(["mv-repo", oldRepo, newRepo], {
      cwd: root,
      env: SID,
    });
    expect(second.code).toBe(0);
    expect(firstObj(second.output).rewritten_epics).toEqual([]);
    expect(firstObj(second.output).rewritten_tasks).toEqual([]);
    expect(gitLogCount(root)).toBe(afterFirst);
    expect(epicDef(root, "fn-2-mv").primary_repo).toBe(newRepo);
  });

  test("old == new after canonicalize is a no-op (zero commits)", () => {
    const repo = realpathSync(mkdirRepo(join(root, "r_same")));
    seedState(root, { epicId: "fn-3-mv", nTasks: 1, primaryRepo: repo });
    mkdirSync(join(root, ".git"), { recursive: true });
    gitBaseline(root);
    const before = gitLogCount(root);

    const r = runCli(["mv-repo", repo, repo], { cwd: root, env: SID });
    expect(r.code).toBe(0);
    expect(firstObj(r.output).rewritten_epics).toEqual([]);
    expect(gitLogCount(root)).toBe(before);
    expect(epicDef(root, "fn-3-mv").primary_repo).toBe(repo);
  });

  test("refuses loudly when <new> is not a git repo", () => {
    const oldRepo = realpathSync(mkdirRepo(join(root, "r_old3")));
    seedState(root, { epicId: "fn-4-mv", nTasks: 1, primaryRepo: oldRepo });
    mkdirSync(join(root, ".git"), { recursive: true });
    // <new> exists but has no .git/.
    const notRepo = realpathSync(mkdirRepo(join(root, "r_new3"), false));

    const r = runCli(["mv-repo", oldRepo, notRepo], { cwd: root, env: SID });
    expect(r.code).toBe(1);
    expect(parseCliOutput(r.output).success).toBe(false);
    expect(parseCliOutput(r.output).error as string).toContain(
      "contains no .git/",
    );
    // Refused before any write — primary_repo unchanged.
    expect(epicDef(root, "fn-4-mv").primary_repo).toBe(oldRepo);
  });

  test("mixed batch: armed marker byte-identical, ghost stays null", () => {
    // Two epics on the same old repo — one armed, one a ghost. mv-repo rewrites
    // both paths and gates both, but the arm-exclusive latch leaves each marker
    // exactly as it was: the armed value byte-identical, the ghost still null.
    const oldRepo = realpathSync(mkdirRepo(join(root, "r_old5")));
    seedState(root, { epicId: "fn-5-mv", nTasks: 1, primaryRepo: oldRepo });
    seedState(root, { epicId: "fn-6-mv", nTasks: 1, primaryRepo: oldRepo });
    const armedTs = "2020-03-03T03:03:03.000000Z";
    stampMarker(root, "fn-5-mv", armedTs);
    expect(epicDef(root, "fn-6-mv").last_validated_at).toBeNull();
    mkdirSync(join(root, ".git"), { recursive: true });
    gitBaseline(root);
    const newRepo = realpathSync(mkdirRepo(join(root, "r_new5")));
    rmSync(join(root, "r_old5"), { recursive: true, force: true });

    const r = runCli(["mv-repo", oldRepo, newRepo], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    // Both paths rewrote...
    expect(epicDef(root, "fn-5-mv").primary_repo).toBe(newRepo);
    expect(epicDef(root, "fn-6-mv").primary_repo).toBe(newRepo);
    // ...but each marker is preserved independently.
    expect(epicDef(root, "fn-5-mv").last_validated_at).toBe(armedTs);
    expect(epicDef(root, "fn-6-mv").last_validated_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// set-branch / set-title — plain writes, no integrity gate
// ---------------------------------------------------------------------------

describe("plain setters (no integrity gate)", () => {
  test("set-branch plain write, marker stays null", () => {
    // test_restamp_verbs.py::test_set_branch_plain_write_no_restamp
    seedState(root, { epicId: "fn-1-br", nTasks: 1 });
    const r = runCli(["epic", "set-branch", "fn-1-br", "--branch", "feat/x"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect(epicDef(root, "fn-1-br").branch_name).toBe("feat/x");
    expect(epicDef(root, "fn-1-br").last_validated_at).toBeNull();
  });

  test("set-title plain write", () => {
    // test_restamp_verbs.py::test_set_title_plain_write
    seedState(root, { epicId: "fn-1-tl", title: "Old", nTasks: 1 });
    const r = runCli(["epic", "set-title", "fn-1-tl", "--title", "New Name"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect(epicDef(root, "fn-1-tl").title).toBe("New Name");
  });
});

// ---------------------------------------------------------------------------
// epic invalidate — short-circuit / write
// ---------------------------------------------------------------------------

describe("epic invalidate", () => {
  test("short-circuits when already null (ZERO commits)", () => {
    // test_restamp_verbs.py::test_invalidate_short_circuit_when_already_null
    seedState(root, { epicId: "fn-1-inv", nTasks: 1 });
    expect(epicDef(root, "fn-1-inv").last_validated_at).toBeNull();
    gitBaseline(root);
    const before = gitLogCount(root);
    const r = runCli(["epic", "invalidate", "fn-1-inv"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).short_circuited).toBe(true);
    expect(gitLogCount(root)).toBe(before);
  });

  test("clears a stamped marker + commits", () => {
    // test_restamp_verbs.py::test_invalidate_clears_stamped_marker_and_commits
    seedState(root, { epicId: "fn-2-inv", nTasks: 1 });
    stampMarker(root, "fn-2-inv", STALE);
    gitBaseline(root);
    const before = gitLogCount(root);
    const r = runCli(["epic", "invalidate", "fn-2-inv"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).short_circuited).toBe(false);
    expect(epicDef(root, "fn-2-inv").last_validated_at).toBeNull();
    expect(gitLogCount(root)).toBe(before + 1);
    expect(headSubject(root)).toBe("chore(plan): invalidate fn-2-inv");
  });
});

// ---------------------------------------------------------------------------
// refine-context --invalidate — both branches
// ---------------------------------------------------------------------------

describe("refine-context --invalidate", () => {
  test("clears a stamped marker", () => {
    // test_restamp_verbs.py::test_refine_context_invalidate_clears_stamped
    seedState(root, { epicId: "fn-1-rc", nTasks: 1 });
    stampMarker(root, "fn-1-rc", STALE);
    const r = runCli(["refine-context", "fn-1-rc", "--invalidate"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.invalidated).toBe(true);
    expect(payload.last_validated_at).toBeNull();
    expect(epicDef(root, "fn-1-rc").last_validated_at).toBeNull();
  });

  test("short-circuits when already null", () => {
    // test_restamp_verbs.py::test_refine_context_invalidate_short_circuit_when_null
    seedState(root, { epicId: "fn-2-rc", nTasks: 1 });
    expect(epicDef(root, "fn-2-rc").last_validated_at).toBeNull();
    const r = runCli(["refine-context", "fn-2-rc", "--invalidate"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.invalidated).toBe(false);
    expect(payload.last_validated_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// epic add-dep
// ---------------------------------------------------------------------------

describe("epic add-dep", () => {
  test("wires the edge, ghost stays null", () => {
    // test_restamp_verbs.py::test_add_dep_wires_and_restamps
    seedState(root, { epicId: "fn-1-dep", nTasks: 1 });
    seedState(root, { epicId: "fn-2-dep", nTasks: 1 });
    const r = runCli(["epic", "add-dep", "fn-1-dep", "fn-2-dep"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).depends_on_epics).toEqual(["fn-2-dep"]);
    expect(epicDef(root, "fn-1-dep").last_validated_at).toBeNull();
  });

  test("normalizes a bare fn-N to the full slug", () => {
    // test_restamp_verbs.py::test_add_dep_normalizes_number_only_to_full_slug
    seedState(root, { epicId: "fn-1-norm", nTasks: 1 });
    seedState(root, { epicId: "fn-2-norm", nTasks: 1 });
    const r = runCli(["epic", "add-dep", "fn-1-norm", "fn-2"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect(epicDef(root, "fn-1-norm").depends_on_epics).toEqual(["fn-2-norm"]);
  });

  test("cross-project via roots", () => {
    // test_restamp_verbs.py::test_add_dep_cross_project_via_roots
    const rootDir = realpathSync(mkdirRepo(join(root, "_root"), false));
    const home = realpathSync(mkdirRepo(join(root, "_home"), false));
    const projA = realpathSync(mkdirRepo(join(rootDir, "a"), false));
    const projB = realpathSync(mkdirRepo(join(rootDir, "b"), false));
    seedState(projA, { epicId: "fn-1-xa", nTasks: 1 });
    seedState(projB, { epicId: "fn-2-xb", nTasks: 1 });
    setRoots(home, [rootDir]);

    const r = runCli(["epic", "add-dep", "fn-1-xa", "fn-2-xb"], {
      cwd: projA,
      home,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect(epicDef(projA, "fn-1-xa").depends_on_epics).toEqual(["fn-2-xb"]);
  });

  test("cycle rolls back to the prior cycle-free state", () => {
    // test_restamp_verbs.py::test_add_dep_cycle_rolls_back
    seedState(root, { epicId: "fn-1-cyc", nTasks: 1 });
    seedState(root, { epicId: "fn-2-cyc", nTasks: 1 });

    const first = runCli(["epic", "add-dep", "fn-2-cyc", "fn-1-cyc"], {
      cwd: root,
      env: SID,
    });
    expect(first.code).toBe(0);
    expect(epicDef(root, "fn-2-cyc").depends_on_epics).toEqual(["fn-1-cyc"]);

    const second = runCli(["epic", "add-dep", "fn-1-cyc", "fn-2-cyc"], {
      cwd: root,
      env: SID,
    });
    expect(second.code).toBe(1);
    expect(
      (parseCliOutput(second.output).error as Record<string, unknown>).code,
    ).toBe("integrity_failed");
    expect(epicDef(root, "fn-1-cyc").depends_on_epics).toEqual([]);
  });

  test("already-exists errors", () => {
    // test_restamp_verbs.py::test_add_dep_already_exists_errors
    seedState(root, { epicId: "fn-1-ae", nTasks: 1 });
    seedState(root, { epicId: "fn-2-ae", nTasks: 1 });
    const first = runCli(["epic", "add-dep", "fn-1-ae", "fn-2-ae"], {
      cwd: root,
      env: SID,
    });
    expect(first.code).toBe(0);
    const again = runCli(["epic", "add-dep", "fn-1-ae", "fn-2-ae"], {
      cwd: root,
      env: SID,
    });
    expect(again.code).not.toBe(0);
    expect(again.output).toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// epic add-deps
// ---------------------------------------------------------------------------

describe("epic add-deps", () => {
  test("wired + already-present statuses", () => {
    // test_restamp_verbs.py::test_add_deps_wired_and_already_present
    seedState(root, { epicId: "fn-1-ad", nTasks: 1 });
    seedState(root, { epicId: "fn-2-ad", nTasks: 1 });
    seedState(root, { epicId: "fn-3-ad", nTasks: 1 });
    const first = runCli(["epic", "add-deps", "fn-1-ad", "fn-2-ad"], {
      cwd: root,
      env: SID,
    });
    expect(first.code).toBe(0);

    const second = runCli(
      ["epic", "add-deps", "fn-1-ad", "fn-2-ad", "fn-3-ad"],
      {
        cwd: root,
        env: SID,
      },
    );
    expect(second.code).toBe(0);
    const payload = parseCliOutput(second.output);
    const byId = Object.fromEntries(
      (payload.results as Array<Record<string, unknown>>).map((r) => [
        r.dep_id,
        r.status,
      ]),
    );
    expect(byId["fn-2-ad"]).toBe("ALREADY_PRESENT");
    expect(byId["fn-3-ad"]).toBe("WIRED");
    expect(payload.depends_on_epics).toEqual(["fn-2-ad", "fn-3-ad"]);
  });

  test("--skip-invalid routes per-edge errors into SKIPPED_* statuses", () => {
    // test_restamp_verbs.py::test_add_deps_skip_invalid_statuses
    seedState(root, { epicId: "fn-1-si", nTasks: 1 });
    seedState(root, { epicId: "fn-2-si", nTasks: 1 });
    const r = runCli(
      [
        "epic",
        "add-deps",
        "fn-1-si",
        "fn-2-si",
        "not-an-id",
        "fn-9-ghost",
        "--skip-invalid",
      ],
      { cwd: root, env: SID },
    );
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    const byId = Object.fromEntries(
      (payload.results as Array<Record<string, unknown>>).map((rr) => [
        rr.dep_id,
        rr.status,
      ]),
    );
    expect(byId["fn-2-si"]).toBe("WIRED");
    expect(byId["not-an-id"]).toBe("SKIPPED_BAD_ID");
    expect(byId["fn-9-ghost"]).toBe("SKIPPED_NOT_FOUND");
    expect(epicDef(root, "fn-1-si").depends_on_epics).toEqual(["fn-2-si"]);
  });

  test("error priority: bad_id dominates not-found", () => {
    // test_restamp_verbs.py::test_add_deps_error_priority_bad_id_dominates
    seedState(root, { epicId: "fn-1-ep", nTasks: 1 });
    const r = runCli(
      ["epic", "add-deps", "fn-1-ep", "not-an-id", "fn-9-ghost"],
      {
        cwd: root,
        env: SID,
      },
    );
    expect(r.code).toBe(1);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("bad_id");
    expect(epicDef(root, "fn-1-ep").depends_on_epics).toEqual([]);
  });

  test("--skip-invalid still fails on a missing TARGET epic", () => {
    // test_restamp_verbs.py::test_add_deps_target_not_found_fails_loud_under_skip_invalid
    seedState(root, { epicId: "fn-1-tn", nTasks: 1 });
    const r = runCli(
      ["epic", "add-deps", "fn-9-missing", "fn-1-tn", "--skip-invalid"],
      { cwd: root, env: SID },
    );
    expect(r.code).toBe(1);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("epic_not_found");
  });
});

// ---------------------------------------------------------------------------
// epic rm-dep — idempotent
// ---------------------------------------------------------------------------

describe("epic rm-dep", () => {
  test("removes + is idempotent", () => {
    // test_restamp_verbs.py::test_rm_dep_removes_and_is_idempotent
    seedState(root, { epicId: "fn-1-rd", nTasks: 1 });
    seedState(root, { epicId: "fn-2-rd", nTasks: 1 });
    runCli(["epic", "add-dep", "fn-1-rd", "fn-2-rd"], { cwd: root, env: SID });

    const rm = runCli(["epic", "rm-dep", "fn-1-rd", "fn-2-rd"], {
      cwd: root,
      env: SID,
    });
    expect(rm.code).toBe(0);
    expect(epicDef(root, "fn-1-rd").depends_on_epics).toEqual([]);

    const again = runCli(["epic", "rm-dep", "fn-1-rd", "fn-2-rd"], {
      cwd: root,
      env: SID,
    });
    expect(again.code).toBe(0);
    expect(epicDef(root, "fn-1-rd").depends_on_epics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: integrity-gate failure is fail-forward
// ---------------------------------------------------------------------------

describe("integrity-gate failure fail-forward", () => {
  test("write lands, marker untouched, exit 1 with integrity_failed", () => {
    // test_restamp_verbs.py::test_restamp_failure_is_fail_forward
    seedState(root, { epicId: "fn-1-ff", nTasks: 2 });
    unlinkSync(join(root, ".keeper", "specs", "fn-1-ff.2.md"));
    expect(epicDef(root, "fn-1-ff").last_validated_at).toBeNull();

    const r = runCli(["task", "set-description", "fn-1-ff.1"], {
      cwd: root,
      env: SID,
      input: "forward write\n",
    });
    expect(r.code).toBe(1);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(false);
    const err = payload.error as Record<string, unknown>;
    expect(err.code).toBe("integrity_failed");
    expect(err.message as string).toContain("produced an invalid epic tree");
    expect((err.details as string[]).some((d) => d.includes("fn-1-ff.2"))).toBe(
      true,
    );

    expect(specText(root, "fn-1-ff.1")).toContain("forward write");
    expect(epicDef(root, "fn-1-ff").last_validated_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// arm-exclusive latch — ghost stays null, armed stays byte-identical, only the
// trailing validate --epic arms (idempotently).
// ---------------------------------------------------------------------------

describe("arm-exclusive latch", () => {
  test("headline: a gate verb on a dep-less ghost leaves the marker null", () => {
    seedState(root, { epicId: "fn-1-latch", nTasks: 1 });
    // A freshly-scaffolded ghost: no deps, null marker.
    expect(epicDef(root, "fn-1-latch").depends_on_epics ?? []).toEqual([]);
    expect(epicDef(root, "fn-1-latch").last_validated_at).toBeNull();

    const r = runCli(["task", "set-description", "fn-1-latch.1"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
      input: "body\n",
    });
    expect(r.code).toBe(0);
    // The structural write landed but the ghost stays a ghost.
    expect(specText(root, "fn-1-latch.1")).toContain("body");
    expect(epicDef(root, "fn-1-latch").last_validated_at).toBeNull();
  });

  test("a gate verb on an armed epic leaves the marker byte-identical", () => {
    seedState(root, { epicId: "fn-2-latch", nTasks: 1 });
    const armedTs = "2021-07-07T07:07:07.000000Z";
    stampMarker(root, "fn-2-latch", armedTs);

    const r = runCli(["task", "set-description", "fn-2-latch.1"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
      input: "body\n",
    });
    expect(r.code).toBe(0);
    // Exact prior value — not merely non-null (FROZEN would show if it re-stamped).
    expect(epicDef(root, "fn-2-latch").last_validated_at).toBe(armedTs);
  });

  test("validate --epic is the sole arm and is idempotent (one null→timestamp transition)", () => {
    seedState(root, { epicId: "fn-3-latch", nTasks: 1, primaryRepo: root });
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(epicDef(root, "fn-3-latch").last_validated_at).toBeNull();

    const first = runCli(["validate", "--epic", "fn-3-latch"], {
      cwd: root,
      env: SID,
    });
    expect(first.code).toBe(0);
    const armed = epicDef(root, "fn-3-latch").last_validated_at;
    expect(armed).not.toBeNull();

    const second = runCli(["validate", "--epic", "fn-3-latch"], {
      cwd: root,
      env: SID,
    });
    expect(second.code).toBe(0);
    // Idempotent: the second arm is a no-op, the stamp is byte-identical.
    expect(epicDef(root, "fn-3-latch").last_validated_at).toBe(armed);
  });
});

// mkdir -p *dir*; with *withGit* also drop a bare .git/ so it reads as a repo.
function mkdirRepo(dir: string, withGit = true): string {
  mkdirSync(dir, { recursive: true });
  if (withGit) {
    mkdirSync(join(dir, ".git"), { recursive: true });
  }
  return dir;
}
