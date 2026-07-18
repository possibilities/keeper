/**
 * keeper's ephemeral pi extension (`plugins/keeper/pi-extension/keeper-events.ts`)
 * — the M3b live-state translator for pi. These tests pin the PURE translation
 * (pi AgentHarness event → events-log NDJSON) against golden fixtures, prove
 * hostile tool payloads round-trip as data, and exercise the fail-open factory
 * guards (no keeper marker → zero output; a throwing write never escapes). No
 * real pi is ever booted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import keeperEventsExtension, {
  canonicalPiMutationPath,
  clampHistoryParams,
  defaultPiEventStorePaths,
  executeHistoryTool,
  type HistoryExecFile,
  historyCliArgs,
  historyParamError,
  historyToolResult,
  type PiEventBindings,
  type PiExtensionApi,
  type PiExtensionRuntimeOptions,
  type PiObservedEvent,
  type PiSessionContext,
  type PiTranslateMeta,
  piDispatchAttemptFromEnv,
  piEventBindings,
  preparePiMutationEvent,
  resolvePiMutationInputPath,
  sendPiBusMessage,
  serializePiLine,
  titleEventBindings,
  translatePiEvent,
} from "../plugins/keeper/pi-extension/keeper-events";
import type {
  MonitorArtifact,
  MonitorChild,
} from "../plugins/keeper/pi-extension/monitor-facade";
import {
  buildPiTurnArgv,
  buildRenameInputText,
  createRenameCommandHandler,
  createRenameInvocationState,
  extractCompletionText,
  type PiRenameApi,
  parseTurnCliOutput,
  RENAME_MODEL_ID,
  RENAME_MODEL_PROVIDER,
  type RenameCommandContext,
  type RenameCommandDeps,
  registerRenameCommand,
  renameFeedback,
  renameSlugify,
  runRenameInvocation,
  stripSkillBlocks,
  stripUnsafeText,
} from "../plugins/keeper/pi-extension/rename-command";
import { piExtensionArgs, piExtensionPath } from "../src/agent/launch-config";
import { parseDeadLetterLine, parseEventLogLine } from "../src/dead-letter";
import { slugify as canonicalSlugify } from "../src/slug";
import { retryUntil } from "./helpers/retry-until";

class ExtensionMonitorChild extends EventEmitter implements MonitorChild {
  pid = 7331;
  exitCode: number | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.close(null, signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? (signal === null ? 0 : 128);
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

class ExtensionMonitorArtifact implements MonitorArtifact {
  closed = false;

  constructor(readonly path: string) {}

  write(): void {}

  close(): void {
    this.closed = true;
  }
}

const META: PiTranslateMeta = {
  jobId: "job-1111-2222",
  pid: 4242,
  cwd: "/work/repo",
  tsSec: 1_700_000_000,
};

describe("pi extension — pure translation", () => {
  test("exact attempt metadata rides lifecycle data without changing bindings", () => {
    const b = piEventBindings(
      { type: "agent_start" },
      { ...META, dispatchAttemptId: 42 },
    );
    expect(JSON.parse(b?.data as string)).toEqual({
      hook_event_name: "UserPromptSubmit",
      dispatch_attempt_id: 42,
    });
    expect(piDispatchAttemptFromEnv({ KEEPER_DISPATCH_ATTEMPT_ID: "42" })).toBe(
      42,
    );
    for (const raw of ["", "0", "bad", "1;rm", "9".repeat(40)]) {
      expect(
        piDispatchAttemptFromEnv({ KEEPER_DISPATCH_ATTEMPT_ID: raw }),
      ).toBeNull();
    }
  });

  test("agent_start folds to a working-driving UserPromptSubmit", () => {
    const b = piEventBindings({ type: "agent_start" }, META);
    expect(b).toEqual({
      ts: 1_700_000_000,
      session_id: "job-1111-2222",
      pid: 4242,
      hook_event: "UserPromptSubmit",
      event_type: "user_prompt_submit",
      cwd: "/work/repo",
      data: '{"hook_event_name":"UserPromptSubmit"}',
    });
  });

  test("agent_end folds to a stopping Stop", () => {
    const b = piEventBindings({ type: "agent_end" }, META);
    expect(b?.hook_event).toBe("Stop");
    expect(b?.event_type).toBe("stop");
    expect(b?.session_id).toBe("job-1111-2222");
    expect(b?.data).toBe('{"hook_event_name":"Stop"}');
  });

  test("agent_end carries the harness-armed bus watcher as an ambient task", () => {
    const b = piEventBindings(
      { type: "agent_end" },
      {
        ...META,
        backgroundTasks: [
          {
            id: "pi-bus-42",
            type: "shell",
            command: "keeper bus watch --json --lifetime-stdin",
            description: "keeper agent bus",
            kind: "ambient",
          },
        ],
      },
    );
    expect(JSON.parse(b?.data as string).background_tasks).toEqual([
      {
        id: "pi-bus-42",
        type: "shell",
        command: "keeper bus watch --json --lifetime-stdin",
        description: "keeper agent bus",
        kind: "ambient",
      },
    ]);
  });

  test("tool_call folds to PreToolUse carrying the tool name + input", () => {
    const b = piEventBindings(
      { type: "tool_call", toolName: "bash", input: { command: "ls -la" } },
      META,
    );
    expect(b?.hook_event).toBe("PreToolUse");
    expect(b?.event_type).toBe("pre_tool_use");
    expect(b?.tool_name).toBe("Bash");
    expect(JSON.parse(b?.data as string)).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
  });

  test("failed tool_result folds to non-attributing PostToolUseFailure", () => {
    const b = piEventBindings(
      {
        type: "tool_result",
        toolName: "edit",
        input: { path: "failed.ts" },
        isError: true,
      },
      META,
    );
    expect(b?.hook_event).toBe("PostToolUseFailure");
    expect(b?.event_type).toBe("post_tool_use_failure");
    expect(b?.tool_name).toBe("Edit");
    expect(b?.mutation_path).toBeUndefined();
    expect(JSON.parse(b?.data as string)).toEqual({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Edit",
      tool_input: { path: "failed.ts", file_path: "failed.ts" },
      is_error: true,
    });
  });

  test("successful Monitor results lift only a plain non-empty details.taskId", () => {
    const valid = piEventBindings(
      {
        type: "tool_result",
        toolName: "Monitor",
        isError: false,
        details: { taskId: "monitor-42" },
      },
      META,
    );
    expect(JSON.parse(String(valid?.data)).tool_response).toEqual({
      taskId: "monitor-42",
    });

    class HostileDetails {
      taskId = "inherited-or-classed";
    }
    for (const event of [
      {
        type: "tool_result",
        toolName: "Monitor",
        isError: false,
        details: new HostileDetails(),
      },
      {
        type: "tool_result",
        toolName: "Monitor",
        isError: false,
        details: { taskId: "   " },
      },
      {
        type: "tool_result",
        toolName: "Monitor",
        isError: true,
        details: { taskId: "failed-monitor" },
      },
      {
        type: "tool_result",
        toolName: "read",
        isError: false,
        details: { taskId: "other-tool" },
      },
    ] satisfies PiObservedEvent[]) {
      expect(
        JSON.parse(String(piEventBindings(event, META)?.data)).tool_response,
      ).toBeUndefined();
    }
  });

  test("successful Pi write/edit results carry canonical exclusive mutation evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-pi-mutation-"));
    try {
      mkdirSync(join(root, "real"));
      writeFileSync(join(root, "real", "file.ts"), "x\n");
      symlinkSync("real", join(root, "alias"));
      const prepared = preparePiMutationEvent(
        {
          type: "tool_result",
          toolName: "write",
          input: { path: "alias/file.ts", content: "x" },
          content: [{ type: "text", text: "Wrote alias/file.ts" }],
          isError: false,
        },
        root,
      );
      const b = piEventBindings(prepared, { ...META, cwd: root });
      expect(b?.hook_event).toBe("PostToolUse");
      expect(b?.tool_name).toBe("Write");
      expect(b?.mutation_path).toBe(
        realpathSync(join(root, "real", "file.ts")),
      );
      expect(JSON.parse(String(b?.data))).toMatchObject({
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: {
          path: "alias/file.ts",
          file_path: "alias/file.ts",
        },
        tool_response: { stdout: "Wrote alias/file.ts" },
        is_error: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mutation inputs mirror Pi tilde, file URL, at-prefix, and Unicode-space resolution", () => {
    expect(resolvePiMutationInputPath("~/owned.ts", "/repo")).toBe(
      join(homedir(), "owned.ts"),
    );
    expect(
      resolvePiMutationInputPath(
        pathToFileURL("/repo/file url.ts").href,
        "/ignored",
      ),
    ).toBe("/repo/file url.ts");
    expect(resolvePiMutationInputPath("@src/owned.ts", "/repo")).toBe(
      "/repo/src/owned.ts",
    );
    expect(resolvePiMutationInputPath("unicode\u202fspace.ts", "/repo")).toBe(
      "/repo/unicode space.ts",
    );
  });

  test("native Pi mutation attribution follows a stable leaf symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-pi-leaf-link-"));
    try {
      writeFileSync(join(root, "target.ts"), "target\n");
      symlinkSync("target.ts", join(root, "leaf.ts"));
      const event = preparePiMutationEvent(
        {
          type: "tool_result",
          toolName: "edit",
          input: { path: "leaf.ts", edits: [] },
          isError: false,
        },
        root,
      );
      expect(event.mutationPath).toBe(realpathSync(join(root, "target.ts")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing Pi result status is failure, never positive attribution", () => {
    const event = preparePiMutationEvent(
      {
        type: "tool_result",
        toolName: "write",
        input: { path: "unknown.ts" },
      },
      "/repo",
    );
    expect(event.mutationPath).toBeUndefined();
    const bindings = piEventBindings(event, META);
    expect(bindings?.hook_event).toBe("PostToolUseFailure");
    expect(bindings?.mutation_path).toBeUndefined();
  });

  test("Pi mutation canonicalization refuses an unavailable filesystem root", () => {
    const unavailable = (): never => {
      throw new Error("unavailable");
    };
    const fs = {
      lstat: unavailable as typeof import("node:fs").lstatSync,
      stat: unavailable as typeof import("node:fs").statSync,
      realpath: unavailable as unknown as typeof import("node:fs").realpathSync,
    };
    expect(canonicalPiMutationPath("file.ts", "/repo", fs)).toBeNull();
    const event = preparePiMutationEvent(
      {
        type: "tool_result",
        toolName: "write",
        input: { path: "file.ts" },
        isError: false,
      },
      "/repo",
      fs,
    );
    expect(piEventBindings(event, META)?.mutation_path).toBeNull();
  });

  test("session_shutdown[quit] folds to a clean SessionEnd", () => {
    const b = piEventBindings(
      { type: "session_shutdown", reason: "quit" },
      META,
    );
    expect(b?.hook_event).toBe("SessionEnd");
    expect(b?.event_type).toBe("session_end");
  });

  test("no SessionStart is emitted — the birth record owns pi presence", () => {
    // session_start is not in the observed set; even if fired it is unmapped.
    expect(
      piEventBindings({ type: "session_start", reason: "startup" }, META),
    ).toBeNull();
  });

  test("a mid-process session_shutdown (non-quit) does not end the row", () => {
    for (const reason of ["reload", "new", "resume", "fork"]) {
      expect(
        piEventBindings({ type: "session_shutdown", reason }, META),
      ).toBeNull();
    }
  });

  test("unknown / unmapped event kinds are a no-op, never an error", () => {
    for (const type of ["message_end", "turn_start", "context", "bogus"]) {
      expect(piEventBindings({ type }, META)).toBeNull();
      expect(translatePiEvent({ type }, META)).toBeNull();
    }
  });

  test("a tool event with no toolName degrades tool_name to null", () => {
    const b = piEventBindings({ type: "tool_call" }, META);
    expect(b?.tool_name).toBeNull();
  });
});

describe("pi extension — NDJSON line contract", () => {
  test("translatePiEvent emits exactly the birth-line-shaped NDJSON record", () => {
    const line = translatePiEvent({ type: "agent_start" }, META);
    expect(line).toBe(
      `{"bindings":{"ts":1700000000,"session_id":"job-1111-2222","pid":4242,` +
        `"hook_event":"UserPromptSubmit","event_type":"user_prompt_submit",` +
        `"cwd":"/work/repo","data":"{\\"hook_event_name\\":\\"UserPromptSubmit\\"}"}}\n`,
    );
    // The daemon's ingester must parse our line back into the same bindings.
    const parsed = parseEventLogLine((line as string).trim());
    expect(parsed?.bindings.hook_event).toBe("UserPromptSubmit");
    expect(parsed?.bindings.session_id).toBe("job-1111-2222");
  });

  test("serializePiLine wraps the bindings in the {bindings} record shape", () => {
    // Mirrors serializeEventLogRecord in src/dead-letter.ts — the daemon reads
    // exactly `{ bindings }`, newline-terminated.
    const line = serializePiLine({ session_id: "j", ts: 1, pid: 2 });
    expect(line).toBe('{"bindings":{"session_id":"j","ts":1,"pid":2}}\n');
    expect(translatePiEvent({ type: "agent_end" }, META)).toBe(
      serializePiLine(
        piEventBindings({ type: "agent_end" }, META) as PiEventBindings,
      ),
    );
  });

  test("every emitted line round-trips through the daemon's parseEventLogLine", () => {
    const events: PiObservedEvent[] = [
      { type: "agent_start" },
      { type: "agent_end" },
      { type: "tool_call", toolName: "read", input: { path: "/x" } },
      { type: "tool_result", toolName: "read", isError: false },
      { type: "session_shutdown", reason: "quit" },
    ];
    for (const e of events) {
      const line = translatePiEvent(e, META);
      expect(line).not.toBeNull();
      const parsed = parseEventLogLine((line as string).trim());
      expect(parsed).not.toBeNull();
      expect(parsed?.bindings.session_id).toBe("job-1111-2222");
      expect(parsed?.bindings.pid).toBe(4242);
    }
  });

  test("hostile payload content round-trips as data in a valid NDJSON line", () => {
    const hostile = {
      command: 'echo "pwned"; rm -rf /\n$(whoami)\t`id`',
      note: 'quotes " and \\ backslashes and \n newlines',
    };
    const line = translatePiEvent(
      { type: "tool_call", toolName: "bash", input: hostile },
      META,
    );
    // Exactly one line (the hostile newlines did not tear the record).
    expect((line as string).endsWith("\n")).toBe(true);
    expect((line as string).slice(0, -1).includes("\n")).toBe(false);
    const parsed = parseEventLogLine((line as string).trim());
    expect(parsed).not.toBeNull();
    // The hostile content survives verbatim inside `data` as pure data.
    expect(JSON.parse(parsed?.bindings.data as string).tool_input).toEqual(
      hostile,
    );
  });

  test("an oversized tool payload bounds to a valid-JSON truncated envelope", () => {
    const huge = { blob: "x".repeat(64_000) };
    const b = piEventBindings(
      { type: "tool_call", toolName: "write", input: huge },
      META,
    );
    const data = JSON.parse(b?.data as string);
    expect(data).toEqual({ hook_event_name: "PreToolUse", truncated: true });
  });
});

describe("pi extension — history tool argv", () => {
  test("list and search route through the cross-harness history surface", () => {
    expect(
      historyCliArgs({
        operation: "list",
        harness: "pi",
        offset: 20,
        limit: 10,
      }),
    ).toEqual([
      "history",
      "list",
      "--harness",
      "pi",
      "--offset",
      "20",
      "--limit",
      "10",
    ]);
    expect(
      historyCliArgs({
        operation: "search",
        query: "needle phrase",
        session: "Historical title",
        limit: 5,
      }),
    ).toEqual([
      "history",
      "search",
      "--session",
      "Historical title",
      "--limit",
      "5",
      "--",
      "needle phrase",
    ]);
  });

  test("show/page keep Session references argv-safe, including flag-shaped titles", () => {
    expect(
      historyCliArgs({
        operation: "page",
        session: "--project",
        project: "/work/repo",
        before: 40,
        max_chars: 12000,
        grep: "failure",
      }),
    ).toEqual([
      "history",
      "show",
      "--project",
      "/work/repo",
      "--before",
      "40",
      "--max-chars",
      "12000",
      "--grep",
      "failure",
      "--",
      "--project",
    ]);
  });

  test("specialist transcript parameters require an explicit low-level operation", () => {
    expect(
      historyCliArgs({
        operation: "transcript_show",
        harness: "claude",
        session: "Session title",
        subagent: "abc123",
        tools: "full",
        include_meta: true,
      }),
    ).toEqual([
      "transcript",
      "claude",
      "show",
      "--subagent",
      "abc123",
      "--tools",
      "full",
      "--meta",
      "--",
      "Session title",
    ]);
    expect(
      historyParamError({ operation: "show", session: "s", subagent: "x" }),
    ).toContain("transcript_show");
  });
});

describe("pi extension — history param clamping", () => {
  test("list/search/show limits use operation-specific caps", () => {
    expect(
      clampHistoryParams({ operation: "list", limit: 999 }).params.limit,
    ).toBe(100);
    expect(
      clampHistoryParams({ operation: "search", query: "q", limit: 999 }).params
        .limit,
    ).toBe(200);
    const { params, clamps } = clampHistoryParams({
      operation: "show",
      session: "s",
      limit: 5000,
    });
    expect(params.limit).toBe(500);
    expect(clamps).toEqual([{ param: "limit", requested: 5000, applied: 500 }]);
  });

  test("max_chars clamps to 60000 for show/page", () => {
    const { params, clamps } = clampHistoryParams({
      operation: "page",
      session: "s",
      before: 4,
      max_chars: 999_999,
    });
    expect(params.max_chars).toBe(60_000);
    expect(clamps).toEqual([
      { param: "max_chars", requested: 999_999, applied: 60_000 },
    ]);
  });

  test("in-bounds values are untouched and argv carries applied clamps", () => {
    const inBounds = clampHistoryParams({
      operation: "show",
      session: "s",
      limit: 50,
      max_chars: 12_000,
    });
    expect(inBounds.params.limit).toBe(50);
    expect(inBounds.clamps).toEqual([]);
    expect(historyCliArgs({ operation: "list", limit: 999 })).toEqual([
      "history",
      "list",
      "--limit",
      "100",
    ]);
    expect(
      historyCliArgs({
        operation: "show",
        session: "s",
        max_chars: 999_999,
      }),
    ).toContain("60000");
  });
});

describe("pi extension — history validation before spawn", () => {
  test("Session titles may contain spaces/shell text because execFile + -- keep argv inert", () => {
    expect(
      historyParamError({
        operation: "show",
        session: "; rm -rf / $(whoami)",
      }),
    ).toBeNull();
    expect(
      historyCliArgs({ operation: "show", session: "--project" }).at(-1),
    ).toBe("--project");
  });

  test("oversized/NUL references and malformed specialist ids are rejected", () => {
    expect(
      historyParamError({ operation: "show", session: "a".repeat(4097) }),
    ).not.toBeNull();
    expect(
      historyParamError({ operation: "show", session: "bad\0title" }),
    ).not.toBeNull();
    expect(
      historyParamError({
        operation: "transcript_show",
        harness: "claude",
        session: "s",
        subagent: "--all",
      }),
    ).not.toBeNull();
  });

  test("paging and size parameters require integers", () => {
    expect(historyParamError({ operation: "list", offset: 1.5 })).toContain(
      "non-negative integer",
    );
    expect(historyParamError({ operation: "list", limit: 0.5 })).toContain(
      "positive integer",
    );
    expect(
      historyParamError({ operation: "show", session: "s", max_chars: 2.5 }),
    ).toContain("positive integer");
  });

  test("required operation fields and supported low-level harnesses are enforced", () => {
    expect(historyParamError({ operation: "show" })).toContain("session");
    expect(historyParamError({ operation: "search" })).toContain("query");
    expect(
      historyParamError({
        operation: "transcript_show",
        harness: "codex",
        session: "s",
      }),
    ).toContain("claude or pi");
    expect(
      historyParamError({
        operation: "transcript_turn",
        harness: "claude",
        session: "s",
        leaf: "root",
      }),
    ).toContain("pi-only");
    expect(historyParamError({})).toBeNull();
  });
});

describe("pi extension — history tool result shaping and cancellation", () => {
  test("a maxBuffer overflow returns bounded partial content, not a failure", () => {
    const r = historyToolResult(
      {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        message: "stdout maxBuffer length exceeded",
      },
      "partial history body",
      "",
      ["history", "show", "s"],
      [],
    );
    expect(r.content[0].text).toContain("partial history body");
    expect(r.content[0].text).toContain("history output truncated");
    expect(r.content[0].text).not.toContain("keeper history failed");
    expect(r.details.truncated).toBe(true);
  });

  test("failure/success preserve CLI messages and applied clamps", () => {
    const failed = historyToolResult(
      { code: 1, message: "boom" },
      "",
      "no such session",
      ["history", "show", "s"],
      [],
    );
    expect(failed.content[0].text).toBe(
      "keeper history failed: no such session",
    );
    const ok = historyToolResult(
      null,
      "the history",
      "",
      ["history", "list", "--limit", "100"],
      [{ param: "limit", requested: 999, applied: 100 }],
    );
    expect(ok.content[0].text).toBe("the history");
    expect(ok.details.clamps).toEqual([
      { param: "limit", requested: 999, applied: 100 },
    ]);
    expect(
      historyToolResult(null, "", "", ["history", "list"], []).content[0].text,
    ).toBe("(no history output)");
  });

  test("passes AbortSignal to execFile and reports callback cancellation", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const run: HistoryExecFile = (_file, _args, options, callback) => {
      received = options.signal;
      callback({ code: "ABORT_ERR", message: "aborted" }, "", "");
    };
    const result = await executeHistoryTool(
      { operation: "list" },
      controller.signal,
      run,
    );
    expect(received).toBe(controller.signal);
    expect(result.details.cancelled).toBe(true);
    expect(result.content[0].text).toContain("cancelled");
  });

  test("an already-aborted call spawns nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const run: HistoryExecFile = () => {
      spawned = true;
    };
    const result = await executeHistoryTool(
      { operation: "list" },
      controller.signal,
      run,
    );
    expect(spawned).toBe(false);
    expect(result.details.cancelled).toBe(true);
  });
});

describe("pi extension — factory arming + fail-open", () => {
  const saved: Record<string, string | undefined> = {};
  let logDir: string;
  let deadLetterDir: string;

  function keeperEvents(
    pi: PiExtensionApi,
    paths = { eventsLogDir: logDir, deadLetterDir },
    runtimeOptions: PiExtensionRuntimeOptions = {},
  ): void {
    keeperEventsExtension(pi, paths, runtimeOptions);
  }

  function fakePi(
    options: { sendMessage?: PiExtensionApi["sendMessage"] } = {},
  ) {
    const handlers = new Map<
      string,
      Array<(e: unknown, context?: PiSessionContext) => unknown>
    >();
    const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
    const tools = new Map<string, unknown>();
    const sendCalls: Array<{ message: unknown; options: unknown }> = [];
    // Cast once, same reasoning as `fakeRenamePi`'s `on`: this fake's single
    // handler storage backs EVERY `PiExtensionApi.on` overload (lifecycle,
    // `input`, `resources_discover`) — a plain function EXPRESSION assertion
    // is exact where structural inference against the overloaded target
    // (checked contravariantly, not bivariantly, for a property of this
    // shape) is not.
    const on = ((
      kind: string,
      h: (e: unknown, context?: PiSessionContext) => unknown,
    ) => {
      const list = handlers.get(kind) ?? [];
      list.push(h);
      handlers.set(kind, list);
    }) as PiExtensionApi["on"];
    return {
      handlers,
      tools,
      sendCalls,
      events: {
        on(event: string, handler: (data: unknown) => void) {
          const set = eventHandlers.get(event) ?? new Set();
          set.add(handler);
          eventHandlers.set(event, set);
          return () => set.delete(handler);
        },
        emit(event: string, data: unknown) {
          for (const handler of [...(eventHandlers.get(event) ?? [])]) {
            handler(data);
          }
        },
      },
      on,
      /** Returns the LAST registered handler's result (only one handler is
       *  ever registered per kind in production wiring). */
      fire(kind: string, e: unknown, context?: PiSessionContext): unknown {
        let result: unknown;
        for (const h of handlers.get(kind) ?? []) {
          result = h(e, context);
        }
        return result;
      },
      async fireAsync(
        kind: string,
        e: unknown,
        context?: PiSessionContext,
      ): Promise<unknown> {
        let result: unknown;
        for (const h of handlers.get(kind) ?? []) {
          result = await h(e, context);
        }
        return result;
      },
      registerTool(tool: unknown) {
        const name = (tool as { name?: unknown }).name;
        if (typeof name === "string") tools.set(name, tool);
      },
      ...(options.sendMessage === undefined
        ? {}
        : {
            sendMessage(message: unknown, sendOptions: unknown) {
              sendCalls.push({ message, options: sendOptions });
              options.sendMessage?.(
                message as Parameters<
                  NonNullable<PiExtensionApi["sendMessage"]>
                >[0],
                sendOptions as Parameters<
                  NonNullable<PiExtensionApi["sendMessage"]>
                >[1],
              );
            },
          }),
    };
  }

  beforeEach(() => {
    saved.KEEPER_JOB_ID = process.env.KEEPER_JOB_ID;
    saved.KEEPER_DISPATCH_ATTEMPT_ID = process.env.KEEPER_DISPATCH_ATTEMPT_ID;
    logDir = mkdtempSync(join(tmpdir(), "pi-ext-"));
    deadLetterDir = join(logDir, "dead-letters");
    delete process.env.KEEPER_JOB_ID;
    delete process.env.KEEPER_DISPATCH_ATTEMPT_ID;
  });

  afterEach(() => {
    for (const k of ["KEEPER_JOB_ID", "KEEPER_DISPATCH_ATTEMPT_ID"]) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
    rmSync(logDir, { recursive: true, force: true });
  });

  test("no KEEPER_JOB_ID → registers nothing and writes nothing", () => {
    const pi = fakePi();
    keeperEvents(pi);
    expect(pi.handlers.size).toBe(0);
    expect(pi.tools.size).toBe(0);
    pi.fire("agent_start", { type: "agent_start" }); // no handlers — no throw
    expect(existsSync(join(logDir, `${process.pid}.ndjson`))).toBe(false);
  });

  test("with KEEPER_JOB_ID → registers lifecycle, bus observers, and Monitor", () => {
    process.env.KEEPER_JOB_ID = "job-abc";
    const pi = fakePi({ sendMessage() {} });
    keeperEvents(pi);
    expect([...pi.handlers.keys()].sort()).toEqual([
      "agent_end",
      "agent_start",
      "input",
      "model_select",
      "resources_discover",
      "session_shutdown",
      "session_start",
      "thinking_level_select",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
    expect([...pi.tools.keys()]).toEqual([
      "keeper_history",
      "keeper_commit_work",
      "Task",
      "Monitor",
    ]);
    const history = pi.tools.get("keeper_history") as {
      description: string;
      promptGuidelines: string[];
    };
    expect(history.description).toContain("Claude/Pi Session history");
    expect(history.description).not.toContain("Claude Code sessions");
    expect(history.promptGuidelines.join(" ")).toContain("cross-harness");
  });

  test("missing or throwing Monitor APIs fail open without suppressing other registrations", () => {
    process.env.KEEPER_JOB_ID = "job-live";

    const missing = fakePi();
    expect(() => keeperEvents(missing)).not.toThrow();
    expect([...missing.tools.keys()]).toEqual([
      "keeper_history",
      "keeper_commit_work",
      "Task",
    ]);
    expect(missing.handlers.has("agent_end")).toBe(true);

    const missingRegistration = fakePi({ sendMessage() {} });
    Object.assign(missingRegistration, { registerTool: undefined });
    expect(() => keeperEvents(missingRegistration)).not.toThrow();
    expect(missingRegistration.tools.size).toBe(0);
    expect(missingRegistration.handlers.has("session_shutdown")).toBe(true);

    const staleDelivery = fakePi({
      sendMessage() {
        throw new Error("stale extension");
      },
    });
    expect(() => keeperEvents(staleDelivery)).not.toThrow();
    expect([...staleDelivery.tools.keys()]).toEqual([
      "keeper_history",
      "keeper_commit_work",
      "Task",
      "Monitor",
    ]);

    const rejectingMonitor = fakePi({ sendMessage() {} });
    const register = rejectingMonitor.registerTool.bind(rejectingMonitor);
    rejectingMonitor.registerTool = (tool: unknown) => {
      if ((tool as { name?: unknown }).name === "Monitor") {
        throw new Error("Monitor unavailable");
      }
      register(tool);
    };
    expect(() => keeperEvents(rejectingMonitor)).not.toThrow();
    expect([...rejectingMonitor.tools.keys()]).toEqual([
      "keeper_history",
      "keeper_commit_work",
      "Task",
    ]);
    expect(rejectingMonitor.handlers.has("session_shutdown")).toBe(true);
  });

  test("Monitor notifications, provenance, and Stop snapshot share one task id", async () => {
    process.env.KEEPER_JOB_ID = "job-monitor";
    const child = new ExtensionMonitorChild();
    const artifact = new ExtensionMonitorArtifact(
      "/private/monitor-stable.log",
    );
    let busLive = false;
    const busInbox = {
      start() {
        busLive = true;
      },
      ambientTask() {
        return busLive
          ? {
              id: "pi-bus-9001",
              type: "shell" as const,
              command: "keeper bus watch --json --lifetime-stdin",
              description: "keeper agent bus",
            }
          : null;
      },
      async stop() {
        busLive = false;
      },
    };
    const pi = fakePi({ sendMessage() {} });
    keeperEvents(
      pi,
      { eventsLogDir: logDir, deadLetterDir },
      {
        busInbox,
        monitor: {
          spawn: () => child,
          allocateTaskId: () => "monitor-stable",
          createArtifact: () => artifact,
          killTree: (monitorChild, signal) => monitorChild.kill?.(signal),
          batchWindowMs: 0,
        },
      },
    );

    try {
      pi.fire("session_start", { type: "session_start" });
      const monitor = pi.tools.get("Monitor") as {
        execute(
          id: string,
          params: {
            command: string;
            description: string;
            persistent: boolean;
          },
        ): Promise<{
          details: { taskId: string };
        }>;
      };
      const result = await monitor.execute("call-monitor", {
        command: "printf 'ready\\n'",
        description: "readiness probe",
        persistent: true,
      });
      expect(result.details.taskId).toBe("monitor-stable");

      child.stdout.emit("data", Buffer.from("ready\n"));
      const batchCall = await retryUntil(() =>
        pi.sendCalls.find(
          ({ message }) =>
            (message as { customType?: unknown }).customType ===
            "keeper-monitor-batch",
        ),
      );
      if (batchCall === null) throw new Error("missing Monitor batch delivery");
      expect(batchCall.options).toEqual({
        deliverAs: "steer",
        triggerTurn: true,
      });
      expect((batchCall.message as { content: string }).content).toContain(
        "monitor-stable",
      );
      expect((batchCall.message as { content: string }).content).toMatch(
        /automated.*not a user message/i,
      );

      pi.fire("tool_result", {
        type: "tool_result",
        toolName: "Monitor",
        isError: false,
        content: [{ type: "text", text: "Monitor started: monitor-stable" }],
        details: { taskId: result.details.taskId },
      });
      pi.fire("agent_end", { type: "agent_end" });

      const records = readFileSync(
        join(logDir, `${process.pid}.ndjson`),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => parseEventLogLine(line)?.bindings);
      const launch = records.find(
        (bindings) => bindings?.hook_event === "PostToolUse",
      );
      expect(JSON.parse(String(launch?.data)).tool_response.taskId).toBe(
        result.details.taskId,
      );
      const stop = records.find((bindings) => bindings?.hook_event === "Stop");
      expect(JSON.parse(String(stop?.data)).background_tasks).toEqual([
        {
          id: "monitor-stable",
          type: "shell",
          kind: "monitor",
          command: "printf 'ready\\n'",
          description: "readiness probe",
        },
        {
          id: "pi-bus-9001",
          type: "shell",
          command: "keeper bus watch --json --lifetime-stdin",
          description: "keeper agent bus",
          kind: "ambient",
        },
      ]);

      child.close(0);
      const terminalCall = await retryUntil(() =>
        pi.sendCalls.find(
          ({ message }) =>
            (message as { customType?: unknown }).customType ===
            "keeper-monitor-terminal",
        ),
      );
      if (terminalCall === null) {
        throw new Error("missing Monitor terminal delivery");
      }
      expect(terminalCall.options).toEqual({
        deliverAs: "steer",
        triggerTurn: true,
      });
      const terminalText = (terminalCall.message as { content: string })
        .content;
      expect(terminalText).toContain("monitor-stable");
      expect(terminalText).toContain("status: exited");
      expect(terminalText).toContain("exit code: 0");
      expect(terminalText).toContain("/private/monitor-stable.log");
      expect(terminalText).toMatch(/automated.*not a user message/i);
    } finally {
      await pi.fireAsync("session_shutdown", {
        type: "session_shutdown",
        reason: "new",
      });
      expect(busLive).toBe(false);
    }
  });

  test("session shutdown fences late Monitor delivery and stops every live task", async () => {
    process.env.KEEPER_JOB_ID = "job-monitor-shutdown";
    const child = new ExtensionMonitorChild();
    const pi = fakePi({ sendMessage() {} });
    keeperEvents(
      pi,
      { eventsLogDir: logDir, deadLetterDir },
      {
        monitor: {
          spawn: () => child,
          allocateTaskId: () => "monitor-shutdown",
          createArtifact: () =>
            new ExtensionMonitorArtifact("/private/monitor-shutdown.log"),
          killTree: (monitorChild, signal) => monitorChild.kill?.(signal),
        },
      },
    );
    const monitor = pi.tools.get("Monitor") as {
      execute(
        id: string,
        params: {
          command: string;
          description: string;
          persistent: boolean;
        },
      ): Promise<unknown>;
    };
    await monitor.execute("call-shutdown", {
      command: "watch",
      description: "shutdown probe",
      persistent: true,
    });
    const deliveriesBeforeShutdown = pi.sendCalls.length;

    await pi.fireAsync("session_shutdown", {
      type: "session_shutdown",
      reason: "resume",
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(pi.sendCalls).toHaveLength(deliveriesBeforeShutdown);

    child.stdout.emit("data", Buffer.from("late\n"));
    child.emit("close", 0, null);
    await Promise.resolve();
    expect(pi.sendCalls).toHaveLength(deliveriesBeforeShutdown);
  });

  test("session start installs the skill shorthand autocomplete provider without a command snapshot", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    const pi = fakePi();
    let installed = false;
    keeperEvents(pi);
    pi.fire(
      "session_start",
      { type: "session_start" },
      {
        cwd: "/work/repo",
        ui: {
          addAutocompleteProvider() {
            installed = true;
          },
        },
      },
    );
    expect(installed).toBe(true);
  });

  test("repeated session startup re-installs the autocomplete provider each time", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    const pi = fakePi();
    keeperEvents(pi);
    let installCount = 0;
    const ctx = {
      cwd: "/work/repo",
      ui: {
        addAutocompleteProvider() {
          installCount += 1;
        },
      },
    };
    pi.fire("session_start", { type: "session_start" }, ctx);
    pi.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
    expect(installCount).toBe(2);
  });

  test("an autocomplete registration failure never escapes session start and never suppresses input/resources_discover", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    const uiFailure = fakePi();
    keeperEvents(uiFailure);
    // input/resources_discover register at factory time, before any
    // session_start fires — a later autocomplete throw cannot retract them.
    expect(uiFailure.handlers.has("input")).toBe(true);
    expect(uiFailure.handlers.has("resources_discover")).toBe(true);
    expect(() =>
      uiFailure.fire(
        "session_start",
        { type: "session_start" },
        {
          cwd: "/work/repo",
          ui: {
            addAutocompleteProvider() {
              throw new Error("autocomplete UI failed");
            },
          },
        },
      ),
    ).not.toThrow();
    expect(
      uiFailure.fire("input", { type: "input", text: "/hack ship it" }),
    ).toEqual({ action: "transform", text: "/skill:hack ship it" });
  });

  test("input rewrites exact aliases to native skill commands and passes through everything else", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    const pi = fakePi();
    keeperEvents(pi);
    expect(pi.fire("input", { type: "input", text: "/hack ship it" })).toEqual({
      action: "transform",
      text: "/skill:hack ship it",
    });
    expect(pi.fire("input", { type: "input", text: "/plan" })).toEqual({
      action: "transform",
      text: "/skill:plan",
    });
    expect(
      pi.fire("input", { type: "input", text: "/skill:hack do it" }),
    ).toBeUndefined();
    expect(
      pi.fire("input", { type: "input", text: "/hacker" }),
    ).toBeUndefined();
    expect(
      pi.fire("input", { type: "input", text: "ordinary prompt" }),
    ).toBeUndefined();
  });

  test("resources_discover contributes exactly the canonical Hack and Plan skill directories, independent of cwd", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    const pi = fakePi();
    keeperEvents(pi);
    const result = pi.fire("resources_discover", {
      type: "resources_discover",
      cwd: "/some/other/launch/cwd",
      reason: "startup",
    }) as { skillPaths?: string[] } | undefined;
    expect(result?.skillPaths).toHaveLength(2);
    const paths = result?.skillPaths ?? [];
    expect(paths.every((path) => existsSync(path))).toBe(true);
    expect(paths.every((path) => !path.includes("arthack"))).toBe(true);
    expect(
      paths.some((path) => path.endsWith(join("plan", "skills", "hack"))),
    ).toBe(true);
    expect(
      paths.some((path) => path.endsWith(join("plan", "skills", "plan"))),
    ).toBe(true);
  });

  test("a fired event appends the translated line to the per-pid file", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    const pi = fakePi();
    keeperEvents(pi);
    pi.fire("agent_start", { type: "agent_start" });
    const body = readFileSync(join(logDir, `${process.pid}.ndjson`), "utf8");
    const parsed = parseEventLogLine(body.trim());
    expect(parsed?.bindings.session_id).toBe("job-live");
    expect(parsed?.bindings.hook_event).toBe("UserPromptSubmit");
    expect(parsed?.bindings.pid).toBe(process.pid);
  });

  test("a successful native Pi write emits an immediately readable mutation receipt", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    const repo = join(logDir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "owned.ts"), "owned\n");
    const pi = fakePi();
    keeperEvents(pi);
    pi.fire(
      "tool_result",
      {
        type: "tool_result",
        toolName: "write",
        input: { path: "owned.ts", content: "owned" },
        isError: false,
      },
      { cwd: repo } as PiSessionContext,
    );
    const body = readFileSync(join(logDir, `${process.pid}.ndjson`), "utf8");
    const parsed = parseEventLogLine(body.trim());
    expect(parsed?.bindings).toMatchObject({
      session_id: "job-live",
      hook_event: "PostToolUse",
      tool_name: "Write",
      cwd: repo,
      mutation_path: realpathSync(join(repo, "owned.ts")),
    });
  });

  test("malformed attempt metadata stays fail-open and unfenced", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    process.env.KEEPER_DISPATCH_ATTEMPT_ID = "not-an-attempt";
    const pi = fakePi();
    expect(() => keeperEvents(pi)).not.toThrow();
    pi.fire("agent_start", { type: "agent_start" });
    const body = readFileSync(join(logDir, `${process.pid}.ndjson`), "utf8");
    const parsed = parseEventLogLine(body.trim());
    expect(
      JSON.parse(parsed?.bindings.data as string).dispatch_attempt_id,
    ).toBeUndefined();
  });

  test("an unmapped fired event writes no line", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    const pi = fakePi();
    keeperEvents(pi);
    pi.fire("session_shutdown", { type: "session_shutdown", reason: "reload" });
    expect(existsSync(join(logDir, `${process.pid}.ndjson`))).toBe(false);
  });

  test("a failed receipt append dead-letters exact Pi mutation evidence", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    const repo = join(logDir, "dead-letter-repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "owned.ts"), "owned\n");
    // Point the events-log dir UNDER an existing file so mkdir/append throw.
    const blocker = join(logDir, "blocker");
    writeFileSync(blocker, "not a dir");
    const pi = fakePi();
    keeperEvents(pi, {
      eventsLogDir: join(blocker, "nested"),
      deadLetterDir,
    });
    expect(() =>
      pi.fire(
        "tool_result",
        {
          type: "tool_result",
          toolName: "edit",
          input: { path: "owned.ts", edits: [] },
          isError: false,
        },
        { cwd: repo } as PiSessionContext,
      ),
    ).not.toThrow();
    const body = readFileSync(
      join(deadLetterDir, `${process.pid}.ndjson`),
      "utf8",
    );
    expect(parseDeadLetterLine(body.trim())).toMatchObject({
      session_id: "job-live",
      hook_event: "PostToolUse",
      pid: process.pid,
      bindings: {
        tool_name: "Edit",
        mutation_path: realpathSync(join(repo, "owned.ts")),
      },
    });
  });

  test("bus delivery uses steer + idle wake and swallows a stale Pi API", () => {
    const calls: unknown[] = [];
    sendPiBusMessage(
      {
        on() {},
        sendMessage(message, options) {
          calls.push({ message, options });
        },
      },
      "Agent Bus message from alice: ship it",
    );
    expect(calls).toEqual([
      {
        message: {
          customType: "keeper-agent-bus",
          content: "Agent Bus message from alice: ship it",
          display: true,
        },
        options: { deliverAs: "steer", triggerTurn: true },
      },
    ]);
    expect(() =>
      sendPiBusMessage(
        {
          on() {},
          sendMessage() {
            throw new Error("stale extension");
          },
        },
        "late",
      ),
    ).not.toThrow();
  });

  test("the factory never throws even when pi.on itself throws", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    const throwingPi = {
      on() {
        throw new Error("pi.on blew up");
      },
    };
    // A load-time throw would ABORT pi's launch — the top-level guard forbids it.
    expect(() => keeperEvents(throwingPi)).not.toThrow();
  });
});

