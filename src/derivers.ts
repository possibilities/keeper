/**
 * Pure derivers shared by the hook, the reducer, AND the schema migration's
 * same-transaction backfill. A separate module so the hook and reducer share
 * one implementation (no consumer→producer import edge) and so the migration
 * backfill, the live hook write, and a from-scratch re-fold produce
 * byte-identical output for the same input.
 *
 * Every function here is a PURE function of its arguments — no I/O, no
 * mutation, no time/clock reads. That purity is load-bearing: re-fold
 * determinism depends on it. Module-scope regex literals tier up once per
 * process rather than recompiling on every hook invocation (cold-start budget).
 */

/**
 * Anchored leading-slash-command match: `/` + lowercase letter + zero-or-more
 * `[A-Za-z0-9_:-]`. Anchored so `Some inline /foo:bar` does not match; the
 * required lowercase letter after `/` keeps file paths (`/Users/...`) from
 * false-matching. The class allows the slash-command vocabulary (alnum, `_`,
 * `-`, and `:` for plugin namespacing) and stops at the first character outside
 * it, so `/foo bar` captures only `/foo`.
 */
const SLASH_COMMAND_RE = /^\/[a-z][\w:-]*/;

/**
 * The repo-token shape a `repair::<token>` key's id half must match — the
 * `<basename-slug>-<hash>` convention worktree provisioning already names its
 * lane directories with (see `repoToken` in `src/worktree-plan.ts`, the
 * canonical producer). A permissive basename-charset slug (letters/digits/
 * `.`/`_`/`-`) ending in a `-<hash>` suffix, where `<hash>` is the base36
 * FNV-1a digest {@link repoToken} produces (1-7 lowercase alnum chars, the
 * range `(2**32-1).toString(36)` spans). STRUCTURAL only — it cannot prove the
 * token names a real repo (that requires a DB-backed reverse lookup), so it
 * exists to reject an obviously malformed or path-shaped token, not to
 * validate the hash itself. Exported (as the anchored {@link REPO_TOKEN_RE}
 * and this un-anchored source) so {@link SPAWN_VERB_REF_RE}'s repair arm and
 * `dispatch-command.ts`'s `parseDispatchableKey` share ONE definition — both
 * dep-free leaf modules, so a hand-duplicated copy could silently drift.
 */
const REPO_TOKEN_SRC =
  "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?-[0-9a-z]{1,7}";

/** Anchored {@link REPO_TOKEN_SRC} — the standalone repo-token validator. */
export const REPO_TOKEN_RE = new RegExp(`^${REPO_TOKEN_SRC}$`);

/**
 * Anchored spawn-name → `{verb, ref}` match, as TWO alternatives:
 *  - `{plan|work|close|resolve|unblock|deconflict}::fn-\d+-[a-z0-9-]+(.\d+)?`
 *    (captures 1-2) — the verb whitelist is locked; adding one is a deliberate
 *    edit here. `resolve` is the daemon merge-resolver dispatch
 *    (`resolve::<epic>`); `unblock` (`unblock::<task>`) and `deconflict`
 *    (`deconflict::<epic>`) are two of the three autonomous ESCALATION
 *    dispatches.
 *  - `repair::<repo-token>` (captures 3-4) — the THIRD escalation dispatch,
 *    repo-scoped rather than epic/task-scoped, so its ref is a {@link
 *    REPO_TOKEN_SRC} token, never an `fn-`-shaped ref.
 * Folding each one's `plan_verb`/`plan_ref` makes it a first-class dispatch
 * key, so the jobs-keyed reaps + instant-death breaker apply to it like any
 * work/close worker. The `$` anchor rejects extra `::` segments so a typo
 * never partial-matches and lands wrong data in the projection. The fn-shaped
 * ref's slug class is narrower than the slash-command class (kebab-only, no
 * `_`/`:`) so a malformed ref rejects rather than masking the error.
 */
const SPAWN_VERB_REF_RE = new RegExp(
  `^(?:(plan|work|close|resolve|unblock|deconflict)::(fn-\\d+-[a-z0-9-]+(?:\\.\\d+)?)|(repair)::(${REPO_TOKEN_SRC}))$`,
);

/**
 * Anchored `handoff::<slug>` spawn-name match — the SEPARATE spawn-name class for
 * `keeper handoff` dispatch. DELIBERATELY its own regex, never folded into
 * {@link SPAWN_VERB_REF_RE}: a `handoff::` name must NOT populate
 * `plan_verb`/`plan_ref` (it carries no plan ref and would pollute readiness +
 * the autopilot dispatch correlator), so the plan-verb parser returns
 * `(null, null)` for it. The id is the agent-authored, slugified handoff slug
 * (`[a-z0-9-]+`, globally unique on this host), so the body class is kebab
 * (`[a-z0-9-]`); the `$` anchor rejects any trailing `::` segment so a typo
 * rejects rather than binding wrong. Sibling of `SPAWN_VERB_REF_RE` — kept narrow
 * on purpose.
 */
