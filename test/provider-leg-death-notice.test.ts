import { describe, expect, test } from "bun:test";
import type { WrappedLegAbortCapture } from "../src/exec-backend";
import {
  assembleWrappedLegAbortPayload,
  buildBusPublishFrame,
  buildBusRegisterFrame,
  buildProviderLegDeathNotice,
  createProviderLegDeathNoticeState,
  dueProviderLegDeathNotices,
  ingestProviderLegTerminalRows,
  PROVIDER_LEG_DEATH_NOTICE_MAX_BYTES,
  PROVIDER_LEG_DEATH_NOTICE_MAX_CAPTURE_BYTES,
  PROVIDER_LEG_DEATH_NOTICE_MAX_DETAIL_BYTES,
  PROVIDER_LEG_DEATH_NOTICE_SEND_CAP,
  type ProviderLegDeathCandidate,
  type ProviderLegTerminalRow,
  parseProviderLegExitStatus,
  recordProviderLegNoticeResult,
  redactAbortEvidence,
  resolveUniqueEligibleWrapper,
  runProviderLegDeathNoticeSweep,
  terminalRowToCandidate,
  type WrapperAttemptRow,
} from "../src/provider-leg-death-notice";

const terminalRow = (
  over: Partial<ProviderLegTerminalRow> = {},
): ProviderLegTerminalRow => ({
  provider_leg_job_id: "provider-leg-1",
  provider_leg_created_at: 20,
  title: "fn-1296-notify-wrappers-when-legs-die.2",
  transcript_path: "/tmp/provider-leg-1.jsonl",
  terminal_kind: "killed",
  terminal_event_id: 101,
  terminal_event_kind: "Killed",
  terminal_event_at: 30,
  last_lifecycle_at: 30,
  close_kind: "pane_closed",
  kill_reason: "exit_watched",
  backend_exec_birth_session_id: "wrapped",
  terminal_event_data: null,
  leg_launch_id: null,
  wrapper_job_id: null,
  wrapper_dispatch_attempt_id: null,
  ownership_epoch_event_id: null,
  cascade_human_notified_at: null,
  ...over,
});

const candidate = (
  over: Partial<ProviderLegDeathCandidate> = {},
): ProviderLegDeathCandidate => ({
  providerLegJobId: "provider-leg-1",
  providerLegCreatedAt: 20,
  taskId: "fn-1296-notify-wrappers-when-legs-die.2",
  transcriptPath: "/tmp/provider-leg-1.jsonl",
  terminalKind: "killed",
  terminalEventId: 101,
  failureDetail: "pane_closed: exit_watched",
  abortEvidence: {
    status: "unavailable",
    detail: null,
    exit: { signal: null, code: null },
  },
  legLaunchId: null,
  wrapperJobId: null,
  wrapperDispatchAttemptId: null,
  ownershipEpochEventId: null,
  cascadeHumanNotifiedAt: null,
  ...over,
});

const wrapper = (over: Partial<WrapperAttemptRow> = {}): WrapperAttemptRow => ({
  jobId: "wrapper-1",
  state: "working",
  planVerb: "work",
  planRef: "fn-1296-notify-wrappers-when-legs-die.2",
  dispatchOrigin: "autopilot",
  attemptId: 7,
  claimState: "bound",
  legacyUnfenced: 0,
  boundAt: 10,
  releasedAt: null,
  ...over,
});

