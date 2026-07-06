// Engine-agnostic conformance spec for the last_validated_at marker contract —
// the arm-exclusive one-way latch. validate --epic stamp-on-first-run /
// idempotent-on-stamped / no-stamp-on-invalid / never-stamp-on-validate-all; the
// INTEGRITY_GATE_VERBS coverage matrix (each structural verb leaves an armed
// marker byte-identical); the set-target-repo touched_repos auto-roll (grow /
// shrink / idempotent) + the unchanged envelope shape; the samefile mis-location
// reject + symlink accept; epic invalidate (a sole null path) clear /
// short-circuit / updated_at bump.
//
// Real-git divergence from the Python fixture: the Python _create_project writes a
// BARE .git/ skeleton and leans on the fast bucket no-op'ing every git verb. The
// bun binary is the production runtime and ALWAYS runs real-git auto-commit, so
// every fixture here is a real `git init` (withProject) — the marker write rides a
// genuine .keeper/ commit. Epics null their multi-repo fields after mint so
// validate treats them as legacy (skipping the multi-repo path), exactly as the
// Python _create_epic does.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  firstJsonPayload,
  gitInit,
  type ProjectHandle,
  runCli,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

const PRE_STAMP = "2020-01-01T00:00:00Z";

let project: ProjectHandle;
const getProject = withProject("planctl-vmarker-");
beforeEach(() => {
  project = getProject();
});

function run(args: string[], opts: { input?: string } = {}) {
  return runCli(args, {
    cwd: project.root,
    home: project.home,
    input: opts.input,
  });
}

function epicPath(epicId: string): string {
  return join(project.root, ".keeper", "epics", `${epicId}.json`);
}

function readEpic(epicId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(epicPath(epicId), "utf-8"));
}

function writeEpic(epicId: string, data: Record<string, unknown>): void {
  writeFileSync(epicPath(epicId), JSON.stringify(data), "utf-8");
}

// Create a structurally-valid epic, then null its multi-repo fields so validate
// treats it as legacy. Port of _create_epic.
function createEpic(title = "Validate marker test epic"): string {
  const r = run(["epic", "create", "--title", title]);
  expect(r.code).toBe(0);
  const epicId = (firstJsonPayload(r.output).epic as Record<string, unknown>)
    .id as string;
  const data = readEpic(epicId);
  data.primary_repo = null;
  data.touched_repos = null;
  writeEpic(epicId, data);
  return epicId;
}

// Directly write a non-null last_validated_at. Port of _stamp_marker.
function stampMarker(epicId: string, ts = PRE_STAMP): void {
  const data = readEpic(epicId);
  data.last_validated_at = ts;
  writeEpic(epicId, data);
}

// Assert the verb left last_validated_at byte-identical to `pre` — the
// arm-exclusive latch means a gate verb never refreshes an armed marker.
function assertMarkerPreserved(
  epicId: string,
  verb: string,
  pre = PRE_STAMP,
): void {
  expect(readEpic(epicId).last_validated_at).toBe(pre);
  void verb;
}

// Parse a concatenated JSON-document stream (NDJSON or pretty multi-line). Port
// of _parse_json_stream.
function parseJsonStream(text: string): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    let depth = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (c === "\\") {
          esc = true;
        } else if (c === '"') {
          inStr = false;
        }
        continue;
      }
      if (c === '"') {
        inStr = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) {
      break;
    }
    docs.push(JSON.parse(rest.slice(0, end)));
    rest = rest.slice(end).trim();
  }
  return docs;
}

// Scaffold an epic + one task, then null its multi-repo fields. Port of
// _setup_epic_and_task.
function setupEpicAndTask(): { epicId: string; taskId: string } {
  const { epicId, taskIds } = scaffoldEpic(project, {
    title: "Validate marker test epic",
    nTasks: 1,
  });
  const data = readEpic(epicId);
  data.primary_repo = null;
  data.touched_repos = null;
  writeEpic(epicId, data);
  return { epicId, taskId: taskIds[0] as string };
}

// ---------------------------------------------------------------------------
// validate --epic marker-write behavior
// ---------------------------------------------------------------------------

