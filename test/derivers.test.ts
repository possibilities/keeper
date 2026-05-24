/**
 * Pure-deriver tests. These exercise the parsers in `src/derivers.ts`
 * directly — no DB, no migration. The hook, the reducer, and the migration
 * backfill all share these derivers, so the same input MUST produce the same
 * output across all three call sites (re-fold determinism).
 */

import { expect, test } from "bun:test";
import {
  extractPlanctlInvocation,
  isKilledTaskNotification,
  parsePlanRef,
} from "../src/derivers";

// ---------------------------------------------------------------------------
// parsePlanRef
// ---------------------------------------------------------------------------

test("parsePlanRef parses an epic-form ref", () => {
  expect(parsePlanRef("fn-575-osc-parser")).toEqual({
    kind: "epic",
    epic_id: "fn-575-osc-parser",
  });
});

test("parsePlanRef parses a task-form ref into epic_id + task_id", () => {
  expect(parsePlanRef("fn-575-osc-parser.3")).toEqual({
    kind: "task",
    epic_id: "fn-575-osc-parser",
    task_id: "fn-575-osc-parser.3",
  });
});

test("parsePlanRef parses a multi-digit task ordinal", () => {
  expect(parsePlanRef("fn-1-foo.42")).toEqual({
    kind: "task",
    epic_id: "fn-1-foo",
    task_id: "fn-1-foo.42",
  });
});

test("parsePlanRef returns null on a trailing dot with no ordinal", () => {
  // `fn-1-foo.` — the optional dot-group requires `\d+` after the dot.
  expect(parsePlanRef("fn-1-foo.")).toBeNull();
});

test("parsePlanRef returns null on a ref with no slug body", () => {
  // `fn-1` — requires the kebab body after the number.
  expect(parsePlanRef("fn-1")).toBeNull();
});

test("parsePlanRef returns null on a malformed shape (consecutive dashes)", () => {
  // `fn--foo` — `\d+` must match between the `fn-` and the next `-`.
  expect(parsePlanRef("fn--foo")).toBeNull();
});

test("parsePlanRef returns null on the empty string", () => {
  expect(parsePlanRef("")).toBeNull();
});

test("parsePlanRef returns null on null input (defensive)", () => {
  expect(parsePlanRef(null)).toBeNull();
});

test("parsePlanRef rejects uppercase letters in the slug body", () => {
  expect(parsePlanRef("fn-1-FOO")).toBeNull();
  expect(parsePlanRef("fn-1-foo.3X")).toBeNull();
});

test("parsePlanRef rejects trailing whitespace", () => {
  expect(parsePlanRef("fn-1-foo ")).toBeNull();
  expect(parsePlanRef("fn-1-foo.3 ")).toBeNull();
});

test("parsePlanRef rejects extra dot-segments past the ordinal", () => {
  // `fn-1-foo.3.4` — the `$` anchor stops at the ordinal.
  expect(parsePlanRef("fn-1-foo.3.4")).toBeNull();
});

test("parsePlanRef rejects leading slash", () => {
  expect(parsePlanRef("/fn-1-foo")).toBeNull();
});

test("parsePlanRef accepts numeric slug bodies", () => {
  // The slug class is `[a-z0-9-]+` — pure digits are valid (e.g. `fn-1-2`).
  expect(parsePlanRef("fn-1-2")).toEqual({
    kind: "epic",
    epic_id: "fn-1-2",
  });
});

// ---------------------------------------------------------------------------
// isKilledTaskNotification
// ---------------------------------------------------------------------------

const KILLED_NOTIFICATION = [
  "<task-notification>",
  "<task-id>ba82oze4l</task-id>",
  "<output-file>/tmp/ba82oze4l.output</output-file>",
  "<status>killed</status>",
  '<summary>Monitor "chatctl bus" stopped</summary>',
  "</task-notification>",
].join("\n");

