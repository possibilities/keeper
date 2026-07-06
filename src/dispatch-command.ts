/**
 * Pure, dep-free dispatch plumbing shared by the `retry_dispatch` RPC handler
 * (`src/rpc-handlers.ts`) and the client-side `keeper dispatch` CLI
 * (`cli/dispatch.ts`). Holds the `${verb}::${id}` validator and the
 * launch-argv / prompt builders.
 *
 * LEAF-MODULE DISCIPLINE (mirrors the events-writer hook): this file MUST stay
 * dep-free — no `bun:sqlite`, no `./db`, no `./server-worker`, no `./db.ts`
 * symbol. The validator returns a DISCRIMINATED result rather than throwing
 * `BadParamsError` (which lives in the heavy `./server-worker`), so importing
 * this module never drags the server-worker graph into a leaf. The RPC handler
 * re-wraps an `{ ok: false }` into `BadParamsError` to keep the `bad_params`
 * wire contract byte-identical.
 */

// ---------------------------------------------------------------------------
// `${verb}::${id}` composite-key validator
// ---------------------------------------------------------------------------

/**
 * The keeper plan verbs the reconciler / dispatch surface accepts. Mirrors the
 * `Verb` union in `src/autopilot-worker.ts` (kept local rather than
 * re-imported to keep this leaf module's import graph empty).
 */
export type RetryDispatchVerb = "work" | "close" | "approve";

const RETRY_DISPATCH_VERBS = new Set<RetryDispatchVerb>([
  "work",
  "close",
  "approve",
]);

/**
 * The escalation spawn verbs — the two autonomous escalation dispatches
 * (`unblock::<task>`, `deconflict::<epic>`). DELIBERATELY separate from {@link
 * RetryDispatchVerb}: an escalation key is NEVER a sticky `dispatch_failures` row
 * (those stay `work::`/`close::`), so the `retry_dispatch` wire validator ({@link
 * parseDispatchKey}) must NOT accept them — widening it would let `retry_dispatch`
 * accept keys that never exist as rows. The MANUAL `keeper dispatch` surface
 * parses the wider {@link DispatchableVerb} set via {@link parseDispatchableKey}.
 */
export type EscalationVerb = "unblock" | "deconflict";

/**
 * Every verb the manual `keeper dispatch` plan-form positional accepts — the
 * retry-wire verbs PLUS the escalation verbs. A strict superset of {@link
 * RetryDispatchVerb}; the two stay distinct so the `retry_dispatch` wire stays
 * narrow (see {@link EscalationVerb}).
 */
export type DispatchableVerb = RetryDispatchVerb | EscalationVerb;

const DISPATCHABLE_VERBS = new Set<DispatchableVerb>([
  "work",
  "close",
  "approve",
  "unblock",
  "deconflict",
]);

/**
 * True iff `verb` is an escalation verb (`unblock` / `deconflict`). The launch
 * surface uses this to select the escalation launch config (sonnet/high +
 * `escalation` preset) over the worker one — the escalation dispatches boot a
 * purpose-built plan skill, never a worker cell.
 */
export function isEscalationVerb(verb: string): verb is EscalationVerb {
  return verb === "unblock" || verb === "deconflict";
}

/** Discriminated result of {@link parseDispatchKey}. */
export type ParseDispatchKeyResult =
  | { ok: true; verb: RetryDispatchVerb; id: string }
  | { ok: false; error: string };

/**
 * Split + validate a `${verb}::${id}` composite key. Returns a DISCRIMINATED
 * result — `{ ok: true, verb, id }` on success, `{ ok: false, error }` on any
 * miss — instead of throwing, so this module stays dep-free of
 * `BadParamsError`. The RPC handler re-wraps `{ ok: false }` into
 * `BadParamsError(error)` so the wire `bad_params` contract is unchanged.
 *
 * Validation rules (id shape ONLY — launch params come from the projection
 * read at the next reconcile, never the RPC payload):
 *
 * - Non-empty string with exactly one `::` separator.
 * - `verb` is one of `work` / `close` / `approve`. The reconciler only ever
 *   dispatches `work` / `close`; `approve` is accepted SOLELY so an operator can
 *   clear a resurrected/phantom `approve` pending via `retry_dispatch` (the
 *   actual fn-870 incident shape) — there is no live `approve` dispatch path.
 * - `id` is a non-empty token AND passes the {@link rejectDispatchIdToken}
 *   filename-safety predicate (no path separators, no embedded null, no
 *   leading dot). The `dispatch_id` never feeds a filesystem path, but the
 *   predicate is a cheap belt-and-suspenders against a wire token that looks
 *   like a path-traversal probe.
 */
