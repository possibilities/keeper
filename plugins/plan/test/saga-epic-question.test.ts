// Conformance spec for `keeper plan epic-question <epic_id> "<text>" / --clear`
// — the epic-level parked-question runtime overlay verb. Mirrors block/unblock:
// mutates only the gitignored `state/epics/<id>.state.json` overlay, so it
// lands ZERO commits (a readonly invocation). No RPC involved — the plan CLI
// is the plan write path.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EPIC_QUESTION_MAX_CHARS } from "../src/verbs/epic_question.ts";
import {
  gitLogCount,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

// Read the gitignored epic runtime overlay a verb wrote.
function readEpicRuntime(
  root: string,
  epicId: string,
): Record<string, unknown> {
  const path = join(root, ".keeper", "state", "epics", `${epicId}.state.json`);
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("epic-question set/clear", () => {
  const getProj = withProject("planctl-epic-question-");

  test("set stamps the question, zero commit", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Question epic" });

    const before = gitLogCount(proj.root);
    const r = runCli(
      ["epic-question", epicId, "does the evidence check out?"],
      { cwd: proj.root, home: proj.home },
    );
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    expect(payload.epic_id).toBe(epicId);
    expect(payload.question).toBe("does the evidence check out?");

    const rt = readEpicRuntime(proj.root, epicId);
    expect(rt.question).toBe("does the evidence check out?");

    // Readonly verb — no commit lands.
    expect(gitLogCount(proj.root)).toBe(before);
    const inv = payload.plan_invocation as Record<string, unknown>;
    expect(inv.op).toBe("epic-question");
    expect(inv.subject).toBeNull();
    expect(inv.files).toBeNull();
  });

  test("a second set overwrites the prior question", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Question epic" });

    runCli(["epic-question", epicId, "first question"], {
      cwd: proj.root,
      home: proj.home,
    });
    const r = runCli(["epic-question", epicId, "second question"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(readEpicRuntime(proj.root, epicId).question).toBe("second question");
  });

  test("--clear nulls the question, zero commit", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Question epic" });

    runCli(["epic-question", epicId, "parked"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(readEpicRuntime(proj.root, epicId).question).toBe("parked");

    const before = gitLogCount(proj.root);
    const r = runCli(["epic-question", epicId, "--clear"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    expect(payload.question).toBeNull();
    expect(readEpicRuntime(proj.root, epicId).question).toBeNull();
    expect(gitLogCount(proj.root)).toBe(before);
  });

  test("--clear on a never-parked epic is a harmless no-op", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Question epic" });

    const r = runCli(["epic-question", epicId, "--clear"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(readEpicRuntime(proj.root, epicId).question).toBeNull();
  });
});

describe("epic-question typed errors", () => {
  const getProj = withProject("planctl-epic-question-err-");

  test("invalid epic id -> typed error, no write", () => {
    const proj = getProj();
    const r = runCli(["epic-question", "not-an-epic-id", "why?"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(parseCliOutput(r.output).success).toBe(false);
  });

  test("epic not found -> typed error", () => {
    const proj = getProj();
    const r = runCli(["epic-question", "fn-999-ghost", "why?"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(false);
    expect(payload.error as string).toContain("not found");
  });

  test("a task id is rejected (epic-only verb)", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "T", nTasks: 1 });
    const taskId = taskIds[0] as string;
    const r = runCli(["epic-question", taskId, "why?"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(parseCliOutput(r.output).success).toBe(false);
  });

  test("neither a question nor --clear -> typed error", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Question epic" });
    const r = runCli(["epic-question", epicId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(parseCliOutput(r.output).success).toBe(false);
  });

  test("both a question and --clear -> typed error", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Question epic" });
    const r = runCli(["epic-question", epicId, "why?", "--clear"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(parseCliOutput(r.output).success).toBe(false);
  });

  test("an empty/whitespace-only question -> typed error, no write", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Question epic" });
    const r = runCli(["epic-question", epicId, "   "], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(parseCliOutput(r.output).success).toBe(false);
  });

  test("a question exceeding the length cap -> typed error, no write", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Question epic" });
    const tooLong = "x".repeat(EPIC_QUESTION_MAX_CHARS + 1);
    const r = runCli(["epic-question", epicId, tooLong], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(false);
    expect(payload.error as string).toContain(String(EPIC_QUESTION_MAX_CHARS));
  });

  test("a question at exactly the length cap is accepted", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Question epic" });
    const atCap = "x".repeat(EPIC_QUESTION_MAX_CHARS);
    const r = runCli(["epic-question", epicId, atCap], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(readEpicRuntime(proj.root, epicId).question).toBe(atCap);
  });
});
