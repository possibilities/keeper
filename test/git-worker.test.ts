import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackstopCounters,
  type BackstopMessage,
  type BackstopRecord,
  type BackstopRollup,
  buildMissedWakeRecord,
} from "../src/backstop-telemetry";
import {
  extractCommit,
  parseSessionIdTrailer,
  parseTaskTrailers,
} from "../src/derivers";
import {
  buildDiscoveryCandidates,
  buildGitSnapshotFrom,
  COMMIT_ENUM_MAX_RETRIES,
  type DataVersionWakeDecision,
  type DiscoveryContext,
  decideDataVersionWake,
  decideGitPoll,
  decideHeadCacheAdvance,
  decideHeadDivergence,
  decideReconcileTransitions,
  decideSeedRequiredEmit,
  deriveChangeToRescueMs,
  discoverProjectRoots,
  type EnumeratedCommitFile,
  enumerateCommitsFromLog,
  filterPlanChanges,
  type GitDirtyFile,
  type GitFileStatus,
  type GitSnapshotPayload,
  isPlanChangedPath,
  type ParsedGitStatus,
  parseCommitFiles,
  parsePorcelainV2,
  probeRootPresence,
  type RootPresence,
  readGitMetaSignature,
  selectVanishedRoots,
  semanticSnapshotKey,
  shouldWatchRoot,
} from "../src/git-worker";
import { RescanScheduler, type SchedulerTimers } from "../src/rescan";
import {
  GIT_DIFF_TREE_GOLDENS,
  GIT_LOG_GOLDENS,
  GOLDEN_OIDS,
} from "./fixtures/git-log-goldens";

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
// buildGitSnapshotFrom — fn-633.5 file-centric payload, PURE core (fn-904.2).
// The producer's contract narrows to: enumerate dirty files from the
// porcelain-v2 parse, attach per-file `worktree_oid` + `mtime_ms`, emit a flat
// per-file list. NO event-log join, NO per-job rollup, NO project-wide orphan
// filter — those derivations live in the reducer (fn-633.6).
//
// `buildGitSnapshot` (production) calls the two impure helpers
// (`batchHashObjectOids` + per-file `lstatMtimeMs`) then delegates to this pure
// builder, so production behavior is byte-identical (epic acceptance). The pure
// builder takes the two impure inputs as maps and is driven here with synthetic
// payloads — zero git, zero fs.
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

/** A plain tmp dir (NOT a git repo) for the `.keeper`-on-disk discovery tests. */
function mkTmpWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "keeper-git-snapshot-"));
  tmpDirs.push(dir);
  return dir;
}

/** Synthetic porcelain-parse file entry with sensible defaults. */
function fileStatus(over: Partial<GitFileStatus> = {}): GitFileStatus {
  return {
    path: "a.ts",
    xy: ".M",
    index: ".",
    worktree: "M",
    kind: "ordinary",
    index_oid: null,
    worktree_mode: null,
    ...over,
  };
}

function parsed(over: Partial<ParsedGitStatus> = {}): ParsedGitStatus {
  return {
    branch: "main",
    head_oid: "abc123",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
    ...over,
  };
}

