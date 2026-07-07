/**
 * Pure-deriver tests. These exercise the parsers in `src/derivers.ts`
 * directly — no DB, no migration. The hook, the reducer, and the migration
 * backfill all share these derivers, so the same input MUST produce the same
 * output across all three call sites (re-fold determinism).
 */

import { expect, test } from "bun:test";
import {
  extractBackgroundTaskId,
  extractBackgroundTasks,
  extractBashMutation,
  extractMutationPath,
  extractPlanInvocation,
  extractToolUseId,
  isKilledTaskNotification,
  parsePlanRef,
  planVerbRefFromSpawnName,
  REPO_TOKEN_RE,
} from "../src/derivers";

// Minimal helper to build a PostToolUse:Bash deriver call shape.
function bashMutation(command: string, cwd: string | null = "/repo") {
  return extractBashMutation(
    "PostToolUse",
    "Bash",
    { tool_input: { command } },
    cwd,
  );
}

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
// REPO_TOKEN_RE — the `repair::<repo-token>` id-half shape
// ---------------------------------------------------------------------------

test("REPO_TOKEN_RE accepts '<slug>-<hash>' tokens (the worktree lane-dir convention)", () => {
  for (const token of [
    "keeper-qzvs8i",
    "my-repo-ab12",
    "Repo.name_v2-z",
    "a-1",
    "repo123-1z141z3", // max uint32 base36 digest (7 chars)
  ]) {
    expect(REPO_TOKEN_RE.test(token)).toBe(true);
  }
});

test("REPO_TOKEN_RE rejects a token with no hash suffix, a leading hyphen, or an uppercase hash", () => {
  for (const bad of ["noHash", "-leadinghyphen", "repo-AB12", "repo-", ""]) {
    expect(REPO_TOKEN_RE.test(bad)).toBe(false);
  }
});

