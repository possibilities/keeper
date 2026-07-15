import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvelopeSink } from "../cli/envelope";
import {
  type SessionStateMainDeps,
  main as sessionStateMain,
} from "../cli/session-state";
import { main as sessionSummaryMain } from "../cli/session-summary";
import { main as showJobMain } from "../cli/show-job";
import { main as sessionEventsMain } from "../cli/show-session-events";
import { main as sessionFilesMain } from "../cli/show-session-files";
import type {
  GitExecOptions,
  GitExecResult,
  GitRunner,
} from "../src/commit-work/git-exec";
import { buildSessionCatalog } from "../src/history/catalog";
import type {
  KeeperJobAlias,
  NativeSessionArtifact,
  SessionCatalog,
} from "../src/history/model";
import {
  resolveTrackedSessionReference,
  sessionAmbiguityDetails,
} from "../src/history/resolver";
import { freshDbFile } from "./helpers/template-db";

const PROJECT = "/repo/session-reader";
const NATIVE_ID = "native-alpha";
const JOB_ID = "job-alpha";

let root: string;
let dbPath: string;
let db: Database;

function artifact(
  nativeId: string,
  path: string,
  titles: string[],
  project = PROJECT,
): NativeSessionArtifact {
  return {
    harness: "claude",
    nativeId,
    path,
    project,
    currentTitle: titles.at(-1) ?? null,
    titleHistory: titles,
    titleHistoryComplete: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    bytes: 10,
  };
}

function job(
  jobId: string,
  nativeId = NATIVE_ID,
  title = "Current Alpha",
): KeeperJobAlias {
  return {
    jobId,
    harness: "claude",
    nativeId,
    transcriptPath: null,
    project: PROJECT,
    currentTitle: title,
    titleHistory: ["Old Alpha", title],
    state: "ended",
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    pid: null,
    startTime: null,
  };
}

function catalog(jobs: KeeperJobAlias[] = [job(JOB_ID)]): SessionCatalog {
  return buildSessionCatalog(
    [
      artifact(NATIVE_ID, join(root, "native-alpha.jsonl"), [
        "Old Alpha",
        "Current Alpha",
      ]),
    ],
    jobs,
  );
}

function captureSink(): {
  sink: EnvelopeSink;
  text: () => string;
  code: () => number | null;
} {
  let stdout = "";
  let exitCode: number | null = null;
  return {
    sink: {
      writeStdout(value) {
        stdout += value;
      },
      exit(code): never {
        exitCode = code;
        return undefined as never;
      },
    },
    text: () => stdout,
    code: () => exitCode,
  };
}

function swallowExit(run: () => unknown): void {
  run();
}

