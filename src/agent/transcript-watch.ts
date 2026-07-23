import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentKind } from "./dispatch";

export interface TranscriptStop {
  agent: AgentKind;
  eventType: string;
  reason: string;
  timestamp: string | null;
  /**
   * The final assistant message text carried by the stop event, when the
   * backend's stop record exposes it (Claude/Pi assistant content). `null` for a tool-only / structural stop with
   * no readable text — `show-last-message` then falls back to scanning the
   * transcript for the latest assistant text.
   */
  message: string | null;
}

/**
 * The partner's final assistant message resolved for `show-last-message`.
 * `text` is null on an empty/tool-only/refusal final turn so a caller never
 * mistakes a structural stop for an empty answer; `found` records whether ANY
 * assistant message was located at all.
 */
export interface LastMessage {
  agent: AgentKind;
  text: string | null;
  found: boolean;
}

export type PartnerLifecycle =
  | { kind: "live" }
  | { kind: "terminal"; state: "ended" | "killed"; reason: string | null }
  | { kind: "unknown" };

/**
 * A launch's tmux window liveness as a single positive-existence probe reads it:
 * `present` (the window resolves), `absent` (POSITIVE evidence it is gone — the
 * server or window reports not-found), or `unknown` (a transient/inconclusive
 * probe error). Only `absent` terminates a wait; `unknown` keeps it honest, so
 * a flaky probe never masquerades as a termination.
 */
export type WindowLiveness = "present" | "absent" | "unknown";

export interface TranscriptWatchOptions {
  agent: AgentKind;
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  startedAtMs: number;
  sessionId: string | null;
  pollIntervalMs?: number;
  pathTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Persisted before launch for a resumed transcript whose timestamps are not
   *  an invocation boundary. Missing keeps legacy late-sampled behavior. */
  invocationStopFloor?: number | null;
  /** Opaque Bus artifact id whose injected notification opens response capture. */
  injectedMessageMarker?: string | null;
  /** Transcript line count sampled before the matching Bus publish. */
  transcriptLineFloor?: number | null;
  /** Exact folded-job probe. Omitted for direct paths and legacy run artifacts. */
  lifecycleProbe?: () => Promise<PartnerLifecycle>;
  /** Tri-state positive-existence probe for the launch's OWN tmux window (the
   *  handle IS a tmux identity). A positively `absent` window terminates the
   *  wait within one poll tick; `present`/`unknown` keep waiting — an
   *  inconclusive/transient probe never terminates. Omitted for direct-path
   *  handles and legacy artifacts with no window target, so the wait then
   *  behaves byte-identically (lifecycle-probe + deadline only). */
  windowProbe?: () => Promise<WindowLiveness>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Resume marker: when true, transcript DISCOVERY resolves a PRE-EXISTING
   * session file rather than a fresh one. Claude/Pi are strict-pinned by their
   * session id. Claude anchors the stop-scan at {@link startedAtMs}; Pi re-stamps its copied history with resume-time
   * timestamps, defeating that window, so a resumed pi wait anchors on a
   * structural stop-count watermark instead (see {@link waitForTranscriptStop}).
   * Omitted/false = fresh launch, byte-unchanged.
   */
  isResume?: boolean;
}

/** A `waitForTranscriptStop` result that timed out before any stop appeared. */
export type WaitForStopOutcome =
  | { ok: true; stop: TranscriptStop }
  | { ok: false; timedOut: true }
  | { ok: false; partnerDied: true; terminal: PartnerLifecycleTerminal }
  | { ok: false; windowGone: true };

export type PartnerLifecycleTerminal = Extract<
  PartnerLifecycle,
  { kind: "terminal" }
>;

/**
 * A single-tick transcript-path lookup.
 *  - `found`: exactly one positively-attributed transcript.
 *  - `pending`: nothing attributable yet — the caller keeps polling.
 *  - `ambiguous`: more than one candidate the leg cannot attribute to itself
 *   . `ambiguous` is terminal because a confident wrong transcript is worse than
 *  a retryable failure.
 */
type TranscriptPathLookup =
  | { kind: "found"; path: string }
  | { kind: "pending" }
  | { kind: "ambiguous" };

/** The terminal outcome of {@link waitForTranscriptPath}: a resolved path, or a
 *  failure discriminated so the caller maps a concurrent-session collision to a
 *  DISTINCT non-completed outcome rather than the plain path-timeout. */
export type WaitForPathOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: "timeout" | "ambiguous" | "window_gone" }
  | {
      ok: false;
      reason: "partner_died";
      terminal: PartnerLifecycleTerminal;
    };

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_PATH_TIMEOUT_MS = 30_000;
const PI_PATH_TIMEOUT_MS = 120_000;

