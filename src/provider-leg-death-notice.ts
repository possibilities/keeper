import { parseWrappedProviderTaskId } from "./autoclose-worker";
import type { PublishedBusArtifact } from "./bus-artifact";
import {
  encodeBusArtifactRef,
  publishBusArtifact,
  removeBusArtifact,
  resolveBusArtifactRoot,
} from "./bus-artifact";
import type { WrappedLegAbortCapture } from "./exec-backend";

// Schema v2 adds the launch-time abort capture (redacted, bounded pane
// scrollback or a typed capture-unavailable marker) and a structured exit
// signal/code field to the v1 death-notice shape.
export const PROVIDER_LEG_DEATH_NOTICE_SCHEMA_VERSION = 2;
export const PROVIDER_LEG_DEATH_NOTICE_MAX_BYTES = 8192;
export const PROVIDER_LEG_DEATH_NOTICE_MAX_DETAIL_BYTES = 1024;
// Byte cap on the redacted abort-capture text carried in the notice. Bounded
// well under MAX_BYTES so the capture can never crowd out the notice's identity
// fields past the total cap (`buildProviderLegDeathNotice` throws past MAX_BYTES).
export const PROVIDER_LEG_DEATH_NOTICE_MAX_CAPTURE_BYTES = 2048;
export const PROVIDER_LEG_DEATH_NOTICE_SCAN_CAP = 32;
export const PROVIDER_LEG_DEATH_NOTICE_SEND_CAP = 5;
export const PROVIDER_LEG_DEATH_NOTICE_MEMO_CAP = 256;
export const PROVIDER_LEG_DEATH_NOTICE_MAX_ATTEMPTS = 3;
export const PROVIDER_LEG_DEATH_NOTICE_RETRY_MS = 250;

export const CHAT_NAMESPACE = "chat";
export const BUS_RESPONSE_TIMEOUT_MS = 5000;

export type ProviderLegTerminalKind = "ended" | "killed";

export type ProviderLegAbortCaptureStatus = "captured" | "unavailable";

/**
 * The launch-time abort evidence a wrapped-leg death notice carries. `detail`
 * holds the ALREADY-redacted, byte-bounded pane scrollback when `status` is
 * `captured`, or a short typed reason marker when `unavailable` (the pane was
 * already gone, or the producer-side capture failed) — never raw text. The
 * structured `exit` discriminates a signal death (128+n → a signal name) from a
 * plain exit code, read from the dead pane's tmux `pane_dead_status`.
 */
export interface ProviderLegAbortEvidence {
  status: ProviderLegAbortCaptureStatus;
  detail: string | null;
  exit: { signal: string | null; code: number | null };
}

export interface ProviderLegTerminalRow {
  provider_leg_job_id: string;
  provider_leg_created_at: number;
  title: string | null;
  transcript_path: string | null;
  terminal_kind: string;
  terminal_event_id: number;
  terminal_event_kind: string;
  terminal_event_at: number;
  last_lifecycle_at: number | null;
  close_kind: string | null;
  kill_reason: string | null;
  backend_exec_birth_session_id: string | null;
  /**
   * The raw `data` blob of the terminal `Killed` event. The producer redacts +
   * bounds the abort capture INTO this immutable payload at mint time, so the
   * sweep reads it back deterministically here — the evidence lives on the event,
   * never denormalized onto the jobs projection. NULL for a SessionEnd terminal
   * (no capture) or a pre-schema historical Killed.
   */
  terminal_event_data: string | null;
  leg_launch_id: string | null;
  wrapper_job_id: string | null;
  wrapper_dispatch_attempt_id: number | null;
  ownership_epoch_event_id: number | null;
  cascade_human_notified_at: number | null;
}

export interface ProviderLegDeathCandidate {
  providerLegJobId: string;
  providerLegCreatedAt: number;
  taskId: string;
  transcriptPath: string | null;
  terminalKind: ProviderLegTerminalKind;
  terminalEventId: number;
  failureDetail: string | null;
  abortEvidence: ProviderLegAbortEvidence;
  legLaunchId: string | null;
  wrapperJobId: string | null;
  wrapperDispatchAttemptId: number | null;
  ownershipEpochEventId: number | null;
  cascadeHumanNotifiedAt: number | null;
}

