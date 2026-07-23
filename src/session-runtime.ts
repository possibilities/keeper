import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_QUOTA_SCOPES,
  type CodexQuotaScope,
  isCodexQuotaScope,
} from "./codex-quota-scope.ts";

export const SESSION_RUNTIME_SCHEMA_VERSION = 1;
export const RUNTIME_CURRENT_MAX_AGE_MS = 2 * 60 * 1000;
export const MAX_RUNTIME_ARTIFACTS = 256;
const MAX_EXACT_BYTES = 16 * 1024;
const MAX_ROUTE_BYTES = 4 * 1024;
const MAX_ID_BYTES = 256;
const MAX_TEXT_BYTES = 256;

export type RuntimeSubjectScope = "session" | "parent" | "job" | "unavailable";
export type RuntimeSource = "exact" | "coalesced" | "unavailable";
export type RuntimeFreshness = "current" | "stale" | "unknown" | "unavailable";
export type RuntimeAvailability = "available" | "partial" | "unavailable";
export type RuntimeEffortAxis = "effort" | "thinking" | "unavailable";
export type RuntimeRouteProvenance =
  | "scoped_actual"
  | "launch_hint"
  | "unavailable";
export type RuntimeRouteState = "selected" | "retired" | "hint" | "unavailable";

export interface RuntimeSubject {
  scope: RuntimeSubjectScope;
  harness: "claude" | "pi" | null;
  job_id: string;
  native_session_id: string | null;
  agent_id: string | null;
}

export interface RuntimeMeasurements {
  model: {
    status: RuntimeAvailability;
    id: string | null;
    display_name: string | null;
  };
  effort: {
    status: RuntimeAvailability;
    axis: RuntimeEffortAxis;
    level: string | null;
  };
  context: {
    status: RuntimeAvailability;
    used_percentage: number | null;
    input_tokens: number | null;
    window_size: number | null;
  };
}

export interface RuntimeRouteView {
  provenance: RuntimeRouteProvenance;
  state: RuntimeRouteState;
  alias: string | null;
  quota_scope: CodexQuotaScope | null;
  observed_at_ms: number | null;
}

export interface SessionRuntimeData extends RuntimeMeasurements {
  subject: RuntimeSubject;
  source: RuntimeSource;
  freshness: RuntimeFreshness;
  observed_at_ms: number | null;
  generated_at_ms: number;
  route: RuntimeRouteView;
}

export interface ExactRuntimeObservation {
  schema_version: 1;
  session_id: string;
  subject: RuntimeSubject;
  observed_at_ms: number;
  model_id: string | null;
  model_display: string | null;
  effort_axis: RuntimeEffortAxis;
  effort_level: string | null;
  context_used_percentage: number | null;
  context_input_tokens: number | null;
  context_window_size: number | null;
  route_hint: {
    alias: string;
    quota_scope: CodexQuotaScope;
  } | null;
}

export interface CoalescedRuntimeSample {
  model_id: string | null;
  model_display: string | null;
  effort: string | null;
  used_percentage: number | null;
  input_tokens: number | null;
  window_size: number | null;
}

export interface PiRouteObservation {
  schema_version: 1;
  subject_scope: RuntimeSubjectScope;
  job_id: string;
  native_session_id: string | null;
  agent_id: string | null;
  quota_scope: CodexQuotaScope;
  state: "selected" | "retired";
  alias: string | null;
  observed_at_ms: number;
}

export interface RuntimeTarget {
  jobId: string;
  harness: "claude" | "pi";
  nativeSessionId: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maxBytes = MAX_TEXT_BYTES): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (
    Buffer.byteLength(value, "utf8") > maxBytes ||
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return null;
  }
  return value;
}

function safeId(value: unknown): string | null {
  const text = boundedText(value, MAX_ID_BYTES);
  return text !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)
    ? text
    : null;
}

export function isOpaqueRuntimeAlias(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^keeper-codex-[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(value)
  );
}

function finiteNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function effortLevel(value: unknown): string | null {
  return typeof value === "string" &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
    ? value
    : null;
}