const HANDOFF_SPAWN_RE = /^handoff::([a-z0-9-]+)$/;

/**
 * Extract the leading slash command from a `UserPromptSubmit`'s `data.prompt`.
 * Returns `null` for anything not an anchored `/lowercase…` token. The parser
 * stays shape-agnostic (string in, `null`-or-string out) so the migration
 * backfill can call it without re-implementing the caller's event/tool gating.
 */
export function slashCommandFromPrompt(prompt: unknown): string | null {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return null;
  }
  const m = prompt.match(SLASH_COMMAND_RE);
  return m ? m[0] : null;
}

/**
 * Extract the skill name from a Pre/PostToolUse-on-Skill event's
 * `data.tool_input.skill`. Gated by hook event AND tool name — returns `null`
 * otherwise so the column stays NULL (keeping the partial index small).
 * Defensive: a missing `tool_input`, a non-string `skill`, or any shape
 * mismatch returns `null`. NEVER throws — the hook's exit-0 contract is
 * non-negotiable.
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
 * The pair returned by {@link planVerbRefFromSpawnName} — both strings on a
 * clean match, both NULL on any mismatch. Destructured into the
 * `jobs.plan_verb` / `jobs.plan_ref` columns.
 */
export interface PlanVerbRef {
  plan_verb: string | null;
  plan_ref: string | null;
}

/**
 * Split a spawn name (the parent claude `--name`/`-n` token, scraped on
 * `SessionStart`) into `(plan_verb, plan_ref)` per the `{plan,work,close}::<ref>`
 * shape. Returns both NULL on a NULL name, an unwhitelisted verb, a malformed
 * body, or anything trailing the ref. A future verb addition requires editing
 * {@link SPAWN_VERB_REF_RE} — there is no silent fall-through.
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
  // Exactly one alternative matched — captures 1-2 (fn-shaped ref) or 3-4
  // (repair's repo-token ref); the other pair is `undefined`.
  const verb = m[1] ?? m[3];
  const ref = m[2] ?? m[4];
  if (verb === undefined || ref === undefined) {
    return { plan_verb: null, plan_ref: null };
  }
  return { plan_verb: verb, plan_ref: ref };
}

/**
 * Extract the `handoff_id` from a `handoff::<id>` spawn name (the handoff-ee
 * worker's `--name`, scraped on `SessionStart`). Returns the id on a clean
 * match, else `null` (a NULL name, a non-handoff verb, or a malformed body).
 * Distinct from {@link planVerbRefFromSpawnName} so a `handoff::` name lands
 * the handoff bind WITHOUT ever populating `plan_verb`/`plan_ref` — the two
 * spawn-name classes never cross. Pure; re-fold-deterministic. NEVER throws.
 */
export function handoffIdFromSpawnName(
  spawnName: string | null,
): string | null {
  if (spawnName == null || spawnName.length === 0) {
    return null;
  }
  const m = spawnName.match(HANDOFF_SPAWN_RE);
  // biome-ignore lint/style/noNonNullAssertion: regex match guarantees the capture group
  return m == null ? null : m[1]!;
}

/**
 * Extract the `tool_use_id` correlator from any event payload's `data`. Gated
 * only on a non-empty-string field — no event/tool filter; the broad footprint
 * is intentional (a canonical id-keyed correlator). Defensive: missing /
 * non-string / empty all return `null`; never throws.
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
 * The launched background-task id minted on a PostToolUse:Monitor or
 * PostToolUse:Bash-with-`run_in_background`, stamped into
 * `events.background_task_id` so the reducer's Stop arm can resolve three-way
 * provenance. Gated EXACTLY on `(PostToolUse, toolName in {Monitor, Bash})`.
 * The launcher field lives under `data.tool_response`: Monitor's `taskId`,
 * Bash's `backgroundTaskId`. NEVER throws — every shape-mismatch path returns
 * `null` so the column stays NULL and its partial index stays selective.
 */
