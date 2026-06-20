// Engine-agnostic conformance spec for the in-wave mutating verbs — translated
// from tests/test_restamp_verbs.py, every node mapped by a source-comment. The
// mutating-side companion to verbs-query: the restamping setters
// (set-description / set-acceptance from file AND stdin, reset incl. --cascade,
// set-target-repo's touched_repos recompute, the warn-and-write
// set-primary-repo / set-touched-repos), the non-restamp setters (set-tier,
// set-branch, set-title), the short-circuiting verbs (invalidate / queue-jump /
// refine-context --invalidate), the dep editors (add-dep fn-N normalization,
// cross-project via roots, cycle rollback, idempotent rm-dep), add-deps
// (skip-invalid statuses, error priority), and the fail-forward restamp-failure.
//
// Every fixture is seedState + gitBaseline (the _git_seed port); commit subjects
// + two-file scope read off git log. Assertions on envelopes, .keeper/ files,
// git — never internals.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
          if (!(keys.length === 1 && keys[0] === "planctl_invocation")) {
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
// set-description / set-acceptance — section patch + restamp (file + stdin)
// ---------------------------------------------------------------------------

describe("set-description / set-acceptance restamp", () => {
  test("set-description from --file patches + restamps", () => {
    // test_restamp_verbs.py::test_set_description_from_file_patches_and_restamps
    seedState(root, { epicId: "fn-1-sd", nTasks: 1 });
    expect(epicDef(root, "fn-1-sd").last_validated_at).toBeNull();
    const descFile = join(root, "desc.md");
    writeFileSync(descFile, "brand new description body\n");

    const r = runCli(
      ["task", "set-description", "fn-1-sd.1", "--file", descFile],
      {
        cwd: root,
        env: { ...SID, PLANCTL_NOW: FROZEN },
      },
    );
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.task_id).toBe("fn-1-sd.1");
    expect(payload.section).toBe("Description");
    expect(specText(root, "fn-1-sd.1")).toContain("brand new description body");
    expect(epicDef(root, "fn-1-sd").last_validated_at).toBe(FROZEN);
  });

  test("set-acceptance from stdin patches + restamps", () => {
    // test_restamp_verbs.py::test_set_acceptance_from_stdin_patches_and_restamps
    seedState(root, { epicId: "fn-1-sa", nTasks: 1 });
    const r = runCli(["task", "set-acceptance", "fn-1-sa.1"], {
      cwd: root,
      env: { ...SID, PLANCTL_NOW: FROZEN },
      input: "- [ ] new criterion from stdin\n",
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).section).toBe("Acceptance");
    expect(specText(root, "fn-1-sa.1")).toContain("new criterion from stdin");
    expect(epicDef(root, "fn-1-sa").last_validated_at).toBe(FROZEN);
  });

  test("set-description commit subject", () => {
    // test_restamp_verbs.py::test_set_description_commit_subject
    seedState(root, { epicId: "fn-2-sd", nTasks: 1 });
    gitBaseline(root);
    const before = gitLogCount(root);
    const r = runCli(["task", "set-description", "fn-2-sd.1"], {
      cwd: root,
      env: { ...SID, PLANCTL_NOW: FROZEN },
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
  test("clears runtime + spec + worker_done_at + restamps", () => {
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
      env: { ...SID, PLANCTL_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    expect(
      (runtime(root, "fn-1-rst.1") as Record<string, unknown>).status,
    ).toBe("todo");
    expect(taskDef(root, "fn-1-rst.1").worker_done_at).toBeNull();
    const spec = specText(root, "fn-1-rst.1");
    expect(spec).not.toContain("all shipped");
    expect(spec).not.toContain("lots");
    expect(epicDef(root, "fn-1-rst").last_validated_at).toBe(FROZEN);
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
  test("recomputes touched_repos before restamp", () => {
    // test_restamp_verbs.py::test_set_target_repo_recomputes_touched_repos
    const repoA = realpathSync(mkdirRepo(join(root, "repo_a")));
    const repoB = realpathSync(mkdirRepo(join(root, "repo_b")));
    seedState(root, { epicId: "fn-1-str", nTasks: 2, primaryRepo: repoA });

    const r = runCli(
      ["task", "set-target-repo", "fn-1-str.1", "--path", repoB],
      { cwd: root, env: { ...SID, PLANCTL_NOW: FROZEN } },
    );
    expect(r.code).toBe(0);
    expect(taskDef(root, "fn-1-str.1").target_repo).toBe(repoB);
    const epic = epicDef(root, "fn-1-str");
    expect(epic.touched_repos).toEqual([repoA, repoB].sort());
    expect(epic.last_validated_at).toBe(FROZEN);
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
  test("set-primary-repo valid restamps", () => {
    // test_restamp_verbs.py::test_set_primary_repo_valid_restamps
    const repo = realpathSync(mkdirRepo(join(root, "real_repo")));
    seedState(root, { epicId: "fn-1-spr", nTasks: 1, primaryRepo: root });
    mkdirSync(join(root, ".git"), { recursive: true });

    const r = runCli(["epic", "set-primary-repo", "fn-1-spr", "--path", repo], {
      cwd: root,
      env: { ...SID, PLANCTL_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.primary_repo).toBe(repo);
    expect(payload.warnings).toEqual([]);
    expect(epicDef(root, "fn-1-spr").last_validated_at).toBe(FROZEN);
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
// set-tier / set-branch / set-title — no restamp
// ---------------------------------------------------------------------------

describe("non-restamp setters", () => {
  test("set-tier writes + leaves the marker (not a restamp member)", () => {
    // test_restamp_verbs.py::test_set_tier_writes_and_leaves_marker
    seedState(root, { epicId: "fn-1-tier", nTasks: 1 });
    stampMarker(root, "fn-1-tier", STALE);
    const r = runCli(["task", "set-tier", "fn-1-tier.1", "--tier", "high"], {
      cwd: root,
      env: { ...SID, PLANCTL_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).tier).toBe("high");
    expect(taskDef(root, "fn-1-tier.1").tier).toBe("high");
    expect(epicDef(root, "fn-1-tier").last_validated_at).toBe(STALE);
  });

  test("set-branch plain write, no restamp", () => {
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
// epic queue-jump — short-circuit / write
// ---------------------------------------------------------------------------

describe("epic queue-jump", () => {
  test("sets the flag + commits", () => {
    // test_restamp_verbs.py::test_queue_jump_sets_flag_and_commits
    seedState(root, { epicId: "fn-1-qj", nTasks: 1 });
    gitBaseline(root);
    const before = gitLogCount(root);
    const r = runCli(["epic", "queue-jump", "fn-1-qj"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).short_circuited).toBe(false);
    expect(epicDef(root, "fn-1-qj").queue_jump).toBe(true);
    expect(gitLogCount(root)).toBe(before + 1);
    expect(headSubject(root)).toBe("chore(plan): queue-jump fn-1-qj");
  });

  test("short-circuits when already true (ZERO commits)", () => {
    // test_restamp_verbs.py::test_queue_jump_short_circuit_when_already_true
    seedState(root, { epicId: "fn-2-qj", nTasks: 1 });
    const p = join(root, ".keeper", "epics", "fn-2-qj.json");
    const ed = loadJson(p);
    ed.queue_jump = true;
    atomicWriteJson(p, ed);
    gitBaseline(root);
    const before = gitLogCount(root);
    const r = runCli(["epic", "queue-jump", "fn-2-qj"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).short_circuited).toBe(true);
    expect(gitLogCount(root)).toBe(before);
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
  test("wires + restamps", () => {
    // test_restamp_verbs.py::test_add_dep_wires_and_restamps
    seedState(root, { epicId: "fn-1-dep", nTasks: 1 });
    seedState(root, { epicId: "fn-2-dep", nTasks: 1 });
    const r = runCli(["epic", "add-dep", "fn-1-dep", "fn-2-dep"], {
      cwd: root,
      env: { ...SID, PLANCTL_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).depends_on_epics).toEqual(["fn-2-dep"]);
    expect(epicDef(root, "fn-1-dep").last_validated_at).toBe(FROZEN);
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
// Cross-cutting: restamp-failure fail-forward
// ---------------------------------------------------------------------------

describe("restamp-failure fail-forward", () => {
  test("write lands, marker stays stale, exit 1 with integrity_failed", () => {
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
    expect(err.message as string).toContain("last_validated_at NOT re-stamped");
    expect((err.details as string[]).some((d) => d.includes("fn-1-ff.2"))).toBe(
      true,
    );

    expect(specText(root, "fn-1-ff.1")).toContain("forward write");
    expect(epicDef(root, "fn-1-ff").last_validated_at).toBeNull();
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
