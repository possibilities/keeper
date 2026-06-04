/**
 * Pure TypeScript port of jobctl's `/plan:plan`-windowed creator/refiner
 * classifier — the load-bearing piece of fn-598. Three exports, all pure
 * (no I/O, no clock, no DB access):
 *
 * - {@link computePlanWindows} — derive half-open `[start, next_start)`
 *   windows from a sorted list of `/plan:plan` opener timestamps. The last
 *   window's upper bound is `Number.MAX_SAFE_INTEGER` (NEVER JS `Infinity`
 *   — SQLite has no infinity type and bun:sqlite would coerce to NULL if
 *   ever persisted; see the epic's "Best practices" callout).
 * - {@link deriveEpicLinks} — classify one session's planctl invocations
 *   against its `/plan:plan` windows; return a deduped, sorted list of
 *   `{kind: "creator" | "refiner", target: <epic_id>}` entries.
 * - {@link deriveJobLinks} — symmetric per-epic view: walk every session's
 *   invocations + windows, return a deduped, sorted list of
 *   `{kind, job_id}` entries for the target epic.
 *
 * The Python source of truth lives at
 * `apps/cli_common/cli_common/planctl_invocations.py:304-756`
 * (`_compute_plan_windows`, `derive_epic_links`, `derive_job_links`).
 *
 * **Unit divergence from the Python.** The Python compares `int ms`
 * throughout (skill invocations are stored as `int(seconds * 1000)`, and
 * planctl invocations are float seconds — converted via `int(raw_ts * 1000)`
 * before window comparison). The TS port compares `seconds` throughout —
 * keeper's `events.ts` is REAL Unix epoch seconds (see
 * `src/types.ts`: "ts is unix-epoch seconds as a REAL"), and we never
 * cross-mix with skill_invocations storage. The golden-fixture generator
 * (`scripts/gen-plan-classifier-fixture.py`) emits Python output as seconds
 * (by passing `ts_ms / 1000` at fixture-emit time) so the byte-identical
 * parity test still holds.
 *
 * **Window opener input shape.** The locked decision (epic spec, "Approach"):
 * a window opens on `PreToolUse:Skill AND skill_name='plan:plan'` ONLY —
 * `slash_command='/plan:plan'` UserPromptSubmit rows are NOT openers (they'd
 * double-fire on slash-typed invocations). This module accepts a list of
 * opener `ts` values; the upstream reducer fan-out decides which event rows
 * feed in. We do not reach into the event log here.
 *
 * **isEpicId rule.** Mirrors jobctl by reusing {@link parsePlanRef} from
 * `src/derivers.ts` — `parsePlanRef(target)?.kind === 'epic'` is the single
 * source of truth (no second copy of the regex). The spawn-name ref shape
 * (see `SPAWN_VERB_REF_RE` in `src/derivers.ts`) and the planctl-target ref
 * shape MUST agree byte-for-byte so a re-fold from scratch reproduces the
 * same epic links.
 *
 * **Re-fold determinism.** Every function here is a pure function of its
 * arguments — no I/O, no mutation of inputs, no time/clock reads. The
 * reducer's `syncPlanctlLinks` fan-out calls these from the deduped UNION of
 * `planctl_op` stdout-scrape events AND durable `Commit`-event trailer facts
 * (`Planctl-Op` / `Planctl-Target` / `Session-Id`, epic fn-695) — the
 * classifier is agnostic to which channel an invocation came from; it sees
 * the merged invocation list. A from-scratch re-fold must reproduce
 * byte-identical `epic_links` / `job_links` arrays (CLAUDE.md
 * "byte-identical re-fold" invariant); pre-fn-695 `Commit` events lack the
 * trailer fields so the commit channel is a no-op over the historical log.
 */

import { parsePlanRef } from "./derivers";

/**
 * Half-open window pair `[start, end)` where the upper bound on the last
 * window is {@link MAX_TS_SENTINEL}.
 */
export type PlanWindow = readonly [start: number, end: number];

