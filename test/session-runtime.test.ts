import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvelopeSink } from "../cli/envelope.ts";
import { main as runtimeMain } from "../cli/session-runtime.ts";
import { buildPiTelemetryPayload } from "../plugins/keeper/pi-extension/status-footer.ts";
import { buildSessionCatalog } from "../src/history/catalog.ts";
import type {
  KeeperJobAlias,
  NativeSessionArtifact,
  SessionCatalog,
} from "../src/history/model.ts";
import {
  buildSessionRuntimeData,
  type ExactRuntimeObservation,
  parseExactRuntimePayload,
  piRouteObservationPath,
  publishExactStatuslineRuntime,
  publishPiRouteObservation,
  readExactRuntimeObservation,
  readLatestPiRouteObservation,
  resolvePiRouteObservationDir,
} from "../src/session-runtime.ts";

const JOB_ID = "job-runtime-1";
const NATIVE_ID = "pi-runtime-1";
const NOW = 2_000;

function artifact(
  nativeId = NATIVE_ID,
  title = "Runtime session",
  path = `/history/${nativeId}.jsonl`,
): NativeSessionArtifact {
  return {
    harness: "pi",
    nativeId,
    path,
    project: "/work/runtime",
    currentTitle: title,
    titleHistory: [title],
    titleHistoryComplete: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    bytes: 10,
  };
}

function job(
  jobId = JOB_ID,
  nativeId = NATIVE_ID,
  title = "Runtime session",
): KeeperJobAlias {
  return {
    jobId,
    harness: "pi",
    nativeId,
    transcriptPath: null,
    project: "/work/runtime",
    currentTitle: title,
    titleHistory: [title],
    state: "working",
    createdAtMs: 1_000,
    updatedAtMs: 1_500,
    pid: 42,
    startTime: "start-42",
  };
}

function catalog(): SessionCatalog {
  return buildSessionCatalog([artifact()], [job()]);
}

function exactObservation(): ExactRuntimeObservation {
  return {
    schema_version: 1,
    session_id: JOB_ID,
    subject: {
      scope: "session",
      harness: "pi",
      job_id: JOB_ID,
      native_session_id: NATIVE_ID,
      agent_id: null,
    },
    observed_at_ms: 1_950,
    model_id: "gpt-5.3-codex",
    model_display: "GPT 5.3 Codex",
    effort_axis: "thinking",
    effort_level: "high",
    context_used_percentage: 42.75,
    context_input_tokens: 85_500,
    context_window_size: 200_000,
    route_hint: {
      alias: "keeper-codex-a",
      quota_scope: "generic",
    },
  };
}

function captureSink(): {
  sink: EnvelopeSink;
  json: () => Record<string, unknown>;
  code: () => number | null;
} {
  let text = "";
  let code: number | null = null;
  return {
    sink: {
      writeStdout(value) {
        text += value;
      },
      exit(value): never {
        code = value;
        return undefined as never;
      },
    },
    json: () => JSON.parse(text) as Record<string, unknown>,
    code: () => code,
  };
}

async function runRuntime(
  reference: string[],
  options: {
    catalog?: SessionCatalog;
    env?: NodeJS.ProcessEnv;
    exact?: ExactRuntimeObservation | null;
    route?: ReturnType<typeof readLatestPiRouteObservation>;
    coalesced?: {
      model_id: string | null;
      model_display: string | null;
      effort: string | null;
      used_percentage: number | null;
      input_tokens: number | null;
      window_size: number | null;
    } | null;
    coalescedRead?: () => void;
  } = {},
): Promise<{ body: Record<string, unknown>; code: number | null }> {
  const captured = captureSink();
  await runtimeMain(
    reference,
    {
      catalog: options.catalog ?? catalog(),
      env: options.env ?? {},
      now: () => NOW,
      runtimeDir: "/unused/runtime",
      readExact: () => options.exact ?? null,
      readRoute: () => options.route ?? null,
      readCoalesced: () => {
        options.coalescedRead?.();
        return options.coalesced ?? null;
      },
    },
    captured.sink,
  );
  return { body: captured.json(), code: captured.code() };
}