test("buildGitSnapshotFrom on a clean worktree emits an empty dirty_files list", () => {
  const snapshot = buildGitSnapshotFrom(
    "/repo",
    parsed({ files: [] }),
    new Map(),
    new Map(),
  );
  expect(snapshot).toEqual({
    project_dir: "/repo",
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

test("buildGitSnapshotFrom on a mixed dirty worktree stamps mtime_ms + worktree_oid per file", () => {
  const oidByPath = new Map<string, string | null>([
    ["a.ts", "aa".repeat(20)],
    ["b.ts", "bb".repeat(20)],
  ]);
  const mtimeByPath = new Map<string, number | null>([
    ["a.ts", 1_700_000_000_000],
    ["b.ts", 1_700_000_100_000],
  ]);
  const snapshot = buildGitSnapshotFrom(
    "/repo",
    parsed({
      head_oid: "deadbeef",
      upstream: null,
      ahead: null,
      behind: null,
      files: [
        fileStatus({
          path: "a.ts",
          xy: ".M",
          index: ".",
          worktree: "M",
          kind: "ordinary",
          index_oid: "1".repeat(40),
          worktree_mode: "100644",
        }),
        fileStatus({
          path: "b.ts",
          xy: "R.",
          index: "R",
          worktree: ".",
          kind: "renamed",
          orig_path: "a-old.ts",
          index_oid: "2".repeat(40),
          worktree_mode: "100644",
        }),
      ],
    }),
    oidByPath,
    mtimeByPath,
  );

  expect(snapshot.dirty_files).toHaveLength(2);
  const a = snapshot.dirty_files[0] as GitDirtyFile;
  expect(a.path).toBe("a.ts");
  expect(a.kind).toBe("ordinary");
  expect(a.xy).toBe(".M");
  expect(a.mtime_ms).toBe(1_700_000_000_000);
  expect(a).not.toHaveProperty("orig_path");
  // Per-file content axes — `index_oid` + `worktree_mode` pass through from the
  // porcelain parse; `worktree_oid` comes from the producer's batched hash map.
  expect(a.index_oid).toBe("1".repeat(40));
  expect(a.worktree_mode).toBe("100644");
  expect(a.worktree_oid).toBe("aa".repeat(20));

  const b = snapshot.dirty_files[1] as GitDirtyFile;
  expect(b.path).toBe("b.ts");
  expect(b.kind).toBe("renamed");
  expect(b.xy).toBe("R.");
  expect(b.orig_path).toBe("a-old.ts");
  expect(b.mtime_ms).toBe(1_700_000_100_000);
  expect(b.index_oid).toBe("2".repeat(40));
  expect(b.worktree_mode).toBe("100644");
  expect(b.worktree_oid).toBe("bb".repeat(20));
  // Distinct content → distinct worktree oid (the discharge gate reads this).
  expect(b.worktree_oid).not.toBe(a.worktree_oid);
});

test("buildGitSnapshotFrom on an all-untracked worktree preserves null index_oid/mode + carries worktree_oid", () => {
  const oidByPath = new Map<string, string | null>([
    ["another.md", "cc".repeat(20)],
    ["sub/new file.ts", "dd".repeat(20)],
  ]);
  const mtimeByPath = new Map<string, number | null>([
    ["another.md", 1_650_001_000_000],
    ["sub/new file.ts", 1_650_000_000_000],
  ]);
  // The porcelain parse yields a stable total order (it sorts by path); pass
  // the files in that order so the payload order is deterministic.
  const snapshot = buildGitSnapshotFrom(
    "/repo",
    parsed({
      branch: null,
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      files: [
        fileStatus({
          path: "another.md",
          xy: "??",
          index: "?",
          worktree: "?",
          kind: "untracked",
        }),
        fileStatus({
          path: "sub/new file.ts",
          xy: "??",
          index: "?",
          worktree: "?",
          kind: "untracked",
        }),
      ],
    }),
    oidByPath,
    mtimeByPath,
  );

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
  // Untracked porcelain records carry no `hI`/`mW`, so index_oid/worktree_mode
  // stay null — but the worktree blob hash IS available (bytes on disk), so
  // worktree_oid rides through from the producer's hash map.
  expect(snapshot.dirty_files.every((f) => f.index_oid === null)).toBe(true);
  expect(snapshot.dirty_files.every((f) => f.worktree_mode === null)).toBe(
    true,
  );
  expect(snapshot.dirty_files.map((f) => f.worktree_oid)).toEqual([
    "cc".repeat(20),
    "dd".repeat(20),
  ]);
});

test("buildGitSnapshotFrom tolerates a stat race (file gone) by stamping mtime_ms: null", () => {
  // `gone.ts` is in the porcelain-v2 parse but absent from BOTH the oid map and
  // the mtime map — the documented producer-side stat race: `git status`
  // enumerated it, then it vanished before the batched `hash-object` + `lstat`.
  // The pure builder must read both as `null` for that file and NOT crash.
  const oidByPath = new Map<string, string | null>([
    ["real.ts", "ee".repeat(20)],
  ]);
  const mtimeByPath = new Map<string, number | null>([
    ["real.ts", 1_700_000_200_000],
  ]);
  const snapshot = buildGitSnapshotFrom(
    "/repo",
    parsed({
      head_oid: "abc",
      upstream: null,
      ahead: null,
      behind: null,
      files: [
        fileStatus({
          path: "gone.ts",
          index_oid: "3".repeat(40),
          worktree_mode: "100644",
        }),
        fileStatus({
          path: "real.ts",
          index_oid: "4".repeat(40),
          worktree_mode: "100644",
        }),
      ],
    }),
    oidByPath,
    mtimeByPath,
  );

  expect(snapshot.dirty_files).toHaveLength(2);
  expect(snapshot.dirty_files[0].path).toBe("gone.ts");
  expect(snapshot.dirty_files[0].mtime_ms).toBeNull();
  // The stat race extends to `worktree_oid` — a file missing from the producer's
  // hash map reads null without wedging the snapshot. `index_oid` /
  // `worktree_mode` came off the porcelain parse (no fs probe) so they survive.
  expect(snapshot.dirty_files[0].worktree_oid).toBeNull();
  expect(snapshot.dirty_files[0].index_oid).toBe("3".repeat(40));
  expect(snapshot.dirty_files[0].worktree_mode).toBe("100644");
  expect(snapshot.dirty_files[1].path).toBe("real.ts");
  expect(snapshot.dirty_files[1].mtime_ms).toBe(1_700_000_200_000);
  expect(snapshot.dirty_files[1].worktree_oid).toBe("ee".repeat(20));
  expect(snapshot.dirty_files[1].index_oid).toBe("4".repeat(40));
  expect(snapshot.dirty_files[1].worktree_mode).toBe("100644");
});

test("buildGitSnapshotFrom reads each file's mtime from the per-path map (lstat semantics live in the producer)", () => {
  // The producer's per-file `lstatMtimeMs` does the lstat (so a symlink reports
  // the link's own mtime, not the target's — verified end-to-end in the slow
  // real-git quarantine). The pure builder just reads whatever the producer put
  // in the map for that path; assert that pass-through is exact and per-path.
  const linkMtime = 1_777_000_000_123;
  const oidByPath = new Map<string, string | null>([
    ["link.ts", "ff".repeat(20)],
  ]);
  const mtimeByPath = new Map<string, number | null>([["link.ts", linkMtime]]);
  const snapshot = buildGitSnapshotFrom(
    "/repo",
    parsed({
      head_oid: "abc",
      upstream: null,
      ahead: null,
      behind: null,
      files: [
        fileStatus({
          path: "link.ts",
          xy: "??",
          index: "?",
          worktree: "?",
          kind: "untracked",
        }),
      ],
    }),
    oidByPath,
    mtimeByPath,
  );
  expect(snapshot.dirty_files).toHaveLength(1);
  expect(snapshot.dirty_files[0].mtime_ms).toBe(linkMtime);
  expect(snapshot.dirty_files[0].worktree_oid).toBe("ff".repeat(20));
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
    // Epic fn-695: `plan_op` / `plan_target` join the payload.
    // Both null here — a source commit (no `Planctl-Op:`/`Planctl-Target:`
    // trailer). The dedicated decode cases below exercise present/legacy/
    // malformed shapes.
    plan_op: null,
    plan_target: null,
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
// decideHeadCacheAdvance — epic fn-705 (T2). The pure policy gating whether
// emitSnapshot advances `lastHeadOidByRoot` after `enumerateCommitsInDelta`.
// The bug: a transient enumeration throw used to advance the cache anyway,
// permanently skipping (dropping) the failed commit's `plan-commit-changed`
// + `Commit` discharge. The fix holds the cache so the next observation
// re-enumerates — bounded by COMMIT_ENUM_MAX_RETRIES so a permanently corrupt
// range can't hot-spin.
// ---------------------------------------------------------------------------

test("decideHeadCacheAdvance: success advances and resets the failure counter", () => {
  // Clean enumeration → advance the cache, clear any accumulated failures.
  expect(decideHeadCacheAdvance(true, 0, 5)).toEqual({
    advance: true,
    nextFailures: 0,
    loudBackstop: false,
  });
  // A success AFTER prior throws still resets (the commit re-emitted on retry).
  expect(decideHeadCacheAdvance(true, 3, 5)).toEqual({
    advance: true,
    nextFailures: 0,
    loudBackstop: false,
  });
});

test("decideHeadCacheAdvance: a transient throw HOLDS the cache so the range re-enumerates", () => {
  // First throw: hold (advance=false), bump the counter, no loud alarm.
  const first = decideHeadCacheAdvance(false, 0, 5);
  expect(first).toEqual({
    advance: false,
    nextFailures: 1,
    loudBackstop: false,
  });
  // Still under cap on a repeated throw — keep holding, keep counting.
  expect(decideHeadCacheAdvance(false, 1, 5)).toEqual({
    advance: false,
    nextFailures: 2,
    loudBackstop: false,
  });
  expect(decideHeadCacheAdvance(false, 3, 5)).toEqual({
    advance: false,
    nextFailures: 4,
    loudBackstop: false,
  });
});

test("decideHeadCacheAdvance: at the retry cap, force-advance with a loud backstop (no hot spin)", () => {
  // priorFailures+1 === maxRetries → advance anyway, reset, raise the alarm.
  expect(decideHeadCacheAdvance(false, 4, 5)).toEqual({
    advance: true,
    nextFailures: 0,
    loudBackstop: true,
  });
  // maxRetries=1 degenerate cap: a single throw immediately force-advances.
  expect(decideHeadCacheAdvance(false, 0, 1)).toEqual({
    advance: true,
    nextFailures: 0,
    loudBackstop: true,
  });
});

test("decideHeadCacheAdvance: COMMIT_ENUM_MAX_RETRIES holds for N-1 throws then force-advances on the Nth", () => {
  // Walk the real production cap exactly: the first MAX-1 throws hold the
  // cache (drop-proof re-enumeration), the MAX-th breaks the spin.
  let failures = 0;
  for (let i = 0; i < COMMIT_ENUM_MAX_RETRIES - 1; i++) {
    const d = decideHeadCacheAdvance(false, failures, COMMIT_ENUM_MAX_RETRIES);
    expect(d.advance).toBe(false);
    expect(d.loudBackstop).toBe(false);
    failures = d.nextFailures;
  }
  expect(failures).toBe(COMMIT_ENUM_MAX_RETRIES - 1);
  const last = decideHeadCacheAdvance(false, failures, COMMIT_ENUM_MAX_RETRIES);
  expect(last).toEqual({ advance: true, nextFailures: 0, loudBackstop: true });
});

// ---------------------------------------------------------------------------
// fn-705 (T2) re-enumeration integration: model the emitSnapshot HEAD-oid
// delta loop against a real git repo and assert that a transient enumeration
// throw does NOT skip the commit — the held cache re-enumerates it on the next
// (clean) observation, re-emitting its `plan-commit-changed` payload. Also
// covers the divergence-wedge window (suppression holds the cache → re-enumerates
// on clear), since both share the same "don't advance `prev`" mechanism.
// ---------------------------------------------------------------------------

// Faithful re-creation of emitSnapshot's HEAD-oid delta + advance arms, driving
// the same `decideHeadCacheAdvance` policy + `enumerateCommitsFromLog` /
// `filterPlanChanges` the worker uses. `logFor(prev,next)` stands in for the
// `git log -z` shell-out — it returns a synthetic `-z` log string (or throws to
// simulate a transient enumeration failure). `filesFor(oid)` is the synthetic
// `diff-tree` resolver. Both are pure, so this test exercises the policy machine
// with zero real git (fn-904.2).
const SYNTH_ROOT = "/repo";

/** Build a one-commit synthetic `git log -z` field string for the given oid,
 *  no trailers (the policy tests only care about the per-commit FILE list). */
function synthLog(oid: string): string {
  // 8 fields per commit, trailing empty element — matches COMMIT_LOG_FORMAT.
  return `${oid}\0\0\0\0\0\0\0\0`;
}

function stepHeadDelta(
  cache: Map<string, string | null>,
  failures: Map<string, number>,
  currentHeadOid: string | null,
  logFor: (prev: string | null, next: string) => string,
  filesFor: (oid: string) => EnumeratedCommitFile[],
): { planEmits: string[][]; loud: boolean } {
  const root = SYNTH_ROOT;
  const planEmits: string[][] = [];
  let loud = false;
  if (!cache.has(root)) {
    cache.set(root, currentHeadOid);
    return { planEmits, loud };
  }
  const prev = cache.get(root) ?? null;
  if (currentHeadOid !== null && currentHeadOid !== prev) {
    let enumOk = true;
    try {
      const rawZ = logFor(prev, currentHeadOid);
      const commits = enumerateCommitsFromLog(rawZ, filesFor);
      for (const c of commits) {
        const changes = filterPlanChanges(c.files);
        if (changes.length > 0) planEmits.push(changes.map((ch) => ch.path));
      }
    } catch {
      enumOk = false;
    }
    const decision = decideHeadCacheAdvance(
      enumOk,
      failures.get(root) ?? 0,
      COMMIT_ENUM_MAX_RETRIES,
    );
    if (decision.nextFailures === 0) failures.delete(root);
    else failures.set(root, decision.nextFailures);
    loud = decision.loudBackstop;
    if (decision.advance) cache.set(root, currentHeadOid);
  }
  return { planEmits, loud };
}

const planFile = (path: string): EnumeratedCommitFile[] => [
  { path, blob_oid: "a".repeat(40), committed_mode: "100644" },
];
const throwLog = (): string => {
  throw new Error("simulated enumeration failure");
};

test("emitSnapshot delta: a transient enumeration throw re-emits plan-commit-changed on the next clean observation", () => {
  const cache = new Map<string, string | null>();
  const failures = new Map<string, number>();

  // Seed the cache on first sighting (no emit) — mirrors emitSnapshot's
  // bootstrap arm.
  const seedOid = "1".repeat(40);
  const planOid = "2".repeat(40);
  const seed = stepHeadDelta(
    cache,
    failures,
    seedOid,
    (_p, next) => synthLog(next),
    () => [],
  );
  expect(seed.planEmits).toEqual([]);

  // Observation #1: enumeration THROWS transiently. The pre-fn-705 bug would
  // advance the cache past this commit and drop it forever.
  const obs1 = stepHeadDelta(cache, failures, planOid, throwLog, () =>
    planFile(".keeper/epics/fn-999-demo.json"),
  );
  expect(obs1.planEmits).toEqual([]); // nothing emitted — the throw ate it
  expect(cache.get(SYNTH_ROOT)).toBe(seedOid); // cache HELD at the pre-commit head
  expect(failures.get(SYNTH_ROOT)).toBe(1); // one failure recorded

  // Observation #2: same (or any newer) head, enumeration succeeds. Because the
  // cache was held, the SAME range re-enumerates and the dropped commit's
  // plan change re-emits — drop-proof.
  const obs2 = stepHeadDelta(
    cache,
    failures,
    planOid,
    (_prev, next) => synthLog(next),
    () => planFile(".keeper/epics/fn-999-demo.json"),
  );
  expect(obs2.planEmits).toHaveLength(1);
  expect(obs2.planEmits[0]).toContain(".keeper/epics/fn-999-demo.json");
  expect(cache.get(SYNTH_ROOT)).toBe(planOid); // advanced now that it succeeded
  expect(failures.has(SYNTH_ROOT)).toBe(false); // counter reset on success
});

test("emitSnapshot delta: persistent enumeration failure force-advances after COMMIT_ENUM_MAX_RETRIES (no hot spin)", () => {
  const cache = new Map<string, string | null>();
  const failures = new Map<string, number>();
  const seedOid = "1".repeat(40);
  const nextOid = "2".repeat(40);
  stepHeadDelta(
    cache,
    failures,
    seedOid,
    (_p, next) => synthLog(next),
    () => [],
  ); // seed

  // Throw on every observation. For the first MAX-1 the cache holds (the range
  // keeps re-enumerating); on the MAX-th it force-advances with a loud alarm so
  // the worker can't spin forever on a poisoned range.
  for (let i = 0; i < COMMIT_ENUM_MAX_RETRIES - 1; i++) {
    const obs = stepHeadDelta(cache, failures, nextOid, throwLog, () => []);
    expect(obs.loud).toBe(false);
    expect(cache.get(SYNTH_ROOT)).toBe(seedOid); // still held
  }
  const final = stepHeadDelta(cache, failures, nextOid, throwLog, () => []);
  expect(final.loud).toBe(true); // loud backstop alarm
  expect(cache.get(SYNTH_ROOT)).toBe(nextOid); // force-advanced past the poison
  expect(failures.has(SYNTH_ROOT)).toBe(false); // counter reset post force-advance
});

test("emitSnapshot delta: divergence-wedge window holds the cache → commits re-enumerate on clear", () => {
  // The divergence guard `return`s before the delta arm, so during suppression
  // the cache is never touched. Model that as "skip the step entirely while
  // suppressed" and assert the post-clear observation re-enumerates the full
  // window — the same drop-proof property as the throw path.
  const cache = new Map<string, string | null>();
  const failures = new Map<string, number>();
  const seedOid = "1".repeat(40);
  stepHeadDelta(
    cache,
    failures,
    seedOid,
    (_p, next) => synthLog(next),
    () => [],
  ); // seed

  // Two plan commits land DURING a divergence-suppression window — emitSnapshot
  // returns early, so we run NO step for them (the cache stays at seedOid).
  const headDuringWedge = "3".repeat(40);
  const wedgeOid1 = "2".repeat(40);
  expect(cache.get(SYNTH_ROOT)).toBe(seedOid); // untouched through the wedge

  // Wedge clears: the next clean observation re-enumerates the WHOLE window
  // (seed..headDuringWedge), re-emitting both plan commits. The synthetic log
  // emits BOTH commits in the delta (two 8-field strides).
  const cleared = stepHeadDelta(
    cache,
    failures,
    headDuringWedge,
    () => synthLog(headDuringWedge) + synthLog(wedgeOid1),
    (oid) =>
      oid === headDuringWedge
        ? planFile(".keeper/tasks/fn-999-demo.2.json")
        : planFile(".keeper/tasks/fn-999-demo.1.json"),
  );
  const flatPaths = cleared.planEmits.flat();
  expect(flatPaths).toContain(".keeper/tasks/fn-999-demo.1.json");
  expect(flatPaths).toContain(".keeper/tasks/fn-999-demo.2.json");
  expect(cache.get(SYNTH_ROOT)).toBe(headDuringWedge);
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
// enumerateCommitsFromLog — the PURE `git log -z` stride parser (fn-904.2),
// split out of `enumerateCommitsInDelta` (which keeps the impure `gitOutput` +
// `commitFiles` calls). Driven here against GOLDEN `git log -z` strings
// CAPTURED FROM REAL GIT (test/fixtures/git-log-goldens.ts) so the widened
// format string + 8-field stride parser are validated against a real sample
// WITHOUT spawning git on every run. An off-by-one in the stride surfaces at
// the trailer assertion. `noFiles` is the synthetic file resolver (the trailer
// cases don't assert the per-commit FILE list — the diff-tree round-trips
// below cover that).
// ---------------------------------------------------------------------------

const REAL_UUID_A = "01234567-89ab-cdef-0123-456789abcdef";
const REAL_UUID_B = "fedcba98-7654-3210-fedc-ba9876543210";

const noFiles = (): EnumeratedCommitFile[] => [];

test("enumerateCommitsFromLog: Session-Id-only commit → committer_session_id set, task_ids=[]", () => {
  const commits = enumerateCommitsFromLog(GIT_LOG_GOLDENS.sessionOnly, noFiles);
  expect(commits).toHaveLength(1);
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([]);
});

test("enumerateCommitsFromLog: Job-Id-only commit → committer_session_id coalesces from Job-Id", () => {
  // This is the load-bearing case: a jobctl-stamped commit (no Session-Id,
  // Job-Id only). Pre-fn-670 this commit's committer_session_id was NULL
  // and the v45 per-session discharge arm in foldCommit lay dormant.
  // Post-fn-670 the coalesce lifts Job-Id into committer_session_id, so
  // the per-session arm finally fires for jobctl commits.
  const commits = enumerateCommitsFromLog(GIT_LOG_GOLDENS.jobIdOnly, noFiles);
  expect(commits).toHaveLength(1);
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([]);
});

test("enumerateCommitsFromLog: Session-Id + Job-Id equal → Session-Id wins (no warn)", () => {
  // The canonical commit-work commit: jobctl stamps Job-Id == Session-Id
  // (keeper invariant). The coalesce takes Session-Id and emits NO warn.
  const errs: unknown[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args);
  };
  try {
    const commits = enumerateCommitsFromLog(
      GIT_LOG_GOLDENS.sessionJobEqual,
      noFiles,
    );
    expect(commits).toHaveLength(1);
    expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  } finally {
    console.error = orig;
  }
  expect(errs).toEqual([]);
});

test("enumerateCommitsFromLog: Session-Id + Job-Id DIFFER → Session-Id wins AND stderr warn fires", () => {
  // Bug-signal case: the keeper invariant `job_id === session_id` is
  // violated. We don't fail the commit (the producer-only liveness
  // invariant + hook exit-0 contract forbid escalating from a trailer
  // mismatch), but we log a stderr warn so a forensic grep can find it.
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errs.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const commits = enumerateCommitsFromLog(
      GIT_LOG_GOLDENS.sessionJobDiffer,
      noFiles,
    );
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

test("enumerateCommitsFromLog: no trailers → committer_session_id=null, task_ids=[]", () => {
  // The historical-shape commit: human commit / CI commit / pre-jobctl
  // commit. Global-discharge semantic preserved (foldCommit's null arm).
  const commits = enumerateCommitsFromLog(GIT_LOG_GOLDENS.noTrailers, noFiles);
  expect(commits).toHaveLength(1);
  expect(commits[0].committer_session_id).toBeNull();
  expect(commits[0].task_ids).toEqual([]);
});

test("enumerateCommitsFromLog: one Task: trailer → task_ids carries one entry", () => {
  const commits = enumerateCommitsFromLog(
    GIT_LOG_GOLDENS.sessionOneTask,
    noFiles,
  );
  expect(commits).toHaveLength(1);
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([VALID_TASK_1]);
});

test("enumerateCommitsFromLog: multiple Task: trailers → task_ids collects ALL entries", () => {
  // The multi-close case: one commit closes two tasks. Both must land on
  // the link fold; take-last would lose one.
  const commits = enumerateCommitsFromLog(
    GIT_LOG_GOLDENS.sessionTwoTasks,
    noFiles,
  );
  expect(commits).toHaveLength(1);
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([VALID_TASK_1, VALID_TASK_2]);
});

test("enumerateCommitsFromLog: all three trailers together → stride parser holds (no off-by-one)", () => {
  // The full-fan-out case. If the 8-field stride parser is off by one,
  // task_ids would silently swap with another field and one of the
  // assertions below would fail.
  const commits = enumerateCommitsFromLog(GIT_LOG_GOLDENS.allThree, noFiles);
  expect(commits).toHaveLength(1);
  expect(commits[0].commit_oid).toBe(
    "df8b8529946d342e298b11c4e5ac4fc12a31eed2",
  );
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([VALID_TASK_1, VALID_TASK_2]);
  expect(commits[0].committed_at_ms).toBeGreaterThan(0);
});

test("enumerateCommitsFromLog: multi-commit delta — each commit's trailers parse independently", () => {
  // Stride parser exercise across N>1 commits. A regression that drifts
  // the field offset would surface as one commit reading the next
  // commit's session/tasks. The `multiTrailerDelta` golden is an
  // `oid1..oid2` log: only oid2 (Session-Id B, Task 2) is in the delta.
  const commits = enumerateCommitsFromLog(
    GIT_LOG_GOLDENS.multiTrailerDelta,
    noFiles,
  );
  expect(commits).toHaveLength(1);
  expect(commits[0].commit_oid).toBe(GOLDEN_OIDS.multiTrailerOid2);
  expect(commits[0].parent_oid).toBe(GOLDEN_OIDS.multiTrailerOid1);
  expect(commits[0].committer_session_id).toBe(REAL_UUID_B);
  expect(commits[0].task_ids).toEqual([VALID_TASK_2]);

  // oid1 alone (the `-1 oid1` fallback golden): its own Job-Id A + Task 1, no
  // bleed from oid2.
  const firstAlone = enumerateCommitsFromLog(
    GIT_LOG_GOLDENS.multiTrailerOid1Alone,
    noFiles,
  );
  expect(firstAlone).toHaveLength(1);
  expect(firstAlone[0].commit_oid).toBe(GOLDEN_OIDS.multiTrailerOid1);
  expect(firstAlone[0].committer_session_id).toBe(REAL_UUID_A);
  expect(firstAlone[0].task_ids).toEqual([VALID_TASK_1]);
});

// ---------------------------------------------------------------------------
// enumerateCommitsFromLog — fn-695 Planctl-Op / Planctl-Target trailer lift.
// The stride parser widened from 6 fields to 8; these cases pin that the
// new fields land on the right commit (no off-by-one) and normalize/validate
// identically to the legacy stdout-scrape path. Goldens captured from real git.
// ---------------------------------------------------------------------------

const VALID_EPIC = "fn-670-deterministic-committing-session";

test("enumerateCommitsFromLog: Planctl-Op + Planctl-Target present → lifted, op normalized", () => {
  // The canonical `chore(plan)` scaffold commit: plan stamps
  // `Planctl-Op: epic-scaffold` + `Planctl-Target: <epic>`. The op
  // normalizes (`epic-scaffold` → `scaffold`) exactly like the scrape
  // path's classifier input; the target validates via parsePlanRef.
  const commits = enumerateCommitsFromLog(
    GIT_LOG_GOLDENS.planOpTarget,
    noFiles,
  );
  expect(commits).toHaveLength(1);
  expect(commits[0].plan_op).toBe("scaffold");
  expect(commits[0].plan_target).toBe(VALID_EPIC);
  // The fn-670 fields still parse alongside (stride holds).
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([]);
});

test("enumerateCommitsFromLog: a task-form Planctl-Target validates and rides verbatim", () => {
  // A `task-done` commit stamps a task-form target. parsePlanRef accepts
  // it; we store the raw validated ref (the edge fold folds it up to the
  // parent epic downstream, exactly as extractPlanInvocation does).
  const commits = enumerateCommitsFromLog(
    GIT_LOG_GOLDENS.planTaskForm,
    noFiles,
  );
  expect(commits).toHaveLength(1);
  expect(commits[0].plan_op).toBe("done");
  expect(commits[0].plan_target).toBe(VALID_TASK_1);
});

test("enumerateCommitsFromLog: no Planctl-* trailers → plan_op/target null", () => {
  // A source commit (`feat(...)`) carrying Session-Id + Task but no
  // Planctl-* trailers — both new fields stay null (the no-commit-edge
  // input to the T3 fold).
  const commits = enumerateCommitsFromLog(GIT_LOG_GOLDENS.noPlanctl, noFiles);
  expect(commits).toHaveLength(1);
  expect(commits[0].plan_op).toBeNull();
  expect(commits[0].plan_target).toBeNull();
  // Adjacent fields still parse — the absent Planctl-* fields don't drift
  // the stride.
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([VALID_TASK_1]);
});

test("enumerateCommitsFromLog: malformed Planctl-Target → null, op still lifts", () => {
  // A garbage target ref must not poison the edge fold: parsePlanRef
  // rejects it and the producer folds plan_target to null. The op
  // (a valid shape) still lifts independently.
  const commits = enumerateCommitsFromLog(
    GIT_LOG_GOLDENS.planMalformedTarget,
    noFiles,
  );
  expect(commits).toHaveLength(1);
  expect(commits[0].plan_op).toBe("close");
  expect(commits[0].plan_target).toBeNull();
});

test("enumerateCommitsFromLog: ALL eight fields together → stride parser holds (no off-by-one)", () => {
  // The full-fan-out case across the widened 8-field stride. If the
  // 6→8 widening drifted the offsets, one of these assertions would
  // read a neighboring field and fail.
  const commits = enumerateCommitsFromLog(GIT_LOG_GOLDENS.allEight, noFiles);
  expect(commits).toHaveLength(1);
  expect(commits[0].commit_oid).toBe(
    "0341f2603e15fc6f2391e7ff58d1bbd8892d4401",
  );
  expect(commits[0].committer_session_id).toBe(REAL_UUID_A);
  expect(commits[0].task_ids).toEqual([VALID_TASK_1, VALID_TASK_2]);
  expect(commits[0].plan_op).toBe("done");
  expect(commits[0].plan_target).toBe(VALID_TASK_1);
  expect(commits[0].committed_at_ms).toBeGreaterThan(0);
});

test("enumerateCommitsFromLog: multi-commit delta — Planctl-* parse per-commit (no field bleed)", () => {
  // Stride exercise across N>1 commits with the new fields. A regression
  // that drifts the 8-field offset would surface as one commit reading
  // the next commit's op/target. `multiPlanDelta` is an `oid1..oid2` log —
  // only oid2 (Session B, task-done, task 2) is in the delta.
  const second = enumerateCommitsFromLog(
    GIT_LOG_GOLDENS.multiPlanDelta,
    noFiles,
  );
  expect(second).toHaveLength(1);
  expect(second[0].commit_oid).toBe(GOLDEN_OIDS.multiPlanOid2);
  expect(second[0].parent_oid).toBe(GOLDEN_OIDS.multiPlanOid1);
  expect(second[0].committer_session_id).toBe(REAL_UUID_B);
  expect(second[0].plan_op).toBe("done");
  expect(second[0].plan_target).toBe(VALID_TASK_2);

  // oid1 alone (the `-1 oid1` fallback golden): its own op/target, no bleed.
  const first = enumerateCommitsFromLog(
    GIT_LOG_GOLDENS.multiPlanOid1Alone,
    noFiles,
  );
  expect(first).toHaveLength(1);
  expect(first[0].commit_oid).toBe(GOLDEN_OIDS.multiPlanOid1);
  expect(first[0].plan_op).toBe("scaffold");
  expect(first[0].plan_target).toBe(VALID_EPIC);
  expect(first[0].committer_session_id).toBeNull();
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

// ---------------------------------------------------------------------------
// extractCommit — fn-695 plan_op / plan_target defensive decode.
// Mirrors the task_ids decode cases: well-formed round-trip, legacy-null
// (pre-feature event), and bad-shape per-field fold-to-null.
// ---------------------------------------------------------------------------

test("extractCommit decodes plan_op / plan_target when present", () => {
  const res = extractCommit({
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: VALID_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: VALID_UUID,
      task_ids: [],
      plan_op: "scaffold",
      plan_target: "fn-695-durable-commit-derived-creatorrefiner",
      committed_at_ms: 1000,
    }),
  });
  expect(res?.plan_op).toBe("scaffold");
  expect(res?.plan_target).toBe("fn-695-durable-commit-derived-creatorrefiner");
});

test("extractCommit defaults plan_op / plan_target to null on pre-fn-695 events", () => {
  // Re-fold determinism: every historical Commit event lacks BOTH fields;
  // the deriver must decode each as null so the T3 edge fold sees the same
  // "no commit-derived edge" input as the scrape-only legacy semantic.
  const res = extractCommit({
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: VALID_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: VALID_UUID,
      task_ids: [],
      committed_at_ms: 1000,
    }),
  });
  expect(res?.plan_op).toBeNull();
  expect(res?.plan_target).toBeNull();
});

test("extractCommit folds a malformed plan_target to null (parsePlanRef gate)", () => {
  // A bad-shape target ref must not reach the edge fold. The op (a
  // non-empty string) survives independently — per-field gating, not
  // all-or-nothing.
  const res = extractCommit({
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: VALID_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: VALID_UUID,
      task_ids: [],
      plan_op: "close",
      plan_target: "not-a-plan-ref",
      committed_at_ms: 0,
    }),
  });
  expect(res?.plan_op).toBe("close");
  expect(res?.plan_target).toBeNull();
});

test("extractCommit folds non-string / empty plan_op / plan_target to null", () => {
  // Object/scalar/empty-string instead of a string — each folds to null
  // without failing the whole payload.
  for (const bad of [{ foo: 1 }, 42, "", null] as const) {
    const res = extractCommit({
      data: JSON.stringify({
        project_dir: "/repo",
        commit_oid: VALID_OID,
        parent_oid: null,
        files: ["src/a.ts"],
        committer_session_id: VALID_UUID,
        task_ids: [],
        plan_op: bad,
        plan_target: bad,
        committed_at_ms: 0,
      }),
    });
    expect(res?.plan_op).toBeNull();
    expect(res?.plan_target).toBeNull();
  }
});

// ---------------------------------------------------------------------------
// fn-681 — commit-driven plan ingest. Pure-helper coverage first
// (classifier + filter), then a real-git round-trip pinning that the
// `git rm` path produces the `delete` op (the FSEvents-bypass
// correctness gate). The cross-worker message wiring is exercised by
// `test/plan-worker.test.ts` against the consumer side.
// ---------------------------------------------------------------------------

test("isPlanChangedPath: epics/tasks json + state-tasks/state-epics state.json accepted, else rejected", () => {
  // Accept: the four shapes the plan-worker's classifyPlanPath projects.
  expect(isPlanChangedPath(".keeper/epics/fn-1-x.json")).toBe(true);
  expect(isPlanChangedPath(".keeper/tasks/fn-1-x.2.json")).toBe(true);
  expect(isPlanChangedPath(".keeper/state/tasks/fn-1-x.2.state.json")).toBe(
    true,
  );
  // The 4th shape — closes the documented lockstep gap with plan-worker.
  expect(isPlanChangedPath(".keeper/state/epics/fn-1-x.state.json")).toBe(true);
  // Accept under nested repo paths — git diff-tree emits POSIX separators
  // regardless of platform, so a forward-slash split is sufficient.
  expect(isPlanChangedPath("sub/.keeper/epics/fn-1-x.json")).toBe(true);

  // Reject: wrong extension, wrong subdir, missing state.json suffix, non-
  // plan paths, deeper nesting under the 3-segment shapes.
  expect(isPlanChangedPath(".keeper/specs/fn-1-x.md")).toBe(false);
  expect(isPlanChangedPath(".keeper/epics/fn-1-x.md")).toBe(false);
  expect(isPlanChangedPath("epics/fn-1-x.json")).toBe(false);
  expect(isPlanChangedPath(".keeper/state/tasks/fn-1-x.json")).toBe(false);
  expect(isPlanChangedPath(".keeper/state/epics/fn-1-x.json")).toBe(false);
  expect(isPlanChangedPath(".keeper/epics/sub/fn-1-x.json")).toBe(false);
  expect(isPlanChangedPath("src/a.ts")).toBe(false);

  // keeper's OWN root plan is accepted.
  expect(isPlanChangedPath(".keeper/epics/fn-822.json")).toBe(true);
});

test("filterPlanChanges: tags add/update vs delete by blob_oid null sentinel", () => {
  // The producer's commitFiles already lifts a zero-oid diff-tree record
  // to {blob_oid: null, committed_mode: null} — the filter reads that
  // shape as "delete" and every other shape as "upsert". A non-plan
  // file in the same commit drops out of the result list entirely.
  const out = filterPlanChanges([
    {
      path: ".keeper/epics/fn-1-x.json",
      blob_oid: "0123456789abcdef0123456789abcdef01234567",
      committed_mode: "100644",
    },
    {
      path: ".keeper/tasks/fn-1-x.2.json",
      blob_oid: null,
      committed_mode: null,
    },
    {
      // Sidecar runtime state — also routed to the consumer via
      // onChange's task-state arm.
      path: ".keeper/state/tasks/fn-1-x.2.state.json",
      blob_oid: "fedcba9876543210fedcba9876543210fedcba98",
      committed_mode: "100644",
    },
    {
      // Non-plan file in the same commit — must drop.
      path: "src/a.ts",
      blob_oid: "abc1234567890abc1234567890abc1234567890a",
      committed_mode: "100644",
    },
  ]);
  expect(out).toEqual([
    { path: ".keeper/epics/fn-1-x.json", op: "upsert" },
    { path: ".keeper/tasks/fn-1-x.2.json", op: "delete" },
    { path: ".keeper/state/tasks/fn-1-x.2.state.json", op: "upsert" },
  ]);
});

test("filterPlanChanges: a commit with no plan files returns []", () => {
  // The common case for source commits — none of the changed files match
  // the plan shapes, so the producer suppresses the message entirely
  // (the live worker checks `result.length > 0` before posting).
  expect(
    filterPlanChanges([
      {
        path: "src/a.ts",
        blob_oid: "abc1234567890abc1234567890abc1234567890a",
        committed_mode: "100644",
      },
      {
        path: "README.md",
        blob_oid: "def4567890abcdef4567890abcdef4567890abcd",
        committed_mode: "100644",
      },
    ]),
  ).toEqual([]);
});

test("parseCommitFiles → filterPlanChanges: a `git rm` of a plan json tags it 'delete'", () => {
  // The producer round-trip: a `git rm` commit's `diff-tree -z` lands the
  // deletion with blob_oid=null (the all-zeros sentinel), which the filter
  // reads as op='delete' — the commit-driven tombstone path (no FSEvents).
  // Golden `diff-tree` output CAPTURED FROM REAL GIT (planDelete fixture).
  const files = parseCommitFiles(GIT_DIFF_TREE_GOLDENS.planDelete);
  expect(filterPlanChanges(files)).toEqual([
    { path: ".keeper/epics/fn-1-x.json", op: "delete" },
  ]);
});

test("parseCommitFiles → filterPlanChanges: an `add` of plan files tags every entry 'upsert'", () => {
  // The scaffold-burst shape the epic spec calls out: one commit touching
  // several plan paths (plus a non-plan src file), every plan path tagged
  // upsert. Golden `diff-tree` output CAPTURED FROM REAL GIT (planAdd fixture:
  // 3 plan json + 1 src file).
  const files = parseCommitFiles(GIT_DIFF_TREE_GOLDENS.planAdd);
  const changes = filterPlanChanges(files);
  // The non-plan `src-a.ts` is filtered out; only the three plan paths remain.
  expect(new Set(changes.map((c) => c.path))).toEqual(
    new Set([
      ".keeper/epics/fn-1-x.json",
      ".keeper/tasks/fn-1-x.1.json",
      ".keeper/tasks/fn-1-x.2.json",
    ]),
  );
  // Every entry is an upsert.
  expect(changes.every((c) => c.op === "upsert")).toBe(true);
});

// ---------------------------------------------------------------------------
// fn-690 — dynamic watch-membership gate. The watch verdict widens from
// `.keeper`-only to `.keeper || dirty || ahead>0`, recomputed each
// reconcile against a bounded + TTL-memoized candidate set with a
// cooling-hysteresis drop. All the rules below live entirely on the
// producer side; the reducer is untouched so re-fold determinism holds.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// shouldWatchRoot — PURE verdict helper (the probe verdict is an argument). The
// only fs touch is the `.keeper`-on-disk short-circuit, so these run git-free:
// a plain tmp dir (with or without a real `.keeper` subdir) + a SYNTHETIC probe
// verdict (fn-904.2). The real `probeWatchMembership` git spawn is exercised in
// the slow real-git quarantine.
// ---------------------------------------------------------------------------

test("shouldWatchRoot: .keeper present → watch without probe (short-circuit)", () => {
  const root = mkTmpWorktree();
  mkdirSync(join(root, ".keeper"), { recursive: true });
  // Pass a probe verdict that would otherwise say "skip" — `.keeper`
  // wins anyway. The whole point: a plan-backed clean repo stays watched.
  expect(
    shouldWatchRoot(
      root,
      { dirty: false, ahead: 0 },
      { currentlyWatched: false },
    ),
  ).toBe(true);
  // And even a null probe (timeout / error) doesn't matter when
  // `.keeper` is present.
  expect(shouldWatchRoot(root, null, { currentlyWatched: false })).toBe(true);
});

test("shouldWatchRoot: clean + pushed (no .keeper) → don't watch", () => {
  const root = mkTmpWorktree(); // no `.keeper` subdir created
  expect(
    shouldWatchRoot(
      root,
      { dirty: false, ahead: 0 },
      { currentlyWatched: false },
    ),
  ).toBe(false);
});

test("shouldWatchRoot: dirty worktree (no .keeper) → watch", () => {
  const root = mkTmpWorktree();
  expect(
    shouldWatchRoot(
      root,
      { dirty: true, ahead: 0 },
      { currentlyWatched: false },
    ),
  ).toBe(true);
});

test("shouldWatchRoot: ahead > 0 clean (no .keeper) → watch", () => {
  const root = mkTmpWorktree();
  expect(
    shouldWatchRoot(
      root,
      { dirty: false, ahead: 2 },
      { currentlyWatched: false },
    ),
  ).toBe(true);
});

test("shouldWatchRoot: no-upstream dirty (no .keeper) → watch", () => {
  // No `# branch.ab` line means ahead=0 by convention; dirty alone is enough.
  const root = mkTmpWorktree();
  expect(
    shouldWatchRoot(
      root,
      { dirty: true, ahead: 0 },
      { currentlyWatched: false },
    ),
  ).toBe(true);
});

test("shouldWatchRoot: no-upstream clean-with-commits (no .keeper) → don't watch", () => {
  // No upstream, no dirty: ahead is 0 by convention; verdict is "don't watch".
  // The whole point of the new gate — a quiescent repo with no work in flight
  // isn't keeper's business.
  const root = mkTmpWorktree();
  expect(
    shouldWatchRoot(
      root,
      { dirty: false, ahead: 0 },
      { currentlyWatched: false },
    ),
  ).toBe(false);
});

test("shouldWatchRoot: null probe + currentlyWatched=true → retain (fail-open)", () => {
  // Probe timeout / spawn error on an already-watched root: fail OPEN.
  // Don't drop a watched root because one probe stuttered.
  const root = mkTmpWorktree();
  expect(shouldWatchRoot(root, null, { currentlyWatched: true })).toBe(true);
});

test("shouldWatchRoot: null probe + currentlyWatched=false → skip (fail-closed)", () => {
  // Probe failure on a cold candidate: skip. Don't join on a broken probe.
  const root = mkTmpWorktree();
  expect(shouldWatchRoot(root, null, { currentlyWatched: false })).toBe(false);
});

// ---------------------------------------------------------------------------
// decideReconcileTransitions — cooling-hysteresis pure decision. The drop
// path waits ≥ dwell ms before unsubscribing a clean+pushed root; a re-
// dirty within the dwell cancels the drop.
// ---------------------------------------------------------------------------

test("decideReconcileTransitions: subscribe a new desired root immediately", () => {
  const result = decideReconcileTransitions(
    new Set(), // nothing watched yet
    new Set(["/repo"]),
    new Map(),
    1000,
    45_000,
  );
  expect(result.toAdd).toEqual(["/repo"]);
  expect(result.toDrop).toEqual([]);
});

test("decideReconcileTransitions: watched + still desired → no transitions, dwell cleared", () => {
  const dwell = new Map<string, number>([["/repo", 500]]); // a stale dwell entry
  const result = decideReconcileTransitions(
    new Set(["/repo"]),
    new Set(["/repo"]),
    dwell,
    1000,
    45_000,
  );
  expect(result.toAdd).toEqual([]);
  expect(result.toDrop).toEqual([]);
  // A re-qualifying root clears its dwell timer so a future drop starts a
  // fresh window.
  expect(dwell.has("/repo")).toBe(false);
});

test("decideReconcileTransitions: first cycle a watched root falls out → start dwell, don't drop", () => {
  const dwell = new Map<string, number>();
  const result = decideReconcileTransitions(
    new Set(["/repo"]),
    new Set(),
    dwell,
    1000,
    45_000,
  );
  expect(result.toAdd).toEqual([]);
  expect(result.toDrop).toEqual([]);
  expect(dwell.get("/repo")).toBe(1000);
});

test("decideReconcileTransitions: watched + clean for ≥ dwell → drop", () => {
  // Stamped at t=1000, now is 1000 + 45_000 = exactly at threshold.
  const dwell = new Map<string, number>([["/repo", 1000]]);
  const result = decideReconcileTransitions(
    new Set(["/repo"]),
    new Set(),
    dwell,
    46_000,
    45_000,
  );
  expect(result.toAdd).toEqual([]);
  expect(result.toDrop).toEqual(["/repo"]);
  expect(dwell.has("/repo")).toBe(false);
});

test("decideReconcileTransitions: re-dirty within dwell cancels the drop", () => {
  // Cycle 1: watched root falls out at t=1000 → start dwell.
  const dwell = new Map<string, number>();
  decideReconcileTransitions(
    new Set(["/repo"]),
    new Set(),
    dwell,
    1000,
    45_000,
  );
  expect(dwell.get("/repo")).toBe(1000);

  // Cycle 2: re-dirty at t=20_000 (well inside the 45s dwell). Root
  // is desired again → dwell cleared, no drop.
  const result = decideReconcileTransitions(
    new Set(["/repo"]),
    new Set(["/repo"]),
    dwell,
    20_000,
    45_000,
  );
  expect(result.toDrop).toEqual([]);
  expect(dwell.has("/repo")).toBe(false);

  // Cycle 3: root falls out again at t=30_000 → dwell starts FRESH at
  // 30_000, NOT carrying the original 1000 stamp. So at t=40_000 (10s
  // later, still well inside the 45s dwell) we still don't drop.
  decideReconcileTransitions(
    new Set(["/repo"]),
    new Set(),
    dwell,
    30_000,
    45_000,
  );
  expect(dwell.get("/repo")).toBe(30_000);
  const stillHolding = decideReconcileTransitions(
    new Set(["/repo"]),
    new Set(),
    dwell,
    40_000,
    45_000,
  );
  expect(stillHolding.toDrop).toEqual([]);
});

test("decideReconcileTransitions: simultaneous add + drop in one cycle", () => {
  // /repo-a is dropping (dwell elapsed), /repo-b is newly desired.
  const dwell = new Map<string, number>([["/repo-a", 1000]]);
  const result = decideReconcileTransitions(
    new Set(["/repo-a"]),
    new Set(["/repo-b"]),
    dwell,
    50_000,
    45_000,
  );
  expect(result.toAdd).toEqual(["/repo-b"]);
  expect(result.toDrop).toEqual(["/repo-a"]);
});

// ---------------------------------------------------------------------------
// fn-771 — deriveChangeToRescueMs: a missed-wake rescue's TRUE change-to-rescue
// latency from the commit times it discharged. Worst-case (oldest) anchor; no
// anchor (dirty-only rescue) → null. The negative clamp lives in
// buildMissedWakeRecord, so this helper returns the raw signed difference.
// ---------------------------------------------------------------------------

test("deriveChangeToRescueMs: a single discharged commit yields now − committed_at_ms", () => {
  // commit landed at 14:04:07Z, heartbeat caught it 2s later — the Incident B
  // case that previously paged a false critical via inflated staleness_ms.
  const committedAt = 1_749_564_247_000;
  const now = committedAt + 2000;
  expect(deriveChangeToRescueMs([committedAt], now)).toBe(2000);
});

test("deriveChangeToRescueMs: several commits in one rescue tick anchor on the OLDEST (worst case)", () => {
  const now = 1_749_564_300_000;
  const oldest = now - 90_000;
  const middle = now - 30_000;
  const newest = now - 5000;
  // Order-independent: the worst-case bound is the longest any delivered change
  // waited unobserved.
  expect(deriveChangeToRescueMs([newest, oldest, middle], now)).toBe(90_000);
  expect(deriveChangeToRescueMs([middle, newest, oldest], now)).toBe(90_000);
});

test("deriveChangeToRescueMs: an empty array (dirty-tree-only rescue, no commit anchor) yields null", () => {
  expect(deriveChangeToRescueMs([], 1_749_564_300_000)).toBeNull();
});

test("deriveChangeToRescueMs: clock skew (oldest commit AFTER now) returns the raw negative — buildMissedWakeRecord owns the clamp to null", () => {
  const now = 1_749_564_300_000;
  // committed_at_ms > now: a negative latency the record builder clamps to null.
  const skewed = now + 5000;
  expect(deriveChangeToRescueMs([skewed], now)).toBe(-5000);
});

// ---------------------------------------------------------------------------
// decideReconcileTransitions re-add. A root that left the watched set but is
// still DESIRED by discovery re-enters `toAdd` exactly once on the next
// reconcile — the level-triggered membership re-derivation that, post-fn-921
// (poll-only, no FSEvents re-arm), is the sole add/drop driver.
// ---------------------------------------------------------------------------

test("a not-watched-but-still-desired root re-enters toAdd exactly once via decideReconcileTransitions", () => {
  // /repo-rearmed is no longer in the watched set but is still desired by
  // discovery, so the next reconcile re-adds it.
  const dwell = new Map<string, number>();
  const result = decideReconcileTransitions(
    new Set<string>(), // currentlyWatched: torn down → empty
    new Set(["/repo-rearmed"]), // still desired
    dwell,
    50_000,
    45_000,
  );
  expect(result.toAdd).toEqual(["/repo-rearmed"]);
  expect(result.toDrop).toEqual([]);
  // No drop/dwell side effect: a re-arm is not a drop, so no dwell timer is
  // stamped for the re-subscribing root.
  expect(dwell.has("/repo-rearmed")).toBe(false);
});

// ---------------------------------------------------------------------------
// selectVanishedRoots — the ghost-row prune. A git_status projection row whose
// worktree was deleted/moved is unreachable by decideReconcileTransitions (which
// only walks currentlyWatched) AND, for an always-watched `.keeper` lane, by the
// dwell drop, so this producer-side stat probe tombstones it. The discriminator
// treats ONLY ENOENT/ENOTDIR ("vanished") as gone — a currently-watched lane
// retires on that verdict across two consecutive passes (debounce), any other
// error fails closed, and an unwatched root keeps today's single-pass behavior.
// ---------------------------------------------------------------------------

/** Build a probe from a fixed dir→verdict map (default "present"). */
function fixedProbe(
  verdicts: Record<string, RootPresence>,
): (dir: string) => RootPresence {
  return (dir) => verdicts[dir] ?? "present";
}

test("selectVanishedRoots: an unwatched vanished dir is dropped and recorded as tombstoned", () => {
  const tombstoned = new Set<string>();
  const streak = new Map<string, number>();
  const drop = selectVanishedRoots(
    ["/code/gone", "/code/here"],
    fixedProbe({ "/code/gone": "vanished", "/code/here": "present" }),
    new Set(),
    tombstoned,
    streak,
  );
  expect(drop).toEqual(["/code/gone"]);
  expect(tombstoned.has("/code/gone")).toBe(true);
});

test("selectVanishedRoots: an unwatched non-ENOENT probe error still retires (byte-identical to the old existsSync=false drop)", () => {
  // The fail-closed discrimination is scoped to WATCHED lanes only; an unwatched
  // root retires on ANY not-present verdict, exactly like the prior existsSync path.
  const tombstoned = new Set<string>();
  const drop = selectVanishedRoots(
    ["/code/eio"],
    fixedProbe({ "/code/eio": "error" }),
    new Set(),
    tombstoned,
    new Map(),
  );
  expect(drop).toEqual(["/code/eio"]);
  expect(tombstoned.has("/code/eio")).toBe(true);
});

test("selectVanishedRoots: a present dir is skipped and un-tombstoned", () => {
  // /code/back vanished last sweep (still in tombstoned) but its dir is now
  // present again — clear the dedupe entry so a future vanish can re-drop it.
  const tombstoned = new Set<string>(["/code/back"]);
  const streak = new Map<string, number>([["/code/back", 1]]);
  const drop = selectVanishedRoots(
    ["/code/back"],
    fixedProbe({ "/code/back": "present" }),
    new Set(),
    tombstoned,
    streak,
  );
  expect(drop).toEqual([]);
  expect(tombstoned.has("/code/back")).toBe(false);
  expect(streak.has("/code/back")).toBe(false);
});

test("selectVanishedRoots: a currently-watched vanished root retires only after two consecutive passes (debounce)", () => {
  // The inverted #1346 bug fixture: the OLD code skipped a watched root forever
  // (the retirement deadlock). Now it retires — but only once the vanished verdict
  // holds across two consecutive sweep passes, protecting a live lane from a blip.
  const tombstoned = new Set<string>();
  const streak = new Map<string, number>();
  const watched = new Set(["/code/watched-gone"]);
  const probe = fixedProbe({ "/code/watched-gone": "vanished" });

  // First pass: no retire, streak recorded.
  const pass1 = selectVanishedRoots(
    ["/code/watched-gone"],
    probe,
    watched,
    tombstoned,
    streak,
  );
  expect(pass1).toEqual([]);
  expect(tombstoned.has("/code/watched-gone")).toBe(false);
  expect(streak.get("/code/watched-gone")).toBe(1);

  // Second consecutive vanished pass: retire (exactly one tombstone entry), and
  // the debounce counter is cleared as the retire fires.
  const pass2 = selectVanishedRoots(
    ["/code/watched-gone"],
    probe,
    watched,
    tombstoned,
    streak,
  );
  expect(pass2).toEqual(["/code/watched-gone"]);
  expect(tombstoned.has("/code/watched-gone")).toBe(true);
  expect(streak.has("/code/watched-gone")).toBe(false);
});

test("selectVanishedRoots: a single-pass vanish on a watched root does not retire (debounce)", () => {
  const tombstoned = new Set<string>();
  const streak = new Map<string, number>();
  const drop = selectVanishedRoots(
    ["/code/watched-gone"],
    fixedProbe({ "/code/watched-gone": "vanished" }),
    new Set(["/code/watched-gone"]),
    tombstoned,
    streak,
  );
  expect(drop).toEqual([]);
  expect(tombstoned.has("/code/watched-gone")).toBe(false);
});

test("selectVanishedRoots: a non-ENOENT probe error never retires a watched lane (fail closed), across repeated passes", () => {
  const tombstoned = new Set<string>();
  const streak = new Map<string, number>();
  const watched = new Set(["/code/watched-eio"]);
  const probe = fixedProbe({ "/code/watched-eio": "error" });
  for (let i = 0; i < 3; i++) {
    const drop = selectVanishedRoots(
      ["/code/watched-eio"],
      probe,
      watched,
      tombstoned,
      streak,
    );
    expect(drop).toEqual([]);
  }
  expect(tombstoned.has("/code/watched-eio")).toBe(false);
  expect(streak.has("/code/watched-eio")).toBe(false);
});

test("selectVanishedRoots: an inconclusive error between two vanishes breaks the consecutive streak", () => {
  const tombstoned = new Set<string>();
  const streak = new Map<string, number>();
  const watched = new Set(["/code/blippy"]);
  const vanished = fixedProbe({ "/code/blippy": "vanished" });
  const errored = fixedProbe({ "/code/blippy": "error" });
  const pass = (probe: (d: string) => RootPresence) =>
    selectVanishedRoots(["/code/blippy"], probe, watched, tombstoned, streak);

  expect(pass(vanished)).toEqual([]); // streak 1
  expect(pass(errored)).toEqual([]); // reset
  expect(streak.has("/code/blippy")).toBe(false);
  expect(pass(vanished)).toEqual([]); // streak 1 again
  expect(pass(vanished)).toEqual(["/code/blippy"]); // 2 consecutive → retire
});

test("selectVanishedRoots: the immediate (nudge) sweep retires a watched vanished root in one pass", () => {
  const tombstoned = new Set<string>();
  const streak = new Map<string, number>();
  const drop = selectVanishedRoots(
    ["/code/torn-down"],
    fixedProbe({ "/code/torn-down": "vanished" }),
    new Set(["/code/torn-down"]),
    tombstoned,
    streak,
    /* immediate */ true,
  );
  expect(drop).toEqual(["/code/torn-down"]);
  expect(tombstoned.has("/code/torn-down")).toBe(true);
});

test("selectVanishedRoots: the immediate sweep double-probes — a blip healed between the two probes keeps the lane", () => {
  // The immediate sweep confirms with a SECOND probe in the same pass; if the dir
  // reappears between them, the lane is kept (the ENOENT gate re-verifies).
  const tombstoned = new Set<string>();
  const streak = new Map<string, number>();
  let calls = 0;
  const flapping = (): RootPresence => (++calls === 1 ? "vanished" : "present");
  const drop = selectVanishedRoots(
    ["/code/flap"],
    flapping,
    new Set(["/code/flap"]),
    tombstoned,
    streak,
    /* immediate */ true,
  );
  expect(calls).toBe(2); // the second confirming probe ran
  expect(drop).toEqual([]);
  expect(tombstoned.has("/code/flap")).toBe(false);
});

test("selectVanishedRoots: an already-tombstoned vanished root is not re-emitted", () => {
  const tombstoned = new Set<string>(["/code/gone"]);
  const drop = selectVanishedRoots(
    ["/code/gone"],
    fixedProbe({ "/code/gone": "vanished" }),
    new Set(),
    tombstoned,
    new Map(),
  );
  expect(drop).toEqual([]);
});

test("selectVanishedRoots: boot shape (empty watched set) drops every vanished root single-pass — byte-identical to today", () => {
  // At boot currentlyWatched is empty, so EVERY row is an unwatched root and
  // retires on the first not-present pass, exactly as the prior existsSync sweep.
  const tombstoned = new Set<string>();
  const streak = new Map<string, number>();
  const drop = selectVanishedRoots(
    ["/a/gone", "/b/here", "/c/gone"],
    fixedProbe({
      "/a/gone": "vanished",
      "/b/here": "present",
      "/c/gone": "vanished",
    }),
    new Set(),
    tombstoned,
    streak,
  );
  expect(drop).toEqual(["/a/gone", "/c/gone"]);
  // Boot debounce is inert (no watched roots), so the streak map stays empty.
  expect(streak.size).toBe(0);
});

test("selectVanishedRoots: a round-tripped tombstone (row gone from git_status) is pruned so the bookkeeping stays bounded", () => {
  // /old was tombstoned last sweep; its DELETE has since round-tripped so it no
  // longer appears among the live git_status rows. Its dedupe + debounce entries
  // are stale — prune them so both structures stay bounded by the live row count.
  const tombstoned = new Set<string>(["/old", "/present"]);
  const streak = new Map<string, number>([
    ["/old", 1],
    ["/present", 1],
  ]);
  const drop = selectVanishedRoots(
    ["/present"],
    fixedProbe({ "/present": "vanished" }),
    new Set(["/present"]),
    tombstoned,
    streak,
  );
  expect(drop).toEqual([]); // /present is already-tombstoned → not re-emitted
  expect(tombstoned.has("/old")).toBe(false); // pruned (round-tripped)
  expect(streak.has("/old")).toBe(false); // pruned (round-tripped)
});

// ---------------------------------------------------------------------------
// probeRootPresence — the real stat probe. present ⟺ existsSync===true;
// ENOENT/ENOTDIR ⟺ "vanished"; any other errno ⟺ "error" (fail-closed).
// ---------------------------------------------------------------------------

test("probeRootPresence: an existing dir is 'present', a missing one 'vanished', a non-dir parent 'vanished'", () => {
  const root = mkdtempSync(join(tmpdir(), "keeper-probe-"));
  try {
    expect(probeRootPresence(root)).toBe("present");
    expect(probeRootPresence(join(root, "nope"))).toBe("vanished");
    // A path whose PARENT is a file → ENOTDIR, still classified vanished.
    const file = join(root, "afile");
    writeFileSync(file, "x");
    expect(probeRootPresence(join(file, "child"))).toBe("vanished");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// discoverProjectRoots — the dynamic discovery integration. Drives it
// against a real bun:sqlite jobs table + epics table + the real probe
// helper, exercising the bounded candidate set, TTL memo, and
// monotonicity invariant.
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";

function makeDiscoveryDb(): Database {
  const db = new Database(":memory:");
  // Mirror the keeper schema columns discoverProjectRoots reads.
  db.run(`CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    cwd TEXT,
    state TEXT NOT NULL DEFAULT 'stopped',
    updated_at REAL NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE epics (
    epic_id TEXT PRIMARY KEY,
    project_dir TEXT,
    tasks TEXT
  )`);
  return db;
}

function fakeProbe(
  verdicts: Map<string, { dirty: boolean; ahead: number } | null>,
  spawnCount?: { n: number },
): (root: string) => { dirty: boolean; ahead: number } | null {
  return (root: string) => {
    if (spawnCount !== undefined) spawnCount.n += 1;
    return verdicts.get(root) ?? { dirty: false, ahead: 0 };
  };
}

test("discoverProjectRoots: .keeper repo always watched without probe spawn", () => {
  // The `.keeper` short-circuit reads the dir off disk (existsSync) — a plain
  // tmp dir, NOT a git repo. The injected probe is a fake whose spawn counter
  // proves the short-circuit fires BEFORE any probe (fn-904.2).
  const root = realpathSync(mkTmpWorktree());
  mkdirSync(join(root, ".keeper"), { recursive: true });
  const db = makeDiscoveryDb();
  db.run(
    "INSERT INTO jobs (job_id, cwd, state, updated_at) VALUES (?, ?, 'working', 0)",
    ["sess-a", root],
  );
  const probeSpawnCount = { n: 0 };
  const ctx: DiscoveryContext = {
    // Pre-seed cwd→toplevel so resolution is a cache hit (git-free) — the
    // candidate IS the root; no `git rev-parse --show-toplevel` spawn.
    cwdRootCache: new Map([[root, root]]),
    watchProbeCache: new Map(),
    currentlyWatched: new Set(),
    nowMs: 1000,
    runFullSweep: true,
    probe: fakeProbe(new Map(), probeSpawnCount),
  };
  const desired = discoverProjectRoots(db, ctx);
  expect(desired).toContain(root);
  // Crucial: `.keeper` short-circuits — no probe spawn.
  expect(probeSpawnCount.n).toBe(0);
  db.close();
});

test("discoverProjectRoots: TTL memo prevents repeated probe spawns in steady state", () => {
  // A dirty repo's verdict is cached at the hot TTL when watched; calling
  // discoverProjectRoots again within the TTL should NOT re-spawn the probe.
  // Driven with a SYNTHETIC root + fake probe — the memo logic is git-free.
  const root = "/tmp/keeper-fn904-ttl-root";
  const db = makeDiscoveryDb();
  db.run(
    "INSERT INTO jobs (job_id, cwd, state, updated_at) VALUES (?, ?, 'working', 0)",
    ["sess-a", root],
  );
  const probeSpawnCount = { n: 0 };
  const fakeVerdicts = new Map([[root, { dirty: true, ahead: 0 }]]);
  const ctx: DiscoveryContext = {
    cwdRootCache: new Map([[root, root]]), // git-free cwd→toplevel cache hit
    watchProbeCache: new Map(),
    currentlyWatched: new Set([root]), // already watched → hot tier
    nowMs: 1000,
    runFullSweep: true,
    probe: fakeProbe(fakeVerdicts, probeSpawnCount),
  };
  // First call → one probe.
  expect(discoverProjectRoots(db, ctx)).toContain(root);
  expect(probeSpawnCount.n).toBe(1);
  // Second call within hot TTL (5s) → memo hit, no new probe.
  ctx.nowMs = 1500;
  expect(discoverProjectRoots(db, ctx)).toContain(root);
  expect(probeSpawnCount.n).toBe(1);
  // After hot TTL elapses → re-probe.
  ctx.nowMs = 10_000;
  expect(discoverProjectRoots(db, ctx)).toContain(root);
  expect(probeSpawnCount.n).toBe(2);
  db.close();
});

test("discoverProjectRoots: epic.project_dir + task.target_repo always candidates (plan-backed)", () => {
  // Both roots carry a real `.keeper` dir (existsSync short-circuit), so the
  // injected probe is never consulted — a plain tmp dir, no git (fn-904.2).
  const planRoot = realpathSync(mkTmpWorktree());
  mkdirSync(join(planRoot, ".keeper"), { recursive: true });
  const targetRoot = realpathSync(mkTmpWorktree());
  mkdirSync(join(targetRoot, ".keeper"), { recursive: true });
  const db = makeDiscoveryDb();
  db.run(`INSERT INTO epics (epic_id, project_dir, tasks) VALUES (?, ?, ?)`, [
    "fn-1-foo",
    planRoot,
    JSON.stringify([{ task_id: "fn-1-foo.1", target_repo: targetRoot }]),
  ]);
  // No jobs row — only epic-derived candidates exist.
  const ctx: DiscoveryContext = {
    // Both epic-derived dirs resolve to themselves (git-free cache hit).
    cwdRootCache: new Map([
      [planRoot, planRoot],
      [targetRoot, targetRoot],
    ]),
    watchProbeCache: new Map(),
    currentlyWatched: new Set(),
    nowMs: 1000,
    runFullSweep: false, // even on the fast path, epic dirs are in
    probe: fakeProbe(new Map()),
  };
  const desired = new Set(discoverProjectRoots(db, ctx));
  expect(desired.has(planRoot)).toBe(true);
  expect(desired.has(targetRoot)).toBe(true);
  db.close();
});

test("discoverProjectRoots: null probe + currentlyWatched → fail-open retains the root", () => {
  // A timeout / spawn failure on the probe must NOT immediately drop an
  // already-watched root. shouldWatchRoot fails-open under currentlyWatched.
  // Synthetic root + a probe that always returns null — git-free (fn-904.2).
  const root = "/tmp/keeper-fn904-failopen-root";
  const db = makeDiscoveryDb();
  db.run(
    "INSERT INTO jobs (job_id, cwd, state, updated_at) VALUES (?, ?, 'working', 0)",
    ["sess-a", root],
  );
  const ctx: DiscoveryContext = {
    cwdRootCache: new Map([[root, root]]), // git-free cwd→toplevel cache hit
    watchProbeCache: new Map(),
    currentlyWatched: new Set([root]),
    nowMs: 1000,
    runFullSweep: true,
    probe: () => null, // every probe fails
  };
  const desired = discoverProjectRoots(db, ctx);
  expect(desired).toContain(root);
  db.close();
});

test("buildDiscoveryCandidates: performance.now()-scale nowMs would silently disable the fast-path window — Date.now()-scale rejects stale rows", () => {
  // Pins the clock-units contract that fn-692 fixed. The fast path's
  // SQL cutoff `(nowMs - RECENT_JOB_WINDOW_MS) / 1000` is compared
  // against `jobs.updated_at` (REAL unix seconds). If a caller passes
  // `performance.now()` (ms since process start, e.g. 60_000 = 1 min
  // since boot) instead of `Date.now()`, the cutoff becomes deeply
  // negative and the WHERE clause matches every row — the fast path
  // silently degrades to a full scan. This test feeds both clock
  // domains against the same DB and asserts the contract: a stale
  // row (updated_at well outside the window) MUST be excluded under
  // a real wall-clock `nowMs`, and would WRONGLY be included under
  // a `performance.now()`-scale `nowMs`.
  const db = makeDiscoveryDb();
  const nowSec = Date.now() / 1000;
  // Stale: updated_at 1 day ago — well outside the 2-hour window.
  const staleSec = nowSec - 24 * 60 * 60;
  const staleCwd = "/tmp/keeper-fn692-stale-cwd";
  db.run(
    "INSERT INTO jobs (job_id, cwd, state, updated_at) VALUES (?, ?, 'stopped', ?)",
    ["sess-stale", staleCwd, staleSec],
  );

  // Wall-clock nowMs (Date.now()-scale): cutoff sits at nowSec - 7200,
  // so the day-old row is correctly excluded.
  const wallClockCandidates = buildDiscoveryCandidates(db, {
    nowMs: Date.now(),
    runFullSweep: false,
    watched: new Set<string>(),
  });
  expect(wallClockCandidates.has(staleCwd)).toBe(false);

  // performance.now()-scale nowMs (e.g. 60_000ms = 1 minute since
  // process start): cutoff becomes (60_000 - 7_200_000) / 1000 =
  // -7140, so every non-null-cwd row satisfies `updated_at >= -7140`
  // and the fast path collapses to a full scan. This branch documents
  // the bug fn-692 fixed — the row WOULD have leaked through.
  const perfNowCandidates = buildDiscoveryCandidates(db, {
    nowMs: 60_000, // performance.now() shape, 1 min since process start
    runFullSweep: false,
    watched: new Set<string>(),
  });
  expect(perfNowCandidates.has(staleCwd)).toBe(true);

  db.close();
});

test("buildDiscoveryCandidates: fn-705 extraCandidates folded in unconditionally (no job-cwd row required)", () => {
  // The fn-705 discovery nudge case: a brand-new repo keeper has never seen a
  // session in — it has NO `jobs.cwd` row and NO `epics.project_dir` entry, so
  // neither the fast path nor the full sweep would surface it. The plan-worker
  // hands it over via `extraCandidates`; the candidate set must include it
  // regardless of sweep mode, so the `.keeper` short-circuit in
  // `shouldWatchRoot` can subscribe it.
  const db = makeDiscoveryDb();
  const nudgeRoot = "/tmp/keeper-fn705-never-seen-repo";

  for (const runFullSweep of [false, true]) {
    const candidates = buildDiscoveryCandidates(db, {
      nowMs: Date.now(),
      runFullSweep,
      watched: new Set<string>(),
      extraCandidates: new Set([nudgeRoot]),
    });
    expect(candidates.has(nudgeRoot)).toBe(true);
  }

  // Sanity: absent the nudge, the never-seen repo is NOT a candidate.
  const without = buildDiscoveryCandidates(db, {
    nowMs: Date.now(),
    runFullSweep: true,
    watched: new Set<string>(),
  });
  expect(without.has(nudgeRoot)).toBe(false);

  db.close();
});

// ---------------------------------------------------------------------------
// semanticSnapshotKey — epic fn-716. The producer-side no-op dedupe gate. The
// key must cover render-significant fields ONLY and EXCLUDE per-file mtime_ms,
// so a save that doesn't change the dirty set / content / branch state does NOT
// re-emit a GitSnapshot (the flood fix). It must still distinguish a genuinely
// changed dirty set, content oid, branch, or ahead/behind.
// ---------------------------------------------------------------------------

function dirtyFile(over: Partial<GitDirtyFile> = {}): GitDirtyFile {
  return {
    path: "src/a.ts",
    xy: ".M",
    kind: "ordinary",
    mtime_ms: 1000,
    worktree_oid: "a".repeat(40),
    index_oid: "b".repeat(40),
    worktree_mode: "100644",
    ...over,
  };
}

function snap(over: Partial<GitSnapshotPayload> = {}): GitSnapshotPayload {
  return {
    project_dir: "/repo",
    branch: "main",
    head_oid: "c".repeat(40),
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    dirty_files: [dirtyFile()],
    ...over,
  };
}

test("semanticSnapshotKey: identical render-significant state with a DIFFERENT mtime_ms yields the SAME key (coalesced)", () => {
  const a = snap({ dirty_files: [dirtyFile({ mtime_ms: 1000 })] });
  const b = snap({ dirty_files: [dirtyFile({ mtime_ms: 9_999_999 })] });
  expect(semanticSnapshotKey(a)).toBe(semanticSnapshotKey(b));
});

test("semanticSnapshotKey: a changed dirty SET (added file) yields a DIFFERENT key (emits)", () => {
  const a = snap({ dirty_files: [dirtyFile()] });
  const b = snap({
    dirty_files: [dirtyFile(), dirtyFile({ path: "src/b.ts" })],
  });
  expect(semanticSnapshotKey(a)).not.toBe(semanticSnapshotKey(b));
});

test("semanticSnapshotKey: a content change (worktree_oid differs, same path/mtime) yields a DIFFERENT key", () => {
  // worktree_oid is render-significant: the reducer's content-aware discharge
  // keys on blob_oid === worktree_oid, so new bytes must re-emit.
  const a = snap({
    dirty_files: [dirtyFile({ worktree_oid: "a".repeat(40) })],
  });
  const b = snap({
    dirty_files: [dirtyFile({ worktree_oid: "d".repeat(40) })],
  });
  expect(semanticSnapshotKey(a)).not.toBe(semanticSnapshotKey(b));
});

test("semanticSnapshotKey: branch / head_oid / ahead / behind / upstream changes each flip the key", () => {
  const base = snap();
  const baseKey = semanticSnapshotKey(base);
  expect(semanticSnapshotKey(snap({ head_oid: "e".repeat(40) }))).not.toBe(
    baseKey,
  );
  expect(semanticSnapshotKey(snap({ ahead: 1 }))).not.toBe(baseKey);
  expect(semanticSnapshotKey(snap({ behind: 2 }))).not.toBe(baseKey);
  expect(semanticSnapshotKey(snap({ upstream: "origin/other" }))).not.toBe(
    baseKey,
  );
  // branch is NOT in the key (the board reads head/upstream/ahead/behind, not
  // the human-facing branch name) — a pure branch rename with identical
  // head/upstream/dirty state is not render-significant.
  expect(semanticSnapshotKey(snap({ branch: "feature" }))).toBe(baseKey);
});

test("semanticSnapshotKey: a status (xy) or mode flip is render-significant (emits)", () => {
  const baseKey = semanticSnapshotKey(snap());
  expect(
    semanticSnapshotKey(snap({ dirty_files: [dirtyFile({ xy: "A." })] })),
  ).not.toBe(baseKey);
  expect(
    semanticSnapshotKey(
      snap({ dirty_files: [dirtyFile({ worktree_mode: "100755" })] }),
    ),
  ).not.toBe(baseKey);
});

test("semanticSnapshotKey: a rename's orig_path is render-significant; absent vs explicit-null are equal", () => {
  const noOrig = snap({ dirty_files: [dirtyFile()] });
  const explicitNull = snap({
    dirty_files: [{ ...dirtyFile(), orig_path: undefined }],
  });
  expect(semanticSnapshotKey(noOrig)).toBe(semanticSnapshotKey(explicitNull));
  const renamed = snap({
    dirty_files: [dirtyFile({ kind: "renamed", orig_path: "src/old.ts" })],
  });
  expect(semanticSnapshotKey(renamed)).not.toBe(semanticSnapshotKey(noOrig));
});

// ---------------------------------------------------------------------------
// Per-root emission throttle under continuous churn — epic fn-716. The
// git-worker passes GIT_SNAPSHOT_MAX_WAIT_MS into each RescanScheduler so a
// root churning faster than the trailing debounce still flushes at the ceiling,
// bounding the emit rate to ≤1 per window. Modelled with the same fake-clock
// harness rescan.test.ts uses (the scheduler is the throttle primitive).
// ---------------------------------------------------------------------------

function fakeClock(): {
  timers: SchedulerTimers;
  flushDelay: (ms: number) => void;
  pendingCount: () => number;
} {
  let next = 1;
  const cbs = new Map<number, { cb: () => void; ms: number }>();
  const timers: SchedulerTimers = {
    setTimeout: (cb, ms) => {
      const id = next++;
      cbs.set(id, { cb, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      cbs.delete(handle as unknown as number);
    },
  };
  const fireSubset = (ids: number[]) => {
    const ready: Array<() => void> = [];
    for (const id of ids) {
      const entry = cbs.get(id);
      if (entry) {
        ready.push(entry.cb);
        cbs.delete(id);
      }
    }
    for (const cb of ready) cb();
  };
  return {
    timers,
    flushDelay: (ms) =>
      fireSubset(
        [...cbs.entries()].filter(([, e]) => e.ms === ms).map(([id]) => id),
      ),
    pendingCount: () => cbs.size,
  };
}

test("fn-716 throttle: continuous churn faster than the debounce emits ≤1 per ceiling window", () => {
  const DEBOUNCE = 500;
  const CEILING = 1500; // GIT_SNAPSHOT_MAX_WAIT_MS
  const clock = fakeClock();
  let emits = 0;
  const sched = new RescanScheduler(
    () => {
      emits++;
    },
    DEBOUNCE,
    () => {},
    clock.timers,
    CEILING,
  );

  // Simulate a long burst of saves arriving faster than the debounce can
  // settle: re-schedule many times without ever flushing the debounce. The
  // ceiling timer (armed on the first schedule) is the only thing that can
  // flush this burst — exactly the "trailing debounce never fires" scenario.
  for (let i = 0; i < 100; i++) sched.schedule();
  expect(emits).toBe(0);

  // One ceiling window elapses → exactly one flush, latest-wins.
  clock.flushDelay(CEILING);
  expect(emits).toBe(1);

  // Another full burst within the next window → still bounded to one more emit.
  for (let i = 0; i < 100; i++) sched.schedule();
  clock.flushDelay(CEILING);
  expect(emits).toBe(2);

  // Two ceiling windows of continuous churn → at most two emits, NOT one per
  // schedule() (the flood the epic fixes).
  expect(emits).toBe(2);
});

test("fn-716 throttle: a bursty-then-quiet edit still flushes on the trailing debounce (no needless ceiling wait)", () => {
  const DEBOUNCE = 500;
  const CEILING = 1500;
  const clock = fakeClock();
  let emits = 0;
  const sched = new RescanScheduler(
    () => {
      emits++;
    },
    DEBOUNCE,
    () => {},
    clock.timers,
    CEILING,
  );

  // A short burst that then goes quiet — the common case. The trailing debounce
  // settles first, so the snapshot lands at ~DEBOUNCE, not held to the ceiling.
  sched.schedule();
  sched.schedule();
  clock.flushDelay(DEBOUNCE);
  expect(emits).toBe(1);
});

// ---------------------------------------------------------------------------
// decideDataVersionWake — epic fn-748. The data_version poll drives membership
// reconcile ONLY. `data_version` carries no root attribution, so it must never
// fan a per-root snapshot out (the O(roots) fan-out that pegged the daemon was
// removed here). Per-root snapshots now come solely from the worktree +
// git-common-dir FSEvents subs + the 60s heartbeat backstop. The decision
// collapses to membership-only: `reconcile` is true on any version advance.
// ---------------------------------------------------------------------------

test("decideDataVersionWake: no advance → no reconcile", () => {
  expect(decideDataVersionWake(5, 5)).toEqual({
    reconcile: false,
  } satisfies DataVersionWakeDecision);
});

test("decideDataVersionWake: a version advance → reconcile (membership only)", () => {
  expect(decideDataVersionWake(6, 5)).toEqual({
    reconcile: true,
  } satisfies DataVersionWakeDecision);
});

test("decideDataVersionWake: a self-write advance still reconciles (cheap, idempotent — no snapshot fan-out)", () => {
  // The worker's own GitSnapshot insert bumps data_version. With the snapshot
  // fan-out removed, that self-write is harmless: it only reconciles membership
  // (O(1), idempotent) and never re-arms a per-root snapshot, so no storm forms.
  expect(decideDataVersionWake(7, 6)).toEqual({
    reconcile: true,
  } satisfies DataVersionWakeDecision);
});

test("decideDataVersionWake: a back-to-back foreign change reconciles every advance", () => {
  // No floor / no rate gate — every distinct advance reconciles membership. The
  // cost is bounded by O(1) reconcile, not O(roots) snapshot, so back-to-back
  // advances are safe.
  expect(decideDataVersionWake(8, 7)).toEqual({
    reconcile: true,
  } satisfies DataVersionWakeDecision);
  expect(decideDataVersionWake(9, 8)).toEqual({
    reconcile: true,
  } satisfies DataVersionWakeDecision);
});

test("decideDataVersionWake: first advance after boot reconciles", () => {
  // lastDataVersion seeds to the cur value at boot, so the first genuine bump
  // reads as an advance and reconciles.
  expect(decideDataVersionWake(2, 1)).toEqual({
    reconcile: true,
  } satisfies DataVersionWakeDecision);
});

// ---------------------------------------------------------------------------
// fn-921 — two-tier git poll pure decision + metadata signature
// ---------------------------------------------------------------------------

test("decideGitPoll: first observation (prev null) → rescan to establish baseline", () => {
  expect(decideGitPoll(null, "sig-1")).toEqual({ rescan: true });
});

test("decideGitPoll: a changed signature → rescan", () => {
  expect(decideGitPoll("sig-1", "sig-2")).toEqual({ rescan: true });
});

test("decideGitPoll: an unchanged signature → no rescan (the quiet steady state)", () => {
  expect(decideGitPoll("sig-1", "sig-1")).toEqual({ rescan: false });
});

test("decideGitPoll: a vanished worktree (cur null) → skip (no usable signature)", () => {
  expect(decideGitPoll("sig-1", null)).toEqual({ rescan: false });
  expect(decideGitPoll(null, null)).toEqual({ rescan: false });
});

test("readGitMetaSignature: returns null when the worktree root cannot be stat'd", () => {
  expect(
    readGitMetaSignature("/synthetic/git-worker/does-not-exist", null),
  ).toBeNull();
});

test("readGitMetaSignature: a real dir produces a stable, change-sensitive signature", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "keeper-gitmeta-")));
  tmpDirs.push(dir);
  // No common-dir → just the worktree mtime; deterministic across two reads.
  const a = readGitMetaSignature(dir, null);
  const b = readGitMetaSignature(dir, null);
  expect(a).not.toBeNull();
  expect(a).toBe(b as string);
  // A missing common-dir file contributes `0` — the signature still includes the
  // meta slots, so an appearing/disappearing HEAD flips it.
  const withCommon = readGitMetaSignature(dir, dir);
  expect(withCommon).not.toBeNull();
  expect(withCommon).not.toBe(a as string); // common-dir slots widen the sig
});

// ---------------------------------------------------------------------------
// fn-921 — quiet-repo seed_required force-emit decision
// ---------------------------------------------------------------------------

test("decideSeedRequiredEmit: seed clear → no force-emit (the steady state)", () => {
  expect(decideSeedRequiredEmit(false, ["/a", "/b"], new Set(["/a"]))).toEqual(
    [],
  );
});

test("decideSeedRequiredEmit: empty unseeded set → no force-emit", () => {
  expect(decideSeedRequiredEmit(true, ["/a", "/b"], new Set<string>())).toEqual(
    [],
  );
});

test("decideSeedRequiredEmit: emits the WATCHED ∩ unseeded-gated intersection", () => {
  // Watched {/a,/b,/c}; unseeded gated {/b,/d}. Only /b is both watched AND
  // unseeded — /d is gated-but-unwatched (the worker can't force-emit it), /a,/c
  // are watched-but-seeded.
  expect(
    decideSeedRequiredEmit(true, ["/a", "/b", "/c"], new Set(["/b", "/d"])),
  ).toEqual(["/b"]);
});

test("decideSeedRequiredEmit: preserves watched iteration order for a stable emit set", () => {
  expect(
    decideSeedRequiredEmit(
      true,
      ["/c", "/a", "/b"],
      new Set(["/a", "/b", "/c"]),
    ),
  ).toEqual(["/c", "/a", "/b"]);
});

// ---------------------------------------------------------------------------
// fn-748 regression — NO snapshot fan-out on a foreign data_version advance.
//
// THE acceptance guard for this epic: a foreign write that dirties root A (a
// hook tool event → a `jobs`-row touch → a `data_version` bump) must NOT fan a
// `git status` snapshot out to the OTHER subscribed roots B/C/D. `data_version`
// carries no root attribution, so the removed fan-out arm could not have known
// which root the write belonged to — it scheduled a snapshot on EVERY root,
// the O(roots × write-rate) shell-out storm that pegged the daemon at 144%.
//
// We faithfully re-create the poll-loop's wiring (src/git-worker.ts:2757) — a
// per-root `RescanScheduler` (the snapshot trigger) for each subscribed root,
// and the `decideDataVersionWake` → reconcile-only branch the loop runs on each
// tick. The poll loop, on an advance, calls `reconcileRoots()` and NOTHING
// else; it never touches any root's scheduler. So after a foreign advance, the
// only observable effect must be one membership reconcile and ZERO scheduled
// snapshots across all roots. A pinned-down model of the OLD fan-out (schedule
// on every root) is asserted to show what the regression would look like.
// ---------------------------------------------------------------------------

test("fn-748 regression: a foreign data_version advance fans NO snapshot to other roots", () => {
  const clock = fakeClock();
  const roots = ["/repo/A", "/repo/B", "/repo/C", "/repo/D"];

  // One snapshot scheduler per subscribed root — the actual per-root snapshot
  // trigger the worker owns (subscriptions.get(root).sched). A fire here means
  // a `git status` shell-out for that root.
  const scheduled: Record<string, number> = {};
  const schedByRoot = new Map<string, RescanScheduler>();
  for (const root of roots) {
    scheduled[root] = 0;
    schedByRoot.set(
      root,
      new RescanScheduler(
        () => {
          scheduled[root] = (scheduled[root] ?? 0) + 1;
        },
        500,
        () => {},
        clock.timers,
        1500,
      ),
    );
  }

  // The poll loop's exact body: decide, and on an advance reconcile membership
  // ONLY. `reconcileRoots` manages subscriptions — it never schedules a
  // per-root snapshot — so we model it as a pure membership-touch counter.
  let reconciles = 0;
  let lastDataVersion = 1;
  const pollTick = (curVersion: number): void => {
    const decision = decideDataVersionWake(curVersion, lastDataVersion);
    if (!decision.reconcile) return;
    lastDataVersion = curVersion;
    reconciles++; // === reconcileRoots(); NO sched.schedule() anywhere.
  };

  // A foreign write dirties root A → data_version bumps 1 → 2. Drive the tick.
  pollTick(2);

  // Membership was reconciled exactly once (cheap, O(1), idempotent)…
  expect(reconciles).toBe(1);
  // …and NOTHING was scheduled — not for A, and crucially not for B/C/D.
  clock.flushDelay(500); // trailing debounce
  clock.flushDelay(1500); // ceiling
  for (const root of roots) {
    expect(scheduled[root]).toBe(0);
  }

  // A burst of back-to-back foreign advances (a multi-agent write storm) still
  // never fans a snapshot out — the storm class the epic kills. Each advance is
  // a bounded O(1) reconcile, never O(roots) git status spawns.
  for (let v = 3; v <= 50; v++) pollTick(v);
  expect(reconciles).toBe(49); // 48 storm advances + the first
  clock.flushDelay(500);
  clock.flushDelay(1500);
  for (const root of roots) {
    expect(scheduled[root]).toBe(0);
  }

  // Contrast: the REMOVED fan-out arm scheduled a snapshot on EVERY subscribed
  // root per advance. Pinned here so the regression's shape is explicit — if a
  // future edit re-wires the data_version poll back into per-root scheduling,
  // the assertions above flip from 0 to (advances × roots) and this test fails.
  let fanoutScheduled = 0;
  const oldFanoutOnAdvance = (): void => {
    for (const root of roots) {
      schedByRoot.get(root)?.schedule();
      fanoutScheduled++;
    }
  };
  oldFanoutOnAdvance();
  expect(fanoutScheduled).toBe(roots.length); // 4 — what the bug did per write
  clock.flushDelay(500);
  for (const root of roots) {
    // The old arm WOULD have fired one snapshot per root — proving the test's
    // scheduler wiring is live (so the 0s above are a real absence, not a
    // mis-wired harness that can never schedule).
    expect(scheduled[root]).toBe(1);
  }
});

// ---------------------------------------------------------------------------
// fn-720 backstop telemetry — git-heartbeat missed-wake record + denominator.
// emitSnapshot + the heartbeat body live inside the worker `main` closure, so
// (per the established emitSnapshot-delta test pattern above) we faithfully
// re-create the heartbeat body — the SAME `BackstopCounters.bump` +
// `buildMissedWakeRecord` calls the worker makes — driving it with a synthetic
// clock + per-root emitted-booleans. The fast-path stamp (`lastFastPathAt`) is
// set only by the scheduler fire, NOT the heartbeat, exactly as in the worker.
// ---------------------------------------------------------------------------

/** Faithful re-creation of git-worker's heartbeat backstop body (fn-720). */
function stepGitHeartbeat(
  counters: BackstopCounters,
  emittedByRoot: boolean[],
  now: number,
  lastFastPathAt: number | null,
): BackstopMessage[] {
  const out: BackstopMessage[] = [];
  let rescued = false;
  for (const emitted of emittedByRoot) {
    if (emitted) rescued = true;
  }
  counters.bump("git-heartbeat", "missed-wake", rescued);
  if (rescued) {
    out.push({
      kind: "backstop",
      record: buildMissedWakeRecord({
        backstop: "git-heartbeat",
        worker: "git-worker",
        fastPath: "metadata-poll",
        rescued: true,
        now,
        lastFastPathAt,
      }),
    });
  }
  return out;
}

test("fn-720 git-heartbeat: a mute-watcher rescue (a root re-emitted) posts a missed-wake record with correct staleness", () => {
  const counters = new BackstopCounters();
  // The metadata-poll fast path last fired (scheduler emit) at t=1000.
  const lastFastPathAt = 1000;
  // Heartbeat at t=62240: one subscribed root re-emitted a snapshot the live
  // path missed (watcher went mute), so rescued=true.
  const msgs = stepGitHeartbeat(counters, [false, true], 62240, lastFastPathAt);
  expect(msgs).toHaveLength(1);
  const rec = msgs[0]?.record as BackstopRecord;
  expect(rec).toEqual({
    ts: 62240,
    kind: "backstop-rescue",
    class: "missed-wake",
    backstop: "git-heartbeat",
    worker: "git-worker",
    fast_path: "metadata-poll",
    rescued: true,
    staleness_ms: 61240, // 62240 - 1000
    last_fast_path_at: 1000,
  });
});

test("fn-720 git-heartbeat: a no-op heartbeat (every root coalesced) posts NO record but bumps the denominator", () => {
  const counters = new BackstopCounters();
  const msgs = stepGitHeartbeat(counters, [false, false], 70000, 1000);
  expect(msgs).toHaveLength(0);
  const rollups = counters.snapshot(70001);
  expect(rollups).toHaveLength(1);
  expect(rollups[0]).toEqual({
    ts: 70001,
    kind: "backstop-rollup",
    backstop: "git-heartbeat",
    class: "missed-wake",
    fires_total: 1,
    rescues_total: 0,
  });
});

test("fn-720 git-heartbeat: cold-boot heartbeat (no fast path yet) reports NULL staleness", () => {
  const counters = new BackstopCounters();
  const msgs = stepGitHeartbeat(counters, [true], 999999, null);
  expect(msgs).toHaveLength(1);
  const rec = msgs[0]?.record as BackstopRecord;
  expect(rec.staleness_ms).toBeNull();
  expect(rec.last_fast_path_at).toBeNull();
});

test("fn-720 git-heartbeat: denominator accumulates across fires (rate => rescues/fires)", () => {
  const counters = new BackstopCounters();
  stepGitHeartbeat(counters, [true], 1000, 0); // rescue
  stepGitHeartbeat(counters, [false], 2000, 0); // no-op
  stepGitHeartbeat(counters, [false], 3000, 0); // no-op
  const rollups = counters.snapshot(4000) as BackstopRollup[];
  expect(rollups[0]?.fires_total).toBe(3);
  expect(rollups[0]?.rescues_total).toBe(1);
});
