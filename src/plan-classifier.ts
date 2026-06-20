/**
 * Windowless creator/refiner classifier for keeper's plan-link projection.
 * Two exports, both pure (no I/O, no clock, no DB access):
 *
 * - {@link deriveEpicLinks} — classify one session's planctl invocations and
 *   return a deduped, sorted list of `{kind: "creator" | "refiner", target:
 *   <epic_id>}` entries. Every epic-mutating op links regardless of time; the
 *   read-only (`subject_present === false`) gate is the only skip.
 * - {@link deriveJobLinks} — symmetric per-epic view: walk every session's
 *   invocations, return a deduped, sorted list of `{kind, job_id}` entries
 *   for the target epic.
 *
 * **Two-kind taxonomy.** `creator` = op in {create, scaffold} with an
 * epic-shaped `parsePlanRef(target).kind === 'epic'`; otherwise `refiner` if
 * the op names an epic (`epic_id` resolves). `scaffold` is keeper's canonical
 * epic-create path (zero `epic-create` events have ever fired on this
 * codebase); `/plan:defer` rides the scaffold→creator path, and
 * `/plan:next` / queue-jump / direct-CLI edits land as refiners. No other
 * kinds.
 *
 * **Per-session creator-suppression.** A session that BOTH scaffolds AND later
 * refines the same epic emits ONE `creator` edge, not creator+refiner — the
 * suppression set is keyed on target/epic only (NOT on a time window).
 * Cross-session edges are NEVER suppressed: two different sessions touching the
 * same epic keep their distinct `job_id`s.
 *
 * **isEpicId rule.** Reuses {@link parsePlanRef} from `src/derivers.ts` —
 * `parsePlanRef(target)?.kind === 'epic'` is the single source of truth (no
 * second copy of the regex). The spawn-name ref shape (`SPAWN_VERB_REF_RE` in
 * `src/derivers.ts`) and the planctl-target ref shape MUST agree byte-for-byte
 * so a re-fold from scratch reproduces the same epic links.
 *
 * **Re-fold determinism.** Every function here is a pure function of its
 * arguments — no I/O, no mutation of inputs, no time/clock reads. Input is
 * sorted by a TOTAL ORDER `(ts ASC, event_id ASC)` before classification, so
 * the per-session creator-suppression outcome does not depend on the wire order
 * of `ts`-ties (two same-`ts` ops of one epic resolve identically every fold).
 * The reducer's `syncPlanctlLinks` fan-out calls these from the deduped UNION
 * of `planctl_op` stdout-scrape events AND durable `Commit`-event trailer facts
 * (`Planctl-Op` / `Planctl-Target` / `Session-Id`, epic fn-695) — the
 * classifier is agnostic to which channel an invocation came from; it sees the
 * merged invocation list. A from-scratch re-fold must reproduce byte-identical
 * `epic_links` / `job_links` arrays (CLAUDE.md "byte-identical re-fold"
 * invariant); pre-fn-695 `Commit` events lack the trailer fields so the commit
 * channel is a no-op over the historical log.
 */

import { parsePlanRef } from "./derivers";

/**
 * Normalize a keeper-side raw planctl CLI verb (`epic-create`, `task-create`,
 * `epic-set-title`, `task-set-description`) into the namespace-stripped form
 * the classifier reads (`create`, `set-title`, `set-description`).
 *
 * Keeper's hook stamps the raw CLI verb on the `events.planctl_op` column
 * (see {@link import("./derivers").extractPlanctlInvocation}). Both fan-out
 * call sites (the live reducer's `syncPlanctlLinks` and the frozen migration
 * backfills in `src/db.ts`) MUST use this same helper so the migration's
 * output is byte-identical to what the live reducer produces — without that, a
 * re-fold from scratch would diverge from a migrated DB and break the
 * "byte-identical re-fold" invariant.
 *
 * Pure function of the input. NEVER throws. Unknown / non-prefixed verbs pass
 * through unchanged — `cat` stays `cat`, `done` stays `done`, `scaffold` stays
 * `scaffold`, `close` stays `close`, etc. — so a future planctl CLI verb that
 * doesn't follow the `<kind>-<op>` shape rides through deterministically.
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
 * One classifier-input invocation entry. The hook stamps `ts`, `op`, `target`,
 * `epic_id`, `subject_present` onto the `events` row via
 * {@link import("./derivers").extractPlanctlInvocation}; the reducer's
 * per-session re-derive loop loads them into this shape via a partial-index
 * scan.
 *
 * `event_id` is the source-event id (the `events.id` row, or the
 * `commit_trailer_facts.event_id` for a commit-channel fact). It is the
 * tiebreaker that makes the classifier's sort a TOTAL ORDER on `ts`-ties —
 * required for byte-identical re-fold. Absent (`undefined`) inputs sort as 0,
 * which is harmless for hand-written test cases that never collide on `ts`.
 *
 * `subject_present === false` is the read-only gate (mirrors `epics` / `tasks`
 * / `cat` listing verbs that touch no plan state); such entries are skipped.
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
  /** Source-event id; the total-order tiebreaker on `ts`-ties. Optional for tests. */
  event_id?: number;
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
 * Total-order comparator on `(ts ASC, event_id ASC)`. The `event_id` tiebreak
 * makes the order independent of input wire-order on `ts`-ties, so a
 * from-scratch re-fold over the same deterministic event log reproduces the
 * same creator-suppression outcome. A missing `event_id` reads as 0.
 */
