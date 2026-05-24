/**
 * Pure derivers shared by the hook, the reducer, AND the schema migration's
 * same-transaction backfill. Single source of truth for the three derivation
 * rules added in fn-577 (skill + slash-command metadata):
 *
 * - `slashCommandFromPrompt(prompt)` — pull a leading `/foo:bar` token out of a
 *   UserPromptSubmit payload's `data.prompt` so consumers can index slash
 *   invocations without JSON-scanning the blob.
 * - `extractSkillName(hookEvent, toolName, data)` — pull `tool_input.skill`
 *   out of a Pre/PostToolUse-on-Skill payload, gated by event + tool name and
 *   defensive against non-object/non-string fields.
 * - `planVerbRefFromSpawnName(spawnName)` — split a `{plan,work,close}::<ref>`
 *   spawn name into its verb + ref components for the jobs projection.
 *
 * Why a separate module rather than colocating with the hook or reducer:
 *
 * 1. Both the hook (`plugin/hooks/events-writer.ts`) and the reducer
 *    (`src/reducer.ts`) need these — putting them in either creates a
 *    consumer→producer-side import edge that the hook's "no third-party / no
 *    cross-module pull" budget (see CLAUDE.md "No third-party deps in the
 *    hook") would rather avoid; the hook already pulls `src/db.ts` for the
 *    SQLite connection, so a sibling pure-string module is in budget.
 * 2. The v8→v9 migration backfills existing rows by re-running these same
 *    derivers on stored events/spawn names. Sharing the implementation
 *    guarantees the backfill matches the steady-state hook+reducer output
 *    byte-identically (no parser drift between past and future rows).
 * 3. Module-scope regex literals tier up at V8/JSC startup once per process
 *    instead of being recompiled on every hook invocation — the SessionEnd
 *    hook's 1.5s timeout budget rewards every microsecond saved at cold
 *    start.
 *
 * Every function here is a PURE function of its arguments — no I/O, no
 * mutation, no time/clock reads. Re-fold determinism (CLAUDE.md "byte-
 * identical re-fold" invariant) depends on that purity: the migration
 * backfill, the hook's live write, and a future from-scratch re-fold must
 * all produce the same output for the same input.
 */

/**
 * Anchored leading-slash-command match. The strict shape:
 *
 *   `/`  +  lowercase letter  +  zero-or-more `[A-Za-z0-9_:-]`
 *
 * Anchored at the start of the string so `Some inline /foo:bar` does not
 * match; requires a lowercase letter immediately after `/` so file paths like
 * `/Users/...` or `/Library/...` can never false-match. After the first
 * letter the character class allows the canonical Claude Code slash-command
 * vocabulary: alphanumerics, `_` (word characters), `-` (kebab segments),
 * and `:` (plugin namespacing — `plan:work`, `arthack:check`). Stops at the
 * first character outside that class, so `/foo bar baz` captures only
 * `/foo`.
 *
 * Module-scope literal so V8/JSC tier up once at process start (per v8.dev
 * "RegExp tier-up"); reusing the same RegExp on every hook invocation is the
 * whole reason for keeping the parser pure.
 */
const SLASH_COMMAND_RE = /^\/[a-z][\w:-]*/;

/**
 * Anchored spawn-name → `{verb, ref}` match. The strict shape:
 *
 *   `{plan|work|close}` + `::` + `fn-\d+-[a-z0-9-]+` + optional `.\d+`
 *
 * Whitelist of verbs is locked: `plan`, `work`, `close`. `audit::` /
 * `develop::` / any future verb does NOT match and returns `(null, null)` —
 * adding a verb is a deliberate one-line edit here, never silent. The `$`
 * anchor rejects extra `::` segments (`work::fn-1-foo::extra` is malformed
 * and folds to both null) so a typo never partial-matches and lands wrong
 * data in the projection.
 *
 * Ref shape `fn-\d+-[a-z0-9-]+(?:\.\d+)?` matches both epic refs
 * (`fn-575-osc-parser`) and task refs (`fn-575-osc-parser.3`); the optional
 * dot-suffix is the planctl task-number tail. The character class on the
 * slug body is intentionally narrower than the slash-command class — refs
 * are kebab-only and never carry `_` or `:`, so allowing them would mask
 * shape errors.
 */
const SPAWN_VERB_REF_RE = /^(plan|work|close)::(fn-\d+-[a-z0-9-]+(?:\.\d+)?)$/;

