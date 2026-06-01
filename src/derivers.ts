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
 * - `parseSessionIdTrailer(raw)` / `extractCommit(event)` — take-last
 *   parser for the `Session-Id:` trailer block git emits via
 *   `%(trailers:key=Session-Id,valueonly,only,unfold)`, and the
 *   defensive synthetic-`Commit`-event payload parser the reducer's
 *   `foldCommit` arm reads. Pure functions of their inputs so the
 *   git-worker producer write and a future from-scratch re-fold
 *   derive byte-identical results.
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

/**
 * Defensive cap on the Bash `tool_input.command` string we will tokenize.
 * Real shell commands stamped on Bash hooks are kilobyte-class at most; an
 * outsized blob is almost certainly machine-generated piped output that
 * couldn't have been a meaningful mutation. Skipping the parse on the rare
 * giant input keeps the hook cold-start budget intact (CLAUDE.md "1.5s
 * SessionEnd timeout"). The cap is generous enough to never bite real
 * shell invocations.
 */
const BASH_COMMAND_CAP = 32_000;

/**
 * Whitespace-trimmed sentinel matching env-prefix tokens (`KEY=VAL pnpm i`).
 * Anchored at the start of the token; uppercase + digits + `_` for the key,
 * any non-whitespace body for the value. We strip these from the leading
 * argv until the first non-env-prefix token, so a `FOO=1 BAR=baz pnpm i`
 * invocation resolves to a `pnpm i` head. Tokenization stays lexical —
 * we never expand the value or substitute it into later tokens.
 */
const ENV_PREFIX_RE = /^[A-Z_][A-Z0-9_]*=/;

/**
 * The hardcoded "every package manager we recognize" table. Keys are the argv
 * head tokens; values carry the install / uninstall verbs (so the deriver
 * can tag the mutation kind precisely) and the canonical lockfile path
 * suffix (joined to `<git-root>` at fold time — except we don't know the
 * git root from a hook payload, so the targets list carries the bare
 * lockfile name AND the cwd-anchored `package.json`-style manifest path).
 *
 * Manifests live in `cwd`; lockfiles live at the git root. Per the task
 * spec's "hardcoded canonical paths, not arg parsing" rule, we do NOT walk
 * up from `cwd` to find the git root — the reducer's attribution pass
 * (task .6) is responsible for resolving the lockfile path against the
 * project_dir the GitSnapshot is anchored on. The deriver stamps the
 * bare lockfile basename and the cwd-anchored manifest path; downstream
 * consumers map them to absolute paths in their own coordinate space.
 *
 * Each entry's `install` / `uninstall` arrays list the subcommands that
 * actually mutate the lockfile / manifest. `pnpm test` / `npm run x` /
 * `cargo build` are NOT in the lists — they don't mutate the dep graph
 * and don't deserve an attribution edge.
 */
interface PkgManagerSpec {
  install: ReadonlySet<string>;
  uninstall: ReadonlySet<string>;
  /**
   * Relative lockfile path under the git root. Stamped verbatim in the
   * `targets` array; downstream consumers prepend project_dir.
   */
  lockfile: string;
  /**
   * Relative manifest path under cwd. Stamped verbatim under cwd-anchored
   * resolution; downstream consumers may absolutize.
   */
  manifest: string;
}

const PKG_MANAGERS: Record<string, PkgManagerSpec> = {
  pnpm: {
    install: new Set(["install", "i", "add"]),
    uninstall: new Set(["remove", "rm", "uninstall", "un"]),
    lockfile: "pnpm-lock.yaml",
    manifest: "package.json",
  },
  npm: {
    install: new Set(["install", "i", "add"]),
    uninstall: new Set(["uninstall", "remove", "rm", "un"]),
    lockfile: "package-lock.json",
    manifest: "package.json",
  },
  yarn: {
    install: new Set(["install", "add"]),
    uninstall: new Set(["remove"]),
    lockfile: "yarn.lock",
    manifest: "package.json",
  },
  bun: {
    install: new Set(["install", "i", "add"]),
    uninstall: new Set(["remove", "rm"]),
    lockfile: "bun.lockb",
    manifest: "package.json",
  },
  uv: {
    install: new Set(["add", "sync", "lock"]),
    uninstall: new Set(["remove"]),
    lockfile: "uv.lock",
    manifest: "pyproject.toml",
  },
  pip: {
    install: new Set(["install"]),
    uninstall: new Set(["uninstall"]),
    lockfile: "requirements.txt",
    manifest: "requirements.txt",
  },
  cargo: {
    install: new Set(["add", "install"]),
    uninstall: new Set(["remove", "uninstall"]),
    lockfile: "Cargo.lock",
    manifest: "Cargo.toml",
  },
  poetry: {
    install: new Set(["add", "install", "lock", "update"]),
    uninstall: new Set(["remove"]),
    lockfile: "poetry.lock",
    manifest: "pyproject.toml",
  },
};