test("REPO_TOKEN_RE rejects a path-shaped token", () => {
  for (const bad of ["../etc/passwd", "/abs/path", "a/b-12"]) {
    expect(REPO_TOKEN_RE.test(bad)).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// planVerbRefFromSpawnName — repair::<repo-token> (repo-scoped escalation)
// ---------------------------------------------------------------------------

test("planVerbRefFromSpawnName: repair::<repo-token> → {repair, token} (repo-scoped escalation dispatch key)", () => {
  // `repair::<repo-token>` is the THIRD autonomous escalation dispatch,
  // repo-scoped rather than epic/task-scoped — folding its plan_verb/plan_ref
  // makes it a first-class dispatch key like unblock/deconflict.
  expect(planVerbRefFromSpawnName("repair::keeper-qzvs8i")).toEqual({
    plan_verb: "repair",
    plan_ref: "keeper-qzvs8i",
  });
});

test("planVerbRefFromSpawnName: repair rejects a malformed (non-token-shaped) ref", () => {
  // No hyphen at all → no `-<hash>` suffix can be carved out.
  expect(planVerbRefFromSpawnName("repair::nohyphenatall")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
  // Uppercase in the trailing hash-shaped segment → the hash class is
  // lowercase-alnum only (base36 from `(h >>> 0).toString(36)`).
  expect(planVerbRefFromSpawnName("repair::trailing-UPPERCASE")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
});

test("planVerbRefFromSpawnName: repair extra ::segment rejected (no partial match)", () => {
  expect(planVerbRefFromSpawnName("repair::keeper-qzvs8i::extra")).toEqual({
    plan_verb: null,
    plan_ref: null,
  });
});

test("planVerbRefFromSpawnName: existing fn-shaped verbs are unaffected by the repair arm", () => {
  expect(planVerbRefFromSpawnName("work::fn-575-osc-parser.3")).toEqual({
    plan_verb: "work",
    plan_ref: "fn-575-osc-parser.3",
  });
  expect(planVerbRefFromSpawnName("unblock::fn-1129-escalate.2")).toEqual({
    plan_verb: "unblock",
    plan_ref: "fn-1129-escalate.2",
  });
  expect(planVerbRefFromSpawnName("deconflict::fn-1129-escalate")).toEqual({
    plan_verb: "deconflict",
    plan_ref: "fn-1129-escalate",
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
// extractPlanInvocation
// ---------------------------------------------------------------------------

interface Envelope {
  op: string;
  target?: string | null;
  subject?: unknown;
  // Schema v46 / fn-666: the repo-relative `files` array plan emits on
  // every mutating verb. Optional + arbitrary type (`unknown`) so tests can
  // drive the deriver's `Array.isArray` + per-element-string filter against
  // non-array, non-string-element, and size-cap edges.
  files?: unknown;
}

/**
 * Wrap a plan_invocation envelope into the canonical PostToolUse:Bash
 * tool_response.stdout shape — JSON whose top-level `plan_invocation`
 * key carries the envelope. Mirrors the plan CLI's stdout-emit shape.
 */
function post(envelope: Envelope | null): Record<string, unknown> {
  const stdout =
    envelope === null ? "" : JSON.stringify({ plan_invocation: envelope });
  return { tool_response: { stdout } };
}

/** Raw stdout body — for tests that need to bypass the JSON wrapper. */
function postRaw(stdout: unknown): Record<string, unknown> {
  return { tool_response: { stdout } };
}

test("extractPlanInvocation returns null on non-PostToolUse event", () => {
  expect(
    extractPlanInvocation(
      "PreToolUse",
      "Bash",
      post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
    ),
  ).toBeNull();
  expect(
    extractPlanInvocation(
      "UserPromptSubmit",
      "Bash",
      post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
    ),
  ).toBeNull();
});

test("extractPlanInvocation returns null on PostToolUseFailure (prefix-startsWith would false-match)", () => {
  // Defense against any future `startsWith('PostToolUse')` shortcut —
  // PostToolUseFailure has no `tool_response` and must not match.
  expect(
    extractPlanInvocation(
      "PostToolUseFailure",
      "Bash",
      post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
    ),
  ).toBeNull();
});

test("extractPlanInvocation returns null on non-Bash tool", () => {
  expect(
    extractPlanInvocation(
      "PostToolUse",
      "Skill",
      post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
    ),
  ).toBeNull();
  expect(
    extractPlanInvocation(
      "PostToolUse",
      null,
      post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
    ),
  ).toBeNull();
});

test("extractPlanInvocation returns null on missing tool_response", () => {
  expect(extractPlanInvocation("PostToolUse", "Bash", {})).toBeNull();
  expect(
    extractPlanInvocation("PostToolUse", "Bash", { tool_response: null }),
  ).toBeNull();
  expect(
    extractPlanInvocation("PostToolUse", "Bash", {
      tool_response: "string",
    }),
  ).toBeNull();
});

test("extractPlanInvocation returns null on non-string stdout", () => {
  expect(
    extractPlanInvocation("PostToolUse", "Bash", postRaw(null)),
  ).toBeNull();
  expect(extractPlanInvocation("PostToolUse", "Bash", postRaw(42))).toBeNull();
  expect(
    extractPlanInvocation("PostToolUse", "Bash", postRaw({ x: 1 })),
  ).toBeNull();
  expect(extractPlanInvocation("PostToolUse", "Bash", postRaw(""))).toBeNull();
});

test("extractPlanInvocation returns null on stdout that isn't JSON", () => {
  expect(
    extractPlanInvocation("PostToolUse", "Bash", postRaw("hello world")),
  ).toBeNull();
  expect(
    extractPlanInvocation("PostToolUse", "Bash", postRaw("ls -la\n")),
  ).toBeNull();
});

test("extractPlanInvocation returns null on malformed JSON", () => {
  expect(
    extractPlanInvocation("PostToolUse", "Bash", postRaw('{"truncated')),
  ).toBeNull();
  expect(
    extractPlanInvocation("PostToolUse", "Bash", postRaw("{ not json }")),
  ).toBeNull();
});

test("extractPlanInvocation returns null on JSON without a plan_invocation key", () => {
  expect(
    extractPlanInvocation("PostToolUse", "Bash", postRaw('{"foo":"bar"}')),
  ).toBeNull();
  expect(
    extractPlanInvocation(
      "PostToolUse",
      "Bash",
      postRaw('{"plan_invocation":null}'),
    ),
  ).toBeNull();
  expect(
    extractPlanInvocation(
      "PostToolUse",
      "Bash",
      postRaw('{"plan_invocation":"not-an-object"}'),
    ),
  ).toBeNull();
  // A stray LEGACY `planctl_invocation` key is no longer read (single-path
  // post-v78); without a `plan_invocation` it folds to null.
  expect(
    extractPlanInvocation(
      "PostToolUse",
      "Bash",
      postRaw('{"planctl_invocation":{"op":"epic-create"}}'),
    ),
  ).toBeNull();
});

test("extractPlanInvocation returns null when stdout exceeds the length cap", () => {
  // 64_001 chars of valid JSON-looking text — over the 64_000 cap.
  const oversize = `{${"x".repeat(64_000)}}`;
  expect(
    extractPlanInvocation("PostToolUse", "Bash", postRaw(oversize)),
  ).toBeNull();
});

test("extractPlanInvocation reads the plan_invocation key (single-path post-v78)", () => {
  const envelope = { op: "epic-create", target: "fn-1-foo", subject: "x" };
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    postRaw(JSON.stringify({ plan_invocation: envelope })),
  );
  expect(got).not.toBeNull();
  expect(got?.op).toBe("epic-create");
  expect(got?.epic_id).toBe("fn-1-foo");
});

test("extractPlanInvocation reads plan_invocation, ignoring a stray legacy planctl_invocation", () => {
  // Single-path post-v78: the deriver reads ONLY `plan_invocation`. A stray
  // legacy `planctl_invocation` riding alongside is never read or merged, so
  // the fold resolves to the `plan_invocation` envelope exactly once.
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    postRaw(
      JSON.stringify({
        plan_invocation: { op: "wins", target: "fn-1-foo" },
        planctl_invocation: { op: "loses", target: "fn-2-bar" },
      }),
    ),
  );
  expect(got?.op).toBe("wins");
  expect(got?.epic_id).toBe("fn-1-foo");
});

test("extractPlanInvocation parses epic-create envelope with epic ref", () => {
  const got = extractPlanInvocation(
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
    files: null,
  });
});

test("extractPlanInvocation parses scaffold envelope with epic ref", () => {
  // scaffold is the canonical create-an-epic path on this codebase.
  const got = extractPlanInvocation(
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
    files: null,
  });
});

test("extractPlanInvocation parses epic-close envelope with epic ref", () => {
  // Two-word verb that the old input-command regex saw as `op=close,
  // target=fn-...` — the envelope carries the real op name.
  const got = extractPlanInvocation(
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
    files: null,
  });
});

test("extractPlanInvocation parses task-set-tier envelope into epic_id + task_id", () => {
  const got = extractPlanInvocation(
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
    files: null,
  });
});

test("extractPlanInvocation parses envelope with null target (bare-verb mutation)", () => {
  const got = extractPlanInvocation(
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
    files: null,
  });
});

test("extractPlanInvocation treats non-ref target as parseable but unresolved", () => {
  // `keeper plan scaffold spec.json` — target is captured but parsePlanRef yields null.
  const got = extractPlanInvocation(
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
    files: null,
  });
});

test("extractPlanInvocation marks subject_present:false when subject is missing or null", () => {
  // Envelope where `subject` field is absent or explicitly null → false.
  const a = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    postRaw(
      JSON.stringify({
        plan_invocation: { op: "show", target: "fn-1-foo" },
      }),
    ),
  );
  expect(a?.subject_present).toBe(false);
  const b = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "cat", target: "fn-1-foo", subject: null }),
  );
  expect(b?.subject_present).toBe(false);
});

test("extractPlanInvocation marks subject_present:true when subject is any non-null value", () => {
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "epic-set-title", target: "fn-1-foo", subject: "new title" }),
  );
  expect(got?.subject_present).toBe(true);
});

test("extractPlanInvocation widens to absolute-path and bash -c invocations (envelope is authoritative)", () => {
  // The old regex rejected these; the envelope-based deriver accepts them
  // because the envelope rides on stdout regardless of how plan was
  // invoked. The hook just sees a Bash command whose stdout is JSON.
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "epic-create", target: "fn-1-foo", subject: "x" }),
  );
  expect(got?.op).toBe("epic-create");
});

test("extractPlanInvocation rejects an envelope missing op", () => {
  expect(
    extractPlanInvocation(
      "PostToolUse",
      "Bash",
      postRaw(
        JSON.stringify({
          plan_invocation: { target: "fn-1-foo", subject: "x" },
        }),
      ),
    ),
  ).toBeNull();
});

test("extractPlanInvocation rejects an envelope with empty-string op", () => {
  expect(
    extractPlanInvocation(
      "PostToolUse",
      "Bash",
      postRaw(
        JSON.stringify({ plan_invocation: { op: "", target: "fn-1-foo" } }),
      ),
    ),
  ).toBeNull();
});