/**
 * Extract the leading slash command from a `UserPromptSubmit`'s
 * `data.prompt` string. Returns `null` for anything that isn't an anchored
 * `/lowercase…` token — bare text, file paths like `/Users/...`, inline
 * mentions, or a non-string input.
 *
 * Hook callers gate on `hookEvent === 'UserPromptSubmit'` AND a non-null
 * `data.prompt` BEFORE calling this — the parser itself stays
 * shape-agnostic (string in, `null` or string out) so the migration's
 * backfill can call it on any historical event row's parsed prompt field
 * without re-implementing the gating.
 */
export function slashCommandFromPrompt(prompt: unknown): string | null {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return null;
  }
  const m = prompt.match(SLASH_COMMAND_RE);
  return m ? m[0] : null;
}

/**
 * Extract the canonical skill name from a Pre/PostToolUse-on-Skill event's
 * `data.tool_input.skill` field. Gated by hook event AND tool name —
 * returns `null` for every other combination so the column stays NULL on
 * unrelated rows (the partial-index `WHERE skill_name IS NOT NULL`
 * predicate then keeps the index small).
 *
 * Mirrors {@link extractSubagentAgentId} in `plugin/hooks/events-writer.ts`
 * defensively: a missing `tool_input` object, a non-string `skill`, or any
 * other shape-mismatch path returns `null`. Claude Code occasionally puts
 * objects in fields documented as strings (see the `strField` precedent);
 * NEVER throw — the hook's exit-0 contract is non-negotiable.
 */
export function extractSkillName(
  hookEvent: string,
  toolName: string | null,
  data: Record<string, unknown>,
): string | null {
  if (
    (hookEvent !== "PreToolUse" && hookEvent !== "PostToolUse") ||
    toolName !== "Skill"
  ) {
    return null;
  }
  const toolInput = data.tool_input;
  if (typeof toolInput !== "object" || toolInput === null) {
    return null;
  }
  const candidate = (toolInput as Record<string, unknown>).skill;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

/**
 * The pair returned by {@link planVerbRefFromSpawnName}. Both fields are
 * always populated together — either both strings (a clean match against
 * {@link SPAWN_VERB_REF_RE}) or both NULL (any mismatch / NULL / malformed
 * input). The reducer + migration backfill destructure this pair into the
 * two `jobs.plan_verb` / `jobs.plan_ref` columns.
 */
export interface PlanVerbRef {
  plan_verb: string | null;
  plan_ref: string | null;
}

/**
 * Split a spawn name (the parent claude process's `--name`/`-n` token,
 * scraped by the hook on `SessionStart`) into `(plan_verb, plan_ref)` per
 * the canonical `{plan,work,close}::<ref>` shape. Returns both NULL on a
 * NULL spawn name, an `audit::` / `develop::` / other-verb prefix, a
 * malformed body, or anything trailing the ref (extra `::` segments).
 *
 * The strict whitelist matches a deliberate locked design decision: only
 * the three verbs that map to a planctl epic/task workflow generate a jobs
 * projection. A future verb addition requires editing
 * {@link SPAWN_VERB_REF_RE} here — there is no silent fall-through path.
 */
export function planVerbRefFromSpawnName(
  spawnName: string | null,
): PlanVerbRef {
  if (spawnName == null || spawnName.length === 0) {
    return { plan_verb: null, plan_ref: null };
  }
  const m = spawnName.match(SPAWN_VERB_REF_RE);
  if (m == null) {
    return { plan_verb: null, plan_ref: null };
  }
  // biome-ignore lint/style/noNonNullAssertion: regex match guarantees both capture groups
  return { plan_verb: m[1]!, plan_ref: m[2]! };
}

/**
 * Anchored task-notification-killed envelope match. The strict shape:
 *
 *   `<task-notification>` ... `<status>killed</status>` ...
 *
 * Claude Code injects this exact envelope through the `UserPromptSubmit`
 * hook when a backgrounded task (e.g. a `Monitor` tool process) is killed
 * — most commonly during session shutdown after a SIGHUP from the user
 * closing the terminal window. The model can't react to the notification
 * if the session is also dying, so the reducer treats these as no-ops for
 * the lifecycle state machine. Every other `UserPromptSubmit` — including
 * task-notifications carrying `status=completed` / `status=failed`, which
 * the model can and does react to — still flips state to `working`.
 *
 * `^` anchors the opener so a free-text prompt that happens to mention the
 * substring `<task-notification>` mid-message cannot false-match. `[\s\S]*`
 * spans the body greedily (newlines + whitespace are normal between the
 * inner tags); the trailing literal closes the match cheaply (no nested
 * quantifier — no catastrophic-backtracking risk).
 *
 * Module-scope literal so V8/JSC tier up once at process start, mirroring
 * the other parsers in this file.
 */
const KILLED_TASK_NOTIFICATION_RE =
  /^<task-notification>[\s\S]*<status>killed<\/status>/;

/**
 * Detect Claude Code's `<task-notification>…<status>killed</status>` envelope
 * on a `UserPromptSubmit` event's `data.prompt`. Reducer-only: the lifecycle
 * branch skips the `state = 'working'` write when this returns `true` so a
 * shutdown-housekeeping notification doesn't briefly flip a `stopped` /
 * terminal row into `working` right before `SessionEnd` (or the exit-watcher's
 * synthetic `Killed`) lands.
 *
 * Returns `false` for any non-string or empty input. Stays a pure function
 * of its argument so re-fold determinism is preserved — a re-fold from
 * scratch on a fresh reducer agrees with steady-state writes byte-for-byte.
 *
 * Modest by design: `status=completed` / `status=failed` task-notifications
 * are real signals the model reacts to and continue to flip state to
 * `working`. Only the `killed` variant — which fires while the session
 * itself is dying — is suppressed.
 */
export function isKilledTaskNotification(prompt: unknown): boolean {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return false;
  }
  return KILLED_TASK_NOTIFICATION_RE.test(prompt);
}