describe("pi extension — launcher arming", () => {
  test("piExtensionArgs emits -e <path> when the extension file exists", () => {
    expect(piExtensionArgs(() => true)).toEqual(["-e", piExtensionPath()]);
  });

  test("piExtensionArgs fails open to [] when the extension file is absent", () => {
    expect(piExtensionArgs(() => false)).toEqual([]);
  });

  test("the real extension file ships at the resolved path", () => {
    expect(existsSync(piExtensionPath())).toBe(true);
    // Default existence check (production) therefore arms the flag.
    expect(piExtensionArgs()).toEqual(["-e", piExtensionPath()]);
  });

  test("authority stores ignore caller-controlled path and HOME overrides", () => {
    const baseline = defaultPiEventStorePaths();
    const savedHome = process.env.HOME;
    const savedEvents = process.env.KEEPER_EVENTS_LOG;
    const savedDeadLetters = process.env.KEEPER_DEAD_LETTER_DIR;
    try {
      process.env.HOME = "/tmp/spoof-home";
      process.env.KEEPER_EVENTS_LOG = "/tmp/spoof-events";
      process.env.KEEPER_DEAD_LETTER_DIR = "/tmp/spoof-dead";
      expect(defaultPiEventStorePaths()).toEqual(baseline);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedEvents === undefined) delete process.env.KEEPER_EVENTS_LOG;
      else process.env.KEEPER_EVENTS_LOG = savedEvents;
      if (savedDeadLetters === undefined)
        delete process.env.KEEPER_DEAD_LETTER_DIR;
      else process.env.KEEPER_DEAD_LETTER_DIR = savedDeadLetters;
    }
    expect(baseline.eventsLogDir).toContain(
      join(".local", "state", "keeper", "events-log"),
    );
    expect(baseline.deadLetterDir).toContain(
      join(".local", "state", "keeper", "dead-letters"),
    );
  });
});