/**
 * Pi discovers and initializes profile packages before it creates a session
 * transcript. A cold package graph can legitimately exceed the ordinary path
 * window, so detached Pi runs get a wider discovery ceiling. Callers can still
 * override it explicitly in focused tests and probes.
 */
export function defaultTranscriptPathTimeoutMs(agent: AgentKind): number {
  return agent === "pi" ? PI_PATH_TIMEOUT_MS : DEFAULT_PATH_TIMEOUT_MS;
}

/**
 * Derive the READ-ONLY window-presence probe argv from a launch's socket-correct
 * `kill-window` argv (`[tmux, ...socketArgs, "kill-window", "-t", "@id"]`) →
 * `[tmux, ...socketArgs, "list-panes", "-t", "@id", "-F", "#{window_id}"]`. The
 * probe never mutates: it lists the window's panes, exiting non-zero with a
 * not-found stderr when the window (or its whole server) is gone. Null when the
 * input is not a well-formed kill-window argv, so a legacy/malformed control
 * yields NO probe rather than a guessed target — matching the exact-teardown
 * ownership discipline the kill argv already carries.
 */
export function windowPresenceProbeCommand(
  killWindowCommand: readonly string[] | null | undefined,
): string[] | null {
  if (!isTmuxKillWindowCommand(killWindowCommand)) {
    return null;
  }
  const windowId = killWindowCommand.at(-1) as string;
  return [
    ...killWindowCommand.slice(0, -3),
    "list-panes",
    "-t",
    windowId,
    "-F",
    "#{window_id}",
  ];
}

/**
 * The SINGLE STRUCTURAL authority for "is this a socket-correct tmux kill-window
 * argv": `[<abs-or-bare tmux>, (ZERO or ONE `-L`/`-S <value>` pair),
 * "kill-window", "-t", "@<digits>"]`, every token a non-empty string. It checks
 * STRUCTURE only — `command[0]` need only BASENAME to `tmux`, so it MAY accept a
 * renamed `/tmp/evil/tmux`. It is NOT the execution guard: what makes a renamed
 * binary inert is the effect-boundary trusted-argv0 replacement
 * ({@link withTrustedTmuxBin} in run-capture), which swaps argv0 for the current
 * trusted binary at the spawn. Shared with {@link windowPresenceProbeCommand} and
 * run-capture's control validator so the structural rule lives in exactly one place.
 */
export function isTmuxKillWindowCommand(command: unknown): command is string[] {
  if (!Array.isArray(command) || command.length < 4) {
    return false;
  }
  if (!command.every((token) => typeof token === "string" && token !== "")) {
    return false;
  }
  if (!/(?:^|\/)tmux$/.test(command[0] as string)) {
    return false;
  }
  // Launch parsing makes `-L`/`-S` MUTUALLY EXCLUSIVE, so the only producible
  // socket shape is ZERO or ONE pair — never repeated or both. Accepting `*`
  // pairs would bless producer-impossible argv the launcher can never emit.
  const socketArgs = command.slice(1, -3);
  if (socketArgs.length !== 0 && socketArgs.length !== 2) {
    return false;
  }
  if (
    socketArgs.length === 2 &&
    socketArgs[0] !== "-L" &&
    socketArgs[0] !== "-S"
  ) {
    return false;
  }
  return (
    command.at(-3) === "kill-window" &&
    command.at(-2) === "-t" &&
    /^@[0-9]+$/.test(command.at(-1) as string)
  );
}

/**
 * Wall-clock ceiling for the stop wait. A real model turn can run for minutes, so this is generous — it is a fail-loud backstop against
 * an unbounded hang, not a turn-length SLA. Overridable via `stopTimeoutMs`.
 */
export const DEFAULT_STOP_TIMEOUT_MS = 600_000;
const START_SLOP_MS = 1_000;

export async function waitForTranscriptPath(
  opts: TranscriptWatchOptions,
): Promise<WaitForPathOutcome> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? sleep;
  const deadline =
    now() + (opts.pathTimeoutMs ?? defaultTranscriptPathTimeoutMs(opts.agent));

  while (true) {
    const lookup = findTranscriptPath(opts);
    if (lookup.kind === "found") {
      return { ok: true, path: lookup.path };
    }
    // A concurrent-session collision won't resolve by waiting (both files keep
    // being written), so fail loud immediately rather than burning the deadline.
    if (lookup.kind === "ambiguous") {
      return { ok: false, reason: "ambiguous" };
    }
    const terminal = await probeTerminal(opts.lifecycleProbe);
    if (terminal !== null) {
      return { ok: false, reason: "partner_died", terminal };
    }
    // Positively-gone target: no transcript ever appeared and the window is gone,
    // so no message is recoverable — a truthful terminal, not a burned deadline.
    if (await probeWindowGone(opts.windowProbe)) {
      return { ok: false, reason: "window_gone" };
    }
    if (now() >= deadline) {
      return { ok: false, reason: "timeout" };
    }
    await wait(pollIntervalMs);
  }
}

