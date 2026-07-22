// The `epics` / `list` listing verbs default to an OPEN-FIRST composite so live
// work is never paged out behind hundreds of closed epics: open epics ascending
// by number, then done epics most-recent-first. A `--status open|done|all`
// filter selects a section; `--status all` is the named escape hatch that
// reproduces the historical flat ascending-by-number order for scripts that
// relied on it. Driven through the real CLI verb seams.

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { atomicWriteJson, loadJson } from "../src/store.ts";
import { parseCliOutput, runCli, seedState, withTmpdir } from "./harness.ts";

/** Seed a task-free epic, then stamp its status + updated_at so listing order
 * (recency for the done section) is deterministic. */
function seedEpic(
  root: string,
  epicId: string,
  status: string,
  updatedAt: string,
): void {
  seedState(root, { epicId, title: epicId, nTasks: 0 });
  const ep = join(root, ".keeper", "epics", `${epicId}.json`);
  const def = loadJson(ep);
  def.status = status;
  def.updated_at = updatedAt;
  atomicWriteJson(ep, def);
}

function ids(output: string): string[] {
  const env = parseCliOutput(output) as unknown as { epics: { id: string }[] };
  return env.epics.map((e) => e.id);
}

const OLD = "2026-01-01T00:00:00.000000Z";
const MID = "2026-02-01T00:00:00.000000Z";
const NEW = "2026-03-01T00:00:00.000000Z";

describe("epics listing is open-first by default", () => {
  const getTmp = withTmpdir("planctl-epics-order-");
  let root: string;
  beforeEach(() => {
    root = getTmp();
  });

  test("default listing surfaces open epics first and never pages them out at the default limit", () => {
    // 52 low-id DONE epics + 2 high-id OPEN epics — more done than the default
    // limit of 50, so the historical ascending order paged the open ones out.
    for (let i = 1; i <= 52; i += 1) {
      seedEpic(root, `fn-${i}-done`, "done", OLD);
    }
    seedEpic(root, "fn-90-live", "open", MID);
    seedEpic(root, "fn-91-live", "open", NEW);

    const env = parseCliOutput(
      runCli(["epics"], { cwd: root }).output,
    ) as unknown as {
      epics: { id: string; status: string }[];
      total: number;
      returned: number;
      truncated: boolean;
    };
    expect(env.total).toBe(54);
    expect(env.returned).toBe(50);
    expect(env.truncated).toBe(true);
    // The two open epics head the page, ascending by number, never truncated.
    expect(env.epics[0]?.id).toBe("fn-90-live");
    expect(env.epics[1]?.id).toBe("fn-91-live");
    expect(env.epics.slice(0, 2).every((e) => e.status === "open")).toBe(true);
  });

  test("--status open lists only open epics, ascending by number", () => {
    seedEpic(root, "fn-1-done", "done", OLD);
    seedEpic(root, "fn-5-live", "open", OLD);
    seedEpic(root, "fn-2-live", "open", OLD);
    const env = parseCliOutput(
      runCli(["epics", "--status", "open"], { cwd: root }).output,
    ) as unknown as { epics: { id: string }[]; total: number };
    expect(env.epics.map((e) => e.id)).toEqual(["fn-2-live", "fn-5-live"]);
    expect(env.total).toBe(2);
  });

  test("--status done lists only done epics, most-recent-first", () => {
    seedEpic(root, "fn-1-a", "done", OLD);
    seedEpic(root, "fn-2-b", "done", NEW);
    seedEpic(root, "fn-3-c", "done", MID);
    seedEpic(root, "fn-4-open", "open", NEW);
    const env = parseCliOutput(
      runCli(["epics", "--status", "done"], { cwd: root }).output,
    ) as unknown as { epics: { id: string }[]; total: number };
    expect(env.epics.map((e) => e.id)).toEqual(["fn-2-b", "fn-3-c", "fn-1-a"]);
    expect(env.total).toBe(3);
  });

  test("--status all reproduces the historical ascending-by-number order (escape hatch)", () => {
    seedEpic(root, "fn-3-done", "done", NEW);
    seedEpic(root, "fn-1-open", "open", OLD);
    seedEpic(root, "fn-2-done", "done", MID);
    // The pre-change default was a flat ascending-by-number sort regardless of
    // status; `--status all` is the named escape hatch that reproduces it, so a
    // script relying on the old order passes it explicitly.
    expect(
      ids(runCli(["epics", "--status", "all"], { cwd: root }).output),
    ).toEqual(["fn-1-open", "fn-2-done", "fn-3-done"]);
  });

  test("--limit/--offset page against the open-first default ordering", () => {
    seedEpic(root, "fn-10-open", "open", OLD);
    seedEpic(root, "fn-11-open", "open", MID);
    seedEpic(root, "fn-1-done", "done", NEW); // newest done
    seedEpic(root, "fn-2-done", "done", MID);
    // Composite order is every open epic first, then the done epics — the page
    // window below slices that ordering.
    const env = parseCliOutput(
      runCli(["epics", "--limit", "2", "--offset", "1"], { cwd: root }).output,
    ) as unknown as {
      epics: { id: string }[];
      total: number;
      returned: number;
      truncated: boolean;
    };
    expect(env.epics.map((e) => e.id)).toEqual(["fn-11-open", "fn-1-done"]);
    expect(env.total).toBe(4);
    expect(env.returned).toBe(2);
    expect(env.truncated).toBe(true);
  });

  test("an unrecognized --status value is exit-2 CLI misuse", () => {
    seedEpic(root, "fn-1-open", "open", OLD);
    const r = runCli(["epics", "--status", "bogus"], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("must be one of open, done, all");
  });

  test("the list (tree) verb shares the same ordering and escape hatch", () => {
    seedEpic(root, "fn-3-done", "done", NEW);
    seedEpic(root, "fn-1-open", "open", OLD);
    seedEpic(root, "fn-2-done", "done", MID);
    // Default: open leads.
    expect(ids(runCli(["list"], { cwd: root }).output)[0]).toBe("fn-1-open");
    // --status all: historical ascending, same as the epics verb.
    expect(
      ids(runCli(["list", "--status", "all"], { cwd: root }).output),
    ).toEqual(["fn-1-open", "fn-2-done", "fn-3-done"]);
  });
});
