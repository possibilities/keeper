// Conformance spec for `keeper plan selection-review <epic_id> --set <json> /
// --clear` — the epic-level selection-review runtime overlay verb. Mirrors
// epic-question: mutates only the gitignored `state/epics/<id>.state.json`
// overlay, so it lands ZERO commits (a readonly invocation). No RPC involved —
// the plan CLI is the plan write path.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SELECTION_REVIEW_MAX_CHARS } from "../src/verbs/selection_review.ts";
import {
  gitLogCount,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

const PAYLOAD =
  '{"counts":{"underpowered":1,"right_sized":3,"overpowered":0},"reviewed_at":"2026-07-07T00:00:00Z"}';

// Read the gitignored epic runtime overlay a verb wrote.
function readEpicRuntime(
  root: string,
  epicId: string,
): Record<string, unknown> {
  const path = join(root, ".keeper", "state", "epics", `${epicId}.state.json`);
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("selection-review set/clear", () => {
  const getProj = withProject("planctl-selection-review-");

  test("set stamps the review payload, zero commit", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Review epic" });

    const before = gitLogCount(proj.root);
    const r = runCli(["selection-review", epicId, "--set", PAYLOAD], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    expect(payload.epic_id).toBe(epicId);
    expect(payload.selection_review).toBe(PAYLOAD);

    const rt = readEpicRuntime(proj.root, epicId);
    expect(rt.selection_review).toBe(PAYLOAD);

    // Readonly verb — no commit lands.
    expect(gitLogCount(proj.root)).toBe(before);
    const inv = payload.plan_invocation as Record<string, unknown>;
    expect(inv.op).toBe("selection-review");
    expect(inv.subject).toBeNull();
    expect(inv.files).toBeNull();
  });

  test("set preserves a sibling parked question in the overlay", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Review epic" });

    runCli(["epic-question", epicId, "parked?"], {
      cwd: proj.root,
      home: proj.home,
    });
    runCli(["selection-review", epicId, "--set", PAYLOAD], {
      cwd: proj.root,
      home: proj.home,
    });
    const rt = readEpicRuntime(proj.root, epicId);
    expect(rt.selection_review).toBe(PAYLOAD);
    expect(rt.question).toBe("parked?");
  });

  test("--clear nulls the review, zero commit", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Review epic" });

    runCli(["selection-review", epicId, "--set", PAYLOAD], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(readEpicRuntime(proj.root, epicId).selection_review).toBe(PAYLOAD);

    const before = gitLogCount(proj.root);
    const r = runCli(["selection-review", epicId, "--clear"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    expect(payload.selection_review).toBeNull();
    expect(readEpicRuntime(proj.root, epicId).selection_review).toBeNull();
    expect(gitLogCount(proj.root)).toBe(before);
  });
});

describe("selection-review typed errors", () => {
  const getProj = withProject("planctl-selection-review-err-");

  test("invalid epic id -> typed error, no write", () => {
    const proj = getProj();
    const r = runCli(["selection-review", "not-an-epic-id", "--set", PAYLOAD], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(parseCliOutput(r.output).success).toBe(false);
  });

  test("epic not found -> typed error", () => {
    const proj = getProj();
    const r = runCli(["selection-review", "fn-999-ghost", "--set", PAYLOAD], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(false);
    expect(payload.error as string).toContain("not found");
  });

  test("neither --set nor --clear -> typed error", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Review epic" });
    const r = runCli(["selection-review", epicId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(parseCliOutput(r.output).success).toBe(false);
  });

  test("both --set and --clear -> typed error", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Review epic" });
    const r = runCli(
      ["selection-review", epicId, "--set", PAYLOAD, "--clear"],
      { cwd: proj.root, home: proj.home },
    );
    expect(r.code).not.toBe(0);
    expect(parseCliOutput(r.output).success).toBe(false);
  });

  test("malformed JSON payload -> typed error, no write", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Review epic" });
    const r = runCli(["selection-review", epicId, "--set", "{not json"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(false);
    expect(payload.error as string).toContain("valid JSON");
  });

  test("a payload exceeding the length cap -> typed error, no write", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Review epic" });
    // A valid JSON string longer than the cap.
    const tooLong = `"${"x".repeat(SELECTION_REVIEW_MAX_CHARS)}"`;
    const r = runCli(["selection-review", epicId, "--set", tooLong], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(false);
    expect(payload.error as string).toContain(
      String(SELECTION_REVIEW_MAX_CHARS),
    );
  });

  test("a payload at exactly the length cap is accepted", () => {
    const proj = getProj();
    const { epicId } = scaffoldEpic(proj, { title: "Review epic" });
    // Build a valid JSON string of exactly SELECTION_REVIEW_MAX_CHARS chars:
    // `"` + (cap-2) filler + `"`.
    const atCap = `"${"x".repeat(SELECTION_REVIEW_MAX_CHARS - 2)}"`;
    expect(atCap.length).toBe(SELECTION_REVIEW_MAX_CHARS);
    const r = runCli(["selection-review", epicId, "--set", atCap], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(readEpicRuntime(proj.root, epicId).selection_review).toBe(atCap);
  });
});