/**
 * Whitelist of explicit filesystem-mutating commands. The argv head must be
 * EXACT (no `/usr/bin/rm` — the hook's `cwd` doesn't resolve aliases or
 * absolute paths; that's task 6's inferred-attribution job).
 *
 * Each entry maps the verb to the deriver's mutation `kind`. Argv tail
 * parsing is identical for all three: skip leading `-flag` tokens, every
 * remaining token is a path. We do NOT distinguish source vs destination
 * for `mv` / `cp` — the deriver reports every operand as a target. This
 * over-attributes the source, but the reducer's attribution pass is the
 * final arbiter against the actual dirty file set.
 */
const FS_COMMANDS: Record<
  string,
  "fs-remove" | "fs-move" | "fs-copy" | "fs-mkdir"
> = {
  rm: "fs-remove",
  mv: "fs-move",
  cp: "fs-copy",
  mkdir: "fs-mkdir",
};

/**
 * Whitelist of git subcommands that rewrite the working tree out from under
 * us. The deriver stamps a `__TREE__` sentinel target when no pathspec is
 * present (the whole tree may flip — every dirty file could change
 * attribution). With a pathspec, only the literal pathspec arg is stamped
 * (we don't expand globs — the inferred-attribution pass handles that).
 */
const GIT_TREE_MUTATORS: ReadonlySet<string> = new Set([
  "checkout",
  "restore",
  "stash",
  "reset",
]);

/**
 * Tree-wide sentinel target for git mutations with no pathspec. Downstream
 * the reducer reads this as "any dirty file in the project could have
 * flipped attribution". We use a bracketed token so it can never collide
 * with a real path (POSIX paths can't contain unescaped `__` boundaries
 * at the start, and the surrounding `__` doubles the no-collision guard).
 */
const TREE_SENTINEL = "__TREE__";

/**
 * The shape returned by {@link extractBashMutation}. `kind` tags the
 * mutation family — drives the bash-side attribution edge the reducer's
 * fold (task .6) will create. `targets` is the lexical list of resolved
 * paths (relative→absolute against `cwd`), bare lockfile/manifest names
 * for package-manager kinds, or the `__TREE__` sentinel for git
 * tree-mutators with no pathspec.
 *
 * Kind taxonomy:
 * - `pkg-install` / `pkg-uninstall` — package-manager mutation; targets
 *   are the manifest + lockfile paths.
 * - `fs-remove` / `fs-move` / `fs-copy` / `fs-mkdir` — explicit
 *   `rm`/`mv`/`cp`/`mkdir` command; targets are every non-flag positional,
 *   resolved against `cwd`.
 * - `git-tree-mutate` — `git checkout|restore|stash|reset`; targets are
 *   the `__TREE__` sentinel (no pathspec) or every post-`--` pathspec.
 * - `git-rm` — `git rm` with one or more pathspec targets (delete
 *   semantics; reducer matches against snapshot-known deleted paths).
 * - `git-mv` — `git mv` with one or more pathspec targets (rename
 *   semantics; ALL positionals captured, both source(s) and destination,
 *   resolved against `cwd`). The reducer matches both deletes and adds.
 *
 * For `git-rm` / `git-mv`, the `__TREE__` sentinel is also used when
 * `--pathspec-from-file=` is present (we won't read the file) or any
 * pathspec carries `:`-magic (`:(top)foo`, `:!foo`, etc.).
 *
 * A null return from {@link extractBashMutation} signals "not a mutation
 * we recognize" — the column stays NULL on disk and the partial index
 * (`WHERE bash_mutation_kind IS NOT NULL`) stays selective.
 */