export interface WrapperAttemptRow {
  jobId: string;
  state: string;
  planVerb: string | null;
  planRef: string | null;
  dispatchOrigin: string | null;
  attemptId: number | null;
  claimState: string;
  legacyUnfenced: number;
  boundAt: number | null;
  releasedAt: number | null;
}

export interface ProviderLegDeathNoticePayload {
  schema_version: typeof PROVIDER_LEG_DEATH_NOTICE_SCHEMA_VERSION;
  kind: "provider_leg_died";
  terminal_event_id: number;
  provider_leg_job_id: string;
  task_id: string;
  terminal_kind: ProviderLegTerminalKind;
  transcript_path: string | null;
  failure_detail: string | null;
  /**
   * Launch-time abort evidence (schema v2): `status` is `captured` with redacted,
   * byte-bounded pane scrollback in `detail`, or `unavailable` with a typed
   * reason marker. `exit` carries the structured signal/code when the dead pane's
   * status was readable.
   */
  abort_capture: {
    status: ProviderLegAbortCaptureStatus;
    detail: string | null;
    exit: { signal: string | null; code: number | null };
  };
  truncated: boolean;
}

export type ProviderLegNoticeSendResult =
  | { kind: "delivered" }
  | { kind: "retry"; detail: string; deliveryAmbiguous: boolean }
  | { kind: "drop"; detail: string };

type PendingNotice = {
  candidate: ProviderLegDeathCandidate;
  attempts: number;
  nextAttemptAtMs: number;
};

export interface ProviderLegDeathNoticeState {
  readonly bootFenceEventId: number;
  scanAfterEventId: number;
  pending: Map<number, PendingNotice>;
  recentTerminalEventIds: Map<number, "delivered" | "dropped">;
  scanMayHaveMore: boolean;
}

export interface ProviderLegDeathNoticeSweepDeps {
  selectTerminalRows: (
    afterEventId: number,
    limit: number,
  ) => readonly ProviderLegTerminalRow[];
  selectWrapperAttempts: (
    candidate: ProviderLegDeathCandidate,
  ) => readonly WrapperAttemptRow[];
  send: (
    candidate: ProviderLegDeathCandidate,
    wrapperJobId: string,
  ) => Promise<ProviderLegNoticeSendResult>;
  nowMs: () => number;
  noteLine?: (line: string) => void;
}

export interface BusArtifactRefPayload {
  media_type: string;
  text: string;
  t: "bus-artifact-ref";
  v: 1;
  id: string;
  len: number;
  sha256: string;
}

export interface BusPublishFrame {
  op: "publish";
  event: "send";
  namespace: string;
  to: string;
  payload: BusArtifactRefPayload;
}

export type BusPublishResult =
  | "delivered"
  | "queued_for_wake"
  | "not_connected"
  | "unknown_target"
  | "ambiguous_target"
  | "delivery_failed";

export interface BusSendResult {
  result: BusPublishResult;
  recipients: number;
}

export class BusSendAttemptError extends Error {
  constructor(
    message: string,
    readonly deliveryAmbiguous: boolean,
  ) {
    super(message);
  }
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): {
  value: string;
  truncated: boolean;
} {
  const source = Buffer.from(value, "utf8");
  if (source.byteLength <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: source.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}

function boundedString(
  value: string | null,
  maxBytes: number,
): { value: string | null; truncated: boolean } {
  if (value == null) return { value: null, truncated: false };
  return truncateUtf8(value, maxBytes);
}

const REDACTION_PLACEHOLDER = "[REDACTED]";

// Sensitive env/config KEY names whose VALUE must never survive into persisted
// capture. Matched case-insensitively; the value after `=`/`:` on the same
// segment is replaced. Interim inline list — structured for replacement by the
// shared secrets pattern list when that ADR ratifies; until then it deliberately
// over-matches (a bare `AUTH`/`SECRET` substring), failing toward MORE redaction.
// The value capture excludes a bare `Bearer` scheme word: on
// `Authorization: Bearer <token>` the `AUTH` arm would otherwise capture
// `Bearer` as the value, redacting the scheme word and stripping the prefix
// BEARER_RE needs to reach the token — leaking an opaque token. Skipping it
// hands the whole credential to BEARER_RE below.
const SENSITIVE_KEY_RE =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|SESSION_KEY|COOKIE|AUTH)[A-Z0-9_]*)(\s*[=:]\s*)(?!bearer\b)(\S+)/gi;