test("extractPlanInvocation tolerates leading whitespace before the JSON body", () => {
  // plan envelopes are JSON; tolerate trailing newlines from upstream
  // wrappers and leading whitespace from CLI prefix lines.
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    postRaw(
      `\n  ${JSON.stringify({ plan_invocation: { op: "init", target: null } })}\n`,
    ),
  );
  expect(got?.op).toBe("init");
});

test("extractPlanInvocation never throws on arbitrary garbage", () => {
  const garbage: unknown[] = [
    postRaw("\x00\x01\x02"),
    postRaw("not json"),
    postRaw('{"plan_invocation":42}'),
    postRaw('{"plan_invocation":{"op":null}}'),
    postRaw('{"plan_invocation":{"op":"foo","target":42}}'),
    { tool_response: { stdout: { nested: "object" } } },
    { tool_response: 42 },
    {},
  ];
  for (const data of garbage) {
    expect(() =>
      extractPlanInvocation(
        "PostToolUse",
        "Bash",
        data as Record<string, unknown>,
      ),
    ).not.toThrow();
  }
});

// ---------------------------------------------------------------------------
// extractPlanInvocation — schema v46 / fn-666: `files` lift
// ---------------------------------------------------------------------------

test("extractPlanInvocation lifts non-empty files array from the envelope (schema v46)", () => {
  // Canonical scaffold envelope shape — `files` carries repo-relative
  // paths plan wrote (every .planctl/{epics,tasks,specs}/...).
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({
      op: "scaffold",
      target: "fn-1-foo",
      subject: "title",
      files: [
        ".planctl/epics/fn-1-foo.json",
        ".planctl/meta.json",
        ".planctl/specs/fn-1-foo.md",
        ".planctl/tasks/fn-1-foo.1.json",
      ],
    }),
  );
  expect(got?.files).toEqual([
    ".planctl/epics/fn-1-foo.json",
    ".planctl/meta.json",
    ".planctl/specs/fn-1-foo.md",
    ".planctl/tasks/fn-1-foo.1.json",
  ]);
});

test("extractPlanInvocation folds an absent files key to null", () => {
  // Read-only verbs and legacy plan envelopes omit the field entirely.
  // The deriver folds the absence to `null` so the `events.planctl_files`
  // column's partial-index `WHERE planctl_files IS NOT NULL` stays
  // selective. Re-fold determinism: every legacy event reproduces null.
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "epics", target: null, subject: null }),
  );
  expect(got?.files).toBeNull();
});

test("extractPlanInvocation folds an explicit null files field to null", () => {
  // The plan CLI's emit() writes `files: null` on read-only ops
  // (`epics`, `cat`, etc.). Same null-fold path as the absent-key test.
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "epics", target: null, subject: null, files: null }),
  );
  expect(got?.files).toBeNull();
});

test("extractPlanInvocation folds an empty files array to null", () => {
  // An empty `files: []` is functionally equivalent to absent — no mint
  // would land. We collapse it to `null` so the column shape stays
  // sparse + the partial index stays selective.
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({ op: "scaffold", target: "fn-1-foo", subject: "x", files: [] }),
  );
  expect(got?.files).toBeNull();
});

test("extractPlanInvocation filters non-string elements out of files", () => {
  // Defensive — `extractPlanInvocation` mirrors `bash_mutation_targets`'s
  // Array.isArray + per-element string filter. Mixed-type entries (a buggy
  // plan) are dropped; valid strings ride through. If filtering empties
  // the array entirely, the result folds to `null` (no mint).
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({
      op: "scaffold",
      target: "fn-1-foo",
      subject: "x",
      files: [
        ".planctl/epics/fn-1-foo.json",
        42,
        null,
        { x: 1 },
        ".planctl/meta.json",
      ],
    }),
  );
  expect(got?.files).toEqual([
    ".planctl/epics/fn-1-foo.json",
    ".planctl/meta.json",
  ]);
});

test("extractPlanInvocation folds an all-non-string files array to null", () => {
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({
      op: "scaffold",
      target: "fn-1-foo",
      subject: "x",
      files: [42, null, { x: 1 }],
    }),
  );
  expect(got?.files).toBeNull();
});

test("extractPlanInvocation folds a non-array files value to null (defensive)", () => {
  // A corrupt envelope might carry a string / object / number for `files`.
  // The deriver folds these to `null` (matching every other shape-mismatch
  // path) — never throws, never coerces.
  const stringFiles = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({
      op: "scaffold",
      target: "fn-1-foo",
      subject: "x",
      files: ".planctl/epics/fn-1-foo.json",
    }),
  );
  expect(stringFiles?.files).toBeNull();
  const objectFiles = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({
      op: "scaffold",
      target: "fn-1-foo",
      subject: "x",
      files: { a: 1 },
    }),
  );
  expect(objectFiles?.files).toBeNull();
});

test("extractPlanInvocation folds an oversized files array to null (runaway guard)", () => {
  // Generous cap — a real scaffold writes <20 paths. An array way past the
  // cap is almost certainly a corrupt envelope, and storing it would burn
  // disk space + parse budget downstream. The deriver folds the whole lift
  // to `null` rather than truncating (truncation is silently lossy).
  const oversized = Array.from({ length: 1000 }, (_, i) => `f${i}.txt`);
  const got = extractPlanInvocation(
    "PostToolUse",
    "Bash",
    post({
      op: "scaffold",
      target: "fn-1-foo",
      subject: "x",
      files: oversized,
    }),
  );
  expect(got?.files).toBeNull();
});