export function parseDispatchKey(value: unknown): ParseDispatchKeyResult {
  if (typeof value !== "string" || value.length === 0) {
    return {
      ok: false,
      error:
        "retry_dispatch: `id` must be a non-empty string of the form `verb::id` (e.g. `work::fn-1-foo.3`)",
    };
  }
  const sep = value.indexOf("::");
  if (sep <= 0 || sep === value.length - 2) {
    return {
      ok: false,
      error:
        "retry_dispatch: `id` must contain exactly one `::` separator with non-empty halves",
    };
  }
  // A second `::` is also a malformed key — the verb half MUST be a simple
  // token, and the id half MUST NOT contain `::` either (the composite key is
  // `verb::id`, not nested).
  if (value.indexOf("::", sep + 2) !== -1) {
    return {
      ok: false,
      error: "retry_dispatch: `id` must contain exactly ONE `::` separator",
    };
  }
  const verbRaw = value.slice(0, sep);
  const idRaw = value.slice(sep + 2);
  if (!RETRY_DISPATCH_VERBS.has(verbRaw as RetryDispatchVerb)) {
    return {
      ok: false,
      error: `retry_dispatch: \`verb\` must be one of work|close|approve (got ${JSON.stringify(verbRaw)})`,
    };
  }
  if (!isSafeDispatchIdToken(idRaw)) {
    return {
      ok: false,
      error:
        "retry_dispatch: `id` half is empty or weaponizable (path-traversal token rejected)",
    };
  }
  return { ok: true, verb: verbRaw as RetryDispatchVerb, id: idRaw };
}

/** Discriminated result of {@link parseDispatchableKey}. */
export type ParseDispatchableKeyResult =
  | { ok: true; verb: DispatchableVerb; id: string }
  | { ok: false; error: string };

/**
 * Split + validate a `${verb}::${id}` composite key for the MANUAL `keeper
 * dispatch` surface, accepting the wider {@link DispatchableVerb} set (the
 * retry-wire verbs PLUS the escalation verbs `unblock` / `deconflict`). The
 * id-shape rules are identical to {@link parseDispatchKey} — same separator +
 * {@link isSafeDispatchIdToken} filename-safety checks — the ONLY difference is
 * the accepted verb set. Kept as a SEPARATE function (not a widening of
 * {@link parseDispatchKey}) so the `retry_dispatch` wire validator stays
 * byte-identical: it never accepts an escalation key, which is never a sticky
 * `dispatch_failures` row. Returns a DISCRIMINATED result; dep-free.
 */
export function parseDispatchableKey(
  value: unknown,
): ParseDispatchableKeyResult {
  if (typeof value !== "string" || value.length === 0) {
    return {
      ok: false,
      error:
        "dispatch: `id` must be a non-empty string of the form `verb::id` (e.g. `unblock::fn-1-foo.3`)",
    };
  }
  const sep = value.indexOf("::");
  if (sep <= 0 || sep === value.length - 2) {
    return {
      ok: false,
      error:
        "dispatch: `id` must contain exactly one `::` separator with non-empty halves",
    };
  }
  if (value.indexOf("::", sep + 2) !== -1) {
    return {
      ok: false,
      error: "dispatch: `id` must contain exactly ONE `::` separator",
    };
  }
  const verbRaw = value.slice(0, sep);
  const idRaw = value.slice(sep + 2);
  if (!DISPATCHABLE_VERBS.has(verbRaw as DispatchableVerb)) {
    return {
      ok: false,
      error: `dispatch: \`verb\` must be one of work|close|approve|unblock|deconflict (got ${JSON.stringify(verbRaw)})`,
    };
  }
  if (!isSafeDispatchIdToken(idRaw)) {
    return {
      ok: false,
      error:
        "dispatch: `id` half is empty or weaponizable (path-traversal token rejected)",
    };
  }
  return { ok: true, verb: verbRaw as DispatchableVerb, id: idRaw };
}

/**
 * True iff `${verb}::${id}` is a key the `retry_dispatch` wire path would accept
 * — i.e. an operator could clear it via `keeper autopilot retry`. A
 * `dispatch_failures` row whose key fails this is UN-retryable (a producer minted
 * a key the validator rejects, e.g. a raw-path token); the daemon GC-sweeps such
 * orphans on boot since the operator surface can never reach them. Pure; dep-free.
 */
export function isRetryableDispatchKey(verb: string, id: string): boolean {
  return parseDispatchKey(`${verb}::${id}`).ok;
}

/**
 * True iff the `id` half is a safe token — non-empty, no path separators, no
 * embedded null, no leading dot. The id never feeds a filesystem path inside
 * the reconciler, but rejecting weaponizable shapes at the wire boundary is
 * cheap defense against future code paths that might (e.g. a viewer that ever
 * serialized an id into a path).
 */
function isSafeDispatchIdToken(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith(".")
  );
}

// ---------------------------------------------------------------------------
// Plan prompt + launch-argv builders
// ---------------------------------------------------------------------------

/** The canonical `/plan:<verb> <id>` slash-command prompt for a plan-form
 *  dispatch. Accepts the full {@link DispatchableVerb} set so an escalation
 *  dispatch boots `/plan:unblock` / `/plan:deconflict`; the reconciler's
 *  `work`/`close` launches (a {@link RetryDispatchVerb} subset) pass through
 *  unchanged. */
export function defaultPlanPrompt(verb: DispatchableVerb, id: string): string {
  return `/plan:${verb} ${id}`;
}