export interface BashMutation {
  kind:
    | "pkg-install"
    | "pkg-uninstall"
    | "fs-remove"
    | "fs-move"
    | "fs-copy"
    | "fs-mkdir"
    | "git-tree-mutate"
    | "git-rm"
    | "git-mv";
  targets: string[];
}

/**
 * Tokenize a POSIX-shell-ish command line into argv tokens. Quote-aware
 * (single + double), backslash-escape-aware. NO AST, NO subshells, NO
 * heredocs, NO brace expansion — every uncovered pattern degrades to
 * "won't match a mutation" and falls through to the inferred-attribution
 * pass (task .6). Returns the argv array; never throws.
 *
 * Quoting rules (the subset we recognize):
 * - `'...'` (single quotes): everything between is literal, including
 *   spaces and backslashes. A missing close-quote eats to end-of-string.
 * - `"..."` (double quotes): everything between is literal except `\\`,
 *   `\"`, `\$`, `\`` — these strip the backslash and pass the next char
 *   through (POSIX double-quote escape rules). Other backslash sequences
 *   keep the backslash literally (so `"\n"` is the two-char `\n`, not a
 *   newline). A missing close-quote eats to end-of-string.
 * - `\X` (bare backslash escape): outside quotes, drops the backslash and
 *   includes the next char literally. A bare trailing `\` at end-of-input
 *   is dropped.
 *
 * Compound-command separators (`;`, `&&`, `||`, `|`) terminate the current
 * token list — we only ever tokenize the FIRST simple command in a
 * compound. The spec accepts this: "compound commands degrade gracefully
 * to inferred". Subshells (`$(...)`, backticks) are not tokenized — they
 * pass through as opaque chars inside their own token.
 */
function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasContent = false; // distinguish "empty unquoted token" from "no token"
  const flush = (): void => {
    if (hasContent) {
      tokens.push(current);
    }
    current = "";
    hasContent = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (inSingle) {
      if (c === "'") {
        inSingle = false;
        hasContent = true;
        continue;
      }
      current += c;
      hasContent = true;
      continue;
    }
    if (inDouble) {
      if (c === '"') {
        inDouble = false;
        hasContent = true;
        continue;
      }
      if (c === "\\" && i + 1 < command.length) {
        const next = command[i + 1] as string;
        if (next === "\\" || next === '"' || next === "$" || next === "`") {
          current += next;
          hasContent = true;
          i++;
          continue;
        }
      }
      current += c;
      hasContent = true;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      hasContent = true;
      i++;
      continue;
    }
    // Compound-command separator: stop after the first simple command.
    if (c === ";" || c === "|" || c === "&") {
      flush();
      return tokens;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      flush();
      continue;
    }
    current += c;
    hasContent = true;
  }
  flush();
  return tokens;
}

/**
 * Resolve `path` against `cwd` lexically. Absolute paths pass through;
 * relative paths get `<cwd>/<path>` joined. We do NOT call `path.resolve`
 * (no `..` collapsing, no symlink walk) and we do NOT expand `~` — the
 * hook's payload-only invariant forbids any filesystem hit. Lexical
 * resolution is the contract: the reducer's attribution pass (task .6)
 * is the right place to canonicalize against actual git status output.
 *
 * `cwd` may be null on synthetic events; in that case relative paths are
 * stamped verbatim (the reducer has nothing better to do with them than
 * tag the row "unresolved" and fall through to inferred).
 */
function resolveAgainstCwd(p: string, cwd: string | null): string {
  if (p.length === 0) {
    return p;
  }
  if (p.startsWith("/")) {
    return p;
  }
  if (cwd === null || cwd.length === 0) {
    return p;
  }
  const trimmed = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return `${trimmed}/${p}`;
}

/**
 * Skip leading env-prefix tokens (`KEY=VAL ... cmd`) and leading flag
 * tokens (`--`, `-x`) on a fs-command argv tail. Returns the index of the
 * first positional argument. The fs-commands all share the GNU/BSD flag
 * convention: `-` or `--` prefix means flag. A bare `--` terminator means
 * "rest are positional" — we honor that by returning the index PAST it.
 */