describe("titleEventBindings", () => {
  test("produces a lifecycle-neutral TranscriptTitle binding", () => {
    const b = titleEventBindings("new-title", META);
    expect(b).toEqual({
      ts: META.tsSec,
      session_id: META.jobId,
      pid: META.pid,
      hook_event: "TranscriptTitle",
      event_type: "transcript_title",
      cwd: META.cwd,
      data: '{"session_title":"new-title"}',
    });
  });

  test("hook_event is distinct from every lifecycle-driving pi translation", () => {
    const lifecycleHookEvents = [
      piEventBindings({ type: "agent_start" }, META)?.hook_event,
      piEventBindings({ type: "agent_end" }, META)?.hook_event,
      piEventBindings({ type: "tool_call" }, META)?.hook_event,
      piEventBindings({ type: "tool_result" }, META)?.hook_event,
      piEventBindings({ type: "session_shutdown", reason: "quit" }, META)
        ?.hook_event,
    ];
    expect(lifecycleHookEvents).not.toContain("TranscriptTitle");
  });
});

describe("/rename — fixed model", () => {
  test("resolves only the one fixed cheap model, never a fallback", () => {
    expect(RENAME_MODEL_PROVIDER).toBe("openai-codex");
    expect(RENAME_MODEL_ID).toBe("gpt-5.3-codex-spark");
  });
});