describe("Provider-leg terminal candidate selection", () => {
  test("accepts only post-fence authoritative ended or killed transitions", () => {
    expect(terminalRowToCandidate(terminalRow(), 100)?.terminalKind).toBe(
      "killed",
    );
    expect(
      terminalRowToCandidate(
        terminalRow({
          terminal_event_id: 102,
          terminal_kind: "ended",
          terminal_event_kind: "SessionEnd",
          close_kind: null,
          kill_reason: null,
        }),
        100,
      )?.terminalKind,
    ).toBe("ended");

    for (const row of [
      terminalRow({ terminal_event_id: 100 }),
      terminalRow({ terminal_event_kind: "Stop" }),
      terminalRow({ last_lifecycle_at: 29 }),
      terminalRow({ terminal_kind: "working" }),
      terminalRow({ backend_exec_birth_session_id: "autopilot" }),
      terminalRow({ title: "fn-1296-notify-wrappers-when-legs-die" }),
    ]) {
      expect(terminalRowToCandidate(row, 100)).toBeNull();
    }
  });

  test("a post-fence seed-killed transition remains eligible", () => {
    const selected = terminalRowToCandidate(
      terminalRow({
        terminal_event_id: 501,
        kill_reason: "boot_pid_dead",
      }),
      500,
    );
    expect(selected).toMatchObject({
      terminalEventId: 501,
      terminalKind: "killed",
      failureDetail: "pane_closed: boot_pid_dead",
    });
  });
});

describe("unique live Dispatch-attempt owner", () => {
  test("requires one exact current attempt whose bind encloses Provider-leg birth", () => {
    expect(resolveUniqueEligibleWrapper(candidate(), [wrapper()])).toBe(
      "wrapper-1",
    );
    for (const row of [
      wrapper({ boundAt: 21 }),
      wrapper({ releasedAt: 22, claimState: "released" }),
      wrapper({ attemptId: null, legacyUnfenced: 1 }),
      wrapper({ state: "ended" }),
      wrapper({ dispatchOrigin: null }),
      wrapper({ planRef: "fn-1296-notify-wrappers-when-legs-die.3" }),
    ]) {
      expect(resolveUniqueEligibleWrapper(candidate(), [row])).toBeNull();
    }
  });

  test("durable ownership selects only the exact wrapper attempt, never a title peer", () => {
    const owned = candidate({
      legLaunchId: "leg-1",
      wrapperJobId: "wrapper-2",
      wrapperDispatchAttemptId: 8,
      ownershipEpochEventId: 99,
    });
    expect(
      resolveUniqueEligibleWrapper(owned, [
        wrapper(),
        wrapper({ jobId: "wrapper-2", attemptId: 8, planRef: "other-task" }),
      ]),
    ).toBe("wrapper-2");
  });

  test("zero or multiple eligible wrappers fail closed", () => {
    expect(resolveUniqueEligibleWrapper(candidate(), [])).toBeNull();
    expect(
      resolveUniqueEligibleWrapper(candidate(), [
        wrapper(),
        wrapper({ jobId: "wrapper-2" }),
      ]),
    ).toBeNull();
  });
});