describe("session runtime envelope", () => {
  test("explicit and ambient shared Session references emit the same exact schema-v1 data", async () => {
    const exact = exactObservation();
    const route = {
      schema_version: 1 as const,
      subject_scope: "session" as const,
      job_id: JOB_ID,
      native_session_id: NATIVE_ID,
      agent_id: null,
      quota_scope: "generic" as const,
      state: "selected" as const,
      alias: "keeper-codex-b",
      observed_at_ms: 1_975,
    };
    let coalescedReads = 0;
    const explicit = await runRuntime(["Runtime session"], {
      exact,
      route,
      coalescedRead: () => coalescedReads++,
    });
    const ambient = await runRuntime([], {
      env: { KEEPER_JOB_ID: JOB_ID },
      exact,
      route,
      coalescedRead: () => coalescedReads++,
    });
    const expected = {
      schema_version: 1,
      ok: true,
      error: null,
      data: {
        subject: {
          scope: "session",
          harness: "pi",
          job_id: JOB_ID,
          native_session_id: NATIVE_ID,
          agent_id: null,
        },
        source: "exact",
        freshness: "current",
        observed_at_ms: 1_950,
        generated_at_ms: 2_000,
        model: {
          status: "available",
          id: "gpt-5.3-codex",
          display_name: "GPT 5.3 Codex",
        },
        effort: { status: "available", axis: "thinking", level: "high" },
        context: {
          status: "available",
          used_percentage: 42.75,
          input_tokens: 85_500,
          window_size: 200_000,
        },
        route: {
          provenance: "scoped_actual",
          state: "selected",
          alias: "keeper-codex-b",
          quota_scope: "generic",
          observed_at_ms: 1_975,
        },
      },
    };
    expect(explicit).toEqual({ body: expected, code: 0 });
    expect(ambient).toEqual({ body: expected, code: 0 });
    expect(coalescedReads).toBe(0);
  });

  test("missing and ambiguous references use the standard Session problem envelopes", async () => {
    const missing = await runRuntime(["does-not-exist"]);
    expect(missing.code).toBe(1);
    expect(missing.body).toEqual({
      schema_version: 1,
      ok: false,
      error: {
        code: "session_not_found",
        message: "no Session matched the supplied reference",
        recovery:
          "Run `keeper history list --format json` and retry with a qualified native id, exact job id, or exact title.",
      },
      data: null,
    });

    const ambiguousCatalog = buildSessionCatalog(
      [
        artifact("pi-first", "Shared runtime", "/history/first.jsonl"),
        artifact("pi-second", "Shared runtime", "/history/second.jsonl"),
      ],
      [
        job("job-first", "pi-first", "Shared runtime"),
        job("job-second", "pi-second", "Shared runtime"),
      ],
    );
    const ambiguous = await runRuntime(["Shared runtime"], {
      catalog: ambiguousCatalog,
    });
    expect(ambiguous.code).toBe(1);
    expect((ambiguous.body.error as { code: string }).code).toBe(
      "session_ambiguous",
    );
    expect(
      (ambiguous.body.error as { details: { candidate_count: number } }).details
        .candidate_count,
    ).toBe(2);
  });

  test("old Sessions label jobs fallback as coalesced and preserve unavailable values", async () => {
    const result = await runRuntime([JOB_ID], {
      coalesced: {
        model_id: "claude-opus-4-8",
        model_display: null,
        effort: "xhigh",
        used_percentage: 40,
        input_tokens: null,
        window_size: 200_000,
      },
    });
    expect(result.code).toBe(0);
    expect(result.body).toEqual({
      schema_version: 1,
      ok: true,
      error: null,
      data: {
        subject: {
          scope: "job",
          harness: "pi",
          job_id: JOB_ID,
          native_session_id: NATIVE_ID,
          agent_id: null,
        },
        source: "coalesced",
        freshness: "unknown",
        observed_at_ms: null,
        generated_at_ms: NOW,
        model: {
          status: "partial",
          id: "claude-opus-4-8",
          display_name: null,
        },
        effort: { status: "available", axis: "thinking", level: "xhigh" },
        context: {
          status: "partial",
          used_percentage: 40,
          input_tokens: null,
          window_size: 200_000,
        },
        route: {
          provenance: "unavailable",
          state: "unavailable",
          alias: null,
          quota_scope: null,
          observed_at_ms: null,
        },
      },
    });
  });
});

