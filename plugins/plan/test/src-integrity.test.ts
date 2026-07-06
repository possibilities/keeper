// Unit tests for src/integrity.ts and src/integrity_gate.ts —
// the integrity catalog + the post-write integrity gate.
//
// The catalog cases pin the check output (the executable spec the catalog is
// held to): missing epic/task deps, the two graph cycles, the samefile
// mis-location error, and the resolve() target_repo warning with its repr
// quoting. The checkFilesystemRepos toggle is exercised both ways. The integrity
// gate is driven through a spawned bun harness (integrityGateOrFail / runSetter
// call process.exit on integrity failure, which a child process makes
// observable), proving fail-forward (write lands, marker untouched), the
// arm-exclusive latch (ghost stays null, armed stays byte-identical), and
// add-dep's rollback hook.

import { describe, expect, test } from "bun:test";
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
import { join } from "node:path";

import {
  type CheckEpicTreeOptions,
  checkEpicTree,
  validateTaskSpecHeadings as headingsFromIntegrity,
} from "../src/integrity.ts";
import { INTEGRITY_GATE_VERBS } from "../src/integrity_gate.ts";
import { validateTaskSpecHeadings as headingsFromSpecs } from "../src/specs.ts";

const REPO = join(import.meta.dir, "..");
const TASK_SPEC =
  "## Description\nx\n\n## Acceptance\n- [ ] x\n\n## Done summary\n\n## Evidence\n";

interface Fixture {
  dir: string;
  dataDir: string;
}

/** Build a `.keeper/` tree under a fresh tmp dir and return [dir, dataDir]. */
function makeFixture(): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "planctl-integrity-")));
  const dataDir = join(dir, ".keeper");
  for (const sub of ["epics", "tasks", "specs", "state"]) {
    mkdirSync(join(dataDir, sub), { recursive: true });
  }
  return { dir, dataDir };
}

function writeEpic(
  fx: Fixture,
  id: string,
  fields: Record<string, unknown>,
): void {
  writeFileSync(
    join(fx.dataDir, "epics", `${id}.json`),
    JSON.stringify({
      id,
      title: "T",
      status: "open",
      depends_on_epics: [],
      primary_repo: null,
      touched_repos: null,
      ...fields,
    }),
  );
  writeFileSync(join(fx.dataDir, "specs", `${id}.md`), "## Overview\nx\n");
}

function writeTask(
  fx: Fixture,
  id: string,
  fields: Record<string, unknown>,
): void {
  writeFileSync(
    join(fx.dataDir, "tasks", `${id}.json`),
    JSON.stringify({
      id,
      epic: id.slice(0, id.lastIndexOf(".")),
      title: "Task",
      status: "todo",
      depends_on: [],
      target_repo: null,
      ...fields,
    }),
  );
  writeFileSync(join(fx.dataDir, "specs", `${id}.md`), TASK_SPEC);
}

/** Run the bun checkEpicTree against the same on-disk tree. */
function bunCheck(
  dataDir: string,
  eid: string,
  taskIds: string[],
  checkFilesystemRepos: boolean,
): { errors: string[]; warnings: string[] } {
  const epic = JSON.parse(
    readFileSync(join(dataDir, "epics", `${eid}.json`), "utf-8"),
  );
  const tasks: Record<string, Record<string, unknown>> = {};
  const specs: Record<string, string | null> = {};
  for (const tid of taskIds) {
    const t = JSON.parse(
      readFileSync(join(dataDir, "tasks", `${tid}.json`), "utf-8"),
    );
    tasks[t.id] = t;
    const specPath = join(dataDir, "specs", `${tid}.md`);
    specs[t.id] = existsSync(specPath) ? readFileSync(specPath, "utf-8") : null;
  }
  const opts: CheckEpicTreeOptions = {
    dataDir,
    allEpicIds: new Set([eid]),
    stateStore: null,
    checkFilesystemRepos,
    allEpicDeps: { [eid]: epic.depends_on_epics ?? [] },
  };
  const [errors, warnings] = checkEpicTree(eid, epic, tasks, specs, opts);
  return { errors, warnings };
}

/** Run the bun catalog for the fixture and return its errors+warnings; callers
 * pin the load-bearing strings explicitly. */