describe("bounded versioned notice", () => {
  test("uses terminal event id as idempotency key and bounds attacker-influenced text", () => {
    const notice = buildProviderLegDeathNotice(
      candidate({
        failureDetail: "💀".repeat(2000),
        transcriptPath: `/${"x".repeat(5000)}`,
        abortEvidence: {
          status: "captured",
          detail: "🔥".repeat(2000),
          exit: { signal: "SIGKILL", code: null },
        },
      }),
    );
    expect(notice.payload).toMatchObject({
      schema_version: 2,
      kind: "provider_leg_died",
      terminal_event_id: 101,
      provider_leg_job_id: "provider-leg-1",
      task_id: "fn-1296-notify-wrappers-when-legs-die.2",
      terminal_kind: "killed",
      abort_capture: {
        status: "captured",
        exit: { signal: "SIGKILL", code: null },
      },
      truncated: true,
    });
    expect(
      Buffer.byteLength(notice.payload.failure_detail ?? "", "utf8"),
    ).toBeLessThanOrEqual(PROVIDER_LEG_DEATH_NOTICE_MAX_DETAIL_BYTES);
    expect(
      Buffer.byteLength(notice.payload.abort_capture.detail ?? "", "utf8"),
    ).toBeLessThanOrEqual(PROVIDER_LEG_DEATH_NOTICE_MAX_CAPTURE_BYTES);
    expect(Buffer.byteLength(notice.body, "utf8")).toBeLessThanOrEqual(
      PROVIDER_LEG_DEATH_NOTICE_MAX_BYTES,
    );
    expect(JSON.parse(notice.body)).toEqual(notice.payload);
  });

  test("the shared transport registers send_only and publishes JSON by exact job id", () => {
    expect(buildBusRegisterFrame(true, {}, 44)).toEqual({
      op: "register",
      namespace: "chat",
      namespaces: ["chat"],
      pid: 44,
      send_only: true,
    });
    const frame = buildBusPublishFrame(
      {
        path: "/ignored",
        ref: {
          id: "00000000000000000000000000000001",
          len: 12,
          sha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
      "wrapper-1",
      "application/json",
    );
    expect(frame.to).toBe("wrapper-1");
    expect(frame.payload.media_type).toBe("application/json");
    expect(frame).not.toHaveProperty("from");
  });
});

describe("launch-time abort capture", () => {
  const SHA = "93f1d67eee729503e7779aee4811aa342061803f";
  const UUID = "0c764f8c-4b33-4891-b041-d1bf3ba3c21a";

  test("redaction removes secret tokens but preserves SHAs and UUIDs", () => {
    const raw = [
      `provider leg ${UUID} at commit ${SHA} booting`,
      "ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
      "GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      "aws creds AKIAIOSFODNN7EXAMPLE and",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF123456",
    ].join("\n");
    const redacted = redactAbortEvidence(raw);

    // Safe forensic correlators survive untouched.
    expect(redacted).toContain(SHA);
    expect(redacted).toContain(UUID);

    // Every recognizable secret is gone.
    for (const secret of [
      "sk-ant-api03",
      "ghp_ABCDEFGHIJKLMNOP",
      "AKIAIOSFODNN7EXAMPLE",
      "wJalrXUtnFEMI",
      "eyJhbGciOiJIUzI1NiJ9",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("[REDACTED]");
  });

  test("an opaque non-JWT bearer token is redacted, the scheme word survives", () => {
    // No token-shape arm matches this value, so only the bearer path can redact
    // it — the regression guard for the AUTH key arm eating `Bearer`.
    const OPAQUE = "Zx9Kq2Lm7Pw4Rt6Yn1Bv";
    expect(redactAbortEvidence(`Authorization: Bearer ${OPAQUE}`)).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  test("a bearer-prefixed value with a non-space boundary still redacts", () => {
    // BEARER_RE only reaches a space-separated `bearer <token>`; a glued or
    // punctuated value that literally begins with `bearer` must stay caught by
    // the sensitive-key arm, or it leaks into persisted capture.
    const OPAQUE = "Zx9Kq2Lm7Pw4Rt6Yn1Bv";
    // Glued, no space after the scheme word.
    expect(redactAbortEvidence(`Authorization:Bearer${OPAQUE}`)).toBe(
      "Authorization:[REDACTED]",
    );
    // Punctuated `bearer.` prefix on an env-style key.
    expect(redactAbortEvidence("AUTH_TOKEN=bearer.foo")).toBe(
      "AUTH_TOKEN=[REDACTED]",
    );
    // Hyphen and equals boundaries after the scheme word.
    expect(redactAbortEvidence("AUTH_TOKEN=bearer-foo")).toBe(
      "AUTH_TOKEN=[REDACTED]",
    );
    expect(redactAbortEvidence("API_KEY: bearer=foo")).toBe(
      "API_KEY: [REDACTED]",
    );
  });

  test("exit status discriminates a signal death from a plain exit code", () => {
    expect(parseProviderLegExitStatus("137")).toEqual({
      signal: "SIGKILL",
      code: null,
    });
    expect(parseProviderLegExitStatus("134")).toEqual({
      signal: "SIGABRT",
      code: null,
    });
    expect(parseProviderLegExitStatus("1")).toEqual({
      signal: null,
      code: 1,
    });
    for (const garbage of [null, "", "not-a-number", "-4", "999"]) {
      expect(parseProviderLegExitStatus(garbage)).toEqual({
        signal: null,
        code: null,
      });
    }
  });

  test("a captured pane redacts, bounds, and structures its exit status", () => {
    const capture: WrappedLegAbortCapture = {
      status: "captured",
      rawText: `boot failed OPENAI_API_KEY=sk-${"A".repeat(40)} at ${SHA}`,
      paneDead: true,
      deadStatus: "137",
    };
    const evidence = assembleWrappedLegAbortPayload(capture);
    expect(evidence.status).toBe("captured");
    expect(evidence.detail).toContain(SHA);
    expect(evidence.detail).not.toContain("sk-AAAA");
    expect(evidence.detail).toContain("[REDACTED]");
    expect(evidence.exit).toEqual({ signal: "SIGKILL", code: null });
  });

  test("a huge capture is byte-bounded at the source", () => {
    const evidence = assembleWrappedLegAbortPayload({
      status: "captured",
      rawText: "x".repeat(50_000),
      paneDead: true,
      deadStatus: "1",
    });
    expect(
      Buffer.byteLength(evidence.detail ?? "", "utf8"),
    ).toBeLessThanOrEqual(PROVIDER_LEG_DEATH_NOTICE_MAX_CAPTURE_BYTES);
    expect(evidence.exit).toEqual({ signal: null, code: 1 });
  });

  test("an unavailable capture degrades to a typed marker, never raw text", () => {
    const evidence = assembleWrappedLegAbortPayload({
      status: "unavailable",
      reason: "pane absent or capture failed",
    });
    expect(evidence).toEqual({
      status: "unavailable",
      detail: "capture-unavailable: pane absent or capture failed",
      exit: { signal: null, code: null },
    });
  });

  test("the candidate reads abort evidence back off the immutable Killed payload", () => {
    const abort = assembleWrappedLegAbortPayload({
      status: "captured",
      rawText: "pi: boot aborted",
      paneDead: true,
      deadStatus: "134",
    });
    const withCapture = terminalRowToCandidate(
      terminalRow({
        terminal_event_data: JSON.stringify({
          pid: 4321,
          start_time: "111",
          close_kind: "pane_closed",
          reason: "exit_watched",
          abort_capture: abort,
        }),
      }),
      100,
    );
    expect(withCapture?.abortEvidence).toEqual(abort);

    // A malformed / absent payload folds to the unavailable marker, never throws.
    for (const data of [null, "not json{", JSON.stringify({ pid: 1 })]) {
      expect(
        terminalRowToCandidate(terminalRow({ terminal_event_data: data }), 100)
          ?.abortEvidence,
      ).toEqual({
        status: "unavailable",
        detail: null,
        exit: { signal: null, code: null },
      });
    }
  });
});

describe("bounded sweep and retry memo", () => {
  test("caps one tick and deduplicates terminal event ids", () => {
    const state = createProviderLegDeathNoticeState(100);
    const rows = Array.from(
      { length: PROVIDER_LEG_DEATH_NOTICE_SEND_CAP + 2 },
      (_, index) => terminalRow({ terminal_event_id: 101 + index }),
    );
    ingestProviderLegTerminalRows(state, rows, 1_000);
    expect(dueProviderLegDeathNotices(state, 1_000)).toHaveLength(
      PROVIDER_LEG_DEATH_NOTICE_SEND_CAP,
    );
    recordProviderLegNoticeResult(state, 101, { kind: "delivered" }, 1_000);
    ingestProviderLegTerminalRows(state, [rows[0]], 2_000);
    expect(state.pending.has(101)).toBe(false);
    expect(state.recentTerminalEventIds.get(101)).toBe("delivered");
  });

  test("the bounded memo never advances past unsaved burst candidates", () => {
    const state = createProviderLegDeathNoticeState(100);
    ingestProviderLegTerminalRows(
      state,
      Array.from({ length: 300 }, (_, index) =>
        terminalRow({ terminal_event_id: 101 + index }),
      ),
      1_000,
    );
    expect(state.pending.size).toBe(256);
    expect(state.scanAfterEventId).toBe(356);
    expect(state.scanMayHaveMore).toBe(true);
  });

  test("full scan pages schedule continuation without a new Fold", async () => {
    const state = createProviderLegDeathNoticeState(100);
    const selectedLimits: number[] = [];
    await runProviderLegDeathNoticeSweep(state, {
      selectTerminalRows: (_after, limit) => {
        selectedLimits.push(limit);
        return Array.from({ length: limit }, (_, index) =>
          terminalRow({ terminal_event_id: 101 + index }),
        );
      },
      selectWrapperAttempts: () => [],
      send: async () => ({ kind: "delivered" }),
      nowMs: () => 1_000,
    });
    expect(selectedLimits).toEqual([32]);
    expect(state.scanMayHaveMore).toBe(true);
  });

  test("ambiguous transport retries are bounded and keep the same event id", async () => {
    const state = createProviderLegDeathNoticeState(100);
    const sent: number[] = [];
    let now = 1_000;
    const deps = {
      selectTerminalRows: () => [terminalRow()],
      selectWrapperAttempts: () => [wrapper()],
      send: async (notice: ProviderLegDeathCandidate) => {
        sent.push(notice.terminalEventId);
        return {
          kind: "retry" as const,
          detail: "publish acknowledgement timed out",
          deliveryAmbiguous: true,
        };
      },
      nowMs: () => now,
    };
    await runProviderLegDeathNoticeSweep(state, deps);
    now += 250;
    await runProviderLegDeathNoticeSweep(state, {
      ...deps,
      selectTerminalRows: () => [],
    });
    now += 250;
    await runProviderLegDeathNoticeSweep(state, {
      ...deps,
      selectTerminalRows: () => [],
    });
    now += 250;
    await runProviderLegDeathNoticeSweep(state, {
      ...deps,
      selectTerminalRows: () => [],
    });
    expect(sent).toEqual([101, 101, 101]);
    expect(state.pending.size).toBe(0);
    expect(state.recentTerminalEventIds.get(101)).toBe("dropped");
  });

  test("a cascade-paged incident never sends a second death notice", async () => {
    const state = createProviderLegDeathNoticeState(100);
    let sends = 0;
    await runProviderLegDeathNoticeSweep(state, {
      selectTerminalRows: () => [
        terminalRow({
          leg_launch_id: "leg-1",
          wrapper_job_id: "wrapper-1",
          wrapper_dispatch_attempt_id: 7,
          ownership_epoch_event_id: 90,
          cascade_human_notified_at: 99,
        }),
      ],
      selectWrapperAttempts: () => [wrapper()],
      send: async () => {
        sends += 1;
        return { kind: "delivered" };
      },
      nowMs: () => 1_000,
    });
    expect(sends).toBe(0);
    expect(state.recentTerminalEventIds.get(101)).toBe("dropped");
  });

  test("an offline owner result is terminal and never retries", async () => {
    const state = createProviderLegDeathNoticeState(100);
    let sends = 0;
    await runProviderLegDeathNoticeSweep(state, {
      selectTerminalRows: () => [terminalRow()],
      selectWrapperAttempts: () => [wrapper()],
      send: async () => {
        sends += 1;
        return { kind: "drop", detail: "not_connected" };
      },
      nowMs: () => 1_000,
    });
    await runProviderLegDeathNoticeSweep(state, {
      selectTerminalRows: () => [],
      selectWrapperAttempts: () => [wrapper()],
      send: async () => {
        sends += 1;
        return { kind: "delivered" };
      },
      nowMs: () => 2_000,
    });
    expect(sends).toBe(1);
  });
});