function firstPositional(tokens: string[], startIdx: number): number {
  let i = startIdx;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (t === "--") {
      return i + 1;
    }
    if (t.startsWith("-") && t.length > 1) {
      i++;
      continue;
    }
    return i;
  }
  return i;
}

/**
 * Recognize a POSIX shell I/O redirect operator token (`>`, `>>`, `<`,
 * `<<`, `2>`, `2>>`, `&>`, `2>&1`, `N>&M`, `N>` etc.). The tokenizer only
 * splits on `;|&` so redirect tokens currently leak through as ordinary
 * argv tokens; the target-collection paths (fs-commands + git rm/mv) use
 * this predicate to drop them — and their operand, when the operator is
 * not self-contained (`2>&1` carries its target inline; `> log` does
 * not). The redirect form `&>file` is also self-contained.
 *
 * Self-contained forms (operator consumes its operand inside the same
 * token) return `{redirect: true, consumesNext: false}`; bare forms (the
 * next token is the file target) return `consumesNext: true`.
 *
 * Pure regex match — never throws. Patterns:
 *   `^\d*>>?$` / `^<<?$` — bare `>`, `>>`, `<`, `<<`, `2>`, `2>>` (operand
 *     is the next token).
 *   `^\d*>&\d*$` — `2>&1`, `>&2`, `1>&2` (self-contained).
 *   `^&>>?$` — `&>`, `&>>` (operand is the next token, both streams).
 */
function isRedirectToken(t: string): { match: boolean; consumesNext: boolean } {
  // Self-contained: dup-fd (e.g. `2>&1`, `>&2`).
  if (/^\d*>&\d*$/.test(t)) {
    return { match: true, consumesNext: false };
  }
  // Bare redirect needing operand: `>`, `>>`, `<`, `<<`, `2>`, `2>>`,
  // `&>`, `&>>`.
  if (/^\d*>>?$/.test(t) || /^<<?$/.test(t) || /^&>>?$/.test(t)) {
    return { match: true, consumesNext: true };
  }
  return { match: false, consumesNext: false };
}

/**
 * Subset of `git rm` / `git mv` long-form options that take a glued
 * `--name=value` argument we must NOT mis-classify as a path. We only
 * key on the exact pathspec-magic case (`--pathspec-from-file=`) since
 * its presence forces the deriver to bail to `__TREE__` (we won't read
 * the file). Other `--name=value` flags (e.g. hypothetical) are still
 * filtered by the leading-`-` flag-skip in {@link firstPositional}.
 */
const GIT_PATHSPEC_FROM_FILE = "--pathspec-from-file=";

/**
 * Detect pathspec magic prefixes (`:(top)foo`, `:!foo`, `:(exclude)foo`,
 * `::foo`). Any token starting with bare `:` triggers a bail — we don't
 * try to interpret the magic, the reducer's inferred pass handles it.
 * Tokens starting with `./` or `/` are normal paths; only literal `:`
 * at index 0 matches.
 */
function isPathspecMagic(t: string): boolean {
  return t.length > 0 && t.startsWith(":");
}

/**
 * Walk argv tail from `startIdx`, collecting positional pathspec tokens
 * while honoring:
 *   - leading flag tokens (`-x`, `--foo`) → skipped (all git rm/mv flags
 *     are boolean; `--pathspec-from-file=…` triggers the caller's bail).
 *   - explicit `--` terminator → switches to positional-only mode.
 *   - shell redirect tokens (`2>&1`, `> log`, `2> file`, `&>`, …) →
 *     skipped along with their operand when bare; mirrors the
 *     fs-commands fix.
 *
 * Returns `{targets, bail}` — `bail = true` when a pathspec-from-file or
 * `:`-magic token is seen, signaling the caller to fall back to the
 * `__TREE__` sentinel.
 */
function collectPathspecs(
  tokens: string[],
  startIdx: number,
  cwd: string | null,
): { targets: string[]; bail: boolean } {
  const targets: string[] = [];
  let sawSeparator = false;
  for (let j = startIdx; j < tokens.length; j++) {
    const t = tokens[j] as string;
    if (t === "--") {
      sawSeparator = true;
      continue;
    }
    // Skip leading flag tokens (but not after `--`).
    if (!sawSeparator && t.startsWith("-") && t.length > 1) {
      if (t.startsWith(GIT_PATHSPEC_FROM_FILE)) {
        return { targets: [], bail: true };
      }
      continue;
    }
    const r = isRedirectToken(t);
    if (r.match) {
      if (r.consumesNext) {
        j++;
      }
      continue;
    }
    if (t.length === 0) {
      continue;
    }
    if (isPathspecMagic(t)) {
      return { targets: [], bail: true };
    }
    targets.push(resolveAgainstCwd(t, cwd));
  }
  return { targets, bail: false };
}

