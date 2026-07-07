// Unit tests for src/brief.ts (assemble + byte-parity write) and the
// workerAgentFor / isTaskId / epicIdFromTask gate helpers — all in-process.
// The claim/block ZERO-commit guarantee + byte-equal runtime sidecar are owned
// in-process by verbs-worker.test.ts (fake-VCS gitLogCount delta + runtime
// read-back); the brief_ref handle is owned by saga-claim.test.ts.

import { describe, expect, test } from "bun:test";
import {
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
  assembleBrief,
  BRIEF_SCHEMA_VERSION,
  writeBrief,
} from "../src/brief.ts";
import { epicIdFromTask, isTaskId } from "../src/ids.ts";
import { workerAgentFor } from "../src/models.ts";
import { serializeStateJson } from "../src/store.ts";

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("gate helpers", () => {
  test("isTaskId: task ids true, epic / garbage false", () => {
    expect(isTaskId("fn-1-add-auth.3")).toBe(true);
    expect(isTaskId("fn-12-x.10")).toBe(true);
    expect(isTaskId("fn-1-add-auth")).toBe(false); // epic id
    expect(isTaskId("not-a-task")).toBe(false);
  });

  test("epicIdFromTask strips the final segment; throws on a non-task", () => {
    expect(epicIdFromTask("fn-1-add-auth.3")).toBe("fn-1-add-auth");
    expect(epicIdFromTask("fn-30-bun.12")).toBe("fn-30-bun");
    expect(() => epicIdFromTask("fn-1-add-auth")).toThrow();
  });

  test("workerAgentFor: {tier,model} member -> agent, either null -> null, bad -> throw", () => {
    expect(workerAgentFor("medium", "opus")).toBe("plan:worker-opus-medium");
    expect(workerAgentFor("xhigh", "opus")).toBe("plan:worker-opus-xhigh");
    expect(workerAgentFor(null, "opus")).toBeNull();
    expect(workerAgentFor("medium", null)).toBeNull();
    expect(workerAgentFor(null, null)).toBeNull();
    expect(() => workerAgentFor("turbo", "opus")).toThrow();
    expect(() => workerAgentFor("medium", "gpt")).toThrow();
  });
});