function expectParity(
  dataDir: string,
  eid: string,
  taskIds: string[],
  cfr: boolean,
): { errors: string[]; warnings: string[] } {
  return bunCheck(dataDir, eid, taskIds, cfr);
}

describe("checkEpicTree catalog against the frozen spec", () => {
  test("clean tree: no errors, no warnings", () => {
    const fx = makeFixture();
    try {
      writeEpic(fx, "fn-1-ok", {});
      writeTask(fx, "fn-1-ok.1", {});
      const out = expectParity(fx.dataDir, "fn-1-ok", ["fn-1-ok.1"], false);
      expect(out.errors).toEqual([]);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("missing epic dep + missing task dep + task-graph cycle", () => {
    const fx = makeFixture();
    try {
      writeEpic(fx, "fn-1-cafe", { depends_on_epics: ["fn-99-ghost"] });
      writeTask(fx, "fn-1-cafe.1", {
        depends_on: ["fn-1-cafe.9", "fn-1-cafe.2"],
      });
      writeTask(fx, "fn-1-cafe.2", { depends_on: ["fn-1-cafe.1"] });
      const out = expectParity(
        fx.dataDir,
        "fn-1-cafe",
        ["fn-1-cafe.1", "fn-1-cafe.2"],
        false,
      );
      // Pin the golden-corpus strings explicitly.
      expect(out.errors).toContain(
        "Epic fn-1-cafe: dependency fn-99-ghost does not exist",
      );
      expect(out.errors).toContain(
        "Task fn-1-cafe.1: dependency fn-1-cafe.9 does not exist",
      );
      expect(out.errors).toContain(
        "Epic fn-1-cafe: dependency cycle detected: fn-1-cafe.1 -> fn-1-cafe.2 -> fn-1-cafe.1",
      );
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("epic-dep self-reference + invalid epic id in depends_on_epics", () => {
    const fx = makeFixture();
    try {
      writeEpic(fx, "fn-1-self", {
        depends_on_epics: ["fn-1-self", "not-an-epic"],
      });
      writeTask(fx, "fn-1-self.1", {});
      const out = expectParity(fx.dataDir, "fn-1-self", ["fn-1-self.1"], false);
      expect(out.errors).toContain(
        "Epic fn-1-self: self-referential dependency",
      );
      expect(out.errors).toContain(
        "Epic fn-1-self: invalid epic ID in depends_on_epics: not-an-epic",
      );
      expect(out.errors).toContain(
        "Epic fn-1-self: epic-dep cycle detected: fn-1-self -> fn-1-self",
      );
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("missing task spec is reported (spec file absent)", () => {
    const fx = makeFixture();
    try {
      writeEpic(fx, "fn-1-nospec", {});
      writeTask(fx, "fn-1-nospec.1", {});
      // Delete the task spec so the check reports it missing — both engines read
      // an absent spec as null, so expectParity exercises the same path.
      rmSync(join(fx.dataDir, "specs", "fn-1-nospec.1.md"));
      const out = expectParity(
        fx.dataDir,
        "fn-1-nospec",
        ["fn-1-nospec.1"],
        false,
      );
      expect(out.errors).toContain(
        "Task fn-1-nospec.1: spec file missing at specs/fn-1-nospec.1.md",
      );
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

describe("checkEpicTree repo-path semantics + toggle byte-parity", () => {
  /** A real git repo (a dir holding `.git/`). */
  function gitRepo(parent: string, name: string): string {
    const p = join(parent, name);
    mkdirSync(join(p, ".git"), { recursive: true });
    return p;
  }

  test("samefile mis-location error fires only with the filesystem toggle", () => {
    const fx = makeFixture();
    try {
      // primary_repo points at a DIFFERENT git repo than the data-dir parent.
      const other = gitRepo(fx.dir, "elsewhere");
      writeEpic(fx, "fn-1-loc", {
        primary_repo: other,
        touched_repos: [other],
      });
      writeTask(fx, "fn-1-loc.1", {});
      // Toggle ON: the mis-location error surfaces (samefile dev+ino compare).
      const on = expectParity(fx.dataDir, "fn-1-loc", ["fn-1-loc.1"], true);
      expect(on.errors.some((e) => e.includes("epic is mis-located"))).toBe(
        true,
      );
      // Toggle OFF: the filesystem/samefile checks are skipped.
      const off = expectParity(fx.dataDir, "fn-1-loc", ["fn-1-loc.1"], false);
      expect(off.errors.some((e) => e.includes("mis-located"))).toBe(false);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("correctly-located primary_repo (samefile true) yields no error", () => {
    const fx = makeFixture();
    try {
      // The data-dir parent IS a git repo and IS the primary_repo.
      mkdirSync(join(fx.dir, ".git"), { recursive: true });
      writeEpic(fx, "fn-1-here", {
        primary_repo: fx.dir,
        touched_repos: [fx.dir],
      });
      writeTask(fx, "fn-1-here.1", { target_repo: fx.dir });
      const out = expectParity(fx.dataDir, "fn-1-here", ["fn-1-here.1"], true);
      expect(out.errors.some((e) => e.includes("mis-located"))).toBe(false);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("target_repo not in touched_repos warns with the resolved path quoted", () => {
    const fx = makeFixture();
    try {
      const repoA = gitRepo(fx.dir, "repo_a");
      const repoB = gitRepo(fx.dir, "repo_b");
      writeEpic(fx, "fn-1-tr", { primary_repo: repoA, touched_repos: [repoA] });
      // target_repo = repoB, absent from touched_repos -> resolve-compare warning.
      writeTask(fx, "fn-1-tr.1", { target_repo: repoB });
      // Warnings fire under either toggle (pure string check). Pick OFF so the
      // .git checks don't add errors and the warning is isolated.
      const out = expectParity(fx.dataDir, "fn-1-tr", ["fn-1-tr.1"], false);
      expect(out.warnings.length).toBe(1);
      expect(out.warnings[0]).toContain(`target_repo '${repoB}'`);
      expect(out.warnings[0]).toContain("epic.touched_repos");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});

describe("INTEGRITY_GATE_VERBS membership", () => {
  test("matches the canonical list exactly (order included)", () => {
    const canonical = [
      "set-description",
      "set-acceptance",
      "reset",
      "add-dep",
      "add-deps",
      "rm-dep",
      "set-primary-repo",
      "set-touched-repos",
      "set-target-repo",
      "mv-repo",
      "refine-apply",
      "assign-cells",
    ];
    expect([...INTEGRITY_GATE_VERBS]).toEqual(canonical);
  });
});

describe("spec-heading check is reused, never forked", () => {
  test("integrity re-exports the identical specs.ts validateTaskSpecHeadings", () => {
    expect(headingsFromIntegrity).toBe(headingsFromSpecs);
  });
});

// ---------------------------------------------------------------------------
// integrityGateOrFail + runSetter — driven through a spawned bun harness because
// the failure path calls process.exit(1). The harness writes a tree, applies a
// structural change, then runs the pipeline and reports the post-state on stdout.
// ---------------------------------------------------------------------------

const HARNESS = join(import.meta.dir, "fixtures", "restamp-harness.ts");

interface HarnessResult {
  exitCode: number;
  stdout: string;
}

function runHarness(dataDir: string, scenario: string): HarnessResult {
  const proc = Bun.spawnSync(["bun", "run", HARNESS, dataDir, scenario], {
    cwd: REPO,
    env: { ...process.env, KEEPER_PLAN_NOW: "2026-06-06T00:00:00.000000Z" },
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
}

function readEpicJson(dataDir: string, eid: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dataDir, "epics", `${eid}.json`), "utf-8"),
  );
}

describe("integrityGateOrFail + runSetter pipeline", () => {
  test("runSetter: clean tree applies the write; the gate leaves the ghost null", () => {
    const fx = makeFixture();
    try {
      writeEpic(fx, "fn-1-clean", { last_validated_at: null });
      writeTask(fx, "fn-1-clean.1", {});
      const res = runHarness(fx.dataDir, "setter-clean");
      expect(res.exitCode).toBe(0);
      // The per-verb apply landed its structural write...
      expect(readFileSync(join(fx.dir, "applied.txt"), "utf-8")).toBe(
        "setter-clean",
      );
      // ...and the marker was NOT armed — a ghost stays a ghost through the gate.
      expect(
        readEpicJson(fx.dataDir, "fn-1-clean").last_validated_at ?? null,
      ).toBeNull();
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("runSetter: an armed epic's marker is byte-identical after a clean setter", () => {
    const fx = makeFixture();
    try {
      const armed = "2020-05-05T05:05:05.000000Z";
      writeEpic(fx, "fn-1-armed", { last_validated_at: armed });
      writeTask(fx, "fn-1-armed.1", {});
      const res = runHarness(fx.dataDir, "armed-preserved");
      expect(res.exitCode).toBe(0);
      expect(readFileSync(join(fx.dir, "applied.txt"), "utf-8")).toBe(
        "armed-preserved",
      );
      // The gate never refreshes an armed marker — it is exactly the prior value,
      // not merely non-null (the frozen clock would be 2026-06-06 if it re-stamped).
      expect(readEpicJson(fx.dataDir, "fn-1-armed").last_validated_at).toBe(
        armed,
      );
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("integrity-gate failure is fail-forward: write lands, marker untouched, exit 1", () => {
    const fx = makeFixture();
    try {
      writeEpic(fx, "fn-1-ff", { last_validated_at: null });
      writeTask(fx, "fn-1-ff.1", {});
      writeTask(fx, "fn-1-ff.2", {});
      // The harness deletes .2's spec (a deterministic integrity error) AFTER
      // its structural write, so the post-write gate fails.
      const res = runHarness(fx.dataDir, "setter-fail-forward");
      expect(res.exitCode).toBe(1);
      const env = JSON.parse(res.stdout.trim().split("\n").pop() as string);
      expect(env.success).toBe(false);
      expect(env.error.code).toBe("integrity_failed");
      expect(env.error.message).toContain("produced an invalid epic tree");
      expect(
        env.error.details.some((d: string) => d.includes("fn-1-ff.2")),
      ).toBe(true);
      // Fail-FORWARD: the structural write stayed on disk...
      expect(readFileSync(join(fx.dir, "applied.txt"), "utf-8")).toBe(
        "setter-fail-forward",
      );
      // ...and the marker (null) was never touched.
      expect(readEpicJson(fx.dataDir, "fn-1-ff").last_validated_at).toBeNull();
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("add-dep rollback hook restores prior epic state on an introduced cycle", () => {
    const fx = makeFixture();
    try {
      // fn-2 -> fn-1 already wired; the harness adds fn-1 -> fn-2 (closes the
      // cycle), which the post-write gate rejects, firing the rollback.
      writeEpic(fx, "fn-1-cyc", {
        depends_on_epics: [],
        last_validated_at: null,
      });
      writeTask(fx, "fn-1-cyc.1", {});
      writeEpic(fx, "fn-2-cyc", {
        depends_on_epics: ["fn-1-cyc"],
        last_validated_at: null,
      });
      writeTask(fx, "fn-2-cyc.1", {});
      const res = runHarness(fx.dataDir, "add-dep-cycle");
      expect(res.exitCode).toBe(1);
      const env = JSON.parse(res.stdout.trim().split("\n").pop() as string);
      expect(env.error.code).toBe("integrity_failed");
      // Rollback: fn-1's dep list restored to the pre-write empty state.
      expect(readEpicJson(fx.dataDir, "fn-1-cyc").depends_on_epics).toEqual([]);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("set-target-repo pre-gate hook recomputes touched_repos before the gate", () => {
    const fx = makeFixture();
    try {
      const repoA = join(fx.dir, "repo_a");
      const repoB = join(fx.dir, "repo_b");
      for (const r of [repoA, repoB]) {
        mkdirSync(join(r, ".git"), { recursive: true });
      }
      writeEpic(fx, "fn-1-str", {
        primary_repo: repoA,
        touched_repos: [repoA],
        last_validated_at: null,
      });
      writeTask(fx, "fn-1-str.1", { target_repo: repoA });
      writeTask(fx, "fn-1-str.2", { target_repo: repoA });
      // Harness repoints .1 at repoB and runs the pre-gate touched_repos
      // recompute -> touched becomes [repoA, repoB] sorted; the marker is untouched.
      const res = runHarness(fx.dataDir, "set-target-repo");
      expect(res.exitCode).toBe(0);
      const epic = readEpicJson(fx.dataDir, "fn-1-str");
      expect(epic.touched_repos).toEqual([repoA, repoB].sort());
      expect(epic.last_validated_at ?? null).toBeNull();
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });
});
