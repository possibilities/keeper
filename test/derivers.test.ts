/**
 * Pure-deriver tests. These exercise the parsers in `src/derivers.ts`
 * directly — no DB, no migration. The hook, the reducer, and the migration
 * backfill all share these derivers, so the same input MUST produce the same
 * output across all three call sites (re-fold determinism).
 */

import { expect, test } from "bun:test";
import {
  extractPlanctlInvocation,
  extractToolUseId,
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

interface Envelope {
  op: string;
  target?: string | null;
  subject?: unknown;
  // Schema v30: the `/plan:queue` priority-jump signal. Optional + arbitrary
  // type (`unknown`) so tests can drive the deriver's `=== true` defensive
  // check with non-boolean values too (the string `"true"`, `1`, an object,
  // etc., all of which MUST fold to `false`).
  queue_jump?: unknown;
}

/**
 * Wrap a planctl_invocation envelope into the canonical PostToolUse:Bash
 * tool_response.stdout shape — JSON whose top-level `planctl_invocation`
 * key carries the envelope. Mirrors the planctl CLI's stdout-emit shape
 * (`apps/planctl/planctl/cli.py` `emit()`).
 */
function post(envelope: Envelope | null): Record<string, unknown> {
  const stdout =
    envelope === null ? "" : JSON.stringify({ planctl_invocation: envelope });
  return { tool_response: { stdout } };
}

/** Raw stdout body — for tests that need to bypass the JSON wrapper. */
function postRaw(stdout: unknown): Record<string, unknown> {
  return { tool_response: { stdout } };
}

test("extractPlanctlInvocation returns null on non-PostToolUse event", () => {
  expect(
    extractPlanctlInvocation(
      "PreToolUse",
      "Bash",
      post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
    ),
  ).toBeNull();
  expect(
    extractPlanctlInvocation(
      "UserPromptSubmit",
      "Bash",
      post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
    ),
  ).toBeNull();
});

test("extractPlanctlInvocation returns null on PostToolUseFailure (prefix-startsWith would false-match)", () => {
  // Defense against any future `startsWith('PostToolUse')` shortcut —
  // PostToolUseFailure has no `tool_response` and must not match.
  expect(
    extractPlanctlInvocation(
      "PostToolUseFailure",
      "Bash",
      post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
    ),
  ).toBeNull();
});

test("extractPlanctlInvocation returns null on non-Bash tool", () => {
  expect(
    extractPlanctlInvocation(
      "PostToolUse",
      "Skill",
      post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
    ),
  ).toBeNull();
  expect(
    extractPlanctlInvocation(
      "PostToolUse",
      null,
      post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
    ),
  ).toBeNull();
});

test("extractPlanctlInvocation returns null on missing tool_response", () => {
  expect(extractPlanctlInvocation("PostToolUse", "Bash", {})).toBeNull();
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", { tool_response: null }),
  ).toBeNull();
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", {
      tool_response: "string",
    }),
  ).toBeNull();
});

test("extractPlanctlInvocation returns null on non-string stdout", () => {
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", postRaw(null)),
  ).toBeNull();
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", postRaw(42)),
  ).toBeNull();
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", postRaw({ x: 1 })),
  ).toBeNull();
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", postRaw("")),
  ).toBeNull();
});

test("extractPlanctlInvocation returns null on stdout that isn't JSON", () => {
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", postRaw("hello world")),
  ).toBeNull();
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", postRaw("ls -la\n")),
  ).toBeNull();
});

test("extractPlanctlInvocation returns null on malformed JSON", () => {
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", postRaw('{"truncated')),
  ).toBeNull();
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", postRaw("{ not json }")),
  ).toBeNull();
});

test("extractPlanctlInvocation returns null on JSON without planctl_invocation key", () => {
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", postRaw('{"foo":"bar"}')),
  ).toBeNull();
  expect(
    extractPlanctlInvocation(
      "PostToolUse",
      "Bash",
      postRaw('{"planctl_invocation":null}'),
    ),
  ).toBeNull();
  expect(
    extractPlanctlInvocation(
      "PostToolUse",
      "Bash",
      postRaw('{"planctl_invocation":"not-an-object"}'),
    ),
  ).toBeNull();
});

test("extractPlanctlInvocation returns null when stdout exceeds the length cap", () => {
  // 64_001 chars of valid JSON-looking text — over the 64_000 cap.
  const oversize = `{${"x".repeat(64_000)}}`;
  expect(
    extractPlanctlInvocation("PostToolUse", "Bash", postRaw(oversize)),
  ).toBeNull();
});

test("extractPlanctlInvocation parses epic-create envelope with epic ref", () => {
  const got = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "epic-create", target: "fn-575-foo", subject: "the subject" }),
  );
  expect(got).toEqual({
    op: "epic-create",
    target: "fn-575-foo",
    epic_id: "fn-575-foo",
    task_id: null,
    subject_present: true,
    queue_jump: false,
  });
});