export async function waitForTranscriptStop(
  opts: TranscriptWatchOptions & { transcriptPath: string },
): Promise<WaitForStopOutcome> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? sleep;
  const deadline = now() + (opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);

  // Pi re-stamps copied history on resume. New artifacts persist the structural
  // floor before launch; old callers retain the former wait-entry sampling.
  const resumeStopFloor =
    opts.isResume === true && opts.agent === "pi"
      ? (opts.invocationStopFloor ??
        countTranscriptStops(opts.agent, opts.transcriptPath))
      : null;

  while (true) {
    const stop = scanForStop(opts, resumeStopFloor);
    if (stop !== null) {
      return { ok: true, stop };
    }
    const terminal = await probeTerminal(opts.lifecycleProbe);
    if (terminal !== null) {
      // Stop-flush race: a clean end can write its stop AFTER the last scan but
      // before this terminal is observed. Re-read once for a boundary-qualified
      // stop; only a real stop upgrades to a completion — a non-terminal
      // assistant turn's interim text NEVER launders a death into success.
      const flushed = scanForStop(opts, resumeStopFloor);
      if (flushed !== null) {
        return { ok: true, stop: flushed };
      }
      return { ok: false, partnerDied: true, terminal };
    }
    // Positively-gone target: the window can vanish just after the leg flushes
    // its stop, so do the SAME actual-stop-only re-read. A boundary-qualified
    // stop → completion; otherwise the target is gone with no real terminal
    // turn, so report window gone (never a fabricated end from interim text).
    if (await probeWindowGone(opts.windowProbe)) {
      const flushed = scanForStop(opts, resumeStopFloor);
      if (flushed !== null) {
        return { ok: true, stop: flushed };
      }
      return { ok: false, windowGone: true };
    }
    if (now() >= deadline) {
      return { ok: false, timedOut: true };
    }
    await wait(pollIntervalMs);
  }
}

/**
 * One boundary-qualified stop scan — the injected-marker gate, the resumed-pi
 * structural floor, or the plain started-at window, exactly as the poll loop
 * selects. Factored out so the terminal / window-gone stop-flush re-read uses
 * the IDENTICAL detection as the loop, never a looser last-message fallback.
 */
function scanForStop(
  opts: TranscriptWatchOptions & { transcriptPath: string },
  resumeStopFloor: number | null,
): TranscriptStop | null {
  return opts.injectedMessageMarker != null
    ? findStopAfterInjectedMessage(
        opts.agent,
        opts.transcriptPath,
        opts.injectedMessageMarker,
        opts.transcriptLineFloor ?? 0,
      )
    : resumeStopFloor === null
      ? findTranscriptStop(opts.agent, opts.transcriptPath, opts.startedAtMs)
      : findStopPastFloor(opts.agent, opts.transcriptPath, resumeStopFloor);
}

/**
 * Resolve the partner's final assistant message from a transcript. Run handles
 * restrict the scan to their timestamp or structural invocation boundary;
 * boundary-free direct paths scan the whole file. `wait-for-stop` is the
 * blocking primitive; this just reads the latest.
 * Prefers the text carried on the latest stop event; if that stop is tool-only
 * (no text) it falls back to the latest assistant message with readable text.
 * `found:false` means no stop-or-text-bearing assistant turn was observed —
 * which includes a claude tool-only final turn, since `claudeStopFromObject`
 * excludes `stopReason:"tool_use"` and such a turn carries no assistant text,
 * so neither `sawStop` nor `sawAssistant` flips. `text:null` with `found:true`
 * means a turn was observed but carried no readable text.
 *
 * A persisted Pi stop floor is the authoritative resume cut. Legacy resumed Pi
 * handles fall back to the resumed turn's last user-role entry. Direct paths
 * and handles without a freshness boundary keep whole-file behavior.
 */