describe("/rename — stripUnsafeText", () => {
  test("replaces ASCII control characters with a space", () => {
    expect(stripUnsafeText("abcd")).toBe("a b c d");
  });

  test("drops Unicode bidi formatting/override characters entirely", () => {
    expect(stripUnsafeText("a\u200bb\u202ec\u2066d")).toBe("abcd");
  });

  test("leaves ordinary text untouched", () => {
    expect(stripUnsafeText("Add Dark Mode")).toBe("Add Dark Mode");
  });
});

describe("/rename — renameSlugify drift corpus against src/slug.ts", () => {
  test("matches the canonical slugify byte-for-byte across a representative corpus", () => {
    const corpus = [
      "Hello, World!",
      "Café résumé",
      "  leading and trailing  ",
      "ALL CAPS TITLE",
      "under_score-mix.dots",
      "日本語のタイトル",
      "🚀 emoji only 🚀",
      "...",
      "---",
      "a".repeat(100),
      "MixedCASE 123 -- stuff",
      "",
      "control\u0007char",
      "bidi\u202Eoverride",
      "Add Dark Mode",
    ];
    for (const input of corpus) {
      expect(renameSlugify(input)).toBe(canonicalSlugify(input));
    }
  });
});

describe("/rename — buildRenameInputText", () => {
  test("combines prompt and response when both are present", () => {
    expect(buildRenameInputText("do X", "did X", 1_000)).toBe(
      "User: do X\n\nAssistant: did X",
    );
  });

  test("omits the assistant section when response is null", () => {
    expect(buildRenameInputText("do X", null, 1_000)).toBe("User: do X");
  });

  test("removes expanded skill blocks before truncation", () => {
    const prompt = `<skill name="hack">${"x".repeat(1_000)}</skill>\n\nrename helper`;
    expect(buildRenameInputText(prompt, null, 40)).toBe(
      "User: \n\nrename helper",
    );
  });

  test("removes every complete skill block from model input", () => {
    expect(
      stripSkillBlocks(
        'before <skill name="one">first</skill> middle <skill name="two">second</skill> after',
      ),
    ).toBe("before  middle  after");
  });

  test("leaves incomplete skill markup unchanged", () => {
    expect(stripSkillBlocks('<skill name="hack">unfinished')).toBe(
      '<skill name="hack">unfinished',
    );
  });

  test("bounds the combined text to maxBytes UTF-8 bytes", () => {
    const prompt = "x".repeat(50);
    const response = "y".repeat(50);
    const bounded = buildRenameInputText(prompt, response, 20);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(20);
  });

  test("bounds multi-byte text without exceeding the byte cap", () => {
    const bounded = buildRenameInputText("😀".repeat(20), null, 10);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(10);
  });
});