/**
 * Extract the mutation kind + lexical target list from a `PostToolUse:Bash`
 * event's `data.tool_input.command` string. Returns `null` on every
 * non-matching hook event / tool name / data shape, every unrecognized
 * command head, every empty argv after env-prefix stripping, and every
 * exception path — the hook's exit-0 contract is non-negotiable.
 *
 * Gated by `hookEvent === 'PostToolUse' && toolName === 'Bash'` (EXACT —
 * `PostToolUseFailure` has no settled `tool_input` and must not match).
 * The `cwd` argument is taken from `events.cwd` (the cwd at hook fire,
 * which IS the cwd of the bash subprocess that ran the command — modulo
 * compound commands where the inner cwd may differ; accepted lossiness,
 * see the spec's "Risks" section).
 *
 * Pattern table (hardcoded canonical paths per the spec's "no arg parsing"
 * rule):
 * - **Package managers** (`pnpm`, `npm`, `yarn`, `bun`, `uv`, `pip`,
 *   `cargo`, `poetry`): match argv[0] + argv[1] against
 *   {@link PKG_MANAGERS}'s install/uninstall sets; targets are the
 *   `<cwd>/manifest` + bare `lockfile` strings.
 * - **Explicit fs** (`rm`, `mv`, `cp`, `mkdir`): match argv[0] against
 *   {@link FS_COMMANDS}; targets are every non-flag argv tail token,
 *   resolved lexically against `cwd`.
 * - **Git tree-mutators** (`checkout`, `restore`, `stash`, `reset`):
 *   match `argv[0] === 'git'` AND `argv[1] in `{@link GIT_TREE_MUTATORS}`;
 *   targets are either every pathspec arg (post-`--`) or the
 *   `__TREE__` sentinel when no pathspec is present.
 *
 * Mirrors {@link extractPlanctlInvocation}'s defensive-probe shape: type-
 * check the `tool_input` object, type-check the `command` string, length
 * cap, try/catch around the tokenizer. NEVER throws past the caller —
 * every error path returns `null`.
 *
 * Pure function of its arguments: re-fold determinism (CLAUDE.md "byte-
 * identical re-fold" invariant) requires that the migration's same-
 * transaction backfill, the live hook write, and a future from-scratch
 * re-fold all produce the same output for the same input. A future
 * bugfix to this deriver requires a schema-bump-with-rewind to re-backfill
 * stored rows — same precedent as the v25→v26 spawn-name widening.
 */