const fakeGit: GitRunner = async (
  args: string[],
  _options?: GitExecOptions,
): Promise<GitExecResult> => {
  if (args[0] === "rev-parse") {
    return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
  }
  if (args[0] === "symbolic-ref") {
    return { code: 0, stdout: "main\n", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-session-reference-readers-"));
  dbPath = join(root, "keeper.db");
  db = freshDbFile(dbPath).db;
  db.query(
    `INSERT INTO jobs(
       job_id, created_at, updated_at, cwd, state, title, title_source,
       transcript_path, name_history, harness, resume_target
     ) VALUES (?, 1, 2, ?, 'ended', 'Current Alpha', 'prompt', ?, ?, 'claude', ?)`,
  ).run(
    JOB_ID,
    PROJECT,
    join(root, "native-alpha.jsonl"),
    JSON.stringify(["Old Alpha", "Current Alpha"]),
    NATIVE_ID,
  );
  db.query(
    `INSERT INTO events(
       ts, session_id, hook_event, event_type, tool_name, data
     ) VALUES (1, ?, 'UserPromptSubmit', 'user_prompt_submit', NULL, ?),
              (2, ?, 'PreToolUse', 'pre_tool_use', 'Read', '{}')`,
  ).run(JOB_ID, JSON.stringify({ prompt: "first prompt" }), JOB_ID);
  db.query(
    `INSERT INTO file_attributions(
       project_dir, session_id, file_path, last_mutation_at, last_commit_at,
       op, source
     ) VALUES (?, ?, 'src/changed.ts', 2, NULL, 'edit', 'tool')`,
  ).run(PROJECT, JOB_ID);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("shared tracked-Session resolver outcomes", () => {
  test("resolves qualified/native/job ids and current/historical titles", () => {
    const c = catalog();
    for (const reference of [
      `claude:${NATIVE_ID}`,
      NATIVE_ID,
      JOB_ID,
      "Current Alpha",
      "old alpha",
    ]) {
      const result = resolveTrackedSessionReference(c, reference);
      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") expect(result.job.jobId).toBe(JOB_ID);
    }
  });

  test("native-only, missing job store, and multiple jobs remain distinct", () => {
    const nativeOnly = catalog([]);
    expect(resolveTrackedSessionReference(nativeOnly, NATIVE_ID).kind).toBe(
      "not_tracked",
    );

    const unavailable: SessionCatalog = {
      ...nativeOnly,
      diagnostics: [
        { code: "keeper_jobs_unavailable", harness: null, scope: "job" },
      ],
    };
    expect(resolveTrackedSessionReference(unavailable, NATIVE_ID).kind).toBe(
      "keeper_jobs_unavailable",
    );

    const multiple = catalog([job("job-one"), job("job-two")]);
    expect(resolveTrackedSessionReference(multiple, NATIVE_ID).kind).toBe(
      "job_ambiguous",
    );
    const narrowed = resolveTrackedSessionReference(multiple, "job-two");
    expect(narrowed.kind).toBe("resolved");
    if (narrowed.kind === "resolved") {
      expect(narrowed.job.jobId).toBe("job-two");
    }
  });

  test("an exact job reference cannot be replaced by a different job filter", () => {
    const multiple = catalog([job("job-one"), job("job-two")]);
    expect(
      resolveTrackedSessionReference(multiple, "job-one", {
        jobId: "job-two",
      }).kind,
    ).toBe("not_found");
    const consistent = resolveTrackedSessionReference(multiple, "job-one", {
      jobId: "job-one",
    });
    expect(consistent.kind).toBe("resolved");
    if (consistent.kind === "resolved") {
      expect(consistent.job.jobId).toBe("job-one");
    }
  });

  test("an exact job filter narrows a title shared by distinct Sessions", () => {
    const first = artifact(
      "first",
      join(root, "first.jsonl"),
      ["Shared title"],
      "/repo/first",
    );
    const second = artifact(
      "second",
      join(root, "second.jsonl"),
      ["Shared title"],
      "/repo/second",
    );
    const c = buildSessionCatalog(
      [first, second],
      [
        job("job-first", "first", "Shared title"),
        job("job-second", "second", "Shared title"),
      ],
    );
    expect(resolveTrackedSessionReference(c, "Shared title").kind).toBe(
      "session_ambiguous",
    );
    const narrowed = resolveTrackedSessionReference(c, "Shared title", {
      jobId: "job-second",
    });
    expect(narrowed.kind).toBe("resolved");
    if (narrowed.kind === "resolved") {
      expect(narrowed.job.jobId).toBe("job-second");
    }
  });

  test("duplicate artifacts stay ambiguous and candidate metadata is bounded", () => {
    const artifacts = Array.from({ length: 60 }, (_, index) =>
      artifact(
        "duplicate",
        join(root, `duplicate-${index}.jsonl`),
        ["Repeated"],
        `/repo/${index}`,
      ),
    );
    const resolution = resolveTrackedSessionReference(
      buildSessionCatalog(artifacts),
      "duplicate",
    );
    expect(resolution.kind).toBe("session_ambiguous");
    if (resolution.kind !== "session_ambiguous") return;
    const details = sessionAmbiguityDetails(
      resolution.match,
      resolution.candidates,
    ) as {
      candidate_count: number;
      candidates_truncated: boolean;
      candidates: unknown[];
    };
    expect(details.candidate_count).toBe(60);
    expect(details.candidates).toHaveLength(20);
    expect(details.candidates_truncated).toBe(true);
  });
});

describe("keeper session state|files|events|summary targeting", () => {
  const referenceDeps = (): SessionStateMainDeps => ({
    catalog: catalog(),
    dbPath,
    env: {},
    gitRunner: fakeGit,
    attribution: {
      dbPath,
      gitRoot: () => PROJECT,
      liveDirtyPaths: () => new Set(["src/changed.ts"]),
    },
  });

  test("all four public reads accept historical title/--session forms", async () => {
    const state = captureSink();
    await sessionStateMain(["Old Alpha"], referenceDeps(), state.sink);
    expect(JSON.parse(state.text()).session_files).toEqual(["src/changed.ts"]);

    const files = captureSink();
    sessionFilesMain(
      ["--session", "Old Alpha", "--cwd", PROJECT],
      referenceDeps(),
      files.sink,
    );
    expect(JSON.parse(files.text()).files_by_repo[PROJECT]).toEqual([
      "src/changed.ts",
    ]);

    const events = captureSink();
    swallowExit(() =>
      sessionEventsMain([`claude:${NATIVE_ID}`], events.sink, referenceDeps()),
    );
    expect(events.code()).toBe(0);
    expect(JSON.parse(events.text()).data.session_id).toBe(JOB_ID);

    const summary = captureSink();
    swallowExit(() =>
      sessionSummaryMain(
        ["--session", "Current Alpha"],
        summary.sink,
        referenceDeps(),
      ),
    );
    expect(summary.code()).toBe(0);
    expect(JSON.parse(summary.text()).data.session_id).toBe(JOB_ID);
  });

  test("the compatibility --session-id spelling feeds every shared resolver", async () => {
    const state = captureSink();
    await sessionStateMain(
      ["--session-id", "Old Alpha"],
      referenceDeps(),
      state.sink,
    );
    expect(JSON.parse(state.text()).session_files).toEqual(["src/changed.ts"]);

    const files = captureSink();
    sessionFilesMain(
      ["--session-id", "Old Alpha", "--cwd", PROJECT],
      referenceDeps(),
      files.sink,
    );
    expect(JSON.parse(files.text()).files_by_repo[PROJECT]).toEqual([
      "src/changed.ts",
    ]);

    const events = captureSink();
    sessionEventsMain(
      ["--session-id", "Old Alpha"],
      events.sink,
      referenceDeps(),
    );
    expect(events.code()).toBe(0);
    expect(JSON.parse(events.text()).data.session_id).toBe(JOB_ID);

    const summary = captureSink();
    sessionSummaryMain(
      ["--session-id", "Old Alpha"],
      summary.sink,
      referenceDeps(),
    );
    expect(summary.code()).toBe(0);
    expect(JSON.parse(summary.text()).data.session_id).toBe(JOB_ID);
  });

  test("explicit state reads run git and attribution in the resolved project", async () => {
    const seenCwds: string[] = [];
    const gitRunner: GitRunner = async (args, options) => {
      seenCwds.push(options?.cwd ?? "");
      return fakeGit(args, options);
    };
    const output = captureSink();
    await sessionStateMain(
      ["Old Alpha"],
      { ...referenceDeps(), gitRunner },
      output.sink,
    );
    expect(JSON.parse(output.text()).success).toBe(true);
    expect(seenCwds).toEqual([PROJECT, PROJECT, PROJECT, PROJECT]);
  });

  test("state preserves its zero-argument ambient auto-detection", async () => {
    const output = captureSink();
    await sessionStateMain(
      [],
      {
        ...referenceDeps(),
        env: { KEEPER_JOB_ID: JOB_ID },
      },
      output.sink,
    );
    expect(JSON.parse(output.text()).session_files).toEqual(["src/changed.ts"]);
  });

  test("show-job resolves the same historical title but returns a full job row", () => {
    const output = captureSink();
    swallowExit(() =>
      showJobMain(["Old Alpha"], output.sink, {
        catalog: catalog(),
        dbPath,
        env: {},
      }),
    );
    const body = JSON.parse(output.text());
    expect(output.code()).toBe(0);
    expect(body.data.job.job_id).toBe(JOB_ID);
    expect(body.data.resolution.method).toBe("session-reference");
    expect(body.data.resolution.session_match).toBe("title");
  });

  test("show-job keeps cwd as an orthogonal narrowing filter", () => {
    const firstJob = {
      ...job("job-first", "first", "Shared title"),
      project: "/repo/first",
    };
    const secondJob = {
      ...job("job-second", "second", "Shared title"),
      project: "/repo/second",
    };
    const sharedCatalog = buildSessionCatalog(
      [
        artifact(
          "first",
          join(root, "first.jsonl"),
          ["Shared title"],
          "/repo/first",
        ),
        artifact(
          "second",
          join(root, "second.jsonl"),
          ["Shared title"],
          "/repo/second",
        ),
      ],
      [firstJob, secondJob],
    );
    for (const candidate of [firstJob, secondJob]) {
      db.query(
        `INSERT INTO jobs(
           job_id, created_at, updated_at, cwd, state, title, name_history,
           harness, resume_target
         ) VALUES (?, 3, 4, ?, 'ended', ?, '[]', 'claude', ?)`,
      ).run(
        candidate.jobId,
        candidate.project,
        candidate.currentTitle,
        candidate.nativeId,
      );
    }

    const output = captureSink();
    showJobMain(
      ["Shared title", "--cwd", "/repo/second", "--cwd-exact"],
      output.sink,
      { catalog: sharedCatalog, dbPath, env: {} },
    );
    expect(output.code()).toBe(0);
    expect(JSON.parse(output.text()).data.job.job_id).toBe("job-second");
  });

  test("show-job never recency-collapses multiple jobs for a Session reference", () => {
    const output = captureSink();
    swallowExit(() =>
      showJobMain([NATIVE_ID, "--latest"], output.sink, {
        catalog: catalog([job("job-one"), job("job-two")]),
        dbPath,
        env: {},
      }),
    );
    const body = JSON.parse(output.text());
    expect(output.code()).toBe(1);
    expect(body.error.code).toBe("job_ambiguous");
    expect(body.error.details.candidate_count).toBe(2);
  });

  test("job-backed readers distinguish an unavailable job store from not_tracked", () => {
    const nativeOnly = catalog([]);
    const output = captureSink();
    sessionEventsMain([NATIVE_ID], output.sink, {
      catalog: {
        ...nativeOnly,
        diagnostics: [
          { code: "keeper_jobs_unavailable", harness: null, scope: "job" },
        ],
      },
      dbPath: join(root, "missing.db"),
    });
    expect(output.code()).toBe(1);
    expect(JSON.parse(output.text()).error.code).toBe(
      "keeper_jobs_unavailable",
    );
  });

  test("job-backed readers return typed not_tracked instead of empty data", () => {
    const output = captureSink();
    swallowExit(() =>
      sessionEventsMain([NATIVE_ID], output.sink, {
        catalog: catalog([]),
        dbPath,
      }),
    );
    const body = JSON.parse(output.text());
    expect(output.code()).toBe(1);
    expect(body.error.code).toBe("not_tracked");
    expect(body.error.details.session.qualified_id).toBe(`claude:${NATIVE_ID}`);
  });
});