test("isKilledTaskNotification matches the killed envelope", () => {
  expect(isKilledTaskNotification(KILLED_NOTIFICATION)).toBe(true);
});

test("isKilledTaskNotification rejects a completed task-notification", () => {
  const completed = KILLED_NOTIFICATION.replace(
    "<status>killed</status>",
    "<status>completed</status>",
  );
  expect(isKilledTaskNotification(completed)).toBe(false);
});

test("isKilledTaskNotification rejects a failed task-notification", () => {
  const failed = KILLED_NOTIFICATION.replace(
    "<status>killed</status>",
    "<status>failed</status>",
  );
  expect(isKilledTaskNotification(failed)).toBe(false);
});

test("isKilledTaskNotification rejects a plain user prompt", () => {
  expect(isKilledTaskNotification("please kill the build")).toBe(false);
});

test("isKilledTaskNotification rejects a prompt that mentions the envelope inline", () => {
  // The opener must be anchored at start-of-string. A user pasting the
  // literal envelope text into the middle of a prompt must not false-match.
  expect(
    isKilledTaskNotification(
      `here's what I saw: ${KILLED_NOTIFICATION}\n— please debug`,
    ),
  ).toBe(false);
});

test("isKilledTaskNotification rejects null / non-string input", () => {
  expect(isKilledTaskNotification(null)).toBe(false);
  expect(isKilledTaskNotification(undefined)).toBe(false);
  expect(isKilledTaskNotification(42)).toBe(false);
  expect(isKilledTaskNotification({ prompt: KILLED_NOTIFICATION })).toBe(false);
});

test("isKilledTaskNotification rejects the empty string", () => {
  expect(isKilledTaskNotification("")).toBe(false);
});

// ---------------------------------------------------------------------------
// extractPlanctlInvocation
// ---------------------------------------------------------------------------

const PLANCTL_READONLY_VERBS = [
  "epics",
  "tasks",
  "cat",
  "show",
  "list",
  "detect",
  "gist",
  "init",
  "claim",
  "block",
] as const;

function pre(command: unknown): Record<string, unknown> {
  return { tool_input: { command } };
}

test("extractPlanctlInvocation returns null on non-PreToolUse event", () => {
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", pre("planctl epics")),
  ).toBeNull();
  expect(
    extractPlanctlInvocation("UserPromptSubmit", "Bash", pre("planctl epics")),
  ).toBeNull();
});

test("extractPlanctlInvocation returns null on non-Bash tool", () => {
  expect(
    extractPlanctlInvocation("PreToolUse", "Skill", pre("planctl epics")),
  ).toBeNull();
  expect(
    extractPlanctlInvocation("PreToolUse", null, pre("planctl epics")),
  ).toBeNull();
});

test("extractPlanctlInvocation returns null on missing tool_input", () => {
  expect(extractPlanctlInvocation("PreToolUse", "Bash", {})).toBeNull();
  expect(
    extractPlanctlInvocation("PreToolUse", "Bash", { tool_input: null }),
  ).toBeNull();
  expect(
    extractPlanctlInvocation("PreToolUse", "Bash", { tool_input: "string" }),
  ).toBeNull();
});

test("extractPlanctlInvocation returns null on non-string command", () => {
  expect(extractPlanctlInvocation("PreToolUse", "Bash", pre(null))).toBeNull();
  expect(extractPlanctlInvocation("PreToolUse", "Bash", pre(42))).toBeNull();
  expect(
    extractPlanctlInvocation("PreToolUse", "Bash", pre({ x: 1 })),
  ).toBeNull();
  expect(extractPlanctlInvocation("PreToolUse", "Bash", pre(""))).toBeNull();
});

test("extractPlanctlInvocation returns null on a command that isn't planctl", () => {
  expect(
    extractPlanctlInvocation("PreToolUse", "Bash", pre("ls -la")),
  ).toBeNull();
  expect(
    extractPlanctlInvocation("PreToolUse", "Bash", pre("planning the day")),
  ).toBeNull();
});