export function findLastMessage(
  agent: AgentKind,
  path: string,
  opts?: {
    isResume?: boolean;
    startedAtMs?: number;
    invocationStopFloor?: number | null;
    injectedMessageMarker?: string | null;
    transcriptLineFloor?: number | null;
  },
): LastMessage {
  const lines = readLines(path);
  const start =
    opts?.injectedMessageMarker != null
      ? lineIndexPastInjectedMarker(
          lines,
          opts.injectedMessageMarker,
          opts.transcriptLineFloor ?? 0,
        )
      : agent === "pi" &&
          opts?.invocationStopFloor !== null &&
          opts?.invocationStopFloor !== undefined
        ? lineIndexPastStopFloor(lines, agent, opts.invocationStopFloor)
        : opts?.isResume === true && agent === "pi"
          ? lastPiUserPromptIndex(lines)
          : 0;

  let latestStopText: string | null = null;
  let sawStop = false;
  let latestAssistantText: string | null = null;
  let sawAssistant = false;

  for (let i = start; i < lines.length; i++) {
    const parsed = parseJsonObject(lines[i] as string);
    if (parsed === null) {
      continue;
    }
    if (
      opts?.startedAtMs !== undefined &&
      opts.startedAtMs > 0 &&
      !withinStartWindow(parsed, opts.startedAtMs)
    ) {
      continue;
    }
    const stop = stopFromObject(agent, parsed);
    if (stop !== null) {
      sawStop = true;
      latestStopText = stop.message;
    }
    const text = assistantMessageText(agent, parsed);
    if (text !== null) {
      sawAssistant = true;
      latestAssistantText = text;
    }
  }

  if (sawStop) {
    return { agent, text: latestStopText ?? latestAssistantText, found: true };
  }
  if (sawAssistant) {
    return { agent, text: latestAssistantText, found: true };
  }
  return { agent, text: null, found: false };
}

/**
 * The index of the resumed pi turn's own prompt — the LAST user-role message
 * entry (`type:"message"`, `message.role:"user"`). Everything after it is this
 * turn's output; everything before is the re-stamped copied history. 0 when no
 * user entry is found, so the scan falls back to the whole file (nothing to cut).
 */
function lineIndexPastStopFloor(
  lines: string[],
  agent: AgentKind,
  floor: number,
): number {
  if (floor <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseJsonObject(lines[i] as string);
    if (parsed !== null && stopFromObject(agent, parsed) !== null) {
      seen++;
      if (seen === floor) return i + 1;
    }
  }
  return lines.length;
}

function lastPiUserPromptIndex(lines: string[]): number {
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseJsonObject(lines[i] as string);
    if (parsed !== null && isPiUserPrompt(parsed)) {
      idx = i;
    }
  }
  return idx;
}

function isPiUserPrompt(obj: Record<string, unknown>): boolean {
  if (stringValue(obj.type) !== "message") {
    return false;
  }
  return stringValue(objectValue(obj.message)?.role) === "user";
}

/**
 * Extract the readable assistant text from a single transcript line, or null
 * when the line is not a text-bearing assistant message. Mirrors the per-backend
 * stop shapes but is permissive: it pulls text from ANY assistant turn, not only
 * a terminal one, so a fallback scan can find the latest text (including a bounded
 * partial from an in-progress tool_use turn recovered on a timeout).
 */