function runtimeSubject(
  sessionId: string,
  payload: Record<string, unknown>,
): {
  subject: RuntimeSubject;
  effortAxis: RuntimeEffortAxis;
  routeHint: ExactRuntimeObservation["route_hint"];
} {
  const metadata = record(payload.keeper_runtime);
  if (metadata === null) {
    const nested = record(payload.agent);
    return {
      subject: {
        scope: nested === null ? "session" : "parent",
        harness: "claude",
        job_id: sessionId,
        native_session_id: sessionId,
        agent_id: nested === null ? null : safeId(nested.id ?? nested.agent_id),
      },
      effortAxis: "effort",
      routeHint: null,
    };
  }

  const subject = record(metadata.subject);
  const jobId = subject === null ? null : safeId(subject.job_id);
  const nativeId = subject === null ? null : safeId(subject.native_session_id);
  const agentId = subject === null ? null : safeId(subject.agent_id);
  const scope = subject?.scope;
  const harness = subject?.harness;
  const validScope =
    scope === "session" || scope === "parent" || scope === "job";
  const valid =
    metadata.schema_version === 1 &&
    jobId === sessionId &&
    harness === "pi" &&
    validScope &&
    (scope === "job" || nativeId !== null);
  if (!valid) {
    return {
      subject: {
        scope: "job",
        harness: null,
        job_id: sessionId,
        native_session_id: null,
        agent_id: null,
      },
      effortAxis: "unavailable",
      routeHint: null,
    };
  }

  const hint = record(metadata.route_hint);
  const routeHint =
    hint !== null &&
    isOpaqueRuntimeAlias(hint.alias) &&
    isCodexQuotaScope(hint.quota_scope)
      ? { alias: hint.alias, quota_scope: hint.quota_scope }
      : null;
  return {
    subject: {
      scope,
      harness: "pi",
      job_id: sessionId,
      native_session_id: nativeId,
      agent_id: agentId,
    },
    effortAxis:
      metadata.effort_axis === "thinking" ? "thinking" : "unavailable",
    routeHint,
  };
}

export function parseExactRuntimePayload(
  raw: string,
  now: number,
): ExactRuntimeObservation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const payload = record(parsed);
  const sessionId = payload === null ? null : safeId(payload.session_id);
  const observedAt = timestamp(now);
  if (payload === null || sessionId === null || observedAt === null)
    return null;

  const model = record(payload.model);
  const effort = record(payload.effort);
  const context = record(payload.context_window);
  const provenance = runtimeSubject(sessionId, payload);
  return {
    schema_version: 1,
    session_id: sessionId,
    subject: provenance.subject,
    observed_at_ms: observedAt,
    model_id: model === null ? null : boundedText(model.id),
    model_display: model === null ? null : boundedText(model.display_name),
    effort_axis: provenance.effortAxis,
    effort_level: effort === null ? null : effortLevel(effort.level),
    context_used_percentage:
      context === null ? null : finiteNumber(context.used_percentage, 0, 100),
    context_input_tokens:
      context === null ? null : nonnegativeInteger(context.total_input_tokens),
    context_window_size:
      context === null ? null : nonnegativeInteger(context.context_window_size),
    route_hint: provenance.routeHint,
  };
}

export function resolveSessionRuntimeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.KEEPER_SESSION_RUNTIME_DIR?.trim();
  return (
    override || join(homedir(), ".local", "state", "keeper", "session-runtime")
  );
}

export function resolvePiRouteObservationDir(runtimeDir: string): string {
  return join(runtimeDir, "routes");
}