describe("brief assemble + write", () => {
  test("assembleBrief carries the stable key set incl. empty snippet_context", () => {
    const dataDir = tmp("planctl-brief-");
    try {
      const brief = assembleBrief({
        taskId: "fn-1-x.1",
        epicId: "fn-1-x",
        targetRepo: "/repo",
        primaryRepo: "/repo",
        stateRepo: "/repo",
        tier: "high",
        auditRequired: false,
        dataDir,
      });
      expect(brief.schema_version).toBe(BRIEF_SCHEMA_VERSION);
      expect(brief.task_id).toBe("fn-1-x.1");
      expect(brief.epic_id).toBe("fn-1-x");
      expect(brief.tier).toBe("high");
      expect(brief.snippet_context).toBe(""); // present, not omitted
      // audit_required is a stable key, present even when unflagged.
      expect("audit_required" in brief).toBe(true);
      expect(brief.audit_required).toBe(false);
      // Missing specs -> empty markdown, never a throw.
      expect(brief.task_spec_md).toBe("");
      expect(brief.epic_spec_md).toBe("");
      // Absent CONTEXT.md -> present-but-empty glossary (stable key set).
      expect("glossary_md" in brief).toBe(true);
      expect(brief.glossary_md).toBe("");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("assembleBrief carries audit_required=true when the task is flagged", () => {
    const dataDir = tmp("planctl-brief-flag-");
    try {
      const brief = assembleBrief({
        taskId: "fn-1-x.1",
        epicId: "fn-1-x",
        targetRepo: "/repo",
        primaryRepo: "/repo",
        stateRepo: "/repo",
        tier: "max",
        auditRequired: true,
        dataDir,
      });
      expect(brief.audit_required).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("assembleBrief reads the target repo's CONTEXT.md verbatim", () => {
    const repo = tmp("planctl-glossary-");
    const dataDir = tmp("planctl-glossary-data-");
    try {
      const glossary = "## Glossary\n\n**Lane**: a worktree checkout.\n";
      writeFileSync(join(repo, "CONTEXT.md"), glossary);
      const brief = assembleBrief({
        taskId: "fn-1-x.1",
        epicId: "fn-1-x",
        targetRepo: repo,
        primaryRepo: repo,
        stateRepo: repo,
        tier: "high",
        auditRequired: false,
        dataDir,
      });
      expect(brief.glossary_md).toBe(glossary);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("assembleBrief sources the glossary from targetRepo, not primaryRepo", () => {
    const target = tmp("planctl-glossary-t-");
    const primary = tmp("planctl-glossary-p-");
    try {
      // The worker edits the target repo's code -> its glossary must win.
      writeFileSync(join(target, "CONTEXT.md"), "target glossary\n");
      writeFileSync(join(primary, "CONTEXT.md"), "primary glossary\n");
      const brief = assembleBrief({
        taskId: "fn-1-x.1",
        epicId: "fn-1-x",
        targetRepo: target,
        primaryRepo: primary,
        stateRepo: primary,
        tier: null,
        auditRequired: false,
        dataDir: primary,
      });
      expect(brief.glossary_md).toBe("target glossary\n");
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(primary, { recursive: true, force: true });
    }
  });

  test("assembleBrief caps an oversize glossary at a line boundary with a marker", () => {
    const repo = tmp("planctl-glossary-big-");
    try {
      // 101-byte lines * 200 = 20200 bytes > the 16 KiB (16384) cap. The cap
      // slice (first 16384 bytes) spans 162 whole lines (16362 bytes) plus a
      // 22-byte partial line 163; truncation backs up to the last newline, so
      // exactly 162 whole lines survive. Constants hand-computed from the input,
      // independent of the code path under test.
      const line = `${"x".repeat(100)}\n`; // 101 bytes
      writeFileSync(join(repo, "CONTEXT.md"), line.repeat(200));
      const brief = assembleBrief({
        taskId: "fn-1-x.1",
        epicId: "fn-1-x",
        targetRepo: repo,
        primaryRepo: repo,
        stateRepo: repo,
        tier: "high",
        auditRequired: false,
        dataDir: repo,
      });
      const g = brief.glossary_md as string;
      const expectedBody = line.repeat(162); // 16362 bytes, ends on a newline
      const marker =
        "[glossary truncated at 16KiB — read CONTEXT.md for the full text]\n";
      expect(Buffer.byteLength(expectedBody, "utf-8")).toBe(16362);
      expect(g).toBe(expectedBody + marker);
      // The retained body stays within the cap and ends cleanly on a line.
      expect(Buffer.byteLength(expectedBody, "utf-8")).toBeLessThanOrEqual(
        16 * 1024,
      );
      expect(expectedBody.endsWith("\n")).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("assembleBrief reads spec markdown when present", () => {
    const dataDir = tmp("planctl-brief2-");
    try {
      mkdirSync(join(dataDir, "specs"), { recursive: true });
      writeFileSync(join(dataDir, "specs", "fn-1-x.1.md"), "## Task\nbody\n");
      writeFileSync(join(dataDir, "specs", "fn-1-x.md"), "## Epic\nover\n");
      const brief = assembleBrief({
        taskId: "fn-1-x.1",
        epicId: "fn-1-x",
        targetRepo: "/r",
        primaryRepo: "/r",
        stateRepo: "/r",
        tier: null,
        auditRequired: false,
        dataDir,
      });
      expect(brief.task_spec_md).toBe("## Task\nbody\n");
      expect(brief.epic_spec_md).toBe("## Epic\nover\n");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("writeBrief output is byte-identical to the frozen serialization", () => {
    const briefsDir = tmp("planctl-briefw-");
    try {
      const brief = assembleBrief({
        taskId: "fn-1-x.1",
        epicId: "fn-1-x",
        targetRepo: "/r",
        primaryRepo: "/r",
        stateRepo: "/r",
        tier: "max",
        auditRequired: true,
        dataDir: briefsDir,
      });
      const ref = writeBrief(briefsDir, "fn-1-x.1", brief);
      expect(ref).toBe(realpathSync(join(briefsDir, "fn-1-x.1.json")));
      expect(readFileSync(ref, "utf-8")).toBe(serializeStateJson(brief));
    } finally {
      rmSync(briefsDir, { recursive: true, force: true });
    }
  });
});
