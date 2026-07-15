import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  prepareForegroundResumeAgentDeps,
  type ResumeCliDeps,
  runResumeCli,
} from "../cli/resume";
import { main as agentMain } from "../src/agent/main";
import { buildSessionCatalog } from "../src/history/catalog";
import type {
  CatalogSession,
  KeeperJobAlias,
  NativeSessionArtifact,
  SessionCatalog,
} from "../src/history/model";
import {
  buildResumeReentryCommand,
  type ForegroundResumeLaunch,
  formatResumePicker,
} from "../src/history/resume";
import {
  claudeCwdSlug,
  nodeResumeResolveFs,
  type ResumeResolveFs,
} from "../src/resume-resolve";
import { encodeClaudeProject } from "../src/transcript/claude";
import { encodePiCwd } from "../src/transcript/pi";
import {
  ExitSignal,
  makeHarness as makeAgentHarness,
} from "./helpers/agent-main-harness";
import { freshDbFile } from "./helpers/template-db";

interface FakeFsSpec {
  files?: Record<string, string>;
  dirs?: string[];
  realpaths?: Record<string, string>;
}

function fakeFs(spec: FakeFsSpec): ResumeResolveFs {
  const files = spec.files ?? {};
  const explicitDirs = spec.dirs ?? [];
  const realpaths = spec.realpaths ?? {};
  const dirs = new Set(explicitDirs);
  for (const path of [...Object.keys(files), ...explicitDirs]) {
    let parent = dirname(path);
    while (parent !== "/" && parent !== ".") {
      dirs.add(parent);
      parent = dirname(parent);
    }
  }
  const canonical = (path: string): string => realpaths[path] ?? path;
  return {
    listDir(dir) {
      const target = canonical(dir);
      const entries = new Set<string>();
      for (const path of [...Object.keys(files), ...dirs]) {
        if (dirname(path) === target) entries.add(basename(path));
      }
      return [...entries];
    },
    exists(path) {
      const target = canonical(path);
      return files[target] !== undefined || dirs.has(target);
    },
    realpath(path) {
      return canonical(path);
    },
    readTail(path, maxBytes) {
      const text = files[canonical(path)];
      if (text === undefined) return null;
      const bytes = Buffer.from(text);
      const start = Math.max(0, bytes.length - maxBytes);
      return {
        text: bytes.toString("utf8", start),
        fromStart: start === 0,
      };
    },
  };
}

function artifact(options: {
  harness: "claude" | "pi";
  id: string;
  path: string;
  project: string;
  titles?: string[];
  updatedAt?: string;
}): NativeSessionArtifact {
  const titles = options.titles ?? [];
  return {
    harness: options.harness,
    nativeId: options.id,
    path: options.path,
    project: options.project,
    currentTitle: titles.at(-1) ?? null,
    titleHistory: titles,
    titleHistoryComplete: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-01-02T00:00:00.000Z",
    bytes: 10,
  };
}

function claudeFixture(options: {
  id: string;
  project: string;
  titles?: string[];
  root?: string;
  updatedAt?: string;
}): { artifact: NativeSessionArtifact; path: string; text: string } {
  const path = join(
    options.root ?? "/home/test/.claude",
    "projects",
    claudeCwdSlug(options.project),
    `${options.id}.jsonl`,
  );
  return {
    path,
    text: `${JSON.stringify({ type: "user", cwd: options.project })}\n`,
    artifact: artifact({
      harness: "claude",
      id: options.id,
      path,
      project: options.project,
      titles: options.titles,
      updatedAt: options.updatedAt,
    }),
  };
}

function piFixture(options: {
  id: string;
  project: string;
  titles?: string[];
  updatedAt?: string;
}): { artifact: NativeSessionArtifact; path: string; text: string } {
  const path = `/home/test/.pi/agent/sessions/bucket/ts_${options.id}.jsonl`;
  return {
    path,
    text: `${JSON.stringify({ type: "session", cwd: options.project })}\n`,
    artifact: artifact({
      harness: "pi",
      id: options.id,
      path,
      project: options.project,
      titles: options.titles,
      updatedAt: options.updatedAt,
    }),
  };
}