// A `Bearer <token>` credential: the scheme label survives, the token is redacted.
const BEARER_RE = /\b(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

// Recognizable secret TOKEN shapes, redacted wherever they appear. Deliberately
// NONE of these match a 40-hex git SHA or an 8-4-4-4-12 UUID — those are safe
// forensic correlators the capture must preserve (all require a literal
// non-hex prefix or an interior `.`/`_` a SHA/UUID never carries).
const SECRET_TOKEN_RES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI-style
  /gh[posru]_[A-Za-z0-9]{20,}/g, // GitHub token
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWT
];

/**
 * Redact recognizable secrets from captured pane text through the interim inline
 * denylist. Two arms: a key-denylist (a sensitive `KEY=value` line's value) and
 * a token-shape list (`sk-…`, `gh?_…`, AWS/Slack/JWT/Bearer). SHAs and UUIDs
 * survive by construction. Pure — exported for tests. Redaction runs at the
 * PRODUCER, before the text is persisted, so an unredacted secret never reaches a
 * durable store.
 */
export function redactAbortEvidence(text: string): string {
  let out = text.replace(
    SENSITIVE_KEY_RE,
    (_m, key: string, sep: string) => `${key}${sep}${REDACTION_PLACEHOLDER}`,
  );
  out = out.replace(
    BEARER_RE,
    (_m, scheme: string) => `${scheme}${REDACTION_PLACEHOLDER}`,
  );
  for (const re of SECRET_TOKEN_RES) {
    out = out.replace(re, REDACTION_PLACEHOLDER);
  }
  return out;
}

const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  11: "SIGSEGV",
  13: "SIGPIPE",
  15: "SIGTERM",
};

/**
 * Discriminate a dead pane's tmux `pane_dead_status` into a structured signal vs
 * exit code, honoring the shell 128+n convention (137 → SIGKILL, 134 → SIGABRT).
 * A null/garbage status folds to both-null. Pure — exported for tests.
 */
export function parseProviderLegExitStatus(deadStatus: string | null): {
  signal: string | null;
  code: number | null;
} {
  if (deadStatus == null) return { signal: null, code: null };
  const trimmed = deadStatus.trim();
  // An empty status is "no status observed" — never coerce it to `Number("")` 0.
  if (trimmed === "") return { signal: null, code: null };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    return { signal: null, code: null };
  }
  if (n >= 128 && n <= 192) {
    const sig = n - 128;
    return { signal: SIGNAL_NAMES[sig] ?? `SIG${sig}`, code: null };
  }
  return { signal: null, code: n };
}

/**
 * Turn a best-effort {@link WrappedLegAbortCapture} into the redacted, bounded,
 * exit-discriminated payload the producer rides on the synthetic `Killed`
 * event's `data`. Redacts + byte-bounds the captured text at the source (the
 * unredacted text never leaves the producer), and degrades an `unavailable`
 * capture to a typed marker. Pure — exported for tests and the producer.
 */
export function assembleWrappedLegAbortPayload(
  capture: WrappedLegAbortCapture,
): ProviderLegAbortEvidence {
  if (capture.status === "unavailable") {
    return {
      status: "unavailable",
      detail: `capture-unavailable: ${capture.reason}`,
      exit: { signal: null, code: null },
    };
  }
  const bounded = truncateUtf8(
    redactAbortEvidence(capture.rawText),
    PROVIDER_LEG_DEATH_NOTICE_MAX_CAPTURE_BYTES,
  );
  return {
    status: "captured",
    detail: bounded.value,
    exit: parseProviderLegExitStatus(capture.deadStatus),
  };
}