export function extractBackgroundTaskId(
  hookEvent: string,
  toolName: string | null,
  data: Record<string, unknown>,
): string | null {
  if (hookEvent !== "PostToolUse") {
    return null;
  }
  if (toolName !== "Monitor" && toolName !== "Bash") {
    return null;
  }
  const toolResponse = data.tool_response;
  if (typeof toolResponse !== "object" || toolResponse === null) {
    return null;
  }
  const key = toolName === "Monitor" ? "taskId" : "backgroundTaskId";
  const candidate = (toolResponse as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

/**
 * The single cross-event fold field the git-attribution scan reads off a
 * file-mutating tool event — `data.tool_input.file_path` — promoted to the
 * `events.mutation_path` column so the fold no longer parses the JSON body.
 * Gated EXACTLY on `(PostToolUse, toolName in {Write, Edit, MultiEdit,
 * NotebookEdit})`, mirroring the ARM-B scan's `tool_name IN (...)` predicate.
 *
 * Same null-on-malformed contract as ARM B's `CASE WHEN json_valid` guard: a
 * missing / non-string / empty `file_path`, or a non-object `tool_input`,
 * returns `null` so the column stays NULL and the partial index stays
 * selective. NEVER throws — purity is the re-fold-determinism contract (a
 * future bugfix here needs a schema-bump-with-rewind to re-backfill stored
 * rows). Hook-safe: pure, no I/O, no `bun:sqlite`/`src/db.ts` import.
 */
export function extractMutationPath(
  hookEvent: string,
  toolName: string | null,
  data: Record<string, unknown>,
): string | null {
  if (hookEvent !== "PostToolUse") {
    return null;
  }
  if (
    toolName !== "Write" &&
    toolName !== "Edit" &&
    toolName !== "MultiEdit" &&
    toolName !== "NotebookEdit"
  ) {
    return null;
  }
  const toolInput = data.tool_input;
  if (typeof toolInput !== "object" || toolInput === null) {
    return null;
  }
  const filePath = (toolInput as Record<string, unknown>).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : null;
}

/**
 * The SQL twin of {@link extractMutationPath}'s tool gate: the exact four
 * mutation tools `(PostToolUse, {Write,Edit,MultiEdit,NotebookEdit})` a row must
 * match to ever owe a `mutation_path` backfill. Unaliased columns so it drops
 * into any query over `events` directly.
 *
 * Deriving both the backfill's row scope and compaction's shed guard from this
 * ONE constant is the point: the guard must exclude exactly the rows the
 * backfill still owes, and any future drift between "which tools carry a
 * promotable file_path" and "which rows the shed guard protects" would silently
 * NULL the sole copy of fold-read data. Hook-safe: a plain string, no I/O.
 */
export const MUTATION_TOOL_SQL_PREDICATE = `hook_event = 'PostToolUse'
   AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')`;

/**
 * One entry in the reducer-projected `jobs.monitors` JSON array. Three-way
 * provenance — `monitor` / `bash-bg` / `ambient` (the last is harness-armed,
 * no launch event in this session's stream). Each Stop's `background_tasks`
 * snapshot is fully replaced (live-only, drop-when-dead), so the id is a stable
 * join key only within a single Stop's snapshot window.
 */
export interface MonitorEntry {
  id: string;
  kind: "monitor" | "bash-bg" | "ambient";
  // Carried through from the Stop snapshot (empty-string, never `undefined`,
  // when omitted) so `keeper jobs` can render the monitor's script. `status` is
  // deliberately NOT carried — empirically always `"running"`.
  command?: string;
  description?: string;
}

/**
 * Defensive cap on background_tasks entries kept from one Stop's snapshot. The
 * shell is per-session, so >50 is almost certainly a runaway payload; truncate
 * rather than store an outsized blob. Stable-sort BEFORE the slice so the cap
 * bites deterministically across re-folds.
 */
const BACKGROUND_TASKS_CAP = 50;

/**
 * Defensive lift of a Stop payload's `data.background_tasks`. Allowlist on
 * `type === "shell"` (NOT a denylist — new kinds drop silently until we know
 * how to project them), stable-sort by id, cap at {@link BACKGROUND_TASKS_CAP}.
 * `command`/`description` are defensive string coerces (a non-string folds to
 * `""`). Provenance (`kind`) is recomputed by the reducer, not carried here.
 *
 * NEVER throws — a throw inside the open BEGIN IMMEDIATE rolls back the cursor
 * and wedges the reducer; every shape-mismatch path folds to `[]`. The empty /
 * missing case is AUTHORITATIVE: a Stop with no/empty `background_tasks`
 * REPLACES the persisted monitors with `[]` (drop-when-dead) — a dead monitor
 * must never linger.
 */
export function extractBackgroundTasks(
  data: unknown,
): { id: string; command: string; description: string }[] {
  if (data === null || typeof data !== "object") {
    return [];
  }
  const raw = (data as Record<string, unknown>).background_tasks;
  if (!Array.isArray(raw)) {
    return [];
  }
  const tasks: { id: string; command: string; description: string }[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (e.type !== "shell") {
      continue;
    }
    const id = e.id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    // Defensive coerce — a non-string/absent field folds to `""`, never
    // `undefined`, so the projected shape is stable.
    const command = typeof e.command === "string" ? e.command : "";
    const description = typeof e.description === "string" ? e.description : "";
    tasks.push({ id, command, description });
  }
  // Stable sort by id BEFORE the cap bites so a re-fold over the same payload
  // produces the byte-identical truncated set.
  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (tasks.length > BACKGROUND_TASKS_CAP) {
    return tasks.slice(0, BACKGROUND_TASKS_CAP);
  }
  return tasks;
}

/**
 * Schema v59 (fn-719 task 1): the provenance-filtered occupancy fact
 * derived from a `jobs.monitors` JSON-array value. `true` when ANY entry
 * is a WORKER-LAUNCHED monitor (`kind in {monitor, bash-bg}`); `ambient`
 * session-watchers (the plugin/harness-armed Agent Bus, a never-claimed
 * background shell) NEVER count — they were not launched by the work
 * session's own turn, so they must not occupy the autopilot mutex.
 *
 * Shared, so the reducer's embedded-fact stamp (Stop fold) and the `keeper
 * dash` AGENTS rollup glyph derive the worker-monitor fact from the SAME
 * bytes — the glyph cannot drift from the board pill. Pure function of the
 * serialized monitors string `computeMonitors` produces: same input bytes
 * always yield the same boolean, so the embedded-fact stamp stays re-fold
 * deterministic. NEVER throws (a throw inside the reducer's open BEGIN
 * IMMEDIATE rolls back the cursor; the dash read-side must never throw
 * mid-frame): a malformed / non-array cell folds to `false`.
 *
 * `'[]'` (the drop-when-dead empty snapshot, the terminal-clear write on
 * SessionEnd / Killed) yields `false` — so a terminal job auto-resolves
 * the fact to `false` for free, riding the existing `monitors='[]'` clear.
 */
export function hasLiveWorkerMonitor(monitorsJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(monitorsJson);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) {
    return false;
  }
  return parsed.some(
    (entry) =>
      entry != null &&
      typeof entry === "object" &&
      (entry as { kind?: unknown }).kind !== "ambient" &&
      typeof (entry as { kind?: unknown }).kind === "string",
  );
}

/**
 * Anchored match for Claude Code's `<task-notification>…<status>killed</status>`
 * envelope, injected through `UserPromptSubmit` when a backgrounded task is
 * killed (most commonly during session shutdown). `^` anchors the opener so a
 * free-text mention mid-message can't false-match; the trailing literal closes
 * the match cheaply (no nested quantifier — no catastrophic backtracking).
 */
const KILLED_TASK_NOTIFICATION_RE =
  /^<task-notification>[\s\S]*<status>killed<\/status>/;

/**
 * Detect the killed-task-notification envelope on a `UserPromptSubmit`'s
 * `data.prompt`. Reducer-only: the lifecycle branch skips the `state =
 * 'working'` write when this is `true`, so a shutdown-housekeeping notification
 * doesn't briefly flip a terminal row into `working` right before `SessionEnd`
 * lands. Only the `killed` variant is suppressed — `completed`/`failed`
 * notifications are real signals and still flip to `working`. Pure; `false`
 * for non-string/empty input.
 */
export function isKilledTaskNotification(prompt: unknown): boolean {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return false;
  }
  return KILLED_TASK_NOTIFICATION_RE.test(prompt);
}

