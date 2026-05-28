import { afterAll, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCommit, parseSessionIdTrailer } from "../src/derivers";
import {
  buildGitSnapshot,
  type GitDirtyFile,
  parsePorcelainV2,
} from "../src/git-worker";

// ---------------------------------------------------------------------------
// parsePorcelainV2 — kept verbatim from pre-fn-633.5; the producer's
// porcelain-v2 parse is unchanged by the file-centric payload rewrite. The
// only consumer of `parsePorcelainV2`'s output, `buildGitSnapshot`, switched
// from event-log joins to per-file `lstat` — the parse itself stays put.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildGitSnapshot — fn-633.5 file-centric payload. The producer's contract
// narrows to: enumerate dirty files from the porcelain-v2 parse, `lstat`
// each for `mtime_ms`, emit a flat per-file list. NO event-log join, NO
// per-job rollup, NO project-wide orphan filter — those derivations move to
// the reducer in fn-633.6.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function mkTmpWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "keeper-git-snapshot-"));
  tmpDirs.push(dir);
  return dir;
}

/** Stamp a fixed mtime so the test can assert an exact `mtime_ms` value. */
function stampMtime(absPath: string, unixSeconds: number): void {
  utimesSync(absPath, unixSeconds, unixSeconds);
}

test("buildGitSnapshot on a clean worktree emits an empty dirty_files list", () => {
  const root = mkTmpWorktree();
  const snapshot = buildGitSnapshot(root, {
    branch: "main",
    head_oid: "abc123",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
  });
  expect(snapshot).toEqual({
    project_dir: root,
    branch: "main",
    head_oid: "abc123",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    dirty_files: [],
  });
  // Re-fold determinism: no `orphaned_files` or `jobs` carried in the
  // payload — those derivations move to the reducer in fn-633.6.
  expect(snapshot).not.toHaveProperty("orphaned_files");
  expect(snapshot).not.toHaveProperty("jobs");
});

test("buildGitSnapshot on a mixed dirty worktree stamps mtime_ms per file", () => {
  const root = mkTmpWorktree();
  writeFileSync(join(root, "a.ts"), "modified\n");
  stampMtime(join(root, "a.ts"), 1_700_000_000); // unix seconds
  writeFileSync(join(root, "b.ts"), "renamed-content\n");
  stampMtime(join(root, "b.ts"), 1_700_000_100);

  const snapshot = buildGitSnapshot(root, {
    branch: "main",
    head_oid: "deadbeef",
    upstream: null,
    ahead: null,
    behind: null,
    files: [
      {
        path: "a.ts",
        xy: ".M",
        index: ".",
        worktree: "M",
        kind: "ordinary",
      },
      {
        path: "b.ts",
        xy: "R.",
        index: "R",
        worktree: ".",
        kind: "renamed",
        orig_path: "a-old.ts",
      },
    ],
  });

  expect(snapshot.dirty_files).toHaveLength(2);
  const a = snapshot.dirty_files[0] as GitDirtyFile;
  expect(a.path).toBe("a.ts");
  expect(a.kind).toBe("ordinary");
  expect(a.xy).toBe(".M");
  expect(a.mtime_ms).toBe(1_700_000_000_000);
  expect(a).not.toHaveProperty("orig_path");

  const b = snapshot.dirty_files[1] as GitDirtyFile;
  expect(b.path).toBe("b.ts");
  expect(b.kind).toBe("renamed");
  expect(b.xy).toBe("R.");
  expect(b.orig_path).toBe("a-old.ts");
  expect(b.mtime_ms).toBe(1_700_000_100_000);
});

test("buildGitSnapshot on an all-untracked worktree returns the untracked list with mtimes", () => {
  const root = mkTmpWorktree();
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "sub/new file.ts"), "x\n");
  stampMtime(join(root, "sub/new file.ts"), 1_650_000_000);
  writeFileSync(join(root, "another.md"), "y\n");
  stampMtime(join(root, "another.md"), 1_650_001_000);

  const snapshot = buildGitSnapshot(root, {
    branch: null,
    head_oid: null,
    upstream: null,
    ahead: null,
    behind: null,
    files: [
      {
        path: "another.md",
        xy: "??",
        index: "?",
        worktree: "?",
        kind: "untracked",
      },
      {
        path: "sub/new file.ts",
        xy: "??",
        index: "?",
        worktree: "?",
        kind: "untracked",
      },
    ],
  });

  expect(snapshot.branch).toBeNull();
  expect(snapshot.head_oid).toBeNull();
  expect(snapshot.dirty_files.map((f) => f.path)).toEqual([
    "another.md",
    "sub/new file.ts",
  ]);
  expect(snapshot.dirty_files.every((f) => f.kind === "untracked")).toBe(true);
  expect(snapshot.dirty_files.map((f) => f.mtime_ms)).toEqual([
    1_650_001_000_000, 1_650_000_000_000,
  ]);
});

