/**
 * keeper's `/rename` Pi command — derives a short Session title from Pi's
 * active, compaction-aware conversation context and applies it through Pi's
 * own `setSessionName()`, never Keeper's DB or tmux directly. The branch-aware
 * Latest-turn CLI contract gates settled reads and serves older Pi hosts.
 *
 * SELF-CONTAINED ISLAND, same discipline as `keeper-events.ts`: this file
 * ships no static import of any `@earendil-works/*` package (that package is
 * not on keeper's own module path — see `docs/adr/0041`), so every Pi-shaped
 * type here is a hand-kept structural subset. The ONE exception is the host
 * completion boundary (`hostComplete`), which loads Pi's inference package
 * via a runtime `import()` INVOCATION-LOCALLY, inside the command handler,
 * never at module load — an import/API-shape failure there fails only that
 * one `/rename` invocation, never the Pi session.
 *
 * MUTATION DISCIPLINE: `runRenameInvocation` only ever COMPUTES an outcome;
 * `createRenameCommandHandler` is the sole call site of `pi.setSessionName()`,
 * and only on a freshly-revalidated "success" outcome — so "exactly once" is
 * a structural property, not a runtime accounting exercise.
 */

import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** The one fixed model this command ever resolves — no fallback (ADR 0041). */
export const RENAME_MODEL_PROVIDER = "openai-codex";
export const RENAME_MODEL_ID = "gpt-5.3-codex-spark";

/** Bounded model input: at most this many UTF-8 bytes of transcript text. */
export const RENAME_MAX_TRANSCRIPT_BYTES = 16 * 1024;
/** Bounded model output: a short title needs very few tokens. */
export const RENAME_MAX_RESPONSE_TOKENS = 64;
/** Minimal/disabled reasoning — this is a metadata completion, not a turn. */
export const RENAME_REASONING_EFFORT = "minimal";
/** Hard wall-clock budget for the whole completion call. */
export const RENAME_TIMEOUT_MS = 20_000;

/** Local read of the branch-aware turn contract; generous but bounded — this
 *  is a local file read through the `keeper` binary, never network I/O. */
const RENAME_TURN_CLI_TIMEOUT_MS = 10_000;
const RENAME_TURN_CLI_MAX_BUFFER = 256 * 1024;
const RENAME_MAX_READ_FAILURES = 3;
const RENAME_MAX_COMPLETION_ATTEMPTS = 3;

const RENAME_SYSTEM_PROMPT =
  "Generate a short session title (3-6 words) summarizing the overarching " +
  "work in the conversation below. Prioritize the user's requests, goals, " +
  "and repeated themes over assistant implementation detail. Respond with " +
  "ONLY the title text: no punctuation, no quotes, no preamble.";

/** Max slug length AFTER normalization. MUST match `SLUG_MAX_LEN` in
 *  `src/slug.ts` — copied because this file is isolated from keeper's `src/`
 *  tree and cannot import it. `test/pi-extension.test.ts` runs a shared
 *  corpus through both {@link renameSlugify} and the real `slugify` to catch
 *  drift. */
const RENAME_SLUG_MAX_LEN = 64;

// ---------------------------------------------------------------------------
// pure text helpers
// ---------------------------------------------------------------------------

/**
 * Strip ASCII control characters and Unicode bidi formatting/override
 * characters from raw model output BEFORE slugging — defense in depth
 * alongside {@link renameSlugify}'s own ASCII-only filter, so an accepted
 * title can never carry an embedded control sequence even if slugging were
 * ever bypassed. PURE.
 */
export function stripUnsafeText(text: string): string {
  return text
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate ASCII control strip.
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
      " ",
    )
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/**
 * Normalize free text to a `[a-z0-9-]+` slug, or `null` when the result is
 * empty. DELIBERATELY mirrors `slugify` in `src/slug.ts` byte-for-byte — the
 * isolation rule forbids importing it, so this is a hand-kept copy; a drift
 * corpus test in `test/pi-extension.test.ts` runs both through the same
 * inputs. PURE.
 */