/**
 * Anchored plan-ref → `{kind, epic_id, task_id?}` match:
 * `fn-\d+-[a-z0-9-]+(.\d+)?`. Mirrors the ref-body half of
 * {@link SPAWN_VERB_REF_RE} — same kebab-only class and `$` anchor so an
 * uppercase/`_`-bearing ref or a trailing token rejects rather than
 * partial-matching. The optional dot-suffix is the task-number tail.
 */
const PLAN_REF_RE = /^(fn-\d+-[a-z0-9-]+)(?:\.(\d+))?$/;

/**
 * The shape returned by {@link parsePlanRef}. `kind: 'epic'` carries the epic
 * id; `kind: 'task'` carries the epic id plus the fully-qualified task id. A
 * `null` return signals an invalid ref — the reducer's sync helper skips the
 * fan-out and advances the cursor (never throws).
 */
export type ParsedPlanRef =
  | { kind: "epic"; epic_id: string }
  | { kind: "task"; epic_id: string; task_id: string };

/**
 * Split a `plan_ref` into its epic / task components. An epic-form ref returns
 * `{kind: 'epic', epic_id}`; a task-form ref returns `{kind: 'task', epic_id,
 * task_id}` with `task_id = ${epic_id}.${ordinal}`. Anything malformed returns
 * `null`. The reducer's `syncJobIntoEpic` calls this on every `plan_ref`-bearing
 * jobs write; a null return short-circuits the fan-out (cursor still advances).
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
 * The shape returned by {@link extractPlanInvocation}. A `null` return
 * signals "not a plan invocation we care about". `target` / `epic_id` /
 * `task_id` may individually be `null` when the verb takes no argument or its
 * argument is not a parseable plan ref.
 *
 * `subject_present` mirrors the envelope's `subject != null` (the verb carries
 * human subject text); drives creator/refiner classification downstream.
 */
export interface PlanInvocation {
  op: string;
  target: string | null;
  epic_id: string | null;
  task_id: string | null;
  subject_present: boolean;
  /**
   * Repo-relative paths plan wrote during this op. NULL (NOT an empty array)
   * when absent, non-array, filtered to zero strings, or over PLAN_FILES_CAP
   * — keeping the partial-index `IS NOT NULL` predicate selective. Non-empty
   * string arrays only, so a re-fold reproduces the same value.
   */
  files: string[] | null;
}

/**
 * Length cap on the stdout buffer we attempt to `JSON.parse`. plan envelopes
 * are sub-kilobyte; a larger buffer is almost certainly not one and would burn
 * cold-start budget on the parse.
 */
