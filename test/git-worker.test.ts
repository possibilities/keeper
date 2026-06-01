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
import {
  extractCommit,
  parseSessionIdTrailer,
  parseTaskTrailers,
} from "../src/derivers";
import {
  buildGitSnapshot,
  decideHeadDivergence,
  enumerateCommitsInDelta,
  type GitDirtyFile,
  parsePorcelainV2,
  resolveHeadOidViaFs,
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
    "1 .M N... 100644 100644 100755 aaaaa bbbbb src/a.ts",
    "? src/new file.ts",
    "2 R. N... 100644 100644 100644 aaaaa ccccc R100 src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0");

  const parsed = parsePorcelainV2(raw);
  expect(parsed.branch).toBe("main");
  expect(parsed.head_oid).toBe("abc123");
  expect(parsed.upstream).toBe("origin/main");
  expect(parsed.ahead).toBe(2);
  expect(parsed.behind).toBe(1);
  // v44 / fn-664: ordinary + renamed records now carry `index_oid` (hI) +
  // `worktree_mode` (mW) lifted off the porcelain-v2 record at parse time.
  // Untracked records have neither (`?` records carry no oids/modes).
  expect(parsed.files).toEqual([
    {
      path: "src/a.ts",
      xy: ".M",
      index: ".",
      worktree: "M",
      kind: "ordinary",
      index_oid: "bbbbb",
      worktree_mode: "100755",
    },
    {
      path: "src/new file.ts",
      xy: "??",
      index: "?",
      worktree: "?",
      kind: "untracked",
      index_oid: null,
      worktree_mode: null,
    },
    {
      path: "src/new-name.ts",
      xy: "R.",
      index: "R",
      worktree: ".",
      kind: "renamed",
      orig_path: "src/old-name.ts",
      index_oid: "ccccc",
      worktree_mode: "100644",
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
        index_oid: "1111111111111111111111111111111111111111",
        worktree_mode: "100644",
      },
      {
        path: "b.ts",
        xy: "R.",
        index: "R",
        worktree: ".",
        kind: "renamed",
        orig_path: "a-old.ts",
        index_oid: "2222222222222222222222222222222222222222",
        worktree_mode: "100644",
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
  // v44 / fn-664: per-file content axes — `index_oid` + `worktree_mode`
  // pass through from the porcelain parse; `worktree_oid` is the
  // filter-correct hash of the actual bytes, validated as a 40-hex SHA-1
  // (git hash-object produced it).
  expect(a.index_oid).toBe("1111111111111111111111111111111111111111");
  expect(a.worktree_mode).toBe("100644");
  expect(a.worktree_oid).toMatch(/^[0-9a-f]{40}$/);

  const b = snapshot.dirty_files[1] as GitDirtyFile;
  expect(b.path).toBe("b.ts");
  expect(b.kind).toBe("renamed");
  expect(b.xy).toBe("R.");
  expect(b.orig_path).toBe("a-old.ts");
  expect(b.mtime_ms).toBe(1_700_000_100_000);
  expect(b.index_oid).toBe("2222222222222222222222222222222222222222");
  expect(b.worktree_mode).toBe("100644");
  expect(b.worktree_oid).toMatch(/^[0-9a-f]{40}$/);
  // Different bytes → different worktree oid (the whole point — content
  // equality is what task .2's discharge gate reads).
  expect(b.worktree_oid).not.toBe(a.worktree_oid);
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
        index_oid: null,
        worktree_mode: null,
      },
      {
        path: "sub/new file.ts",
        xy: "??",
        index: "?",
        worktree: "?",
        kind: "untracked",
        index_oid: null,
        worktree_mode: null,
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
  // v44 / fn-664: untracked porcelain records carry no `hI`/`mW`, so the
  // parse and payload preserve `null` for both — but the worktree blob
  // hash IS available (the bytes are on disk), so `worktree_oid` still
  // parses as a valid 40-hex SHA-1.
  expect(snapshot.dirty_files.every((f) => f.index_oid === null)).toBe(true);
  expect(snapshot.dirty_files.every((f) => f.worktree_mode === null)).toBe(
    true,
  );
  expect(
    snapshot.dirty_files.every(
      (f) => f.worktree_oid != null && /^[0-9a-f]{40}$/.test(f.worktree_oid),
    ),
  ).toBe(true);
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
        index_oid: "3333333333333333333333333333333333333333",
        worktree_mode: "100644",
      },
      {
        path: "real.ts",
        xy: ".M",
        index: ".",
        worktree: "M",
        kind: "ordinary",
        index_oid: "4444444444444444444444444444444444444444",
        worktree_mode: "100644",
      },
    ],
  });

  expect(snapshot.dirty_files).toHaveLength(2);
  expect(snapshot.dirty_files[0].path).toBe("gone.ts");
  expect(snapshot.dirty_files[0].mtime_ms).toBeNull();
  // v44 / fn-664: the producer-side stat race extends to `worktree_oid` —
  // a file that vanished between `git status` and the batched
  // `hash-object` call gets `worktree_oid: null` without wedging the
  // snapshot. `index_oid` / `worktree_mode` came off the porcelain parse
  // (no fs probe) so they survive. `real.ts` was hashable, so its
  // `worktree_oid` is a valid 40-hex SHA-1.
  expect(snapshot.dirty_files[0].worktree_oid).toBeNull();
  expect(snapshot.dirty_files[0].index_oid).toBe(
    "3333333333333333333333333333333333333333",
  );
  expect(snapshot.dirty_files[0].worktree_mode).toBe("100644");
  expect(snapshot.dirty_files[1].path).toBe("real.ts");
  expect(snapshot.dirty_files[1].mtime_ms).toBe(1_700_000_200_000);
  expect(snapshot.dirty_files[1].worktree_oid).toMatch(/^[0-9a-f]{40}$/);
  expect(snapshot.dirty_files[1].index_oid).toBe(
    "4444444444444444444444444444444444444444",
  );
  expect(snapshot.dirty_files[1].worktree_mode).toBe("100644");
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
        index_oid: null,
        worktree_mode: null,
      },
    ],
  });

  expect(snapshot.dirty_files).toHaveLength(1);
  expect(snapshot.dirty_files[0].mtime_ms).toBe(linkMtimeMs);
  expect(snapshot.dirty_files[0].mtime_ms).not.toBe(targetMtimeMs);
});