test("extractPlanctlInvocation parses scaffold envelope with epic ref", () => {
  // scaffold is the canonical create-an-epic path on this codebase.
  const got = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({
      op: "scaffold",
      target: "fn-606-envelope-driven-planctl-op-deriver",
      subject: "title text",
    }),
  );
  expect(got).toEqual({
    op: "scaffold",
    target: "fn-606-envelope-driven-planctl-op-deriver",
    epic_id: "fn-606-envelope-driven-planctl-op-deriver",
    task_id: null,
    subject_present: true,
    queue_jump: false,
  });
});

test("extractPlanctlInvocation parses epic-close envelope with epic ref", () => {
  // Two-word verb that the old input-command regex saw as `op=close,
  // target=fn-...` — the envelope carries the real op name.
  const got = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "epic-close", target: "fn-575-foo", subject: null }),
  );
  expect(got).toEqual({
    op: "epic-close",
    target: "fn-575-foo",
    epic_id: "fn-575-foo",
    task_id: null,
    subject_present: false,
    queue_jump: false,
  });
});

test("extractPlanctlInvocation parses task-set-tier envelope into epic_id + task_id", () => {
  const got = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "task-set-tier", target: "fn-575-foo.3", subject: "S" }),
  );
  expect(got).toEqual({
    op: "task-set-tier",
    target: "fn-575-foo.3",
    epic_id: "fn-575-foo",
    task_id: "fn-575-foo.3",
    subject_present: true,
    queue_jump: false,
  });
});

test("extractPlanctlInvocation parses envelope with null target (bare-verb mutation)", () => {
  const got = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "init", target: null, subject: null }),
  );
  expect(got).toEqual({
    op: "init",
    target: null,
    epic_id: null,
    task_id: null,
    subject_present: false,
    queue_jump: false,
  });
});

test("extractPlanctlInvocation treats non-ref target as parseable but unresolved", () => {
  // `planctl scaffold spec.json` — target is captured but parsePlanRef yields null.
  const got = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "scaffold", target: "spec.json", subject: "x" }),
  );
  expect(got).toEqual({
    op: "scaffold",
    target: "spec.json",
    epic_id: null,
    task_id: null,
    subject_present: true,
    queue_jump: false,
  });
});

test("extractPlanctlInvocation marks subject_present:false when subject is missing or null", () => {
  // Envelope where `subject` field is absent or explicitly null → false.
  const a = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    postRaw(
      JSON.stringify({
        planctl_invocation: { op: "show", target: "fn-1-foo" },
      }),
    ),
  );
  expect(a?.subject_present).toBe(false);
  const b = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "cat", target: "fn-1-foo", subject: null }),
  );
  expect(b?.subject_present).toBe(false);
});

test("extractPlanctlInvocation marks subject_present:true when subject is any non-null value", () => {
  const got = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "epic-set-title", target: "fn-1-foo", subject: "new title" }),
  );
  expect(got?.subject_present).toBe(true);
});

test("extractPlanctlInvocation lifts queue_jump:true from the envelope (schema v30)", () => {
  // The canonical `/plan:queue` scaffold path — planctl emits the literal
  // boolean `true` on the envelope, the deriver lifts to `queue_jump: true`.
  const got = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({
      op: "scaffold",
      target: "fn-700-queued-thing",
      subject: "title",
      queue_jump: true,
    }),
  );
  expect(got).toEqual({
    op: "scaffold",
    target: "fn-700-queued-thing",
    epic_id: "fn-700-queued-thing",
    task_id: null,
    subject_present: true,
    queue_jump: true,
  });
});

test("extractPlanctlInvocation folds queue_jump:false from the envelope (defer / non-queue paths)", () => {
  // `/plan:defer` and every non-queue scaffold path emit the literal
  // boolean `false` (or omit the key entirely). The deriver folds both to
  // `queue_jump: false`.
  const explicit = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({
      op: "scaffold",
      target: "fn-700-deferred-thing",
      subject: "title",
      queue_jump: false,
    }),
  );
  expect(explicit?.queue_jump).toBe(false);

  // Absent key (legacy planctl envelope predating v30) — `=== true` is
  // false, so queue_jump folds to `false`. This is the re-fold determinism
  // gate: every historical event lacking the field reproduces `false`.
  const absent = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({
      op: "scaffold",
      target: "fn-700-legacy-thing",
      subject: "title",
    }),
  );
  expect(absent?.queue_jump).toBe(false);
});

test("extractPlanctlInvocation defensive: non-boolean queue_jump values fold to false", () => {
  // The `=== true` check is intentionally strict — any non-boolean value
  // (string "true", `1`, an object, `null`) folds to `false`. Protects
  // against a buggy planctl emitting the wrong shape.
  const cases: { label: string; value: unknown }[] = [
    { label: "string 'true'", value: "true" },
    { label: "number 1", value: 1 },
    { label: "object {x:1}", value: { x: 1 } },
    { label: "null", value: null },
  ];
  for (const { value } of cases) {
    const got = extractPlanctlInvocation(
      "PostToolUse",
      "Bash",
      post({
        op: "scaffold",
        target: "fn-700-malformed",
        subject: "title",
        queue_jump: value,
      }),
    );
    expect(got?.queue_jump).toBe(false);
  }
});