export function renameSlugify(text: string): string | null {
  let s = String(text).normalize("NFKD");
  s = s.replace(/\p{M}/gu, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII-only gate.
  s = s.replace(/[^\x00-\x7F]/g, "");
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  if (s.length > RENAME_SLUG_MAX_LEN) {
    s = s.slice(0, RENAME_SLUG_MAX_LEN).replace(/-+$/g, "");
  }
  return s === "" ? null : s;
}

/**
 * Remove Pi's expanded skill envelopes from model input. Skill bodies are
 * instructions for the live agent, not session-title subject matter. PURE.
 */
export function stripSkillBlocks(text: string): string {
  return text.replace(/<skill(?:\s[^>]*)?>[\s\S]*?<\/skill>/g, "");
}

/**
 * Remove expanded skills, then bound the combined prompt+response text to
 * `maxBytes` UTF-8 bytes. PURE. A slice can land mid-codepoint; the model
 * input tolerates a truncated tail (this is completion input, never rendered
 * verbatim to a human).
 */
export function buildRenameInputText(
  prompt: string,
  response: string | null,
  maxBytes: number,
): string {
  const parts = [`User: ${prompt}`];
  if (response !== null && response.length > 0) {
    parts.push(`Assistant: ${response}`);
  }
  const combined = stripSkillBlocks(parts.join("\n\n"));
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return combined;
  }
  let sliceLen = combined.length;
  while (
    sliceLen > 0 &&
    Buffer.byteLength(combined.slice(0, sliceLen), "utf8") > maxBytes
  ) {
    sliceLen -= 1;
  }
  return combined.slice(0, sliceLen);
}

interface RenameContextMessage {
  role?: unknown;
  content?: unknown;
  summary?: unknown;
}

interface RenameConversationSection {
  label: "User" | "Assistant" | "Conversation summary";
  text: string;
  weight: number;
}

function contextText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let result = text.slice(0, low);
  if (/^[\uD800-\uDBFF]$/.test(result.at(-1) ?? "")) {
    result = result.slice(0, -1);
  }
  return result;
}

function allocateConversationBytes(
  sections: readonly RenameConversationSection[],
  budget: number,
): number[] {
  const allocations = sections.map(() => 0);
  let remaining = budget;
  let active = sections.map((_, index) => index);
  while (active.length > 0 && remaining > 0) {
    const totalWeight = active.reduce(
      (sum, index) => sum + (sections[index]?.weight ?? 0),
      0,
    );
    const unit = Math.floor(remaining / totalWeight);
    const completed = active.filter((index) => {
      const section = sections[index];
      return (
        section !== undefined &&
        Buffer.byteLength(section.text, "utf8") <= unit * section.weight
      );
    });
    if (completed.length === 0) {
      let assigned = 0;
      for (const index of active) {
        const section = sections[index];
        if (section === undefined) continue;
        const share = Math.floor((remaining * section.weight) / totalWeight);
        allocations[index] = share;
        assigned += share;
      }
      for (const index of [...active].reverse()) {
        if (assigned >= remaining) break;
        allocations[index] = (allocations[index] ?? 0) + 1;
        assigned += 1;
      }
      break;
    }
    const completedSet = new Set(completed);
    for (const index of completed) {
      const section = sections[index];
      if (section === undefined) continue;
      const bytes = Buffer.byteLength(section.text, "utf8");
      allocations[index] = bytes;
      remaining -= bytes;
    }
    active = active.filter((index) => !completedSet.has(index));
  }
  return allocations;
}

/** Build a bounded, chronological conversation excerpt from Pi's active,
 *  compaction-aware model context. User text receives twice the truncation
 *  weight of assistant detail; summaries remain available as context. PURE. */