function assistantMessageText(
  agent: AgentKind,
  obj: Record<string, unknown>,
): string | null {
  const type = stringValue(obj.type);
  const message = objectValue(obj.message);
  const role = stringValue(message?.role);
  // claude assistant turns are top-level `type:"assistant"`; pi assistant turns
  // are `type:"message"` with `message.role:"assistant"`. Both carry a
  // `message.content[]` text-block array.
  if (
    role === "assistant" &&
    ((agent === "claude" && type === "assistant") ||
      (agent === "pi" && type === "message"))
  ) {
    return contentArrayText(message?.content);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findTranscriptPath(
  opts: TranscriptWatchOptions,
): TranscriptPathLookup {
  // Claude/Pi pin their session id at launch, so their resolution is exact-or-
  // absent — never ambiguous. Map the string|null shape onto the lookup union.
  const path =
    opts.agent === "claude"
      ? findClaudeTranscriptPath(opts)
      : findPiTranscriptPath(opts);
  return path === null ? { kind: "pending" } : { kind: "found", path };
}

function findClaudeTranscriptPath(opts: TranscriptWatchOptions): string | null {
  const projectDir = join(
    opts.homeDir,
    ".claude",
    "projects",
    encodeClaudeCwd(opts.cwd),
  );
  // Strict pinned resolution: a pinned session id resolves to its EXACT
  // `<uuid>.jsonl` or null — never the newest-by-mtime fallback. A concurrent
  // driver in the same project dir writes a newer file; falling through to it is
  // the self-transcript collision this guards against. A future id divergence
  // surfaces as a loud path-timeout, not a silent wrong file. Newest-by-mtime is kept only for the no-id case.
  if (opts.sessionId !== null) {
    const exact = join(projectDir, `${opts.sessionId}.jsonl`);
    return existsSync(exact) ? exact : null;
  }
  return newestFreshFile(jsonlFiles(projectDir, false), opts.startedAtMs);
}

function findPiTranscriptPath(opts: TranscriptWatchOptions): string | null {
  const roots = uniqueStrings([
    (opts.env.PI_CODING_AGENT_DIR ?? "").trim() || null,
    join(opts.homeDir, ".pi", "agent"),
  ]);

  for (const root of roots) {
    const sessionsDir = join(root, "sessions");
    const cwdDir = join(sessionsDir, encodePiCwd(opts.cwd));
    const local = findPiTranscriptInFiles(jsonlFiles(cwdDir, false), opts);
    if (local !== null) {
      return local;
    }
    const recursive = findPiTranscriptInFiles(
      jsonlFiles(sessionsDir, true),
      opts,
    );
    if (recursive !== null) {
      return recursive;
    }
  }
  return null;
}

function findPiTranscriptInFiles(
  files: string[],
  opts: TranscriptWatchOptions,
): string | null {
  // Strict pinned resolution (mirrors claude): a pinned session id resolves to
  // its id-matching file or null — never the newest-by-mtime fallback, so a
  // concurrently-written decoy can't win. Newest-by-mtime serves only the no-id
  // case below.
  if (opts.sessionId !== null) {
    const idMatches = files.filter((path) => {
      return (
        basename(path).includes(opts.sessionId ?? "") ||
        readPiMeta(path).id === opts.sessionId
      );
    });
    return newestFile(idMatches);
  }

  const fresh = freshFiles(files, opts.startedAtMs);
  const cwdMatches = fresh.filter((path) => readPiMeta(path).cwd === opts.cwd);
  return newestFile(cwdMatches) ?? newestFile(fresh);
}

/**
 * The count of per-backend stop markers already in a transcript — the resumed-pi
 * watermark's floor, sampled ONCE as the wait begins. See {@link
 * waitForTranscriptStop}.
 */
export function countTranscriptStops(agent: AgentKind, path: string): number {
  let count = 0;
  for (const line of readLines(path)) {
    const parsed = parseJsonObject(line);
    if (parsed !== null && stopFromObject(agent, parsed) !== null) {
      count++;
    }
  }
  return count;
}

/**
 * The first stop strictly past `floor` prior stops in file order — the resumed
 * turn's own stop, anchored past the re-stamped copied history structurally
 * rather than by a timestamp window pi's re-stamping defeats. Null until the turn
 * appends stop number `floor + 1`.
 */
function findStopPastFloor(
  agent: AgentKind,
  path: string,
  floor: number,
): TranscriptStop | null {
  let seen = 0;
  for (const line of readLines(path)) {
    const parsed = parseJsonObject(line);
    if (parsed === null) {
      continue;
    }
    const stop = stopFromObject(agent, parsed);
    if (stop === null) {
      continue;
    }
    if (seen < floor) {
      seen++;
      continue;
    }
    return stop;
  }
  return null;
}

export function snapshotInvocationStopFloor(
  opts: TranscriptWatchOptions,
): number | null {
  if (opts.agent !== "pi" || opts.isResume !== true) return null;
  const lookup = findTranscriptPath(opts);
  return lookup.kind === "found"
    ? countTranscriptStops(opts.agent, lookup.path)
    : null;
}

export interface InjectedMessageCaptureBoundary {
  transcriptPath: string;
  lineFloor: number;
}

export function snapshotInjectedMessageCaptureBoundary(
  opts: TranscriptWatchOptions,
): InjectedMessageCaptureBoundary | null {
  const lookup = findTranscriptPath(opts);
  if (lookup.kind !== "found") return null;
  return {
    transcriptPath: lookup.path,
    lineFloor: readLines(lookup.path).length,
  };
}

async function probeTerminal(
  probe: TranscriptWatchOptions["lifecycleProbe"],
): Promise<PartnerLifecycleTerminal | null> {
  if (probe === undefined) return null;
  try {
    const outcome = await probe();
    return outcome.kind === "terminal" ? outcome : null;
  } catch {
    return null;
  }
}

/**
 * Collapse the tri-state {@link WindowLiveness} probe to the wait's terminate/
 * keep-waiting decision: ONLY a positively `absent` window terminates the wait
 * (the target is gone). `present`, `unknown`, an omitted probe, or a throw all
 * keep waiting — an inconclusive probe must never masquerade as a termination.
 */
async function probeWindowGone(
  probe: TranscriptWatchOptions["windowProbe"],
): Promise<boolean> {
  if (probe === undefined) return false;
  try {
    return (await probe()) === "absent";
  } catch {
    return false;
  }
}

function lineIndexPastInjectedMarker(
  lines: string[],
  marker: string,
  floor: number,
): number {
  for (let i = Math.max(0, floor); i < lines.length; i++) {
    const parsed = parseJsonObject(lines[i] as string);
    if (parsed !== null && transcriptInjectionCarries(parsed, marker)) {
      return i + 1;
    }
  }
  return lines.length;
}

function transcriptInjectionCarries(
  obj: Record<string, unknown>,
  marker: string,
): boolean {
  const message = objectValue(obj.message);
  if (stringValue(message?.role) === "assistant") return false;
  const candidates: unknown[] = [obj.content, message?.content];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.includes(marker)) {
      return true;
    }
    if (Array.isArray(candidate)) {
      for (const block of candidate) {
        const text =
          typeof block === "object" && block !== null
            ? stringValue((block as Record<string, unknown>).text)
            : null;
        if (text?.includes(marker)) return true;
      }
    }
  }
  return false;
}