/**
 * Sentinel upper bound for the final `/plan:plan` window. Translated from
 * the Python's `math.inf`; we use {@link Number.MAX_SAFE_INTEGER} so any
 * downstream consumer that persists the window into SQLite via bun:sqlite
 * gets a real integer (JS `Infinity` would coerce to NULL — see CLAUDE.md
 * "schema defaults match the zero-event projection" and the epic's Best
 * practices callout on this exact point).
 */
export const MAX_TS_SENTINEL = Number.MAX_SAFE_INTEGER;

/**
 * Normalize a keeper-side raw planctl CLI verb (`epic-create`, `task-create`,
 * `epic-set-title`, `task-set-description`) into the namespace-stripped form
 * the classifier was ported against (`create`, `set-title`, `set-description`).
 *
 * Keeper's hook stamps the raw CLI verb on the `events.planctl_op` column
 * (see {@link import("./derivers").extractPlanctlInvocation}); jobctl's
 * Python audit layer pre-normalizes by stripping the `epic-` / `task-`
 * prefix before passing rows to `derive_epic_links` / `derive_job_links`.
 * Both fan-out call sites (the live reducer's `syncPlanctlLinks` and the
 * v13→v14 migration backfill in `src/db.ts`) MUST use this same helper so
 * the migration's output is byte-identical to what the live reducer
 * produces — without that, a re-fold from scratch would diverge from a
 * migrated DB and break the "byte-identical re-fold" invariant.
 *
 * Pure function of the input. NEVER throws. Unknown / non-prefixed verbs
 * pass through unchanged — `cat` stays `cat`, `done` stays `done`,
 * `scaffold` stays `scaffold`, `close` stays `close`, etc. — so a future
 * planctl CLI verb that doesn't follow the `<kind>-<op>` shape rides through
 * deterministically.
 *
 * **Deliberate TS-only divergence from the Python reference.** Keeper's
 * classifier ({@link deriveEpicLinks}) recognizes `op === "scaffold"` as a
 * creator alongside `op === "create"`, because scaffold is the canonical
 * epic-creation path on this codebase (zero `epic-create` events have ever
 * fired). The Python `apps/cli_common/cli_common/planctl_invocations.py`
 * does NOT recognize `scaffold` as a creator — its audit layer is unaffected
 * by this change. Keeper's view is strictly richer; the parity-fixture tests
 * remain green because none of the captured cases drive a scaffold edge.
 */
export function normalizePlanctlOp(rawOp: string): string {
  if (rawOp.startsWith("epic-")) {
    return rawOp.slice("epic-".length);
  }
  if (rawOp.startsWith("task-")) {
    return rawOp.slice("task-".length);
  }
  return rawOp;
}

/**
 * One classifier-input invocation entry. Mirrors the subset of jobctl's
 * row shape that the classifier reads — `ts`, `op`, `target`, `epic_id`,
 * `subject_present`. The hook stamps these onto the `events` row via
 * {@link import("./derivers").extractPlanctlInvocation}; the reducer's
 * per-session re-derive loop loads them into this shape via a partial-index
 * scan.
 *
 * `subject_present === false` mirrors jobctl's `subject is None` readonly
 * gate (see {@link deriveEpicLinks}).
 */
export interface ClassifierInvocation {
  /** Unix epoch seconds (matches `events.ts` REAL). */
  ts: number;
  op: string;
  /** Bash-parsed planctl target; null when the verb takes no argument. */
  target: string | null;
  /** Parsed-out epic id ({@link parsePlanRef}); null when target is not a planctl ref. */
  epic_id: string | null;
  /** False for read-only verbs (`epics`, `tasks`, `cat`, etc.); true for mutations. */
  subject_present: boolean;
}

/**
 * One link entry in {@link deriveEpicLinks}' return shape. Stable JSON
 * column shape — consumers serialize and persist these arrays verbatim
 * into `jobs.epic_links`. `kind` is one of `"creator" | "refiner"`;
 * `target` is the epic id (NEVER a fully-qualified task id — task-form
 * targets fold up to their parent epic).
 */
export interface EpicLink {
  kind: "creator" | "refiner";
  target: string;
}

