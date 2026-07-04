/**
 * Unit tests for the pure core of the hermes events shim
 * (`plugins/keeper/plugin/hooks/hermes-events-shim.ts`): `buildHermesEventLine`
 * translates a hermes lifecycle payload into ONE keeper events-log NDJSON line.
 *
 * Pure + in-process: every case passes a raw payload string + an injected env +
 * ts, and asserts the exact emitted line (or null). No fs, no fork — the shim's
 * `import.meta.main` guard keeps a plain import inert. The end-to-end
 * "hermes session shows working/stopped churn" lives in the slow tier (it spawns
 * hermes), out of this fast unit suite.
 */

import { describe, expect, test } from "bun:test";
import {
  buildHermesEventLine,
  HERMES_SHIM_EVENTS,
} from "../plugins/keeper/plugin/hooks/hermes-events-shim";

const JOB_ID = "job-abc-123";
const NATIVE_ID = "hermes-sess-xyz";
const TS = 1_700_000_000.5;

/** The env carrying the keeper job identity into the hook subprocess. */
function env(extra: Record<string, string | undefined> = {}) {
  return { KEEPER_JOB_ID: JOB_ID, ...extra };
}

/** The exact line the shim emits for a given bindings map — computed with the
 *  same serializer the shim uses, so the assertion is exact-not-brittle. */
function expectedLine(bindings: Record<string, unknown>): string {
  return `${JSON.stringify({ bindings })}\n`;
}

describe("buildHermesEventLine — event map (golden lines)", () => {
  test("on_session_start → SessionStart, stamps harness + resume_target (native id)", () => {
    const raw = JSON.stringify({
      hook_event_name: "on_session_start",
      session_id: NATIVE_ID,
      cwd: "/repo",
    });
    const line = buildHermesEventLine(raw, env(), TS);
    expect(line).toBe(
      expectedLine({
        ts: TS,
        session_id: JOB_ID,
        hook_event: "SessionStart",
        event_type: "session_start",
        data: raw,
        cwd: "/repo",
        harness: "hermes",
        resume_target: NATIVE_ID,
      }),
    );
  });

  test("pre_llm_call → UserPromptSubmit (the working driver)", () => {
    const raw = JSON.stringify({
      hook_event_name: "pre_llm_call",
      session_id: NATIVE_ID,
    });
    const line = buildHermesEventLine(raw, env(), TS);
    expect(line).toBe(
      expectedLine({
        ts: TS,
        session_id: JOB_ID,
        hook_event: "UserPromptSubmit",
        event_type: "user_prompt_submit",
        data: raw,
      }),
    );
  });

  test("pre_tool_call → PreToolUse carries tool_name", () => {
    const raw = JSON.stringify({
      hook_event_name: "pre_tool_call",
      tool_name: "terminal",
      tool_input: { command: "ls" },
    });
    const line = buildHermesEventLine(raw, env(), TS);
    expect(line).toBe(
      expectedLine({
        ts: TS,
        session_id: JOB_ID,
        hook_event: "PreToolUse",
        event_type: "pre_tool_use",
        data: raw,
        tool_name: "terminal",
      }),
    );
  });

  test("post_tool_call → PostToolUse", () => {
    const raw = JSON.stringify({
      hook_event_name: "post_tool_call",
      tool_name: "write_file",
    });
    const parsed = JSON.parse(buildHermesEventLine(raw, env(), TS) as string);
    expect(parsed.bindings.hook_event).toBe("PostToolUse");
    expect(parsed.bindings.event_type).toBe("tool_use");
    expect(parsed.bindings.tool_name).toBe("write_file");
  });

  test("on_session_end → SessionEnd (the stopped edge)", () => {
    const raw = JSON.stringify({ hook_event_name: "on_session_end" });
    const parsed = JSON.parse(buildHermesEventLine(raw, env(), TS) as string);
    expect(parsed.bindings.hook_event).toBe("SessionEnd");
    expect(parsed.bindings.event_type).toBe("session_end");
    // No harness / resume_target stamp off SessionStart.
    expect(parsed.bindings.harness).toBeUndefined();
    expect(parsed.bindings.resume_target).toBeUndefined();
  });

  test("api_request_error → ApiError (the error pill)", () => {
    const raw = JSON.stringify({ hook_event_name: "api_request_error" });
    const parsed = JSON.parse(buildHermesEventLine(raw, env(), TS) as string);
    expect(parsed.bindings.hook_event).toBe("ApiError");
    expect(parsed.bindings.event_type).toBe("api_error");
  });

  test("pre_approval_request → Notification:permission_prompt", () => {
    const raw = JSON.stringify({ hook_event_name: "pre_approval_request" });
    const parsed = JSON.parse(buildHermesEventLine(raw, env(), TS) as string);
    expect(parsed.bindings.hook_event).toBe("Notification");
    expect(parsed.bindings.event_type).toBe("permission_prompt");
  });

  test("subagent_start / subagent_stop map through", () => {
    for (const [hermesEvent, hookEvent] of [
      ["subagent_start", "SubagentStart"],
      ["subagent_stop", "SubagentStop"],
    ] as const) {
      const raw = JSON.stringify({ hook_event_name: hermesEvent });
      const parsed = JSON.parse(buildHermesEventLine(raw, env(), TS) as string);
      expect(parsed.bindings.hook_event).toBe(hookEvent);
    }
  });

  test("every registered shim event maps to a non-null line", () => {
    for (const hermesEvent of HERMES_SHIM_EVENTS) {
      const raw = JSON.stringify({ hook_event_name: hermesEvent });
      expect(buildHermesEventLine(raw, env(), TS)).not.toBeNull();
    }
  });
});

