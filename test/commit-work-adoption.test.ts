import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommitWorkDeps,
  runForTest as runCommitWorkForTest,
} from "../cli/commit-work";
import type { GitRunner } from "../src/commit-work/git-exec";
import {
  IdentityConflictError,
  InvalidIdentityError,
  resolveInvocationIdentity,
} from "../src/commit-work/identity";
import {
  commitFrozenPrivateIndex,
  createFrozenPrivateIndex,
  MAX_COMMIT_MESSAGE_BYTES,
  type PrivateIndexError,
} from "../src/commit-work/private-index";
import {
  discoverCommitWorkSurface,
  readOwnershipClaims,
} from "../src/commit-work/surface";
import {
  COMMIT_WORK_TELEMETRY_DATA_LIMIT,
  emitCommitWorkOutcome,
} from "../src/commit-work/telemetry";
import { openDb } from "../src/db";
import { parseEventLogLine, serializeEventLogRecord } from "../src/dead-letter";
import { freshDbFile } from "./helpers/template-db";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PARENT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FOREIGN = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COMMIT = "cccccccccccccccccccccccccccccccccccccccc";
const TREE = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const MUTATED_TREE = "ffffffffffffffffffffffffffffffffffffffff";

function runForTest(argv: string[], deps: CommitWorkDeps = {}) {
  return runCommitWorkForTest(argv, {
    validateIdentity: () => true,
    validateTaskBinding: () => true,
    ...deps,
  });
}

function statusRecord(path = "a.txt"): string {
  return `? ${path}\0`;
}