test("extractPlanctlInvocation rejects absolute-path planctl", () => {
  expect(
    extractPlanctlInvocation(
      "PreToolUse",
      "Bash",
      pre("/usr/local/bin/planctl epics"),
    ),
  ).toBeNull();
});

test("extractPlanctlInvocation rejects bash -c wrapper", () => {
  expect(
    extractPlanctlInvocation(
      "PreToolUse",
      "Bash",
      pre("bash -c 'planctl epics'"),
    ),
  ).toBeNull();
});

test("extractPlanctlInvocation rejects env-prefix invocation", () => {
  expect(
    extractPlanctlInvocation(
      "PreToolUse",
      "Bash",
      pre("JOBCTL_FOO=1 planctl epics"),
    ),
  ).toBeNull();
});

test("extractPlanctlInvocation parses bare planctl epic-create with epic ref", () => {
  const got = extractPlanctlInvocation(
    "PreToolUse",
    "Bash",
    pre("planctl epic-create fn-575-foo"),
  );
  expect(got).toEqual({
    op: "epic-create",
    target: "fn-575-foo",
    epic_id: "fn-575-foo",
    task_id: null,
    subject_present: true,
  });
});

test("extractPlanctlInvocation parses cd <path> && planctl epic-create", () => {
  const got = extractPlanctlInvocation(
    "PreToolUse",
    "Bash",
    pre("cd /tmp && planctl epic-create fn-575-foo"),
  );
  expect(got).toEqual({
    op: "epic-create",
    target: "fn-575-foo",
    epic_id: "fn-575-foo",
    task_id: null,
    subject_present: true,
  });
});

test("extractPlanctlInvocation parses task-form target into epic_id + task_id", () => {
  const got = extractPlanctlInvocation(
    "PreToolUse",
    "Bash",
    pre("planctl done fn-575-foo.3"),
  );
  expect(got).toEqual({
    op: "done",
    target: "fn-575-foo.3",
    epic_id: "fn-575-foo",
    task_id: "fn-575-foo.3",
    subject_present: true,
  });
});

test("extractPlanctlInvocation strips surrounding double quotes from target", () => {
  const got = extractPlanctlInvocation(
    "PreToolUse",
    "Bash",
    pre('planctl epic-set-title "fn-575-foo"'),
  );
  expect(got?.target).toBe("fn-575-foo");
  expect(got?.epic_id).toBe("fn-575-foo");
});

test("extractPlanctlInvocation strips surrounding single quotes from target", () => {
  const got = extractPlanctlInvocation(
    "PreToolUse",
    "Bash",
    pre("planctl epic-set-title 'fn-575-foo'"),
  );
  expect(got?.target).toBe("fn-575-foo");
  expect(got?.epic_id).toBe("fn-575-foo");
});

test("extractPlanctlInvocation does not swallow trailing && into target", () => {
  const got = extractPlanctlInvocation(
    "PreToolUse",
    "Bash",
    pre("planctl epics && echo done"),
  );
  expect(got).toEqual({
    op: "epics",
    target: null,
    epic_id: null,
    task_id: null,
    subject_present: false,
  });
});

test("extractPlanctlInvocation does not swallow trailing ; into target", () => {
  const got = extractPlanctlInvocation(
    "PreToolUse",
    "Bash",
    pre("planctl epics;ls"),
  );
  expect(got?.op).toBe("epics");
  expect(got?.target).toBeNull();
});

test("extractPlanctlInvocation handles op without target (bare planctl init)", () => {
  const got = extractPlanctlInvocation(
    "PreToolUse",
    "Bash",
    pre("planctl init"),
  );
  expect(got).toEqual({
    op: "init",
    target: null,
    epic_id: null,
    task_id: null,
    subject_present: false,
  });
});

