/**
 * The post-launch transcript verbs: `wait-for-stop` and `show-last-message`.
 * They decouple a detached `--x-tmux --x-tmux-detached` launch
 * from reading its result, so a caller composes `launch-detached → wait-for-stop
 * → show-last-message` instead of a single blocking flag.
 *
 * Both take a `<handle>`: the detached launch JSON's `id` (a `tmux-<uuid>` run
 * id resolving to `<stateDir>/tmux-runs/<id>/run.json`, which carries the agent,
 * cwd, transcript session id and start time), OR a direct transcript path (a
 * value containing a `/`) paired with `--agent <kind>`. The run-id form is the
 * happy path; the path form serves a `--no-artifacts` launch that wrote no
 * run.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDuration } from "../duration";
import type { AgentKind } from "./dispatch";
import { HARNESS_NAME_SET } from "./harness";
import {
  DEFAULT_STOP_TIMEOUT_MS,
  defaultTranscriptPathTimeoutMs,
  findLastMessage,
  type PartnerLifecycle,
  type PartnerLifecycleTerminal,
  type TranscriptStop,
  type WaitForPathOutcome,
  type WindowLiveness,
  waitForTranscriptPath,
  waitForTranscriptStop,
  windowPresenceProbeCommand,
} from "./transcript-watch";

/** A run handle resolved to everything the verbs need to read its transcript. */
export interface ResolvedHandle {
  agent: AgentKind;
  cwd: string;
  sessionId: string | null;
  startedAtMs: number;
  /** Known up-front only for the direct-path handle form; else resolved later. */
  transcriptPath: string | null;
  /**
   * Caller-supplied stop-wait ceiling in ms (`--stop-timeout`), threaded into
   * `waitForTranscriptStop`. Null when the flag is absent — the watcher then
   * falls back to `DEFAULT_STOP_TIMEOUT_MS`. Meaningful only to `wait-for-stop`;
   * `show-last-message` shares this resolver and tolerantly ignores it.
   */
  stopTimeoutMs: number | null;
  /**
   * Caller-supplied TOTAL leg budget in ms (`--budget`), the cumulative ceiling
   * measured from the DURABLE launch instant {@link startedAtMs} — NOT the
   * per-call chunk {@link stopTimeoutMs}. Once launch-age crosses it the capture
   * BLOCKS deterministically (a producer clock, not a wrapper counting chunks),
   * so a fresh or cold-restarted wait over a long-running leg cannot grant
   * another full budget. Absent = no cumulative ceiling (legacy behavior).
   */
  totalBudgetMs?: number | null;
  /**
   * `--output` path for `agent wait`: the atomic result-file sink the wait writes
   * its envelope to on EVERY outcome, so a wait's terminal/attribution result
   * persists for a cold wrapper (the wrapped guard permits only the exact
   * `$KEEPER_WRAPPED_ENVELOPE` path). Absent = stdout only.
   */
  outputPath?: string | null;
  /**
   * Resume marker threaded into transcript discovery. Claude/Pi stay
   * strict-pinned; a resumed Pi wait anchors on a structural stop-count watermark instead, since pi
   * re-stamps its copied history with resume-time timestamps. Absent/false = fresh
   * launch, byte-unchanged.
   */
  isResume?: boolean;
  /** Exact Keeper jobs identity. Absent on direct paths and legacy artifacts. */
  lifecycleJobId?: string | null;
  /** Pre-launch resumed-transcript structural boundary. */
  invocationStopFloor?: number | null;
  /** Exact Bus notification marker required before a stop can satisfy capture. */
  injectedMessageMarker?: string | null;
  /** Transcript line count sampled before the matching Bus publish. */
  transcriptLineFloor?: number | null;
  /** The launch's tmux window presence-probe argv (built from run.json's tmux
   *  block), letting a wait positively detect a gone target within one poll
   *  tick. Absent for direct-path handles and legacy artifacts with no tmux
   *  block — the wait then behaves byte-identically (no window probing). */
  tmuxWindowProbeCommand?: string[] | null;
}