const ABSENT_ABORT_EVIDENCE: ProviderLegAbortEvidence = {
  status: "unavailable",
  detail: null,
  exit: { signal: null, code: null },
};

/**
 * Read the abort evidence back out of a terminal `Killed` event's raw `data`
 * blob (the producer redacted + bounded it at mint). Defensive against every
 * malformed shape — attacker-influenceable text — and NEVER throws; an absent or
 * unparseable payload folds to the typed unavailable marker.
 */
function parseAbortEvidenceFromEventData(
  raw: string | null,
): ProviderLegAbortEvidence {
  if (raw == null || raw.length === 0) return ABSENT_ABORT_EVIDENCE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ABSENT_ABORT_EVIDENCE;
  }
  if (parsed == null || typeof parsed !== "object")
    return ABSENT_ABORT_EVIDENCE;
  const ac = (parsed as { abort_capture?: unknown }).abort_capture;
  if (ac == null || typeof ac !== "object") return ABSENT_ABORT_EVIDENCE;
  const obj = ac as { status?: unknown; detail?: unknown; exit?: unknown };
  const status: ProviderLegAbortCaptureStatus =
    obj.status === "captured" ? "captured" : "unavailable";
  const detail = typeof obj.detail === "string" ? obj.detail : null;
  const exitObj = (obj.exit ?? {}) as { signal?: unknown; code?: unknown };
  const signal = typeof exitObj.signal === "string" ? exitObj.signal : null;
  const code =
    typeof exitObj.code === "number" && Number.isInteger(exitObj.code)
      ? exitObj.code
      : null;
  return { status, detail, exit: { signal, code } };
}

export function terminalRowToCandidate(
  row: ProviderLegTerminalRow,
  bootFenceEventId: number,
): ProviderLegDeathCandidate | null {
  if (
    !Number.isSafeInteger(row.terminal_event_id) ||
    row.terminal_event_id <= bootFenceEventId ||
    !Number.isFinite(row.provider_leg_created_at) ||
    !Number.isFinite(row.terminal_event_at) ||
    row.last_lifecycle_at !== row.terminal_event_at ||
    row.backend_exec_birth_session_id !== "wrapped"
  ) {
    return null;
  }
  const taskId = parseWrappedProviderTaskId(row.title);
  if (taskId == null) return null;
  const accepted =
    (row.terminal_kind === "ended" &&
      row.terminal_event_kind === "SessionEnd") ||
    (row.terminal_kind === "killed" && row.terminal_event_kind === "Killed");
  if (!accepted) return null;
  const detailParts = [row.close_kind, row.kill_reason].filter(
    (part): part is string => part != null && part.length > 0,
  );
  const ownerFields = [
    row.leg_launch_id,
    row.wrapper_job_id,
    row.wrapper_dispatch_attempt_id,
    row.ownership_epoch_event_id,
  ];
  const ownerPresent = ownerFields.every((value) => value != null);
  const ownerAbsent = ownerFields.every((value) => value == null);
  if (!ownerPresent && !ownerAbsent) return null;
  return {
    providerLegJobId: row.provider_leg_job_id,
    providerLegCreatedAt: row.provider_leg_created_at,
    taskId,
    transcriptPath: row.transcript_path,
    terminalKind: row.terminal_kind === "ended" ? "ended" : "killed",
    terminalEventId: row.terminal_event_id,
    failureDetail: detailParts.length === 0 ? null : detailParts.join(": "),
    abortEvidence: parseAbortEvidenceFromEventData(row.terminal_event_data),
    legLaunchId: row.leg_launch_id,
    wrapperJobId: row.wrapper_job_id,
    wrapperDispatchAttemptId: row.wrapper_dispatch_attempt_id,
    ownershipEpochEventId: row.ownership_epoch_event_id,
    cascadeHumanNotifiedAt: row.cascade_human_notified_at,
  };
}

