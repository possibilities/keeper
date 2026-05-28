import { expect, test } from "bun:test";
import { extractCommit, parseSessionIdTrailer } from "../src/derivers";
import { extractFileTouches, parsePorcelainV2 } from "../src/git-worker";

test("parsePorcelainV2 captures branch metadata and dirty file statuses", () => {
  const raw = [
    "# branch.oid abc123",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 aaaaa bbbbb src/a.ts",
    "? src/new file.ts",
    "2 R. N... 100644 100644 100644 aaaaa bbbbb R100 src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0");

  const parsed = parsePorcelainV2(raw);
  expect(parsed.branch).toBe("main");
  expect(parsed.head_oid).toBe("abc123");
  expect(parsed.upstream).toBe("origin/main");
  expect(parsed.ahead).toBe(2);
  expect(parsed.behind).toBe(1);
  expect(parsed.files).toEqual([
    {
      path: "src/a.ts",
      xy: ".M",
      index: ".",
      worktree: "M",
      kind: "ordinary",
    },
    {
      path: "src/new file.ts",
      xy: "??",
      index: "?",
      worktree: "?",
      kind: "untracked",
    },
    {
      path: "src/new-name.ts",
      xy: "R.",
      index: "R",
      worktree: ".",
      kind: "renamed",
      orig_path: "src/old-name.ts",
    },
  ]);
});

test("extractFileTouches resolves Claude file-tool paths relative to the git root", () => {
  const touches = extractFileTouches(
    {
      tool_name: "Edit",
      cwd: "/repo/packages/app",
      data: JSON.stringify({
        tool_input: { file_path: "src/page.tsx" },
      }),
    },
    "/repo",
  );

  expect(touches).toEqual([
    { path: "packages/app/src/page.tsx", ops: ["update"] },
  ]);
});

test("extractFileTouches drops paths outside the git root", () => {
  const touches = extractFileTouches(
    {
      tool_name: "Write",
      cwd: "/repo",
      data: JSON.stringify({
        tool_input: { file_path: "/tmp/outside.txt" },
      }),
    },
    "/repo",
  );

  expect(touches).toEqual([]);
});

test("extractFileTouches ignores Read so reads don't get attributed as dirty", () => {
  const touches = extractFileTouches(
    {
      tool_name: "Read",
      cwd: "/repo",
      data: JSON.stringify({
        tool_input: { file_path: "src/page.tsx" },
      }),
    },
    "/repo",
  );

  expect(touches).toEqual([]);
});

// ---------------------------------------------------------------------------
// parseSessionIdTrailer — take-last policy, UUID validation, malformed handling
// ---------------------------------------------------------------------------

const VALID_UUID = "01234567-89ab-cdef-0123-456789abcdef";
const VALID_UUID_2 = "fedcba98-7654-3210-fedc-ba9876543210";

test("parseSessionIdTrailer returns null on null/empty/whitespace input", () => {
  expect(parseSessionIdTrailer(null)).toBeNull();
  expect(parseSessionIdTrailer(undefined)).toBeNull();
  expect(parseSessionIdTrailer("")).toBeNull();
  expect(parseSessionIdTrailer("   \n\t\n")).toBeNull();
  expect(parseSessionIdTrailer(42)).toBeNull();
});

test("parseSessionIdTrailer accepts a single valid UUID line", () => {
  expect(parseSessionIdTrailer(VALID_UUID)).toBe(VALID_UUID);
  expect(parseSessionIdTrailer(`${VALID_UUID}\n`)).toBe(VALID_UUID);
  expect(parseSessionIdTrailer(`  ${VALID_UUID}  \n`)).toBe(VALID_UUID);
});

test("parseSessionIdTrailer takes the LAST non-empty line on cherry-pick stacks", () => {
  expect(parseSessionIdTrailer(`${VALID_UUID}\n${VALID_UUID_2}\n`)).toBe(
    VALID_UUID_2,
  );
  expect(parseSessionIdTrailer(`${VALID_UUID}\n${VALID_UUID_2}`)).toBe(
    VALID_UUID_2,
  );
});

test("parseSessionIdTrailer returns null when the last non-empty line is malformed", () => {
  // Take-last is strict: a malformed last line means the canonical
  // attribution is malformed, even if an earlier line was valid (the
  // spec's policy — the cherry-picker's session is authoritative, and a
  // bad cherry-picker trailer means global discharge).
  expect(parseSessionIdTrailer(`${VALID_UUID}\nNOT-A-UUID\n`)).toBeNull();
  expect(parseSessionIdTrailer("uppercase-FEEDFACE-1234\n")).toBeNull();
  expect(parseSessionIdTrailer("01234567-89ab-cdef\n")).toBeNull(); // truncated
  expect(parseSessionIdTrailer("garbage trailer value\n")).toBeNull();
});

