/**
 * keeper's ephemeral pi extension (`plugins/keeper/pi-extension/keeper-events.ts`)
 * — the M3b live-state translator for pi. These tests pin the PURE translation
 * (pi AgentHarness event → events-log NDJSON) against golden fixtures, prove
 * hostile tool payloads round-trip as data, and exercise the fail-open factory
 * guards (no keeper marker → zero output; a throwing write never escapes). No
 * real pi is ever booted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import keeperEvents, {
  clampTranscriptParams,
  type PiEventBindings,
  type PiExtensionApi,
  type PiObservedEvent,
  type PiTranslateMeta,
  piDispatchAttemptFromEnv,
  piEventBindings,
  resolvePiEventsLogDir,
  sendPiBusMessage,
  serializePiLine,
  titleEventBindings,
  transcriptCliArgs,
  transcriptIdError,
  transcriptToolResult,
  translatePiEvent,
} from "../plugins/keeper/pi-extension/keeper-events";
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
import { parseEventLogLine } from "../src/dead-letter";
import { slugify as canonicalSlugify } from "../src/slug";

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
    expect(b?.tool_name).toBe("bash");
    expect(JSON.parse(b?.data as string)).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "bash",
      tool_input: { command: "ls -la" },
    });
  });

  test("tool_result folds to PostToolUse carrying the error flag", () => {
    const b = piEventBindings(
      { type: "tool_result", toolName: "edit", isError: true },
      META,
    );
    expect(b?.hook_event).toBe("PostToolUse");
    expect(b?.event_type).toBe("post_tool_use");
    expect(b?.tool_name).toBe("edit");
    expect(JSON.parse(b?.data as string)).toEqual({
      hook_event_name: "PostToolUse",
      tool_name: "edit",
      is_error: true,
    });
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

describe("pi extension — transcript tool argv", () => {
  test("omitted session id lists the current project with bounded filters", () => {
    expect(
      transcriptCliArgs({
        global: true,
        since: "7d",
        offset: 20,
        limit: 10,
      }),
    ).toEqual([
      "transcript",
      "claude",
      "list",
      "--offset",
      "20",
      "--limit",
      "10",
      "--since",
      "7d",
      "--global",
    ]);
  });

  test("session mode forwards subagent, detail, and content filters as argv", () => {
    expect(
      transcriptCliArgs({
        session_id: "session-1",
        subagent: "abc123",
        project: "/work/repo",
        before: 40,
        max_chars: 12000,
        tools: "full",
        grep: "failure",
        global: true,
        include_meta: true,
        include_thinking: true,
      }),
    ).toEqual([
      "transcript",
      "claude",
      "session-1",
      "--project",
      "/work/repo",
      "--subagent",
      "abc123",
      "--before",
      "40",
      "--max-chars",
      "12000",
      "--tools",
      "full",
      "--grep",
      "failure",
      "--meta",
      "--thinking",
    ]);
  });
});

describe("pi extension — param clamping", () => {
  test("a list limit clamps to 100 with a recorded clamp", () => {
    const { params, clamps } = clampTranscriptParams({ limit: 999 });
    expect(params.limit).toBe(100);
    expect(clamps).toEqual([{ param: "limit", requested: 999, applied: 100 }]);
  });

  test("a show limit clamps to 500 (session_id present)", () => {
    const { params, clamps } = clampTranscriptParams({
      session_id: "s",
      limit: 5000,
    });
    expect(params.limit).toBe(500);
    expect(clamps).toEqual([{ param: "limit", requested: 5000, applied: 500 }]);
  });

  test("max_chars clamps to 60000 in show mode", () => {
    const { params, clamps } = clampTranscriptParams({
      session_id: "s",
      max_chars: 999_999,
    });
    expect(params.max_chars).toBe(60_000);
    expect(clamps).toEqual([
      { param: "max_chars", requested: 999_999, applied: 60_000 },
    ]);
  });

  test("in-bounds values are left untouched, no clamp recorded", () => {
    const { params, clamps } = clampTranscriptParams({
      session_id: "s",
      limit: 50,
      max_chars: 12_000,
    });
    expect(params.limit).toBe(50);
    expect(params.max_chars).toBe(12_000);
    expect(clamps).toEqual([]);
  });

  test("transcriptCliArgs emits the clamped bound in argv", () => {
    expect(transcriptCliArgs({ limit: 999 })).toEqual([
      "transcript",
      "claude",
      "list",
      "--limit",
      "100",
    ]);
    expect(
      transcriptCliArgs({ session_id: "s", max_chars: 999_999 }),
    ).toContain("60000");
  });
});

describe("pi extension — id validation before spawn", () => {
  test("a flag-shaped session_id is rejected", () => {
    expect(transcriptIdError({ session_id: "--project" })).not.toBeNull();
    expect(transcriptIdError({ session_id: "-x" })).not.toBeNull();
  });

  test("a verb/injection-shaped session_id is rejected", () => {
    expect(transcriptIdError({ session_id: "; rm -rf /" })).not.toBeNull();
    expect(transcriptIdError({ session_id: "$(whoami)" })).not.toBeNull();
  });

  test("an over-200-char id is rejected", () => {
    expect(transcriptIdError({ session_id: "a".repeat(201) })).not.toBeNull();
  });

  test("a well-formed session_id and subagent pass", () => {
    expect(transcriptIdError({ session_id: "abc-123_9.session" })).toBeNull();
    expect(transcriptIdError({ session_id: "s", subagent: "all" })).toBeNull();
    expect(
      transcriptIdError({ session_id: "s", subagent: "abc12" }),
    ).toBeNull();
  });

  test("a flag-shaped subagent is rejected", () => {
    expect(
      transcriptIdError({ session_id: "s", subagent: "--all" }),
    ).not.toBeNull();
  });

  test("omitted ids are legal (list mode)", () => {
    expect(transcriptIdError({})).toBeNull();
  });
});

describe("pi extension — transcript tool result shaping", () => {
  test("a maxBuffer overflow returns truncated content, not a failure", () => {
    const r = transcriptToolResult(
      {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        message: "stdout maxBuffer length exceeded",
      },
      "partial transcript body",
      "",
      ["transcript", "s"],
      [],
    );
    expect(r.content[0].text).toContain("partial transcript body");
    expect(r.content[0].text).toContain("truncated - narrow with grep/limit");
    expect(r.content[0].text).not.toContain("keeper transcript failed");
    expect(r.details.truncated).toBe(true);
  });

  test("a non-overflow error still fails with the CLI message", () => {
    const r = transcriptToolResult(
      { code: 1, message: "boom" },
      "",
      "no such session",
      ["transcript", "s"],
      [],
    );
    expect(r.content[0].text).toBe("keeper transcript failed: no such session");
    expect(r.details.exit_code).toBe(1);
  });

  test("a successful call surfaces applied clamps in details", () => {
    const r = transcriptToolResult(
      null,
      "the transcript",
      "",
      ["transcript", "list", "--limit", "100"],
      [{ param: "limit", requested: 999, applied: 100 }],
    );
    expect(r.content[0].text).toBe("the transcript");
    expect(r.details.exit_code).toBe(0);
    expect(r.details.clamps).toEqual([
      { param: "limit", requested: 999, applied: 100 },
    ]);
  });

  test("empty stdout on success yields the no-output placeholder", () => {
    const r = transcriptToolResult(null, "", "", ["transcript", "list"], []);
    expect(r.content[0].text).toBe("(no transcript output)");
    expect(r.details.clamps).toBeUndefined();
  });
});

describe("pi extension — factory arming + fail-open", () => {
  const saved: Record<string, string | undefined> = {};
  let logDir: string;

  function fakePi() {
    const handlers = new Map<string, ((e: PiObservedEvent) => void)[]>();
    const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
    const tools = new Map<string, unknown>();
    return {
      handlers,
      tools,
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
      on(kind: string, h: (e: PiObservedEvent) => void) {
        const list = handlers.get(kind) ?? [];
        list.push(h);
        handlers.set(kind, list);
      },
      fire(kind: string, e: PiObservedEvent) {
        for (const h of handlers.get(kind) ?? []) {
          h(e);
        }
      },
      registerTool(tool: unknown) {
        const name = (tool as { name?: unknown }).name;
        if (typeof name === "string") tools.set(name, tool);
      },
    };
  }

  beforeEach(() => {
    saved.KEEPER_JOB_ID = process.env.KEEPER_JOB_ID;
    saved.KEEPER_EVENTS_LOG = process.env.KEEPER_EVENTS_LOG;
    saved.KEEPER_DISPATCH_ATTEMPT_ID = process.env.KEEPER_DISPATCH_ATTEMPT_ID;
    logDir = mkdtempSync(join(tmpdir(), "pi-ext-"));
    process.env.KEEPER_EVENTS_LOG = logDir;
    delete process.env.KEEPER_JOB_ID;
    delete process.env.KEEPER_DISPATCH_ATTEMPT_ID;
  });

  afterEach(() => {
    for (const k of [
      "KEEPER_JOB_ID",
      "KEEPER_EVENTS_LOG",
      "KEEPER_DISPATCH_ATTEMPT_ID",
    ]) {
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

  test("with KEEPER_JOB_ID → registers lifecycle and bus observers", () => {
    process.env.KEEPER_JOB_ID = "job-abc";
    const pi = fakePi();
    keeperEvents(pi);
    expect([...pi.handlers.keys()].sort()).toEqual([
      "agent_end",
      "agent_start",
      "model_select",
      "session_shutdown",
      "session_start",
      "thinking_level_select",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
    expect([...pi.tools.keys()]).toEqual(["keeper_transcript", "Task"]);
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

  test("a write that throws never propagates out of the handler guard", () => {
    process.env.KEEPER_JOB_ID = "job-live";
    // Point the events-log dir UNDER an existing file so mkdir/append throw.
    const blocker = join(logDir, "blocker");
    writeFileSync(blocker, "not a dir");
    process.env.KEEPER_EVENTS_LOG = join(blocker, "nested");
    const pi = fakePi();
    keeperEvents(pi);
    // The deliberately-failing write must be swallowed — no throw escapes.
    expect(() => pi.fire("agent_start", { type: "agent_start" })).not.toThrow();
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

  test("resolvePiEventsLogDir honors KEEPER_EVENTS_LOG then the default", () => {
    expect(resolvePiEventsLogDir({ KEEPER_EVENTS_LOG: "/tmp/x" })).toBe(
      "/tmp/x",
    );
    expect(resolvePiEventsLogDir({})).toContain(
      join(".local", "state", "keeper", "events-log"),
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
    expect(ui.calls.at(-1)?.message).toBe("Session renamed: add-dark-mode");
  });

  test("never calls setSessionName on a non-success outcome", async () => {
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
    expect(ui.calls.at(-1)?.message).toBe(renameFeedback("empty").message);
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

  beforeEach(() => {
    saved.KEEPER_JOB_ID = process.env.KEEPER_JOB_ID;
    saved.KEEPER_EVENTS_LOG = process.env.KEEPER_EVENTS_LOG;
    logDir = mkdtempSync(join(tmpdir(), "pi-ext-rename-"));
    process.env.KEEPER_EVENTS_LOG = logDir;
    process.env.KEEPER_JOB_ID = "job-rename";
  });

  afterEach(() => {
    for (const k of ["KEEPER_JOB_ID", "KEEPER_EVENTS_LOG"]) {
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
    const pi: PiExtensionApi = {
      on(kind: string, h: (e: PiObservedEvent) => void) {
        const list = handlers.get(kind) ?? [];
        list.push(h);
        handlers.set(kind, list);
      },
    };
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
    process.env.KEEPER_EVENTS_LOG = join(blocker, "nested");
    const pi = fakeFullPi();
    keeperEvents(pi);
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