export function resolveUniqueEligibleWrapper(
  candidate: ProviderLegDeathCandidate,
  rows: readonly WrapperAttemptRow[],
): string | null {
  const durableOwner =
    candidate.legLaunchId != null &&
    candidate.wrapperJobId != null &&
    candidate.wrapperDispatchAttemptId != null &&
    candidate.ownershipEpochEventId != null;
  const eligible = new Set<string>();
  for (const row of rows) {
    if (
      row.planVerb !== "work" ||
      (!durableOwner && row.planRef !== candidate.taskId) ||
      (durableOwner &&
        (row.jobId !== candidate.wrapperJobId ||
          row.attemptId !== candidate.wrapperDispatchAttemptId)) ||
      row.dispatchOrigin !== "autopilot" ||
      row.state === "ended" ||
      row.state === "killed" ||
      row.attemptId == null ||
      row.legacyUnfenced !== 0 ||
      (row.claimState !== "bound" && row.claimState !== "resume_requested") ||
      row.boundAt == null ||
      row.boundAt > candidate.providerLegCreatedAt ||
      row.releasedAt != null
    ) {
      continue;
    }
    eligible.add(row.jobId);
  }
  return eligible.size === 1 ? [...eligible][0] : null;
}

export function buildProviderLegDeathNotice(
  candidate: ProviderLegDeathCandidate,
): { payload: ProviderLegDeathNoticePayload; body: string } {
  const job = boundedString(candidate.providerLegJobId, 256);
  const task = boundedString(candidate.taskId, 256);
  const transcript = boundedString(candidate.transcriptPath, 1024);
  const detail = boundedString(
    candidate.failureDetail,
    PROVIDER_LEG_DEATH_NOTICE_MAX_DETAIL_BYTES,
  );
  const abort = candidate.abortEvidence;
  const abortDetail = boundedString(
    abort.detail,
    PROVIDER_LEG_DEATH_NOTICE_MAX_CAPTURE_BYTES,
  );
  const payload: ProviderLegDeathNoticePayload = {
    schema_version: PROVIDER_LEG_DEATH_NOTICE_SCHEMA_VERSION,
    kind: "provider_leg_died",
    terminal_event_id: candidate.terminalEventId,
    provider_leg_job_id: job.value ?? "",
    task_id: task.value ?? "",
    terminal_kind: candidate.terminalKind,
    transcript_path: transcript.value,
    failure_detail: detail.value,
    abort_capture: {
      status: abort.status,
      detail: abortDetail.value,
      exit: { signal: abort.exit.signal, code: abort.exit.code },
    },
    truncated:
      job.truncated ||
      task.truncated ||
      transcript.truncated ||
      detail.truncated ||
      abortDetail.truncated,
  };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > PROVIDER_LEG_DEATH_NOTICE_MAX_BYTES) {
    throw new RangeError("Provider-leg death notice exceeds its byte cap");
  }
  return { payload, body };
}

export function createProviderLegDeathNoticeState(
  bootFenceEventId: number,
): ProviderLegDeathNoticeState {
  return {
    bootFenceEventId,
    scanAfterEventId: bootFenceEventId,
    pending: new Map(),
    recentTerminalEventIds: new Map(),
    scanMayHaveMore: false,
  };
}

function trimOldest<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

