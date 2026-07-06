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
  darwinLstartToStartTime,
  HERMES_ADOPT_OPT_OUT_ENV,
  HERMES_SHIM_EVENTS,
  HERMES_SHIM_VERSION,
  linuxStatToStartTime,
  validateNativeSessionId,
} from "../plugins/keeper/plugin/hooks/hermes-events-shim";
import {
  darwinLstartToStartTime as birthDarwinLstartToStartTime,
  linuxStatToStartTime as birthLinuxStatToStartTime,
} from "../src/birth-record";
import {
  DARWIN_LSTART_CASES,
  LINUX_STAT_CASES,
} from "./fixtures/start-time-parser-cases";

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

// --- Self-seed (hand-started hermes) fixtures ------------------------------
// The injected SESSION pid (the shim's PARENT — hermes; `main` passes
// `process.ppid`) and a fixed injected start_time thunk, so the self-seed tests
// stay pure (no `process.ppid` read, no `ps` fork). START_TIME is an opaque
// hand-chosen constant — the builder stamps whatever the thunk returns.
const SESSION_PID = 4242;
const START_TIME = "darwin:Mon Jul  6 09:00:00 2026";
const startTimeProbe = () => START_TIME;
/** A probe that MUST NOT be called (start_time is SessionStart-only + lazy). */
const throwingProbe = (): string | null => {
  throw new Error("probeStartTime called when it should not be");
};

/** Env for a hand-started hermes INSIDE a raw human tmux pane: `TMUX`/`TMUX_PANE`
 *  set natively, NO keeper carrier (`KEEPER_TMUX_SESSION`) → session stays NULL,
 *  NO `KEEPER_JOB_ID` → the self-seed path. */