function compareInvocations(
  a: ClassifierInvocation,
  b: ClassifierInvocation,
): number {
  if (a.ts !== b.ts) {
    return a.ts - b.ts;
  }
  const aid = a.event_id ?? 0;
  const bid = b.event_id ?? 0;
  return aid - bid;
}

/**
 * Filter out malformed entries (null/non-object/non-finite `ts`) and sort the
 * survivors by the total order. NEVER throws — a malformed entry is dropped
 * defensively so the fold stays safe.
 */
function sortValidInvocations(
  invocations: readonly ClassifierInvocation[],
): ClassifierInvocation[] {
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
  valid.sort(compareInvocations);
  return valid;
}

/**
 * Classify one entry into a `(kind, target)` link, or null when it is not an
 * epic-mutating op. `scaffold` is keeper's canonical epic-create path (the
 * planctl CLI's `scaffold` verb writes a fresh `.keeper/epics/<id>.json`); it
 * carries an epic-shaped target and is a creator alongside `create`. A
 * mutating op that names an epic (via `epic_id`) but is not a create/scaffold
 * is a refiner. Anything else (read-only, or touching no epic) returns null.
 */
function classifyEntry(
  entry: ClassifierInvocation,
): { kind: "creator" | "refiner"; target: string } | null {
  if (typeof entry.op !== "string" || entry.op.length === 0) {
    return null;
  }
  // Read-only / runtime-state-only entries — skip (the only surviving gate).
  if (entry.subject_present === false) {
    return null;
  }
  if (
    (entry.op === "create" || entry.op === "scaffold") &&
    entry.target !== null &&
    parsePlanRef(entry.target)?.kind === "epic"
  ) {
    return { kind: "creator", target: entry.target };
  }
  if (entry.epic_id !== null) {
    return { kind: "refiner", target: entry.epic_id };
  }
  return null;
}

/**
 * Classify one session's planctl invocations and return a deduped, sorted list
 * of `{kind, target}` link entries. Every epic-mutating op links regardless of
 * time — there is no `/plan:plan` window gate.
 *
 * Classification rules:
 *
 * - `subject_present === false` → ignored (read-only gate).
 * - `op` in {create, scaffold} with `parsePlanRef(target).kind === 'epic'` →
 *   `creator` for that epic; suppress any later `refiner` for the SAME epic in
 *   this session (per-session suppression).
 * - Any other mutating op naming an epic (`epic_id !== null`) → `refiner` for
 *   that epic, unless a creator for the same epic already fired this session.
 * - Mutating op touching no epic → ignored.
 *
 * The final list is deduped by `(kind, target)`, then sorted ASCENDING on the
 * full `(kind, target)` tuple — `creator` < `refiner` lexicographically, so
 * creators come first, then refiners, each group sorted by target.
 *
 * Pure CPU-only. Mutates no inputs.
 */
export function deriveEpicLinks(
  invocations: readonly ClassifierInvocation[],
): EpicLink[] {
  const valid = sortValidInvocations(invocations);

  const seenLinks = new Set<string>();
  // Per-session creator-of-X suppresses a later refiner-of-X. Keyed on the
  // target epic only (no time window).
  const seenCreators = new Set<string>();
  const links: EpicLink[] = [];

  for (const entry of valid) {
    const classified = classifyEntry(entry);
    if (classified === null) {
      continue;
    }
    const { kind, target } = classified;

    if (kind === "refiner" && seenCreators.has(target)) {
      continue;
    }

    const linkKey = `${kind} ${target}`;
    if (!seenLinks.has(linkKey)) {
      seenLinks.add(linkKey);
      links.push({ kind, target });
    }
    if (kind === "creator") {
      seenCreators.add(target);
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
 * Symmetric per-epic view of {@link deriveEpicLinks}: walk every session's
 * invocations and return a deduped, sorted list of `{kind, job_id}` entries
 * that touched the target *epicId*. Every epic-mutating op links regardless of
 * time — no `/plan:plan` window gate.
 *
 * Classification rules (for *epicId* only):
 *
 * - `subject_present === false` → ignored.
 * - `op` in {create, scaffold} with `parsePlanRef(target).kind === 'epic'`
 *   AND `target === epicId` → emit `creator` for that session; suppress any
 *   later `refiner` for the same epic in the SAME session.
 * - `entry.epic_id === epicId` (and not a creator) → emit `refiner` (subject
 *   to the per-session suppression above).
 * - Mutation that doesn't touch *epicId* → ignored.
 *
 * The final list is deduped by `(kind, job_id)` across all sessions, then
 * sorted ASCENDING on the full `(kind, job_id)` tuple. Cross-session edges are
 * never suppressed.
 *
 * Pure CPU-only. Mutates no inputs.
 */
export function deriveJobLinks(
  invocationsBySession: ReadonlyMap<string, readonly ClassifierInvocation[]>,
  epicId: string,
): JobLink[] {
  const seen = new Set<string>();
  const links: JobLink[] = [];

  for (const [jobId, invocations] of invocationsBySession) {
    const valid = sortValidInvocations(invocations);
    // Per-session creator-of-epicId suppresses a later refiner-of-epicId.
    let seenCreator = false;

    for (const entry of valid) {
      const classified = classifyEntry(entry);
      if (classified === null) {
        continue;
      }
      // Only edges for the queried epic count toward this session's links.
      if (classified.target !== epicId) {
        continue;
      }
      const kind = classified.kind;
      if (kind === "refiner" && seenCreator) {
        continue;
      }

      const key = `${kind} ${jobId}`;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ kind, job_id: jobId });
      }
      if (kind === "creator") {
        seenCreator = true;
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
