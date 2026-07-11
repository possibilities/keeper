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
  type PiObservedEvent,
  type PiTranslateMeta,
  piEventBindings,
  resolvePiEventsLogDir,
  sendPiBusMessage,
  serializePiLine,
  transcriptCliArgs,
  transcriptIdError,
  transcriptToolResult,
  translatePiEvent,
} from "../plugins/keeper/pi-extension/keeper-events";
import { piExtensionArgs, piExtensionPath } from "../src/agent/launch-config";
import { parseEventLogLine } from "../src/dead-letter";

const META: PiTranslateMeta = {
  jobId: "job-1111-2222",
  pid: 4242,
  cwd: "/work/repo",
  tsSec: 1_700_000_000,
};

describe("pi extension — pure translation", () => {
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
      "list",
      "--harness",
      "claude",
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
      "session-1",
      "--harness",
      "claude",
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
      "list",
      "--harness",
      "claude",
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
    logDir = mkdtempSync(join(tmpdir(), "pi-ext-"));
    process.env.KEEPER_EVENTS_LOG = logDir;
    delete process.env.KEEPER_JOB_ID;
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
      "session_shutdown",
      "session_start",
      "tool_call",
      "tool_result",
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