/**
 * Per-arg cap for the prompt positional, in bytes (UTF-8). Sits under Linux
 * `MAX_ARG_STRLEN` (128 KiB per single arg), which `E2BIG`s a process even
 * when the total `ARG_MAX` budget is otherwise fine.
 */
export const PROMPT_MAX_BYTES = 96 * 1024;

/** Discriminated result of {@link validatePromptBytes}. */
export type ValidatePromptResult = { ok: true } | { ok: false; error: string };

/**
 * Reject a prompt that cannot ride safely as an exec argv element:
 *
 * - a NUL byte silently truncates the C-string argv at the kernel boundary, so
 *   the worker would see a clipped prompt with no error;
 * - a prompt over {@link PROMPT_MAX_BYTES} risks an `E2BIG` per-arg failure.
 *
 * Returns a discriminated result the CLI maps to exit 2.
 */
export function validatePromptBytes(prompt: string): ValidatePromptResult {
  if (prompt.includes("\0")) {
    return {
      ok: false,
      error: "prompt contains a NUL byte (would truncate the exec argv)",
    };
  }
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > PROMPT_MAX_BYTES) {
    return {
      ok: false,
      error: `prompt is ${bytes} bytes, over the ${PROMPT_MAX_BYTES}-byte per-arg cap`,
    };
  }
  return { ok: true };
}

/** Inputs to {@link buildDispatchLaunchArgv}. */
export interface DispatchLaunchOpts {
  /** Working directory — applied by `ensureLaunched`'s tmux `-c`, not by the builder. */
  cwd: string;
  /** `--name <claudeName>` value — emitted only when supplied. In plan form it
   *  is load-bearing for reap/classify parsing; in free form it is an OPTIONAL
   *  verbatim pass-through to `claude`. */
  claudeName?: string;
  /** The initial interactive prompt — rides as the FINAL positional argv element. */
  prompt: string;
  /** `--model <m>` — emitted only when supplied. */
  model?: string;
  /** `--effort <e>` — emitted only when supplied. */
  effort?: string;
  /** Per-cell worker plugin dir — `--plugin-dir <abs>` emitted AFTER `--name`
   *  (mirrors the autopilot twin so the dispatch-key peel is unaffected).
   *  Supplied only for a plan-form `work` launch whose task resolves a
   *  {model, tier} cell; absent for close / cell-less / free-form launches so
   *  those stay byte-identical. */
  pluginDir?: string;
  /** Whether to pass `--x-no-confirm` (the live cwd-confirm suppressor). */
  noConfirm: boolean;
}

/**
 * Build the worker launch argv in the `"$@"` POSITIONAL form, so the prompt
 * (and every flag) crosses the shell boundary as a literal argv element with
 * ZERO shell escaping — no `$`, backtick, `$(...)`, newline, `;`, or leading-`-`
 * quoting class can fire. The `-c` body is a fixed literal; everything the
 * caller controls rides in `"$@"`.
 *
 * Shape: `[shell, "-l", "-i", "-c", body, argv0, ...flags, prompt]` where
 * `body` is `exec claude "$@" ; exec "$0" -l -i`. `argv0` is the explicit
 * `$0` slot — WITHOUT it, the first flag would be consumed as `$0` and every
 * positional would shift by one. The trailing `exec "$0" -l -i` leaves a usable
 * login+interactive shell if `claude` exits.
 *
 * `flags` carries `--x-no-confirm` (the LIVE cwd-confirm suppressor) always, and
 * `--name <claudeName>` / `--model` / `--effort` / `--plugin-dir <pluginDir>`
 * ONLY when supplied (the cell flag slots after `--name`). cwd is NOT a flag —
 * `ensureLaunched` applies it via tmux `-c`, mirroring autopilot.
 *
 * `shell` is injected (the caller resolves `process.env.SHELL` once with a safe
 * default; this pure builder never reads env). `cwd` is accepted for call-site
 * symmetry with the launch surface but is intentionally NOT emitted here.
 *
 * Pure — exported for byte-pin tests.
 */
export function buildDispatchLaunchArgv(
  shell: string,
  opts: DispatchLaunchOpts,
): string[] {
  const flags: string[] = [];
  if (opts.model !== undefined) flags.push("--model", opts.model);
  if (opts.effort !== undefined) flags.push("--effort", opts.effort);
  if (opts.noConfirm) flags.push("--x-no-confirm");
  // `--name <key>` is emitted only when supplied (mirrors `--model`/`--effort`).
  // When present its adjacency is load-bearing for reap/classify parsing.
  if (opts.claudeName !== undefined) flags.push("--name", opts.claudeName);
  // Per-cell worker plugin dir — AFTER `--name` so the dispatch-key peel is
  // unaffected. Present only for a plan-form `work` launch resolving a cell.
  if (opts.pluginDir !== undefined && opts.pluginDir !== "") {
    flags.push("--plugin-dir", opts.pluginDir);
  }
  const body = `exec claude "$@" ; exec "$0" -l -i`;
  // `shell` fills the explicit `$0` slot so the first flag is NOT eaten as $0.
  return [shell, "-l", "-i", "-c", body, shell, ...flags, opts.prompt];
}