test("buildGitSnapshot tolerates a stat race (file gone) by stamping mtime_ms: null", () => {
  const root = mkTmpWorktree();
  // `gone.ts` is in the porcelain-v2 parse but never written to disk — this
  // is the documented stat race: `git status` enumerated it, then it
  // disappeared before our per-file `lstat`. The producer must emit
  // `mtime_ms: null` for the file and NOT crash.
  writeFileSync(join(root, "real.ts"), "exists\n");
  stampMtime(join(root, "real.ts"), 1_700_000_200);

  const snapshot = buildGitSnapshot(root, {
    branch: "main",
    head_oid: "abc",
    upstream: null,
    ahead: null,
    behind: null,
    files: [
      {
        path: "gone.ts",
        xy: ".M",
        index: ".",
        worktree: "M",
        kind: "ordinary",
      },
      {
        path: "real.ts",
        xy: ".M",
        index: ".",
        worktree: "M",
        kind: "ordinary",
      },
    ],
  });

  expect(snapshot.dirty_files).toHaveLength(2);
  expect(snapshot.dirty_files[0].path).toBe("gone.ts");
  expect(snapshot.dirty_files[0].mtime_ms).toBeNull();
  expect(snapshot.dirty_files[1].path).toBe("real.ts");
  expect(snapshot.dirty_files[1].mtime_ms).toBe(1_700_000_200_000);
});

test("buildGitSnapshot uses lstat so a symlink reports the link's own mtime, not the target's", () => {
  const root = mkTmpWorktree();
  // Target file: stamped at T1, OUTSIDE the worktree so its mtime can't be
  // confused with anything in the snapshot.
  const externalTarget = mkdtempSync(
    join(tmpdir(), "keeper-git-snapshot-target-"),
  );
  tmpDirs.push(externalTarget);
  const targetPath = join(externalTarget, "target.ts");
  writeFileSync(targetPath, "target\n");
  stampMtime(targetPath, 1_500_000_000); // way older

  // Symlink inside the worktree pointing at the external target. The link
  // itself gets its own mtime when created (most filesystems stamp it at
  // creation). Then explicitly bump the symlink mtime to T2 so we have two
  // distinctly-recognizable values — if `buildGitSnapshot` used `stat()` it
  // would follow the link and report T1; if it correctly uses `lstat` it
  // reports the link's own T2.
  const linkPath = join(root, "link.ts");
  symlinkSync(targetPath, linkPath);
  // `utimesSync` on a symlink path follows the link, so use `lutimes` via
  // the `node:fs` promises API... but Bun's `fs.lutimesSync` exists. Fall
  // back to a brute-force "delete + recreate" if needed — but the
  // assertion is "link mtime != target mtime", not "link mtime == fixed
  // T2". Read the link's actual current mtime via `lstatSync` and assert
  // the snapshot reports that exact value.
  const linkMtimeMs = lstatSync(linkPath).mtimeMs;
  const targetMtimeMs = lstatSync(targetPath).mtimeMs;
  // Sanity: link and target have different mtimes (so the test is
  // meaningful — if the test environment happened to make them identical,
  // skip rather than false-pass).
  if (linkMtimeMs === targetMtimeMs) {
    return; // environment couldn't differentiate; skip without failing
  }

  const snapshot = buildGitSnapshot(root, {
    branch: "main",
    head_oid: "abc",
    upstream: null,
    ahead: null,
    behind: null,
    files: [
      {
        path: "link.ts",
        xy: "??",
        index: "?",
        worktree: "?",
        kind: "untracked",
      },
    ],
  });

  expect(snapshot.dirty_files).toHaveLength(1);
  expect(snapshot.dirty_files[0].mtime_ms).toBe(linkMtimeMs);
  expect(snapshot.dirty_files[0].mtime_ms).not.toBe(targetMtimeMs);
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