test("extractPlanctlInvocation widens to absolute-path and bash -c invocations (envelope is authoritative)", () => {
  // The old regex rejected these; the envelope-based deriver accepts them
  // because the envelope rides on stdout regardless of how planctl was
  // invoked. The hook just sees a Bash command whose stdout is JSON.
  const got = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
  );
  expect(got?.op).toBe("epic-create");
});

test("extractPlanctlInvocation rejects an envelope missing op", () => {
  expect(
    extractPlanctlInvocation(
      "PostToolUse",
      "Bash",
      postRaw(
        JSON.stringify({
          planctl_invocation: { target: "fn-1-foo", subject: "x" },
        }),
      ),
    ),
  ).toBeNull();
});

test("extractPlanctlInvocation rejects an envelope with empty-string op", () => {
  expect(
    extractPlanctlInvocation(
      "PostToolUse",
      "Bash",
      postRaw(
        JSON.stringify({ planctl_invocation: { op: "", target: "fn-1-foo" } }),
      ),
    ),
  ).toBeNull();
});

test("extractPlanctlInvocation tolerates leading whitespace before the JSON body", () => {
  // planctl envelopes are JSON; tolerate trailing newlines from upstream
  // wrappers and leading whitespace from CLI prefix lines.
  const got = extractPlanctlInvocation(
    "PostToolUse",
    "Bash",
    postRaw(
      `\n  ${JSON.stringify({ planctl_invocation: { op: "init", target: null } })}\n`,
    ),
  );
  expect(got?.op).toBe("init");
});

test("extractPlanctlInvocation never throws on arbitrary garbage", () => {
  const garbage: unknown[] = [
    postRaw("\x00\x01\x02"),
    postRaw("not json"),
    postRaw('{"planctl_invocation":42}'),
    postRaw('{"planctl_invocation":{"op":null}}'),
    postRaw('{"planctl_invocation":{"op":"foo","target":42}}'),
    { tool_response: { stdout: { nested: "object" } } },
    { tool_response: 42 },
    {},
  ];
  for (const data of garbage) {
    expect(() =>
      extractPlanctlInvocation(
        "PostToolUse",
        "Bash",
        data as Record<string, unknown>,
      ),
    ).not.toThrow();
  }
});

// ---------------------------------------------------------------------------
// extractToolUseId (v17 sparse-column deriver)
// ---------------------------------------------------------------------------

test("extractToolUseId returns the string for a populated data.tool_use_id", () => {
  expect(extractToolUseId({ tool_use_id: "toolu_abc" })).toBe("toolu_abc");
});

test("extractToolUseId returns null for a missing tool_use_id field", () => {
  expect(extractToolUseId({})).toBeNull();
  expect(extractToolUseId({ tool_input: { command: "x" } })).toBeNull();
});

test("extractToolUseId returns null for a non-string tool_use_id (defensive)", () => {
  // Claude Code occasionally puts non-strings in fields documented as strings;
  // the hook's exit-0 contract requires a null return, never a throw.
  expect(extractToolUseId({ tool_use_id: 42 })).toBeNull();
  expect(extractToolUseId({ tool_use_id: true })).toBeNull();
  expect(extractToolUseId({ tool_use_id: { id: "x" } })).toBeNull();
  expect(extractToolUseId({ tool_use_id: ["x"] })).toBeNull();
});

test("extractToolUseId returns null for an empty-string tool_use_id", () => {
  // An empty string is treated as absence — matches the partial-index
  // `WHERE tool_use_id IS NOT NULL` predicate's intent (don't index a
  // useless empty value).
  expect(extractToolUseId({ tool_use_id: "" })).toBeNull();
});

test("extractToolUseId returns null for null / non-object input (defensive)", () => {
  expect(extractToolUseId(null)).toBeNull();
  expect(extractToolUseId(undefined)).toBeNull();
  expect(extractToolUseId(42)).toBeNull();
  expect(extractToolUseId("string")).toBeNull();
  expect(extractToolUseId(true)).toBeNull();
});

test("extractToolUseId never throws on arbitrary garbage shapes", () => {
  const garbage: unknown[] = [
    { tool_use_id: Symbol("x") },
    { tool_use_id: () => "x" },
    [],
    new Map([["tool_use_id", "x"]]),
  ];
  for (const data of garbage) {
    expect(() => extractToolUseId(data)).not.toThrow();
  }
});

test("extractToolUseId fires regardless of hook event / tool name (broad gate)", () => {
  // Unlike extractSkillName / extractPlanctlInvocation, this deriver has no
  // event/tool gate — Pre/PostToolUse + PostToolUseFailure on every tool
  // carries the field. The deriver itself only sees `data`, so any payload
  // shape with `data.tool_use_id` populates the column. The hook caller
  // doesn't need to gate either.
  expect(extractToolUseId({ tool_use_id: "toolu_x" })).toBe("toolu_x");
  // A SessionStart payload, a Notification payload, or any other event — if
  // they carry `tool_use_id`, the column populates. (In practice they don't;
  // the partial index stays selective.)
});