describe("buildHermesEventLine — identity + resume target", () => {
  test("session_id column is the keeper job id, NOT hermes's native id", () => {
    const raw = JSON.stringify({
      hook_event_name: "on_session_start",
      session_id: NATIVE_ID,
    });
    const parsed = JSON.parse(buildHermesEventLine(raw, env(), TS) as string);
    expect(parsed.bindings.session_id).toBe(JOB_ID);
    expect(parsed.bindings.resume_target).toBe(NATIVE_ID);
  });

  test("SessionStart with no native session_id stamps harness but no resume_target", () => {
    const raw = JSON.stringify({ hook_event_name: "on_session_start" });
    const parsed = JSON.parse(buildHermesEventLine(raw, env(), TS) as string);
    expect(parsed.bindings.harness).toBe("hermes");
    expect(parsed.bindings.resume_target).toBeUndefined();
  });
});

describe("buildHermesEventLine — injection + garbage (fail-safe)", () => {
  test("quotes / newlines / shell metacharacters round-trip as data — one whole line, no tearing", () => {
    const nasty =
      'rm -rf "/"; echo `whoami`\nSECOND LINE\t{"fake":"binding"}\n$(reboot)';
    const raw = JSON.stringify({
      hook_event_name: "pre_tool_call",
      tool_name: "terminal",
      tool_input: { command: nasty },
    });
    const line = buildHermesEventLine(raw, env(), TS) as string;
    // Exactly one NDJSON record: the trailing newline is the ONLY newline.
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    // The payload round-trips as pure data — no injected top-level binding.
    const parsed = JSON.parse(line);
    expect(JSON.parse(parsed.bindings.data as string).tool_input.command).toBe(
      nasty,
    );
    expect(parsed.bindings.fake).toBeUndefined();
  });

  test("no KEEPER_JOB_ID → null (presence-only floor, never an orphan row)", () => {
    const raw = JSON.stringify({ hook_event_name: "on_session_start" });
    expect(buildHermesEventLine(raw, {}, TS)).toBeNull();
    expect(buildHermesEventLine(raw, { KEEPER_JOB_ID: "  " }, TS)).toBeNull();
  });

  test("unmapped hermes event → null (never poison)", () => {
    const raw = JSON.stringify({ hook_event_name: "post_llm_call" });
    expect(buildHermesEventLine(raw, env(), TS)).toBeNull();
  });

  test("missing hook_event_name → null", () => {
    const raw = JSON.stringify({ session_id: NATIVE_ID });
    expect(buildHermesEventLine(raw, env(), TS)).toBeNull();
  });

  test("garbage / non-object stdin → null, never throws", () => {
    for (const raw of ["not json", "", "[]", "null", "42", '"a string"']) {
      expect(buildHermesEventLine(raw, env(), TS)).toBeNull();
    }
  });

  test("oversized data is bounded (line stays sane)", () => {
    const big = "x".repeat(200_000);
    const raw = JSON.stringify({
      hook_event_name: "pre_llm_call",
      tool_input: { command: big },
    });
    const parsed = JSON.parse(buildHermesEventLine(raw, env(), TS) as string);
    expect((parsed.bindings.data as string).length).toBeLessThanOrEqual(
      64 * 1024,
    );
  });
});