test("extractPlanInvocation files lift never throws on arbitrary garbage", () => {
  // Mirrors the existing exit-0-contract test — the new files branch must
  // also be unconditionally defensive.
  const garbageFiles: unknown[] = [
    Symbol("x"),
    new Map(),
    new Set([1, 2]),
    () => "fn",
  ];
  for (const files of garbageFiles) {
    expect(() =>
      extractPlanInvocation(
        "PostToolUse",
        "Bash",
        post({ op: "scaffold", target: "fn-1-foo", subject: "x", files }),
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
  // Unlike extractSkillName / extractPlanInvocation, this deriver has no
  // event/tool gate — Pre/PostToolUse + PostToolUseFailure on every tool
  // carries the field. The deriver itself only sees `data`, so any payload
  // shape with `data.tool_use_id` populates the column. The hook caller
  // doesn't need to gate either.
  expect(extractToolUseId({ tool_use_id: "toolu_x" })).toBe("toolu_x");
  // A SessionStart payload, a Notification payload, or any other event — if
  // they carry `tool_use_id`, the column populates. (In practice they don't;
  // the partial index stays selective.)
});

// ---------------------------------------------------------------------------
// extractBashMutation (v31 sparse-column deriver)
// ---------------------------------------------------------------------------

test("extractBashMutation returns null on non-PostToolUse event", () => {
  expect(
    extractBashMutation(
      "PreToolUse",
      "Bash",
      { tool_input: { command: "rm foo" } },
      "/repo",
    ),
  ).toBeNull();
  expect(
    extractBashMutation(
      "PostToolUseFailure",
      "Bash",
      { tool_input: { command: "rm foo" } },
      "/repo",
    ),
  ).toBeNull();
});

test("extractBashMutation returns null on non-Bash tool", () => {
  expect(
    extractBashMutation(
      "PostToolUse",
      "Edit",
      { tool_input: { command: "rm foo" } },
      "/repo",
    ),
  ).toBeNull();
});

test("extractBashMutation returns null on missing/empty tool_input", () => {
  expect(extractBashMutation("PostToolUse", "Bash", {}, "/repo")).toBeNull();
  expect(
    extractBashMutation("PostToolUse", "Bash", { tool_input: null }, "/repo"),
  ).toBeNull();
  expect(
    extractBashMutation("PostToolUse", "Bash", { tool_input: {} }, "/repo"),
  ).toBeNull();
  expect(
    extractBashMutation(
      "PostToolUse",
      "Bash",
      { tool_input: { command: "" } },
      "/repo",
    ),
  ).toBeNull();
  expect(
    extractBashMutation(
      "PostToolUse",
      "Bash",
      { tool_input: { command: 42 } },
      "/repo",
    ),
  ).toBeNull();
});

test("extractBashMutation returns null on length-capped command", () => {
  // Cap is 32_000; a 40k-char command never even tokenizes.
  const big = "a".repeat(40_000);
  expect(bashMutation(`rm ${big}`)).toBeNull();
});

// --- Package managers ---

test("extractBashMutation: pnpm install variants → pkg-install", () => {
  for (const verb of ["install", "i", "add"]) {
    const m = bashMutation(`pnpm ${verb} foo`);
    expect(m?.kind).toBe("pkg-install");
    expect(m?.targets).toEqual(["/repo/package.json", "pnpm-lock.yaml"]);
  }
});

test("extractBashMutation: pnpm uninstall variants → pkg-uninstall", () => {
  for (const verb of ["remove", "rm", "uninstall", "un"]) {
    const m = bashMutation(`pnpm ${verb} foo`);
    expect(m?.kind).toBe("pkg-uninstall");
    expect(m?.targets).toEqual(["/repo/package.json", "pnpm-lock.yaml"]);
  }
});

test("extractBashMutation: npm install/uninstall → pkg-{install,uninstall}", () => {
  expect(bashMutation("npm install lodash")?.kind).toBe("pkg-install");
  expect(bashMutation("npm i lodash")?.kind).toBe("pkg-install");
  expect(bashMutation("npm uninstall lodash")?.kind).toBe("pkg-uninstall");
  const m = bashMutation("npm install lodash");
  expect(m?.targets).toEqual(["/repo/package.json", "package-lock.json"]);
});

test("extractBashMutation: yarn add/remove → pkg-{install,uninstall}", () => {
  expect(bashMutation("yarn add react")?.kind).toBe("pkg-install");
  expect(bashMutation("yarn remove react")?.kind).toBe("pkg-uninstall");
  const m = bashMutation("yarn add react");
  expect(m?.targets).toEqual(["/repo/package.json", "yarn.lock"]);
});

test("extractBashMutation: bun add/remove → pkg-{install,uninstall}", () => {
  expect(bashMutation("bun add zod")?.kind).toBe("pkg-install");
  expect(bashMutation("bun remove zod")?.kind).toBe("pkg-uninstall");
  const m = bashMutation("bun add zod");
  expect(m?.targets).toEqual(["/repo/package.json", "bun.lockb"]);
});

test("extractBashMutation: uv add/remove/sync/lock → pkg-{install,uninstall}", () => {
  expect(bashMutation("uv add httpx")?.kind).toBe("pkg-install");
  expect(bashMutation("uv sync")?.kind).toBe("pkg-install");
  expect(bashMutation("uv lock")?.kind).toBe("pkg-install");
  expect(bashMutation("uv remove httpx")?.kind).toBe("pkg-uninstall");
  const m = bashMutation("uv add httpx");
  expect(m?.targets).toEqual(["/repo/pyproject.toml", "uv.lock"]);
});

test("extractBashMutation: pip install/uninstall → pkg-{install,uninstall}", () => {
  expect(bashMutation("pip install requests")?.kind).toBe("pkg-install");
  expect(bashMutation("pip uninstall requests")?.kind).toBe("pkg-uninstall");
});

test("extractBashMutation: cargo add/remove → pkg-{install,uninstall}", () => {
  expect(bashMutation("cargo add serde")?.kind).toBe("pkg-install");
  expect(bashMutation("cargo remove serde")?.kind).toBe("pkg-uninstall");
  const m = bashMutation("cargo add serde");
  expect(m?.targets).toEqual(["/repo/Cargo.toml", "Cargo.lock"]);
});

test("extractBashMutation: poetry add/remove → pkg-{install,uninstall}", () => {
  expect(bashMutation("poetry add fastapi")?.kind).toBe("pkg-install");
  expect(bashMutation("poetry remove fastapi")?.kind).toBe("pkg-uninstall");
});

test("extractBashMutation: pnpm test (non-mutating subcommand) → null", () => {
  expect(bashMutation("pnpm test")).toBeNull();
  expect(bashMutation("npm run build")).toBeNull();
  expect(bashMutation("cargo build")).toBeNull();
  expect(bashMutation("pnpm")).toBeNull(); // no subcommand
});

test("extractBashMutation: env-prefix tokens are stripped (KEY=VAL pnpm i)", () => {
  const m = bashMutation("FOO=1 BAR=baz pnpm i lodash");
  expect(m?.kind).toBe("pkg-install");
  expect(m?.targets).toEqual(["/repo/package.json", "pnpm-lock.yaml"]);
});

// --- Explicit fs ---

test("extractBashMutation: rm -rf path → fs-remove with resolved path", () => {
  const m = bashMutation("rm -rf src/foo.ts");
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["/repo/src/foo.ts"]);
});

test("extractBashMutation: rm with absolute path passes through", () => {
  const m = bashMutation("rm /tmp/x");
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["/tmp/x"]);
});

test("extractBashMutation: rm with multiple paths → all resolved", () => {
  const m = bashMutation("rm a.txt b.txt c.txt");
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["/repo/a.txt", "/repo/b.txt", "/repo/c.txt"]);
});

