// Default-deny SOURCE guard for the central plan-state resolver. Scans
// src/verbs/*.ts: any verb that touches runtime/audit STATE (constructs a
// LocalFileStateStore, writes an audit artifact, or builds a path under
// ctx.stateDir) MUST root that state at the epic's primary_repo through one of the
// sanctioned seams — UNLESS it is on an explicit display/DEF allowlist
// (read-for-display / def-only writers, which carry no primary-rooting concern).
// Anything else is a VIOLATION: a future verb added with a cwd-resolved state
// write fails here instead of silently writing lane-adjacent state in worktree
// mode.
//
// The exempt-list is empty: every stateful verb is routed. A new stateful verb
// either routes through the seam (or the documented inline precedent) or fails
// here; a temporary exemption would be re-added to NOT_YET_MIGRATED only as a
// deliberate, named stopgap.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VERBS_DIR = join(import.meta.dir, "..", "src", "verbs");

// Signals that a verb file does runtime/audit STATE work (read OR write).
const STATE_TOUCH = [
  /new LocalFileStateStore\(/,
  /\.stateDir\b/,
  /\bwriteArtifact\(/,
  /\bwriteBriefArtifact\(/,
];

// The compliance signals: state rooted at the epic's primary_repo through a
// sanctioned seam — the central resolver directly (resolvePlanStateContext), the
// submit verbs' shared brief-resolver (resolveAuditContext, itself routed through
// the resolver), or the inline contextForRoot(primaryRepo) precedent the resolver
// was lifted from (close-preflight / close-finalize thread it off the epic def).
const COMPLIANT = [
  /resolvePlanStateContext/,
  /resolveAuditContext/,
  /contextForRoot\(primaryRepo\)/,
];

// Display / DEF verbs: they read state for DISPLAY or write only committed defs,
// so they carry no primary-rooting concern and are explicitly exempt.
const DISPLAY_DEF_ALLOW = new Set([
  "cat",
  "show",
  "list",
  "status",
  "ready",
  "epics",
  "tasks",
  "state_path",
  "refine_context",
  "find_task_commit",
  "scaffold",
  "refine_apply",
  // assign-cells reads runtime status ONLY to validate the todo-only + full-set
  // contract (a read-for-decision, like tasks/ready), and writes only committed
  // DEFS (task tier/model) + a committed selection sidecar (like refine_apply /
  // scaffold). It runs in the pre-arm ghost window before any lane is cut, so it
  // carries no primary-rooting concern — a def-only writer + status reader.
  "assign_cells",
  "mv_repo",
  "task_set_target_repo",
  "detect",
  "validate",
]);

// Temporary exempt-list — EMPTY: every stateful verb is routed through a
// sanctioned seam. Re-add a name here only as a deliberate, named stopgap for a
// verb mid-migration; the guard is otherwise fully strict.
const NOT_YET_MIGRATED = new Set<string>([]);

type Verdict = "not-stateful" | "migrated" | "display" | "exempt" | "violation";

/** Classify a verb by name + source content. Default-deny: a stateful verb that
 * is neither resolver-routed nor allowlisted nor exempt is a violation. */
function classifyVerb(name: string, content: string): Verdict {
  if (!STATE_TOUCH.some((re) => re.test(content))) {
    return "not-stateful";
  }
  if (COMPLIANT.some((re) => re.test(content))) {
    return "migrated";
  }
  if (DISPLAY_DEF_ALLOW.has(name)) {
    return "display";
  }
  if (NOT_YET_MIGRATED.has(name)) {
    return "exempt";
  }
  return "violation";
}

function verbFiles(): Array<{ name: string; content: string }> {
  return readdirSync(VERBS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({
      name: f.slice(0, -".ts".length),
      content: readFileSync(join(VERBS_DIR, f), "utf-8"),
    }));
}

describe("default-deny plan-state resolver source guard", () => {
  test("every stateful verb is resolver-routed, allowlisted, or exempt", () => {
    const violations = verbFiles()
      .filter((f) => classifyVerb(f.name, f.content) === "violation")
      .map((f) => f.name);
    expect(violations).toEqual([]);
  });

  test("block / unblock / task_reset are detected as resolver-migrated", () => {
    const byName = new Map(verbFiles().map((f) => [f.name, f.content]));
    for (const name of ["block", "unblock", "task_reset"]) {
      expect(classifyVerb(name, byName.get(name) as string)).toBe("migrated");
    }
  });

  test("the migrated trio has graduated off both exempt + display lists", () => {
    for (const name of ["block", "unblock", "task_reset"]) {
      expect(NOT_YET_MIGRATED.has(name)).toBe(false);
      expect(DISPLAY_DEF_ALLOW.has(name)).toBe(false);
    }
  });

  test("a synthetic verb touching state without the resolver is a VIOLATION", () => {
    const synthetic =
      "export function runFrobnicate(): void {\n" +
      "  const store = new LocalFileStateStore(ctx.stateDir);\n" +
      "  store.saveRuntime(taskId, {});\n}\n";
    expect(classifyVerb("frobnicate", synthetic)).toBe("violation");
    // The same body becomes compliant once it routes through the resolver.
    const fixed = `import { resolvePlanStateContext } from "../project.ts";\n${synthetic}`;
    expect(classifyVerb("frobnicate", fixed)).toBe("migrated");
  });

  test("exempt + allowlist entries name real verb files (no stale entries)", () => {
    const names = new Set(verbFiles().map((f) => f.name));
    for (const name of NOT_YET_MIGRATED) {
      expect(names.has(name)).toBe(true);
    }
  });
});