export interface ResolveHandleArgs {
  rest: string[];
  cwd: string;
  stateDir: string;
  /** Wall-clock the run.json launch instant is validated against. run.json is
   *  published BEFORE any wait begins, so a persisted `startedAtMs` in the future
   *  never came from the producer — the resolver rejects it (see resolveRunId).
   *  Injected for tests; defaults to Date.now(). */
  now?: () => number;
}

export type HandleResolution =
  | { ok: true; handle: ResolvedHandle }
  | { ok: false; error: string };

const AGENTS: ReadonlySet<string> = HARNESS_NAME_SET;
const AGENT_ROSTER = [...HARNESS_NAME_SET].join("|");

/**
 * Parse a verb's argv into a resolved handle. The first non-flag positional is
 * the handle; `--agent <kind>` overrides/supplies the agent for a path handle.
 * A handle containing `/` is treated as a transcript path; otherwise it is a run
 * id looked up under the state dir.
 */
export function resolveHandle(args: ResolveHandleArgs): HandleResolution {
  let handleArg: string | null = null;
  let agentOverride: AgentKind | null = null;
  let stopTimeoutMs: number | null = null;
  let declaredBudgetMs: number | null = null;
  let outputPath: string | null = null;

  for (let i = 0; i < args.rest.length; i++) {
    const arg = args.rest[i] as string;
    if (arg === "--agent") {
      const value = args.rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--agent requires a value" };
      }
      if (!AGENTS.has(value)) {
        return {
          ok: false,
          error: `--agent must be ${AGENT_ROSTER}: ${value}`,
        };
      }
      agentOverride = value as AgentKind;
      i += 1;
      continue;
    }
    if (arg.startsWith("--agent=")) {
      const value = arg.slice("--agent=".length);
      if (!AGENTS.has(value)) {
        return {
          ok: false,
          error: `--agent must be ${AGENT_ROSTER}: ${value}`,
        };
      }
      agentOverride = value as AgentKind;
      continue;
    }
    if (arg === "--stop-timeout") {
      const value = args.rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--stop-timeout requires a value" };
      }
      const parsed = parseDuration(value);
      if (!parsed.ok) {
        return { ok: false, error: `--stop-timeout ${parsed.message}` };
      }
      stopTimeoutMs = parsed.ms;
      i += 1;
      continue;
    }
    if (arg.startsWith("--stop-timeout=")) {
      const value = arg.slice("--stop-timeout=".length);
      const parsed = parseDuration(value);
      if (!parsed.ok) {
        return { ok: false, error: `--stop-timeout ${parsed.message}` };
      }
      stopTimeoutMs = parsed.ms;
      continue;
    }
    if (arg === "--budget") {
      const value = args.rest[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--budget requires a value" };
      }
      const parsed = parseDuration(value);
      if (!parsed.ok) {
        return { ok: false, error: `--budget ${parsed.message}` };
      }
      declaredBudgetMs = parsed.ms;
      i += 1;
      continue;
    }
    if (arg.startsWith("--budget=")) {
      const value = arg.slice("--budget=".length);
      const parsed = parseDuration(value);
      if (!parsed.ok) {
        return { ok: false, error: `--budget ${parsed.message}` };
      }
      declaredBudgetMs = parsed.ms;
      continue;
    }
    if (arg === "--output") {
      const value = args.rest[i + 1];
      if (value === undefined || value === "") {
        return { ok: false, error: "--output requires a value" };
      }
      outputPath = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      const value = arg.slice("--output=".length);
      if (value === "") {
        return { ok: false, error: "--output requires a value" };
      }
      outputPath = value;
      continue;
    }
    if (handleArg === null) {
      handleArg = arg;
      continue;
    }
    return { ok: false, error: `unexpected extra argument: ${arg}` };
  }

  if (handleArg === null) {
    return { ok: false, error: "missing handle (a run id or transcript path)" };
  }

  if (handleArg.includes("/")) {
    if (agentOverride === null) {
      return {
        ok: false,
        error: "--agent is required when the handle is a transcript path",
      };
    }
    // A direct transcript path carries NO durable launch state, so a `--budget`
    // has no producer-owned deadline to bind against — FAIL CLOSED rather than
    // honor a model-supplied per-call ceiling.
    if (declaredBudgetMs !== null) {
      return {
        ok: false,
        error:
          "--budget requires a run-id handle with a durable bound budget (not a transcript path)",
      };
    }
    return {
      ok: true,
      handle: {
        agent: agentOverride,
        cwd: args.cwd,
        sessionId: null,
        startedAtMs: 0,
        transcriptPath: handleArg,
        stopTimeoutMs,
        ...(outputPath !== null ? { outputPath } : {}),
      },
    };
  }

  return resolveRunId(
    handleArg,
    args.stateDir,
    agentOverride,
    stopTimeoutMs,
    declaredBudgetMs,
    outputPath,
    (args.now ?? Date.now)(),
  );
}