const PLAN_STDOUT_CAP = 64_000;

/**
 * Cap on entries lifted from the envelope's `files` array. A runaway op past
 * this is almost certainly a bug or corrupt envelope, so we drop the lift
 * entirely (NULL) rather than store an outsized blob.
 */
const PLAN_FILES_CAP = 500;

/**
 * Extract a plan-CLI invocation envelope from a `PostToolUse:Bash`'s
 * `data.tool_response.stdout`. Gated EXACTLY on `(PostToolUse, Bash)`
 * (`PostToolUseFailure` has no `tool_response` and must not match); the buffer
 * must parse as JSON carrying a top-level `plan_invocation` envelope key (the
 * v78 migration rewrote every legacy `planctl_invocation` envelope forward).
 *
 * The envelope is the AUTHORITATIVE mutation sentinel — plan writes it on
 * every mutating call and no other, regardless of how it was invoked.
 * Envelope-less mutations from older plan silently drop edges (acceptable;
 * plan is internally controlled).
 *
 * The `target → (epic_id, task_id)` split reuses {@link parsePlanRef}: the
 * spawn-name ref shape and the plan-target ref shape MUST agree byte-for-byte
 * so a re-fold reproduces the same epic links. NEVER throws — every
 * shape-mismatch path returns `null`.
 */
export function extractPlanInvocation(
  hookEvent: string,
  toolName: string | null,
  data: Record<string, unknown>,
): PlanInvocation | null {
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
  if (stdout.length > PLAN_STDOUT_CAP) {
    return null;
  }
  // Fast pre-parse hint: a plan envelope is a JSON object, so the first
  // non-whitespace char is `{` (0x7B). Most PostToolUse:Bash rows are not JSON;
  // short-circuit them without a parse, allowing a leading-whitespace prefix.
  const head = stdout.charCodeAt(0);
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
  // Single-path read of the `plan_invocation` envelope. The v78 migration
  // rewrote every historical `planctl_invocation` envelope → `plan_invocation`
  // and the producer (the plan CLI) emits only `plan_invocation`, so the legacy
  // fallback coalesce is gone — no canonical event carries the old key.
  const parsedObj = parsed as Record<string, unknown>;
  const envelope = parsedObj.plan_invocation;
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
  const refParsed = target !== null ? parsePlanRef(target) : null;
  const epic_id = refParsed?.epic_id ?? null;
  const task_id = refParsed?.kind === "task" ? refParsed.task_id : null;
  // Lift the repo-relative `files` array: Array.isArray + per-element string
  // filter; a zero-length or over-cap array folds to NULL so the partial-index
  // `IS NOT NULL` predicate stays selective.
  let files: string[] | null = null;
  const rawFiles = envObj.files;
  if (
    Array.isArray(rawFiles) &&
    rawFiles.length > 0 &&
    rawFiles.length <= PLAN_FILES_CAP
  ) {
    const filtered = rawFiles.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (filtered.length > 0) {
      files = filtered;
    }
  }
  return { op, target, epic_id, task_id, subject_present, files };
}

/**
 * Cap on the Bash `tool_input.command` string we tokenize. An outsized blob is
 * almost certainly machine-generated piped output, not a meaningful mutation;
 * skipping its parse keeps the hook cold-start budget intact.
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
 * The recognized-package-manager table. Keys are argv head tokens; values carry
 * the install/uninstall verbs (to tag the mutation kind) plus the canonical
 * lockfile + manifest paths. Hardcoded canonical paths, not arg parsing: the
 * deriver stamps the bare lockfile basename (lives at the git root, which a hook
 * payload can't see) and the cwd-anchored manifest path, leaving absolutization
 * to the reducer's attribution pass. Only dep-graph-mutating subcommands are
 * listed — `pnpm test` / `cargo build` get no attribution edge.
 */