export function buildRenameConversationInput(
  messages: readonly unknown[],
  maxBytes: number,
): string | null {
  const sections: RenameConversationSection[] = [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const message = raw as RenameContextMessage;
    let label: RenameConversationSection["label"];
    let text: string;
    let weight: number;
    if (message.role === "user") {
      label = "User";
      text = contextText(message.content);
      weight = 2;
    } else if (message.role === "assistant") {
      label = "Assistant";
      text = contextText(message.content);
      weight = 1;
    } else if (
      (message.role === "compactionSummary" ||
        message.role === "branchSummary") &&
      typeof message.summary === "string"
    ) {
      label = "Conversation summary";
      text = message.summary;
      weight = 1;
    } else {
      continue;
    }
    text = stripSkillBlocks(text).trim();
    if (text.length > 0) sections.push({ label, text, weight });
  }
  if (sections.length === 0 || maxBytes <= 0) return null;

  const separator = "\n\n";
  const overhead = sections.reduce(
    (bytes, section, index) =>
      bytes +
      Buffer.byteLength(`${section.label}: `, "utf8") +
      (index === 0 ? 0 : Buffer.byteLength(separator, "utf8")),
    0,
  );
  if (overhead >= maxBytes) {
    return truncateUtf8(
      sections
        .map((section) => `${section.label}: ${section.text}`)
        .join(separator),
      maxBytes,
    );
  }

  const allocations = allocateConversationBytes(sections, maxBytes - overhead);
  return sections
    .map(
      (section, index) =>
        `${section.label}: ${truncateUtf8(section.text, allocations[index] ?? 0)}`,
    )
    .join(separator);
}

// ---------------------------------------------------------------------------
// `keeper transcript pi turn` consumption
// ---------------------------------------------------------------------------

/** Build the argv for `keeper transcript pi turn` from a session snapshot. */
export function buildPiTurnArgv(
  sessionId: string,
  leaf: string,
  project: string,
): string[] {
  return [
    "transcript",
    "pi",
    "turn",
    sessionId,
    "--leaf",
    leaf,
    "--project",
    project,
    "--strip-skills",
    "--format",
    "json",
  ];
}

export interface TurnCliExit {
  stdout: string;
  stderr: string;
}

/** The three Latest-turn shapes, collapsed to what `/rename` needs. A CLI
 *  read/parse failure is its own `"error"` kind — NEVER confused with the
 *  legitimate `"empty"` (valid, no non-empty user text yet) case. */
export type TurnFetchOutcome =
  | { kind: "empty" }
  | { kind: "usable"; prompt: string; response: string | null }
  | { kind: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse `keeper transcript pi turn --format json`'s stdout envelope into a
 * {@link TurnFetchOutcome}. PURE — never throws; any shape surprise (bad
 * JSON, a failure envelope, a malformed data/turn shape) folds to `"error"`.
 */
export function parseTurnCliOutput(exit: TurnCliExit): TurnFetchOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exit.stdout);
  } catch {
    return { kind: "error", message: "malformed turn output" };
  }
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
    return { kind: "error", message: "malformed turn envelope" };
  }
  if (parsed.ok !== true) {
    const message =
      isRecord(parsed.error) && typeof parsed.error.message === "string"
        ? parsed.error.message
        : "turn read failed";
    return { kind: "error", message };
  }
  if (!isRecord(parsed.data)) {
    return { kind: "error", message: "malformed turn data" };
  }
  const turn = parsed.data.turn;
  if (turn === null) {
    return { kind: "empty" };
  }
  if (
    !isRecord(turn) ||
    typeof turn.prompt !== "string" ||
    turn.prompt.length === 0
  ) {
    // A well-formed contract only ever omits prompt text via literal
    // `turn: null` (checked above) — any OTHER shape here is malformed, never
    // confused with that legitimate empty case.
    return { kind: "error", message: "malformed turn shape" };
  }
  const response = typeof turn.response === "string" ? turn.response : null;
  return { kind: "usable", prompt: turn.prompt, response };
}

export type RunTurnCliFn = (argv: string[]) => Promise<TurnCliExit>;