export function ingestProviderLegTerminalRows(
  state: ProviderLegDeathNoticeState,
  rows: readonly ProviderLegTerminalRow[],
  nowMs: number,
): void {
  const ordered = [...rows].sort(
    (a, b) => a.terminal_event_id - b.terminal_event_id,
  );
  for (const row of ordered) {
    if (
      state.pending.size >= PROVIDER_LEG_DEATH_NOTICE_MEMO_CAP &&
      !state.pending.has(row.terminal_event_id) &&
      !state.recentTerminalEventIds.has(row.terminal_event_id)
    ) {
      state.scanMayHaveMore = true;
      break;
    }
    if (
      Number.isSafeInteger(row.terminal_event_id) &&
      row.terminal_event_id > state.scanAfterEventId
    ) {
      state.scanAfterEventId = row.terminal_event_id;
    }
    const candidate = terminalRowToCandidate(row, state.bootFenceEventId);
    if (
      candidate == null ||
      state.pending.has(candidate.terminalEventId) ||
      state.recentTerminalEventIds.has(candidate.terminalEventId)
    ) {
      continue;
    }
    state.pending.set(candidate.terminalEventId, {
      candidate,
      attempts: 0,
      nextAttemptAtMs: nowMs,
    });
  }
}

export function dueProviderLegDeathNotices(
  state: ProviderLegDeathNoticeState,
  nowMs: number,
  cap = PROVIDER_LEG_DEATH_NOTICE_SEND_CAP,
): ProviderLegDeathCandidate[] {
  return [...state.pending.values()]
    .filter(
      (entry) =>
        entry.attempts < PROVIDER_LEG_DEATH_NOTICE_MAX_ATTEMPTS &&
        entry.nextAttemptAtMs <= nowMs,
    )
    .sort((a, b) => a.candidate.terminalEventId - b.candidate.terminalEventId)
    .slice(0, Math.max(0, cap))
    .map((entry) => entry.candidate);
}

export function recordProviderLegNoticeResult(
  state: ProviderLegDeathNoticeState,
  terminalEventId: number,
  result: ProviderLegNoticeSendResult,
  nowMs: number,
): void {
  const pending = state.pending.get(terminalEventId);
  if (pending == null) return;
  if (result.kind === "delivered" || result.kind === "drop") {
    state.pending.delete(terminalEventId);
    state.recentTerminalEventIds.set(
      terminalEventId,
      result.kind === "delivered" ? "delivered" : "dropped",
    );
    trimOldest(
      state.recentTerminalEventIds,
      PROVIDER_LEG_DEATH_NOTICE_MEMO_CAP,
    );
    return;
  }
  pending.attempts += 1;
  if (pending.attempts >= PROVIDER_LEG_DEATH_NOTICE_MAX_ATTEMPTS) {
    state.pending.delete(terminalEventId);
    state.recentTerminalEventIds.set(terminalEventId, "dropped");
    trimOldest(
      state.recentTerminalEventIds,
      PROVIDER_LEG_DEATH_NOTICE_MEMO_CAP,
    );
    return;
  }
  pending.nextAttemptAtMs = nowMs + PROVIDER_LEG_DEATH_NOTICE_RETRY_MS;
}

export function nextProviderLegNoticeRetryDelayMs(
  state: ProviderLegDeathNoticeState,
  nowMs: number,
): number | null {
  if (state.scanMayHaveMore) return 0;
  let next = Number.POSITIVE_INFINITY;
  for (const entry of state.pending.values()) {
    if (entry.attempts >= PROVIDER_LEG_DEATH_NOTICE_MAX_ATTEMPTS) continue;
    next = Math.min(next, entry.nextAttemptAtMs);
  }
  return Number.isFinite(next) ? Math.max(0, next - nowMs) : null;
}