describe("runtime subject and route provenance", () => {
  test("Pi telemetry carries proven native identity and labels the launch alias only as a hint", () => {
    const previous = {
      mode: process.env.KEEPER_PI_CODEX_POOL_MODE,
      alias: process.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS,
      scope: process.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE,
    };
    process.env.KEEPER_PI_CODEX_POOL_MODE = "active";
    process.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS = "keeper-codex-a";
    process.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE = "generic";
    try {
      const payload = buildPiTelemetryPayload(
        JOB_ID,
        {
          cwd: "/work/runtime",
          model: { id: "gpt-5.3-codex", name: "Codex", contextWindow: 200_000 },
          sessionManager: { getSessionId: () => NATIVE_ID },
          getContextUsage: () => ({
            percent: null,
            tokens: null,
            contextWindow: 200_000,
          }),
          ui: {},
        },
        "high",
        "1.0.0",
      );
      const parsed = parseExactRuntimePayload(payload, 1_950);
      const data = buildSessionRuntimeData(
        { jobId: JOB_ID, harness: "pi", nativeSessionId: NATIVE_ID },
        { exact: parsed, coalesced: null, route: null, now: NOW },
      );
      expect(data.subject).toEqual({
        scope: "session",
        harness: "pi",
        job_id: JOB_ID,
        native_session_id: NATIVE_ID,
        agent_id: null,
      });
      expect(data.route).toEqual({
        provenance: "launch_hint",
        state: "hint",
        alias: "keeper-codex-a",
        quota_scope: "generic",
        observed_at_ms: 1_950,
      });
      expect(data.context).toEqual({
        status: "partial",
        used_percentage: null,
        input_tokens: null,
        window_size: 200_000,
      });
    } finally {
      if (previous.mode === undefined)
        delete process.env.KEEPER_PI_CODEX_POOL_MODE;
      else process.env.KEEPER_PI_CODEX_POOL_MODE = previous.mode;
      if (previous.alias === undefined)
        delete process.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS;
      else process.env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS = previous.alias;
      if (previous.scope === undefined)
        delete process.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE;
      else process.env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE = previous.scope;
    }
  });

  test("nested and unsupported sources never become agent-local or fabricate zero", () => {
    const nested = parseExactRuntimePayload(
      JSON.stringify({
        session_id: "claude-parent",
        agent: { id: "agent-child" },
        model: { id: "claude-opus-4-8" },
        effort: {},
        context_window: { current_usage: null },
      }),
      100,
    );
    const nestedData = buildSessionRuntimeData(
      {
        jobId: "claude-parent",
        harness: "claude",
        nativeSessionId: "claude-parent",
      },
      { exact: nested, coalesced: null, route: null, now: 110 },
    );
    expect(nestedData.subject).toEqual({
      scope: "parent",
      harness: "claude",
      job_id: "claude-parent",
      native_session_id: "claude-parent",
      agent_id: "agent-child",
    });
    expect(nestedData.effort).toEqual({
      status: "unavailable",
      axis: "effort",
      level: null,
    });
    expect(nestedData.context).toEqual({
      status: "unavailable",
      used_percentage: null,
      input_tokens: null,
      window_size: null,
    });
    expect(JSON.stringify(nestedData)).not.toContain(":0");

    const unsupported = parseExactRuntimePayload(
      JSON.stringify({
        session_id: JOB_ID,
        keeper_runtime: {
          schema_version: 1,
          subject: {
            scope: "agent",
            harness: "pi",
            job_id: JOB_ID,
            native_session_id: NATIVE_ID,
          },
          effort_axis: "thinking",
        },
      }),
      100,
    );
    expect(unsupported?.subject.scope).toBe("job");
    expect(unsupported?.subject.agent_id).toBeNull();
    expect(unsupported?.effort_axis).toBe("unavailable");
  });

  test("route retirement overrides the initial hint with proven scoped unavailability", () => {
    const data = buildSessionRuntimeData(
      { jobId: JOB_ID, harness: "pi", nativeSessionId: NATIVE_ID },
      {
        exact: exactObservation(),
        coalesced: null,
        route: {
          schema_version: 1,
          subject_scope: "session",
          job_id: JOB_ID,
          native_session_id: NATIVE_ID,
          agent_id: null,
          quota_scope: "generic",
          state: "retired",
          alias: null,
          observed_at_ms: 1_980,
        },
        now: NOW,
      },
    );
    expect(data.route).toEqual({
      provenance: "scoped_actual",
      state: "retired",
      alias: null,
      quota_scope: "generic",
      observed_at_ms: 1_980,
    });
  });
});

