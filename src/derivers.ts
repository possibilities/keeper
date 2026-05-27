/**
 * Pure derivers shared by the hook, the reducer, AND the schema migration's
 * same-transaction backfill. Single source of truth for the four derivation
 * rules (three added in fn-577 + the planctl-invocation deriver added in
 * fn-598):
 *
 * - `slashCommandFromPrompt(prompt)` — pull a leading `/foo:bar` token out of a
 *   UserPromptSubmit payload's `data.prompt` so consumers can index slash
 *   invocations without JSON-scanning the blob.
 * - `extractSkillName(hookEvent, toolName, data)` — pull `tool_input.skill`
 *   out of a Pre/PostToolUse-on-Skill payload, gated by event + tool name and
 *   defensive against non-object/non-string fields.
 * - `planVerbRefFromSpawnName(spawnName)` — split a
 *   `{plan,work,close,approve}::<ref>` spawn name into its verb + ref
 *   components for the jobs projection.
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
 *   `{plan|work|close|approve}` + `::` + `fn-\d+-[a-z0-9-]+` + optional `.\d+`
 *
 * Whitelist of verbs is locked: `plan`, `work`, `close`, `approve`.
 * `audit::` / `develop::` / any future verb does NOT match and returns
 * `(null, null)` — adding a verb is a deliberate one-line edit here, never
 * silent. The `$` anchor rejects extra `::` segments
 * (`work::fn-1-foo::extra` is malformed and folds to both null) so a typo
 * never partial-matches and lands wrong data in the projection.
 *
 * Ref shape `fn-\d+-[a-z0-9-]+(?:\.\d+)?` matches both epic refs
 * (`fn-575-osc-parser`) and task refs (`fn-575-osc-parser.3`); the optional
 * dot-suffix is the planctl task-number tail. The character class on the
 * slug body is intentionally narrower than the slash-command class — refs
 * are kebab-only and never carry `_` or `:`, so allowing them would mask
 * shape errors.
 */
const SPAWN_VERB_REF_RE =
  /^(plan|work|close|approve)::(fn-\d+-[a-z0-9-]+(?:\.\d+)?)$/;

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
 * the canonical `{plan,work,close,approve}::<ref>` shape. Returns both
 * NULL on a NULL spawn name, an `audit::` / `develop::` / other-verb
 * prefix, a malformed body, or anything trailing the ref (extra `::`
 * segments).
 *
 * The strict whitelist matches a deliberate locked design decision: only
 * the four verbs that map to a planctl epic/task workflow generate a jobs
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
 * Extract the `tool_use_id` correlator from any event payload's `data`
 * blob. Hook-side gated only on `data.tool_use_id` being a non-empty
 * string — no event-name / tool-name filter. Pre/PostToolUse and
 * PostToolUseFailure on every tool (Bash, Read, Edit, Agent, …) all
 * carry the field and all populate the projection column; the broader
 * footprint is intentional (canonical id-keyed correlator, reusable for
 * future tool-keyed projections beyond Agent/subagent).
 *
 * Mirrors {@link extractSkillName}'s shape-defensive contract: a missing
 * field, a non-string field, or an empty-string field all return `null`;
 * never throws past the caller (the hook's exit-0 contract is
 * non-negotiable). Pure function of the parsed `data` object so the
 * v16→v17 migration backfill, the live hook write, and a future re-fold
 * all derive byte-identically (re-fold determinism).
 */