// ---------------------------------------------------------------------------
// v44 / fn-664: filter-correct worktree_oid via `git hash-object`. The whole
// point of omitting `--no-filters` is so the result equals `git`'s own
// stored blob — the discharge gate in task .2 compares this against the
// `Commit` event's `blob_oid` (which IS the stored hash). Verify equality
// by initializing a real repo, staging the file, and reading `git
// hash-object -w` / `ls-files -s` for the stored oid.
// ---------------------------------------------------------------------------

function gitInit(root: string): void {
  // Minimal config so `git add` / `git commit` work without a global git
  // identity. Suppress stderr to keep the test output clean on hosts that
  // print upgrade-suggestion banners.
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
  ] as const) {
    const res = Bun.spawnSync(["git", "-C", root, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (!res.success) throw new Error(`git ${args.join(" ")} failed`);
  }
}

function gitHashObjectStored(root: string, relPath: string): string {
  // Use `git hash-object` (no `-w`, no `--no-filters`) to compute the SAME
  // filter-correct oid the producer would compute. Used as the ground
  // truth in the equality test below.
  const res = Bun.spawnSync(["git", "-C", root, "hash-object", relPath], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (!res.success || res.exitCode !== 0) {
    throw new Error(`git hash-object failed for ${relPath}`);
  }
  return res.stdout.toString().trim();
}

test("buildGitSnapshot worktree_oid matches git's stored blob oid (filter-correct)", () => {
  const root = mkTmpWorktree();
  gitInit(root);
  // Two distinct files so we exercise the batched path with >1 entry.
  writeFileSync(join(root, "a.ts"), "alpha contents\n");
  writeFileSync(join(root, "b.md"), "# Beta\n\nsome markdown\n");

  const expectedA = gitHashObjectStored(root, "a.ts");
  const expectedB = gitHashObjectStored(root, "b.md");

  const snapshot = buildGitSnapshot(root, {
    branch: "main",
    head_oid: null,
    upstream: null,
    ahead: null,
    behind: null,
    files: [
      {
        path: "a.ts",
        xy: "??",
        index: "?",
        worktree: "?",
        kind: "untracked",
        index_oid: null,
        worktree_mode: null,
      },
      {
        path: "b.md",
        xy: "??",
        index: "?",
        worktree: "?",
        kind: "untracked",
        index_oid: null,
        worktree_mode: null,
      },
    ],
  });

  expect(snapshot.dirty_files).toHaveLength(2);
  // Both oids equal git's own ground-truth — i.e. the producer's batched
  // hash-object call is producing the exact bytes git would store.
  expect(snapshot.dirty_files[0].worktree_oid).toBe(expectedA);
  expect(snapshot.dirty_files[1].worktree_oid).toBe(expectedB);
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

test("extractCommit accepts a well-formed v45+ payload (files: [{path, blob_oid, committed_mode}])", () => {
  // v44 / fn-664: producer emits `files` as `Array<{path, blob_oid}>`. The
  // blob_oid is the per-file committed blob from `git diff-tree -r` —
  // validated as a 40/64-hex OID, `null` on a parse miss (the discharge
  // gate in `foldCommit` treats `null` as "cannot confirm content
  // equality" and falls back to timestamp discharge).
  // v45 / fn-664.2: each entry also carries `committed_mode` (the
  // porcelain `mI` mode lifted off the same `diff-tree` record) so the
  // discharge gate can suppress a chmod-only dirty file's wrong
  // discharge.
  const payload = {
    project_dir: "/repo",
    commit_oid: VALID_OID,
    parent_oid: VALID_OID_2,
    files: [
      { path: "src/a.ts", blob_oid: VALID_OID, committed_mode: "100644" },
      { path: "src/b.ts", blob_oid: null, committed_mode: null },
    ],
    committer_session_id: VALID_UUID,
    // Epic fn-670: `task_ids` joins the payload. Empty array here is
    // the round-trip case (the producer would emit [] for a commit
    // carrying no Task: trailer).
    task_ids: [],
    committed_at_ms: 1_700_000_000_000,
  };
  expect(extractCommit({ data: JSON.stringify(payload) })).toEqual(payload);
});

test("extractCommit normalizes v44 payload (files: [{path, blob_oid}] with no committed_mode) into [{path, blob_oid, committed_mode: null}]", () => {
  // v44 events carried `{path, blob_oid}` per file but no `committed_mode`
  // — extractCommit folds the absent `committed_mode` to `null` so a
  // re-fold over historical v44 events takes the legacy discharge
  // fall-back (identical to today's pre-gate behavior).
  const res = extractCommit({
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: VALID_OID,
      parent_oid: null,
      files: [
        { path: "src/a.ts", blob_oid: VALID_OID }, // v44 shape (no committed_mode)
        { path: "src/b.ts", blob_oid: null },
      ],
      committer_session_id: null,
      committed_at_ms: 1000,
    }),
  });
  expect(res?.files).toEqual([
    { path: "src/a.ts", blob_oid: VALID_OID, committed_mode: null },
    { path: "src/b.ts", blob_oid: null, committed_mode: null },
  ]);
});

test("extractCommit normalizes legacy string-array files into [{path, blob_oid: null, committed_mode: null}]", () => {
  // Pre-v44 events stored `files: string[]`. Re-fold determinism requires
  // the new extractor to accept both shapes; each legacy string becomes
  // `{path, blob_oid: null, committed_mode: null}` so the reducer reads
  // a uniform interface. The discharge gate treats a null oid OR null
  // mode as "cannot confirm content+mode equality → fall back to
  // timestamp discharge", preserving today's behavior on the historical
  // log.
  const res = extractCommit({
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: VALID_OID,
      parent_oid: null,
      files: ["src/a.ts", "src/b.ts"],
      committer_session_id: null,
      committed_at_ms: 1000,
    }),
  });
  expect(res?.files).toEqual([
    { path: "src/a.ts", blob_oid: null, committed_mode: null },
    { path: "src/b.ts", blob_oid: null, committed_mode: null },
  ]);
});