/**
 * One link entry in {@link deriveJobLinks}' return shape. Mirrors
 * {@link EpicLink} on the symmetric axis — `kind` carries the same
 * vocabulary; `job_id` identifies the session that touched the target
 * epic. Consumers serialize and persist these arrays verbatim into
 * `epics.job_links`.
 */
export interface JobLink {
  kind: "creator" | "refiner";
  job_id: string;
}

/**
 * Derive half-open `[start, next_start)` windows from a list of
 * `/plan:plan` opener timestamps. Mirrors the Python `_compute_plan_windows`
 * at `apps/cli_common/cli_common/planctl_invocations.py:304-363`.
 *
 * - Defensive sort against out-of-order input (Timsort is O(n) on
 *   already-sorted data; cheap on the steady-state path).
 * - Non-finite (`NaN`, `Infinity`, `-Infinity`) timestamps are dropped
 *   defensively; only finite numbers feed in.
 * - Empty input → empty output (no windows, no edges downstream).
 * - The last window's upper bound is {@link MAX_TS_SENTINEL} (NEVER JS
 *   `Infinity` — SQLite has no infinity type).
 *
 * Pure CPU-only. Mutates no inputs.
 */
export function computePlanWindows(
  openerTimestamps: readonly number[],
): PlanWindow[] {
  const starts: number[] = [];
  for (const ts of openerTimestamps) {
    if (typeof ts !== "number") {
      continue;
    }
    if (!Number.isFinite(ts)) {
      continue;
    }
    starts.push(ts);
  }
  // Defensive sort — callers should pass ts-ASC but we never trust the wire.
  starts.sort((a, b) => a - b);

  if (starts.length === 0) {
    return [];
  }

  const windows: PlanWindow[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i] as number;
    const end =
      i + 1 < starts.length ? (starts[i + 1] as number) : MAX_TS_SENTINEL;
    windows.push([start, end]);
  }
  return windows;
}

/**
 * Classify one session's planctl invocations against its `/plan:plan`
 * windows and return a deduped, sorted list of `{kind, target}` link
 * entries. Mirrors the Python `derive_epic_links` at
 * `apps/cli_common/cli_common/planctl_invocations.py:366-540`.
 *
 * Classification rules (BYTE-FOR-BYTE port of the Python):
 *
 * - `subject_present === false` → ignored (mirrors `subject is None`
 *   readonly gate).
 * - Mutation `ts` strictly before the first window's `start` → ignored.
 * - Mutation `ts` inside a window AND `op === "create"` AND
 *   `isEpicId(target)` → emit `kind: "creator"` for that epic; suppress
 *   any later `refiner` for the same epic in the SAME window
 *   (per-window suppression; cross-window refiner still emits).
 * - Mutation `ts` inside a window AND `epic_id !== null` (and not a
 *   creator edge) → emit `kind: "refiner"` for that epic (subject to
 *   the per-window creator-suppression above).
 * - Mutation with no `epic_id` and no `create`+`isEpicId` match →
 *   ignored.
 *
 * The final list is deduped by `(kind, target)` across all windows, then
 * sorted ASCENDING on the full `(kind, target)` tuple — NEVER on a single
 * field (this matters: `creator` < `refiner` lexicographically, so
 * creators come first, then refiners, each group sorted by target).
 *
 * **Suppression dimensions.** Two structurally-disjoint seen-sets
 * (mirrors Python `seen_links` + `seen_window_creators`):
 * - `seen_links: Set<"kind|target">` — dedup across all windows
 *   (cross-window).
 * - `seen_window_creators: Set<"win_idx|target">` — per-window creator
 *   suppression of refiner. Index-keyed so the same target in two
 *   different windows can still get refiner-then-creator-then-refiner if
 *   the second window opens a fresh creator.
 *
 * Pure CPU-only. Mutates no inputs.
 */
