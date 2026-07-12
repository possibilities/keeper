// Unit tests for plugin/hooks/state-read-guard.ts.
//
// Two layers: (1) the pure path/command classifiers exercised in-process, and
// (2) the decision ladder driven through a real subprocess against a temp HOME
// (session markers) and temp project tree (briefs/audits paths), mirroring
// commit-guard.test.ts's subprocess discipline.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commandTouchesStateTree,
  isProtectedStatePath,
} from "../plugin/hooks/state-read-guard.ts";

describe("isProtectedStatePath", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "keeper-plan-state-guard-path-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("an absolute briefs path is protected", () => {
    const dir = join(root, ".keeper", "state", "briefs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "fn-1.2.json");
    writeFileSync(file, "{}", "utf-8");
    expect(isProtectedStatePath(file, root)).toBe(true);
  });

  test("an absolute audits path is protected", () => {
    const dir = join(root, ".keeper", "state", "audits", "fn-1");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "brief.json");
    writeFileSync(file, "{}", "utf-8");
    expect(isProtectedStatePath(file, root)).toBe(true);
  });

  test("a relative path resolves against cwd", () => {
    const dir = join(root, ".keeper", "state", "audits", "fn-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "brief.json"), "{}", "utf-8");
    expect(
      isProtectedStatePath(".keeper/state/audits/fn-1/brief.json", root),
    ).toBe(true);
  });

  test("a non-existent path (Write target) still classifies from the syntactic path", () => {
    const dir = join(root, ".keeper", "state", "briefs");
    expect(isProtectedStatePath(join(dir, "new.json"), root)).toBe(true);
  });

  test("a symlink that resolves into the audits tree is protected", () => {
    const dir = join(root, ".keeper", "state", "audits", "fn-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "brief.json"), "{}", "utf-8");
    const link = join(root, "sneaky-link.json");
    symlinkSync(join(dir, "brief.json"), link);
    expect(isProtectedStatePath(link, root)).toBe(true);
  });

  test("an unrelated file is not protected", () => {
    const file = join(root, "README.md");
    writeFileSync(file, "hi", "utf-8");
    expect(isProtectedStatePath(file, root)).toBe(false);
  });

  test("a sibling task JSON outside state/ is not protected", () => {
    const dir = join(root, ".keeper", "tasks");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "fn-1.2.json");
    writeFileSync(file, "{}", "utf-8");
    expect(isProtectedStatePath(file, root)).toBe(false);
  });

  test("empty path is not protected", () => {
    expect(isProtectedStatePath("", root)).toBe(false);
  });
});