export async function runProviderLegDeathNoticeSweep(
  state: ProviderLegDeathNoticeState,
  deps: ProviderLegDeathNoticeSweepDeps,
): Promise<void> {
  const note = deps.noteLine ?? (() => {});
  const now = deps.nowMs();
  try {
    const available = Math.max(
      0,
      PROVIDER_LEG_DEATH_NOTICE_MEMO_CAP - state.pending.size,
    );
    const limit = Math.min(PROVIDER_LEG_DEATH_NOTICE_SCAN_CAP, available);
    if (limit > 0) {
      const rows = deps.selectTerminalRows(state.scanAfterEventId, limit);
      state.scanMayHaveMore = rows.length === limit;
      ingestProviderLegTerminalRows(state, rows, now);
    } else {
      state.scanMayHaveMore = true;
    }
  } catch (err) {
    note(
      `Provider-leg death-notice candidate read failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  for (const candidate of dueProviderLegDeathNotices(state, now)) {
    if (candidate.cascadeHumanNotifiedAt != null) {
      recordProviderLegNoticeResult(
        state,
        candidate.terminalEventId,
        { kind: "drop", detail: "cascade incident already paged" },
        deps.nowMs(),
      );
      continue;
    }
    let wrapperJobId: string | null = null;
    try {
      wrapperJobId = resolveUniqueEligibleWrapper(
        candidate,
        deps.selectWrapperAttempts(candidate),
      );
    } catch (err) {
      note(
        `Provider-leg death-notice owner read failed for event ${candidate.terminalEventId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (wrapperJobId == null) {
      recordProviderLegNoticeResult(
        state,
        candidate.terminalEventId,
        { kind: "drop", detail: "no unique live Dispatch attempt owner" },
        deps.nowMs(),
      );
      continue;
    }
    let result: ProviderLegNoticeSendResult;
    try {
      result = await deps.send(candidate, wrapperJobId);
    } catch (err) {
      result = {
        kind: "retry",
        detail: err instanceof Error ? err.message : String(err),
        deliveryAmbiguous: false,
      };
    }
    recordProviderLegNoticeResult(
      state,
      candidate.terminalEventId,
      result,
      deps.nowMs(),
    );
  }
}

export function buildBusPublishFrame(
  artifact: PublishedBusArtifact,
  target: string,
  mediaType = "text/markdown",
): BusPublishFrame {
  const encoded = JSON.parse(encodeBusArtifactRef(artifact.ref)) as {
    t: "bus-artifact-ref";
    v: 1;
    id: string;
    len: number;
    sha256: string;
  };
  return {
    op: "publish",
    event: "send",
    namespace: CHAT_NAMESPACE,
    to: target,
    payload: {
      media_type: mediaType,
      text: encodeBusArtifactRef(artifact.ref),
      ...encoded,
    },
  };
}

export function buildBusRegisterFrame(
  sendOnly = false,
  env: NodeJS.ProcessEnv = process.env,
  pid = process.pid,
): object {
  const sessionId = (env.KEEPER_JOB_ID ?? "").trim();
  return {
    op: "register",
    namespace: CHAT_NAMESPACE,
    namespaces: [CHAT_NAMESPACE],
    pid,
    send_only: sendOnly,
    ...(sessionId === "" ? {} : { session_id: sessionId }),
  };
}

export function busSendTransportIsAmbiguous(
  publishStarted: boolean,
  serverRejected: boolean,
): boolean {
  return publishStarted && !serverRejected;
}

async function busRoundTrip<T>(
  sockPath: string,
  drive: (
    send: (frame: object) => void,
    onFrame: (handler: (frame: Record<string, unknown>) => void) => void,
    resolve: (value: T) => void,
    reject: (error: Error) => void,
  ) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let remainder = "";
    let settled = false;
    let sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;
    let frameHandler: (frame: Record<string, unknown>) => void = () => {};
    const settle = (error: Error | null, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        sock?.end();
      } catch {
        // best-effort
      }
      if (error) reject(error);
      else resolve(value as T);
    };
    const timeout = setTimeout(() => {
      settle(
        new Error(`no response from bus within ${BUS_RESPONSE_TIMEOUT_MS}ms`),
      );
    }, BUS_RESPONSE_TIMEOUT_MS);
    timeout.unref?.();
    Bun.connect({
      unix: sockPath,
      socket: {
        open(socket) {
          sock = socket;
          drive(
            (frame) => {
              try {
                socket.write(`${JSON.stringify(frame)}\n`);
              } catch (err) {
                settle(new Error(`write failed: ${(err as Error).message}`));
              }
            },
            (handler) => {
              frameHandler = handler;
            },
            (value) => settle(null, value),
            (error) => settle(error),
          );
        },
        data(_socket, chunk) {
          remainder += chunk.toString("utf8");
          let newline = remainder.indexOf("\n");
          while (newline !== -1) {
            const line = remainder.slice(0, newline).trim();
            remainder = remainder.slice(newline + 1);
            if (line.length > 0) {
              try {
                frameHandler(JSON.parse(line) as Record<string, unknown>);
              } catch {
                // Ignore malformed relay output and await a valid acknowledgement.
              }
            }
            newline = remainder.indexOf("\n");
          }
        },
        close() {
          settle(new Error("bus closed connection before responding"));
        },
        error(_socket, err) {
          settle(new Error(`socket error: ${(err as Error).message}`));
        },
      },
    }).catch((err: Error) => {
      settle(new Error(`failed to connect to ${sockPath}: ${err.message}`));
    });
  });
}

