// Whole-board `validate` tolerates the debris a DONE epic accretes as history —
// retired repo paths (primary_repo / touched_repos) and dangling cross-epic
// deps — degrading them to WARNINGS so the board stays green on things no
// epic-file rewrite could repair. A LIVE (open) epic with the identical debris
// stays RED with byte-identical error strings. Driven through the real CLI
// `validate` verb seam (no --epic → no marker arm, no commit).

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { atomicWriteJson, loadJson } from "../src/store.ts";
import { parseCliOutput, runCli, seedState, withTmpdir } from "./harness.ts";

interface ValidateEnvelope {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Seed a task-free epic, then stamp it with a retired repo path + a dangling
 * cross-epic dep at the requested status. Task-free keeps the epic-done
 * coherence check silent so only the debris is under test. */
function seedDebrisEpic(root: string, epicId: string, status: string): void {
  seedState(root, { epicId, title: "History", nTasks: 0 });
  const ep = join(root, ".keeper", "epics", `${epicId}.json`);
  const def = loadJson(ep);
  def.status = status;
  def.primary_repo = "/no/such/retired/repo";
  def.touched_repos = ["/no/such/retired/repo"];
  def.depends_on_epics = ["fn-999-ghost"];
  atomicWriteJson(ep, def);
}

describe("validate tolerates done-epic history debris", () => {
  const getTmp = withTmpdir("planctl-validate-hist-");
  let root: string;
  beforeEach(() => {
    root = getTmp();
  });

  test("whole-board validate on a DONE epic → exit 0 with warnings naming the debris", () => {
    seedDebrisEpic(root, "fn-1-hist", "done");
    const r = runCli(["validate"], { cwd: root });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output) as unknown as ValidateEnvelope;
    expect(env.valid).toBe(true);
    expect(env.errors).toEqual([]);
    expect(env.warnings).toContain(
      "Epic fn-1-hist: dependency fn-999-ghost does not exist",
    );
    expect(env.warnings).toContain(
      "Epic fn-1-hist: primary_repo: path does not exist: /no/such/retired/repo",
    );
    expect(env.warnings).toContain(
      "Epic fn-1-hist: touched_repos entry: path does not exist: /no/such/retired/repo",
    );
  });

  test("whole-board validate on a LIVE epic with the same debris → exit 1, byte-identical errors", () => {
    seedDebrisEpic(root, "fn-1-live", "open");
    const r = runCli(["validate"], { cwd: root });
    expect(r.code).toBe(1);
    const env = parseCliOutput(r.output) as unknown as ValidateEnvelope;
    expect(env.valid).toBe(false);
    expect(env.warnings).toEqual([]);
    expect(env.errors).toContain(
      "Epic fn-1-live: dependency fn-999-ghost does not exist",
    );
    expect(env.errors).toContain(
      "Epic fn-1-live: primary_repo: path does not exist: /no/such/retired/repo",
    );
    expect(env.errors).toContain(
      "Epic fn-1-live: touched_repos entry: path does not exist: /no/such/retired/repo",
    );
  });

  test("a done epic alongside a clean live epic keeps the whole board green", () => {
    seedDebrisEpic(root, "fn-1-hist", "done");
    seedState(root, { epicId: "fn-2-live", title: "Live", nTasks: 1 });
    const r = runCli(["validate"], { cwd: root });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output) as unknown as ValidateEnvelope;
    expect(env.valid).toBe(true);
    expect(env.errors).toEqual([]);
    // The done epic's debris still surfaces as warnings.
    expect(env.warnings).toContain(
      "Epic fn-1-hist: dependency fn-999-ghost does not exist",
    );
  });
});