test("extractBashMutation: mv a b → fs-move with both operands", () => {
  const m = bashMutation("mv old.ts new.ts");
  expect(m?.kind).toBe("fs-move");
  expect(m?.targets).toEqual(["/repo/old.ts", "/repo/new.ts"]);
});

test("extractBashMutation: cp -r src dst → fs-copy with both operands", () => {
  const m = bashMutation("cp -r src dst");
  expect(m?.kind).toBe("fs-copy");
  expect(m?.targets).toEqual(["/repo/src", "/repo/dst"]);
});

test("extractBashMutation: mkdir -p deep/nested → fs-mkdir", () => {
  const m = bashMutation("mkdir -p deep/nested");
  expect(m?.kind).toBe("fs-mkdir");
  expect(m?.targets).toEqual(["/repo/deep/nested"]);
});

test("extractBashMutation: rm with only flags (no positional) → null", () => {
  expect(bashMutation("rm -rf")).toBeNull();
});

test("extractBashMutation: rm -- -looks-like-flag → fs-remove with post-dashdash", () => {
  // The `--` terminator means everything after is positional.
  const m = bashMutation("rm -- -weirdname");
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["/repo/-weirdname"]);
});

test("extractBashMutation: rm with quoted path containing spaces", () => {
  const m = bashMutation('rm "my file.txt"');
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["/repo/my file.txt"]);
});

test("extractBashMutation: rm with single-quoted path", () => {
  const m = bashMutation("rm 'a b c.txt'");
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["/repo/a b c.txt"]);
});

test("extractBashMutation: rm with backslash-escaped space", () => {
  const m = bashMutation("rm a\\ b.txt");
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["/repo/a b.txt"]);
});

// --- Git tree-mutators ---

test("extractBashMutation: git checkout (no pathspec) → tree sentinel", () => {
  const m = bashMutation("git checkout feature-branch");
  expect(m?.kind).toBe("git-tree-mutate");
  expect(m?.targets).toEqual(["__TREE__"]);
});

test("extractBashMutation: git restore (no pathspec) → tree sentinel", () => {
  const m = bashMutation("git restore .");
  expect(m?.kind).toBe("git-tree-mutate");
  expect(m?.targets).toEqual(["__TREE__"]);
});

test("extractBashMutation: git stash → tree sentinel", () => {
  const m = bashMutation("git stash");
  expect(m?.kind).toBe("git-tree-mutate");
  expect(m?.targets).toEqual(["__TREE__"]);
});

test("extractBashMutation: git reset → tree sentinel", () => {
  const m = bashMutation("git reset --hard HEAD~1");
  expect(m?.kind).toBe("git-tree-mutate");
  expect(m?.targets).toEqual(["__TREE__"]);
});

test("extractBashMutation: git checkout -- path1 path2 → pathspec targets", () => {
  const m = bashMutation("git checkout -- src/a.ts src/b.ts");
  expect(m?.kind).toBe("git-tree-mutate");
  expect(m?.targets).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
});

test("extractBashMutation: git restore -- single-path → pathspec target", () => {
  const m = bashMutation("git restore -- src/a.ts");
  expect(m?.targets).toEqual(["/repo/src/a.ts"]);
});

test("extractBashMutation: git status (non-mutator) → null", () => {
  expect(bashMutation("git status")).toBeNull();
  expect(bashMutation("git diff")).toBeNull();
  expect(bashMutation("git log")).toBeNull();
  expect(bashMutation("git")).toBeNull(); // no subcommand
});

// --- git rm / git mv ---

test("extractBashMutation: git rm a b c → pathspec targets (no `--` needed)", () => {
  const m = bashMutation("git rm a b c");
  expect(m?.kind).toBe("git-rm");
  expect(m?.targets).toEqual(["/repo/a", "/repo/b", "/repo/c"]);
});

test("extractBashMutation: git rm -r dir/ → flag skipped, dir captured", () => {
  const m = bashMutation("git rm -r dir/");
  expect(m?.kind).toBe("git-rm");
  expect(m?.targets).toEqual(["/repo/dir/"]);
});

test("extractBashMutation: git rm --cached f → long-form flag skipped", () => {
  const m = bashMutation("git rm --cached f");
  expect(m?.kind).toBe("git-rm");
  expect(m?.targets).toEqual(["/repo/f"]);
});

test("extractBashMutation: git rm '*.ts' → quoted glob token preserved verbatim", () => {
  const m = bashMutation("git rm '*.ts'");
  expect(m?.kind).toBe("git-rm");
  expect(m?.targets).toEqual(["/repo/*.ts"]);
});

test("extractBashMutation: git rm --pathspec-from-file=list → bail to TREE sentinel", () => {
  const m = bashMutation("git rm --pathspec-from-file=list");
  expect(m?.kind).toBe("git-rm");
  expect(m?.targets).toEqual(["__TREE__"]);
});

test("extractBashMutation: git rm -- -weird → `--` terminator lets dash-leading path through", () => {
  const m = bashMutation("git rm -- -weird");
  expect(m?.kind).toBe("git-rm");
  expect(m?.targets).toEqual(["/repo/-weird"]);
});

test("extractBashMutation: git rm with `:`-magic pathspec → bail to TREE sentinel", () => {
  const m = bashMutation("git rm ':(exclude)*.lock'");
  expect(m?.kind).toBe("git-rm");
  expect(m?.targets).toEqual(["__TREE__"]);
});

test("extractBashMutation: git rm with no targets → null", () => {
  // All-flags, no positionals.
  expect(bashMutation("git rm -r")).toBeNull();
  expect(bashMutation("git rm")).toBeNull();
});

test("extractBashMutation: git mv src dst → both positionals captured", () => {
  const m = bashMutation("git mv src dst");
  expect(m?.kind).toBe("git-mv");
  expect(m?.targets).toEqual(["/repo/src", "/repo/dst"]);
});

test("extractBashMutation: git mv a b destdir/ → multi-source + dest captured", () => {
  const m = bashMutation("git mv a b destdir/");
  expect(m?.kind).toBe("git-mv");
  expect(m?.targets).toEqual(["/repo/a", "/repo/b", "/repo/destdir/"]);
});

