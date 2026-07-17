import { parseWrappedProviderTaskId } from "./autoclose-worker";
import type { PublishedBusArtifact } from "./bus-artifact";
import {
  encodeBusArtifactRef,
  publishBusArtifact,
  removeBusArtifact,
  resolveBusArtifactRoot,
} from "./bus-artifact";

export const PROVIDER_LEG_DEATH_NOTICE_SCHEMA_VERSION = 1;
export const PROVIDER_LEG_DEATH_NOTICE_MAX_BYTES = 4096;
export const PROVIDER_LEG_DEATH_NOTICE_MAX_DETAIL_BYTES = 1024;
export const PROVIDER_LEG_DEATH_NOTICE_SCAN_CAP = 32;
export const PROVIDER_LEG_DEATH_NOTICE_SEND_CAP = 5;
export const PROVIDER_LEG_DEATH_NOTICE_MEMO_CAP = 256;
export const PROVIDER_LEG_DEATH_NOTICE_MAX_ATTEMPTS = 3;
export const PROVIDER_LEG_DEATH_NOTICE_RETRY_MS = 250;

export const CHAT_NAMESPACE = "chat";
export const BUS_RESPONSE_TIMEOUT_MS = 5000;

export type ProviderLegTerminalKind = "ended" | "killed";

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
  const payload: ProviderLegDeathNoticePayload = {
    schema_version: PROVIDER_LEG_DEATH_NOTICE_SCHEMA_VERSION,
    kind: "provider_leg_died",
    terminal_event_id: candidate.terminalEventId,
    provider_leg_job_id: job.value ?? "",
    task_id: task.value ?? "",
    terminal_kind: candidate.terminalKind,
    transcript_path: transcript.value,
    failure_detail: detail.value,
    truncated:
      job.truncated ||
      task.truncated ||
      transcript.truncated ||
      detail.truncated,
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