function selfSeedTmuxEnv(extra: Record<string, string | undefined> = {}) {
  return {
    TMUX: "/tmp/tmux-501/default,9999,0",
    TMUX_PANE: "%7",
    ...extra,
  };
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

  test("no KEEPER_JOB_ID AND no native session_id → null (nothing to self-seed under)", () => {
    // Self-seed needs a native id to become the job id; a SessionStart carrying
    // none degrades to the presence-only floor. Whitespace KEEPER_JOB_ID trims to
    // absent, so it takes the same self-seed-without-an-id path.
    const raw = JSON.stringify({ hook_event_name: "on_session_start" });
    expect(
      buildHermesEventLine(raw, {}, TS, SESSION_PID, startTimeProbe),
    ).toBeNull();
    expect(
      buildHermesEventLine(
        raw,
        { KEEPER_JOB_ID: "  " },
        TS,
        SESSION_PID,
        startTimeProbe,
      ),
    ).toBeNull();
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

describe("validateNativeSessionId (self-seed id charset gate)", () => {
  test("accepts a UUID-ish / hermes-native id verbatim (reject-or-passthrough)", () => {
    for (const id of [
      "hermes-sess-xyz",
      "0c9a1b2c-3d4e-5f60-7182-93a4b5c6d7e8",
      "sess.42_abc-DEF",
    ]) {
      expect(validateNativeSessionId(id)).toBe(id);
    }
  });

  test("rejects hostile ids to null — never sanitize-and-continue", () => {
    for (const id of [
      null, // absent
      "", // empty
      "..", // pure-dots traversal token
      ".", // single-dot traversal token
      "../../etc/passwd", // path traversal (slash)
      "a/b", // path separator
      "a\\b", // windows separator
      "has space", // whitespace
      "semi;colon", // shell metacharacter
      "nul byte", // NUL
      "x".repeat(129), // overlong (> 128)
    ]) {
      expect(validateNativeSessionId(id)).toBeNull();
    }
  });
});

describe("buildHermesEventLine — self-seed adoption (hand-started hermes)", () => {
  test("in-tmux SessionStart → full adopted line (native id, adopted, session pid, witness, coords, shim version)", () => {
    const raw = JSON.stringify({
      hook_event_name: "on_session_start",
      session_id: NATIVE_ID,
      cwd: "/repo",
    });
    const line = buildHermesEventLine(
      raw,
      selfSeedTmuxEnv(),
      TS,
      SESSION_PID,
      startTimeProbe,
    );
    expect(line).toBe(
      expectedLine({
        ts: TS,
        session_id: NATIVE_ID, // the NATIVE id IS the job id
        hook_event: "SessionStart",
        event_type: "session_start",
        data: raw,
        cwd: "/repo",
        harness: "hermes",
        resume_target: NATIVE_ID,
        adopted: 1,
        pid: SESSION_PID, // the SESSION (parent) pid, not the shim pid
        start_time: START_TIME, // the (pid, start_time) recycle witness
        backend_exec_type: "tmux",
        backend_exec_pane_id: "%7", // human tmux → no session name, only pane
        shim_version: HERMES_SHIM_VERSION,
      }),
    );
  });

  test("outside-tmux SessionStart → adopted line WITHOUT coords (coordless adopted is legal)", () => {
    const raw = JSON.stringify({
      hook_event_name: "on_session_start",
      session_id: NATIVE_ID,
      cwd: "/repo",
    });
    // No TMUX, no carrier, no KEEPER_JOB_ID → self-seed with all-null coords.
    const line = buildHermesEventLine(raw, {}, TS, SESSION_PID, startTimeProbe);
    expect(line).toBe(
      expectedLine({
        ts: TS,
        session_id: NATIVE_ID,
        hook_event: "SessionStart",
        event_type: "session_start",
        data: raw,
        cwd: "/repo",
        harness: "hermes",
        resume_target: NATIVE_ID,
        adopted: 1,
        pid: SESSION_PID,
        start_time: START_TIME,
        shim_version: HERMES_SHIM_VERSION,
      }),
    );
  });

  test("self-seed pre_llm_call → adopted + pid + coords, but NO start_time / harness / resume_target (probe stays lazy)", () => {
    const raw = JSON.stringify({
      hook_event_name: "pre_llm_call",
      session_id: NATIVE_ID,
    });
    // A throwing probe proves the start_time thunk is NOT called off SessionStart.
    const line = buildHermesEventLine(
      raw,
      selfSeedTmuxEnv(),
      TS,
      SESSION_PID,
      throwingProbe,
    );
    expect(line).toBe(
      expectedLine({
        ts: TS,
        session_id: NATIVE_ID,
        hook_event: "UserPromptSubmit",
        event_type: "user_prompt_submit",
        data: raw,
        adopted: 1,
        pid: SESSION_PID, // pid on EVERY line → a watchable fork-seed row
        backend_exec_type: "tmux",
        backend_exec_pane_id: "%7",
        shim_version: HERMES_SHIM_VERSION,
      }),
    );
  });

  test("opt-out env suppresses self-seeding → null, even with a valid native id", () => {
    const raw = JSON.stringify({
      hook_event_name: "on_session_start",
      session_id: NATIVE_ID,
    });
    expect(
      buildHermesEventLine(
        raw,
        selfSeedTmuxEnv({ [HERMES_ADOPT_OPT_OUT_ENV]: "1" }),
        TS,
        SESSION_PID,
        startTimeProbe,
      ),
    ).toBeNull();
    // An empty/whitespace opt-out value does NOT opt out (presence-gated).
    expect(
      buildHermesEventLine(
        raw,
        selfSeedTmuxEnv({ [HERMES_ADOPT_OPT_OUT_ENV]: "  " }),
        TS,
        SESSION_PID,
        startTimeProbe,
      ),
    ).not.toBeNull();
  });

  test("hostile native id never becomes a job id → null (line degrades to nothing)", () => {
    for (const hostile of [
      "../../etc/passwd",
      "..",
      "a/b",
      "has space",
      "nul byte",
      "x".repeat(200),
    ]) {
      const raw = JSON.stringify({
        hook_event_name: "on_session_start",
        session_id: hostile,
      });
      expect(
        buildHermesEventLine(raw, {}, TS, SESSION_PID, startTimeProbe),
      ).toBeNull();
    }
  });

  test("re-seeded same native id (replayed lifecycle) → identical id, no divergent identity", () => {
    const raw = JSON.stringify({
      hook_event_name: "on_session_start",
      session_id: NATIVE_ID,
      cwd: "/repo",
    });
    const first = buildHermesEventLine(
      raw,
      selfSeedTmuxEnv(),
      TS,
      SESSION_PID,
      startTimeProbe,
    );
    const second = buildHermesEventLine(
      raw,
      selfSeedTmuxEnv(),
      TS,
      SESSION_PID,
      startTimeProbe,
    );
    // Deterministic: the native id is the job id, so a replayed lifecycle folds as
    // a resume onto the SAME row (byte-identical line), never a divergent identity.
    expect(second).toBe(first as string);
    const parsed = JSON.parse(first as string);
    expect(parsed.bindings.session_id).toBe(NATIVE_ID);
    expect(parsed.bindings.resume_target).toBe(NATIVE_ID);
    expect(parsed.bindings.adopted).toBe(1);
  });

  test("self-seeded line is exactly ONE bounded JSON line (no tearing on a hostile-but-valid-charset payload)", () => {
    const nasty = 'echo `whoami`\nSECOND{"fake":"binding"}';
    const raw = JSON.stringify({
      hook_event_name: "pre_tool_call",
      session_id: NATIVE_ID,
      tool_name: "terminal",
      tool_input: { command: nasty },
    });
    const line = buildHermesEventLine(
      raw,
      selfSeedTmuxEnv(),
      TS,
      SESSION_PID,
      throwingProbe,
    ) as string;
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    const parsed = JSON.parse(line);
    expect(parsed.bindings.session_id).toBe(NATIVE_ID);
    expect(parsed.bindings.adopted).toBe(1);
    expect(parsed.bindings.fake).toBeUndefined();
  });
});

describe("buildHermesEventLine — launcher-owned XOR (byte-identical to pre-adoption)", () => {
  test("KEEPER_JOB_ID present → no adoption fields, and the start_time probe never fires", () => {
    const raw = JSON.stringify({
      hook_event_name: "on_session_start",
      session_id: NATIVE_ID,
      cwd: "/repo",
    });
    // A throwing probe + a real session pid: the launcher-owned path must ignore
    // BOTH — no adopted / pid / start_time / coords / shim_version, and no fork.
    const line = buildHermesEventLine(
      raw,
      selfSeedTmuxEnv({ KEEPER_JOB_ID: JOB_ID }),
      TS,
      SESSION_PID,
      throwingProbe,
    );
    expect(line).toBe(
      expectedLine({
        ts: TS,
        session_id: JOB_ID, // the keeper job id, NOT the native id
        hook_event: "SessionStart",
        event_type: "session_start",
        data: raw,
        cwd: "/repo",
        harness: "hermes",
        resume_target: NATIVE_ID,
      }),
    );
    const parsed = JSON.parse(line as string);
    expect(parsed.bindings.adopted).toBeUndefined();
    expect(parsed.bindings.pid).toBeUndefined();
    expect(parsed.bindings.start_time).toBeUndefined();
    expect(parsed.bindings.backend_exec_type).toBeUndefined();
    expect(parsed.bindings.shim_version).toBeUndefined();
  });

  test("opt-out env has NO effect on a launcher-owned session", () => {
    const raw = JSON.stringify({ hook_event_name: "pre_llm_call" });
    const withOptOut = buildHermesEventLine(
      raw,
      env({ [HERMES_ADOPT_OPT_OUT_ENV]: "1" }),
      TS,
    );
    const without = buildHermesEventLine(raw, env(), TS);
    expect(withOptOut).toBe(without as string);
    expect(withOptOut).not.toBeNull();
  });
});

// DRIFT GUARD pin: the shim's darwin/linux start_time parsers are declared
// byte-identical to `birthRecord`'s originals — this must be an assertion,
// not just a comment. Both halves consume the SAME fixture cases
// (test/fixtures/start-time-parser-cases.ts) as the birth-record originals'
// own test, and the shim's outputs are directly compared against the
// birth-record implementations' outputs on every case, so a silent drift in
// either copy fails here regardless of which side changed.
describe("start_time parsers — parity with birth-record (DRIFT GUARD)", () => {
  test("darwin lstart parser matches the birth-record original on every fixture case", () => {
    for (const { input, expected } of DARWIN_LSTART_CASES) {
      expect(darwinLstartToStartTime(input)).toBe(expected);
      expect(darwinLstartToStartTime(input)).toBe(
        birthDarwinLstartToStartTime(input),
      );
    }
  });

  test("linux /proc stat parser matches the birth-record original on every fixture case", () => {
    for (const { input, expected } of LINUX_STAT_CASES) {
      expect(linuxStatToStartTime(input)).toBe(expected);
      expect(linuxStatToStartTime(input)).toBe(
        birthLinuxStatToStartTime(input),
      );
    }
  });
});
