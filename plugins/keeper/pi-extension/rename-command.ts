/**
 * keeper's `/rename` Pi command — derives a short Session title from the
 * current branch's Latest turn (`keeper transcript pi turn`) and applies it
 * through Pi's own `setSessionName()`, never Keeper's DB or tmux directly.
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

const RENAME_SYSTEM_PROMPT =
  "Generate a short session title (3-6 words) summarizing the user's most " +
  "recent request below. Respond with ONLY the title text: no punctuation, " +
  "no quotes, no preamble.";

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
 * Bound the combined prompt+response text to `maxBytes` UTF-8 bytes. PURE.
 * A slice can land mid-codepoint; the model input tolerates a truncated tail
 * (this is a completion INPUT, never rendered verbatim to a human).
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
  const combined = parts.join("\n\n");
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
}

export interface RenameUi {
  notify(message: string, level?: string): void;
}

export interface RenameCommandContext {
  cwd: string;
  sessionManager: RenameSessionManager;
  modelRegistry: RenameModelRegistry;
  ui: RenameUi;
}

/** Monotonic in-process generation token — the LAST `/rename` invocation to
 *  reach the pre-mutation revalidation wins; every earlier one discards. A
 *  fresh state per `registerRenameCommand()` call keeps tests isolated. */
export interface RenameInvocationState {
  generation: number;
}

export function createRenameInvocationState(): RenameInvocationState {
  return { generation: 0 };
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
}

/**
 * Compute (never apply) the `/rename` outcome for one invocation. Snapshots
 * session id / leaf / title BEFORE any await, bumps the generation token,
 * and revalidates snapshot + generation IMMEDIATELY before reporting success
 * — a newer turn, branch navigation, session replacement, manual title
 * change, or a later `/rename` all fold to `"stale"` here. Never mutates Pi
 * state; the caller applies `pi.setSessionName()` exactly once on success.
 */
export async function runRenameInvocation(
  ctx: RenameCommandContext,
  deps: RenameCommandDeps,
  state: RenameInvocationState,
): Promise<RenameOutcome> {
  const myGeneration = ++state.generation;
  const sessionId = ctx.sessionManager.getSessionId();
  const leaf = ctx.sessionManager.getLeafId() ?? "root";
  const preTitle = ctx.sessionManager.getSessionName();

  const cliExit = await deps.runTurnCli(
    buildPiTurnArgv(sessionId, leaf, ctx.cwd),
  );
  const turnOutcome = parseTurnCliOutput(cliExit);
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

  const inputText = buildRenameInputText(
    turnOutcome.prompt,
    turnOutcome.response,
    RENAME_MAX_TRANSCRIPT_BYTES,
  );

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? RENAME_TIMEOUT_MS,
  );
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
    return {
      outcome: controller.signal.aborted ? "timeout" : "model_unavailable",
    };
  } finally {
    clearTimeout(timer);
  }

  if (completion.stopReason === "aborted") {
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

  const stillNewest =
    myGeneration === state.generation &&
    ctx.sessionManager.getSessionId() === sessionId &&
    (ctx.sessionManager.getLeafId() ?? "root") === leaf &&
    ctx.sessionManager.getSessionName() === preTitle;
  if (!stillNewest) {
    return { outcome: "stale" };
  }

  return { outcome: "success", title: slug };
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

/**
 * Build the `/rename` command handler. The ONLY call site of
 * `pi.setSessionName()` — invoked at most once per handler call, and only on
 * a freshly-revalidated success outcome.
 */
export function createRenameCommandHandler(
  pi: { setSessionName(name: string): void },
  deps: RenameCommandDeps,
  state: RenameInvocationState,
): (args: string, ctx: RenameCommandContext) => Promise<void> {
  return async (_args, ctx) => {
    let result: RenameOutcome;
    try {
      result = await runRenameInvocation(ctx, deps, state);
    } catch {
      // Fail-open: any unforeseen throw in the pipeline degrades to a plain
      // failure notification, never an escaped exception into Pi's command
      // dispatch.
      result = { outcome: "model_unavailable" };
    }
    if (result.outcome === "success" && result.title !== undefined) {
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
    const fb = renameFeedback(result.outcome);
    ctx.ui.notify(fb.message, fb.level);
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
    description: "Derive a short Session title from the latest turn",
    handler: createRenameCommandHandler(pi, deps, state),
  });
  pi.on("session_info_changed", (event) => {
    try {
      if (typeof event?.name === "string" && event.name.length > 0) {
        opts.onTitleChange(event.name);
      }
    } catch {
      // Fail-open: never let a title-bridge failure escape into Pi.
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