function resolveRunId(
  runId: string,
  stateDir: string,
  agentOverride: AgentKind | null,
  stopTimeoutMs: number | null,
  declaredBudgetMs: number | null,
  outputPath: string | null,
  nowMs: number,
): HandleResolution {
  const runJsonPath = join(stateDir, "tmux-runs", runId, "run.json");
  if (!existsSync(runJsonPath)) {
    return { ok: false, error: `no run found for handle: ${runId}` };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(runJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return { ok: false, error: `unreadable run metadata: ${runJsonPath}` };
  }

  const agent = agentOverride ?? coerceAgent(parsed.agent);
  if (agent === null) {
    return { ok: false, error: `run metadata has no agent: ${runJsonPath}` };
  }
  const cwd = typeof parsed.cwd === "string" ? parsed.cwd : null;
  if (cwd === null) {
    return { ok: false, error: `run metadata has no cwd: ${runJsonPath}` };
  }

  // The DURABLE producer clock: a FINITE, SAFE, POSITIVE launch instant that was
  // published BEFORE this wait began, so it must be `<= now`. A malformed clock
  // (JSON `1e400` → Infinity, negative), or a future value the producer never
  // wrote (a torn/forged run.json), carries NO cumulative-budget authority.
  const rawStartedAt = parsed.startedAtMs;
  const startedAtValid =
    typeof rawStartedAt === "number" &&
    Number.isSafeInteger(rawStartedAt) &&
    rawStartedAt > 0 &&
    rawStartedAt <= nowMs;
  const startedAtMs = startedAtValid ? (rawStartedAt as number) : 0;

  // The budget ceiling is bound ONCE at launch in owner-private run.json; a
  // per-call `--budget` may only re-declare the SAME value. A mismatch/increase,
  // a declared budget with no launch bind, or a bound budget with no valid clock
  // all FAIL CLOSED before any wait — the durable value is the sole authority.
  // A `budgetMs` field that is PRESENT but not a safe positive integer is a
  // corrupted/torn ceiling, NOT a legacy-unbound run: fail closed rather than
  // silently widen an intended cap to no cap.
  const rawBudget = parsed.budgetMs;
  const budgetFieldPresent = rawBudget !== undefined;
  const persistedBudgetMs =
    typeof rawBudget === "number" &&
    Number.isSafeInteger(rawBudget) &&
    rawBudget > 0
      ? rawBudget
      : null;
  if (budgetFieldPresent && persistedBudgetMs === null) {
    return {
      ok: false,
      error: `run ${runId} has a present but invalid budgetMs — refusing to treat a corrupted ceiling as unbounded`,
    };
  }
  if (declaredBudgetMs !== null) {
    if (persistedBudgetMs === null) {
      return {
        ok: false,
        error: `--budget passed but run ${runId} bound no durable budget at launch`,
      };
    }
    if (declaredBudgetMs !== persistedBudgetMs) {
      return {
        ok: false,
        error: `--budget ${declaredBudgetMs}ms mismatches the launch-bound budget ${persistedBudgetMs}ms`,
      };
    }
  }
  if (persistedBudgetMs !== null && !startedAtValid) {
    return {
      ok: false,
      error: `run ${runId} has a bound budget but no finite positive launch time — refusing an unbounded wait`,
    };
  }

  const tmuxWindowProbeCommand = tmuxWindowProbeCommandFromRunJson(parsed);

  return {
    ok: true,
    handle: {
      agent,
      cwd,
      sessionId:
        typeof parsed.transcriptSessionId === "string"
          ? parsed.transcriptSessionId
          : null,
      startedAtMs,
      transcriptPath: null,
      stopTimeoutMs,
      ...(persistedBudgetMs !== null
        ? { totalBudgetMs: persistedBudgetMs }
        : {}),
      ...(outputPath !== null ? { outputPath } : {}),
      ...(tmuxWindowProbeCommand !== null ? { tmuxWindowProbeCommand } : {}),
      ...(typeof parsed.lifecycleJobId === "string"
        ? { lifecycleJobId: parsed.lifecycleJobId }
        : {}),
      ...(typeof parsed.invocationStopFloor === "number" &&
      Number.isInteger(parsed.invocationStopFloor) &&
      parsed.invocationStopFloor >= 0
        ? { invocationStopFloor: parsed.invocationStopFloor }
        : {}),
      ...(parsed.isResume === true ? { isResume: true } : {}),
    },
  };
}

function coerceAgent(value: unknown): AgentKind | null {
  return typeof value === "string" && AGENTS.has(value)
    ? (value as AgentKind)
    : null;
}

/**
 * Build the launch's tmux window presence-probe argv from a run.json `tmux`
 * block (`{ command: [tmux, ...socketArgs], windowId: "@id" }`). Reconstructs
 * the socket-correct kill-window argv the launch recorded, then transforms it
 * into the read-only list-panes probe. Null when the block is absent or
 * malformed, so a legacy artifact yields no probe (the wait stays byte-identical).
 */
function tmuxWindowProbeCommandFromRunJson(
  parsed: Record<string, unknown>,
): string[] | null {
  const tmux = parsed.tmux;
  if (typeof tmux !== "object" || tmux === null || Array.isArray(tmux)) {
    return null;
  }
  const block = tmux as Record<string, unknown>;
  // REJECT the whole array on any non-string token — filtering non-strings would
  // silently splice a hole shut (e.g. `[tmux, null, "-L", "wrapped"]` collapsing
  // to a valid-looking probe), turning malformed metadata into an executable
  // argv. A single bad token means no probe.
  const rawCommand = block.command;
  if (
    !Array.isArray(rawCommand) ||
    !rawCommand.every((token) => typeof token === "string")
  ) {
    return null;
  }
  const windowId = typeof block.windowId === "string" ? block.windowId : null;
  if (rawCommand.length === 0 || windowId === null) {
    return null;
  }
  return windowPresenceProbeCommand([
    ...(rawCommand as string[]),
    "kill-window",
    "-t",
    windowId,
  ]);
}

export interface VerbDeps {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  probePartnerLifecycle?: (jobId: string) => Promise<PartnerLifecycle>;
  /** Run a launch's tmux window presence probe (the argv from
   *  {@link ResolvedHandle.tmuxWindowProbeCommand}) → tri-state liveness.
   *  Injected so a wait can positively detect a gone target within one poll
   *  tick; omitted → no window probing (byte-identical legacy behavior). */
  probeWindowPresence?: (command: string[]) => Promise<WindowLiveness>;
  /** The poll-tick sleep threaded into both watcher stages. Injected so a test
   *  can prove an over-budget wait does exactly one observation scan and NEVER
   *  sleeps; omitted → the watcher's own default real-time sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** The wall-clock the deadline math reads, threaded end-to-end (runWaitForStop
   *  AND both watcher stages) so a test can freeze time and prove the exhausted-
   *  budget floor deterministically; omitted → Date.now. */
  now?: () => number;
}

/**
 * The Partner's lifecycle as re-probed at an observation deadline: positively
 * `live` (still running) or `unknown` (evidence proves neither live nor dead). A
 * timeout NEVER reports `terminal` here — a confirmed death is the separate
 * `partner_died` path observed during polling, so a bounded wait elapsing can
 * never masquerade as a termination.
 */
export type PartnerLiveness = "live" | "unknown";

export type WaitForStopResult =
  | { ok: true; transcriptPath: string; stop: TranscriptStop }
  | {
      ok: false;
      error: string;
      reason?: "timeout" | "ambiguous" | "partner_died" | "window_gone";
      terminal?: PartnerLifecycleTerminal;
      /** The resolved transcript path, carried on a `timeout` (the caller reads
       *  it once for the bounded partial) or on `window_gone`/`partner_died`
       *  (diagnostic only — a boundary-qualified stop would have returned `ok`,
       *  so no terminal message is recoverable and none is mined). */
      transcriptPath?: string;
      /** Set on a `timeout` reason: the Partner liveness re-probed at the
       *  observation deadline, so the caller's guidance separates a positively-
       *  live Partner from unknown evidence without ever claiming termination. */
      liveness?: PartnerLiveness;
    };

/**
 * Block until the handle's transcript shows the next per-backend stop event,
 * resolving the transcript path first when the handle is a run id. Returns the
 * stop record (carrying the final message text when the backend exposes it).
 *
 * Path discovery and the stop wait share ONE absolute deadline derived from the
 * handle's stop budget: pi creates its session file only at the first assistant
 * message, so a healthy slow leg can legitimately spend most of the budget
 * before any file exists — path discovery may consume the whole remainder for
 * pi, while the fast-writing harnesses keep their small discovery window. The
 * stop wait then gets exactly what is left, so total wall time obeys the one
 * budget instead of stacking a fresh stop budget on top of the path window.
 */
export async function runWaitForStop(
  handle: ResolvedHandle,
  deps: VerbDeps,
): Promise<WaitForStopResult> {
  const now = deps.now ?? Date.now;
  const totalMs = handle.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  // A 0 stopTimeoutMs (an over-budget capture, floored to a single non-sleeping
  // scan by captureFromHandle) means OBSERVATIONS ONLY: each watcher stage does
  // exactly one scan and NO poll sleep. Pin both relative timeouts to a LITERAL
  // 0 — deriving a remainder from the wall clock would re-arm a sleep if the
  // clock moved backward between samples (deadline - a smaller now() > 0). Only a
  // positive budget derives its remainder from the clock.
  const observationOnly = totalMs === 0;
  const deadlineMs = now() + totalMs;
  const remainingForPath = observationOnly
    ? 0
    : Math.max(0, deadlineMs - now());
  const pathTimeoutMs =
    handle.agent === "pi"
      ? remainingForPath
      : Math.min(
          defaultTranscriptPathTimeoutMs(handle.agent),
          remainingForPath,
        );
  const probeWindow = windowProbe(handle, deps);
  const resolved = await resolveTranscriptPath(
    handle,
    deps,
    pathTimeoutMs,
    probeWindow,
  );
  if (!resolved.ok) {
    if (resolved.reason === "partner_died") {
      return partnerDiedFailure(resolved.terminal);
    }
    // The window is positively gone and no transcript ever appeared: a truthful
    // terminal with no message to recover, never a burned deadline.
    if (resolved.reason === "window_gone") {
      return windowGoneFailure();
    }
    return transcriptPathFailure(resolved.reason);
  }
  const transcriptPath = resolved.path;
  const outcome = await waitForTranscriptStop({
    agent: handle.agent,
    cwd: handle.cwd,
    env: deps.env,
    homeDir: deps.homeDir,
    startedAtMs: handle.startedAtMs,
    sessionId: handle.sessionId,
    isResume: handle.isResume,
    invocationStopFloor: handle.invocationStopFloor,
    injectedMessageMarker: handle.injectedMessageMarker,
    transcriptLineFloor: handle.transcriptLineFloor,
    lifecycleProbe: lifecycleProbe(handle, deps),
    windowProbe: probeWindow,
    transcriptPath,
    // Same literal-0 rule as the path stage: an exhausted budget observes once
    // and never sleeps, whatever the wall clock did between samples.
    stopTimeoutMs: observationOnly ? 0 : Math.max(0, deadlineMs - now()),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  // A bounded timeout maps to the caller's RETRYABLE (exit 4) path, mirroring the
  // transcript-path timeout above — a retryable transient, not a wrong answer.
  // The error self-reports the effective deadline and its source so the next
  // failure tells us whether the caller's --stop-timeout or the default bit.
  if (!outcome.ok) {
    if ("partnerDied" in outcome) {
      return {
        ...partnerDiedFailure(outcome.terminal),
        transcriptPath,
      };
    }
    // The window went positively gone with no boundary-qualified stop (the wait
    // already did the final stop re-read; a real stop would have returned `ok`).
    // Carry the known path for diagnostics only — no final message is recovered.
    if ("windowGone" in outcome) {
      return windowGoneFailure(transcriptPath);
    }
    // The deadline elapsed with no settled stop. Re-probe lifecycle ONCE so the
    // caller reports honest liveness — positively live vs unknown — without ever
    // treating the elapsed deadline as a termination.
    const liveness = await probeLivenessAtDeadline(
      lifecycleProbe(handle, deps),
    );
    const source = handle.stopTimeoutMs !== null ? "caller" : "default";
    return {
      ok: false,
      reason: "timeout",
      transcriptPath,
      liveness,
      error: `timed out waiting for transcript stop after ${totalMs}ms (${source})`,
    };
  }
  return { ok: true, transcriptPath, stop: outcome.stop };
}

export type ShowLastMessageResult =
  | { ok: true; transcriptPath: string; text: string | null; found: boolean }
  | {
      ok: false;
      error: string;
      reason?: "timeout" | "ambiguous" | "partner_died";
    };

/**
 * Resolve the handle's transcript and return the partner's final assistant
 * message. Works on a finished OR in-flight run — it never blocks past the
 * transcript-path discovery. `text:null, found:true` is a defined empty signal
 * (tool-only / refusal final turn); `found:false` means no assistant message
 * exists yet.
 */
export async function runShowLastMessage(
  handle: ResolvedHandle,
  deps: VerbDeps,
): Promise<ShowLastMessageResult> {
  const resolved = await resolveTranscriptPath(handle, deps);
  if (!resolved.ok) {
    if (resolved.reason === "partner_died") {
      return partnerDiedFailure(resolved.terminal);
    }
    // `show-last-message` never window-probes (it passes no probe above), so
    // `window_gone` is unreachable here; map it defensively to the same
    // partner-gone terminal rather than a plain path failure.
    if (resolved.reason === "window_gone") {
      return partnerDiedFailure({
        kind: "terminal",
        state: "killed",
        reason: "window-absent",
      });
    }
    return transcriptPathFailure(resolved.reason);
  }
  const transcriptPath = resolved.path;
  const last = findLastMessage(handle.agent, transcriptPath, {
    isResume: handle.isResume,
    startedAtMs: handle.startedAtMs,
    invocationStopFloor: handle.invocationStopFloor,
    injectedMessageMarker: handle.injectedMessageMarker,
    transcriptLineFloor: handle.transcriptLineFloor,
  });
  return {
    ok: true,
    transcriptPath,
    text: last.text,
    found: last.found,
  };
}

/**
 * A direct-path handle resolves to itself; a run-id handle polls for the
 * backend's transcript file (bounded by the watcher's path timeout). The `ambiguous` failure is propagated distinctly so the caller never degrades it into a plain
 * path-timeout (or, worse, a guessed foreign transcript).
 */
async function resolveTranscriptPath(
  handle: ResolvedHandle,
  deps: VerbDeps,
  pathTimeoutMs?: number,
  probeWindow?: () => Promise<WindowLiveness>,
): Promise<WaitForPathOutcome> {
  if (handle.transcriptPath !== null) {
    return { ok: true, path: handle.transcriptPath };
  }
  return waitForTranscriptPath({
    agent: handle.agent,
    cwd: handle.cwd,
    env: deps.env,
    homeDir: deps.homeDir,
    startedAtMs: handle.startedAtMs,
    sessionId: handle.sessionId,
    isResume: handle.isResume,
    invocationStopFloor: handle.invocationStopFloor,
    injectedMessageMarker: handle.injectedMessageMarker,
    transcriptLineFloor: handle.transcriptLineFloor,
    lifecycleProbe: lifecycleProbe(handle, deps),
    windowProbe: probeWindow,
    pathTimeoutMs,
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
}

/** Map a transcript-path resolution failure to a verb result — carrying the
 *  `reason` so run-capture separates a concurrent-session collision
 *  (`transcript_ambiguous`) from a transcript that never appeared. */
function lifecycleProbe(
  handle: ResolvedHandle,
  deps: VerbDeps,
): (() => Promise<PartnerLifecycle>) | undefined {
  const jobId = handle.lifecycleJobId;
  const probe = deps.probePartnerLifecycle;
  return typeof jobId === "string" && jobId !== "" && probe !== undefined
    ? () => probe(jobId)
    : undefined;
}

/** Bind the handle's tmux window presence-probe argv to the injected runner, or
 *  undefined when either is absent — the wait then does no window probing and
 *  behaves byte-identically to today (lifecycle-probe + deadline only). */
function windowProbe(
  handle: ResolvedHandle,
  deps: VerbDeps,
): (() => Promise<WindowLiveness>) | undefined {
  const command = handle.tmuxWindowProbeCommand;
  const probe = deps.probeWindowPresence;
  return Array.isArray(command) && command.length > 0 && probe !== undefined
    ? () => probe(command)
    : undefined;
}

/**
 * Re-probe the Partner lifecycle at the observation deadline, collapsed to the
 * honest `live` / `unknown` liveness a timeout may report. Only a positively-live
 * folded state yields `live`; an absent probe, a throw, or ANY non-live result
 * (including a racing terminal, which the polling loop did not observe as a
 * settled death) collapses to `unknown`, so a timeout never overclaims the
 * Partner is alive nor launders itself into a confirmed termination.
 */
async function probeLivenessAtDeadline(
  probe: (() => Promise<PartnerLifecycle>) | undefined,
): Promise<PartnerLiveness> {
  if (probe === undefined) {
    return "unknown";
  }
  try {
    const lifecycle = await probe();
    return lifecycle.kind === "live" ? "live" : "unknown";
  } catch {
    return "unknown";
  }
}

function partnerDiedFailure(terminal: PartnerLifecycleTerminal): {
  ok: false;
  error: string;
  reason: "partner_died";
  terminal: PartnerLifecycleTerminal;
} {
  return {
    ok: false,
    reason: "partner_died",
    terminal,
    error: `partner died: folded job state is ${terminal.state}${terminal.reason ? ` (${terminal.reason})` : ""}`,
  };
}

function transcriptPathFailure(reason: "timeout" | "ambiguous"): {
  ok: false;
  error: string;
  reason: "timeout" | "ambiguous";
} {
  return {
    ok: false,
    reason,
    error:
      reason === "ambiguous"
        ? "transcript ambiguous: multiple concurrent same-cwd sessions match, cannot attribute"
        : "timed out waiting for transcript path",
  };
}

/** The positive-gone terminal: the launch's tmux window is absent AND the wait's
 *  final stop re-read found no boundary-qualified stop. The known transcript path
 *  rides only as diagnostic detail — no terminal message is recoverable, so the
 *  caller emits `partner_died` and never mines interim text. Distinct from
 *  `timeout` — the target is confirmed gone, not merely unobserved. */
function windowGoneFailure(transcriptPath?: string): {
  ok: false;
  error: string;
  reason: "window_gone";
  transcriptPath?: string;
} {
  return {
    ok: false,
    reason: "window_gone",
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    error: "wait target is positively gone: its tmux window is absent",
  };
}