function runTurnCliViaKeeperBinary(argv: string[]): Promise<TurnCliExit> {
  return new Promise((resolve) => {
    execFile(
      "keeper",
      argv,
      {
        encoding: "utf8",
        timeout: RENAME_TURN_CLI_TIMEOUT_MS,
        maxBuffer: RENAME_TURN_CLI_MAX_BUFFER,
      },
      (_error, stdout, stderr) => {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// host inference boundary (ADR 0041)
// ---------------------------------------------------------------------------

/** Structural subset of Pi's resolved `Model<Api>` this command needs. */
export interface RenamePiModel {
  provider: string;
  [key: string]: unknown;
}

/** Mirrors Pi's `ResolvedRequestAuth` discriminated union exactly, so a real
 *  `ctx.modelRegistry.getApiKeyAndHeaders()` result needs no adapter. */
export type RenameAuthResult =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
    }
  | { ok: false; error: string };

export interface RenameModelRegistry {
  find(provider: string, modelId: string): RenamePiModel | undefined;
  getApiKeyAndHeaders(model: RenamePiModel): Promise<RenameAuthResult>;
}

export interface RenameCompletionContent {
  type: string;
  text?: string;
}

export type RenameStopReason =
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted";

export interface RenameCompletionResult {
  stopReason: RenameStopReason;
  content: RenameCompletionContent[];
  errorMessage?: string;
}

export interface RenameCompletionOptions {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  signal: AbortSignal;
  maxTokens: number;
  reasoningEffort: string;
}

export type RenameCompletionFn = (
  model: RenamePiModel,
  context: {
    systemPrompt: string;
    messages: Array<{
      role: "user";
      content: Array<{ type: "text"; text: string }>;
      timestamp: number;
    }>;
  },
  options: RenameCompletionOptions,
) => Promise<RenameCompletionResult>;

/**
 * Extract usable text from a completion result. Only a `"stop"` stop reason
 * with non-empty text content is usable — `length`/`toolUse`/`error`/
 * `aborted`, or text-free content, all fold to `null`. PURE.
 */
export function extractCompletionText(
  result: RenameCompletionResult,
): string | null {
  if (result.stopReason !== "stop") return null;
  const text = result.content
    .filter(
      (c): c is { type: "text"; text: string } =>
        c.type === "text" && typeof c.text === "string",
    )
    .map((c) => c.text)
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Invocation-local host completion. Dynamically imports Pi's own inference
 * package ONLY when a `/rename` invocation actually reaches this call —
 * never at extension load. An import failure or an API-shape surprise
 * rejects, which the caller folds into a normal failure outcome; it never
 * propagates past the command (docs/adr/0041).
 */
async function hostComplete(
  model: RenamePiModel,
  context: {
    systemPrompt: string;
    messages: Array<{
      role: "user";
      content: Array<{ type: "text"; text: string }>;
      timestamp: number;
    }>;
  },
  options: RenameCompletionOptions,
): Promise<RenameCompletionResult> {
  // @ts-expect-error — Pi's package is on PI's module path, not keeper's own
  // (the self-contained-island rule forbids a static/typed dependency here);
  // resolved only at runtime, inside Pi's process, never during keeper's own
  // `tsc --noEmit`.
  const hostModule = (await import("@earendil-works/pi-ai/compat")) as {
    complete: (
      model: unknown,
      context: unknown,
      options: unknown,
    ) => Promise<{
      stopReason: string;
      content: Array<{ type: string; text?: string }>;
      errorMessage?: string;
    }>;
  };
  const response = await hostModule.complete(model, context, {
    apiKey: options.apiKey,
    headers: options.headers,
    env: options.env,
    signal: options.signal,
    maxTokens: options.maxTokens,
    reasoningEffort: options.reasoningEffort,
  });
  return {
    stopReason: response.stopReason as RenameStopReason,
    content: response.content,
    errorMessage: response.errorMessage,
  };
}

// ---------------------------------------------------------------------------
// command orchestration
// ---------------------------------------------------------------------------

export interface RenameCommandDeps {
  runTurnCli: RunTurnCliFn;
  resolveModel: (
    registry: RenameModelRegistry,
    provider: string,
    modelId: string,
  ) => RenamePiModel | undefined;
  getAuth: (
    registry: RenameModelRegistry,
    model: RenamePiModel,
  ) => Promise<RenameAuthResult>;
  runCompletion: RenameCompletionFn;
  /** Completion wall-clock budget override. Tests shrink this so the
   *  AbortController fires in milliseconds instead of the real
   *  {@link RENAME_TIMEOUT_MS}; production deps omit it. */
  timeoutMs?: number;
}

export function defaultRenameCommandDeps(): RenameCommandDeps {
  return {
    runTurnCli: runTurnCliViaKeeperBinary,
    resolveModel: (registry, provider, modelId) =>
      registry.find(provider, modelId),
    getAuth: (registry, model) => registry.getApiKeyAndHeaders(model),
    runCompletion: hostComplete,
  };
}

export interface RenameSessionManager {
  getSessionId(): string;
  getLeafId(): string | null;
  getSessionName(): string | undefined;
  /** Current Pi hosts expose their active, compaction-aware model context.
   *  Optional so an older host keeps the Latest-turn compatibility path. */
  buildSessionContext?(): { messages: unknown[] };
}

export interface RenameUi {
  notify(message: string, level?: string): void;
}

export interface RenameCommandContext {
  cwd: string;
  sessionManager: RenameSessionManager;
  modelRegistry: RenameModelRegistry;
  ui: RenameUi;
  /** Current Pi hosts provide this on command and event contexts. Absent on an
   *  older host degrades to the original immediate-attempt behavior. */
  isIdle?(): boolean;
}

interface PendingRenameRequest {
  generation: number;
  sessionId: string;
  initialTitle: string | undefined;
  readFailures: number;
  completionAttempts: number;
}

/** Session-scoped `/rename` controller. Explicit invocations advance the
 *  generation; internal retries keep the same immutable request identity. */
export interface RenameInvocationState {
  generation: number;
  pending: PendingRenameRequest | null;
  running: boolean;
  wakeRequested: boolean;
  wakeContext: RenameCommandContext | null;
  activeAbort: AbortController | null;
}

export function createRenameInvocationState(): RenameInvocationState {
  return {
    generation: 0,
    pending: null,
    running: false,
    wakeRequested: false,
    wakeContext: null,
    activeAbort: null,
  };
}

export type RenameOutcomeKind =
  | "empty"
  | "stale"
  | "timeout"
  | "model_unavailable"
  | "auth_failed"
  | "invalid_output"
  | "read_failed"
  | "success";

export interface RenameOutcome {
  outcome: RenameOutcomeKind;
  title?: string;
  staleReason?: "retryable" | "cancelled";
}

function beginRenameRequest(
  ctx: RenameCommandContext,
  state: RenameInvocationState,
): PendingRenameRequest {
  state.activeAbort?.abort();
  const request: PendingRenameRequest = {
    generation: ++state.generation,
    sessionId: ctx.sessionManager.getSessionId(),
    initialTitle: ctx.sessionManager.getSessionName(),
    readFailures: 0,
    completionAttempts: 0,
  };
  state.pending = request;
  state.wakeRequested = false;
  state.wakeContext = null;
  return request;
}

function requestIsCurrent(
  ctx: RenameCommandContext,
  state: RenameInvocationState,
  request: PendingRenameRequest,
): boolean {
  return (
    state.pending === request &&
    state.generation === request.generation &&
    ctx.sessionManager.getSessionId() === request.sessionId &&
    ctx.sessionManager.getSessionName() === request.initialTitle
  );
}

/** Compute (never apply) one attempt for an immutable explicit request. */
async function runRenameAttempt(
  ctx: RenameCommandContext,
  deps: RenameCommandDeps,
  state: RenameInvocationState,
  request: PendingRenameRequest,
): Promise<RenameOutcome> {
  if (!requestIsCurrent(ctx, state, request)) {
    return { outcome: "stale", staleReason: "cancelled" };
  }
  const leaf = ctx.sessionManager.getLeafId() ?? "root";
  const cliExit = await deps.runTurnCli(
    buildPiTurnArgv(request.sessionId, leaf, ctx.cwd),
  );
  const turnOutcome = parseTurnCliOutput(cliExit);
  if (!requestIsCurrent(ctx, state, request)) {
    return { outcome: "stale", staleReason: "cancelled" };
  }
  if (
    (ctx.sessionManager.getLeafId() ?? "root") !== leaf ||
    !(ctx.isIdle?.() ?? true)
  ) {
    return { outcome: "stale", staleReason: "retryable" };
  }
  if (turnOutcome.kind === "error") {
    return { outcome: "read_failed" };
  }
  if (turnOutcome.kind === "empty") {
    return { outcome: "empty" };
  }

  const model = deps.resolveModel(
    ctx.modelRegistry,
    RENAME_MODEL_PROVIDER,
    RENAME_MODEL_ID,
  );
  if (model === undefined) {
    return { outcome: "model_unavailable" };
  }

  const auth = await deps.getAuth(ctx.modelRegistry, model);
  if (auth.ok !== true) {
    return { outcome: "auth_failed" };
  }
  if (!requestIsCurrent(ctx, state, request)) {
    return { outcome: "stale", staleReason: "cancelled" };
  }
  if (
    (ctx.sessionManager.getLeafId() ?? "root") !== leaf ||
    !(ctx.isIdle?.() ?? true)
  ) {
    return { outcome: "stale", staleReason: "retryable" };
  }

  let inputText: string | null = null;
  try {
    const sessionContext = ctx.sessionManager.buildSessionContext?.();
    if (sessionContext !== undefined) {
      inputText = buildRenameConversationInput(
        sessionContext.messages,
        RENAME_MAX_TRANSCRIPT_BYTES,
      );
    }
  } catch {
    // Host context drift degrades to the stable Latest-turn CLI contract.
  }
  inputText ??= buildRenameInputText(
    turnOutcome.prompt,
    turnOutcome.response,
    RENAME_MAX_TRANSCRIPT_BYTES,
  );

  request.completionAttempts += 1;
  const controller = new AbortController();
  state.activeAbort = controller;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.timeoutMs ?? RENAME_TIMEOUT_MS);
  let completion: RenameCompletionResult;
  try {
    completion = await deps.runCompletion(
      model,
      {
        systemPrompt: RENAME_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: inputText }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: controller.signal,
        maxTokens: RENAME_MAX_RESPONSE_TOKENS,
        reasoningEffort: RENAME_REASONING_EFFORT,
      },
    );
  } catch {
    if (!timedOut && controller.signal.aborted) {
      return { outcome: "stale", staleReason: "cancelled" };
    }
    return { outcome: timedOut ? "timeout" : "model_unavailable" };
  } finally {
    clearTimeout(timer);
    if (state.activeAbort === controller) state.activeAbort = null;
  }

  if (completion.stopReason === "aborted") {
    if (controller.signal.aborted && !timedOut) {
      return { outcome: "stale", staleReason: "cancelled" };
    }
    return { outcome: "timeout" };
  }
  const text = extractCompletionText(completion);
  if (text === null) {
    return { outcome: "invalid_output" };
  }

  const slug = renameSlugify(stripUnsafeText(text));
  if (slug === null) {
    return { outcome: "invalid_output" };
  }

  if (!requestIsCurrent(ctx, state, request)) {
    return { outcome: "stale", staleReason: "cancelled" };
  }
  if (
    (ctx.sessionManager.getLeafId() ?? "root") !== leaf ||
    !(ctx.isIdle?.() ?? true)
  ) {
    return { outcome: "stale", staleReason: "retryable" };
  }

  return { outcome: "success", title: slug };
}

/** One-shot compatibility seam used by pure orchestration tests. */
export async function runRenameInvocation(
  ctx: RenameCommandContext,
  deps: RenameCommandDeps,
  state: RenameInvocationState,
): Promise<RenameOutcome> {
  return runRenameAttempt(ctx, deps, state, beginRenameRequest(ctx, state));
}

/** Human-facing feedback for one outcome. Never echoes transcript text,
 *  model output, or credentials — `detail` (success only) is the ACCEPTED
 *  slug itself, which is about to become the visible session title anyway. */
export function renameFeedback(
  kind: RenameOutcomeKind,
  detail?: string,
): { message: string; level: "info" | "error" } {
  switch (kind) {
    case "empty":
      return { message: "/rename: nothing to name yet", level: "info" };
    case "stale":
      return {
        message:
          "/rename: session changed mid-request, discarding stale result",
        level: "info",
      };
    case "timeout":
      return {
        message: "/rename: timed out waiting for a title",
        level: "error",
      };
    case "model_unavailable":
      return {
        message: `/rename: ${RENAME_MODEL_PROVIDER}/${RENAME_MODEL_ID} is unavailable`,
        level: "error",
      };
    case "auth_failed":
      return { message: "/rename: authentication failed", level: "error" };
    case "invalid_output":
      return {
        message: "/rename: could not derive a usable title",
        level: "error",
      };
    case "read_failed":
      return {
        message: "/rename: could not read the latest turn",
        level: "error",
      };
    case "success":
      return { message: `Session renamed: ${detail ?? ""}`, level: "info" };
  }
}

function clearPendingRename(
  state: RenameInvocationState,
  request?: PendingRenameRequest,
): void {
  if (request !== undefined && state.pending !== request) return;
  state.pending = null;
  state.wakeRequested = false;
  state.wakeContext = null;
  state.activeAbort?.abort();
  state.activeAbort = null;
}

/** Drive one pending request while the session is settled. Calls coalesce so
 *  an `agent_settled` arriving during inference becomes one later wake. */
async function drivePendingRename(
  pi: { setSessionName(name: string): void },
  deps: RenameCommandDeps,
  state: RenameInvocationState,
  ctx: RenameCommandContext,
): Promise<void> {
  const request = state.pending;
  if (request === null) return;
  if (state.running) {
    state.wakeRequested = true;
    state.wakeContext = ctx;
    return;
  }
  if (!(ctx.isIdle?.() ?? true)) return;

  state.running = true;
  try {
    while (state.pending === request && (ctx.isIdle?.() ?? true)) {
      let result: RenameOutcome;
      try {
        result = await runRenameAttempt(ctx, deps, state, request);
      } catch {
        result = { outcome: "read_failed" };
      }

      if (result.outcome === "empty") return;
      if (result.outcome === "read_failed") {
        request.readFailures += 1;
        if (request.readFailures < RENAME_MAX_READ_FAILURES) continue;
      }
      if (
        result.outcome === "stale" &&
        result.staleReason === "retryable"
      ) {
        if (request.completionAttempts < RENAME_MAX_COMPLETION_ATTEMPTS) {
          if (ctx.isIdle?.() ?? true) continue;
          return;
        }
        clearPendingRename(state, request);
        const fb = renameFeedback("stale");
        ctx.ui.notify(fb.message, fb.level);
        return;
      }
      if (result.outcome === "stale") {
        clearPendingRename(state, request);
        return;
      }
      if (result.outcome === "success" && result.title !== undefined) {
        // Clear BEFORE mutation: the resulting session_info_changed event can
        // never look like an external manual rename of a live request.
        clearPendingRename(state, request);
        try {
          pi.setSessionName(result.title);
        } catch {
          const fb = renameFeedback("model_unavailable");
          ctx.ui.notify(fb.message, fb.level);
          return;
        }
        const fb = renameFeedback("success", result.title);
        ctx.ui.notify(fb.message, fb.level);
        return;
      }

      clearPendingRename(state, request);
      const fb = renameFeedback(result.outcome);
      ctx.ui.notify(fb.message, fb.level);
      return;
    }
  } finally {
    state.running = false;
    const wakeCtx = state.wakeContext;
    const shouldWake = state.wakeRequested && wakeCtx !== null;
    state.wakeRequested = false;
    state.wakeContext = null;
    if (shouldWake) {
      void drivePendingRename(pi, deps, state, wakeCtx).catch(() => {});
    }
  }
}

/** Build `/rename`: arm one eventual title, acknowledge immediately, then
 *  either attempt now or let `agent_settled` wake it. */
export function createRenameCommandHandler(
  pi: { setSessionName(name: string): void },
  deps: RenameCommandDeps,
  state: RenameInvocationState,
): (args: string, ctx: RenameCommandContext) => Promise<void> {
  return async (_args, ctx) => {
    const request = beginRenameRequest(ctx, state);
    ctx.ui.notify("/rename: generating a session title…", "info");
    try {
      await drivePendingRename(pi, deps, state, ctx);
    } catch {
      clearPendingRename(state, request);
      const fb = renameFeedback("model_unavailable");
      ctx.ui.notify(fb.message, fb.level);
    }
  };
}

// ---------------------------------------------------------------------------
// registration (wired from keeper-events.ts's `KEEPER_JOB_ID` arming boundary)
// ---------------------------------------------------------------------------

/** Minimal structural subset of Pi's `ExtensionAPI` this module needs — a
 *  separate view from `keeper-events.ts`'s own `PiExtensionApi`, targeting
 *  the SAME real object at runtime (see the cast at the `keeperEvents` call
 *  site). No `@earendil-works/*` import required. */
export interface PiRenameApi {
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: RenameCommandContext) => Promise<void>;
    },
  ): void;
  setSessionName(name: string): void;
  on(
    event: "session_info_changed",
    handler: (event: { name?: string }) => void,
  ): void;
  on(
    event: "session_start",
    handler: (
      event: unknown,
      ctx: { sessionManager: RenameSessionManager },
    ) => void,
  ): void;
  on(
    event: "agent_settled",
    handler: (event: unknown, ctx: RenameCommandContext) => void,
  ): void;
  on(event: "session_shutdown", handler: () => void): void;
}