function job(overrides: Partial<KeeperJobAlias>): KeeperJobAlias {
  return {
    jobId: "keeper-job",
    harness: "pi",
    nativeId: "pi-native",
    transcriptPath: null,
    project: "/repo/pi",
    currentTitle: "Tracked title",
    titleHistory: ["Tracked title"],
    state: "stopped",
    createdAtMs: 1,
    updatedAtMs: 2,
    pid: null,
    startTime: null,
    ...overrides,
  };
}

function harness(options: {
  catalog: SessionCatalog;
  fs: ResumeResolveFs;
  cwd: string;
  tty?: boolean;
  pickerAnswer?: string | null;
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => string | null;
  launchStatus?: number;
  launchError?: unknown;
}): {
  deps: ResumeCliDeps;
  launches: ForegroundResumeLaunch[];
  picks: CatalogSession[][];
} {
  const launches: ForegroundResumeLaunch[] = [];
  const picks: CatalogSession[][] = [];
  return {
    launches,
    picks,
    deps: {
      cwd: options.cwd,
      homeDir: "/home/test",
      env: {},
      dbPath: "/missing/keeper.db",
      stateDir: "/state",
      fs: options.fs,
      catalog: options.catalog,
      isTty: options.tty ?? true,
      async pick(candidates) {
        picks.push([...candidates]);
        return options.pickerAnswer ?? null;
      },
      liveness: {
        isPidAlive: options.alive ?? (() => false),
        readStartTime: options.startTime ?? (() => null),
      },
      async launchForeground(request) {
        launches.push(request);
        if (options.launchError !== undefined) throw options.launchError;
        return options.launchStatus ?? 0;
      },
    },
  };
}

function parsedError(stdout: string): Record<string, unknown> {
  const envelope = JSON.parse(stdout) as {
    error: Record<string, unknown>;
  };
  return envelope.error;
}

function details(stdout: string): Record<string, unknown> {
  return parsedError(stdout).details as Record<string, unknown>;
}