describe("/rename — buildPiTurnArgv", () => {
  test("builds the keeper transcript pi turn argv", () => {
    expect(buildPiTurnArgv("sess-1", "root", "/work/repo")).toEqual([
      "transcript",
      "pi",
      "turn",
      "sess-1",
      "--leaf",
      "root",
      "--project",
      "/work/repo",
      "--strip-skills",
      "--format",
      "json",
    ]);
  });
});

function turnEnvelopeStdout(
  turn: unknown,
  ok = true,
  error: { code: string; message: string; recovery: string } = {
    code: "leaf_not_found",
    message: "not found",
    recovery: "retry",
  },
): string {
  return JSON.stringify(
    ok
      ? {
          schema_version: 1,
          ok: true,
          error: null,
          data: {
            harness: "pi",
            session_id: "s",
            selected_leaf: "root",
            turn,
          },
        }
      : { schema_version: 1, ok: false, error, data: null },
  );
}

describe("/rename — parseTurnCliOutput", () => {
  test("malformed stdout is an error, never confused with an empty turn", () => {
    const outcome = parseTurnCliOutput({ stdout: "not json", stderr: "" });
    expect(outcome.kind).toBe("error");
  });

  test("a failure envelope is an error carrying the CLI's message", () => {
    const outcome = parseTurnCliOutput({
      stdout: turnEnvelopeStdout(null, false, {
        code: "session_not_found",
        message: "session 's' not found",
        recovery: "list sessions",
      }),
      stderr: "",
    });
    expect(outcome).toEqual({
      kind: "error",
      message: "session 's' not found",
    });
  });

  test("turn: null is a valid empty turn", () => {
    const outcome = parseTurnCliOutput({
      stdout: turnEnvelopeStdout(null),
      stderr: "",
    });
    expect(outcome).toEqual({ kind: "empty" });
  });

  test("a prompt-only turn (no response yet) is usable", () => {
    const outcome = parseTurnCliOutput({
      stdout: turnEnvelopeStdout({
        prompt: "add dark mode",
        promptTruncated: false,
        response: null,
        responseTruncated: false,
      }),
      stderr: "",
    });
    expect(outcome).toEqual({
      kind: "usable",
      prompt: "add dark mode",
      response: null,
    });
  });

  test("a prompt-and-response turn is usable and carries both", () => {
    const outcome = parseTurnCliOutput({
      stdout: turnEnvelopeStdout({
        prompt: "add dark mode",
        promptTruncated: false,
        response: "done",
        responseTruncated: false,
      }),
      stderr: "",
    });
    expect(outcome).toEqual({
      kind: "usable",
      prompt: "add dark mode",
      response: "done",
    });
  });

  test("a malformed turn shape is an error", () => {
    const outcome = parseTurnCliOutput({
      stdout: turnEnvelopeStdout({ notAPrompt: true }),
      stderr: "",
    });
    expect(outcome.kind).toBe("error");
  });
});