export interface RegisterRenameCommandOptions {
  /** Called with every non-empty Pi session title — both a `/rename` success
   *  (via the `session_info_changed` it triggers) and any OTHER rename path
   *  (`/name`, RPC), plus a `session_start` replay of the current title. */
  onTitleChange: (title: string) => void;
  deps?: RenameCommandDeps;
}

/** Register `/rename`, the `session_info_changed` → title-change bridge, and
 *  the `session_start` replay. Never throws — every handler is fail-open,
 *  matching the factory's top-level guard in `keeper-events.ts`. */
export function registerRenameCommand(
  pi: PiRenameApi,
  opts: RegisterRenameCommandOptions,
): void {
  const deps = opts.deps ?? defaultRenameCommandDeps();
  const state = createRenameInvocationState();
  pi.registerCommand("rename", {
    description: "Derive a short Session title from the conversation",
    handler: createRenameCommandHandler(pi, deps, state),
  });
  pi.on("session_info_changed", (event) => {
    try {
      const pending = state.pending;
      if (pending !== null && event?.name !== pending.initialTitle) {
        // Any external title mutation wins. A successful `/rename` clears its
        // request before calling setSessionName, so it never enters here live.
        clearPendingRename(state, pending);
      }
      if (typeof event?.name === "string" && event.name.length > 0) {
        opts.onTitleChange(event.name);
      }
    } catch {
      // Fail-open: never let a title-bridge failure escape into Pi.
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    try {
      void drivePendingRename(pi, deps, state, ctx).catch(() => {});
    } catch {
      // Fail-open: a missed wake can heal on a later settled turn.
    }
  });
  pi.on("session_shutdown", () => {
    try {
      clearPendingRename(state);
    } catch {
      // Session teardown must never inherit a metadata-command failure.
    }
  });
  pi.on("session_start", (_event, ctx) => {
    try {
      const name = ctx?.sessionManager?.getSessionName?.();
      if (typeof name === "string" && name.length > 0) {
        opts.onTitleChange(name);
      }
    } catch {
      // Fail-open: a missed write heals on a LATER resume/reload instead.
    }
  });
}