export function deriveEpicLinks(
  invocations: readonly ClassifierInvocation[],
  windows: readonly PlanWindow[],
): EpicLink[] {
  if (windows.length === 0) {
    return [];
  }

  // Defensive sort by ts-ASC — callers should pass sorted, never trust the wire.
  const valid: ClassifierInvocation[] = [];
  for (const e of invocations) {
    if (e == null || typeof e !== "object") {
      continue;
    }
    if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) {
      continue;
    }
    valid.push(e);
  }
  valid.sort((a, b) => a.ts - b.ts);

  const seenLinks = new Set<string>();
  const seenWindowCreators = new Set<string>();
  const links: EpicLink[] = [];

  let winIdx = 0;
  const numWindows = windows.length;

  for (const entry of valid) {
    if (typeof entry.op !== "string" || entry.op.length === 0) {
      continue;
    }
    // Readonly / runtime-state-only entries — skip (mirrors Python `subject is None`).
    if (entry.subject_present === false) {
      continue;
    }

    const ts = entry.ts;

    // Advance window pointer: mutation belongs to the next window when
    // ts >= that window's start (half-open [start, next_start)).
    while (
      winIdx + 1 < numWindows &&
      ts >= (windows[winIdx + 1] as PlanWindow)[0]
    ) {
      winIdx++;
    }

    const winStart = (windows[winIdx] as PlanWindow)[0];
    if (ts < winStart) {
      // Before the first window — drop.
      continue;
    }

    // Classify: creator or refiner?
    // `scaffold` is keeper's canonical epic-create path (the planctl CLI's
    // `scaffold` verb writes a fresh `.planctl/epics/<id>.json`); it carries
    // an epic-shaped target and is treated as a creator alongside `create`.
    // See {@link normalizePlanctlOp} for the deliberate TS-only divergence
    // from the Python audit layer.
    let kind: "creator" | "refiner";
    let linkTarget: string;
    if (
      (entry.op === "create" || entry.op === "scaffold") &&
      entry.target !== null &&
      parsePlanRef(entry.target)?.kind === "epic"
    ) {
      kind = "creator";
      linkTarget = entry.target;
    } else if (entry.epic_id !== null) {
      kind = "refiner";
      linkTarget = entry.epic_id;
    } else {
      // Mutating op but not touching an epic — skip.
      continue;
    }

    // Per-window creator-of-X suppresses refiner-of-X in the same window.
    // Key is structurally disjoint from seenLinks (window-int prefix vs.
    // kind-string prefix) so cross-namespace collision is impossible.
    const windowCreatorKey = `${winIdx} ${linkTarget}`;
    if (kind === "refiner" && seenWindowCreators.has(windowCreatorKey)) {
      continue;
    }

    const linkKey = `${kind} ${linkTarget}`;
    if (!seenLinks.has(linkKey)) {
      seenLinks.add(linkKey);
      links.push({ kind, target: linkTarget });
    }
    if (kind === "creator") {
      seenWindowCreators.add(windowCreatorKey);
    }
  }

  // Total-order sort on the full (kind, target) tuple — NEVER on a single field.
  links.sort((a, b) => {
    if (a.kind < b.kind) return -1;
    if (a.kind > b.kind) return 1;
    if (a.target < b.target) return -1;
    if (a.target > b.target) return 1;
    return 0;
  });
  return links;
}