test("extractCommit normalizes bad blob_oid / committed_mode entries to null without dropping the path", () => {
  // A producer-side `diff-tree` parse miss for one file shouldn't drop
  // that file's discharge — it should keep the path but null the oid /
  // mode so the discharge gate falls back to timestamp discharge for
  // that file alone.
  const res = extractCommit({
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: VALID_OID,
      parent_oid: null,
      files: [
        { path: "src/a.ts", blob_oid: VALID_OID, committed_mode: "100644" }, // valid
        { path: "src/b.ts", blob_oid: "not-an-oid", committed_mode: "100644" }, // bad oid → null
        { path: "src/c.ts", blob_oid: "", committed_mode: "100644" }, // empty oid → null
        { path: "src/d.ts", committed_mode: "100644" }, // missing oid → null
        { path: "src/e.ts", blob_oid: 42, committed_mode: "100644" }, // non-string oid → null
        { path: "src/f.ts", blob_oid: VALID_OID, committed_mode: "000000" }, // zero mode → null (deletion sentinel)
        { path: "src/g.ts", blob_oid: VALID_OID, committed_mode: "" }, // empty mode → null
        { path: "src/h.ts", blob_oid: VALID_OID, committed_mode: 42 }, // non-string mode → null
        { path: "src/i.ts", blob_oid: VALID_OID }, // missing mode → null
      ],
      committer_session_id: null,
      committed_at_ms: 0,
    }),
  });
  expect(res?.files).toEqual([
    { path: "src/a.ts", blob_oid: VALID_OID, committed_mode: "100644" },
    { path: "src/b.ts", blob_oid: null, committed_mode: "100644" },
    { path: "src/c.ts", blob_oid: null, committed_mode: "100644" },
    { path: "src/d.ts", blob_oid: null, committed_mode: "100644" },
    { path: "src/e.ts", blob_oid: null, committed_mode: "100644" },
    { path: "src/f.ts", blob_oid: VALID_OID, committed_mode: null },
    { path: "src/g.ts", blob_oid: VALID_OID, committed_mode: null },
    { path: "src/h.ts", blob_oid: VALID_OID, committed_mode: null },
    { path: "src/i.ts", blob_oid: VALID_OID, committed_mode: null },
  ]);
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