describe("validate --epic marker writes", () => {
  test("stamps the marker + merges the invocation into one value on first run", () => {
    // test_validate_marker.py::test_validate_epic_stamps_marker_on_first_run
    const epicId = createEpic();
    expect(readEpic(epicId).last_validated_at ?? null).toBeNull();

    const r = run(["validate", "--epic", epicId]);
    expect(r.code).toBe(0);

    // ONE JSON value: {valid,errors,warnings} with plan_invocation merged in.
    const docs = parseJsonStream(r.stdout);
    expect(docs.length).toBe(1);
    expect(docs[0]?.valid).toBe(true);
    const inv = docs[0]?.plan_invocation as Record<string, unknown>;
    expect(inv).not.toBeUndefined();
    expect(inv.op).toBe("validate");
    expect(inv.target).toBe(epicId);

    expect(readEpic(epicId).last_validated_at).not.toBeNull();
  });

  test("idempotent on an already-stamped epic (no re-stamp, one value each)", () => {
    // test_validate_marker.py::test_validate_epic_idempotent_on_already_stamped
    const epicId = createEpic();
    const r1 = run(["validate", "--epic", epicId]);
    expect(r1.code).toBe(0);
    expect(parseJsonStream(r1.stdout).length).toBe(1);
    const tsFirst = readEpic(epicId).last_validated_at;

    const r2 = run(["validate", "--epic", epicId]);
    expect(r2.code).toBe(0);
    const docs2 = parseJsonStream(r2.stdout);
    expect(docs2.length).toBe(1);
    expect(docs2[0]?.valid).toBe(true);
    expect(readEpic(epicId).last_validated_at).toBe(tsFirst);
  });

  test("invalid epic: exit 1, no marker, no invocation", () => {
    // test_validate_marker.py::test_validate_epic_invalid_no_marker_no_invocation
    const epicId = createEpic();
    const data = readEpic(epicId);
    delete data.title;
    writeEpic(epicId, data);

    const r = run(["validate", "--epic", epicId]);
    expect(r.code).toBe(1);
    const docs = parseJsonStream(r.stdout);
    expect(docs.length).toBe(1);
    expect(docs[0]?.valid).toBe(false);
    for (const doc of docs) {
      expect("plan_invocation" in doc).toBe(false);
    }
    expect(readEpic(epicId).last_validated_at ?? null).toBeNull();
  });

  test("validate-all (no --epic) never writes markers", () => {
    // test_validate_marker.py::test_validate_all_never_writes_markers
    const epicId = createEpic();
    expect(readEpic(epicId).last_validated_at ?? null).toBeNull();

    const r = run(["validate"]);
    expect(readEpic(epicId).last_validated_at ?? null).toBeNull();
    for (const doc of parseJsonStream(r.stdout)) {
      expect("plan_invocation" in doc).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// INTEGRITY_GATE_VERBS coverage — each structural verb, run on an ARMED epic,
// leaves last_validated_at byte-identical (the arm-exclusive latch). Behavior
// overlaps verbs-restamp.test.ts, but here the marker-value lens is asserted.
// ---------------------------------------------------------------------------

describe("integrity-gate marker-preservation matrix", () => {
  test("refine-apply add_tasks preserves the armed marker", () => {
    // test_validate_marker.py::test_restamp_on_refine_apply_adds_task
    const { epicId } = setupEpicAndTask();
    stampMarker(epicId);
    const delta = join(project.root, "add_task.yaml");
    writeFileSync(
      delta,
      "add_tasks:\n  - title: New task\n    tier: medium\n    model: opus\n    spec: |\n" +
        "      ## Description\n      x\n      ## Acceptance\n      - [ ] x\n" +
        "      ## Done summary\n\n      ## Evidence\n",
      "utf-8",
    );
    const r = run(["refine-apply", epicId, "--file", delta]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "refine-apply (add_tasks)");
  });

  test("set-description preserves the armed marker", () => {
    // test_validate_marker.py::test_restamp_on_set_description
    const { epicId, taskId } = setupEpicAndTask();
    stampMarker(epicId);
    const descFile = join(project.root, "desc.md");
    writeFileSync(descFile, "Updated description text.\n", "utf-8");
    const r = run(["task", "set-description", "--file", descFile, taskId]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "set-description");
  });

  test("set-acceptance preserves the armed marker", () => {
    // test_validate_marker.py::test_restamp_on_set_acceptance
    const { epicId, taskId } = setupEpicAndTask();
    stampMarker(epicId);
    const accFile = join(project.root, "acc.md");
    writeFileSync(accFile, "- [ ] Updated acceptance\n", "utf-8");
    const r = run(["task", "set-acceptance", "--file", accFile, taskId]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "set-acceptance");
  });

  test("refine-apply rewire_deps preserves the armed marker", () => {
    // test_validate_marker.py::test_restamp_on_refine_apply_rewires_deps
    const { epicId, taskId } = setupEpicAndTask();
    stampMarker(epicId);
    const delta = join(project.root, "rewire_delta.yaml");
    writeFileSync(
      delta,
      `rewire_deps:\n  - task_id: ${taskId}\n    deps: []\n`,
      "utf-8",
    );
    const r = run(["refine-apply", epicId, "--file", delta]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "refine-apply (rewire_deps)");
  });

  test("reset preserves the armed marker", () => {
    // test_validate_marker.py::test_restamp_on_reset
    const { epicId, taskId } = setupEpicAndTask();
    stampMarker(epicId);
    const r = run(["task", "reset", taskId]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "reset");
  });

  test("epic add-dep preserves the armed marker", () => {
    // test_validate_marker.py::test_restamp_on_epic_add_dep
    const epicId = createEpic();
    const depId = createEpic("Dep epic");
    stampMarker(epicId);
    const r = run(["epic", "add-dep", epicId, depId]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "add-dep");
  });

  test("epic add-deps preserves the armed marker", () => {
    // test_validate_marker.py::test_restamp_on_epic_add_deps
    const epicId = createEpic();
    const depId = createEpic("Dep epic");
    stampMarker(epicId);
    const r = run(["epic", "add-deps", epicId, depId]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "add-deps");
  });

  test("epic rm-dep preserves the armed marker", () => {
    // test_validate_marker.py::test_restamp_on_epic_rm_dep
    const epicId = createEpic();
    const depId = createEpic("Dep epic");
    expect(run(["epic", "add-dep", epicId, depId]).code).toBe(0);
    stampMarker(epicId);
    const r = run(["epic", "rm-dep", epicId, depId]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "rm-dep");
  });

  test("refine-apply epic-spec rewrite preserves the armed marker", () => {
    // test_validate_marker.py::test_restamp_on_refine_apply
    const epicId = createEpic();
    stampMarker(epicId);
    const delta = join(project.root, "delta.yaml");
    writeFileSync(
      delta,
      "epic:\n  spec: |\n    ## Overview\n    Rewritten via refine-apply.\n",
      "utf-8",
    );
    const r = run(["refine-apply", epicId, "--file", delta]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "refine-apply");
  });

  // The canonical INTEGRITY_GATE_VERBS set is pinned exactly by
  //   src-integrity.test.ts (scaffold + validate absent).
});

// ---------------------------------------------------------------------------
// set-*-repo marker-preservation + set-target-repo touched_repos auto-roll
// ---------------------------------------------------------------------------

describe("set-*-repo marker-preservation + touched_repos auto-roll", () => {
  // Create an epic with primary_repo/touched_repos pinned to a real .git/ path.
  // Port of _create_epic_with_primary_repo.
  function createEpicWithPrimary(repoPath: string): string {
    const r = run([
      "epic",
      "create",
      "--title",
      "Validate marker repo test epic",
    ]);
    expect(r.code).toBe(0);
    const epicId = (firstJsonPayload(r.output).epic as Record<string, unknown>)
      .id as string;
    const data = readEpic(epicId);
    data.primary_repo = repoPath;
    data.touched_repos = [repoPath];
    writeEpic(epicId, data);
    return epicId;
  }

  function freshGitRepo(name: string): string {
    const dir = join(project.root, name);
    mkdirSync(dir, { recursive: true });
    gitInit(dir);
    return dir;
  }

  // Scaffold an epic with N tasks, pin primary_repo to project.root, write per-
  // task target_repo values. Port of _seed_multi_task_epic_with_repos.
  function seedMultiTaskWithRepos(taskRepos: string[]): {
    epicId: string;
    taskIds: string[];
  } {
    const { epicId, taskIds } = scaffoldEpic(project, {
      title: "Touched-repos rollup test epic",
      nTasks: taskRepos.length,
    });
    const data = readEpic(epicId);
    data.primary_repo = project.root;
    data.touched_repos = [...new Set(taskRepos)].sort();
    writeEpic(epicId, data);
    taskRepos.forEach((tr, i) => {
      const tp = join(project.root, ".keeper", "tasks", `${taskIds[i]}.json`);
      const tdata = JSON.parse(readFileSync(tp, "utf-8"));
      tdata.target_repo = tr;
      writeFileSync(tp, JSON.stringify(tdata), "utf-8");
    });
    return { epicId, taskIds };
  }

  test("set-primary-repo preserves the armed marker (samefile-pinned to project root)", () => {
    // test_validate_marker.py::test_restamp_on_set_primary_repo
    const epicId = createEpicWithPrimary(project.root);
    stampMarker(epicId);
    const r = run(["epic", "set-primary-repo", epicId, "--path", project.root]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "set-primary-repo");
  });

  test("set-touched-repos preserves the armed marker", () => {
    // test_validate_marker.py::test_restamp_on_set_touched_repos
    const epicId = createEpicWithPrimary(project.root);
    stampMarker(epicId);
    const r = run([
      "epic",
      "set-touched-repos",
      epicId,
      "--paths",
      project.root,
    ]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "set-touched-repos");
  });

  test("task set-target-repo preserves the parent epic's armed marker", () => {
    // test_validate_marker.py::test_restamp_on_set_target_repo
    const { epicId, taskIds } = scaffoldEpic(project, {
      title: "Validate marker repo test epic",
      nTasks: 1,
    });
    const data = readEpic(epicId);
    data.primary_repo = project.root;
    data.touched_repos = [project.root];
    writeEpic(epicId, data);
    stampMarker(epicId);

    const r = run([
      "task",
      "set-target-repo",
      taskIds[0] as string,
      "--path",
      project.root,
    ]);
    expect(r.code).toBe(0);
    assertMarkerPreserved(epicId, "set-target-repo");
  });

  test("touched_repos grows to sorted [A, B]", () => {
    // test_validate_marker.py::test_set_target_repo_recomputes_touched_repos_grow
    const repoA = freshGitRepo("repo-a");
    const repoB = freshGitRepo("repo-b");
    const { epicId, taskIds } = seedMultiTaskWithRepos([repoA, repoA, repoA]);

    const r = run([
      "task",
      "set-target-repo",
      taskIds[1] as string,
      "--path",
      repoB,
    ]);
    expect(r.code).toBe(0);
    expect(readEpic(epicId).touched_repos).toEqual([repoA, repoB].sort());
  });

  test("touched_repos shrinks when a repo loses its last task", () => {
    // test_validate_marker.py::test_set_target_repo_recomputes_touched_repos_shrink
    const repoA = freshGitRepo("repo-a");
    const repoB = freshGitRepo("repo-b");
    const { epicId, taskIds } = seedMultiTaskWithRepos([repoA, repoB]);

    const r = run([
      "task",
      "set-target-repo",
      taskIds[1] as string,
      "--path",
      repoA,
    ]);
    expect(r.code).toBe(0);
    expect(readEpic(epicId).touched_repos).toEqual([repoA]);
  });

  test("touched_repos unchanged on a same-value re-target", () => {
    // test_validate_marker.py::test_set_target_repo_idempotent_when_same
    const repoA = freshGitRepo("repo-a");
    const repoB = freshGitRepo("repo-b");
    const { epicId, taskIds } = seedMultiTaskWithRepos([repoA, repoB]);
    const before = readEpic(epicId).touched_repos;

    const r = run([
      "task",
      "set-target-repo",
      taskIds[1] as string,
      "--path",
      repoB,
    ]);
    expect(r.code).toBe(0);
    const after = readEpic(epicId).touched_repos;
    expect(after).toEqual([repoA, repoB].sort());
    expect(after).toEqual(before);
  });

  test("set-target-repo envelope shape unchanged ({task_id, target_repo})", () => {
    // test_validate_marker.py::test_set_target_repo_envelope_shape_unchanged
    const repoA = freshGitRepo("repo-a");
    const repoB = freshGitRepo("repo-b");
    const { taskIds } = seedMultiTaskWithRepos([repoA]);

    const r = run([
      "task",
      "set-target-repo",
      taskIds[0] as string,
      "--path",
      repoB,
    ]);
    expect(r.code).toBe(0);
    const docs = parseJsonStream(r.stdout);
    expect(docs.length).toBe(1);
    const envelope = docs[0] as Record<string, unknown>;
    const business = Object.fromEntries(
      Object.entries(envelope).filter(
        ([k]) => k !== "success" && k !== "plan_invocation",
      ),
    );
    expect(new Set(Object.keys(business))).toEqual(
      new Set(["task_id", "target_repo"]),
    );
    expect(business.task_id).toBe(taskIds[0]);
    expect(business.target_repo).toBe(repoB);
  });
});

// ---------------------------------------------------------------------------
// samefile defense: mis-location reject + symlink accept
// ---------------------------------------------------------------------------

describe("samefile defense", () => {
  // The Python fixture inits the project inside a subdir git repo; withProject
  // already gives a real git repo at project.root, so that root IS the samefile
  // anchor here.
  function createEpicWithPrimary(repoPath: string): string {
    const r = run([
      "epic",
      "create",
      "--title",
      "Validate marker repo test epic",
    ]);
    expect(r.code).toBe(0);
    const epicId = (firstJsonPayload(r.output).epic as Record<string, unknown>)
      .id as string;
    const data = readEpic(epicId);
    data.primary_repo = repoPath;
    data.touched_repos = [repoPath];
    writeEpic(epicId, data);
    return epicId;
  }

  test("validate rejects a mis-located primary_repo", () => {
    // test_validate_marker.py::test_validate_rejects_mislocated_primary_repo
    const other = join(project.root, "other-repo");
    mkdirSync(other, { recursive: true });
    gitInit(other);
    const epicId = createEpicWithPrimary(other);

    const r = run(["validate", "--epic", epicId]);
    expect(r.code).toBe(1);
    const docs = parseJsonStream(r.stdout);
    expect(docs.length).toBeGreaterThan(0);
    const envelope = docs[0] as Record<string, unknown>;
    expect(envelope.valid).toBe(false);
    expect(
      (envelope.errors as string[]).some((e) => e.includes("mis-located")),
    ).toBe(true);
  });

  test("validate accepts a primary_repo reached via symlink", () => {
    // test_validate_marker.py::test_validate_accepts_primary_repo_via_symlink
    const link = join(project.root, "link-to-project");
    symlinkSync(project.root, link);
    const epicId = createEpicWithPrimary(link);

    const r = run(["validate", "--epic", epicId]);
    expect(r.code).toBe(0);
    const docs = parseJsonStream(r.stdout);
    expect(docs.length).toBeGreaterThan(0);
    const envelope = docs[0] as Record<string, unknown>;
    expect(envelope.valid).toBe(true);
    expect((envelope.errors ?? []) as string[]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// epic invalidate — one of the two un-arm null paths (the other is
// refine-context --invalidate)
// ---------------------------------------------------------------------------

describe("epic invalidate", () => {
  test("clears the marker + emits op=invalidate", () => {
    // test_validate_marker.py::test_invalidate_clears_marker
    const epicId = createEpic();
    stampMarker(epicId);
    expect(readEpic(epicId).last_validated_at).toBe(PRE_STAMP);

    const r = run(["epic", "invalidate", epicId]);
    expect(r.code).toBe(0);
    expect(readEpic(epicId).last_validated_at ?? null).toBeNull();

    const docs = parseJsonStream(r.stdout);
    expect(docs.length).toBe(1);
    const inv = (docs[0]?.plan_invocation ?? {}) as Record<string, unknown>;
    expect(inv.op).toBe("invalidate");
    expect(inv.target).toBe(epicId);
  });

  test("short-circuits when already null (readonly invocation, files null)", () => {
    // test_validate_marker.py::test_invalidate_short_circuits_when_already_null
    const epicId = createEpic();
    expect(readEpic(epicId).last_validated_at ?? null).toBeNull();

    const r = run(["epic", "invalidate", epicId]);
    expect(r.code).toBe(0);
    const docs = parseJsonStream(r.stdout);
    expect(docs.length).toBe(1);
    const inv = (docs[0]?.plan_invocation ?? {}) as Record<string, unknown>;
    expect(inv.op).toBe("invalidate");
    expect(inv.files ?? null).toBeNull();
    expect(readEpic(epicId).last_validated_at ?? null).toBeNull();
  });

  test("bumps updated_at on the stamped→null transition", () => {
    // test_validate_marker.py::test_invalidate_bumps_updated_at
    const epicId = createEpic();
    const data = readEpic(epicId);
    data.updated_at = PRE_STAMP;
    data.last_validated_at = PRE_STAMP;
    writeEpic(epicId, data);

    const r = run(["epic", "invalidate", epicId]);
    expect(r.code).toBe(0);
    const newUpdated = readEpic(epicId).updated_at;
    expect(newUpdated).not.toBeNull();
    expect((newUpdated as string) > PRE_STAMP).toBe(true);
  });

  // invalidate is NOT an INTEGRITY_GATE_VERBS member — src-integrity.test.ts pins
  //   the canonical set (invalidate absent).
});

// ---------------------------------------------------------------------------
// Negative: done does not clear the marker
// ---------------------------------------------------------------------------

describe("done leaves the marker", () => {
  test("planctl done does not clear last_validated_at", () => {
    // test_validate_marker.py::test_done_does_not_clear_marker
    const { epicId, taskId } = setupEpicAndTask();
    const claim = run(["claim", taskId, "--project", project.root]);
    expect(claim.code).toBe(0);
    stampMarker(epicId);

    const r = run(["done", taskId, "--summary", "Test done"]);
    expect(r.code).toBe(0);
    expect(readEpic(epicId).last_validated_at).toBe(PRE_STAMP);
  });
});