function findStopAfterInjectedMessage(
  agent: AgentKind,
  path: string,
  marker: string,
  floor: number,
): TranscriptStop | null {
  if (agent === "claude") {
    return findClaudeStopGated(path, 0, marker, floor);
  }
  const lines = readLines(path);
  const start = lineIndexPastInjectedMarker(lines, marker, floor);
  for (let i = start; i < lines.length; i++) {
    const parsed = parseJsonObject(lines[i] as string);
    if (parsed === null) continue;
    const stop = stopFromObject(agent, parsed);
    if (stop !== null) return stop;
  }
  return null;
}

function findTranscriptStop(
  agent: AgentKind,
  path: string,
  startedAtMs: number,
): TranscriptStop | null {
  // claude gates terminality on background-agent quiescence (a settled stop);
  // Pi keeps the plain first-stop scan.
  if (agent === "claude") {
    return findClaudeStopGated(path, startedAtMs);
  }
  for (const line of readLines(path)) {
    const parsed = parseJsonObject(line);
    if (parsed === null) {
      continue;
    }
    const eventMs = objectTimestampMs(parsed);
    if (eventMs !== null && eventMs < startedAtMs - START_SLOP_MS) {
      continue;
    }
    const stop = stopFromObject(agent, parsed);
    if (stop !== null) {
      return stop;
    }
  }
  return null;
}

/**
 * The claude stop scan, gated on background-agent quiescence. A claude session
 * can end a turn while background agents it launched (Agent tool /
 * `run_in_background`) are still working; the harness later injects their
 * results and the session runs the turns that carry the real answer. A
 * first-stop-wins scan captures the premature turn, so claude terminality is
 * gated on a SETTLED stop: a stop marker is accepted only when no launched
 * background agent is still outstanding at that point AND no governing
 * turn_duration line reports a nonzero pendingBackgroundAgentCount.
 *
 * Line order is authoritative — transcript timestamps are non-monotonic. The
 * pending set is tracked across the WHOLE file with no started-at filter (a
 * launch predating the wait but still outstanding must block quiescence), while
 * stop ACCEPTANCE keeps the started-at window. Everything fails open: a
 * transcript carrying none of the markers behaves byte-identically to the plain
 * first-stop parser, malformed lines are skipped, and the stop-timeout ceiling
 * still bounds the wait. A retired child resumed via SendMessage re-arms work
 * the pending set no longer sees — the final-message directive carries that.
 */
function findClaudeStopGated(
  path: string,
  startedAtMs: number,
  injectedMarker: string | null = null,
  lineFloor = 0,
): TranscriptStop | null {
  const pending = new Set<string>();
  // A stop held pending its governing turn_duration's count. turn_duration
  // trails the assistant end_turn by a beat in file order, so an accepted
  // assistant stop is provisional until its turn_duration confirms it (count
  // absent/zero) or rejects it (count nonzero); a dangling provisional with no
  // trailing turn_duration is accepted at end-of-scan, since the count rule
  // only binds when a governing line exists.
  let provisional: TranscriptStop | null = null;
  let injectedSeen = injectedMarker === null;
  const lines = readLines(path);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const mayCarryInjection =
      !injectedSeen &&
      i >= lineFloor &&
      line.includes(injectedMarker as string);
    if (!hasClaudeMarker(line) && !mayCarryInjection) {
      continue;
    }
    const parsed = parseJsonObject(line);
    if (parsed === null) {
      continue;
    }
    if (
      mayCarryInjection &&
      transcriptInjectionCarries(parsed, injectedMarker as string)
    ) {
      injectedSeen = true;
      provisional = null;
      continue;
    }

    // Pending-set maintenance runs over the WHOLE file (no started-at filter).
    const launchId = claudeAsyncLaunchedAgentId(parsed);
    if (launchId !== null) {
      pending.add(launchId);
    }
    for (const retiredId of claudeRetiredAgentIds(parsed)) {
      pending.delete(retiredId);
    }

    if (isClaudeTurnDuration(parsed)) {
      const count = claudeTurnDurationCount(parsed);
      // Nonzero count: the turn ended with live background children, so its
      // stop is premature — reject the provisional and keep scanning.
      if (count !== null && count > 0) {
        provisional = null;
        continue;
      }
      // Count absent or zero: the turn is settled. Confirm the turn's
      // text-bearing assistant stop, else the turn_duration is itself a
      // structural stop.
      if (injectedSeen && provisional !== null && pending.size === 0) {
        return provisional;
      }
      provisional = null;
      if (
        injectedSeen &&
        pending.size === 0 &&
        withinStartWindow(parsed, startedAtMs)
      ) {
        return claudeStopFromObject(parsed);
      }
      continue;
    }

    // A non-turn_duration line: an assistant / stop_hook_summary stop candidate.
    // Hold the FIRST settled candidate as provisional (freeze-on-first); a
    // trailing turn_duration may still reject it on a nonzero count.
    if (
      injectedSeen &&
      provisional === null &&
      pending.size === 0 &&
      withinStartWindow(parsed, startedAtMs)
    ) {
      const stop = claudeStopFromObject(parsed);
      if (stop !== null) {
        provisional = stop;
      }
    }
  }

  return provisional;
}