describe("/rename — extractCompletionText", () => {
  test("a successful stop with text is usable", () => {
    expect(
      extractCompletionText({
        stopReason: "stop",
        content: [{ type: "text", text: "  Add Dark Mode  " }],
      }),
    ).toBe("Add Dark Mode");
  });

  for (const stopReason of ["length", "toolUse", "error", "aborted"] as const) {
    test(`stopReason ${stopReason} is never usable`, () => {
      expect(
        extractCompletionText({
          stopReason,
          content: [{ type: "text", text: "Add Dark Mode" }],
        }),
      ).toBeNull();
    });
  }

  test("a stop with no text content is unusable", () => {
    expect(
      extractCompletionText({
        stopReason: "stop",
        content: [{ type: "toolCall" }],
      }),
    ).toBeNull();
  });

  test("a stop with only whitespace text is unusable", () => {
    expect(
      extractCompletionText({
        stopReason: "stop",
        content: [{ type: "text", text: "   " }],
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runRenameInvocation orchestration
// ---------------------------------------------------------------------------

interface FakeSessionManager {
  getSessionId(): string;
  getLeafId(): string | null;
  getSessionName(): string | undefined;
  setSessionId(v: string): void;
  setLeafId(v: string | null): void;
  setSessionName(v: string | undefined): void;
}

function fakeSessionManager(initial: {
  sessionId: string;
  leaf: string | null;
  title: string | undefined;
}): FakeSessionManager {
  let sessionId = initial.sessionId;
  let leaf = initial.leaf;
  let title = initial.title;
  return {
    getSessionId: () => sessionId,
    getLeafId: () => leaf,
    getSessionName: () => title,
    setSessionId: (v) => {
      sessionId = v;
    },
    setLeafId: (v) => {
      leaf = v;
    },
    setSessionName: (v) => {
      title = v;
    },
  };
}

function fakeUi(): {
  notify: (message: string, level?: string) => void;
  calls: Array<{ message: string; level?: string }>;
} {
  const calls: Array<{ message: string; level?: string }> = [];
  return {
    notify: (message, level) => {
      calls.push({ message, level });
    },
    calls,
  };
}

function fakeRenameCtx(overrides?: {
  sessionManager?: FakeSessionManager;
  cwd?: string;
  ui?: ReturnType<typeof fakeUi>;
  isIdle?: () => boolean;
}): RenameCommandContext {
  const sessionManager =
    overrides?.sessionManager ??
    fakeSessionManager({ sessionId: "sess-1", leaf: "root", title: undefined });
  return {
    cwd: overrides?.cwd ?? "/work/repo",
    sessionManager,
    modelRegistry: {
      find: () => ({ provider: RENAME_MODEL_PROVIDER, id: RENAME_MODEL_ID }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key-123" }),
    },
    ui: overrides?.ui ?? fakeUi(),
    isIdle: overrides?.isIdle ?? (() => true),
  };
}

function fakeRenameDeps(
  overrides?: Partial<RenameCommandDeps>,
): RenameCommandDeps {
  return {
    runTurnCli: async () => ({
      stdout: turnEnvelopeStdout({
        prompt: "add dark mode",
        promptTruncated: false,
        response: null,
        responseTruncated: false,
      }),
      stderr: "",
    }),
    resolveModel: (registry, provider, modelId) =>
      registry.find(provider, modelId),
    getAuth: (registry, model) => registry.getApiKeyAndHeaders(model),
    runCompletion: async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: "Add Dark Mode" }],
    }),
    timeoutMs: 50,
    ...overrides,
  };
}

describe("runRenameInvocation", () => {
  test("a valid empty turn returns before model lookup", async () => {
    let resolveModelCalled = false;
    const ctx = fakeRenameCtx();
    const deps = fakeRenameDeps({
      runTurnCli: async () => ({
        stdout: turnEnvelopeStdout(null),
        stderr: "",
      }),
      resolveModel: () => {
        resolveModelCalled = true;
        return undefined;
      },
    });
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("empty");
    expect(resolveModelCalled).toBe(false);
  });

  test("a turn CLI read failure is read_failed, distinct from empty", async () => {
    const ctx = fakeRenameCtx();
    const deps = fakeRenameDeps({
      runTurnCli: async () => ({ stdout: "not json", stderr: "boom" }),
    });
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("read_failed");
  });

  test("a missing model is model_unavailable", async () => {
    const ctx = fakeRenameCtx();
    const deps = fakeRenameDeps({ resolveModel: () => undefined });
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("model_unavailable");
  });

  test("a failed auth resolution is auth_failed", async () => {
    const ctx = fakeRenameCtx();
    const deps = fakeRenameDeps({
      getAuth: async () => ({ ok: false, error: "no oauth" }),
    });
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("auth_failed");
  });

  test("a completion that never settles before the timeout is timeout", async () => {
    const ctx = fakeRenameCtx();
    const deps = fakeRenameDeps({
      timeoutMs: 5,
      runCompletion: (_model, _context, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    });
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("timeout");
  });

  test("a graceful aborted stop reason is also timeout", async () => {
    const ctx = fakeRenameCtx();
    const deps = fakeRenameDeps({
      runCompletion: async () => ({ stopReason: "aborted", content: [] }),
    });
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("timeout");
  });

  test("a thrown non-abort completion error is model_unavailable", async () => {
    const ctx = fakeRenameCtx();
    const deps = fakeRenameDeps({
      runCompletion: async () => {
        throw new Error("import failed");
      },
    });
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("model_unavailable");
  });

  for (const stopReason of ["length", "toolUse", "error"] as const) {
    test(`stopReason ${stopReason} is invalid_output`, async () => {
      const ctx = fakeRenameCtx();
      const deps = fakeRenameDeps({
        runCompletion: async () => ({
          stopReason,
          content: [{ type: "text", text: "Add Dark Mode" }],
        }),
      });
      const result = await runRenameInvocation(
        ctx,
        deps,
        createRenameInvocationState(),
      );
      expect(result.outcome).toBe("invalid_output");
    });
  }

  test("an empty-after-slug output is invalid_output", async () => {
    const ctx = fakeRenameCtx();
    const deps = fakeRenameDeps({
      runCompletion: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "🚀🚀🚀" }],
      }),
    });
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("invalid_output");
  });

  test("a usable prompt-and-response turn resolves to a bounded ASCII slug", async () => {
    const ctx = fakeRenameCtx();
    const deps = fakeRenameDeps();
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("success");
    expect(result.title).toBe("add-dark-mode");
  });

  test("a session id change mid-flight discards the result as stale", async () => {
    const sm = fakeSessionManager({
      sessionId: "sess-a",
      leaf: "root",
      title: undefined,
    });
    const ctx = fakeRenameCtx({ sessionManager: sm });
    const deps = fakeRenameDeps({
      runCompletion: async () => {
        sm.setSessionId("sess-b");
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "New Title" }],
        };
      },
    });
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("stale");
  });

  test("a leaf change mid-flight (branch navigation) discards the result as stale", async () => {
    const sm = fakeSessionManager({
      sessionId: "sess-a",
      leaf: "root",
      title: undefined,
    });
    const ctx = fakeRenameCtx({ sessionManager: sm });
    const deps = fakeRenameDeps({
      runCompletion: async () => {
        sm.setLeafId("entry-42");
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "New Title" }],
        };
      },
    });
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("stale");
  });

  test("a manual title change mid-flight discards the result as stale", async () => {
    const sm = fakeSessionManager({
      sessionId: "sess-a",
      leaf: "root",
      title: undefined,
    });
    const ctx = fakeRenameCtx({ sessionManager: sm });
    const deps = fakeRenameDeps({
      runCompletion: async () => {
        sm.setSessionName("manually renamed");
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "New Title" }],
        };
      },
    });
    const result = await runRenameInvocation(
      ctx,
      deps,
      createRenameInvocationState(),
    );
    expect(result.outcome).toBe("stale");
  });

  test("a later /rename invocation discards an earlier one's result", async () => {
    const sm = fakeSessionManager({
      sessionId: "sess-a",
      leaf: "root",
      title: undefined,
    });
    const ctx = fakeRenameCtx({ sessionManager: sm });
    const state = createRenameInvocationState();
    let resolveFirst: (v: {
      stopReason: "stop";
      content: Array<{ type: "text"; text: string }>;
    }) => void = () => {};
    const firstCompletion = new Promise<{
      stopReason: "stop";
      content: Array<{ type: "text"; text: string }>;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const depsFirst = fakeRenameDeps({ runCompletion: () => firstCompletion });
    const depsSecond = fakeRenameDeps({
      runCompletion: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "Second Title" }],
      }),
    });

    const firstPromise = runRenameInvocation(ctx, depsFirst, state);
    const secondResult = await runRenameInvocation(ctx, depsSecond, state);
    resolveFirst({
      stopReason: "stop",
      content: [{ type: "text", text: "First Title" }],
    });
    const firstResult = await firstPromise;

    expect(secondResult.outcome).toBe("success");
    expect(secondResult.title).toBe("second-title");
    expect(firstResult.outcome).toBe("stale");
  });
});