test("parseSessionIdTrailer skips trailing empty lines when taking last", () => {
  // git's format expansion appends a `\n` after the last trailer value,
  // which produces a trailing empty element on split. The take-last loop
  // must skip those to find the real last line.
  expect(parseSessionIdTrailer(`${VALID_UUID}\n\n\n`)).toBe(VALID_UUID);
});

// ---------------------------------------------------------------------------
// extractCommit — defensive payload parsing for the synthetic `Commit` event
// ---------------------------------------------------------------------------

const VALID_OID = "0123456789abcdef0123456789abcdef01234567";
const VALID_OID_2 = "fedcba9876543210fedcba9876543210fedcba98";

test("extractCommit accepts a well-formed payload", () => {
  const payload = {
    project_dir: "/repo",
    commit_oid: VALID_OID,
    parent_oid: VALID_OID_2,
    files: ["src/a.ts", "src/b.ts"],
    committer_session_id: VALID_UUID,
    committed_at_ms: 1_700_000_000_000,
  };
  expect(extractCommit({ data: JSON.stringify(payload) })).toEqual(payload);
});

test("extractCommit returns null on empty data, non-string data, non-JSON data", () => {
  expect(extractCommit({ data: "" })).toBeNull();
  expect(extractCommit({ data: "not-json" })).toBeNull();
  // typeof check rejects non-strings (TypeScript-level guard).
  expect(extractCommit({ data: "null" })).toBeNull();
  expect(extractCommit({ data: "[]" })).toBeNull();
  expect(extractCommit({ data: "42" })).toBeNull();
});

test("extractCommit rejects payloads missing project_dir", () => {
  expect(
    extractCommit({
      data: JSON.stringify({
        commit_oid: VALID_OID,
        files: [],
        committer_session_id: null,
        committed_at_ms: 0,
      }),
    }),
  ).toBeNull();
  expect(
    extractCommit({
      data: JSON.stringify({
        project_dir: "",
        commit_oid: VALID_OID,
        files: [],
        committer_session_id: null,
        committed_at_ms: 0,
      }),
    }),
  ).toBeNull();
});

test("extractCommit rejects payloads with a non-OID commit_oid", () => {
  expect(
    extractCommit({
      data: JSON.stringify({
        project_dir: "/repo",
        commit_oid: "not-an-oid",
        files: [],
        committer_session_id: null,
        committed_at_ms: 0,
      }),
    }),
  ).toBeNull();
  expect(
    extractCommit({
      data: JSON.stringify({
        project_dir: "/repo",
        commit_oid: "0123abc", // too short
        files: [],
        committer_session_id: null,
        committed_at_ms: 0,
      }),
    }),
  ).toBeNull();
});

test("extractCommit normalizes empty/null/missing parent_oid to null", () => {
  for (const variant of [
    { parent_oid: "" },
    { parent_oid: null },
    {}, // missing key
    { parent_oid: "not-an-oid" }, // invalid → null per the defensive parser
  ] as const) {
    const res = extractCommit({
      data: JSON.stringify({
        project_dir: "/repo",
        commit_oid: VALID_OID,
        files: ["x"],
        committer_session_id: null,
        committed_at_ms: 1000,
        ...variant,
      }),
    });
    expect(res?.parent_oid).toBeNull();
  }
});

test("extractCommit filters non-string and empty files entries", () => {
  const res = extractCommit({
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: VALID_OID,
      parent_oid: null,
      files: ["src/a.ts", "", null, 42, "src/b.ts"],
      committer_session_id: null,
      committed_at_ms: 0,
    }),
  });
  expect(res?.files).toEqual(["src/a.ts", "src/b.ts"]);
});

test("extractCommit normalizes invalid committer_session_id to null", () => {
  for (const bad of [
    "not-a-uuid",
    "01234567-89ab-cdef", // truncated
    "UPPERCASE-89ab-cdef-0123-456789abcdef", // not all hex
    42,
    null,
  ] as const) {
    const res = extractCommit({
      data: JSON.stringify({
        project_dir: "/repo",
        commit_oid: VALID_OID,
        parent_oid: null,
        files: ["x"],
        committer_session_id: bad,
        committed_at_ms: 0,
      }),
    });
    expect(res?.committer_session_id).toBeNull();
  }
});

test("extractCommit clamps non-positive / non-numeric committed_at_ms to 0", () => {
  for (const bad of [-1, 0, "1700000000000", null, undefined, NaN] as const) {
    const res = extractCommit({
      data: JSON.stringify({
        project_dir: "/repo",
        commit_oid: VALID_OID,
        parent_oid: null,
        files: ["x"],
        committer_session_id: null,
        committed_at_ms: bad,
      }),
    });
    expect(res?.committed_at_ms).toBe(0);
  }
});