test("extractCommit filters non-string and empty files entries (legacy mixed-shape)", () => {
  // Defensive parse over the legacy `string[]` shape: empty strings, nulls,
  // and non-strings drop; valid strings normalize to {path, blob_oid: null,
  // committed_mode: null} entries so the consumer sees a uniform v45+ array.
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
  expect(res?.files).toEqual([
    { path: "src/a.ts", blob_oid: null, committed_mode: null },
    { path: "src/b.ts", blob_oid: null, committed_mode: null },
  ]);
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

// ---------------------------------------------------------------------------
// resolveHeadOidViaFs — the divergence watchdog's fs-only HEAD ground truth.
// Must match `git rev-parse HEAD` across regular repos, packed-refs, detached
// HEAD, and linked worktrees, WITHOUT shelling git — that independence is the
// whole point (it stays correct when the worker's git subprocess view wedges).
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
  });
  if (!r.success) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "keeper-headfs-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

test("resolveHeadOidViaFs matches git rev-parse on a regular repo (loose ref)", () => {
  const dir = initRepo();
  try {
    expect(resolveHeadOidViaFs(dir)).toBe(git(dir, "rev-parse", "HEAD"));
    // A second commit advances HEAD; the fs read must track it.
    writeFileSync(join(dir, "b.txt"), "world\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "second");
    expect(resolveHeadOidViaFs(dir)).toBe(git(dir, "rev-parse", "HEAD"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHeadOidViaFs resolves a packed ref (no loose ref file)", () => {
  const dir = initRepo();
  try {
    const head = git(dir, "rev-parse", "HEAD");
    git(dir, "pack-refs", "--all");
    // refs/heads/main is now only in packed-refs; the loose file is gone.
    expect(resolveHeadOidViaFs(dir)).toBe(head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHeadOidViaFs returns the oid for a detached HEAD", () => {
  const dir = initRepo();
  try {
    const head = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "--detach", head);
    expect(resolveHeadOidViaFs(dir)).toBe(head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHeadOidViaFs resolves a linked worktree's own HEAD", () => {
  const dir = initRepo();
  const wt = mkdtempSync(join(tmpdir(), "keeper-headfs-wt-"));
  rmSync(wt, { recursive: true, force: true }); // git worktree add wants a fresh path
  try {
    git(dir, "branch", "feature");
    git(dir, "worktree", "add", "-q", wt, "feature");
    // The linked worktree's `.git` is a `gitdir:` pointer file, refs live in
    // the main repo's common-dir — the resolver must follow both hops.
    expect(resolveHeadOidViaFs(wt)).toBe(git(wt, "rev-parse", "HEAD"));
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveHeadOidViaFs returns null on a non-repo path (fail-safe)", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-headfs-bare-"));
  try {
    expect(resolveHeadOidViaFs(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// decideHeadDivergence — pure decision for the emitSnapshot wedge guard. Suppress
// (and eventually trip) ONLY when git-derived HEAD and fs-derived HEAD disagree;
// fail OPEN on uncertainty (null fs head) so real data is never withheld.
// ---------------------------------------------------------------------------

const A = "a".repeat(40);
const B = "b".repeat(40);
const GRACE = 90_000;

test("decideHeadDivergence: agreement is not divergent and clears the timer", () => {
  expect(decideHeadDivergence(A, A, 1000, 5000, GRACE)).toEqual({
    suppress: false,
    sinceMs: null,
    trip: false,
  });
});

test("decideHeadDivergence: null git or null fs head fails open (trust git, reset)", () => {
  expect(decideHeadDivergence(null, A, 1000, 5000, GRACE).suppress).toBe(false);
  // fsHead null = can't verify → never suppress real data, never escalate.
  expect(decideHeadDivergence(A, null, 1000, 5000, GRACE)).toEqual({
    suppress: false,
    sinceMs: null,
    trip: false,
  });
});

test("decideHeadDivergence: first divergence suppresses and stamps sinceMs=now, no trip", () => {
  const d = decideHeadDivergence(A, B, null, 5000, GRACE);
  expect(d.suppress).toBe(true);
  expect(d.sinceMs).toBe(5000);
  expect(d.trip).toBe(false);
});

test("decideHeadDivergence: ongoing divergence carries sinceMs forward until the grace window elapses", () => {
  // 30s in — still within grace.
  expect(decideHeadDivergence(A, B, 5000, 35_000, GRACE)).toEqual({
    suppress: true,
    sinceMs: 5000,
    trip: false,
  });
  // exactly grace later — trips.
  expect(decideHeadDivergence(A, B, 5000, 5000 + GRACE, GRACE)).toEqual({
    suppress: true,
    sinceMs: 5000,
    trip: true,
  });
});

test("decideHeadDivergence: a transient blip (commit race) that re-agrees never trips", () => {
  // Divergent at t=5000 (commit just landed, worker not yet caught up)...
  const blip = decideHeadDivergence(A, B, null, 5000, GRACE);
  expect(blip.suppress).toBe(true);
  // ...then the next read agrees → reset, so the grace timer never accumulates.
  const recovered = decideHeadDivergence(B, B, blip.sinceMs, 5500, GRACE);
  expect(recovered).toEqual({ suppress: false, sinceMs: null, trip: false });
});

// ---------------------------------------------------------------------------
// parseTaskTrailers — collect-all policy on the `Task:` trailer block.
// Distinct from parseSessionIdTrailer's take-last: a commit closing N tasks
// must light N entries on the link fold.
// ---------------------------------------------------------------------------

const VALID_TASK_1 = "fn-670-deterministic-committing-session.1";
const VALID_TASK_2 = "fn-670-deterministic-committing-session.2";

test("parseTaskTrailers returns [] on null/empty/whitespace/non-string input", () => {
  expect(parseTaskTrailers(null)).toEqual([]);
  expect(parseTaskTrailers(undefined)).toEqual([]);
  expect(parseTaskTrailers("")).toEqual([]);
  expect(parseTaskTrailers("   \n\t\n")).toEqual([]);
  expect(parseTaskTrailers(42)).toEqual([]);
});

test("parseTaskTrailers collects ALL valid task-id lines on the value block", () => {
  // Newline-separated (the default git separator with our format string).
  expect(parseTaskTrailers(`${VALID_TASK_1}\n${VALID_TASK_2}\n`)).toEqual([
    VALID_TASK_1,
    VALID_TASK_2,
  ]);
  // NUL-separated (the belt-and-suspenders accept path).
  expect(parseTaskTrailers(`${VALID_TASK_1}\0${VALID_TASK_2}\0`)).toEqual([
    VALID_TASK_1,
    VALID_TASK_2,
  ]);
  // Single value, no trailing newline.
  expect(parseTaskTrailers(VALID_TASK_1)).toEqual([VALID_TASK_1]);
});

test("parseTaskTrailers drops garbage entries without failing the whole list", () => {
  // Partial-validation: keep the validated subset, drop malformed entries.
  expect(
    parseTaskTrailers(`${VALID_TASK_1}\nNOT-A-TASK\n${VALID_TASK_2}\n`),
  ).toEqual([VALID_TASK_1, VALID_TASK_2]);
  // Epic-only ref (no `.N` tail) — drops (the link fold keys on task id).
  expect(parseTaskTrailers("fn-1-foo\n")).toEqual([]);
  // Uppercase — drops (case-sensitive shape).
  expect(parseTaskTrailers("FN-1-FOO.1\n")).toEqual([]);
  // Leading/trailing whitespace — trimmed then validated.
  expect(parseTaskTrailers(`  ${VALID_TASK_1}  \n`)).toEqual([VALID_TASK_1]);
});

test("parseTaskTrailers preserves order across multiple values", () => {
  // The T2 link fold doesn't depend on order (it stamps both tasks
  // identically), but iteration-order stability matters for re-fold
  // determinism on later consumers — assert it explicitly.
  expect(parseTaskTrailers(`${VALID_TASK_2}\n${VALID_TASK_1}\n`)).toEqual([
    VALID_TASK_2,
    VALID_TASK_1,
  ]);
});

// ---------------------------------------------------------------------------
// enumerateCommitsInDelta — real-git round-trip for Session-Id, Job-Id, and
// Task trailers. Pins the widened format string + stride parser against a
// concrete commit so an off-by-one regression in the 6-field consume loop is
// caught at the trailer assertion (rather than silently misaligning fields).
// ---------------------------------------------------------------------------

function gitCommit(
  root: string,
  filename: string,
  body: string,
  trailers: Record<string, string[]>,
): string {
  writeFileSync(join(root, filename), `${filename} contents\n`);
  let res = Bun.spawnSync(["git", "-C", root, "add", "-A"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!res.success) throw new Error("git add failed");
  // Build the message via `git interpret-trailers` so the trailers land
  // in the canonical kebab-case + colon-space shape the producer's
  // format string keys on. `-c` top-level overrides must come BEFORE the
  // subcommand; one `--trailer` per value (multi-`Task:` is supported
  // via `addIfDifferent`).
  const topConfig: string[] = [];
  const trailerArgs: string[] = [];
  for (const [key, values] of Object.entries(trailers)) {
    topConfig.push(
      "-c",
      `trailer.${key.toLowerCase()}.ifExists=addIfDifferent`,
    );
    for (const v of values) {
      trailerArgs.push("--trailer", `${key}=${v}`);
    }
  }
  const it = Bun.spawnSync(
    ["git", ...topConfig, "-C", root, "interpret-trailers", ...trailerArgs],
    {
      stdin: new TextEncoder().encode(body),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (!it.success) {
    throw new Error(`git interpret-trailers failed: ${it.stderr.toString()}`);
  }
  const msg = it.stdout.toString();
  res = Bun.spawnSync(["git", "-C", root, "commit", "-q", "-F", "-"], {
    stdin: new TextEncoder().encode(msg),
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!res.success) throw new Error("git commit failed");
  const rev = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (!rev.success) throw new Error("git rev-parse HEAD failed");
  return rev.stdout.toString().trim();
}

const REAL_UUID_A = "01234567-89ab-cdef-0123-456789abcdef";
const REAL_UUID_B = "fedcba98-7654-3210-fedc-ba9876543210";

test("enumerateCommitsInDelta: Session-Id-only commit → committer_session_id set, task_ids=[]", () => {
  const root = mkTmpWorktree();
  gitInit(root);
  const oid = gitCommit(root, "a.ts", "msg\n", {
    "Session-Id": [REAL_UUID_A],
  });
  const commits = enumerateCommitsInDelta(root, null, oid);
  expect(commits).toHaveLength(1);
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([]);
});

test("enumerateCommitsInDelta: Job-Id-only commit → committer_session_id coalesces from Job-Id", () => {
  // This is the load-bearing case: a jobctl-stamped commit (no Session-Id,
  // Job-Id only). Pre-fn-670 this commit's committer_session_id was NULL
  // and the v45 per-session discharge arm in foldCommit lay dormant.
  // Post-fn-670 the coalesce lifts Job-Id into committer_session_id, so
  // the per-session arm finally fires for jobctl commits.
  const root = mkTmpWorktree();
  gitInit(root);
  const oid = gitCommit(root, "a.ts", "msg\n", {
    "Job-Id": [REAL_UUID_A],
  });
  const commits = enumerateCommitsInDelta(root, null, oid);
  expect(commits).toHaveLength(1);
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([]);
});

test("enumerateCommitsInDelta: Session-Id + Job-Id equal → Session-Id wins (no warn)", () => {
  // The canonical commit-work commit: jobctl stamps Job-Id == Session-Id
  // (keeper invariant). The coalesce takes Session-Id and emits NO warn.
  const root = mkTmpWorktree();
  gitInit(root);
  const oid = gitCommit(root, "a.ts", "msg\n", {
    "Session-Id": [REAL_UUID_A],
    "Job-Id": [REAL_UUID_A],
  });
  // Capture stderr by spying on console.error. The producer's only stderr
  // surface in this path is the both-differing warn; equality must not
  // trip it.
  const errs: unknown[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args);
  };
  try {
    const commits = enumerateCommitsInDelta(root, null, oid);
    expect(commits).toHaveLength(1);
    expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  } finally {
    console.error = orig;
  }
  expect(errs).toEqual([]);
});

test("enumerateCommitsInDelta: Session-Id + Job-Id DIFFER → Session-Id wins AND stderr warn fires", () => {
  // Bug-signal case: the keeper invariant `job_id === session_id` is
  // violated. We don't fail the commit (the producer-only liveness
  // invariant + hook exit-0 contract forbid escalating from a trailer
  // mismatch), but we log a stderr warn so a forensic grep can find it.
  const root = mkTmpWorktree();
  gitInit(root);
  const oid = gitCommit(root, "a.ts", "msg\n", {
    "Session-Id": [REAL_UUID_A],
    "Job-Id": [REAL_UUID_B],
  });
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const commits = enumerateCommitsInDelta(root, null, oid);
    expect(commits).toHaveLength(1);
    // Session-Id wins per take-last canonical policy.
    expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  } finally {
    console.error = orig;
  }
  expect(errs).toHaveLength(1);
  expect(errs[0]).toContain("DIFFER");
  expect(errs[0]).toContain(REAL_UUID_A);
  expect(errs[0]).toContain(REAL_UUID_B);
});

test("enumerateCommitsInDelta: no trailers → committer_session_id=null, task_ids=[]", () => {
  // The historical-shape commit: human commit / CI commit / pre-jobctl
  // commit. Global-discharge semantic preserved (foldCommit's null arm).
  const root = mkTmpWorktree();
  gitInit(root);
  const oid = gitCommit(root, "a.ts", "msg\n", {});
  const commits = enumerateCommitsInDelta(root, null, oid);
  expect(commits).toHaveLength(1);
  expect(commits[0].committer_session_id).toBeNull();
  expect(commits[0].task_ids).toEqual([]);
});

test("enumerateCommitsInDelta: one Task: trailer → task_ids carries one entry", () => {
  const root = mkTmpWorktree();
  gitInit(root);
  const oid = gitCommit(root, "a.ts", "msg\n", {
    "Session-Id": [REAL_UUID_A],
    Task: [VALID_TASK_1],
  });
  const commits = enumerateCommitsInDelta(root, null, oid);
  expect(commits).toHaveLength(1);
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([VALID_TASK_1]);
});

test("enumerateCommitsInDelta: multiple Task: trailers → task_ids collects ALL entries", () => {
  // The multi-close case: one commit closes two tasks. Both must land on
  // the link fold; take-last would lose one.
  const root = mkTmpWorktree();
  gitInit(root);
  const oid = gitCommit(root, "a.ts", "msg\n", {
    "Session-Id": [REAL_UUID_A],
    Task: [VALID_TASK_1, VALID_TASK_2],
  });
  const commits = enumerateCommitsInDelta(root, null, oid);
  expect(commits).toHaveLength(1);
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([VALID_TASK_1, VALID_TASK_2]);
});

test("enumerateCommitsInDelta: all three trailers together → stride parser holds (no off-by-one)", () => {
  // The full-fan-out case. If the 6-field stride parser is off by one,
  // task_ids would silently swap with another field and one of the
  // assertions below would fail.
  const root = mkTmpWorktree();
  gitInit(root);
  const oid = gitCommit(root, "a.ts", "msg\n", {
    "Session-Id": [REAL_UUID_A],
    "Job-Id": [REAL_UUID_A],
    Task: [VALID_TASK_1, VALID_TASK_2],
  });
  const commits = enumerateCommitsInDelta(root, null, oid);
  expect(commits).toHaveLength(1);
  expect(commits[0].commit_oid).toBe(oid);
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([VALID_TASK_1, VALID_TASK_2]);
  expect(commits[0].committed_at_ms).toBeGreaterThan(0);
});

test("enumerateCommitsInDelta: multi-commit delta — each commit's trailers parse independently", () => {
  // Stride parser exercise across N>1 commits. A regression that drifts
  // the field offset would surface as one commit reading the next
  // commit's session/tasks.
  const root = mkTmpWorktree();
  gitInit(root);
  const oid1 = gitCommit(root, "a.ts", "first\n", {
    "Job-Id": [REAL_UUID_A],
    Task: [VALID_TASK_1],
  });
  const oid2 = gitCommit(root, "b.ts", "second\n", {
    "Session-Id": [REAL_UUID_B],
    Task: [VALID_TASK_2],
  });
  // `oid1..oid2` walks commits strictly after oid1; oid2 is included.
  const commits = enumerateCommitsInDelta(root, oid1, oid2);
  // Just the second commit in the delta.
  expect(commits).toHaveLength(1);
  expect(commits[0].commit_oid).toBe(oid2);
  expect(commits[0].committer_session_id).toBe(REAL_UUID_B);
  expect(commits[0].task_ids).toEqual([VALID_TASK_2]);

  // Full-delta walk: null prev → both commits emitted (newest-first).
  const fullCommits = enumerateCommitsInDelta(root, null, oid2);
  expect(fullCommits).toHaveLength(1); // fallback path is `-1 <next>` only
  expect(fullCommits[0].commit_oid).toBe(oid2);

  // Walk the whole history via the parent of oid1 → null prev fallback
  // covers only HEAD; assert independent re-enumeration of oid1.
  const firstAlone = enumerateCommitsInDelta(root, null, oid1);
  expect(firstAlone).toHaveLength(1);
  expect(firstAlone[0].commit_oid).toBe(oid1);
  expect(firstAlone[0].committer_session_id).toBe(REAL_UUID_A);
  expect(firstAlone[0].task_ids).toEqual([VALID_TASK_1]);
});

// ---------------------------------------------------------------------------
// extractCommit — fn-670 task_ids defensive decode
// ---------------------------------------------------------------------------

test("extractCommit decodes task_ids when present (round-trip the producer's shape)", () => {
  const res = extractCommit({
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: VALID_OID,
      parent_oid: null,
      files: [
        { path: "src/a.ts", blob_oid: VALID_OID, committed_mode: "100644" },
      ],
      committer_session_id: VALID_UUID,
      task_ids: [VALID_TASK_1, VALID_TASK_2],
      committed_at_ms: 1000,
    }),
  });
  expect(res?.task_ids).toEqual([VALID_TASK_1, VALID_TASK_2]);
});

test("extractCommit defaults task_ids to [] on pre-fn-670 events (missing field)", () => {
  // Re-fold determinism: every historical Commit event in the log lacks
  // `task_ids`; the deriver must decode it as `[]` so the T2 link fold
  // sees the same "no linkage" input the live producer would emit on a
  // commit with no Task: trailer.
  const res = extractCommit({
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: VALID_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: VALID_UUID,
      committed_at_ms: 1000,
    }),
  });
  expect(res?.task_ids).toEqual([]);
});

test("extractCommit drops malformed task_ids entries (per-entry validation, not all-or-nothing)", () => {
  // Per-entry shape gate via TASK_TRAILER_RE: epic-only refs, uppercase,
  // non-strings drop; valid entries pass through in input order.
  const res = extractCommit({
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: VALID_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: VALID_UUID,
      task_ids: [
        VALID_TASK_1,
        "fn-1-foo", // epic-only ref → drops
        "FN-1-FOO.1", // uppercase → drops
        42, // non-string → drops
        "", // empty → drops
        VALID_TASK_2,
      ],
      committed_at_ms: 0,
    }),
  });
  expect(res?.task_ids).toEqual([VALID_TASK_1, VALID_TASK_2]);
});

test("extractCommit normalizes non-array task_ids to []", () => {
  // Object instead of array, scalar instead of array, null — all fold to
  // [] without failing the whole payload.
  for (const bad of [{ foo: 1 }, "fn-1-foo.1", 42, null] as const) {
    const res = extractCommit({
      data: JSON.stringify({
        project_dir: "/repo",
        commit_oid: VALID_OID,
        parent_oid: null,
        files: ["src/a.ts"],
        committer_session_id: VALID_UUID,
        task_ids: bad,
        committed_at_ms: 0,
      }),
    });
    expect(res?.task_ids).toEqual([]);
  }
});