describe("createRenameCommandHandler", () => {
  test("calls pi.setSessionName exactly once on success, with a success notification", async () => {
    const calls: string[] = [];
    const pi = { setSessionName: (name: string) => calls.push(name) };
    const ui = fakeUi();
    const ctx = fakeRenameCtx({ ui });
    const deps = fakeRenameDeps();
    const handler = createRenameCommandHandler(
      pi,
      deps,
      createRenameInvocationState(),
    );
    await handler("", ctx);
    expect(calls).toEqual(["add-dark-mode"]);
    expect(ui.calls[0]?.message).toBe("/rename: generating a session title…");
    expect(ui.calls.at(-1)?.message).toBe("Session renamed: add-dark-mode");
  });

  test("an empty turn remains pending after the initial generating notice", async () => {
    const calls: string[] = [];
    const pi = { setSessionName: (name: string) => calls.push(name) };
    const ui = fakeUi();
    const ctx = fakeRenameCtx({ ui });
    const deps = fakeRenameDeps({
      runTurnCli: async () => ({
        stdout: turnEnvelopeStdout(null),
        stderr: "",
      }),
    });
    const handler = createRenameCommandHandler(
      pi,
      deps,
      createRenameInvocationState(),
    );
    await handler("", ctx);
    expect(calls).toEqual([]);
    expect(ui.calls).toEqual([
      { message: "/rename: generating a session title…", level: "info" },
    ]);
  });

  test("an active turn waits without reading the transcript", async () => {
    const idle = false;
    let reads = 0;
    const calls: string[] = [];
    const ui = fakeUi();
    const ctx = fakeRenameCtx({ ui, isIdle: () => idle });
    const handler = createRenameCommandHandler(
      { setSessionName: (name) => calls.push(name) },
      fakeRenameDeps({
        runTurnCli: async () => {
          reads += 1;
          return {
            stdout: turnEnvelopeStdout({
              prompt: "settled request",
              response: "done",
            }),
            stderr: "",
          };
        },
      }),
      createRenameInvocationState(),
    );

    await handler("", ctx);
    expect(reads).toBe(0);
    expect(calls).toEqual([]);
    expect(ui.calls).toHaveLength(1);
  });

  test("a leaf change during inference retries the settled latest leaf", async () => {
    const sm = fakeSessionManager({
      sessionId: "sess-a",
      leaf: "leaf-1",
      title: undefined,
    });
    const calls: string[] = [];
    let completions = 0;
    const ctx = fakeRenameCtx({ sessionManager: sm });
    const handler = createRenameCommandHandler(
      { setSessionName: (name) => calls.push(name) },
      fakeRenameDeps({
        runCompletion: async () => {
          completions += 1;
          if (completions === 1) sm.setLeafId("leaf-2");
          return {
            stopReason: "stop",
            content: [{ type: "text", text: `Title ${completions}` }],
          };
        },
      }),
      createRenameInvocationState(),
    );

    await handler("", ctx);
    expect(completions).toBe(2);
    expect(calls).toEqual(["title-2"]);
  });

  test("retries transient transcript read failures before one terminal error", async () => {
    let reads = 0;
    const ui = fakeUi();
    const handler = createRenameCommandHandler(
      { setSessionName: () => {} },
      fakeRenameDeps({
        runTurnCli: async () => {
          reads += 1;
          return { stdout: "not-json", stderr: "" };
        },
      }),
      createRenameInvocationState(),
    );

    await handler("", fakeRenameCtx({ ui }));
    expect(reads).toBe(3);
    expect(ui.calls.map((call) => call.message)).toEqual([
      "/rename: generating a session title…",
      renameFeedback("read_failed").message,
    ]);
  });

  test("feedback never echoes transcript text, model output, or credentials", async () => {
    const ui = fakeUi();
    const ctx = fakeRenameCtx({ ui });
    const secretApiKey = "sk-super-secret-key";
    const deps = fakeRenameDeps({
      getAuth: async () => ({ ok: true, apiKey: secretApiKey }),
      runCompletion: async () => ({
        stopReason: "error",
        content: [],
        errorMessage: "raw provider payload with secrets",
      }),
    });
    const pi = { setSessionName: () => {} };
    const handler = createRenameCommandHandler(
      pi,
      deps,
      createRenameInvocationState(),
    );
    await handler("", ctx);
    for (const call of ui.calls) {
      expect(call.message).not.toContain(secretApiKey);
      expect(call.message).not.toContain("raw provider payload");
    }
  });
});

// ---------------------------------------------------------------------------
// registerRenameCommand wiring (own fake — independent of the factory's fakePi())
// ---------------------------------------------------------------------------

function fakeRenamePi(): PiRenameApi & {
  commands: Map<
    string,
    {
      description?: string;
      handler: (args: string, ctx: RenameCommandContext) => Promise<void>;
    }
  >;
  setNameCalls: string[];
  fire: (event: string, ...args: unknown[]) => void;
} {
  const commands = new Map<
    string,
    {
      description?: string;
      handler: (args: string, ctx: RenameCommandContext) => Promise<void>;
    }
  >();
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const setNameCalls: string[] = [];
  // Cast once to the overloaded interface type — the fake stores every
  // handler untyped (`unknown[]`) regardless of which `session_*` overload
  // registered it, so a plain function EXPRESSION assertion here is exact,
  // unlike letting TS structurally infer the object literal's method type.
  const on = ((event: string, handler: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  }) as PiRenameApi["on"];
  return {
    commands,
    setNameCalls,
    registerCommand(
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: RenameCommandContext) => Promise<void>;
      },
    ) {
      commands.set(name, options);
    },
    setSessionName(name: string) {
      setNameCalls.push(name);
    },
    on,
    fire(event: string, ...args: unknown[]) {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
  };
}