function artifactToken(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

export function exactRuntimePath(root: string, sessionId: string): string {
  return join(root, `${artifactToken(sessionId)}.json`);
}

export function piRouteObservationPath(
  root: string,
  nativeSessionId: string,
  quotaScope: CodexQuotaScope,
): string {
  return join(root, `${artifactToken(nativeSessionId, quotaScope)}.json`);
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function boundArtifacts(dir: string, keepPath: string): void {
  const entries = readdirSync(dir)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => {
      const path = join(dir, name);
      try {
        return { path, mtime: statSync(path).mtimeMs, name };
      } catch {
        return null;
      }
    })
    .filter(
      (entry): entry is { path: string; mtime: number; name: string } =>
        entry !== null,
    )
    .sort(
      (left, right) =>
        left.mtime - right.mtime || left.name.localeCompare(right.name),
    );
  const removable = entries.filter((entry) => entry.path !== keepPath);
  for (const entry of removable.slice(
    0,
    Math.max(0, entries.length - MAX_RUNTIME_ARTIFACTS),
  )) {
    try {
      unlinkSync(entry.path);
    } catch {}
  }
}

function writePrivateAtomic(path: string, value: unknown): boolean {
  const dir = dirname(path);
  const tmp = join(dir, `.${artifactToken(path)}.${process.pid}.tmp`);
  try {
    ensurePrivateDir(dir);
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    boundArtifacts(dir, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
    return false;
  }
}

export function publishExactRuntimeObservation(
  observation: ExactRuntimeObservation,
  root = resolveSessionRuntimeDir(),
): boolean {
  const normalized = normalizeExactObservation(observation);
  return normalized === null
    ? false
    : writePrivateAtomic(
        exactRuntimePath(root, normalized.session_id),
        normalized,
      );
}

export function publishExactStatuslineRuntime(
  raw: string,
  root: string,
  now: number,
): boolean {
  const observation = parseExactRuntimePayload(raw, now);
  return (
    observation !== null && publishExactRuntimeObservation(observation, root)
  );
}

function normalizeExactObservation(
  value: unknown,
): ExactRuntimeObservation | null {
  const item = record(value);
  if (item?.schema_version !== 1) return null;
  const sessionId = safeId(item.session_id);
  const subject = record(item.subject);
  const observedAt = timestamp(item.observed_at_ms);
  const jobId = subject === null ? null : safeId(subject.job_id);
  const nativeId = subject === null ? null : safeId(subject.native_session_id);
  const agentId = subject === null ? null : safeId(subject.agent_id);
  const scope = subject?.scope;
  const harness = subject?.harness;
  const axis = item.effort_axis;
  if (
    sessionId === null ||
    observedAt === null ||
    jobId !== sessionId ||
    !["session", "parent", "job", "unavailable"].includes(String(scope)) ||
    !["claude", "pi", null].includes(harness as "claude" | "pi" | null) ||
    !["effort", "thinking", "unavailable"].includes(String(axis))
  ) {
    return null;
  }
  const hint = record(item.route_hint);
  const routeHint =
    hint !== null &&
    isOpaqueRuntimeAlias(hint.alias) &&
    isCodexQuotaScope(hint.quota_scope)
      ? { alias: hint.alias, quota_scope: hint.quota_scope }
      : null;
  return {
    schema_version: 1,
    session_id: sessionId,
    subject: {
      scope: scope as RuntimeSubjectScope,
      harness: harness as "claude" | "pi" | null,
      job_id: jobId,
      native_session_id: nativeId,
      agent_id: agentId,
    },
    observed_at_ms: observedAt,
    model_id: boundedText(item.model_id),
    model_display: boundedText(item.model_display),
    effort_axis: axis as RuntimeEffortAxis,
    effort_level: effortLevel(item.effort_level),
    context_used_percentage: finiteNumber(item.context_used_percentage, 0, 100),
    context_input_tokens: nonnegativeInteger(item.context_input_tokens),
    context_window_size: nonnegativeInteger(item.context_window_size),
    route_hint: routeHint,
  };
}

function readBoundedJson(path: string, maxBytes: number): unknown {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > maxBytes) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readExactRuntimeObservation(
  sessionId: string,
  root = resolveSessionRuntimeDir(),
): ExactRuntimeObservation | null {
  try {
    const parsed = readBoundedJson(
      exactRuntimePath(root, sessionId),
      MAX_EXACT_BYTES,
    );
    const normalized = normalizeExactObservation(parsed);
    return normalized?.session_id === sessionId ? normalized : null;
  } catch {
    return null;
  }
}

function normalizeRouteObservation(value: unknown): PiRouteObservation | null {
  const item = record(value);
  if (item?.schema_version !== 1) return null;
  const scope = item.subject_scope;
  const jobId = safeId(item.job_id);
  const nativeId = safeId(item.native_session_id);
  const agentId = safeId(item.agent_id);
  const observedAt = timestamp(item.observed_at_ms);
  const state = item.state;
  const alias = isOpaqueRuntimeAlias(item.alias) ? item.alias : null;
  if (
    !["session", "parent", "job", "unavailable"].includes(String(scope)) ||
    jobId === null ||
    !isCodexQuotaScope(item.quota_scope) ||
    observedAt === null ||
    (state !== "selected" && state !== "retired") ||
    (state === "selected" && alias === null) ||
    (state === "retired" && item.alias !== null) ||
    ((scope === "session" || scope === "parent") && nativeId === null)
  ) {
    return null;
  }
  return {
    schema_version: 1,
    subject_scope: scope as RuntimeSubjectScope,
    job_id: jobId,
    native_session_id: nativeId,
    agent_id: agentId,
    quota_scope: item.quota_scope,
    state,
    alias,
    observed_at_ms: observedAt,
  };
}

export function publishPiRouteObservation(
  observation: PiRouteObservation,
  runtimeRoot = resolveSessionRuntimeDir(),
): boolean {
  const normalized = normalizeRouteObservation(observation);
  if (normalized === null || normalized.native_session_id === null)
    return false;
  const root = resolvePiRouteObservationDir(runtimeRoot);
  return writePrivateAtomic(
    piRouteObservationPath(
      root,
      normalized.native_session_id,
      normalized.quota_scope,
    ),
    normalized,
  );
}

export function readLatestPiRouteObservation(
  target: RuntimeTarget,
  runtimeRoot = resolveSessionRuntimeDir(),
  preferredScope?: CodexQuotaScope,
): PiRouteObservation | null {
  const root = resolvePiRouteObservationDir(runtimeRoot);
  const observations: PiRouteObservation[] = [];
  for (const scope of CODEX_QUOTA_SCOPES) {
    try {
      const value = readBoundedJson(
        piRouteObservationPath(root, target.nativeSessionId, scope),
        MAX_ROUTE_BYTES,
      );
      const normalized = normalizeRouteObservation(value);
      if (
        normalized !== null &&
        normalized.subject_scope === "session" &&
        normalized.job_id === target.jobId &&
        normalized.native_session_id === target.nativeSessionId
      ) {
        observations.push(normalized);
      }
    } catch {}
  }
  if (preferredScope !== undefined) {
    const preferred = observations.find(
      (observation) => observation.quota_scope === preferredScope,
    );
    if (preferred !== undefined) return preferred;
  }
  return (
    observations.sort(
      (left, right) =>
        right.observed_at_ms - left.observed_at_ms ||
        left.quota_scope.localeCompare(right.quota_scope),
    )[0] ?? null
  );
}

function availability(values: readonly unknown[]): RuntimeAvailability {
  const count = values.filter((value) => value !== null).length;
  return count === 0
    ? "unavailable"
    : count === values.length
      ? "available"
      : "partial";
}

function measurements(values: {
  modelId: string | null;
  modelDisplay: string | null;
  effortAxis: RuntimeEffortAxis;
  effortLevel: string | null;
  usedPercentage: number | null;
  inputTokens: number | null;
  windowSize: number | null;
}): RuntimeMeasurements {
  return {
    model: {
      status: availability([values.modelId, values.modelDisplay]),
      id: values.modelId,
      display_name: values.modelDisplay,
    },
    effort: {
      status: values.effortLevel === null ? "unavailable" : "available",
      axis: values.effortAxis,
      level: values.effortLevel,
    },
    context: {
      status: availability([
        values.usedPercentage,
        values.inputTokens,
        values.windowSize,
      ]),
      used_percentage: values.usedPercentage,
      input_tokens: values.inputTokens,
      window_size: values.windowSize,
    },
  };
}

function unavailableRoute(): RuntimeRouteView {
  return {
    provenance: "unavailable",
    state: "unavailable",
    alias: null,
    quota_scope: null,
    observed_at_ms: null,
  };
}

function exactSubject(
  target: RuntimeTarget,
  exact: ExactRuntimeObservation,
): RuntimeSubject {
  const claimsNative =
    exact.subject.native_session_id !== null &&
    exact.subject.native_session_id === target.nativeSessionId;
  const claimsHarness = exact.subject.harness === target.harness;
  if (
    exact.subject.job_id !== target.jobId ||
    !claimsHarness ||
    ((exact.subject.scope === "session" || exact.subject.scope === "parent") &&
      !claimsNative)
  ) {
    return {
      scope: "job",
      harness: target.harness,
      job_id: target.jobId,
      native_session_id: target.nativeSessionId,
      agent_id: null,
    };
  }
  return {
    ...exact.subject,
    harness: target.harness,
    job_id: target.jobId,
    native_session_id:
      exact.subject.native_session_id ?? target.nativeSessionId,
  };
}

export function buildSessionRuntimeData(
  target: RuntimeTarget,
  input: {
    exact: ExactRuntimeObservation | null;
    coalesced: CoalescedRuntimeSample | null;
    route: PiRouteObservation | null;
    now: number;
  },
): SessionRuntimeData {
  const generatedAt = timestamp(input.now) ?? 0;
  if (input.exact !== null && input.exact.session_id === target.jobId) {
    const exact = input.exact;
    const subject = exactSubject(target, exact);
    let route = unavailableRoute();
    if (
      subject.scope === "session" &&
      input.route !== null &&
      input.route.job_id === target.jobId &&
      input.route.native_session_id === target.nativeSessionId
    ) {
      route = {
        provenance: "scoped_actual",
        state: input.route.state,
        alias: input.route.alias,
        quota_scope: input.route.quota_scope,
        observed_at_ms: input.route.observed_at_ms,
      };
    } else if (subject.scope === "session" && exact.route_hint !== null) {
      route = {
        provenance: "launch_hint",
        state: "hint",
        alias: exact.route_hint.alias,
        quota_scope: exact.route_hint.quota_scope,
        observed_at_ms: exact.observed_at_ms,
      };
    }
    const age = generatedAt - exact.observed_at_ms;
    return {
      subject,
      source: "exact",
      freshness:
        age >= 0 && age <= RUNTIME_CURRENT_MAX_AGE_MS ? "current" : "stale",
      observed_at_ms: exact.observed_at_ms,
      generated_at_ms: generatedAt,
      ...measurements({
        modelId: exact.model_id,
        modelDisplay: exact.model_display,
        effortAxis: exact.effort_axis,
        effortLevel: exact.effort_level,
        usedPercentage: exact.context_used_percentage,
        inputTokens: exact.context_input_tokens,
        windowSize: exact.context_window_size,
      }),
      route,
    };
  }

  const coalesced = input.coalesced;
  const hasCoalesced =
    coalesced !== null &&
    Object.values(coalesced).some((value) => value !== null);
  if (coalesced !== null && hasCoalesced) {
    return {
      subject: {
        scope: "job",
        harness: target.harness,
        job_id: target.jobId,
        native_session_id: target.nativeSessionId,
        agent_id: null,
      },
      source: "coalesced",
      freshness: "unknown",
      observed_at_ms: null,
      generated_at_ms: generatedAt,
      ...measurements({
        modelId: coalesced.model_id,
        modelDisplay: coalesced.model_display,
        effortAxis: target.harness === "pi" ? "thinking" : "effort",
        effortLevel: coalesced.effort,
        usedPercentage: coalesced.used_percentage,
        inputTokens: coalesced.input_tokens,
        windowSize: coalesced.window_size,
      }),
      route: unavailableRoute(),
    };
  }

  return {
    subject: {
      scope: "unavailable",
      harness: target.harness,
      job_id: target.jobId,
      native_session_id: target.nativeSessionId,
      agent_id: null,
    },
    source: "unavailable",
    freshness: "unavailable",
    observed_at_ms: null,
    generated_at_ms: generatedAt,
    ...measurements({
      modelId: null,
      modelDisplay: null,
      effortAxis: "unavailable",
      effortLevel: null,
      usedPercentage: null,
      inputTokens: null,
      windowSize: null,
    }),
    route: unavailableRoute(),
  };
}

export function piLaunchRouteHint(
  env: NodeJS.ProcessEnv = process.env,
): ExactRuntimeObservation["route_hint"] {
  if (env.KEEPER_PI_CODEX_POOL_MODE !== "active") return null;
  const alias = env.KEEPER_PI_CODEX_POOL_INITIAL_ALIAS?.trim();
  const rawScope = env.KEEPER_PI_CODEX_POOL_INITIAL_SCOPE?.trim();
  const scope =
    rawScope === "" || rawScope === undefined
      ? CODEX_GENERIC_QUOTA_SCOPE
      : rawScope;
  return isOpaqueRuntimeAlias(alias) && isCodexQuotaScope(scope)
    ? { alias, quota_scope: scope }
    : null;
}