test("extractPlanctlInvocation treats non-ref target as parseable but unresolved", () => {
  // `planctl scaffold spec.json` — target is captured but parsePlanRef yields null.
  const got = extractPlanctlInvocation(
    "PreToolUse",
    "Bash",
    pre("planctl scaffold spec.json"),
  );
  expect(got).toEqual({
    op: "scaffold",
    target: "spec.json",
    epic_id: null,
    task_id: null,
    subject_present: true,
  });
});

test("extractPlanctlInvocation marks every read-only verb subject_present:false", () => {
  for (const verb of PLANCTL_READONLY_VERBS) {
    const got = extractPlanctlInvocation(
      "PreToolUse",
      "Bash",
      pre(`planctl ${verb} fn-1-foo`),
    );
    expect(got?.op).toBe(verb);
    expect(got?.subject_present).toBe(false);
  }
});

test("extractPlanctlInvocation marks epic-mutation verbs subject_present:true", () => {
  const verbs = [
    "epic-create",
    "epic-set-title",
    "epic-set-branch",
    "epic-close",
    "epic-add-dep",
    "epic-invalidate",
  ];
  for (const verb of verbs) {
    const got = extractPlanctlInvocation(
      "PreToolUse",
      "Bash",
      pre(`planctl ${verb} fn-1-foo`),
    );
    expect(got?.op).toBe(verb);
    expect(got?.subject_present).toBe(true);
  }
});

test("extractPlanctlInvocation marks task-mutation verbs subject_present:true", () => {
  const verbs = [
    "task-set-description",
    "task-set-acceptance",
    "task-set-snippets",
    "task-reset",
  ];
  for (const verb of verbs) {
    const got = extractPlanctlInvocation(
      "PreToolUse",
      "Bash",
      pre(`planctl ${verb} fn-1-foo.1`),
    );
    expect(got?.op).toBe(verb);
    expect(got?.subject_present).toBe(true);
  }
});

test("extractPlanctlInvocation marks lifecycle mutation verbs subject_present:true", () => {
  // `done` is a worker-side lifecycle write — NOT in the read-only allowlist.
  const got = extractPlanctlInvocation(
    "PreToolUse",
    "Bash",
    pre("planctl done fn-1-foo.1 --summary x"),
  );
  expect(got?.op).toBe("done");
  expect(got?.subject_present).toBe(true);
});

test("extractPlanctlInvocation never throws on arbitrary garbage", () => {
  const garbage: unknown[] = [
    pre("\x00\x01\x02"),
    pre("planctl"),
    pre("planctl\t\t\tepics"),
    pre("planctl !@#$%"),
    pre("planctl ;;;"),
    pre("p l a n c t l epics"),
    { tool_input: { command: { nested: "object" } } },
    { tool_input: { command: 1234 } },
    { tool_input: 42 },
    {},
  ];
  for (const data of garbage) {
    expect(() =>
      extractPlanctlInvocation(
        "PreToolUse",
        "Bash",
        data as Record<string, unknown>,
      ),
    ).not.toThrow();
  }
});

test("extractPlanctlInvocation handles a 10KB command without backtracking", () => {
  // No nested quantifiers in PLANCTL_COMMAND_RE — confirm a giant input
  // resolves in linear time. We don't assert wall-time (flaky); we just
  // assert the call completes and produces a sensible result.
  const huge = `planctl epic-create fn-1-foo ${"x".repeat(10_000)}`;
  const got = extractPlanctlInvocation("PreToolUse", "Bash", pre(huge));
  expect(got?.op).toBe("epic-create");
  expect(got?.target).toBe("fn-1-foo");
});

test("extractPlanctlInvocation rejects malformed leading token (planctld)", () => {
  // The regex requires `planctl` followed by whitespace — `planctld` must not match.
  expect(
    extractPlanctlInvocation("PreToolUse", "Bash", pre("planctld epics")),
  ).toBeNull();
});