function surfaceGit(path = "a.txt"): GitRunner {
  return async (args) => {
    if (args[0] === "status") {
      return { code: 0, stdout: statusRecord(path), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
}

describe("commit-work invocation identity", () => {
  test("normalizes one valid UUID to lowercase", () => {
    const resolved = resolveInvocationIdentity(
      "11111111-1111-4111-8111-AAAAAAAAAAAA",
      { KEEPER_JOB_ID: "11111111-1111-4111-8111-aaaaaaaaaaaa" },
    );
    expect(resolved.value).toBe("11111111-1111-4111-8111-aaaaaaaaaaaa");
  });

  test("invalid and conflicting carriers are distinct refusals", () => {
    expect(() => resolveInvocationIdentity("not-a-uuid", {})).toThrow(
      InvalidIdentityError,
    );
    expect(() =>
      resolveInvocationIdentity(ID, { KEEPER_JOB_ID: OTHER }),
    ).toThrow(IdentityConflictError);
  });

  test("invalid identity refuses before any discovery probe", async () => {
    let gitCalls = 0;
    const output = await runForTest(["message", "--session-id", "bad"], {
      gitRunner: async () => {
        gitCalls += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(output.code).toBe(1);
    expect(JSON.parse(output.stdout).outcome).toBe("invalid_identity");
    expect(gitCalls).toBe(0);
  });
});

describe("commit-work foreign claim adoption", () => {
  test("only positively terminal foreign claims are adoptable", async () => {
    for (const liveness of ["live", "unknown"] as const) {
      const surface = await discoverCommitWorkSurface({
        worktree: "/repo",
        identity: ID,
        adoptedPaths: ["a.txt"],
        git: surfaceGit(),
        deps: {
          readClaims: () => [{ path: "a.txt", sessionId: OTHER, liveness }],
        },
      });
      expect(surface.adopted).toEqual([]);
      expect(surface.rejections[0]?.code).toBe("ownership_conflict");
    }

    const terminal = await discoverCommitWorkSurface({
      worktree: "/repo",
      identity: ID,
      adoptedPaths: ["a.txt"],
      git: surfaceGit(),
      deps: {
        readClaims: () => [
          {
            path: "a.txt",
            sessionId: OTHER,
            liveness: "terminal",
            state: "ended",
            source: "direct",
            orderedTerminalProof: true,
          },
        ],
      },
    });
    expect(terminal.adopted).toEqual(["a.txt"]);
  });

  test("terminal adoption uses per-session cursor-fresh evidence", async () => {
    const cases: Array<{
      name: string;
      laterDbSession?: string;
      laterDbHook?: string;
      receiptSession?: string;
      cursor: "head" | "mutation";
      expected: "terminal" | "unknown";
      rejection?: "receipts_pending";
    }> = [
      {
        name: "later unrelated event and another session receipt",
        laterDbSession: "unrelated",
        receiptSession: "receipt-other",
        cursor: "head",
        expected: "terminal",
      },
      {
        name: "own pending receipt",
        receiptSession: OTHER,
        cursor: "head",
        expected: "unknown",
        rejection: "receipts_pending",
      },
      {
        name: "cursor behind terminal event",
        cursor: "mutation",
        expected: "unknown",
      },
      {
        name: "same-session lifecycle after terminal",
        laterDbSession: OTHER,
        laterDbHook: "UserPromptSubmit",
        cursor: "head",
        expected: "unknown",
      },
    ];

    for (const entry of cases) {
      const dir = mkdtempSync(join(tmpdir(), "keeper-adoption-terminal-"));
      const dbPath = join(dir, "keeper.db");
      const eventsLogDir = join(dir, "events-log");
      const deadLetterDir = join(dir, "dead-letters");
      const birthDir = join(dir, "births");
      mkdirSync(eventsLogDir);
      mkdirSync(deadLetterDir);
      mkdirSync(join(birthDir, "new"), { recursive: true });
      freshDbFile(dbPath).db.close();
      try {
        const { db } = openDb(dbPath, { migrate: false });
        db.run(
          "INSERT INTO jobs (job_id, created_at, state, updated_at) VALUES (?, 1, 'ended', 1)",
          [OTHER],
        );
        const mutation = db.run(
          `INSERT INTO events
             (ts, session_id, hook_event, event_type, tool_name, cwd, data,
              mutation_path)
           VALUES (1, ?, 'PostToolUse', 'post_tool_use', 'Write', '/repo', '{}', '/repo/a.txt')`,
          [OTHER],
        );
        const terminal = db.run(
          `INSERT INTO events
             (ts, session_id, hook_event, event_type, cwd, data)
           VALUES (2, ?, 'SessionEnd', 'session_end', '/repo', '{}')`,
          [OTHER],
        );
        db.run("UPDATE jobs SET last_event_id = ? WHERE job_id = ?", [
          terminal.lastInsertRowid,
          OTHER,
        ]);
        if (entry.laterDbSession !== undefined) {
          db.run(
            `INSERT INTO events
               (ts, session_id, hook_event, event_type, cwd, data)
             VALUES (3, ?, ?, 'user_prompt_submit', '/repo', '{}')`,
            [entry.laterDbSession, entry.laterDbHook ?? "UserPromptSubmit"],
          );
        }
        const head = (
          db.query("SELECT MAX(id) AS max_id FROM events").get() as {
            max_id: number;
          }
        ).max_id;
        db.run(
          `INSERT INTO file_attributions
             (project_dir, session_id, file_path, last_mutation_at, op, source,
              last_event_id, updated_at)
           VALUES ('/repo', ?, 'a.txt', 1, 'Write', 'tool', ?, 1)`,
          [OTHER, mutation.lastInsertRowid],
        );
        db.run(
          "INSERT INTO git_status (project_dir, updated_at, attribution_event_id) VALUES ('/repo', 1, ?)",
          [head],
        );
        db.run("UPDATE reducer_state SET last_event_id = ? WHERE id = 1", [
          entry.cursor === "mutation" ? mutation.lastInsertRowid : head,
        ]);
        db.close();

        if (entry.receiptSession !== undefined) {
          writeFileSync(
            join(eventsLogDir, "pending.ndjson"),
            serializeEventLogRecord({
              bindings: {
                session_id: entry.receiptSession,
                hook_event: "PostToolUse",
                tool_name: "Write",
                mutation_path: "/other/resumed.ts",
              },
            }),
          );
        }

        const claims = readOwnershipClaims("/repo", dbPath, {
          eventsLogDir,
          deadLetterDir,
          birthDir,
        });
        expect(claims).not.toBeNull();
        const target = claims?.find((claim) => claim.sessionId === OTHER);
        expect(target).toMatchObject({
          path: "a.txt",
          liveness: entry.expected,
        });

        const surface = await discoverCommitWorkSurface({
          worktree: "/repo",
          identity: ID,
          adoptedPaths: ["a.txt"],
          git: surfaceGit(),
          deps: { readClaims: () => claims },
        });
        if (entry.expected === "terminal") {
          expect(surface.adopted).toEqual(["a.txt"]);
          expect(surface.rejections).toEqual([]);
        } else {
          expect(surface.adopted).toEqual([]);
          expect(surface.rejections[0]?.code).toBe(
            entry.rejection ?? "ownership_conflict",
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("adoption reports outside, excluded, ignored, and clean paths separately", async () => {
    const git: GitRunner = async (args) => {
      if (args[0] === "status") {
        return { code: 0, stdout: statusRecord(".keeper/x"), stderr: "" };
      }
      if (args[0] === "check-ignore") {
        return { code: 0, stdout: "ignored\0", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    const surface = await discoverCommitWorkSurface({
      worktree: "/repo",
      identity: ID,
      adoptedPaths: ["../outside", ".keeper/x", "ignored", "clean"],
      git,
      deps: { readClaims: () => [] },
    });
    expect(surface.rejections.map((entry) => entry.code)).toEqual([
      "outside_worktree",
      "excluded",
      "ignored",
      "clean",
    ]);
  });

  test("explicit adoption supersedes the caller's stale automatic identity", async () => {
    const surface = await discoverCommitWorkSurface({
      worktree: "/repo",
      identity: ID,
      adoptedPaths: ["a.txt"],
      git: surfaceGit(),
      deps: {
        readClaims: () => [
          {
            path: "a.txt",
            sessionId: ID,
            liveness: "live",
            source: "tool",
            oid: "deadbeef",
            mode: "100644",
          },
        ],
      },
    });
    expect(surface.adopted).toEqual(["a.txt"]);
    expect(surface.automatic).toEqual([]);
    expect(surface.rejections).toEqual([]);
  });

  test("unavailable overlap evidence blocks adoption unless direct evidence is complete", async () => {
    const unavailable = await discoverCommitWorkSurface({
      worktree: "/repo",
      identity: ID,
      adoptedPaths: ["a.txt"],
      git: surfaceGit(),
      deps: { readClaims: () => null },
    });
    expect(unavailable.adopted).toEqual([]);
    expect(unavailable.rejections).toEqual([
      { input: "a.txt", path: "a.txt", code: "ownership_unavailable" },
    ]);

    const directComplete = await discoverCommitWorkSurface({
      worktree: "/repo",
      identity: ID,
      adoptedPaths: ["a.txt"],
      git: surfaceGit(),
      directEvidence: { complete: true, claims: [] },
      deps: { readClaims: () => null },
    });
    expect(directComplete.adopted).toEqual(["a.txt"]);
    expect(directComplete.rejections).toEqual([]);
  });

  test("Bash and inferred observations require explicit adoption", async () => {
    for (const source of ["bash", "inferred"] as const) {
      const preview = await discoverCommitWorkSurface({
        worktree: "/repo",
        identity: ID,
        adoptedPaths: [],
        git: surfaceGit(),
        deps: {
          readClaims: () => [
            { path: "a.txt", sessionId: ID, liveness: "live", source },
          ],
        },
      });
      expect(preview.automatic).toEqual([]);
      expect(preview.summary.adoptable_unattributed.total).toBe(1);
      expect(preview.summary.observed_adoptable).toEqual({
        total: 1,
        sample: ["a.txt"],
      });

      const adopted = await discoverCommitWorkSurface({
        worktree: "/repo",
        identity: ID,
        adoptedPaths: ["a.txt"],
        git: surfaceGit(),
        deps: {
          readClaims: () => [
            { path: "a.txt", sessionId: OTHER, liveness: "live", source },
          ],
        },
      });
      expect(adopted.adopted).toEqual(["a.txt"]);
    }
  });

  test("newer direct identity evidence replaces null and stale durable duplicates", async () => {
    for (const [durableOid, durableLiveness] of [
      [null, "live"],
      ["stale-oid", "unknown"],
    ] as const) {
      const surface = await discoverCommitWorkSurface({
        worktree: "/repo",
        identity: ID,
        adoptedPaths: [],
        git: surfaceGit(),
        directEvidence: {
          claims: [
            {
              path: "a.txt",
              sessionId: ID,
              liveness: "live",
              oid: "exact-oid",
              mode: "100755",
              source: "direct",
            },
          ],
          complete: true,
        },
        deps: {
          readClaims: () => [
            {
              path: "a.txt",
              sessionId: ID,
              liveness: durableLiveness,
              oid: durableOid,
              mode: durableOid === null ? null : "100644",
              source: "durable",
            },
          ],
        },
      });
      expect(surface.claimsByPath.get("a.txt")).toEqual([
        expect.objectContaining({ oid: "exact-oid", mode: "100755" }),
      ]);
    }
  });

  test("stopped/missing jobs and classifier failures remain unknown", async () => {
    const claims = [
      { path: "a.txt", sessionId: OTHER, liveness: "terminal" as const },
    ];
    for (const classifyClaim of [
      () => "unknown" as const,
      () => {
        throw new Error("classifier unavailable");
      },
    ]) {
      const surface = await discoverCommitWorkSurface({
        worktree: "/repo",
        identity: ID,
        adoptedPaths: ["a.txt"],
        git: surfaceGit(),
        deps: { readClaims: () => claims, classifyClaim },
      });
      expect(surface.rejections[0]?.code).toBe("ownership_conflict");
    }

    for (const state of ["stopped", null] as const) {
      const surface = await discoverCommitWorkSurface({
        worktree: "/repo",
        identity: ID,
        adoptedPaths: ["a.txt"],
        git: surfaceGit(),
        deps: {
          readClaims: () => [
            {
              path: "a.txt",
              sessionId: OTHER,
              liveness: "terminal",
              state,
            },
          ],
        },
      });
      expect(surface.rejections[0]?.code).toBe("ownership_conflict");
    }
  });
});

interface RefFixtureOptions {
  beforeCommit?: string;
  parents?: string[];
  tree?: string;
  casFails?: boolean;
  casCode?: number;
  casSignal?: NodeJS.Signals;
  unborn?: boolean;
  commitFails?: boolean;
  signingConfigRace?: boolean;
  onHook?: (name: string) => void;
}

const BASE_TREE = "1111111111111111111111111111111111111111";
const BLOB = "1234567890123456789012345678901234567890";

function refFixture(options: RefFixtureOptions = {}) {
  let branchReads = 0;
  let branchTip: string | null = options.unborn ? null : PARENT;
  let privateUpdated = false;
  let hookRan = false;
  let removeCount = 0;
  let configFingerprint = "before";
  const calls: Array<{
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
  }> = [];
  const parents = options.parents ?? (options.unborn ? [] : [PARENT]);
  const objectTree = options.tree ?? TREE;
  const run: GitRunner = async (args, opts = {}) => {
    const stdin = opts.stdin ? new TextDecoder().decode(opts.stdin) : undefined;
    calls.push({ args: [...args], cwd: opts.cwd, env: opts.env, stdin });
    if (args[0] === "symbolic-ref") {
      return { code: 0, stdout: "refs/heads/main\n", stderr: "" };
    }
    if (
      args[0] === "rev-parse" &&
      args[1] === "--verify" &&
      args[2] === "refs/heads/main^{commit}"
    ) {
      branchReads += 1;
      if (branchTip === null) {
        return { code: 128, stdout: "", stderr: "unborn branch" };
      }
      const oid =
        branchReads === 2 && options.beforeCommit
          ? options.beforeCommit
          : branchTip;
      return { code: 0, stdout: `${oid}\n`, stderr: "" };
    }
    if (args[0] === "show-ref" && args.includes("refs/heads/main")) {
      return {
        code: branchTip === null ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    }
    if (
      args[0] === "rev-parse" &&
      args.includes("--path-format=absolute") &&
      args.includes("--git-common-dir")
    ) {
      return { code: 0, stdout: "/repo/.git\n", stderr: "" };
    }
    if (args[0] === "read-tree") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "config" && args.includes("core.filemode")) {
      return { code: 0, stdout: "true\n", stderr: "" };
    }
    if (args[0] === "config" && args.includes("--list")) {
      return { code: 0, stdout: configFingerprint, stderr: "" };
    }
    if (args[0] === "config" && args.includes("commit.gpgSign")) {
      if (options.signingConfigRace) configFingerprint = "after";
      return { code: 0, stdout: "false\n", stderr: "" };
    }
    if (args[0] === "ls-tree") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "hash-object") {
      return { code: 0, stdout: `${BLOB}\n`, stderr: "" };
    }
    if (args[0] === "update-index") {
      if (opts.env?.GIT_INDEX_FILE) privateUpdated = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "write-tree") {
      return {
        code: 0,
        stdout: `${hookRan && options.tree ? options.tree : privateUpdated ? TREE : BASE_TREE}\n`,
        stderr: "",
      };
    }
    if (
      args[0] === "diff" &&
      args.includes("--cached") &&
      opts.env?.GIT_INDEX_FILE
    ) {
      return { code: 0, stdout: "a.txt\0", stderr: "" };
    }
    if (args[0] === "interpret-trailers") {
      const trailers = args
        .flatMap((arg, index) => (arg === "--trailer" ? [args[index + 1]] : []))
        .filter((value): value is string => value !== undefined);
      const input = stdin?.trimEnd() ?? "";
      const separator =
        /\n\n[A-Za-z0-9-]+:[^\n]*(?:\n[A-Za-z0-9-]+:[^\n]*)*$/.test(input)
          ? "\n"
          : "\n\n";
      return {
        code: 0,
        stdout: `${input}${separator}${trailers.join("\n")}\n`,
        stderr: "",
      };
    }
    if (args[0] === "hook" && args[1] === "run") {
      hookRan = true;
      options.onHook?.(args[3] ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "commit-tree") {
      return {
        code: options.commitFails ? 1 : 0,
        stdout: options.commitFails ? "" : `${COMMIT}\n`,
        stderr: options.commitFails ? "commit-tree refused" : "",
      };
    }
    if (
      args[0] === "rev-parse" &&
      args[1] === "--verify" &&
      args[2] === "HEAD^{commit}"
    ) {
      return { code: 0, stdout: `${COMMIT}\n`, stderr: "" };
    }
    if (args[0] === "cat-file" && args[1] === "commit") {
      return {
        code: 0,
        stdout: `tree ${objectTree}\n${parents.map((parent) => `parent ${parent}\n`).join("")}author Test <t@example.com> 1 +0000\ncommitter Test <t@example.com> 1 +0000\n\nmessage\n`,
        stderr: "",
      };
    }
    if (args[0] === "update-ref") {
      const code = options.casCode ?? (options.casFails ? 1 : 0);
      if (code === 0) branchTip = COMMIT;
      return {
        code,
        stdout: "",
        stderr: code === 0 ? "" : "compare-and-swap failed",
        signal: options.casSignal ?? null,
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const fs = {
    makeTempDir: () => "/tmp/keeper-private-audit",
    removeTempDir: () => {
      removeCount += 1;
    },
    commitMarker: () => "audit-marker",
    inspectPath: () => ({ kind: "file" as const, executable: false }),
    fingerprintIndex: () => "stable-private-index",
    targetIndexPath: () => "/repo/.git/index",
  };
  return {
    run,
    calls,
    fs,
    removed: () => removeCount,
  };
}

async function frozenFixture(fixture: ReturnType<typeof refFixture>) {
  return createFrozenPrivateIndex("/repo", ["a.txt"], fixture.run, fixture.fs);
}

async function capturePrivateError(
  fixture: ReturnType<typeof refFixture>,
): Promise<PrivateIndexError> {
  const frozen = await frozenFixture(fixture);
  try {
    await commitFrozenPrivateIndex(
      frozen,
      "message",
      "/repo",
      fixture.run,
      fixture.fs,
    );
  } catch (error) {
    return error as PrivateIndexError;
  }
  throw new Error("expected private-index failure");
}

function pipelineRun(fixture: ReturnType<typeof refFixture>): GitRunner {
  return async (args, options) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: "/repo\n", stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--path-format=absolute") {
      return { code: 0, stdout: "/repo/.git\n", stderr: "" };
    }
    if (args[0] === "status") {
      return { code: 0, stdout: statusRecord(), stderr: "" };
    }
    if (
      args[0] === "diff" &&
      args.includes("--cached") &&
      args.includes("--name-only")
    ) {
      return {
        code: 0,
        stdout: options?.env?.GIT_INDEX_FILE ? "a.txt\0" : "",
        stderr: "",
      };
    }
    if (args[0] === "diff" && args.includes("--diff-filter=U")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return fixture.run(args, options);
  };
}

describe("commit-work atomic plumbing publication", () => {
  test("ref advance before commit-tree refuses without publishing", async () => {
    const fixture = refFixture({ beforeCommit: FOREIGN });
    const error = await capturePrivateError(fixture);
    expect(error).toMatchObject({ code: "ref_conflict", committed: false });
    expect(fixture.calls.some((call) => call.args[0] === "commit-tree")).toBe(
      false,
    );
    expect(fixture.calls.some((call) => call.args[0] === "update-ref")).toBe(
      false,
    );
  });

  test("an unborn branch publishes one parentless create-only CAS", async () => {
    const fixture = refFixture({ unborn: true });
    const frozen = await frozenFixture(fixture);
    const committed = await commitFrozenPrivateIndex(
      frozen,
      "initial",
      "/repo",
      fixture.run,
      fixture.fs,
    );
    expect(committed.sha).toBe(COMMIT);
    const commitTree = fixture.calls.find(
      (call) => call.args[0] === "commit-tree",
    );
    expect(commitTree?.args).not.toContain("-p");
    const publish = fixture.calls.find((call) => call.args[0] === "update-ref");
    expect(publish?.args.at(-1)).toBe("0".repeat(40));
  });

  test("commit-tree uses the captured tree and parent and publishes one exact CAS", async () => {
    const fixture = refFixture();
    const frozen = await frozenFixture(fixture);
    await expect(
      commitFrozenPrivateIndex(
        frozen,
        "message",
        "/repo",
        fixture.run,
        fixture.fs,
      ),
    ).resolves.toEqual({ sha: COMMIT, tree: TREE });

    const commitTree = fixture.calls.find(
      (call) => call.args[0] === "commit-tree",
    );
    expect(commitTree).toMatchObject({ cwd: "/repo" });
    expect(commitTree?.args.slice(0, 5)).toEqual([
      "commit-tree",
      TREE,
      "-p",
      PARENT,
      "-F",
    ]);
    expect(
      fixture.calls.filter((call) => call.args[0] === "update-ref"),
    ).toEqual([
      expect.objectContaining({
        args: [
          "update-ref",
          "-m",
          "keeper commit-work: publish isolated commit",
          "refs/heads/main",
          COMMIT,
          PARENT,
        ],
      }),
    ]);
    expect(
      fixture.calls.some((call) =>
        ["fsck", "log", "worktree"].includes(call.args[0] ?? ""),
      ),
    ).toBe(false);
  });

  test("revalidates ownership after final index checks and before CAS", async () => {
    const fixture = refFixture();
    const originalFingerprint = fixture.fs.fingerprintIndex;
    let fingerprintReads = 0;
    fixture.fs.fingerprintIndex = () => {
      fingerprintReads += 1;
      return originalFingerprint();
    };
    const validationBoundaries: number[] = [];
    let updateRefCalled = false;
    const run: GitRunner = async (args, options) => {
      if (args[0] === "update-ref") updateRefCalled = true;
      return fixture.run(args, options);
    };
    const frozen = await createFrozenPrivateIndex(
      "/repo",
      ["a.txt"],
      run,
      fixture.fs,
    );

    await expect(
      commitFrozenPrivateIndex(frozen, "message", "/repo", run, fixture.fs, {
        validateOwnership: async () => {
          validationBoundaries.push(fingerprintReads);
          if (validationBoundaries.length === 3) {
            throw new Error("foreign claim arrived during final checks");
          }
        },
      }),
    ).rejects.toThrow("foreign claim arrived during final checks");

    expect(validationBoundaries).toHaveLength(3);
    expect(validationBoundaries[2]).toBeGreaterThan(
      validationBoundaries[1] ?? 0,
    );
    expect(updateRefCalled).toBe(false);
  });

  test("unexpected parent discards the temporary commit without a ref write", async () => {
    const fixture = refFixture({ parents: [FOREIGN] });
    const error = await capturePrivateError(fixture);
    expect(error).toMatchObject({
      code: "commit_failed",
      commitSha: COMMIT,
      committed: false,
    });
    expect(fixture.calls.some((call) => call.args[0] === "update-ref")).toBe(
      false,
    );
  });

  test("hook tree mutation never publishes", async () => {
    const fixture = refFixture({ tree: MUTATED_TREE });
    const error = await capturePrivateError(fixture);
    expect(error).toMatchObject({
      code: "commit_hook_mutated",
      committed: false,
      indeterminate: false,
    });
    expect(error.commitSha).toBeUndefined();
    expect(fixture.calls.some((call) => call.args[0] === "update-ref")).toBe(
      false,
    );
  });

  test("CAS failure is one ref write with no rollback", async () => {
    const fixture = refFixture({ casFails: true });
    const error = await capturePrivateError(fixture);
    expect(error).toMatchObject({
      code: "ref_conflict",
      commitSha: COMMIT,
      committed: false,
      indeterminate: false,
    });
    expect(
      fixture.calls.filter((call) => call.args[0] === "update-ref"),
    ).toHaveLength(1);
  });

  test("an unknowable CAS timeout reports indeterminate and never retries", async () => {
    const fixture = refFixture({ casCode: 124 });
    const error = await capturePrivateError(fixture);
    expect(error).toMatchObject({
      code: "commit_state_indeterminate",
      commitSha: COMMIT,
      committed: false,
      indeterminate: true,
    });
    expect(
      fixture.calls.filter((call) => call.args[0] === "update-ref"),
    ).toHaveLength(1);
  });

  test("a signaled CAS reports indeterminate and never retries", async () => {
    const fixture = refFixture({ casCode: 137, casSignal: "SIGKILL" });
    const error = await capturePrivateError(fixture);
    expect(error).toMatchObject({
      code: "commit_state_indeterminate",
      commitSha: COMMIT,
      committed: false,
      indeterminate: true,
    });
    expect(
      fixture.calls.filter((call) => call.args[0] === "update-ref"),
    ).toHaveLength(1);
  });

  test("commit-tree failure does not publish", async () => {
    const fixture = refFixture({ commitFails: true });
    const error = await capturePrivateError(fixture);
    expect(error).toMatchObject({ code: "commit_failed", committed: false });
    expect(fixture.calls.some((call) => call.args[0] === "update-ref")).toBe(
      false,
    );
  });

  test("a signing-policy/config race refuses construction", async () => {
    const fixture = refFixture({ signingConfigRace: true });
    await expect(frozenFixture(fixture)).rejects.toMatchObject({
      code: "surface_changed",
      stderr: "Git configuration changed while signing policy was captured",
    });
    expect(fixture.calls.some((call) => call.args[0] === "commit-tree")).toBe(
      false,
    );
  });

  test("construction failure removes its private-index directory", async () => {
    const fixture = refFixture();
    const run: GitRunner = async (args, options) => {
      if (args[0] === "read-tree") {
        return { code: 1, stdout: "", stderr: "seed failed" };
      }
      return fixture.run(args, options);
    };
    await expect(
      createFrozenPrivateIndex("/repo", ["a.txt"], run, fixture.fs),
    ).rejects.toMatchObject({ code: "index_seed_failed" });
    expect(fixture.removed()).toBe(1);
  });

  test("a hook cannot add an untrusted Task trailer", async () => {
    const fixture = refFixture();
    const run: GitRunner = async (args, options) => {
      const result = await fixture.run(args, options);
      if (args[0] === "hook" && args.includes("prepare-commit-msg")) {
        const separator = args.indexOf("--");
        const messagePath = separator >= 0 ? args[separator + 1] : undefined;
        if (messagePath) {
          appendFileSync(messagePath, "Task: fn-999-forged.1\n");
        }
      }
      return result;
    };
    const frozen = await createFrozenPrivateIndex(
      "/repo",
      ["a.txt"],
      run,
      fixture.fs,
    );
    await expect(
      commitFrozenPrivateIndex(
        frozen,
        "feat: exact\n\nTask: fn-1-real.1",
        "/repo",
        run,
        fixture.fs,
      ),
    ).rejects.toMatchObject({ code: "commit_hook_mutated" });
    expect(fixture.calls.some((call) => call.args[0] === "commit-tree")).toBe(
      false,
    );
  });

  for (const injected of [
    `Session-Id: ${OTHER}`,
    "Signed-off-by: attacker@example.test",
    "Planctl-Op: refine-apply",
    "Planctl-Target: fn-999-forged.1",
  ]) {
    test(`a hook cannot inject protected authority trailer ${injected.split(":")[0]}`, async () => {
      const fixture = refFixture();
      const run: GitRunner = async (args, options) => {
        const result = await fixture.run(args, options);
        if (args[0] === "hook" && args.includes("prepare-commit-msg")) {
          const separator = args.indexOf("--");
          const messagePath = separator >= 0 ? args[separator + 1] : undefined;
          if (messagePath) appendFileSync(messagePath, `${injected}\n`);
        }
        return result;
      };
      const frozen = await createFrozenPrivateIndex(
        "/repo",
        ["a.txt"],
        run,
        fixture.fs,
      );
      await expect(
        commitFrozenPrivateIndex(
          frozen,
          "feat: exact\n\nTask: fn-1-real.1",
          "/repo",
          run,
          fixture.fs,
          { jobId: ID },
        ),
      ).rejects.toMatchObject({ code: "commit_hook_mutated" });
      expect(fixture.calls.some((call) => call.args[0] === "commit-tree")).toBe(
        false,
      );
    });
  }

  test("a hook cannot expand the commit message beyond its byte bound", async () => {
    const fixture = refFixture();
    const run: GitRunner = async (args, options) => {
      const result = await fixture.run(args, options);
      if (args[0] === "hook" && args.includes("prepare-commit-msg")) {
        const separator = args.indexOf("--");
        const messagePath = separator >= 0 ? args[separator + 1] : undefined;
        if (messagePath) {
          writeFileSync(
            messagePath,
            "x".repeat(MAX_COMMIT_MESSAGE_BYTES + 8_192),
          );
        }
      }
      return result;
    };
    const frozen = await createFrozenPrivateIndex(
      "/repo",
      ["a.txt"],
      run,
      fixture.fs,
    );
    await expect(
      commitFrozenPrivateIndex(
        frozen,
        "feat: bounded message",
        "/repo",
        run,
        fixture.fs,
        { jobId: ID },
      ),
    ).rejects.toMatchObject({ code: "commit_hook_mutated" });
    expect(fixture.calls.some((call) => call.args[0] === "commit-tree")).toBe(
      false,
    );
  });

  for (const [key, value] of [
    ["Task", "fn-1-real.1"],
    ["Job-Id", ID],
    ["Keeper-Commit-Id", "keeper-commit-work:audit-marker"],
  ] as const) {
    test(`a hook cannot alter ${key} with a trailer continuation`, async () => {
      const fixture = refFixture();
      const run: GitRunner = async (args, options) => {
        const result = await fixture.run(args, options);
        if (args[0] === "hook" && args.includes("prepare-commit-msg")) {
          const separator = args.indexOf("--");
          const messagePath = separator >= 0 ? args[separator + 1] : undefined;
          if (messagePath) {
            const before = readFileSync(messagePath, "utf8");
            writeFileSync(
              messagePath,
              before.replace(
                `${key}: ${value}`,
                `${key}: ${value}\n forged-continuation`,
              ),
            );
          }
        }
        return result;
      };
      const frozen = await createFrozenPrivateIndex(
        "/repo",
        ["a.txt"],
        run,
        fixture.fs,
      );
      await expect(
        commitFrozenPrivateIndex(
          frozen,
          "feat: exact\n\nTask: fn-1-real.1",
          "/repo",
          run,
          fixture.fs,
          { jobId: ID },
        ),
      ).rejects.toMatchObject({ code: "commit_hook_mutated" });
      expect(fixture.calls.some((call) => call.args[0] === "commit-tree")).toBe(
        false,
      );
    });
  }

  test("private construction uses exact NUL index-info and one trailer render", async () => {
    const fixture = refFixture();
    const frozen = await frozenFixture(fixture);
    await commitFrozenPrivateIndex(
      frozen,
      "feat: exact\n\nTask: fn-x.1",
      "/repo",
      fixture.run,
      fixture.fs,
      { jobId: ID },
    );
    const exact = fixture.calls.find(
      (call) =>
        call.args[0] === "update-index" &&
        call.env?.GIT_INDEX_FILE !== undefined,
    );
    expect(exact?.args).toEqual(["update-index", "-z", "--index-info"]);
    expect(exact?.stdin).toBe(`100644 ${BLOB} 0\ta.txt\0`);
    expect(
      fixture.calls.some((call) =>
        ["add", "reset"].includes(call.args[0] ?? ""),
      ),
    ).toBe(false);
    expect(
      fixture.calls.filter((call) => call.args[0] === "interpret-trailers"),
    ).toHaveLength(1);
    const rendered = fixture.calls.find(
      (call) => call.args[0] === "interpret-trailers",
    );
    expect(rendered?.stdin).toContain("Task: fn-x.1");
    expect(rendered?.args).toContain(`Job-Id: ${ID}`);
    expect(rendered?.args).toContain(
      "Keeper-Commit-Id: keeper-commit-work:audit-marker",
    );

    const { cleanupPrivateIndex } = await import(
      "../src/commit-work/private-index"
    );
    cleanupPrivateIndex(frozen, fixture.fs);
    expect(fixture.removed()).toBe(1);
  });
});

describe("commit-work immediate discovery and frozen claim binding", () => {
  test("fold-lagged dirt is surfaced immediately as adoptable", async () => {
    const preview = await runForTest(["--preview-files", "--session-id", ID], {
      cwd: "/repo",
      env: {},
      gitRunner: surfaceGit(),
      readClaims: () => [],
    });
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      outcome: "preview",
      files: [],
      surface: { adoptable_unattributed: { total: 1, sample: ["a.txt"] } },
    });
  });

  test("a live foreign claim appearing during lint blocks identical frozen bytes", async () => {
    const fixture = refFixture();
    let reads = 0;
    const output = await runForTest(["message", "--session-id", ID], {
      cwd: "/repo",
      env: {},
      gitRunner: pipelineRun(fixture),
      directEvidence: () => ({ complete: true }),
      readClaims: () => {
        reads += 1;
        return reads < 3
          ? [{ path: "a.txt", sessionId: ID, liveness: "live" as const }]
          : [
              { path: "a.txt", sessionId: ID, liveness: "live" as const },
              {
                path: "a.txt",
                sessionId: OTHER,
                liveness: "unknown" as const,
              },
            ];
      },
      detectInProgress: async () => null,
      checkSharedCheckoutJam: () => false,
      acquireLock: () => ({ release: () => {} }),
      runLint: async () => {},
      privateIndexFs: fixture.fs,
    });
    expect(output.code).toBe(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      outcome: "ownership_conflict",
      reason: "foreign_claim_after_lint",
    });
    expect(fixture.calls.some((call) => call.args[0] === "commit")).toBe(false);
  });

  test("a same-OID foreign claim appearing during hooks blocks publication", async () => {
    let hookRan = false;
    const fixture = refFixture({
      onHook: () => {
        hookRan = true;
      },
    });
    let reads = 0;
    const mine = {
      path: "a.txt",
      sessionId: ID,
      liveness: "live" as const,
      oid: BLOB,
      mode: "100644",
    };
    const output = await runForTest(["message", "--session-id", ID], {
      cwd: "/repo",
      env: {},
      gitRunner: pipelineRun(fixture),
      directEvidence: () => ({ complete: true }),
      readClaims: () => {
        reads += 1;
        return !hookRan
          ? [mine]
          : [
              mine,
              {
                path: "a.txt",
                sessionId: OTHER,
                liveness: "unknown" as const,
                oid: BLOB,
                mode: "100644",
              },
            ];
      },
      detectInProgress: async () => null,
      checkSharedCheckoutJam: () => false,
      acquireLock: () => ({ release: () => {} }),
      runLint: async () => {},
      privateIndexFs: fixture.fs,
    });
    expect(reads).toBe(4);
    expect(JSON.parse(output.stdout)).toMatchObject({
      outcome: "ownership_conflict",
      reason: "foreign_claim_before_publication",
    });
    expect(
      fixture.calls.filter(
        (call) => call.args[0] === "hook" && call.args[1] === "run",
      ),
    ).toHaveLength(3);
    expect(fixture.calls.some((call) => call.args[0] === "commit-tree")).toBe(
      false,
    );
    expect(fixture.calls.some((call) => call.args[0] === "update-ref")).toBe(
      false,
    );
  });

  test("claim OID and mode drift appearing during hooks blocks publication", async () => {
    for (const changed of [
      { oid: FOREIGN, mode: "100644" },
      { oid: BLOB, mode: "100755" },
    ]) {
      let hookRan = false;
      const fixture = refFixture({
        onHook: () => {
          hookRan = true;
        },
      });
      const output = await runForTest(["message", "--session-id", ID], {
        cwd: "/repo",
        env: {},
        gitRunner: pipelineRun(fixture),
        directEvidence: () => ({ complete: true }),
        readClaims: () => [
          {
            path: "a.txt",
            sessionId: ID,
            liveness: "live" as const,
            oid: hookRan ? changed.oid : BLOB,
            mode: hookRan ? changed.mode : "100644",
          },
        ],
        detectInProgress: async () => null,
        checkSharedCheckoutJam: () => false,
        acquireLock: () => ({ release: () => {} }),
        runLint: async () => {},
        privateIndexFs: fixture.fs,
      });
      expect(JSON.parse(output.stdout)).toMatchObject({
        outcome: "surface_changed",
        reason: "claim_identity_changed_before_publication",
      });
      expect(fixture.calls.some((call) => call.args[0] === "commit-tree")).toBe(
        false,
      );
    }
  });

  test("an operation starting during hooks aborts publication", async () => {
    let operationStarted = false;
    const fixture = refFixture({
      onHook: () => {
        operationStarted = true;
      },
    });
    let probes = 0;
    const output = await runForTest(["message", "--session-id", ID], {
      cwd: "/repo",
      env: {},
      gitRunner: pipelineRun(fixture),
      directEvidence: () => ({
        currentSessionPaths: ["a.txt"],
        complete: true,
      }),
      readClaims: () => [],
      detectInProgress: async () => {
        probes += 1;
        return operationStarted ? "rebase" : null;
      },
      checkSharedCheckoutJam: () => false,
      acquireLock: () => ({ release: () => {} }),
      runLint: async () => {},
      privateIndexFs: fixture.fs,
    });
    expect(probes).toBe(4);
    expect(JSON.parse(output.stdout)).toMatchObject({
      outcome: "operation_in_progress",
      operation: "rebase",
    });
    expect(
      fixture.calls.filter(
        (call) => call.args[0] === "hook" && call.args[1] === "run",
      ),
    ).toHaveLength(3);
    expect(fixture.calls.some((call) => call.args[0] === "commit-tree")).toBe(
      false,
    );
    expect(fixture.calls.some((call) => call.args[0] === "update-ref")).toBe(
      false,
    );
  });

  test("publication and push remain bound to the captured branch and commit", async () => {
    const fixture = refFixture();
    const pushed: unknown[][] = [];
    const output = await runForTest(["message", "--session-id", ID], {
      cwd: "/repo",
      env: {},
      gitRunner: pipelineRun(fixture),
      directEvidence: () => ({
        currentSessionPaths: ["a.txt"],
        complete: true,
      }),
      readClaims: () => [],
      detectInProgress: async () => null,
      checkSharedCheckoutJam: () => false,
      acquireLock: () => ({ release: () => {} }),
      runLint: async () => {},
      privateIndexFs: fixture.fs,
      push: async (worktree, sha, branchRef, run) => {
        pushed.push([worktree, sha, branchRef, run]);
        return {
          success: true,
          pushed: true,
          remote: "origin",
          branch: "main",
        };
      },
    });
    expect(output.code).toBe(0);
    expect(pushed).toEqual([
      ["/repo", COMMIT, "refs/heads/main", expect.any(Function)],
    ]);
    // Capture, three hook boundaries, pre/post-commit target validation, and
    // guarded ambient reconciliation; none chooses push source or destination.
    expect(
      fixture.calls.filter((call) => call.args[0] === "symbolic-ref"),
    ).toHaveLength(7);
  });

  test("ambient reconciliation uses one exact index-info update and never reset", async () => {
    const fixture = refFixture();
    const output = await runForTest(["message", "--session-id", ID], {
      cwd: "/repo",
      env: {},
      gitRunner: pipelineRun(fixture),
      directEvidence: () => ({
        currentSessionPaths: ["a.txt"],
        complete: true,
      }),
      readClaims: () => [],
      detectInProgress: async () => null,
      checkSharedCheckoutJam: () => false,
      acquireLock: () => ({ release: () => {} }),
      runLint: async () => {},
      privateIndexFs: fixture.fs,
      push: async () => ({
        success: true,
        pushed: false,
        skipped: "worktree",
        branch: "main",
      }),
    });
    expect(output.code).toBe(0);
    const ambient = fixture.calls.filter(
      (call) =>
        call.args[0] === "update-index" &&
        call.env?.GIT_INDEX_FILE === undefined,
    );
    expect(ambient).toEqual([
      expect.objectContaining({
        args: ["update-index", "-z", "--index-info"],
        stdin: `100644 ${BLOB} 0\ta.txt\0`,
      }),
    ]);
    expect(fixture.calls.some((call) => call.args[0] === "reset")).toBe(false);
  });

  test("automatic claim OID is checked against the frozen selected entry", async () => {
    const fixture = refFixture();
    const run: GitRunner = async (args, options) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { code: 0, stdout: "/repo\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute") {
        return { code: 0, stdout: "/repo/.git\n", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: statusRecord(), stderr: "" };
      }
      if (
        args[0] === "diff" &&
        args.includes("--cached") &&
        args.includes("--name-only")
      ) {
        return {
          code: 0,
          stdout: options?.env?.GIT_INDEX_FILE ? "a.txt\0" : "",
          stderr: "",
        };
      }
      return fixture.run(args, options);
    };
    const output = await runForTest(["message", "--session-id", ID], {
      cwd: "/repo",
      env: {},
      gitRunner: run,
      directEvidence: () => ({ complete: true }),
      readClaims: () => [
        {
          path: "a.txt",
          sessionId: ID,
          liveness: "live",
          oid: "stale-oid",
          mode: "100644",
        },
      ],
      detectInProgress: async () => null,
      checkSharedCheckoutJam: () => false,
      acquireLock: () => ({ release: () => {} }),
      privateIndexFs: fixture.fs,
    });
    expect(output.code).toBe(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      outcome: "surface_changed",
      reason: "automatic_claim_identity_changed",
    });
    expect(fixture.calls.some((call) => call.args[0] === "commit")).toBe(false);
  });

  test("one versioned result carries compatibility aliases and the explicit Job-Id", async () => {
    const fixture = refFixture();
    const run: GitRunner = async (args, options) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { code: 0, stdout: "/repo\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute") {
        return { code: 0, stdout: "/repo/.git\n", stderr: "" };
      }
      if (args[0] === "status") {
        return { code: 0, stdout: statusRecord(), stderr: "" };
      }
      if (
        args[0] === "diff" &&
        args.includes("--cached") &&
        args.includes("--name-only")
      ) {
        return {
          code: 0,
          stdout: options?.env?.GIT_INDEX_FILE ? "a.txt\0" : "",
          stderr: "",
        };
      }
      if (args[0] === "diff" && args.includes("--diff-filter=U")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return fixture.run(args, options);
    };
    const output = await runForTest(["message", "--session-id", ID], {
      cwd: "/repo",
      env: {},
      gitRunner: run,
      directEvidence: () => ({
        currentSessionPaths: ["a.txt"],
        complete: true,
      }),
      readClaims: () => [],
      detectInProgress: async () => null,
      checkSharedCheckoutJam: () => false,
      acquireLock: () => ({ release: () => {} }),
      runLint: async () => {},
      privateIndexFs: fixture.fs,
      push: async () => ({
        success: true,
        pushed: true,
        remote: "origin",
        branch: "main",
      }),
    });
    expect(output.code).toBe(0);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      schema_version: 1,
      kind: "commit-work-result",
      outcome: "committed_pushed",
      commit_sha: COMMIT,
      files: ["a.txt"],
      pushed: true,
      remote: "origin",
      branch: "main",
    });
    const trailers = fixture.calls.find(
      (call) => call.args[0] === "interpret-trailers",
    );
    expect(trailers?.args).toContain(`Job-Id: ${ID}`);
    expect(trailers?.args).toContain(
      "Keeper-Commit-Id: keeper-commit-work:audit-marker",
    );
    const commitTree = fixture.calls.find(
      (call) => call.args[0] === "commit-tree",
    );
    expect(commitTree?.env?.GIT_REFLOG_ACTION).toBeUndefined();
    const ambientUpdates = fixture.calls.filter(
      (call) =>
        call.args[0] === "update-index" &&
        call.env?.GIT_INDEX_FILE === undefined,
    );
    expect(ambientUpdates).toEqual([
      expect.objectContaining({
        args: ["update-index", "-z", "--index-info"],
      }),
    ]);
    expect(fixture.calls.some((call) => call.args[0] === "reset")).toBe(false);
    expect(fixture.removed()).toBe(1);
  });
});

describe("commit-work telemetry", () => {
  test("telemetry import boundary excludes db.ts and bun:sqlite", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/commit-work/telemetry.ts"),
      "utf8",
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/from\s+["'][^"']*\/db["']/);
    expect(code).not.toMatch(/bun:sqlite/);
  });

  test("real append is bounded, mode 0600, and ingestion-compatible", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-commit-telemetry-"));
    try {
      emitCommitWorkOutcome(
        {
          schema_version: 1,
          kind: "commit-work-result",
          outcome: "lint_failed",
          success: false,
          stderr: "x".repeat(COMMIT_WORK_TELEMETRY_DATA_LIMIT * 2),
        },
        ID,
        { eventsLogDir: () => dir },
      );
      const path = join(dir, `${process.pid}.ndjson`);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const line = readFileSync(path, "utf8");
      expect(Buffer.byteLength(line)).toBeLessThan(
        COMMIT_WORK_TELEMETRY_DATA_LIMIT + 2048,
      );
      const parsed = parseEventLogLine(line.trimEnd());
      expect(parsed?.bindings.hook_event).toBe("commit_work_outcome");
      expect(
        Object.values(parsed?.bindings ?? {}).every(
          (value) =>
            value === null ||
            new Set(["string", "number", "boolean"]).has(typeof value),
        ),
      ).toBe(true);
      const data = JSON.parse(String(parsed?.bindings.data));
      expect(data.telemetry_truncated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("filesystem failures remain fail-open", () => {
    expect(() =>
      emitCommitWorkOutcome({ success: true }, ID, {
        eventsLogDir: () => "/unreachable",
        ensureDir: () => {
          throw new Error("no space");
        },
      }),
    ).not.toThrow();
  });
});