export async function sendBusArtifact(
  sockPath: string,
  artifact: PublishedBusArtifact,
  target: string,
  mediaType = "text/markdown",
  beforePublish?: () => boolean,
): Promise<BusSendResult> {
  let publishStarted = false;
  let serverRejected = false;
  try {
    return await busRoundTrip<BusSendResult>(
      sockPath,
      (send, onFrame, resolve, reject) => {
        onFrame((frame) => {
          if (frame.type === "ack" && frame.op === "register") {
            let eligible = true;
            try {
              eligible = beforePublish?.() ?? true;
            } catch {
              eligible = false;
            }
            if (!eligible) {
              serverRejected = true;
              reject(
                new Error("recipient Dispatch attempt is no longer eligible"),
              );
              return;
            }
            publishStarted = true;
            send(buildBusPublishFrame(artifact, target, mediaType));
          } else if (frame.type === "ack" && frame.op === "publish") {
            resolve({
              result: frame.result as BusPublishResult,
              recipients:
                typeof frame.recipients === "number" ? frame.recipients : 0,
            });
          } else if (frame.type === "error") {
            serverRejected = true;
            reject(new Error(`${frame.code}: ${frame.message}`));
          }
        });
        send(buildBusRegisterFrame(true));
      },
    );
  } catch (err) {
    throw new BusSendAttemptError(
      (err as Error).message,
      busSendTransportIsAmbiguous(publishStarted, serverRejected),
    );
  }
}

export async function sendProviderLegDeathNotice(args: {
  sockPath: string;
  candidate: ProviderLegDeathCandidate;
  wrapperJobId: string;
  artifactRoot?: string;
  sendArtifact?: typeof sendBusArtifact;
  stillEligible?: () => boolean;
}): Promise<ProviderLegNoticeSendResult> {
  let body: string;
  try {
    body = buildProviderLegDeathNotice(args.candidate).body;
  } catch (err) {
    return {
      kind: "drop",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const root = args.artifactRoot ?? resolveBusArtifactRoot();
  let artifact: PublishedBusArtifact;
  try {
    artifact = publishBusArtifact(root, body);
  } catch (err) {
    return {
      kind: "retry",
      detail: err instanceof Error ? err.message : String(err),
      deliveryAmbiguous: false,
    };
  }
  try {
    const result = await (args.sendArtifact ?? sendBusArtifact)(
      args.sockPath,
      artifact,
      args.wrapperJobId,
      "application/json",
      args.stillEligible,
    );
    if (result.result === "delivered" && result.recipients === 1) {
      return { kind: "delivered" };
    }
    removeBusArtifact(root, artifact.ref.id);
    if (result.result === "delivery_failed") {
      return {
        kind: "retry",
        detail: result.result,
        deliveryAmbiguous: false,
      };
    }
    return { kind: "drop", detail: result.result };
  } catch (err) {
    const ambiguous =
      err instanceof BusSendAttemptError && err.deliveryAmbiguous;
    if (!ambiguous) removeBusArtifact(root, artifact.ref.id);
    return {
      kind: "retry",
      detail: err instanceof Error ? err.message : String(err),
      deliveryAmbiguous: ambiguous,
    };
  }
}