export function extractBashMutation(
  hookEvent: string,
  toolName: string | null,
  data: Record<string, unknown>,
  cwd: string | null,
): BashMutation | null {
  if (hookEvent !== "PostToolUse" || toolName !== "Bash") {
    return null;
  }
  const toolInput = data.tool_input;
  if (typeof toolInput !== "object" || toolInput === null) {
    return null;
  }
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== "string" || command.length === 0) {
    return null;
  }
  if (command.length > BASH_COMMAND_CAP) {
    return null;
  }
  let tokens: string[];
  try {
    tokens = tokenizeShell(command);
  } catch {
    return null;
  }
  // Strip env-prefix tokens (`KEY=VAL`). They are NOT part of the simple
  // command's argv per POSIX shell grammar; stripping is the canonical
  // pre-resolution step.
  let i = 0;
  while (i < tokens.length && ENV_PREFIX_RE.test(tokens[i] as string)) {
    i++;
  }
  if (i >= tokens.length) {
    return null;
  }
  const head = tokens[i] as string;
  // Package-manager dispatch — argv[0] is the pm, argv[1] is the
  // subcommand (`install` / `add` / `remove` / `rm` / etc.).
  const pkg = PKG_MANAGERS[head];
  if (pkg !== undefined) {
    const sub = tokens[i + 1];
    if (typeof sub !== "string") {
      return null;
    }
    if (pkg.install.has(sub)) {
      return {
        kind: "pkg-install",
        targets: [resolveAgainstCwd(pkg.manifest, cwd), pkg.lockfile],
      };
    }
    if (pkg.uninstall.has(sub)) {
      return {
        kind: "pkg-uninstall",
        targets: [resolveAgainstCwd(pkg.manifest, cwd), pkg.lockfile],
      };
    }
    return null;
  }
  // Explicit fs dispatch — argv[0] is the verb; every non-flag argv tail
  // token is a target path. Redirect tokens (`2>&1`, `> log`, `&>file`,
  // `N>&M`) are dropped here too — `tokenizeShell` only splits on
  // `;|&`, so without this filter `rm x > log` would stamp `>` and `log`
  // as bogus targets.
  const fsKind = FS_COMMANDS[head];
  if (fsKind !== undefined) {
    const firstArg = firstPositional(tokens, i + 1);
    const targets: string[] = [];
    for (let j = firstArg; j < tokens.length; j++) {
      const t = tokens[j] as string;
      const r = isRedirectToken(t);
      if (r.match) {
        if (r.consumesNext) {
          j++;
        }
        continue;
      }
      if (t.length === 0) {
        continue;
      }
      targets.push(resolveAgainstCwd(t, cwd));
    }
    if (targets.length === 0) {
      return null;
    }
    return { kind: fsKind, targets };
  }
  // Git rm / mv dispatch — handled separately from the tree-mutator
  // set. Their operands are pathspecs even without a `--` terminator
  // (git's argv grammar; flags are all boolean). Empty pathspec set
  // after stripping → return null (mirror the FS_COMMANDS guard above);
  // `--pathspec-from-file=` or `:`-magic → bail to `__TREE__`.
  if (head === "git") {
    const sub = tokens[i + 1];
    if (sub === "rm" || sub === "mv") {
      const kind = sub === "rm" ? "git-rm" : "git-mv";
      const collected = collectPathspecs(tokens, i + 2, cwd);
      if (collected.bail) {
        return { kind, targets: [TREE_SENTINEL] };
      }
      if (collected.targets.length === 0) {
        return null;
      }
      return { kind, targets: collected.targets };
    }
  }
  // Git tree-mutator dispatch — `git <subcommand> [args...]` where
  // subcommand is a tree-mutator. No pathspec → `__TREE__` sentinel.
  if (head === "git") {
    const sub = tokens[i + 1];
    if (typeof sub !== "string" || !GIT_TREE_MUTATORS.has(sub)) {
      return null;
    }
    // After the subcommand, find the first positional past flags.
    const firstArg = firstPositional(tokens, i + 2);
    const pathspecs: string[] = [];
    // For `git checkout <branch>`, the first positional is the branch
    // name (not a path) — but we can't tell that apart from a pathspec
    // without doing real git arg parsing. The conservative choice is to
    // treat ALL non-`--`-separated positionals as tree-wide (since a
    // bare branch checkout flips the entire tree anyway) and only honor
    // pathspecs after an explicit `--` terminator. That matches the
    // POSIX convention: `git checkout -- path1 path2` is the unambiguous
    // pathspec form.
    let sawSeparator = false;
    for (let j = i + 2; j < tokens.length; j++) {
      const t = tokens[j] as string;
      if (t === "--") {
        sawSeparator = true;
        continue;
      }
      if (!sawSeparator) {
        continue;
      }
      if (t.length === 0) {
        continue;
      }
      pathspecs.push(resolveAgainstCwd(t, cwd));
    }
    if (sawSeparator && pathspecs.length > 0) {
      return { kind: "git-tree-mutate", targets: pathspecs };
    }
    // No `--` separator OR no pathspecs after it → tree-wide sentinel.
    void firstArg;
    return { kind: "git-tree-mutate", targets: [TREE_SENTINEL] };
  }
  return null;
}