/**
 * The marker substrings a claude stop-scan line must contain to matter — a
 * background launch, a retire, or any of the three stop shapes. A line with
 * none affects neither the pending set nor stop detection, so it is skipped
 * before the JSON parse (a false positive just gets parsed and rejected).
 */
const CLAUDE_STOP_SCAN_MARKERS: readonly string[] = [
  "async_launched",
  "task-id",
  "stop_reason",
  "turn_duration",
  "stop_hook_summary",
];

function hasClaudeMarker(line: string): boolean {
  for (const marker of CLAUDE_STOP_SCAN_MARKERS) {
    if (line.includes(marker)) {
      return true;
    }
  }
  return false;
}

function withinStartWindow(
  obj: Record<string, unknown>,
  startedAtMs: number,
): boolean {
  const eventMs = objectTimestampMs(obj);
  return eventMs === null || eventMs >= startedAtMs - START_SLOP_MS;
}

function isClaudeTurnDuration(obj: Record<string, unknown>): boolean {
  return (
    stringValue(obj.type) === "system" &&
    stringValue(obj.subtype) === "turn_duration"
  );
}

/**
 * The `pendingBackgroundAgentCount` a turn_duration line carries, or null when
 * the field is absent/non-numeric. Null imposes NO count constraint (fail-open);
 * only a strictly positive value blocks stop acceptance.
 */
function claudeTurnDurationCount(obj: Record<string, unknown>): number | null {
  const count = obj.pendingBackgroundAgentCount;
  return typeof count === "number" ? count : null;
}

/**
 * The `agentId` a claude background-agent LAUNCH line arms, or null. A launch is
 * a user tool_result whose top-level `toolUseResult` is an OBJECT with
 * `status:"async_launched"`. A FAILED launch carries a STRING `toolUseResult`
 * (with an is_error tool_result) — the object check excludes it, so it never
 * enters the pending set.
 */
function claudeAsyncLaunchedAgentId(
  obj: Record<string, unknown>,
): string | null {
  const result = objectValue(obj.toolUseResult);
  if (result === null || stringValue(result.status) !== "async_launched") {
    return null;
  }
  return stringValue(result.agentId);
}

const CLAUDE_TERMINAL_STATUS = /<status>(?:completed|failed|killed)<\/status>/;
const CLAUDE_TASK_ID = /<task-id>([^<]+)<\/task-id>/g;

/**
 * The background-agent ids a claude line RETIRES. Two carriers, both string
 * bodies embedding a `<task-id>…</task-id>` alongside a terminal `<status>`:
 * queue-operation lines (top-level `content`, any operation) and injected
 * task-notification user lines (`message.content`). A normal assistant/user
 * turn carries an ARRAY `content`, which yields no string body — so only a
 * genuine notification retires. Retiring a non-member is a caller-side no-op,
 * keeping descendant-agent and backgrounded-Bash notifications from gating.
 */
function claudeRetiredAgentIds(obj: Record<string, unknown>): string[] {
  const ids: string[] = [];
  collectRetiredIds(stringValue(obj.content), ids);
  collectRetiredIds(stringValue(objectValue(obj.message)?.content), ids);
  return ids;
}

function collectRetiredIds(body: string | null, into: string[]): void {
  if (body === null || !CLAUDE_TERMINAL_STATUS.test(body)) {
    return;
  }
  for (const match of body.matchAll(CLAUDE_TASK_ID)) {
    const id = match[1];
    if (id !== undefined) {
      into.push(id);
    }
  }
}

function stopFromObject(
  agent: AgentKind,
  obj: Record<string, unknown>,
): TranscriptStop | null {
  if (agent === "claude") {
    return claudeStopFromObject(obj);
  }
  return piStopFromObject(obj);
}