/**
 * Symmetric per-epic view of {@link deriveEpicLinks}: walk every
 * session's invocations + windows and return a deduped, sorted list of
 * `{kind, job_id}` entries that touched the target *epicId*. Mirrors the
 * Python `derive_job_links` at
 * `apps/cli_common/cli_common/planctl_invocations.py:543-746`.
 *
 * Classification rules (BYTE-FOR-BYTE port of the Python):
 *
 * - `subject_present === false` → ignored.
 * - Mutation `ts` strictly before the first window's `start` for that
 *   session → ignored.
 * - Mutation `ts` inside a window AND `op === "create"` AND
 *   `isEpicId(target)` AND `target === epicId` → emit `kind: "creator"`
 *   for that session; suppress any later `refiner` for the same epic in
 *   the SAME window.
 * - Mutation `ts` inside a window AND `entry.epic_id === epicId`
 *   (and not a creator) → emit `kind: "refiner"` (subject to suppression).
 * - Mutation that doesn't touch *epicId* at all → ignored.
 *
 * Sessions with zero `/plan:plan` invocations (i.e. empty
 * `windowsBySession` entry, or missing entirely) produce no edges.
 *
 * The final list is deduped by `(kind, job_id)` across all sessions,
 * then sorted ASCENDING on the full `(kind, job_id)` tuple.
 *
 * Two structurally-disjoint seen-sets per session (mirrors Python
 * `seen` + `seen_job_creators`):
 * - `seen: Set<"kind|job_id">` — dedup across all sessions (cross-session).
 * - `seenJobCreators: Set<"win_idx|epic_id">` — per-window-per-session
 *   creator suppression of refiner.
 *
 * **Iteration order.** Python 3.7+ dicts preserve insertion order;
 * JavaScript `Map` does too (and `Map.prototype.entries` iterates in
 * insertion order per the ES spec). Sorting on the final
 * `(kind, job_id)` tuple is the only observable ordering, so iteration
 * order of the input map only affects intermediate state (which is
 * collapsed by the dedupe + final sort).
 *
 * Pure CPU-only. Mutates no inputs.
 */
export function deriveJobLinks(
  invocationsBySession: ReadonlyMap<string, readonly ClassifierInvocation[]>,
  windowsBySession: ReadonlyMap<string, readonly PlanWindow[]>,
  epicId: string,
): JobLink[] {
  const seen = new Set<string>();
  const links: JobLink[] = [];

  for (const [jobId, invocations] of invocationsBySession) {
    const windows = windowsBySession.get(jobId);
    if (windows === undefined || windows.length === 0) {
      // No /plan:plan windows for this session — no edges.
      continue;
    }

    // Defensive sort by ts-ASC.
    const valid: ClassifierInvocation[] = [];
    for (const e of invocations) {
      if (e == null || typeof e !== "object") {
        continue;
      }
      if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) {
        continue;
      }
      valid.push(e);
    }
    valid.sort((a, b) => a.ts - b.ts);

    let winIdx = 0;
    const numWindows = windows.length;
    const seenJobCreators = new Set<string>();

    for (const entry of valid) {
      if (typeof entry.op !== "string" || entry.op.length === 0) {
        continue;
      }
      if (entry.subject_present === false) {
        continue;
      }

      const ts = entry.ts;

      while (
        winIdx + 1 < numWindows &&
        ts >= (windows[winIdx + 1] as PlanWindow)[0]
      ) {
        winIdx++;
      }

      const winStart = (windows[winIdx] as PlanWindow)[0];
      if (ts < winStart) {
        continue;
      }

      // Classify for this epic only. `scaffold` is keeper's canonical
      // epic-create path (zero `epic-create` events have ever fired on this
      // codebase); treated as a creator alongside `create`, symmetric with
      // the {@link deriveEpicLinks} predicate. Deliberate TS-only
      // divergence from the Python audit layer.
      let kind: "creator" | "refiner";
      if (
        (entry.op === "create" || entry.op === "scaffold") &&
        entry.target !== null &&
        parsePlanRef(entry.target)?.kind === "epic" &&
        entry.target === epicId
      ) {
        kind = "creator";
      } else if (entry.epic_id === epicId) {
        // Suppress refiner if creator edge already emitted in this window.
        const windowCreatorKey = `${winIdx} ${epicId}`;
        if (seenJobCreators.has(windowCreatorKey)) {
          continue;
        }
        kind = "refiner";
      } else {
        // Mutating op but not for this epic — skip.
        continue;
      }

      const key = `${kind} ${jobId}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ kind, job_id: jobId });
      }
      if (kind === "creator") {
        seenJobCreators.add(`${winIdx} ${epicId}`);
      }
    }
  }

  // Total-order sort on the full (kind, job_id) tuple — NEVER on a single field.
  links.sort((a, b) => {
    if (a.kind < b.kind) return -1;
    if (a.kind > b.kind) return 1;
    if (a.job_id < b.job_id) return -1;
    if (a.job_id > b.job_id) return 1;
    return 0;
  });
  return links;
}