describe("commandTouchesStateTree", () => {
  test("a cat of a briefs path is detected", () => {
    expect(
      commandTouchesStateTree("cat .keeper/state/briefs/fn-1.2.json"),
    ).toBe(true);
  });

  test("a cat of an audits path is detected", () => {
    expect(
      commandTouchesStateTree("cat .keeper/state/audits/fn-1/brief.json"),
    ).toBe(true);
  });

  test("an unrelated command is not detected", () => {
    expect(commandTouchesStateTree("git status")).toBe(false);
  });

  test("a command touching a sibling .keeper dir is not detected", () => {
    expect(commandTouchesStateTree("cat .keeper/tasks/fn-1.2.json")).toBe(
      false,
    );
  });

  test("a grep of a briefs path is detected", () => {
    expect(
      commandTouchesStateTree(
        "grep finding_ref .keeper/state/briefs/fn-1.2.json",
      ),
    ).toBe(true);
  });

  test("the sanctioned keeper plan AUDIT_SEVERE block is exempt", () => {
    expect(
      commandTouchesStateTree(
        'keeper plan block fn-1.2 --reason "AUDIT_SEVERE: finding_ref=.keeper/state/audits/fn-1/tasks/fn-1.2.json"',
      ),
    ).toBe(false);
  });

  test("a keeper plan seam chained to a tree read is NOT exempt", () => {
    expect(
      commandTouchesStateTree(
        "keeper plan block fn-1.2 --reason x && cat .keeper/state/audits/fn-1/tasks/fn-1.2.json",
      ),
    ).toBe(true);
  });

  test("an AUDIT_SEVERE block whose reason prose holds a shell-inert metachar stays exempt", () => {
    for (const ch of [">", "<", "&", "|", ";"]) {
      expect(
        commandTouchesStateTree(
          `keeper plan block fn-1.2 --reason "AUDIT_SEVERE: timeout ${ch} 5s regresses (finding_ref=.keeper/state/audits/fn-1/tasks/fn-1.2.json)"`,
        ),
      ).toBe(false);
    }
  });

  test("a real chain after the closed reason quote still forfeits the exemption", () => {
    expect(
      commandTouchesStateTree(
        'keeper plan block fn-1.2 --reason "AUDIT_SEVERE: prose" && cat .keeper/state/audits/fn-1/tasks/fn-1.2.json',
      ),
    ).toBe(true);
  });

  test("a command substitution inside the reason value still forfeits the exemption", () => {
    for (const sub of [
      '"$(cat .keeper/state/audits/fn-1/tasks/fn-1.2.json)"',
      '"`cat .keeper/state/audits/fn-1/tasks/fn-1.2.json`"',
    ]) {
      expect(
        commandTouchesStateTree(`keeper plan block fn-1.2 --reason ${sub}`),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// decision ladder — subprocess, temp HOME (markers) + temp project (paths)
// ---------------------------------------------------------------------------

const GUARD = join(
  import.meta.dir,
  "..",
  "plugin",
  "hooks",
  "state-read-guard.ts",
);

let home: string;
let sessionsDir: string;
let project: string;
let briefFile: string;
let auditFile: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keeper-plan-state-guard-home-"));
  sessionsDir = join(home, ".local", "state", "keeper", "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  project = mkdtempSync(join(tmpdir(), "keeper-plan-state-guard-proj-"));
  const briefsDir = join(project, ".keeper", "state", "briefs");
  mkdirSync(briefsDir, { recursive: true });
  briefFile = join(briefsDir, "fn-1-x.2.json");
  writeFileSync(briefFile, "{}", "utf-8");

  const auditsDir = join(project, ".keeper", "state", "audits", "fn-1-x");
  mkdirSync(auditsDir, { recursive: true });
  auditFile = join(auditsDir, "brief.json");
  writeFileSync(auditFile, "{}", "utf-8");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const SESSION = "sess-state-read";

function writeMarker(
  kind: "work" | "close",
  idField: Record<string, string>,
): void {
  writeFileSync(
    join(sessionsDir, `${SESSION}.json`),
    JSON.stringify({
      schema_version: 1,
      session_id: SESSION,
      kind,
      ...idField,
      created_at: "2026-06-11T00:00:00Z",
    }),
    "utf-8",
  );
}

async function run(
  payload: unknown,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn(["bun", GUARD], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home, ...extraEnv },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { stdout, code };
}

function readPayload(extra: Record<string, unknown> = {}): unknown {
  return {
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    tool_name: "Read",
    cwd: project,
    tool_input: { file_path: briefFile },
    ...extra,
  };
}

describe("state-read-guard ladder", () => {
  test("a marker-active work orchestrator's Read of a briefs path denies", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout, code } = await run(readPayload());
    expect(code).toBe(0);
    const env = JSON.parse(stdout.trim());
    expect(env.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(env.hookSpecificOutput.permissionDecisionReason).toContain("Read");
  });

  test("a marker-active close orchestrator's Read of an audits path denies", async () => {
    writeMarker("close", { epic_id: "fn-1-x" });
    const { stdout, code } = await run(
      readPayload({ tool_input: { file_path: auditFile } }),
    );
    expect(code).toBe(0);
    expect(
      JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  test("a Write of a briefs path denies", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout } = await run(
      readPayload({ tool_name: "Write", tool_input: { file_path: briefFile } }),
    );
    expect(
      JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  test("an Edit of an audits path denies", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout } = await run(
      readPayload({ tool_name: "Edit", tool_input: { file_path: auditFile } }),
    );
    expect(
      JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  test("agent_id present allows regardless of marker/path", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout, code } = await run(readPayload({ agent_id: "agent-7" }));
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("a non-marker session allows", async () => {
    const { stdout } = await run(readPayload());
    expect(stdout).toBe("");
  });

  test("a Read of a path outside the state trees allows", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const other = join(project, "README.md");
    writeFileSync(other, "hi", "utf-8");
    const { stdout } = await run(
      readPayload({ tool_input: { file_path: other } }),
    );
    expect(stdout).toBe("");
  });

  test("a Bash cat vector against a briefs path denies", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout, code } = await run({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Bash",
      cwd: project,
      tool_input: { command: "cat .keeper/state/briefs/fn-1-x.2.json" },
    });
    expect(code).toBe(0);
    expect(
      JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  test("a Bash keeper plan AUDIT_SEVERE block vector allows despite the audits token", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout, code } = await run({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Bash",
      cwd: project,
      tool_input: {
        command:
          'keeper plan block fn-1-x.2 --reason "AUDIT_SEVERE: finding_ref=.keeper/state/audits/fn-1-x/tasks/fn-1-x.2.json"',
      },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("a Bash keeper plan seam chained to a tree read denies", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout, code } = await run({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Bash",
      cwd: project,
      tool_input: {
        command:
          "keeper plan reconcile fn-1-x.2 && cat .keeper/state/audits/fn-1-x/tasks/fn-1-x.2.json",
      },
    });
    expect(code).toBe(0);
    expect(
      JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  test("a Bash AUDIT_SEVERE block whose reason prose holds a shell-inert metachar allows", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout, code } = await run({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Bash",
      cwd: project,
      tool_input: {
        command:
          'keeper plan block fn-1-x.2 --reason "AUDIT_SEVERE: timeout > 5s regresses; see .keeper/state/audits/fn-1-x/tasks/fn-1-x.2.json"',
      },
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  test("a Bash keeper plan seam with a real chain after the closed reason quote denies", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout, code } = await run({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Bash",
      cwd: project,
      tool_input: {
        command:
          'keeper plan block fn-1-x.2 --reason "AUDIT_SEVERE: prose" && cat .keeper/state/audits/fn-1-x/tasks/fn-1-x.2.json',
      },
    });
    expect(code).toBe(0);
    expect(
      JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  test("a Bash command with no state-tree token allows", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout } = await run({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      tool_name: "Bash",
      cwd: project,
      tool_input: { command: "git status" },
    });
    expect(stdout).toBe("");
  });

  test("bypass allows before any I/O", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout } = await run(readPayload(), {
      KEEPER_PLAN_GUARD_BYPASS: "1",
    });
    expect(stdout).toBe("");
  });

  test("a non-guarded tool_name passes untouched", async () => {
    writeMarker("work", { task_id: "fn-1-x.2" });
    const { stdout } = await run(
      readPayload({ tool_name: "Grep", tool_input: { pattern: "x" } }),
    );
    expect(stdout).toBe("");
  });

  test("unparseable stdin fails open", async () => {
    const proc = Bun.spawn(["bun", GUARD], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    });
    proc.stdin.write("{not json");
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});