test("extractBashMutation: git mv with `-k` flag → flag skipped, paths captured", () => {
  const m = bashMutation("git mv -k a b");
  expect(m?.kind).toBe("git-mv");
  expect(m?.targets).toEqual(["/repo/a", "/repo/b"]);
});

test("extractBashMutation: git mv with no targets → null", () => {
  expect(bashMutation("git mv")).toBeNull();
});

// --- Redirect-token termination (fs-commands + git rm/mv) ---

test("extractBashMutation: rm x 2>&1 → redirect dropped, only real path remains", () => {
  const m = bashMutation("rm x 2>&1");
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["/repo/x"]);
});

test("extractBashMutation: rm x > log → bare redirect + operand both dropped", () => {
  const m = bashMutation("rm x > log");
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["/repo/x"]);
});

test("extractBashMutation: rm x 2> err → 2>+operand both dropped", () => {
  const m = bashMutation("rm x 2> err");
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["/repo/x"]);
});

test("extractBashMutation: cp a b 2>&1 → redirect dropped", () => {
  const m = bashMutation("cp a b 2>&1");
  expect(m?.kind).toBe("fs-copy");
  expect(m?.targets).toEqual(["/repo/a", "/repo/b"]);
});

test("extractBashMutation: mv a b &> /tmp/log → &>+operand dropped", () => {
  const m = bashMutation("mv a b &> /tmp/log");
  expect(m?.kind).toBe("fs-move");
  expect(m?.targets).toEqual(["/repo/a", "/repo/b"]);
});

test("extractBashMutation: git rm x > log → redirect dropped on git arm", () => {
  const m = bashMutation("git rm x > log");
  expect(m?.kind).toBe("git-rm");
  expect(m?.targets).toEqual(["/repo/x"]);
});

test("extractBashMutation: git rm x 2>&1 → self-contained dup-fd dropped", () => {
  const m = bashMutation("git rm x 2>&1");
  expect(m?.kind).toBe("git-rm");
  expect(m?.targets).toEqual(["/repo/x"]);
});

test("extractBashMutation: git mv a b 2> err → redirect dropped on git-mv", () => {
  const m = bashMutation("git mv a b 2> err");
  expect(m?.kind).toBe("git-mv");
  expect(m?.targets).toEqual(["/repo/a", "/repo/b"]);
});

test("extractBashMutation: rm with only redirect (no real targets) → null", () => {
  // `rm > log` — after dropping `> log` nothing remains.
  expect(bashMutation("rm > log")).toBeNull();
});

// --- Negative & malformed ---

test("extractBashMutation: cat file (read-only) → null", () => {
  expect(bashMutation("cat file.txt")).toBeNull();
  expect(bashMutation("ls -la")).toBeNull();
  expect(bashMutation("echo hello")).toBeNull();
});

test("extractBashMutation: empty command after env-prefix → null", () => {
  expect(bashMutation("FOO=1 BAR=2")).toBeNull();
});

test("extractBashMutation: never throws on arbitrary garbage shapes", () => {
  const garbage: unknown[] = [
    null,
    undefined,
    {},
    { tool_input: 42 },
    { tool_input: { command: 42 } },
    { tool_input: { command: { obj: "x" } } },
    { tool_input: [] },
    { tool_input: "string" },
  ];
  for (const data of garbage) {
    expect(() =>
      extractBashMutation(
        "PostToolUse",
        "Bash",
        (data ?? {}) as Record<string, unknown>,
        "/repo",
      ),
    ).not.toThrow();
  }
});

test("extractBashMutation: handles unclosed quote without throwing", () => {
  // Unclosed quote eats to end of string per the tokenizer's contract.
  // This shouldn't throw — it should produce *something*, and not match
  // any pattern (since the token contains the rest of the command).
  expect(() => bashMutation('rm "unclosed')).not.toThrow();
});

test("extractBashMutation: compound command tokenizes only the first simple command", () => {
  // `cd foo && rm bar` — we only see `cd foo`, which is not a mutation.
  // Acceptable lossiness per the task spec ("compound commands degrade
  // gracefully to inferred").
  const m = bashMutation("cd foo && rm bar");
  expect(m).toBeNull();
});

test("extractBashMutation: piped commands stop at the pipe boundary", () => {
  // `cat foo | rm bar` — first simple command is `cat foo` (not a mutation).
  expect(bashMutation("cat foo | rm bar")).toBeNull();
});

test("extractBashMutation: relative paths resolve to absolute via cwd", () => {
  const m = bashMutation("rm foo/bar.ts", "/Users/mike/code/keeper");
  expect(m?.targets).toEqual(["/Users/mike/code/keeper/foo/bar.ts"]);
});

test("extractBashMutation: null cwd leaves relative paths unresolved", () => {
  const m = bashMutation("rm foo.ts", null);
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["foo.ts"]);
});

test("extractBashMutation: trailing-slash cwd is normalized", () => {
  const m = bashMutation("rm foo.ts", "/repo/");
  expect(m?.targets).toEqual(["/repo/foo.ts"]);
});

test("extractBashMutation: tilde NOT expanded (lexical-only contract)", () => {
  const m = bashMutation("rm ~/foo.ts");
  expect(m?.kind).toBe("fs-remove");
  expect(m?.targets).toEqual(["/repo/~/foo.ts"]);
});

test("extractBashMutation: round-trip determinism — same input → same output", () => {
  // The migration backfill and the hook call the same deriver — assert
  // the function is deterministic by calling twice and comparing.
  const a = bashMutation("pnpm add foo");
  const b = bashMutation("pnpm add foo");
  expect(a).toEqual(b);
  const c = bashMutation("rm -rf src/old");
  const d = bashMutation("rm -rf src/old");
  expect(c).toEqual(d);
});

// ---------------------------------------------------------------------------
// extractBackgroundTaskId — schema v51 / fn-682
//
// Stamps `events.background_task_id` at hook INSERT time for the two launch
// shapes — PostToolUse:Monitor → `tool_response.taskId`, PostToolUse:Bash with
// `run_in_background` → `tool_response.backgroundTaskId`. The migrate-time
// backfill calls the SAME function so a re-fold reproduces byte-identical
// provenance.
// ---------------------------------------------------------------------------

test("extractBackgroundTaskId: PostToolUse:Monitor returns tool_response.taskId", () => {
  expect(
    extractBackgroundTaskId("PostToolUse", "Monitor", {
      tool_response: { taskId: "bash-1234" },
    }),
  ).toBe("bash-1234");
});