/**
 * Canonical UUID-ish session-id pattern. Claude Code's
 * `CLAUDE_CODE_SESSION_ID` is a lowercase-hyphenated v4 UUID
 * (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`); the git wrapper
 * (`plugin/bin/git`) stamps that value verbatim into the
 * `Session-Id:` trailer. A trailer carrying anything else
 * (truncated, missing hyphens, uppercase, garbage) is treated as
 * malformed and the deriver returns `null` → global discharge.
 *
 * Anchored at start AND end (the regex test below uses `^…$`
 * implicitly via `RegExp.test` on a trimmed string with no anchors —
 * see {@link parseSessionIdTrailer}). Module-scope literal so V8/JSC
 * tier up once at process start, mirroring every other parser in
 * this file.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Take-last policy on a multi-line `Session-Id:` trailer block as
 * produced by `git log --format='%(trailers:key=Session-Id,valueonly,
 * only,unfold)'`. Git emits ONE line per Session-Id trailer found on
 * the commit (newline-separated, with a trailing newline on the
 * format-expansion result), so a cherry-picked commit that picked up
 * a second `Session-Id:` trailer from the source commit emits two
 * lines — and the canonical attribution is the LAST line (the
 * cherry-picker's session, not the original author's).
 *
 * Returns the last non-empty trimmed line that matches
 * {@link UUID_RE}, or `null` for an empty / whitespace-only / all-
 * malformed input. A mixed block (one malformed line + one valid
 * UUID line) returns the valid one iff it is the last non-empty
 * line — mirroring the spec's "take-last policy" without a salvage
 * pass.
 *
 * Pure function of its argument so re-fold determinism holds: the
 * migration's same-transaction backfill (if added later), the live
 * worker emission, and a future from-scratch re-fold all produce
 * the same output for the same input.
 */
export function parseSessionIdTrailer(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  // Split on `\n` (the unfold output is plain newlines); trim each
  // line because git appends a trailing `\n` after the last trailer
  // value, which produces a trailing empty element on split.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) continue;
    return UUID_RE.test(line) ? line : null;
  }
  return null;
}

/**
 * The shape returned by {@link extractCommit}. Mirrors the
 * git-worker's `CommitMessage` field-for-field minus the `kind`
 * discriminator. A `null` return signals "not a parseable Commit
 * payload" — the reducer's fold arm short-circuits without a write,
 * the cursor still advances (never throw inside the fold tx).
 *
 * `committer_session_id` is `null` either because the trailer was
 * absent (commit minted outside a Claude Code session — human
 * commit, CI commit, etc.) OR malformed (wrapper bug, hand-edited
 * trailer with a bad value). Both fold to the same "global
 * discharge" semantic: every session's attribution row for the
 * named files clears, because we have no honest way to single out a
 * specific session.
 *
 * `committed_at_ms` is unix-epoch milliseconds — the producer
 * derives it from git's `%ct` (committer date in unix seconds) by
 * multiplying by 1000. Stored in the payload so the reducer can
 * stamp `file_attributions.last_commit_at` without re-reading the
 * commit (producer-only liveness invariant).
 */
/**
 * One entry in a {@link CommitPayload}'s `files[]` — the committed path plus
 * the new blob oid that the commit introduced for that path (schema v44 /
 * epic fn-664). `blob_oid` carries the validated 40-hex SHA-1 (or 64-hex
 * SHA-256 on a future repo) of the committed bytes, derived by the producer
 * via `git diff-tree -r --no-commit-id <commit_oid>` at event-build time
 * (frozen — re-fold determinism, no fold-time git probe).
 *
 * `blob_oid` is `null` when (a) the producer's `diff-tree` parse couldn't
 * recover a clean oid for that path (parse miss, weird record, deletion-mode
 * line we elected not to attribute) — every such single-file failure folds
 * to `null` rather than wedging the entire `CommitPayload` — OR (b) the
 * event was emitted by a pre-v44 producer that carried the legacy
 * `files: string[]` shape; `extractCommit` accepts both shapes for backward
 * compatibility (re-fold determinism over the historical event log) and
 * normalizes the legacy form into `{path, blob_oid: null}` rows. Task .2
 * of the epic gates content-aware discharge on `blob_oid != null && blob_oid
 * === worktree_oid`; a `null` here falls back to today's timestamp
 * discharge (safer side — "cannot confirm content equality → discharge as
 * a no-op probe via the timestamp rule").
 */
export interface CommitFileEntry {
  path: string;
  blob_oid: string | null;
}