/**
 * Anchored planctl-ref → `{kind, epic_id, task_id?}` match. The strict shape:
 *
 *   `fn-\d+-[a-z0-9-]+` + optional `.\d+`
 *
 * Mirrors the ref-body half of {@link SPAWN_VERB_REF_RE} — same lowercase
 * kebab-only character class so an uppercase or `_`-bearing ref rejects, same
 * `$` anchor so a trailing token (`fn-1-foo.1.extra`) rejects rather than
 * partial-matching. The optional dot-suffix is the planctl task-number tail.
 *
 * Module-scope so V8/JSC tier up once at process start; reused by the reducer's
 * `syncJobIntoEpic` fan-out on every `plan_ref`-bearing jobs write.
 */
const PLAN_REF_RE = /^(fn-\d+-[a-z0-9-]+)(?:\.(\d+))?$/;

/**
 * The shape returned by {@link parsePlanRef}. `kind: 'epic'` carries just the
 * epic id (verbs `plan` / `close`); `kind: 'task'` carries both the epic id and
 * the fully-qualified task id (verb `work`). Returning `null` from
 * {@link parsePlanRef} signals an invalid ref — the reducer's sync helper
 * treats null as "skip the fan-out, advance the cursor, no throw."
 */
export type ParsedPlanRef =
  | { kind: "epic"; epic_id: string }
  | { kind: "task"; epic_id: string; task_id: string };

/**
 * Split a `plan_ref` into its epic / task components. An epic-form ref
 * (`fn-575-osc-parser`) returns `{kind: 'epic', epic_id}`; a task-form ref
 * (`fn-575-osc-parser.3`) returns `{kind: 'task', epic_id, task_id}` with the
 * fully-qualified `task_id` (`${epic_id}.${ordinal}`). Anything else — null
 * input, malformed shape (`fn-1-foo.`, `fn-1`, `fn--foo`, empty), uppercase
 * letter, trailing whitespace, extra segments — returns `null`.
 *
 * The reducer's `syncJobIntoEpic` calls this on every `plan_ref`-bearing jobs
 * write to decide which embedded array to fan into. A null return short-
 * circuits the fan-out (the cursor still advances upstream — never throw).
 */
export function parsePlanRef(ref: string | null): ParsedPlanRef | null {
  if (typeof ref !== "string" || ref.length === 0) {
    return null;
  }
  const m = ref.match(PLAN_REF_RE);
  if (m == null) {
    return null;
  }
  // biome-ignore lint/style/noNonNullAssertion: regex match guarantees group 1
  const epicId = m[1]!;
  const ordinal = m[2];
  if (ordinal !== undefined) {
    return { kind: "task", epic_id: epicId, task_id: `${epicId}.${ordinal}` };
  }
  return { kind: "epic", epic_id: epicId };
}