test("extractBackgroundTaskId: PostToolUse:Bash returns tool_response.backgroundTaskId", () => {
  expect(
    extractBackgroundTaskId("PostToolUse", "Bash", {
      tool_response: { backgroundTaskId: "bash-5678" },
    }),
  ).toBe("bash-5678");
});

test("extractBackgroundTaskId: PostToolUse:Bash WITHOUT backgroundTaskId returns null (foreground)", () => {
  // The vast majority of Bash invocations are foreground — the launcher
  // field is absent on the foreground payload. Must NOT match.
  expect(
    extractBackgroundTaskId("PostToolUse", "Bash", {
      tool_response: { stdout: "hello", interrupted: false },
    }),
  ).toBeNull();
});

test("extractBackgroundTaskId: non-PostToolUse hook event returns null", () => {
  // The launch fields only exist on PostToolUse; pre/other events with the
  // same tool name must NOT stamp the column (gate fires before the lookup).
  expect(
    extractBackgroundTaskId("PreToolUse", "Monitor", {
      tool_response: { taskId: "bash-1234" },
    }),
  ).toBeNull();
  expect(
    extractBackgroundTaskId("UserPromptSubmit", "Bash", {
      tool_response: { backgroundTaskId: "bash-5678" },
    }),
  ).toBeNull();
});

test("extractBackgroundTaskId: PostToolUseFailure does NOT match (defense vs prefix-startsWith)", () => {
  // Mirrors the extractPlanInvocation hardening for PostToolUseFailure —
  // a strict `===` keeps the gate honest.
  expect(
    extractBackgroundTaskId("PostToolUseFailure", "Monitor", {
      tool_response: { taskId: "bash-1234" },
    }),
  ).toBeNull();
});

test("extractBackgroundTaskId: unrelated tool name returns null", () => {
  // The gate excludes every tool other than Monitor / Bash so the partial
  // index `WHERE background_task_id IS NOT NULL` stays selective.
  expect(
    extractBackgroundTaskId("PostToolUse", "Edit", {
      tool_response: { taskId: "bash-1234" },
    }),
  ).toBeNull();
  expect(
    extractBackgroundTaskId("PostToolUse", null, {
      tool_response: { taskId: "bash-1234" },
    }),
  ).toBeNull();
});

test("extractBackgroundTaskId: missing tool_response returns null", () => {
  expect(extractBackgroundTaskId("PostToolUse", "Monitor", {})).toBeNull();
  expect(
    extractBackgroundTaskId("PostToolUse", "Monitor", { tool_response: null }),
  ).toBeNull();
  expect(
    extractBackgroundTaskId("PostToolUse", "Bash", {
      tool_response: "not-an-object",
    }),
  ).toBeNull();
});

test("extractBackgroundTaskId: non-string taskId / backgroundTaskId returns null", () => {
  // Defensive: a malformed payload (number, object, null, missing field)
  // must NEVER throw — the hook's exit-0 contract is non-negotiable.
  expect(
    extractBackgroundTaskId("PostToolUse", "Monitor", {
      tool_response: { taskId: 42 },
    }),
  ).toBeNull();
  expect(
    extractBackgroundTaskId("PostToolUse", "Bash", {
      tool_response: { backgroundTaskId: { id: "x" } },
    }),
  ).toBeNull();
  expect(
    extractBackgroundTaskId("PostToolUse", "Monitor", {
      tool_response: { taskId: null },
    }),
  ).toBeNull();
  expect(
    extractBackgroundTaskId("PostToolUse", "Monitor", {
      tool_response: { taskId: "" },
    }),
  ).toBeNull();
});

test("extractBackgroundTaskId: round-trip determinism — same input → same output", () => {
  // The migration backfill and the hook call the same deriver — assert
  // the function is deterministic by calling twice and comparing.
  const a = extractBackgroundTaskId("PostToolUse", "Monitor", {
    tool_response: { taskId: "bash-1234" },
  });
  const b = extractBackgroundTaskId("PostToolUse", "Monitor", {
    tool_response: { taskId: "bash-1234" },
  });
  expect(a).toBe(b);
});

// ---------------------------------------------------------------------------
// extractBackgroundTasks — schema v51 / fn-682, enriched fn-718 (task 1)
//
// Defensive lift of a Stop event payload's `data.background_tasks` array.
// Allowlist `type === "shell"` (subagent entries drop silently), stable
// sort by id, cap at 50 entries. Returns `{id, command, description}` per
// surviving entry (fn-718) — command/description are defensive string
// coerces (non-string → `""`). NEVER throws — empty / missing / malformed
// folds to `[]` (the snapshot paradox: an unreadable Stop is drop-when-dead).
// ---------------------------------------------------------------------------

/** Shorthand for the projected object shape (command/description default ""). */
function bgTask(id: string, command = "", description = "") {
  return { id, command, description };
}

test("extractBackgroundTasks: shell allowlist returns the entries", () => {
  expect(
    extractBackgroundTasks({
      background_tasks: [
        { id: "bash-1", type: "shell" },
        { id: "bash-2", type: "shell" },
      ],
    }),
  ).toEqual([bgTask("bash-1"), bgTask("bash-2")]);
});

test("extractBackgroundTasks: carries command/description (fn-718)", () => {
  // fn-718 (task 1): the entry's command/description ride through so the
  // render layer can show the script. Defensive string coerce — a
  // non-string field folds to `""`, never `undefined`.
  expect(
    extractBackgroundTasks({
      background_tasks: [
        {
          id: "bash-1",
          type: "shell",
          command: "chatctl watch-chat",
          description: "chatctl bus",
        },
        { id: "bash-2", type: "shell", command: 42, description: null },
        { id: "bash-3", type: "shell" },
      ],
    }),
  ).toEqual([
    bgTask("bash-1", "chatctl watch-chat", "chatctl bus"),
    bgTask("bash-2", "", ""),
    bgTask("bash-3", "", ""),
  ]);
});

test("extractBackgroundTasks: subagent entries drop silently (allowlist not denylist)", () => {
  // The deriver is an ALLOWLIST on `type === "shell"`, not a denylist on
  // `!== "subagent"` — a future Claude Code task type we don't yet
  // understand must NOT leak into `jobs.monitors`.
  expect(
    extractBackgroundTasks({
      background_tasks: [
        { id: "bash-1", type: "shell" },
        { id: "subagent-1", type: "subagent" },
        { id: "future-1", type: "some-new-kind" },
      ],
    }),
  ).toEqual([bgTask("bash-1")]);
});