export interface CommitPayload {
  project_dir: string;
  commit_oid: string;
  parent_oid: string | null;
  files: CommitFileEntry[];
  committer_session_id: string | null;
  committed_at_ms: number;
}

/**
 * Anchored full-OID match — git short-OIDs vary in length but the
 * `%H` format always emits the full 40-char SHA-1 (or 64-char
 * SHA-256 on future repos). We accept either width so a SHA-256
 * repo doesn't fail attribution; anything else (empty, partial,
 * non-hex, embedded whitespace) rejects. Module-scope literal so
 * V8/JSC tier up once at process start.
 */
const GIT_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Defensive parse of a synthetic `Commit` event's `data` blob into
 * a {@link CommitPayload}. Returns `null` on every shape-mismatch
 * path — the reducer's fold arm reads the return value and skips
 * the write on null, advancing the cursor without a throw.
 *
 * Pure function of the event-row shape so re-fold determinism
 * holds: a from-scratch re-fold against the persisted event log
 * derives the same payload as the live producer wrote.
 *
 * `parent_oid` may be the empty string when git's `%P` expansion
 * returned no parents (the initial commit). We normalize that to
 * `null` so downstream consumers don't accidentally compare
 * against `""`.
 */
export function extractCommit(event: { data: string }): CommitPayload | null {
  if (typeof event.data !== "string" || event.data.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const projectDir = obj.project_dir;
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    return null;
  }
  const commitOid = obj.commit_oid;
  if (typeof commitOid !== "string" || !GIT_OID_RE.test(commitOid)) {
    return null;
  }
  const rawParent = obj.parent_oid;
  let parentOid: string | null;
  if (rawParent === null || rawParent === undefined) {
    parentOid = null;
  } else if (typeof rawParent === "string") {
    parentOid =
      rawParent.length === 0
        ? null
        : GIT_OID_RE.test(rawParent)
          ? rawParent
          : null;
  } else {
    parentOid = null;
  }
  // v44 / fn-664: `files[]` is now `Array<{path, blob_oid}>` carrying the
  // committed blob oid per file (used by task .2 for content-aware
  // discharge). Pre-v44 events stored `files: string[]`; we accept BOTH
  // shapes so a from-scratch re-fold over the historical event log
  // reproduces the same projection — a legacy string entry normalizes to
  // `{path, blob_oid: null}` and the reducer's discharge fold treats
  // `blob_oid: null` exactly as today's timestamp discharge (safer side).
  // Per-entry shape misses fold to null/skip; never throws (the fold tx is
  // sacred). The blob_oid validation reuses GIT_OID_RE so a producer
  // diff-tree parse miss or a non-hex token folds to `null` for that one
  // file without wedging the whole payload.
  const rawFiles = obj.files;
  const files: CommitFileEntry[] = [];
  if (Array.isArray(rawFiles)) {
    for (const f of rawFiles) {
      if (typeof f === "string") {
        if (f.length > 0) {
          files.push({ path: f, blob_oid: null });
        }
        continue;
      }
      if (typeof f !== "object" || f === null) continue;
      const entry = f as Record<string, unknown>;
      const rawPath = entry.path;
      if (typeof rawPath !== "string" || rawPath.length === 0) continue;
      const rawOid = entry.blob_oid;
      let blobOid: string | null;
      if (rawOid === null || rawOid === undefined) {
        blobOid = null;
      } else if (typeof rawOid === "string") {
        blobOid =
          rawOid.length === 0 ? null : GIT_OID_RE.test(rawOid) ? rawOid : null;
      } else {
        blobOid = null;
      }
      files.push({ path: rawPath, blob_oid: blobOid });
    }
  }
  const rawSession = obj.committer_session_id;
  const committerSessionId: string | null =
    typeof rawSession === "string" && UUID_RE.test(rawSession)
      ? rawSession
      : null;
  const rawTs = obj.committed_at_ms;
  const committedAtMs =
    typeof rawTs === "number" && Number.isFinite(rawTs) && rawTs > 0
      ? rawTs
      : 0;
  return {
    project_dir: projectDir,
    commit_oid: commitOid,
    parent_oid: parentOid,
    files,
    committer_session_id: committerSessionId,
    committed_at_ms: committedAtMs,
  };
}
