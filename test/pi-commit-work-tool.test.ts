import { describe, expect, test } from "bun:test";
import {
  type CommitWorkExecFile,
  createPiCommitWorkTool,
  executePiCommitWork,
  piCommitWorkArgv,
  piCommitWorkParamError,
} from "../plugins/keeper/pi-extension/commit-work-tool";

const ENV = {
  KEEPER_AGENT_PI_PROMPT_EXECUTABLE: "/opt/keeper/bin/bun",
  KEEPER_AGENT_PI_PROMPT_CLI: "/opt/keeper/cli/keeper.ts",
  KEEPER_JOB_ID: "11111111-1111-4111-8111-111111111111",
};

describe("Pi keeper_commit_work tool", () => {
  test("builds argv without shell interpolation and keeps message last", () => {
    expect(
      piCommitWorkArgv({
        message: "feat(pi): keep $(touch nope) inert",
        task_id: "fn-1-pi.2",
        adopt: ["--flag-shaped.ts", "space name.ts"],
        adopt_from: ["/tmp/adopt manifest.json"],
        max_files: 42,
        allow_stale_unstage: true,
      }),
    ).toEqual([
      "commit-work",
      "--allow-stale-unstage",
      "--max-files",
      "42",
      "--task-id",
      "fn-1-pi.2",
      "--adopt",
      "--flag-shaped.ts",
      "--adopt",
      "space name.ts",
      "--adopt-from",
      "/tmp/adopt manifest.json",
      "--",
      "feat(pi): keep $(touch nope) inert",
    ]);
  });

  test("validates bounded message, path, and preview shapes before spawn", () => {
    expect(piCommitWorkParamError({})).toContain("required");
    expect(
      piCommitWorkParamError({
        message: "x",
        message_file: "/tmp/message",
      }),
    ).toContain("either");
    expect(
      piCommitWorkParamError({ message: "x", adopt: ["bad\0path"] }),
    ).toContain("NUL");
    expect(piCommitWorkParamError({ preview_files: true })).toBeNull();
  });

  test("executes the stamped absolute Keeper CLI with cwd, signal, and no shell", async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const run: CommitWorkExecFile = (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(
        null,
        `${JSON.stringify({
          schema_version: 1,
          kind: "commit-work-result",
          outcome: "committed_pushed",
          success: true,
          identity: ENV.KEEPER_JOB_ID,
          committed: true,
          pushed: true,
          commit_sha: "a".repeat(40),
          file_total: 1,
          files: ["owned.ts"],
          selection: { total: 1, sample: ["owned.ts"] },
          surface: { dirty_total: 1 },
          commit: { sha: "a".repeat(40), identities: [{ path: "owned.ts" }] },
          push: { success: true, pushed: true, branch: "main" },
        })}\n`,
        "",
      );
    };
    const result = await executePiCommitWork(
      { message: "feat(pi): publish", task_id: "fn-1-pi.2" },
      { cwd: "/work/repo" },
      controller.signal,
      ENV,
      run,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: "/opt/keeper/bin/bun",
      args: [
        "/opt/keeper/cli/keeper.ts",
        "commit-work",
        "--task-id",
        "fn-1-pi.2",
        "--",
        "feat(pi): publish",
      ],
      options: {
        cwd: "/work/repo",
        env: ENV,
        shell: false,
        signal: controller.signal,
      },
    });
    expect(result.details).toMatchObject({
      outcome: "committed_pushed",
      success: true,
      committed: true,
      pushed: true,
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain('"outcome":"committed_pushed"');
    expect(text).not.toContain("identities");
  });

  test("ownership-conflict request-release pointer survives the compact Pi envelope", async () => {
    const run: CommitWorkExecFile = (_file, _args, _options, callback) => {
      callback(
        { code: 1 },
        `${JSON.stringify({
          schema_version: 1,
          kind: "commit-work-result",
          outcome: "ownership_conflict",
          success: false,
          identity: ENV.KEEPER_JOB_ID,
          request_release: {
            schema_version: 1,
            kind: "commit-work-request-release",
            requester_session_id: ENV.KEEPER_JOB_ID,
            requester_protocol:
              "send-only notice, wait the grace window, re-run, then BLOCKED with request evidence; never signal a live peer",
            claimant_total: 1,
            claimants_truncated: false,
            claimants: [
              {
                claimant_session_id: "22222222-2222-4222-8222-222222222222",
                paths: ["shared/a.txt"],
                path_total: 1,
                paths_truncated: false,
                release_argv: [
                  "keeper",
                  "session",
                  "release",
                  "--session-id",
                  "22222222-2222-4222-8222-222222222222",
                  "--",
                  "shared/a.txt",
                ],
                release_invocation:
                  "keeper session release --session-id 22222222-2222-4222-8222-222222222222 -- shared/a.txt",
              },
            ],
          },
        })}\n`,
        "",
      );
    };
    const result = await executePiCommitWork(
      { message: "feat(pi): blocked" },
      { cwd: "/work/repo" },
      undefined,
      ENV,
      run,
    );
    expect(result.details.outcome).toBe("ownership_conflict");
    const text = result.content[0]?.text ?? "";
    expect(text).toContain('"request_release"');
    expect(text).toContain("22222222-2222-4222-8222-222222222222");
    expect(text).toContain("shared/a.txt");
  });

  test("an explicit unknown push state remains null", async () => {
    const run: CommitWorkExecFile = (_file, _args, _options, callback) => {
      callback(
        { code: 1 },
        JSON.stringify({
          schema_version: 1,
          kind: "commit-work-result",
          outcome: "push_state_indeterminate",
          success: false,
          committed: true,
          pushed: null,
        }),
        "",
      );
    };
    const result = await executePiCommitWork(
      { message: "feat(pi): remote unknown" },
      { cwd: "/work/repo" },
      undefined,
      ENV,
      run,
    );
    expect(result.details.pushed).toBeNull();
    expect(result.content[0]?.text).toContain('"pushed":null');
  });

  test("an already-aborted request spawns nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const result = await executePiCommitWork(
      { preview_files: true },
      { cwd: "/work/repo" },
      controller.signal,
      ENV,
      () => {
        spawned = true;
      },
    );
    expect(spawned).toBe(false);
    expect(result.details.cancelled).toBe(true);
  });

  test("wrapped Pi cells require the launch-bound task id", async () => {
    let spawned = false;
    const env = {
      ...ENV,
      KEEPER_WRAPPED_CELL: "pi",
      KEEPER_WRAPPED_ENVELOPE: "/tmp/keeper-wrapped/fn-9-bound.3.json",
    };
    const rejected = await executePiCommitWork(
      { message: "feat(pi): wrong", task_id: "fn-9-other.1" },
      { cwd: "/work/repo" },
      undefined,
      env,
      () => {
        spawned = true;
      },
    );
    expect(spawned).toBe(false);
    expect(rejected.details.rejected).toContain("fn-9-bound.3");
  });

  test("missing pinned launch paths spawn nothing", async () => {
    let spawned = false;
    const result = await executePiCommitWork(
      { preview_files: true },
      { cwd: "/work/repo" },
      undefined,
      { KEEPER_JOB_ID: ENV.KEEPER_JOB_ID },
      () => {
        spawned = true;
      },
    );
    expect(spawned).toBe(false);
    expect(result.details.unavailable).toBeString();
  });

  test("missing complete output reports indeterminate instead of a false failure", async () => {
    const run: CommitWorkExecFile = (_file, _args, _options, callback) => {
      callback(
        { code: "ETIMEDOUT", signal: "SIGTERM", killed: true },
        "",
        "timed out",
      );
    };
    const result = await executePiCommitWork(
      { message: "feat(pi): uncertain" },
      { cwd: "/work/repo" },
      undefined,
      ENV,
      run,
    );
    expect(result.details).toMatchObject({
      indeterminate: true,
      killed: true,
      signal: "SIGTERM",
    });
    expect(result.content[0]?.text).toContain("inspect the repository");
  });

  test("registered tool carries explicit ownership and retry guidance", () => {
    const tool = createPiCommitWorkTool(ENV, () => {});
    expect(tool.name).toBe("keeper_commit_work");
    expect(tool.description).toContain("tracked Pi session");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.promptGuidelines.join(" ")).toContain("Preview first");
    expect(tool.promptGuidelines.join(" ")).toContain("committed:true");
  });
});