test("extractBackgroundTasks: empty array returns []", () => {
  expect(extractBackgroundTasks({ background_tasks: [] })).toEqual([]);
});

test("extractBackgroundTasks: missing field returns []", () => {
  expect(extractBackgroundTasks({})).toEqual([]);
});

test("extractBackgroundTasks: non-object data returns []", () => {
  expect(extractBackgroundTasks(null)).toEqual([]);
  expect(extractBackgroundTasks("string")).toEqual([]);
  expect(extractBackgroundTasks(42)).toEqual([]);
});

test("extractBackgroundTasks: malformed entries (non-object, missing id, non-string id) drop silently", () => {
  expect(
    extractBackgroundTasks({
      background_tasks: [
        null,
        "string",
        42,
        { type: "shell" }, // missing id
        { id: 42, type: "shell" }, // non-string id
        { id: "", type: "shell" }, // empty id
        { id: "bash-good", type: "shell" }, // the one good entry
      ],
    }),
  ).toEqual([bgTask("bash-good")]);
});

test("extractBackgroundTasks: non-array background_tasks returns []", () => {
  expect(extractBackgroundTasks({ background_tasks: "not-array" })).toEqual([]);
  expect(extractBackgroundTasks({ background_tasks: null })).toEqual([]);
  expect(extractBackgroundTasks({ background_tasks: { id: "x" } })).toEqual([]);
});

test("extractBackgroundTasks: stable sort by id (lexicographic)", () => {
  // Stable sort is REQUIRED for re-fold determinism — the persisted
  // `jobs.monitors` JSON must be byte-identical across re-folds.
  expect(
    extractBackgroundTasks({
      background_tasks: [
        { id: "bash-3", type: "shell" },
        { id: "bash-1", type: "shell" },
        { id: "bash-2", type: "shell" },
      ],
    }),
  ).toEqual([bgTask("bash-1"), bgTask("bash-2"), bgTask("bash-3")]);
});

test("extractBackgroundTasks: cap at 50 entries (defensive)", () => {
  // The cap bites AFTER the stable sort, so the truncated set is
  // deterministic across re-folds (lexicographic ordering keeps the
  // same 50 entries every time).
  const tasks = Array.from({ length: 75 }, (_, i) => ({
    id: `bash-${String(i).padStart(3, "0")}`,
    type: "shell",
  }));
  const got = extractBackgroundTasks({ background_tasks: tasks });
  expect(got.length).toBe(50);
  // The sorted order is bash-000 … bash-074; the cap retains the first
  // 50 (bash-000 … bash-049).
  expect(got[0]?.id).toBe("bash-000");
  expect(got[49]?.id).toBe("bash-049");
});

test("extractBackgroundTasks: round-trip determinism — same input → same output", () => {
  // The reducer calls this once per Stop; a re-fold must produce
  // byte-identical output (pure function invariant).
  const input = {
    background_tasks: [
      { id: "bash-c", type: "shell" },
      { id: "bash-a", type: "shell" },
      { id: "bash-b", type: "shell" },
    ],
  };
  expect(extractBackgroundTasks(input)).toEqual(extractBackgroundTasks(input));
});

// ---------------------------------------------------------------------------
// extractMutationPath (v73 promoted git-attribution fold column)
// ---------------------------------------------------------------------------

// Minimal helper to build the deriver call shape for a file-mutating tool.
function mutationPath(
  toolName: string | null,
  data: Record<string, unknown>,
  hookEvent = "PostToolUse",
) {
  return extractMutationPath(hookEvent, toolName, data);
}

test("extractMutationPath: PostToolUse:Write lifts tool_input.file_path", () => {
  expect(
    mutationPath("Write", { tool_input: { file_path: "/repo/src/a.ts" } }),
  ).toBe("/repo/src/a.ts");
});

test("extractMutationPath: Edit/MultiEdit/NotebookEdit all lift the path", () => {
  for (const tool of ["Edit", "MultiEdit", "NotebookEdit"]) {
    expect(mutationPath(tool, { tool_input: { file_path: "/repo/x" } })).toBe(
      "/repo/x",
    );
  }
});

test("extractMutationPath: non-PostToolUse event → null", () => {
  expect(
    mutationPath(
      "Write",
      { tool_input: { file_path: "/repo/a.ts" } },
      "PreToolUse",
    ),
  ).toBeNull();
  expect(
    mutationPath(
      "Write",
      { tool_input: { file_path: "/repo/a.ts" } },
      "PostToolUseFailure",
    ),
  ).toBeNull();
});

test("extractMutationPath: non-file-mutating tool → null", () => {
  expect(
    mutationPath("Bash", { tool_input: { file_path: "/repo/a.ts" } }),
  ).toBeNull();
  expect(
    mutationPath("Read", { tool_input: { file_path: "/repo/a.ts" } }),
  ).toBeNull();
  expect(
    mutationPath(null, { tool_input: { file_path: "/repo/a.ts" } }),
  ).toBeNull();
});

test("extractMutationPath: missing/malformed tool_input → null (never throws)", () => {
  expect(mutationPath("Write", {})).toBeNull();
  expect(mutationPath("Write", { tool_input: null })).toBeNull();
  expect(mutationPath("Write", { tool_input: "nope" })).toBeNull();
  expect(mutationPath("Write", { tool_input: {} })).toBeNull();
});

test("extractMutationPath: non-string / empty file_path → null", () => {
  expect(mutationPath("Write", { tool_input: { file_path: 42 } })).toBeNull();
  expect(mutationPath("Write", { tool_input: { file_path: "" } })).toBeNull();
  expect(mutationPath("Write", { tool_input: { file_path: null } })).toBeNull();
  expect(
    mutationPath("Write", { tool_input: { file_path: { nested: 1 } } }),
  ).toBeNull();
});

test("extractMutationPath: never throws on arbitrary garbage shapes", () => {
  const garbage: Record<string, unknown>[] = [
    {},
    { tool_input: [] },
    { tool_input: { file_path: [] } },
    { tool_input: 0 },
    { tool_input: true },
  ];
  for (const g of garbage) {
    expect(() => mutationPath("Edit", g)).not.toThrow();
  }
});

test("extractMutationPath: round-trip determinism — same input → same output", () => {
  const data = { tool_input: { file_path: "/repo/src/x.ts" } };
  expect(mutationPath("Write", data)).toBe(mutationPath("Write", data));
});