function claudeStopFromObject(
  obj: Record<string, unknown>,
): TranscriptStop | null {
  const type = stringValue(obj.type);
  const message = objectValue(obj.message);
  const stopReason = stringValue(message?.stop_reason);
  if (
    type === "assistant" &&
    stopReason !== null &&
    stopReason !== "tool_use"
  ) {
    return stopInfo(
      "claude",
      "assistant",
      stopReason,
      obj,
      claudeMessageText(obj),
    );
  }

  const subtype = stringValue(obj.subtype);
  if (type === "system" && subtype === "turn_duration") {
    return stopInfo("claude", subtype, "turn_duration", obj, null);
  }
  if (type === "system" && subtype === "stop_hook_summary") {
    return stopInfo(
      "claude",
      subtype,
      stringValue(obj.stopReason) ?? "stop",
      obj,
      null,
    );
  }
  return null;
}

function piStopFromObject(obj: Record<string, unknown>): TranscriptStop | null {
  const type = stringValue(obj.type);
  if (type === "turn.completed" || type === "turn.failed") {
    return stopInfo("pi", type, type, obj, null);
  }

  const message = objectValue(obj.message);
  const role = stringValue(message?.role);
  const stopReason = stringValue(message?.stopReason);
  if (
    type === "message" &&
    role === "assistant" &&
    stopReason !== null &&
    stopReason !== "toolUse"
  ) {
    return stopInfo("pi", "assistant", stopReason, obj, piMessageText(obj));
  }
  return null;
}

function stopInfo(
  agent: AgentKind,
  eventType: string,
  reason: string,
  obj: Record<string, unknown>,
  message: string | null,
): TranscriptStop {
  return {
    agent,
    eventType,
    reason,
    timestamp: stringValue(obj.timestamp),
    message,
  };
}

/**
 * Concatenate the text of an assistant `message.content[]` block array (claude
 * and pi share this shape). Thinking / tool-use / non-text blocks are skipped.
 * Returns null when no text block carries content, so a tool-only final turn is
 * a defined empty signal rather than a misleading "".
 */
function contentArrayText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "text") {
      const text = stringValue(b.text);
      if (text !== null && text !== "") {
        parts.push(text);
      }
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function claudeMessageText(obj: Record<string, unknown>): string | null {
  return contentArrayText(objectValue(obj.message)?.content);
}

function piMessageText(obj: Record<string, unknown>): string | null {
  return contentArrayText(objectValue(obj.message)?.content);
}

function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function encodePiCwd(cwd: string): string {
  const trimmed = cwd.replace(/^\/+|\/+$/g, "");
  return `--${trimmed.replace(/\//g, "-")}--`;
}

function jsonlFiles(root: string, recursive: boolean): string[] {
  try {
    const stat = statSync(root);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: Array<{
      name: string | Buffer;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = String(entry.name);
      const path = join(dir, name);
      if (entry.isDirectory()) {
        if (recursive) {
          visit(path);
        }
      } else if (entry.isFile() && name.endsWith(".jsonl")) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

function freshFiles(files: string[], startedAtMs: number): string[] {
  return files.filter((path) => {
    const stat = safeStat(path);
    return stat !== null && stat.mtimeMs >= startedAtMs - START_SLOP_MS;
  });
}

function newestFreshFile(files: string[], startedAtMs: number): string | null {
  return newestFile(freshFiles(files, startedAtMs));
}

function newestFile(files: string[]): string | null {
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const path of files) {
    const stat = safeStat(path);
    if (stat === null) {
      continue;
    }
    if (newest === null || stat.mtimeMs > newest.mtimeMs) {
      newest = { path, mtimeMs: stat.mtimeMs };
    }
  }
  return newest?.path ?? null;
}

function safeStat(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readPiMeta(path: string): { id: string | null; cwd: string | null } {
  for (const line of readLines(path, 64 * 1024)) {
    const parsed = parseJsonObject(line);
    if (parsed?.type !== "session") {
      continue;
    }
    return {
      id: stringValue(parsed.id),
      cwd: stringValue(parsed.cwd),
    };
  }
  return { id: null, cwd: null };
}

function readLines(path: string, maxBytes?: number): string[] {
  try {
    let text = readFileSync(path, "utf8");
    if (maxBytes !== undefined && text.length > maxBytes) {
      text = text.slice(0, maxBytes);
    }
    return text.split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore partial JSONL lines while the agent is writing.
  }
  return null;
}

function objectTimestampMs(obj: Record<string, unknown>): number | null {
  const timestamp = obj.timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof timestamp === "number") {
    return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  }
  const message = objectValue(obj.message);
  const messageTimestamp = message?.timestamp;
  if (typeof messageTimestamp === "number") {
    return messageTimestamp > 1_000_000_000_000
      ? messageTimestamp
      : messageTimestamp * 1000;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [
    ...new Set(values.filter((value): value is string => value !== null)),
  ];
}