describe("foreground Session resume", () => {
  test("historical title selects a standalone Claude artifact but the native id is the only resume key", async () => {
    const fixture = claudeFixture({
      id: "claude-full-native-id",
      project: "/repo/claude",
      titles: ["Historical title", "Current title"],
    });
    const catalog = buildSessionCatalog([fixture.artifact]);
    const fs = fakeFs({
      files: { [fixture.path]: fixture.text },
      dirs: [fixture.artifact.project as string],
    });
    const h = harness({ catalog, fs, cwd: "/repo/claude" });

    const outcome = await runResumeCli(["historical TITLE"], h.deps);

    expect(outcome.code).toBe(0);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]?.target).toBe("claude-full-native-id");
    expect(h.launches[0]?.baseNativeArgv).toEqual([
      "claude",
      "--resume",
      "claude-full-native-id",
    ]);
    expect(h.launches[0]?.agentArgv).toEqual([
      "claude",
      "--x-no-confirm",
      "--resume",
      "claude-full-native-id",
    ]);
    expect(h.launches[0]?.liveness).toMatchObject({
      state: "unknown",
      reason: "standalone_session",
    });
  });

  test("an artifact-less resume target cannot shadow a real Session title", async () => {
    const fixture = claudeFixture({
      id: "claude-real-native-id",
      project: "/repo/claude",
      titles: ["shared-selector"],
    });
    const catalog = buildSessionCatalog(
      [fixture.artifact],
      [
        job({
          jobId: "failed-pi-job",
          harness: "pi",
          nativeId: "shared-selector",
          transcriptPath: null,
          project: "/repo/claude",
          currentTitle: null,
          titleHistory: [],
        }),
      ],
    );
    const fs = fakeFs({
      files: { [fixture.path]: fixture.text },
      dirs: ["/repo/claude"],
    });
    const h = harness({ catalog, fs, cwd: "/repo/claude" });

    const outcome = await runResumeCli(["shared-selector"], h.deps);

    expect(outcome.code).toBe(0);
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]).toMatchObject({
      harness: "claude",
      target: "claude-real-native-id",
      qualifiedId: "claude:claude-real-native-id",
    });
  });

  test("standalone Pi resumes by its full native session id and keeps liveness unknown", async () => {
    const fixture = piFixture({
      id: "pi-full-native-id",
      project: "/repo/pi",
      titles: ["Pi native"],
    });
    const catalog = buildSessionCatalog([fixture.artifact]);
    const fs = fakeFs({
      files: { [fixture.path]: fixture.text },
      dirs: ["/repo/pi"],
    });
    const h = harness({ catalog, fs, cwd: "/repo/pi" });

    await runResumeCli(["pi:pi-full-native-id"], h.deps);

    expect(h.launches[0]?.baseNativeArgv).toEqual([
      "pi",
      "--session",
      "pi-full-native-id",
    ]);
    expect(h.launches[0]?.keeperJobIdCarrier).toBeNull();
    expect(h.launches[0]?.liveness.state).toBe("unknown");
  });

  test("foreground handoff reuses Claude account/plugin launch semantics", async () => {
    const h = makeAgentHarness({
      argv: [],
      rawArgv: true,
      cwd: "/wrong",
      env: { KEEPER_JOB_ID: "ambient", PWD: "/wrong" },
    });
    const request: ForegroundResumeLaunch = {
      harness: "claude",
      target: "claude-native",
      cwd: "/repo/claude",
      qualifiedId: "claude:claude-native",
      baseNativeArgv: ["claude", "--resume", "claude-native"],
      agentArgv: ["claude", "--x-no-confirm", "--resume", "claude-native"],
      keeperJobIdCarrier: null,
      liveness: {
        state: "unknown",
        reason: "standalone_session",
        evidence: [],
      },
    };

    const deps = prepareForegroundResumeAgentDeps(request, h.deps);
    await expect(agentMain(deps)).rejects.toBeInstanceOf(ExitSignal);

    const cmd = h.spawned[0] ?? [];
    expect(h.routerCalls()).toBe(1);
    expect(cmd[0]).toBe("/fake-home/.local/bin/claude");
    expect(cmd).toContain("--resume");
    expect(cmd[cmd.indexOf("--resume") + 1]).toBe("claude-native");
    expect(cmd).toContain("--strict-mcp-config");
    expect(cmd).toContain("--settings");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--session-id");
    expect(cmd).not.toContain("--name");
    expect(h.spawnOptions[0]?.cwd).toBe("/repo/claude");
    expect(h.spawnOptions[0]?.env?.PWD).toBe("/repo/claude");
    expect(h.deps.env.KEEPER_JOB_ID).toBe("ambient");
  });

  test("foreground handoff carries only an unambiguous Pi Keeper job id", async () => {
    for (const [carrier, expectedJobId] of [
      [null, "fresh-pi-job"],
      ["keeper-alias", "keeper-alias"],
    ] as const) {
      const h = makeAgentHarness({
        argv: [],
        rawArgv: true,
        cwd: "/wrong",
        env: { KEEPER_JOB_ID: "ambient", PWD: "/wrong" },
        randomUuid: () => "fresh-pi-job",
        resolvePiExtensionArgs: () => ["-e", "/fake/pi-extension.js"],
      });
      const request: ForegroundResumeLaunch = {
        harness: "pi",
        target: "pi-native",
        cwd: "/repo/pi",
        qualifiedId: "pi:pi-native",
        baseNativeArgv: ["pi", "--session", "pi-native"],
        agentArgv: ["pi", "--x-no-confirm", "--session", "pi-native"],
        keeperJobIdCarrier: carrier,
        liveness: {
          state: "unknown",
          reason: "standalone_session",
          evidence: [],
        },
      };

      const deps = prepareForegroundResumeAgentDeps(request, h.deps);
      await expect(agentMain(deps)).rejects.toBeInstanceOf(ExitSignal);

      expect(h.piStateSharingCalls).toHaveLength(1);
      expect(h.spawned[0]).toEqual([
        "/fake-home/.local/bin/pi",
        "--session",
        "pi-native",
        "-e",
        "/fake/pi-extension.js",
      ]);
      expect(h.spawned[0]).not.toContain("-na");
      expect(h.birthRecords[0]?.draft).toMatchObject({
        session_id: expectedJobId,
        harness: "pi",
        cwd: "/repo/pi",
        resume_target: "pi-native",
      });
      expect(h.spawnOptions[0]?.cwd).toBe("/repo/pi");
      expect(h.spawnOptions[0]?.env?.PWD).toBe("/repo/pi");
      expect(h.spawnOptions[0]?.env?.KEEPER_JOB_ID).toBe(expectedJobId);
      expect(h.deps.env.KEEPER_JOB_ID).toBe("ambient");
    }
  });

  test("non-TTY ambiguity returns a bounded structured envelope and launches nothing", async () => {
    const c = claudeFixture({
      id: "claude-a",
      project: "/repo/a",
      titles: ["Reusable"],
    });
    const p = piFixture({
      id: "pi-b",
      project: "/repo/b",
      titles: ["reusable"],
    });
    const catalog = buildSessionCatalog([c.artifact, p.artifact]);
    const fs = fakeFs({
      files: { [c.path]: c.text, [p.path]: p.text },
      dirs: ["/repo/a", "/repo/b"],
    });
    const h = harness({ catalog, fs, cwd: "/repo/a", tty: false });

    const outcome = await runResumeCli(["REUSABLE"], h.deps);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toBe("");
    expect(parsedError(outcome.stdout).code).toBe("session_ambiguous");
    const candidates = details(outcome.stdout).candidates as Array<
      Record<string, unknown>
    >;
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      harness: "claude",
      current_title: "Reusable",
      qualified_id: "claude:claude-a",
      project: "/repo/a",
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    expect(h.picks).toEqual([]);
    expect(h.launches).toEqual([]);
  });

  test("JSON ambiguity never opens the TTY picker", async () => {
    const a = piFixture({ id: "one", project: "/one", titles: ["Same"] });
    const b = piFixture({ id: "two", project: "/two", titles: ["Same"] });
    const catalog = buildSessionCatalog([a.artifact, b.artifact]);
    const fs = fakeFs({
      files: { [a.path]: a.text, [b.path]: b.text },
      dirs: ["/one", "/two"],
    });
    const h = harness({ catalog, fs, cwd: "/one", tty: true });

    const outcome = await runResumeCli(["Same", "--format", "json"], h.deps);

    expect(parsedError(outcome.stdout).code).toBe("session_ambiguous");
    expect(h.picks).toEqual([]);
    expect(h.launches).toEqual([]);
  });

  test("--json is an alias of --format json and conflicts with human", async () => {
    const h = harness({
      catalog: buildSessionCatalog([]),
      fs: fakeFs({}),
      cwd: "/repo",
      tty: true,
    });

    const json = await runResumeCli(["missing", "--json"], h.deps);
    expect(json.stderr).toBe("");
    expect(parsedError(json.stdout).code).toBe("session_not_found");

    const conflict = await runResumeCli(
      ["missing", "--json", "--format", "human"],
      h.deps,
    );
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain("--json conflicts with --format human");
  });

  test("TTY picker exposes required fields and launches only the numbered selection", async () => {
    const c = claudeFixture({
      id: "claude-pick",
      project: "/repo/claude",
      titles: ["Pick me"],
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    const p = piFixture({
      id: "pi-pick",
      project: "/repo/pi",
      titles: ["Pick me"],
      updatedAt: "2026-01-04T00:00:00.000Z",
    });
    const catalog = buildSessionCatalog([c.artifact, p.artifact]);
    const fs = fakeFs({
      files: { [c.path]: c.text, [p.path]: p.text },
      dirs: ["/repo/claude", "/repo/pi"],
    });
    const h = harness({
      catalog,
      fs,
      cwd: "/repo/pi",
      tty: true,
      pickerAnswer: "2",
    });

    const outcome = await runResumeCli(["Pick me"], h.deps);

    expect(outcome.code).toBe(0);
    expect(h.picks).toHaveLength(1);
    const menu = formatResumePicker(h.picks[0] ?? []);
    expect(menu).toContain("claude  Pick me  claude:claude-pick");
    expect(menu).toContain("project=/repo/pi");
    expect(menu).toContain("updated=2026-01-04T00:00:00.000Z");
    expect(h.launches.map((launch) => launch.qualifiedId)).toEqual([
      "pi:pi-pick",
    ]);
  });

  for (const [label, answer, code] of [
    ["cancel", "", "picker_cancelled"],
    ["invalid", "99", "picker_invalid"],
  ] as const) {
    test(`TTY picker ${label} launches nothing`, async () => {
      const a = piFixture({ id: "one", project: "/one", titles: ["Same"] });
      const b = piFixture({ id: "two", project: "/two", titles: ["Same"] });
      const catalog = buildSessionCatalog([a.artifact, b.artifact]);
      const fs = fakeFs({
        files: { [a.path]: a.text, [b.path]: b.text },
        dirs: ["/one", "/two"],
      });
      const h = harness({
        catalog,
        fs,
        cwd: "/one",
        tty: true,
        pickerAnswer: answer,
      });

      const outcome = await runResumeCli(["Same"], h.deps);

      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain(code.replace("picker_", ""));
      expect(h.launches).toEqual([]);
    });
  }

  test("--project disambiguates duplicate harness-native ids", async () => {
    const a = claudeFixture({ id: "duplicate", project: "/repo/a" });
    const b = claudeFixture({ id: "duplicate", project: "/repo/b" });
    const catalog = buildSessionCatalog([a.artifact, b.artifact]);
    const fs = fakeFs({
      files: { [a.path]: a.text, [b.path]: b.text },
      dirs: ["/repo/a", "/repo/b"],
    });
    const h = harness({ catalog, fs, cwd: "/repo/b" });

    const outcome = await runResumeCli(
      ["claude:duplicate", "--project", "/repo/b"],
      h.deps,
    );

    expect(outcome.code).toBe(0);
    expect(h.launches[0]?.cwd).toBe("/repo/b");
    expect(h.launches[0]?.target).toBe("duplicate");
  });

  test("production-shaped Claude resume follows a symlinked/re-homed transcript tail cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-resume-claude-real-"));
    try {
      const home = join(root, "home");
      const stateDir = join(root, "state");
      const project = join(root, "repo", "claude");
      const projectsDir = join(home, ".claude", "projects");
      const physicalBucket = join(root, "physical-bucket-not-a-cwd-slug");
      const nativeId = "claude-real-symlink";
      mkdirSync(project, { recursive: true });
      mkdirSync(projectsDir, { recursive: true });
      mkdirSync(physicalBucket, { recursive: true });
      symlinkSync(
        physicalBucket,
        join(projectsDir, encodeClaudeProject(project)),
        "dir",
      );
      writeFileSync(
        join(physicalBucket, `${nativeId}.jsonl`),
        `${JSON.stringify({
          type: "user",
          timestamp: "2026-01-02T00:00:00.000Z",
          cwd: project,
          message: { role: "user", content: "hello" },
        })}\n`,
      );

      const launches: ForegroundResumeLaunch[] = [];
      const outcome = await runResumeCli([`claude:${nativeId}`], {
        cwd: project,
        homeDir: home,
        env: {},
        dbPath: join(root, "missing-keeper.db"),
        stateDir,
        fs: nodeResumeResolveFs(),
        isTty: false,
        async pick() {
          throw new Error("picker must not open for a qualified id");
        },
        liveness: {
          isPidAlive: () => false,
          readStartTime: () => null,
        },
        async launchForeground(request) {
          launches.push(request);
          return 0;
        },
      });

      expect(outcome.code).toBe(0);
      expect(launches[0]?.cwd).toBe(realpathSync(project));
      expect(launches[0]?.target).toBe(nativeId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("production-shaped Pi catalog with multiple Keeper jobs mints a fresh foreground alias", async () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-resume-pi-real-"));
    const dbPath = join(root, "keeper.db");
    const kdb = freshDbFile(dbPath);
    try {
      const home = join(root, "home");
      const stateDir = join(root, "state");
      const project = join(root, "repo", "pi");
      const nativeId = "pi-real-native";
      const bucket = join(
        home,
        ".pi",
        "agent",
        "sessions",
        encodePiCwd(project),
      );
      mkdirSync(project, { recursive: true });
      mkdirSync(bucket, { recursive: true });
      writeFileSync(
        join(bucket, `2026-01-01T00-00-00.000Z_${nativeId}.jsonl`),
        `${JSON.stringify({ type: "session", cwd: project })}\n`,
      );
      const insert = kdb.db.prepare(`INSERT INTO jobs(
        job_id, created_at, updated_at, cwd, title, name_history,
        transcript_path, harness, resume_target
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      insert.run(
        "keeper-pi-a",
        1,
        2,
        project,
        "Pi A",
        JSON.stringify(["Pi A"]),
        null,
        "pi",
        nativeId,
      );
      insert.run(
        "keeper-pi-b",
        1,
        3,
        project,
        "Pi B",
        JSON.stringify(["Pi B"]),
        null,
        "pi",
        nativeId,
      );

      const launches: ForegroundResumeLaunch[] = [];
      const outcome = await runResumeCli([`pi:${nativeId}`], {
        cwd: project,
        homeDir: home,
        env: {},
        dbPath,
        stateDir,
        fs: nodeResumeResolveFs(),
        isTty: false,
        async pick() {
          throw new Error("picker must not open for a qualified id");
        },
        liveness: {
          isPidAlive: () => false,
          readStartTime: () => null,
        },
        async launchForeground(request) {
          launches.push(request);
          return 0;
        },
      });

      expect(outcome.code).toBe(0);
      expect(launches[0]?.target).toBe(nativeId);
      expect(launches[0]?.keeperJobIdCarrier).toBeNull();
      expect(launches[0]?.agentArgv).toEqual([
        "pi",
        "--x-no-confirm",
        "--session",
        nativeId,
      ]);
    } finally {
      kdb.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("duplicate artifacts with the same harness id and project remain unresumable after a picker choice", async () => {
    const first = artifact({
      harness: "pi",
      id: "same-native",
      path: "/pi/a/ts_same-native.jsonl",
      project: "/repo",
      titles: ["Collision"],
    });
    const second = artifact({
      harness: "pi",
      id: "same-native",
      path: "/pi/b/ts_same-native.jsonl",
      project: "/repo",
      titles: ["Collision"],
    });
    const catalog = buildSessionCatalog([first, second]);
    const fs = fakeFs({
      files: {
        "/pi/a/ts_same-native.jsonl": "{}\n",
        "/pi/b/ts_same-native.jsonl": "{}\n",
      },
      dirs: ["/repo"],
    });
    const h = harness({
      catalog,
      fs,
      cwd: "/repo",
      pickerAnswer: "1",
    });

    const outcome = await runResumeCli(
      ["pi:same-native", "--format", "human"],
      h.deps,
    );

    expect(outcome.stderr).toContain("native resume key is ambiguous");
    expect(h.launches).toEqual([]);
  });

  test("a job alias conflicting with artifact identity fails instead of guessing", async () => {
    const fixture = piFixture({ id: "native", project: "/repo" });
    const catalog = buildSessionCatalog([fixture.artifact]);
    const selected = catalog.sessions[0] as CatalogSession;
    selected.jobs.push(
      job({
        jobId: "bad-alias",
        nativeId: "different-native-id",
        transcriptPath: fixture.path,
        project: "/repo",
      }),
    );
    const fs = fakeFs({
      files: { [fixture.path]: fixture.text },
      dirs: ["/repo"],
    });
    const h = harness({ catalog, fs, cwd: "/repo" });

    const outcome = await runResumeCli(
      ["pi:native", "--format", "json"],
      h.deps,
    );

    expect(parsedError(outcome.stdout).code).toBe("alias_conflict");
    expect(details(outcome.stdout).conflict_job_ids).toEqual(["bad-alias"]);
    expect(h.launches).toEqual([]);
  });

  test("positive live identity refuses, while a recycled pid is resumable", async () => {
    const fixture = piFixture({ id: "pi-native", project: "/repo/pi" });
    const alias = job({
      jobId: "keeper-alias",
      nativeId: "pi-native",
      transcriptPath: fixture.path,
      project: "/repo/pi",
      pid: 4242,
      startTime: "darwin:original",
    });
    const catalog = buildSessionCatalog([fixture.artifact], [alias]);
    const fs = fakeFs({
      files: { [fixture.path]: fixture.text },
      dirs: ["/repo/pi"],
    });
    const live = harness({
      catalog,
      fs,
      cwd: "/repo/pi",
      alive: () => true,
      startTime: () => "darwin:original",
    });

    const refused = await runResumeCli(
      ["keeper-alias", "--format", "json"],
      live.deps,
    );
    expect(parsedError(refused.stdout).code).toBe("session_live");
    expect(live.launches).toEqual([]);

    const recycled = harness({
      catalog,
      fs,
      cwd: "/repo/pi",
      alive: () => true,
      startTime: () => "darwin:recycled",
    });
    const resumed = await runResumeCli(["keeper-alias"], recycled.deps);
    expect(resumed.code).toBe(0);
    expect(recycled.launches[0]?.target).toBe("pi-native");
    expect(recycled.launches[0]?.keeperJobIdCarrier).toBe("keeper-alias");
    expect(recycled.launches[0]?.liveness.state).toBe("not_live");
    expect(recycled.launches[0]?.liveness.evidence[0]?.status).toBe("recycled");
  });

  test("wrong cwd emits one POSIX-quoted command and reports standalone liveness as unknown in JSON", async () => {
    const target = "/repo/it's $wild;[x]";
    const fixture = claudeFixture({ id: "quoted", project: target });
    const catalog = buildSessionCatalog([fixture.artifact]);
    const fs = fakeFs({
      files: { [fixture.path]: fixture.text },
      dirs: [target, "/elsewhere"],
    });
    const h = harness({ catalog, fs, cwd: "/elsewhere" });

    const human = await runResumeCli(["claude:quoted"], h.deps);
    expect(human.stdout).toBe(
      `${buildResumeReentryCommand({ cwd: target, qualifiedId: "claude:quoted" })}\n`,
    );
    expect(human.stderr).toBe("");
    expect(h.launches).toEqual([]);

    const machine = await runResumeCli(
      ["claude:quoted", "--format", "json"],
      h.deps,
    );
    const meta = details(machine.stdout);
    expect(parsedError(machine.stdout).code).toBe("wrong_cwd");
    expect((meta.liveness as Record<string, unknown>).state).toBe("unknown");
    expect(String(meta.command)).toContain("'\"'\"'");
  });

  test("wrong-cwd re-entry includes --project when duplicate native ids require it", async () => {
    const a = claudeFixture({ id: "duplicate", project: "/repo/a" });
    const b = claudeFixture({ id: "duplicate", project: "/repo/b" });
    const catalog = buildSessionCatalog([a.artifact, b.artifact]);
    const fs = fakeFs({
      files: { [a.path]: a.text, [b.path]: b.text },
      dirs: ["/repo/a", "/repo/b", "/elsewhere"],
    });
    const h = harness({ catalog, fs, cwd: "/elsewhere" });

    const outcome = await runResumeCli(
      ["claude:duplicate", "--project", "/repo/b"],
      h.deps,
    );

    expect(outcome.stdout).toBe(
      "cd -- '/repo/b' && keeper resume 'claude:duplicate' --project '/repo/b'\n",
    );
    expect(h.launches).toEqual([]);
  });

  test("vanished artifact cwd and missing artifact both fail before launch", async () => {
    const vanished = claudeFixture({ id: "gone-cwd", project: "/gone" });
    const missing = piFixture({ id: "gone-artifact", project: "/repo" });
    const catalog = buildSessionCatalog([vanished.artifact, missing.artifact]);
    const fs = fakeFs({
      files: { [vanished.path]: vanished.text },
      dirs: ["/current", "/repo"],
    });
    const h = harness({ catalog, fs, cwd: "/current" });

    const cwdResult = await runResumeCli(
      ["claude:gone-cwd", "--format", "json"],
      h.deps,
    );
    expect(parsedError(cwdResult.stdout).code).toBe("cwd_vanished");

    const artifactResult = await runResumeCli(
      ["pi:gone-artifact", "--format", "json"],
      h.deps,
    );
    expect(parsedError(artifactResult.stdout).code).toBe("artifact_missing");
    expect(h.launches).toEqual([]);
  });

  test("missing binary is friendly and child exit status propagates through the launch seam", async () => {
    const fixture = piFixture({ id: "launch", project: "/repo" });
    const catalog = buildSessionCatalog([fixture.artifact]);
    const fs = fakeFs({
      files: { [fixture.path]: fixture.text },
      dirs: ["/repo"],
    });
    const missing = harness({
      catalog,
      fs,
      cwd: "/repo",
      launchError: { code: "ENOENT", path: "pi" },
    });
    const missingResult = await runResumeCli(
      ["pi:launch", "--format", "json"],
      missing.deps,
    );
    expect(parsedError(missingResult.stdout).code).toBe("binary_not_found");

    const exited = harness({
      catalog,
      fs,
      cwd: "/repo",
      launchStatus: 23,
    });
    const exitResult = await runResumeCli(["pi:launch"], exited.deps);
    expect(exitResult.code).toBe(23);
    expect(exited.launches).toHaveLength(1);
  });

  test("--latest is not part of the foreground resume grammar", async () => {
    const outcome = await runResumeCli(["anything", "--latest"]);
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain("Unknown option '--latest'");
  });

  test("--help is resolved before production catalog/process dependencies", async () => {
    const outcome = await runResumeCli(["--help"]);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("keeper resume <session-reference>");
  });
});