describe("runtime artifacts", () => {
  test("exact and route artifacts serialize allowlisted data only", () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-runtime-sanitize-"));
    const secret = "Bearer secret-canary owner@example.test raw-provider-error";
    const payload = JSON.stringify({
      session_id: JOB_ID,
      model: { id: "gpt-5.3-codex", display_name: "Codex" },
      effort: { level: "high" },
      context_window: { used_percentage: 10 },
      provider: secret,
      api_key: secret,
      error: secret,
      keeper_runtime: {
        schema_version: 1,
        subject: {
          scope: "session",
          harness: "pi",
          job_id: JOB_ID,
          native_session_id: NATIVE_ID,
          agent_id: null,
        },
        effort_axis: "thinking",
        route_hint: { alias: secret, quota_scope: "generic" },
        raw_error: secret,
      },
    });
    expect(publishExactStatuslineRuntime(payload, root, 100)).toBe(true);
    const exact = readExactRuntimeObservation(JOB_ID, root);
    expect(exact?.route_hint).toBeNull();

    expect(
      publishPiRouteObservation(
        {
          schema_version: 1,
          subject_scope: "session",
          job_id: JOB_ID,
          native_session_id: NATIVE_ID,
          agent_id: null,
          quota_scope: "generic",
          state: "selected",
          alias: "keeper-codex-a",
          observed_at_ms: 101,
          raw_error: secret,
          provider: secret,
          credential: secret,
        } as never,
        root,
      ),
    ).toBe(true);
    const routePath = piRouteObservationPath(
      resolvePiRouteObservationDir(root),
      NATIVE_ID,
      "generic",
    );
    const serialized = `${JSON.stringify(exact)}${readFileSync(routePath, "utf8")}`;
    expect(serialized).not.toContain("secret-canary");
    expect(serialized).not.toContain("owner@example.test");
    expect(serialized).not.toContain("raw-provider-error");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("provider");
  });

  test("same-timestamp scope switches read the requested model scope", () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-runtime-scope-"));
    for (const observation of [
      {
        quota_scope: "generic" as const,
        alias: "keeper-codex-a",
      },
      {
        quota_scope: "model:gpt-5.3-codex-spark" as const,
        alias: "keeper-codex-b",
      },
    ]) {
      expect(
        publishPiRouteObservation(
          {
            schema_version: 1,
            subject_scope: "session",
            job_id: JOB_ID,
            native_session_id: NATIVE_ID,
            agent_id: null,
            state: "selected",
            observed_at_ms: 500,
            ...observation,
          },
          root,
        ),
      ).toBe(true);
    }
    expect(
      readLatestPiRouteObservation(
        { jobId: JOB_ID, harness: "pi", nativeSessionId: NATIVE_ID },
        root,
        "model:gpt-5.3-codex-spark",
      ),
    ).toEqual({
      schema_version: 1,
      subject_scope: "session",
      job_id: JOB_ID,
      native_session_id: NATIVE_ID,
      agent_id: null,
      quota_scope: "model:gpt-5.3-codex-spark",
      state: "selected",
      alias: "keeper-codex-b",
      observed_at_ms: 500,
    });
  });

  test("route observations evict to the fixed artifact bound", () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-runtime-bound-"));
    for (let index = 0; index < 265; index += 1) {
      expect(
        publishPiRouteObservation(
          {
            schema_version: 1,
            subject_scope: "session",
            job_id: `job-${index}`,
            native_session_id: `native-${index}`,
            agent_id: null,
            quota_scope: "generic",
            state: "selected",
            alias: "keeper-codex-a",
            observed_at_ms: 1_000 + index,
          },
          root,
        ),
      ).toBe(true);
    }
    expect(readdirSync(resolvePiRouteObservationDir(root))).toHaveLength(256);
  });
});