export function extractToolUseId(data: unknown): string | null {
  if (data === null || typeof data !== "object") {
    return null;
  }
  const candidate = (data as Record<string, unknown>).tool_use_id;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
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

/**
 * The shape returned by {@link extractPlanctlInvocation}. All four-id fields
 * (`op`, `target`, `epic_id`, `task_id`) are always present together; a `null`
 * return from the function signals "this is not a planctl invocation we care
 * about" (wrong hook event, wrong tool, missing/malformed envelope, etc.).
 * `target` / `epic_id` / `task_id` may individually be `null` when the verb
 * takes no argument or when the argument is not a parseable planctl ref
 * (`planctl epics`, `planctl init`).
 *
 * `subject_present` mirrors the envelope's `subject != null` — `true` when
 * the verb carries a human subject (title / description / acceptance text);
 * `false` for read-only verbs and operational state writes (claim, block,
 * etc.). The flag drives creator/refiner classification downstream in
 * `src/plan-classifier.ts`.
 *
 * `queue_jump` (schema v30) mirrors the envelope's `queue_jump` field —
 * server-derived from a `/plan:queue` scaffold event, ALWAYS present, defaults
 * `false` whenever the envelope omits the key, has a non-boolean value, or is
 * produced by an older planctl that predates the field. The `=== true`
 * defensive check guarantees byte-identical re-fold determinism across the
 * v29→v30 boundary: every legacy event folds to `queue_jump=false`. Projected
 * to `epics.queue_jump` by `syncPlanctlLinks`; drives the `!`-prefix `sort_path`
 * branch for root epics so queued work sorts atop the dashctl board.
 */
export interface PlanctlInvocation {
  op: string;
  target: string | null;
  epic_id: string | null;
  task_id: string | null;
  subject_present: boolean;
  queue_jump: boolean;
}

/**
 * Defensive length cap on the stdout buffer we will attempt to `JSON.parse`.
 * planctl envelopes are sub-kilobyte; any Bash stdout above this threshold
 * is almost certainly not a planctl invocation and would needlessly burn
 * cold-start budget on a large parse. Mirrors the cap-on-stdout posture
 * elsewhere in the hook surface.
 */
const PLANCTL_STDOUT_CAP = 64_000;

/**
 * Extract a planctl-CLI invocation envelope from a `PostToolUse:Bash` event's
 * `data.tool_response.stdout` string. Returns `null` for every non-matching
 * hook event / tool name / data shape — the column stays NULL on unrelated
 * rows so the partial-index `WHERE planctl_op IS NOT NULL` predicate stays
 * selective.
 *
 * Gated by `hookEvent === 'PostToolUse' && toolName === 'Bash'` (EXACT
 * match — `PostToolUseFailure` has no `tool_response` and must not match
 * via any `startsWith` shortcut). The stdout buffer must parse as JSON
 * carrying a top-level `planctl_invocation` key; anything else returns
 * `null`.
 *
 * The envelope is the AUTHORITATIVE source: planctl writes it on every
 * mutating call (and on no other call), so envelope-presence IS the
 * mutation sentinel. This intentionally widens the surface from the old
 * input-command-regex approach — `bash -c 'planctl …'`, `/abs/path/planctl
 * …`, and env-prefixed (`FOO=1 planctl …`) invocations all stamp now,
 * because the envelope rides on stdout regardless of how planctl was
 * invoked. Envelope-less mutations from older planctl versions silently
 * drop edges; acceptable since planctl is internally controlled.
 *
 * Mirrors {@link extractSubagentAgentId} (in `plugin/hooks/events-writer.ts`)
 * 1:1 for the defensive-probe shape: type-check the `tool_response` object,
 * type-check the `stdout` string, length-cap, fast `startsWith('{')` hint
 * to skip the parse on the common non-JSON case, try/catch around
 * `JSON.parse`. Mirrors jobctl's `audit._derive_ids` 1:1 for the
 * `target → (epic_id, task_id)` split by reusing {@link parsePlanRef}: the
 * spawn-name ref shape (see {@link SPAWN_VERB_REF_RE}) and the
 * planctl-target ref shape MUST agree byte-for-byte so a re-fold from
 * scratch reproduces the same epic links.
 *
 * NEVER throws — the hook's exit-0 contract is non-negotiable. Claude Code
 * occasionally puts objects in fields documented as strings; every
 * shape-mismatch path returns `null`.
 */
export function extractPlanctlInvocation(
  hookEvent: string,
  toolName: string | null,
  data: Record<string, unknown>,
): PlanctlInvocation | null {
  if (hookEvent !== "PostToolUse" || toolName !== "Bash") {
    return null;
  }
  const toolResponse = data.tool_response;
  if (typeof toolResponse !== "object" || toolResponse === null) {
    return null;
  }
  const stdout = (toolResponse as Record<string, unknown>).stdout;
  if (typeof stdout !== "string" || stdout.length === 0) {
    return null;
  }
  if (stdout.length > PLANCTL_STDOUT_CAP) {
    return null;
  }
  // Fast pre-parse hint: a planctl envelope is always a JSON object, so the
  // first non-whitespace char is `{`. We trim only a single leading-WS pass
  // (cheap) before the hint check; anything else short-circuits without a
  // parse. Most PostToolUse:Bash rows are not JSON at all.
  const head = stdout.charCodeAt(0);
  // `{` is 0x7B. Allow a leading whitespace prefix (space=0x20, tab=0x09,
  // newline=0x0A, carriage-return=0x0D) by re-checking the trimmed head.
  if (head !== 0x7b) {
    if (head !== 0x20 && head !== 0x09 && head !== 0x0a && head !== 0x0d) {
      return null;
    }
    if (!stdout.trimStart().startsWith("{")) {
      return null;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const envelope = (parsed as Record<string, unknown>).planctl_invocation;
  if (typeof envelope !== "object" || envelope === null) {
    return null;
  }
  const envObj = envelope as Record<string, unknown>;
  const op = envObj.op;
  if (typeof op !== "string" || op.length === 0) {
    return null;
  }
  const rawTarget = envObj.target;
  const target: string | null =
    typeof rawTarget === "string" ? rawTarget : null;
  const rawSubject = envObj.subject;
  const subject_present = rawSubject != null;
  // Schema v30: lift the `/plan:queue` priority-jump signal from the envelope.
  // Defensive `=== true` check (NOT `?? false` or truthiness) — anything else
  // (absent, non-boolean, an object, the string "true", `1`, etc.) folds to
  // `false`. This is what makes the v29→v30 re-fold byte-identical: every
  // legacy event predating the field has no `queue_jump` key, so `envObj
  // .queue_jump === true` evaluates `false` for ALL historical events. The
  // ONLY way to land `queue_jump: true` is for the planctl CLI to have
  // emitted the literal boolean `true` on the scaffold envelope.
  const queue_jump = envObj.queue_jump === true;
  const refParsed = target !== null ? parsePlanRef(target) : null;
  const epic_id = refParsed?.epic_id ?? null;
  const task_id = refParsed?.kind === "task" ? refParsed.task_id : null;
  return { op, target, epic_id, task_id, subject_present, queue_jump };
}