describe("registerRenameCommand", () => {
  test("registers the rename command", () => {
    const pi = fakeRenamePi();
    registerRenameCommand(pi, { onTitleChange: () => {} });
    expect(pi.commands.has("rename")).toBe(true);
  });

  test("an empty request renames once after the next settled turn", async () => {
    const pi = fakeRenamePi();
    let hasTurn = false;
    const deps = fakeRenameDeps({
      runTurnCli: async () => ({
        stdout: turnEnvelopeStdout(
          hasTurn ? { prompt: "add durable retries", response: "done" } : null,
        ),
        stderr: "",
      }),
    });
    registerRenameCommand(pi, { onTitleChange: () => {}, deps });
    const ctx = fakeRenameCtx();

    await pi.commands.get("rename")?.handler("", ctx);
    expect(pi.setNameCalls).toEqual([]);
    hasTurn = true;
    pi.fire("agent_settled", {}, ctx);

    expect(
      await retryUntil(() =>
        pi.setNameCalls.length === 1 ? pi.setNameCalls[0] : null,
      ),
    ).toBe("add-dark-mode");
  });

  test("a manual rename cancels a request waiting for its first turn", async () => {
    const pi = fakeRenamePi();
    let hasTurn = false;
    const deps = fakeRenameDeps({
      runTurnCli: async () => ({
        stdout: turnEnvelopeStdout(
          hasTurn ? { prompt: "later prompt", response: "done" } : null,
        ),
        stderr: "",
      }),
    });
    registerRenameCommand(pi, { onTitleChange: () => {}, deps });
    const ctx = fakeRenameCtx();

    await pi.commands.get("rename")?.handler("", ctx);
    pi.fire("session_info_changed", { name: "human-title" });
    hasTurn = true;
    pi.fire("agent_settled", {}, ctx);

    expect(pi.setNameCalls).toEqual([]);
  });

  test("session shutdown cancels a queued request", async () => {
    const pi = fakeRenamePi();
    let hasTurn = false;
    const deps = fakeRenameDeps({
      runTurnCli: async () => ({
        stdout: turnEnvelopeStdout(
          hasTurn ? { prompt: "later prompt", response: "done" } : null,
        ),
        stderr: "",
      }),
    });
    registerRenameCommand(pi, { onTitleChange: () => {}, deps });
    const ctx = fakeRenameCtx();

    await pi.commands.get("rename")?.handler("", ctx);
    pi.fire("session_shutdown");
    hasTurn = true;
    pi.fire("agent_settled", {}, ctx);

    expect(pi.setNameCalls).toEqual([]);
  });

  test("session_info_changed bridges a non-empty name to onTitleChange", () => {
    const pi = fakeRenamePi();
    const seen: string[] = [];
    registerRenameCommand(pi, { onTitleChange: (t) => seen.push(t) });
    pi.fire("session_info_changed", { name: "new-title" });
    expect(seen).toEqual(["new-title"]);
  });

  test("session_info_changed ignores a cleared (undefined) name", () => {
    const pi = fakeRenamePi();
    const seen: string[] = [];
    registerRenameCommand(pi, { onTitleChange: (t) => seen.push(t) });
    pi.fire("session_info_changed", { name: undefined });
    expect(seen).toEqual([]);
  });

  test("session_start replays the current non-empty title", () => {
    const pi = fakeRenamePi();
    const seen: string[] = [];
    registerRenameCommand(pi, { onTitleChange: (t) => seen.push(t) });
    pi.fire(
      "session_start",
      {},
      {
        sessionManager: {
          getSessionId: () => "s",
          getLeafId: () => null,
          getSessionName: () => "resumed-title",
        },
      },
    );
    expect(seen).toEqual(["resumed-title"]);
  });

  test("session_start does nothing when no title is set", () => {
    const pi = fakeRenamePi();
    const seen: string[] = [];
    registerRenameCommand(pi, { onTitleChange: (t) => seen.push(t) });
    pi.fire(
      "session_start",
      {},
      {
        sessionManager: {
          getSessionId: () => "s",
          getLeafId: () => null,
          getSessionName: () => undefined,
        },
      },
    );
    expect(seen).toEqual([]);
  });

  test("a throwing onTitleChange never escapes session_info_changed or session_start", () => {
    const pi = fakeRenamePi();
    registerRenameCommand(pi, {
      onTitleChange: () => {
        throw new Error("write failed");
      },
    });
    expect(() => pi.fire("session_info_changed", { name: "x" })).not.toThrow();
    expect(() =>
      pi.fire(
        "session_start",
        {},
        {
          sessionManager: {
            getSessionId: () => "s",
            getLeafId: () => null,
            getSessionName: () => "x",
          },
        },
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// /rename arming through the keeperEvents factory
// ---------------------------------------------------------------------------

function fakeFullPi(): PiExtensionApi & {
  handlers: Map<string, Array<(e: unknown, ctx?: unknown) => void>>;
  tools: Map<string, unknown>;
  commands: Map<
    string,
    {
      description?: string;
      handler: (args: string, ctx: RenameCommandContext) => Promise<void>;
    }
  >;
  setNameCalls: string[];
  fire: (kind: string, e?: unknown, ctx?: unknown) => void;
} {
  const handlers = new Map<
    string,
    Array<(e: unknown, ctx?: unknown) => void>
  >();
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const tools = new Map<string, unknown>();
  const commands = new Map<
    string,
    {
      description?: string;
      handler: (args: string, ctx: RenameCommandContext) => Promise<void>;
    }
  >();
  const setNameCalls: string[] = [];
  // Cast once, same reasoning as `fakeRenamePi`'s `on`: this fake's single
  // handler storage backs BOTH `PiExtensionApi.on` (lifecycle events, typed
  // `PiObservedEvent`) and, via the factory's internal `as unknown as
  // PiRenameApi` cast, the `session_info_changed`/`session_start` overloads —
  // a plain function EXPRESSION assertion is exact where structural
  // inference is not.
  const on = ((kind: string, h: (e: unknown, ctx?: unknown) => void) => {
    const list = handlers.get(kind) ?? [];
    list.push(h);
    handlers.set(kind, list);
  }) as PiExtensionApi["on"];
  return {
    handlers,
    tools,
    commands,
    setNameCalls,
    events: {
      on(event: string, handler: (data: unknown) => void) {
        const set = eventHandlers.get(event) ?? new Set();
        set.add(handler);
        eventHandlers.set(event, set);
        return () => set.delete(handler);
      },
      emit(event: string, data: unknown) {
        for (const handler of [...(eventHandlers.get(event) ?? [])]) {
          handler(data);
        }
      },
    },
    on,
    fire(kind: string, e?: unknown, ctx?: unknown) {
      for (const h of handlers.get(kind) ?? []) h(e, ctx);
    },
    registerTool(tool: unknown) {
      const name = (tool as { name?: unknown }).name;
      if (typeof name === "string") tools.set(name, tool);
    },
    registerCommand(
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: RenameCommandContext) => Promise<void>;
      },
    ) {
      commands.set(name, options);
    },
    setSessionName(name: string) {
      setNameCalls.push(name);
    },
  };
}

describe("pi extension — /rename arming via the keeperEvents factory", () => {
  const saved: Record<string, string | undefined> = {};
  let logDir: string;

  function keeperEvents(
    pi: PiExtensionApi,
    paths = {
      eventsLogDir: logDir,
      deadLetterDir: join(logDir, "dead-letters"),
    },
  ): void {
    keeperEventsExtension(pi, paths);
  }

  beforeEach(() => {
    saved.KEEPER_JOB_ID = process.env.KEEPER_JOB_ID;
    logDir = mkdtempSync(join(tmpdir(), "pi-ext-rename-"));
    process.env.KEEPER_JOB_ID = "job-rename";
  });

  afterEach(() => {
    for (const k of ["KEEPER_JOB_ID"]) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
    rmSync(logDir, { recursive: true, force: true });
  });

  test("an armed session with a full pi surface registers /rename", () => {
    const pi = fakeFullPi();
    keeperEvents(pi);
    expect(pi.commands.has("rename")).toBe(true);
  });

  test("without KEEPER_JOB_ID, /rename never registers", () => {
    delete process.env.KEEPER_JOB_ID;
    const pi = fakeFullPi();
    keeperEvents(pi);
    expect(pi.commands.size).toBe(0);
  });

  test("a pi surface missing registerCommand/setSessionName never throws and never registers /rename", () => {
    const handlers = new Map<string, Array<(e: PiObservedEvent) => void>>();
    // Same cast idiom as `fakeRenamePi`'s `on`: a plain function EXPRESSION
    // assertion is exact where structural inference against the overloaded
    // `PiExtensionApi.on` target is not.
    const on = ((kind: string, h: (e: PiObservedEvent) => void) => {
      const list = handlers.get(kind) ?? [];
      list.push(h);
      handlers.set(kind, list);
    }) as PiExtensionApi["on"];
    const pi: PiExtensionApi = { on };
    expect(() => keeperEvents(pi)).not.toThrow();
  });

  test("session_info_changed writes a TranscriptTitle line to the per-pid file", () => {
    const pi = fakeFullPi();
    keeperEvents(pi);
    pi.fire("session_info_changed", { name: "new-session-title" });
    const body = readFileSync(join(logDir, `${process.pid}.ndjson`), "utf8");
    const parsed = parseEventLogLine(body.trim());
    expect(parsed?.bindings.hook_event).toBe("TranscriptTitle");
    expect(parsed?.bindings.session_id).toBe("job-rename");
    expect(JSON.parse(String(parsed?.bindings.data))).toEqual({
      session_title: "new-session-title",
    });
  });

  test("session_start replays the resumed title as a TranscriptTitle line", () => {
    const pi = fakeFullPi();
    keeperEvents(pi);
    pi.fire(
      "session_start",
      {},
      {
        sessionManager: {
          getSessionId: () => "s",
          getLeafId: () => null,
          getSessionName: () => "resumed-title",
        },
      },
    );
    const body = readFileSync(join(logDir, `${process.pid}.ndjson`), "utf8");
    const parsed = parseEventLogLine(body.trim());
    expect(parsed?.bindings.hook_event).toBe("TranscriptTitle");
    expect(JSON.parse(String(parsed?.bindings.data))).toEqual({
      session_title: "resumed-title",
    });
  });

  test("session_start does nothing when no title is set (no line written)", () => {
    const pi = fakeFullPi();
    keeperEvents(pi);
    pi.fire(
      "session_start",
      {},
      {
        sessionManager: {
          getSessionId: () => "s",
          getLeafId: () => null,
          getSessionName: () => undefined,
        },
      },
    );
    expect(existsSync(join(logDir, `${process.pid}.ndjson`))).toBe(false);
  });

  test("a title-write failure never propagates out of session_info_changed", () => {
    const blocker = join(logDir, "blocker");
    writeFileSync(blocker, "not a dir");
    const pi = fakeFullPi();
    keeperEvents(pi, {
      eventsLogDir: join(blocker, "nested"),
      deadLetterDir: join(logDir, "dead-letters"),
    });
    expect(() => pi.fire("session_info_changed", { name: "x" })).not.toThrow();
  });

  test("the registered command's handler is the /rename handler (identity, not invocation)", () => {
    // NEVER invoked here: the real handler's default deps spawn the `keeper`
    // binary and dynamically import Pi's host inference module — both are
    // exercised only through injected fakes in the dedicated
    // `createRenameCommandHandler`/`runRenameInvocation` suites above, never
    // for real in this process.
    const pi = fakeFullPi();
    keeperEvents(pi);
    const registration = pi.commands.get("rename");
    expect(registration).toBeDefined();
    expect(typeof registration?.handler).toBe("function");
  });
});