interface PkgManagerSpec {
  install: ReadonlySet<string>;
  uninstall: ReadonlySet<string>;
  /** Relative lockfile path under the git root; consumers prepend project_dir. */
  lockfile: string;
  /** Relative manifest path under cwd; consumers may absolutize. */
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
 * EXACT (no `/usr/bin/rm` — absolute-path resolution is the inferred pass's
 * job). Tail parsing is uniform: skip leading flags, every remaining token is a
 * path. `mv`/`cp` source and destination are both reported as targets
 * (over-attributing the source); the reducer's attribution pass is the final
 * arbiter against the dirty set.
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
 * Whitelist of git subcommands that rewrite the working tree. No pathspec →
 * `__TREE__` sentinel (the whole tree may flip); with a pathspec, only the
 * literal arg is stamped (globs are the inferred pass's job).
 */
const GIT_TREE_MUTATORS: ReadonlySet<string> = new Set([
  "checkout",
  "restore",
  "stash",
  "reset",
]);

/**
 * Tree-wide sentinel target for git mutations with no pathspec — the reducer
 * reads it as "any dirty file could have flipped attribution". The bracketed
 * `__` token can never collide with a real POSIX path.
 */
const TREE_SENTINEL = "__TREE__";

/**
 * The shape returned by {@link extractBashMutation}. `kind` tags the mutation
 * family; `targets` is the resolved path list (relative→absolute against `cwd`,
 * bare lockfile/manifest names for package managers, or `__TREE__`). For
 * `git-rm`/`git-mv` the `__TREE__` sentinel is also used when
 * `--pathspec-from-file=` is present (we won't read the file) or any pathspec
 * carries `:`-magic. A null return stays NULL on disk so the partial index
 * stays selective.
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
 * Tokenize a POSIX-shell-ish command line into argv tokens. Quote- and
 * backslash-escape-aware; NO AST, subshells, heredocs, or brace expansion —
 * every uncovered pattern degrades to "won't match a mutation" and falls
 * through to the inferred pass. Never throws.
 *
 * Quoting subset:
 * - `'...'`: everything literal; a missing close-quote eats to end-of-string.
 * - `"..."`: literal except `\\`, `\"`, `\$`, `` \` `` (POSIX double-quote
 *   escapes strip the backslash); other backslash sequences keep it literal.
 * - bare `\X` outside quotes: drops the backslash, keeps the next char.
 *
 * Compound-command separators (`;`, `&`, `|`) terminate the token list — we
 * only tokenize the FIRST simple command. Subshells pass through opaque.
 *
 * Exported so the sidecar-writer hook reuses the SAME tokenizer for parsing a
 * `gh gist create <doc>.md <doc>.yaml` argv (no second hand-rolled splitter).
 */
export function tokenizeShell(command: string): string[] {
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
 * Resolve `path` against `cwd` LEXICALLY — no `path.resolve`, no `..`
 * collapsing, no symlink walk, no `~` expansion: the hook's payload-only
 * invariant forbids any filesystem hit. Canonicalization is the reducer's
 * attribution pass's job. `cwd` null (synthetic events) → relative paths stamp
 * verbatim.
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
 * Index of the first positional argument on a fs-command argv tail, skipping
 * leading flag tokens. A bare `--` terminator returns the index PAST it.
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
 * Recognize a POSIX shell I/O redirect operator token. The tokenizer only
 * splits on `;|&`, so redirect tokens leak through as ordinary argv; the
 * target-collection paths use this to drop them — and their operand when the
 * operator is bare (`> log`) rather than self-contained (`2>&1`). Self-contained
 * forms return `consumesNext: false`; bare forms `consumesNext: true`.
 */
function isRedirectToken(t: string): { match: boolean; consumesNext: boolean } {
  // Self-contained dup-fd: `2>&1`, `>&2`.
  if (/^\d*>&\d*$/.test(t)) {
    return { match: true, consumesNext: false };
  }
  // Bare redirect needing an operand: `>`, `>>`, `<`, `<<`, `2>`, `&>`, …
  if (/^\d*>>?$/.test(t) || /^<<?$/.test(t) || /^&>>?$/.test(t)) {
    return { match: true, consumesNext: true };
  }
  return { match: false, consumesNext: false };
}

/**
 * The one glued `--name=value` git rm/mv option that matters: its presence
 * forces a bail to `__TREE__` (we won't read the file). Other `--name=value`
 * flags are filtered by the flag-skip in {@link firstPositional}.
 */
const GIT_PATHSPEC_FROM_FILE = "--pathspec-from-file=";

/**
 * Detect pathspec magic prefixes (`:(top)foo`, `:!foo`, `::foo`). Any token
 * starting with bare `:` triggers a bail — the inferred pass interprets the
 * magic, not us.
 */
function isPathspecMagic(t: string): boolean {
  return t.length > 0 && t.startsWith(":");
}

/**
 * Walk argv tail from `startIdx`, collecting positional pathspec tokens while
 * skipping leading flags, honoring a `--` terminator, and dropping redirect
 * tokens (and their bare operand). Returns `bail = true` on a
 * pathspec-from-file or `:`-magic token, signaling the caller to fall back to
 * `__TREE__`.
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
 * Extract the mutation kind + lexical target list from a `PostToolUse:Bash`'s
 * `data.tool_input.command`. Gated EXACTLY on `(PostToolUse, Bash)`
 * (`PostToolUseFailure` has no settled `tool_input`). `cwd` is `events.cwd` —
 * the bash subprocess's cwd, modulo compound commands (accepted lossiness).
 *
 * Pattern table (hardcoded canonical paths, no arg parsing):
 * - Package managers: match argv[0] + argv[1] against {@link PKG_MANAGERS}.
 * - Explicit fs (`rm`/`mv`/`cp`/`mkdir`): every non-flag tail token, resolved
 *   against `cwd`.
 * - Git tree-mutators: `git <{@link GIT_TREE_MUTATORS}>`; post-`--` pathspecs
 *   or the `__TREE__` sentinel.
 *
 * NEVER throws — every error path returns `null`. A future bugfix here requires
 * a schema-bump-with-rewind to re-backfill stored rows (re-fold determinism).
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
  // Strip env-prefix tokens (`KEY=VAL`) — not part of the simple command's argv
  // per POSIX shell grammar.
  let i = 0;
  while (i < tokens.length && ENV_PREFIX_RE.test(tokens[i] as string)) {
    i++;
  }
  if (i >= tokens.length) {
    return null;
  }
  const head = tokens[i] as string;
  // Package-manager dispatch — argv[0] is the pm, argv[1] the subcommand.
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
  // Explicit fs dispatch — every non-flag tail token is a target. Redirect
  // tokens are dropped (the tokenizer only splits on `;|&`, so without this
  // `rm x > log` would stamp `>` and `log` as bogus targets).
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
  // Git rm / mv dispatch — operands are pathspecs even without a `--` (git's
  // flags are all boolean). Empty set → null; pathspec-from-file or `:`-magic →
  // bail to `__TREE__`.
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
  // Git tree-mutator dispatch — no pathspec → `__TREE__` sentinel.
  if (head === "git") {
    const sub = tokens[i + 1];
    if (typeof sub !== "string" || !GIT_TREE_MUTATORS.has(sub)) {
      return null;
    }
    const firstArg = firstPositional(tokens, i + 2);
    const pathspecs: string[] = [];
    // `git checkout <branch>`'s first positional is a branch, not a path, and
    // we can't tell them apart without real git arg parsing. A bare branch
    // checkout flips the whole tree anyway, so we treat all positionals as
    // tree-wide and only honor pathspecs after an explicit `--`.
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
 * Lowercase-hyphenated v4 UUID pattern matching `CLAUDE_CODE_SESSION_ID` as the
 * git wrapper stamps it into the `Session-Id:` trailer. Anything else
 * (truncated, uppercase, garbage) is malformed → `null` → global discharge.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Take-LAST policy on a multi-line `Session-Id:` trailer block (one line per
 * trailer, newline-separated). A cherry-pick that picked up a second
 * `Session-Id:` emits two lines, and the canonical attribution is the last (the
 * cherry-picker's session, not the original author's). Returns the last
 * non-empty {@link UUID_RE}-matching line, or `null` for empty / all-malformed
 * input. Pure.
 */
export function parseSessionIdTrailer(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  // Split on `\n`; trim each line (git appends a trailing `\n` after the last
  // trailer, producing a trailing empty element on split).
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) continue;
    return UUID_RE.test(line) ? line : null;
  }
  return null;
}

/**
 * Anchored plan TASK-id pattern. Tighter than {@link PLAN_REF_RE} on purpose
 * — an epic-form ref (no `.N` tail) is malformed and drops, because the
 * epic→committing-session link fold keys on a task id, not an epic id.
 */
const TASK_TRAILER_RE = /^fn-\d+-[a-z0-9-]+\.\d+$/;

/**
 * Collect-ALL policy on a multi-line `Task:` trailer block. A commit may close
 * multiple tasks in one message, so this collects EVERY {@link TASK_TRAILER_RE}-
 * valid value (union-of-all) — distinct from session attribution's take-last.
 * Garbage entries drop at entry granularity; `[]` for null / empty / all-invalid
 * input. Accepts both `\n` and `\0` separators (the producer emits NUL between
 * values; the {@link extractCommit} re-decode reads back a JSON `string[]`).
 * Pure.
 */
export function parseTaskTrailers(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }
  const out: string[] = [];
  // Split on BOTH `\n` (legacy unfold) and `\0` (the multi-value separator).
  const lines = raw.split(/[\n\0]/);
  for (const line of lines) {
    const v = line.trim();
    if (v.length === 0) continue;
    if (TASK_TRAILER_RE.test(v)) out.push(v);
  }
  return out;
}

