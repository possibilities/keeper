// Default-deny SOURCE guard for the central plan-state resolver. Scans
// src/verbs/*.ts: any verb that touches runtime/audit STATE (constructs a
// LocalFileStateStore, writes an audit artifact, or builds a path under
// ctx.stateDir) MUST route that state through resolvePlanStateContext — UNLESS it
// is on an explicit display/DEF allowlist (read-for-display / def-only writers,
// which carry no primary-rooting concern) or on a SHRINKING temporary exempt-list
// of stateful verbs not yet migrated to the resolver. Anything else is a
// VIOLATION: a future verb added with a cwd-resolved state write fails here
// instead of silently writing lane-adjacent state in worktree mode.
//
// As later slices migrate their verbs (route them through resolvePlanStateContext
// OR the inline contextForRoot(primary_repo) precedent), each removes its entries
// from NOT_YET_MIGRATED — the list shrinks toward empty.

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

// The compliance signal: state routed through the central resolver.
const RESOLVER = /resolvePlanStateContext/;

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
  "mv_repo",
  "task_set_target_repo",
  "detect",
  "validate",
]);

// SHRINKING temporary exempt-list: stateful verbs not yet routed through the
// resolver (later slices migrate + remove them). close_preflight already routes
// state via the inline contextForRoot(primary_repo) precedent this seam lifts;
// the rest await their convergence slice.
const NOT_YET_MIGRATED = new Set([
  "claim",
  "done",
  "reconcile",
  "resolve_task",
  "worker_resume",
  "epic_close",
  "epic_rm",
  "audit_submit",
  "verdict_submit",
  "followup_submit",
  "close_preflight",
]);

type Verdict = "not-stateful" | "migrated" | "display" | "exempt" | "violation";

/** Classify a verb by name + source content. Default-deny: a stateful verb that
 * is neither resolver-routed nor allowlisted nor exempt is a violation. */
function classifyVerb(name: string, content: string): Verdict {
  if (!STATE_TOUCH.some((re) => re.test(content))) {
    return "not-stateful";
  }
  if (RESOLVER.test(content)) {
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