/**
 * One entry in a {@link CommitPayload}'s `files[]` — the committed path plus the
 * blob oid and mode the commit introduced. `blob_oid` is the validated SHA-1/
 * SHA-256 from `git diff-tree -r` at event-build time (frozen — no fold-time git
 * probe). `blob_oid` / `committed_mode` are `null` on a producer parse miss, a
 * deletion record, or a legacy event predating the field; {@link extractCommit}
 * accepts both the legacy `files: string[]` shape and the tuple shape, so a
 * re-fold over the historical log reproduces the same projection. The discharge
 * gate stamps `last_commit_at` only when BOTH content+mode pairs match the
 * worktree; any null falls back to unconditional timestamp discharge (the safer
 * side).
 */
export interface CommitFileEntry {
  path: string;
  blob_oid: string | null;
  committed_mode: string | null;
}

/**
 * The shape returned by {@link extractCommit} — a parsed synthetic `Commit`
 * event payload. A `null` return short-circuits the reducer's fold arm without
 * a write (cursor still advances, never throws). `committer_session_id` is
 * `null` when the trailer is absent (non-session commit) or malformed; both
 * fold to global discharge (every session's attribution row for the named files
 * clears, since no session can be singled out). `committed_at_ms` is unix-epoch
 * ms from git's `%ct`, stored so the reducer stamps `last_commit_at` without
 * re-reading the commit.
 */
export interface CommitPayload {
  project_dir: string;
  commit_oid: string;
  parent_oid: string | null;
  files: CommitFileEntry[];
  committer_session_id: string | null;
  /**
   * Validated plan-shaped `Task:` trailer values — union-of-ALL (a commit
   * may close multiple tasks), NOT take-last like {@link committer_session_id}.
   * `[]` on no trailer, all-malformed, or a legacy event. The link fold reads
   * this AND `committer_session_id`; either array-empty or session-null
   * short-circuits.
   */
  task_ids: string[];
  /**
   * The plan op from the `Planctl-Op:` trailer, normalized at producer time
   * so it shares the scrape path's vocabulary. `null` on no trailer, empty, or
   * a legacy event. The edge fold needs `plan_op` + {@link plan_target} +
   * {@link committer_session_id} all non-null to mint an edge.
   */
  plan_op: string | null;
  /**
   * The plan target ref from the `Planctl-Target:` trailer, validated via
   * {@link parsePlanRef} (a task-form ref folds up to its epic). `null` on a
   * missing / malformed trailer or a legacy event.
   */
  plan_target: string | null;
  committed_at_ms: number;
}

/**
 * Anchored full-OID match — `%H` emits the full 40-char SHA-1 (or 64-char
 * SHA-256). We accept either width so a SHA-256 repo doesn't fail attribution;
 * anything else rejects.
 */
const GIT_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Defensive parse of a synthetic `Commit` event's `data` blob into a
 * {@link CommitPayload}. Returns `null` on every shape-mismatch path (the fold
 * arm skips the write, cursor still advances). Pure. `parent_oid` normalizes
 * the empty-string initial-commit case to `null`.
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
  // `files[]` accepts ALL historical shapes — legacy `string[]`, `{path,
  // blob_oid}`, and the full `{path, blob_oid, committed_mode}` tuple — so a
  // re-fold over the historical log reproduces the same projection (a legacy
  // string normalizes to nulls). Per-entry shape misses fold to null/skip;
  // never throws (the fold tx is sacred). blob_oid reuses GIT_OID_RE so a parse
  // miss folds to `null` without wedging the whole payload; a zero-mode / empty
  // / non-string committed_mode folds to `null`.
  const rawFiles = obj.files;
  const files: CommitFileEntry[] = [];
  if (Array.isArray(rawFiles)) {
    for (const f of rawFiles) {
      if (typeof f === "string") {
        if (f.length > 0) {
          files.push({ path: f, blob_oid: null, committed_mode: null });
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
      const rawMode = entry.committed_mode;
      let committedMode: string | null;
      if (typeof rawMode === "string") {
        committedMode =
          rawMode.length === 0 || /^0+$/.test(rawMode) ? null : rawMode;
      } else {
        committedMode = null;
      }
      files.push({
        path: rawPath,
        blob_oid: blobOid,
        committed_mode: committedMode,
      });
    }
  }
  const rawSession = obj.committer_session_id;
  const committerSessionId: string | null =
    typeof rawSession === "string" && UUID_RE.test(rawSession)
      ? rawSession
      : null;
  // Defensively decode `task_ids` — a legacy event lacking the field defaults to
  // `[]` (the no-op link-fold input, re-fold determinism). Each entry must be a
  // non-empty TASK_TRAILER_RE-matching string; garbage drops at entry
  // granularity without failing the whole payload.
  const rawTaskIds = obj.task_ids;
  let taskIds: string[];
  if (Array.isArray(rawTaskIds)) {
    taskIds = [];
    for (const t of rawTaskIds) {
      if (typeof t !== "string") continue;
      const v = t.trim();
      if (v.length === 0) continue;
      if (TASK_TRAILER_RE.test(v)) taskIds.push(v);
    }
  } else {
    taskIds = [];
  }
  // Defensively decode `plan_op` / `plan_target` — a legacy event lacking
  // both defaults each to `null` (the no-op edge-fold input). Single-path read
  // of the `plan_*` keys: the v82 migration rewrote every historical Commit
  // record's legacy `planctl_op` / `planctl_target` data keys forward, so no
  // canonical event carries the old spelling. A type-gate re-check of
  // producer-validated facts: non-empty string for the op, `parsePlanRef`-valid
  // ref for the target; anything else folds to `null`.
  const rawOp = obj.plan_op;
  const planOp: string | null =
    typeof rawOp === "string" && rawOp.length > 0 ? rawOp : null;
  const rawTarget = obj.plan_target;
  const planTarget: string | null =
    typeof rawTarget === "string" && parsePlanRef(rawTarget) !== null
      ? rawTarget
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
    task_ids: taskIds,
    plan_op: planOp,
    plan_target: planTarget,
    committed_at_ms: committedAtMs,
  };
}
