#!/usr/bin/env bun
/**
 * keeper-board — an epics-only "UI" over the read-only NDJSON-over-UDS
 * subscribe server (`src/server-worker.ts`) that streams the epics +
 * subagent_invocations collections (plus jobs as a passive feed for the
 * nested per-task / per-link rendering) as one frame per change. Sibling
 * of `cli/jobs.ts`, which owns the bottom jobs list + the dead-letter
 * banner — those moved out of board in fn-658.3. `subagent_invocations`
 * rows feed the readiness pill AND nest as indented `[<status>]` lines
 * under the matching job row inside each epic block, stamping the raw
 * 5-value projection enum `running|ok|failed|unknown|superseded`
 * verbatim — `superseded` is promoted natively by the projection (task
 * fn-605.2). Same-name invocations within one job ADDITIONALLY collapse
 * on the client to a single line representing the most-recent (max
 * turn_seq) row via `collapseSubagentsByName` in
 * `src/readiness-client.ts` — a `(×N)` multiplier and an optional
 * `N stuck` orphan indicator surface the collapsed count and any
 * non-surviving `running` rows. The same collapse feeds readiness, so
 * an orphan `running` row whose matching `SubagentStop` never landed no
 * longer false-blocks predicate 6. Full uncollapsed audit trail stays
 * in sqlite.
 *
 * Frame shape:
 *
 *   {epics body}     ← one block per epic, see `renderEpicBlock` below
 *
 * Each epic block carries its own embedded creator/refiner link lines
 * (one per `job_links` entry) AND its work-verb jobs nested under the
 * matching task or close row — those are EPIC rendering, not the bottom
 * jobs list. The flat bottom jobs list and its `[dead-letter:N]` banner
 * live in `cli/jobs.ts`.
 *
 * Connection / poll / coalesce / first-paint lifecycle is owned by
 * `subscribeReadiness` in `src/readiness-client.ts`. The board is the
 * RENDERER: it owns the sidecar writes, the per-frame `job_id →
 * SubagentInvocation[]` index used to nest sub-agent lines under jobs,
 * the `lastBody` byte-compare that suppresses no-op frames, and the
 * stdout emit. The helper handles the all-five-strict first-paint
 * gate, the per-collection refetch coalesce, the capped-backoff
 * reconnect, the steady-poll backstop, and (load-bearing) reads
 * subagent_invocations through `state.rows` so re-entrant sub-agents
 * sharing one `job_id` all reach `computeReadiness`.
 *
 * Empty-section policy: an empty epics collection renders as NOTHING
 * (no placeholder text) — the frame is just the `---` lead.
 *
 * Filters: this view uses the SERVER defaults for the epics collection —
 * `status = 'open' AND approval != 'approved'`. That's the common-case
 * "board" view; for explicit filters drop down to a custom subscribe client.
 *
 * Sidecar / SIGINT semantics: THREE indexed sidecar files per frame
 * (state JSON + frame text + per-frame unified diff against the previous
 * emit) plus a session meta file at /tmp/keeper-board.<pid>.meta.txt.
 * The diff is `diff -u prev current` via the system tool —
 * universally-readable unified-diff format; the first frame writes a
 * sentinel since there's no prior to diff. SIGINT calls the shell's
 * `dispose()` (restores the terminal), then the helper's `dispose()`
 * (drops every subscription via a bare `unsubscribe`), logs the session
 * sidecar paths, and exits.
 *
 * Usage:
 *   keeper board [--sock <path>]
 *
 *   --sock <path>    Socket path override (else $KEEPER_SOCK, else the
 *                    ~/.local/state/keeper/keeperd.sock default).
 *   --help           Show this help.
 *
 * fn-646.4 cutover: moved from `scripts/board.ts` to `cli/board.ts`.
 * The `main(argv: string[])` signature lets the `cli/keeper.ts`
 * dispatcher pass through subcommand argv directly; the `import.meta.main`
 * guard is neutralized — the dispatcher is the canonical entry. The
 * exported `colorizePillsInLine`, `projectRows`, `renderJobLinkLines`,
 * `renderEpicDepPills`, `renderDeadLetterPill`, `epicNumFromIdOrBare`,
 * `renderEpicDepPillsFromProjection`, and `sendReplayDeadLetterRpc`
 * survive the move so `test/board.test.ts` continues to assert against
 * them — `renderDeadLetterPill` + `sendReplayDeadLetterRpc` survive
 * as re-exports even though board no longer renders the banner (jobs
 * owns it). Embedded SGR codes (`colorizePillsInLine`'s output) are
 * parsed into OpenTUI `StyledText` at paint time by
 * `src/ansi-to-styled.ts` — the live shell calls the shim on any line
 * containing `\x1b`. Sidecars stay PLAIN (the colorizer is only run on
 * `pushFrame` lines, not on sidecar / stdout writes); the non-TTY plain
 * path emits uncolored.
 */

import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  apiErrorPillSeg,
  inputRequestPillSeg,
  planVerbLabel,
  subagentLinesFor,
} from "../src/board-render";
import { resolveSockPath } from "../src/db";
import type { EpicDepResolution } from "../src/epic-deps";
import { formatPill, type Verdict } from "../src/readiness";
import {
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import { appendDiagnostic } from "../src/readiness-diagnostics";
import type {
  Epic,
  JobLinkEntry,
  ResolvedEpicDep,
  SubagentInvocation,
} from "../src/types";
import { createViewShell } from "../src/view-shell";

// ---------------------------------------------------------------------------
// Re-export shims (fn-658.1)
// ---------------------------------------------------------------------------
//
// `test/board.test.ts` and `scripts/drain-dead-letters.ts` already import
// the symbols below directly from `../cli/board`. The fn-658.1 extraction
// moved their definitions to `src/board-render.ts`; these shims keep the
// existing import paths resolving without forcing a rename at every call
// site. Mirrors the existing `export { projectRows } from
// "../src/readiness-client"` precedent further down. New code should
// import from `src/board-render` directly.
export {
  colorizePillsInLine,
  type ReplayDeadLetterRpcResult,
  renderDeadLetterPill,
  sendReplayDeadLetterRpc,
} from "../src/board-render";

const HELP = `keeper board — epics-only UI over the keeper subscribe server

Usage: keeper board [--sock <path>]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --help           Show this help

Real TUI mode (alt-screen + keyboard nav) when stdout is a TTY. Keys:
  ←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
  c copy current frame + sidecar paths to clipboard,
  q/Ctrl-C quit.
  Per-frame sidecars are indexed; lifecycle + warn output
  is appended to /tmp/keeper-board.<pid>.lifecycle.txt. Session paths
  print on exit.

The bottom jobs list and the dead-letter banner (with the 'r' replay
key) live in 'keeper jobs' (fn-658.3 split them out of board).

Renders one block per epic; the frame is just the '---' lead when no
epics match the default scope.

Each epic block opens with a header line of the form:

  ({dir}) {epic_number} {title} [name#dep,name#dep] [validated|unvalidated] [slotted-after-closer]? [<readiness>]

(a [blocked:<reason>] readiness pill drops to its own indented line beneath
the header instead of stamping at the end; ready/completed/running stay inline)

The cross-epic dependency pills carry the dep's project-name prefix
(e.g. [arthack#633]) so deps that cross topics/projects read unambiguously;
the bare task-dep pills below stay [#n] (same-epic, no prefix needed).

The optional [slotted-after-closer] pill (schema v29) appears only on epics
whose projection carries a non-null created_by_closer_of — i.e. epics minted
by another epic's closer session. Its presence is also what slots the epic
directly below its parent in the default sort (sort_path ASC).

followed (when the epic carries job_links) by one indented creator/refiner
line per linked session —
'{title} [creator|refiner] [state] [failed:<kind>]?' with an optional
[awaiting:<kind>] pill dropped onto its own indented continuation line
beneath the row
(title falls back to {job_id} when the embedded title is null; the
[failed:<kind>] pill appears when the session's last Claude API request
failed at a terminal HTTP boundary and the human hasn't picked up since —
the six rendered kinds are rate_limit | authentication_failed |
billing_error | server_error | invalid_request | unknown, and anything
outside the allow-list folds to 'unknown'; the recoverable
max_output_tokens kind is excluded by design; the [awaiting:<kind>] pill
appears when the session is stopped on an interactive built-in tool that
fires no hook of its own — currently just AskUserQuestion, rendered as
[awaiting:ask_user_question] in warn/yellow via the awaiting:* prefix
fallback, future-extensible to any other built-in interactive tool that
surfaces a question without a hook; the [state]/[failed:<kind>] pills
stay inline while [awaiting:<kind>] drops to its own continuation line
below the row). Schema v25 denormalized title / state /
last_api_error_at / last_api_error_kind / last_input_request_at /
last_input_request_kind off the linked jobs row at the reducer's write
boundary, so the same line shape renders for live, terminal, and
off-page sessions — no live-jobs join, no off-page fallback branch — then the task lines
(one per embedded task,
'{n}. {title} [#dep,#dep] [runtime_status] [worker_phase] [approval]' —
the three native pills side-by-side: planctl runtime status
'todo|in_progress|done|blocked', derived worker-phase binary 'open|done',
and approval 'approved|rejected|pending'), and a final "Quality audit and
close" line for the epic itself. The [validated] / [unvalidated] pill
reflects planctl's last_validated_at timestamp on the epic file — flipped
by 'planctl validate --epic <id>'.

Sub-agent invocations nest under their owning job row as one indented
line each — '{subagent_type}{annotations}: {description} [<status>]' —
where <status> is the raw 5-value projection enum
'running|ok|failed|unknown|superseded'. 'superseded' is rendered verbatim
(no hiding) so the audit trail of re-entrant attempts stays visible.

Same-name invocations within one job COLLAPSE on the client to a single
line representing the most recent (max turn_seq) row; the {annotations}
block is a parenthesized comma-joined annotation that appears only when
there's something to say: '(×N)' when the group folded N rows, and/or
'(N stuck)' when one or more non-surviving rows are still status='running'
(orphans whose matching SubagentStop never landed). The same collapse
applies to the readiness handoff (predicate 6 sees one logical agent
per (job_id, subagent_type) pair) so an orphaned 'running' row no longer
false-blocks downstream rows. The full uncollapsed audit trail is still
in sqlite — only the client view collapses.

The [<readiness>] pill is one of [ready], [completed], or
[blocked:<reason>] — a pure-function verdict computed by src/readiness.ts
from the (epics, jobs, subagent_invocations) snapshot. For tasks and the
close row a [ready] / [completed] / [running:<kind>] pill stamps inline on
the indented "[<id>]" reference line beneath the header; a [blocked:<reason>]
pill instead drops to its OWN line directly beneath the id line (so the
full reason — including any "dep-on-task <upstream>" id — reads without
wrapping). The epic header (which has no id line) follows the same split:
ready/completed/running stamp at the end of the header itself, while a
[blocked:<reason>] pill drops to its own indented line beneath it.

When a task's target_repo diverges from its epic's project_dir, the id
line carries one extra trailing pill '[task-repo:<basename>]' (yellow /
warn bucket via the colorizer's 'task-repo:*' prefix fallback) so the
unusual cross-repo routing surfaces visibly next to the verdict that
references it (the same divergence drives which root the per-root mutex
locks; see effectiveRoot in src/readiness.ts). The close row has no
per-row target_repo override, so the divergence pill never appears on
the "Quality audit and close" line. The per-root mutex still keys the
close row to the epic's project_dir, but the pass-1 claim is SCOPED
(fn-655): the close row only locks project_dir when at least one
epic-level running source is live (planner-running, an epic-level
close-verb job, or an epic-level sub-agent). A close row whose running
state is purely inherited from a task-level worker in a different
target_repo does NOT claim project_dir — the contributing task already
holds its own correct root via its target_repo. See
applySingleTaskPerRootMutex in src/readiness.ts for the full rule.

The first frame waits until ALL FIVE readiness collections have landed their
first result, so first paint is never half-empty AND the readiness pill is
never computed against a partial snapshot. An empty epics collection renders
as NOTHING (no placeholder text); the frame is just the '---' lead. The page
is refetched on every change signal and on a steady poll; a new frame prints
only when the rendered output changes. All five subscriptions ride one
connection; an epics-only change refetches only epics.
Every emitted frame is mirrored to three indexed /tmp sidecar files
(state JSON + frame text + unified diff vs. the previous emit); a session
meta file at /tmp/keeper-board.<pid>.meta.txt accumulates the index.
Connection-lifecycle events are appended to the lifecycle sidecar.
Session sidecar paths print on exit (Ctrl-C).

This view uses the SERVER defaults for the epics collection
(open + not-yet-approved). For explicit per-collection filters write a small
custom subscribe client against src/protocol.ts.
`;

/**
 * Re-export `projectRows` from the helper so `test/board.test.ts` (and any
 * external consumers) can keep importing `projectRows` from the board entry.
 * The helper module is the canonical home; this re-export is a stability
 * shim. New code should import from `src/readiness-client` directly.
 */
export { projectRows } from "../src/readiness-client";

/** Approval enum vocabulary, mirrored from `src/plan-worker.ts:Approval`. */
const APPROVAL_VALUES = new Set(["approved", "rejected", "pending"]);

function approvalPill(v: unknown): string {
  if (typeof v === "string" && APPROVAL_VALUES.has(v)) {
    return v;
  }
  return "pending";
}

/**
 * Map the epic's `last_validated_at` to a `[validated]` / `[unvalidated]`
 * pill — mirrors `approvalPill`'s shape. The producer-side `asString`
 * (`src/plan-worker.ts`) already collapses empty-string / non-string values
 * to `null`, so the predicate is simply `v != null`. The pill string is
 * fixed (not the raw timestamp); a future task may add a sortable mode if
 * a use case appears.
 */
function validatedPill(v: unknown): "validated" | "unvalidated" {
  return v != null ? "validated" : "unvalidated";
}

/**
 * Render the optional `[task-repo:<basename>]` pill segment when a task's
 * `target_repo` diverges from its epic's `project_dir`. Divergence is
 * unusual — a task whose worker runs in a sibling repo from where the
 * epic was authored. Visible as a yellow/warn pill via the
 * colorizer's `task-repo:*` prefix fallback so the eye picks the
 * divergent row out at a glance (this is the same predicate the
 * per-root mutex uses to decide which root claims a task — see
 * `effectiveRoot` in `src/readiness.ts`).
 *
 * The close row uses `epic.project_dir` directly with no per-row
 * `target_repo`, so divergence isn't representable there — the helper
 * is only called from the task arm of `renderEpicBlock`.
 *
 * Empty / null `target_repo` is the "no override" case (the task runs
 * in the epic's project_dir); we return `""` so the caller can append
 * unconditionally. Same null+empty fallthrough as `effectiveRoot`
 * so the pill never lies about which root the row actually occupies.
 */
function taskRepoPillSeg(taskRepo: unknown, epicProjectDir: unknown): string {
  if (taskRepo == null) {
    return "";
  }
  const tr = String(taskRepo);
  if (tr === "") {
    return "";
  }
  const epicDir = epicProjectDir == null ? "" : String(epicProjectDir);
  if (tr === epicDir) {
    return "";
  }
  return ` [task-repo:${basename(tr)}]`;
}

/**
 * Cross-epic dependency reference label — `<name>#<number>` (e.g.
 * `arthack#633`) extracted from a dep epic id like
 * `arthack-633-git-per-session-file-attribution`. The project-name prefix
 * disambiguates deps that cross topics/projects, so the header pill reads
 * `[arthack#633]` rather than the bare `[#633]`. Returns `null` when the id
 * doesn't match the `<name>-<number>-<slug>` shape (caller drops it).
 */
function epicDepRefFromId(id: string): string | null {
  const m = /^([a-z]+)-(\d+)-/.exec(id);
  return m ? `${m[1]}#${m[2]}` : null;
}

/**
 * Parallel to {@link epicDepRefFromId} for the bare-id form (`fn-N`, no
 * trailing slug). Returns the bare epic number when the id matches; else
 * `null`. The board's `[#N,#M]` summary pill on the epic header uses
 * this alongside `epicDepRefFromId` so both id shapes render correctly
 * — full ids carry the `<project>#<N>` cross-project prefix when present,
 * bare ids render as a bare `#N` (intra-project by definition of the
 * resolver's fn-N-then-cwd-then-global match path).
 */
export function epicNumFromIdOrBare(id: string): number | null {
  // Full id: `<name>-<num>-<slug>` — first numeric segment after the
  // project prefix. Bare id: `fn-<num>` exact.
  const full = /^[a-z]+-(\d+)-/.exec(id);
  if (full !== null) {
    return Number.parseInt(full[1] ?? "", 10);
  }
  const bare = /^fn-(\d+)$/.exec(id);
  if (bare !== null) {
    return Number.parseInt(bare[1] ?? "", 10);
  }
  return null;
}

/**
 * fn-636: pill assembly for one epic's `depends_on_epics` list. Lifted out
 * of the `renderEpicBlock` closure so the three render shapes are directly
 * assertable from tests:
 *
 *   - dangling (resolver said `dangling`, id well-formed enough to extract
 *     a number) → `?#N`
 *   - intra-project (resolver returned `cross_project === null`) → `#N`
 *   - cross-project (resolver returned a non-null `cross_project`) →
 *     `<prefix>::#N`
 *
 * Malformed dangling ids (no extractable number) and found-but-numberless
 * upstreams are dropped, matching the closure's behavior verbatim. The
 * caller still drives `resolveEpicDep` directly so the diagnostics sink
 * stays under its control; this helper only assembles the rendered refs
 * from the dep string + its resolution.
 */
export function renderEpicDepPills(
  deps: ReadonlyArray<string>,
  resolve: (dep: string) => EpicDepResolution,
): string[] {
  const refs: string[] = [];
  for (const d of deps) {
    const depStr = String(d);
    const num = epicNumFromIdOrBare(depStr);
    const resolved = resolve(depStr);
    if (resolved.kind === "dangling") {
      if (num !== null) {
        refs.push(`?#${num}`);
      }
      continue;
    }
    const resolvedNum = resolved.epic.epic_number;
    if (typeof resolvedNum !== "number") {
      continue;
    }
    if (resolved.cross_project === null) {
      refs.push(`#${resolvedNum}`);
    } else {
      refs.push(`${resolved.cross_project}::#${resolvedNum}`);
    }
  }
  return refs;
}

/**
 * fn-637.4: projection-driven counterpart to {@link renderEpicDepPills}.
 * Reads the schema-v34 `resolved_epic_deps` array (the reducer's forward-
 * stamp output) and assembles the same three render shapes — `#N`,
 * `<project>::#N`, `?#N` — without invoking the resolver live. The board
 * pill and predicate 9 in `src/readiness.ts` consume the same projection,
 * so they cannot drift on what an entry resolves to.
 *
 * Per-entry render rules (identical surface to {@link renderEpicDepPills}):
 *   - `state === "dangling"` → `?#N` when `dep_token` parses to a number,
 *     dropped otherwise (the well-formed-but-numberless case maps to no
 *     pill, mirroring the legacy renderer).
 *   - `state === "satisfied" | "blocked-incomplete"` + `cross_project === false`
 *     → `#N` (intra-project; `epic_number` is non-null for resolved entries).
 *   - `state === "satisfied" | "blocked-incomplete"` + `cross_project === true`
 *     → `<project_basename>::#N` (cross-project prefix; basename is non-null
 *     for resolved entries).
 *
 * A resolved entry whose `epic_number` is somehow null (defensive: should
 * not happen given the reducer's invariants) is dropped, matching the
 * legacy behavior bit-for-bit.
 */
export function renderEpicDepPillsFromProjection(
  deps: ReadonlyArray<ResolvedEpicDep>,
): string[] {
  const refs: string[] = [];
  for (const dep of deps) {
    if (dep.state === "dangling") {
      const num = epicNumFromIdOrBare(dep.dep_token);
      if (num !== null) {
        refs.push(`?#${num}`);
      }
      continue;
    }
    const resolvedNum = dep.epic_number;
    if (typeof resolvedNum !== "number") {
      continue;
    }
    if (!dep.cross_project) {
      refs.push(`#${resolvedNum}`);
    } else {
      // `cross_project === true` implies a non-null `project_basename` (the
      // reducer's `enrichEpicDep` only sets the boolean when basenames
      // differ — both non-empty by construction). Guard once and drop the
      // pill on the impossible-null fallback to keep the renderer total.
      const basename = dep.project_basename;
      if (basename === null) {
        continue;
      }
      refs.push(`${basename}::#${resolvedNum}`);
    }
  }
  return refs;
}

function taskNumFromId(id: string): number | null {
  const m = /\.(\d+)$/.exec(id);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Per-epic creator/refiner link lines, indented one level under the epic
 * header. Each {@link JobLinkEntry} carries eight embedded fields
 * `{kind, job_id, title, state, last_api_error_at, last_api_error_kind,
 * last_input_request_at, last_input_request_kind}` denormalized off the
 * linked `jobs` row at the reducer's write boundary (schema v25), so
 * the render reads every field straight off the projection — no
 * live-jobs join, no off-page fallback branch.
 *
 * The line shape is the same regardless of whether the linked session
 * is live, terminal, or off-page:
 *
 *     {title ?? job_id} [{kind}] [{state}]{apiErrorPillSeg}
 *       [awaiting:<kind>]   ← only when present, own continuation line
 *
 * Title falls back to `job_id` when the embedded `title` is null —
 * preserves the line shape when title is genuinely unknown (e.g. a
 * shell-inserted epic whose linked session has no captured title yet)
 * without dropping the readable label entirely.
 *
 * `[state]` and `[failed:<kind>]?` stay inline on the row; the optional
 * `[awaiting:<kind>]` pill drops to its own indented continuation line
 * beneath the row so a long interactive stop reads without wrapping.
 *
 * Iteration order is the projection's own `(kind, job_id)` ASC sort
 * (set by `sortJobLinks` in `src/reducer.ts`).
 *
 * Module-level + exported so `test/board.test.ts` can assert the line
 * shape directly without standing up the full subscribe loop.
 */
export function renderJobLinkLines(jobLinks: unknown): string[] {
  if (!Array.isArray(jobLinks) || jobLinks.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const link of jobLinks as JobLinkEntry[]) {
    const label = link.title ?? link.job_id;
    const state = link.state == null ? "" : String(link.state);
    const awaiting = inputRequestPillSeg(
      link.last_input_request_at,
      link.last_input_request_kind,
    );
    out.push(
      `  ${label} [${link.kind}] [${state}]${apiErrorPillSeg(link.last_api_error_at, link.last_api_error_kind)}`,
    );
    // The [awaiting:<kind>] pill drops to its own continuation line (one
    // indent level deeper) so a long-running interactive stop reads
    // without wrapping; [state]/[failed:<kind>] stay inline above.
    if (awaiting !== "") {
      out.push(`    ${awaiting.trimStart()}`);
    }
  }
  return out;
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      sock: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = values.sock ?? resolveSockPath();
  // fn-635: readiness diagnostics JSONL log. Siblings the sock + dispatch
  // log in the same state directory (`~/.local/state/keeper/`). Two
  // processes (board.ts + autopilot.ts) can append concurrently; POSIX
  // O_APPEND under PIPE_BUF gives the atomicity guarantee, no flock.
  const diagnosticsLogPath = join(
    dirname(sockPath),
    "readiness-diagnostics.jsonl",
  );
  const seg = (v: unknown) => (v == null ? "" : String(v));

  // --- epic rendering ---

  // `subagentLinesFor` is a pure module function in `src/board-render.ts`
  // (fn-658.1) — shared with the forthcoming `cli/jobs.ts` view. The
  // closure version that previously lived here closed over `seg`; the
  // moved version inlines the trivial `v == null ? "" : String(v)` for
  // the one call site. `renderJobLinkLines` likewise lives at module
  // scope (exported) so `test/board.test.ts` can assert the line shape
  // without standing up the full subscribe loop.

  function renderJobLines(
    subagentIndex: Map<string, SubagentInvocation[]>,
    jobsArr: unknown,
  ): string[] {
    if (!Array.isArray(jobsArr) || jobsArr.length === 0) {
      return [];
    }
    const out: string[] = [];
    for (const j of jobsArr) {
      const job = j as Record<string, unknown>;
      const awaiting = inputRequestPillSeg(
        job.last_input_request_at,
        job.last_input_request_kind,
      );
      out.push(
        `    ${seg(job.title)} [${planVerbLabel(job.plan_verb) ?? ""}] [${seg(job.state)}]${apiErrorPillSeg(job.last_api_error_at, job.last_api_error_kind)}`,
      );
      // [awaiting:<kind>] on its own continuation line (six-space indent —
      // same depth as this row's sub-agent lines below).
      if (awaiting !== "") {
        out.push(`      ${awaiting.trimStart()}`);
      }
      out.push(
        ...subagentLinesFor(subagentIndex, String(job.job_id), "      "),
      );
    }
    return out;
  }

  /**
   * Look up a verdict by id from the readiness map. A renderer-side lookup
   * miss (verdict map doesn't have the id) yields the defensive
   * `[blocked:unknown]` pill — visible bug indicator, inert for autopilot
   * dispatch.
   */
  function verdictFromMap(
    map: Map<string, Verdict> | undefined,
    id: string,
  ): Verdict {
    if (map === undefined) {
      return { tag: "blocked", reason: { kind: "unknown" } };
    }
    return map.get(id) ?? { tag: "blocked", reason: { kind: "unknown" } };
  }

  function renderEpicBlock(
    snap: ReadinessClientSnapshot,
    subagentIndex: Map<string, SubagentInvocation[]>,
    epicIds: Set<string>,
    row: Record<string, unknown>,
  ): string {
    const dir =
      row.project_dir == null ? "" : basename(String(row.project_dir));
    const dirSeg = dir === "" ? "" : `(${dir}) `;
    const epicDeps = Array.isArray(row.depends_on_epics)
      ? row.depends_on_epics
      : [];
    // fn-637.4: summary pill reads `row.resolved_epic_deps` — the schema-v34
    // projection maintained by the reducer's forward-stamp + reverse fan-out.
    // The board pill and predicate 9 share the same source of truth, so they
    // cannot drift. Three render shapes (identical to the pre-cutover live
    // resolver branches):
    //   - `satisfied` / `blocked-incomplete` + `cross_project === false` →
    //     `[#N]` intra-project
    //   - `satisfied` / `blocked-incomplete` + `cross_project === true` →
    //     `[<project_basename>::#N]` cross-project
    //   - `dangling` → `[?#N]` when the raw `dep_token` parses to a
    //     number, dropped when it doesn't.
    // The fn-637 `completedEpics` merge / resolver-only subscription is gone
    // — completed upstreams already resolved into `state === "satisfied"`
    // entries at fold time when the consumer's row was last stamped.
    const resolvedDeps = Array.isArray(row.resolved_epic_deps)
      ? (row.resolved_epic_deps as ResolvedEpicDep[])
      : [];
    let epicDepRefs: string[];
    if (resolvedDeps.length > 0) {
      epicDepRefs = renderEpicDepPillsFromProjection(resolvedDeps);
    } else {
      // No projection entries (either `depends_on_epics` is empty, or the
      // row landed before the schema-v34 reducer stamped it — `null`
      // sentinel). Fall back to the legacy `<name>#<number>` render off
      // the raw `depends_on_epics` array so the line stays informative
      // during the migration window.
      epicDepRefs = [];
      for (const d of epicDeps) {
        const legacy = epicDepRefFromId(String(d));
        if (legacy !== null) {
          epicDepRefs.push(legacy);
        }
      }
    }
    const epicDepsSeg =
      epicDepRefs.length === 0 ? "" : ` [${epicDepRefs.join(",")}]`;
    // `epicIds` is no longer used for filtering (resolver path handles
    // every dep shape including ambiguous bare-ids); kept in the
    // signature for API stability while the helper is in flux. Silence
    // the lint by reading once.
    void epicIds;
    const epicId = seg(row.epic_id);
    const epicApproval = approvalPill(row.approval);
    const lines: string[] = [];
    const epicVerdict = verdictFromMap(snap.readiness.perEpic, epicId);
    // Schema v29: `[slotted-after-closer]` pill — appears only when the
    // epic was minted by another epic's closer session (the projection's
    // `created_by_closer_of` is non-null). Placed after `[validated|
    // unvalidated]` and before the readiness pill (mirrors the
    // `epicDepsSeg` shape: empty string when absent, leading space when
    // present so the join reads cleanly).
    const slottedSeg =
      row.created_by_closer_of == null ? "" : " [slotted-after-closer]";
    // Same rule as the task/close rows: a [blocked:<reason>] verdict drops
    // to its own line (two-space indent) beneath the header; ready/
    // completed/running stay inline at the end of the header itself.
    const epicHeader = `${dirSeg}${seg(row.epic_number)} ${seg(row.title)}${epicDepsSeg} [${validatedPill(row.last_validated_at)}]${slottedSeg}`;
    const epicHeaderLines =
      epicVerdict.tag === "blocked"
        ? [epicHeader, `  ${formatPill(epicVerdict)}`]
        : [`${epicHeader} ${formatPill(epicVerdict)}`];
    lines.push(...epicHeaderLines, ...renderJobLinkLines(row.job_links));
    const tasks = Array.isArray(row.tasks) ? row.tasks : [];
    for (const task of tasks) {
      const t = task as Record<string, unknown>;
      const tdeps = Array.isArray(t.depends_on) ? t.depends_on : [];
      const tnums = tdeps
        .map((d) => taskNumFromId(String(d)))
        .filter((n): n is number => n != null);
      const taskDepsSeg =
        tnums.length === 0 ? "" : ` [${tnums.map((n) => `#${n}`).join(",")}]`;
      const taskApproval = approvalPill(t.approval);
      const taskId = seg(t.task_id);
      const taskVerdict = verdictFromMap(snap.readiness.perTask, taskId);
      // A [blocked:<reason>] verdict drops to its own line beneath the
      // [id] reference; ready/completed/running pills stay inline on the id
      // line. The `[task-repo:<basename>]` divergence pill follows the
      // verdict wherever it lands (it "surfaces next to the verdict that
      // references it" — see `taskRepoPillSeg`).
      const taskPillSeg = `${formatPill(taskVerdict)}${taskRepoPillSeg(t.target_repo, row.project_dir)}`;
      const taskIdLines =
        taskVerdict.tag === "blocked"
          ? [`    [${taskId}]`, `    ${taskPillSeg}`]
          : [`    [${taskId}] ${taskPillSeg}`];
      lines.push(
        // Schema v19: task elements now carry both `runtime_status` (the
        // planctl-native enum `todo|in_progress|done|blocked`) and
        // `worker_phase` (the derived worker-phase binary `open|done`).
        // Render both pills side-by-side with `[approval]` so the row
        // surfaces the full native vocabulary — no client-side collapse.
        `  ${seg(t.task_number)}. ${seg(t.title)}${taskDepsSeg} [${seg(t.runtime_status)}] [${seg(t.worker_phase)}] [${taskApproval}]`,
        ...taskIdLines,
        ...renderJobLines(subagentIndex, t.jobs),
      );
    }
    const closeVerdict = verdictFromMap(snap.readiness.perCloseRow, epicId);
    // Same rule as the task arm: a [blocked:<reason>] verdict drops to its
    // own line beneath the [id]; ready/completed/running stay inline.
    const closeIdLines =
      closeVerdict.tag === "blocked"
        ? [`    [${epicId}]`, `    ${formatPill(closeVerdict)}`]
        : [`    [${epicId}] ${formatPill(closeVerdict)}`];
    lines.push(
      `  X. Quality audit and close [${seg(row.status)}] [${epicApproval}]`,
      ...closeIdLines,
      ...renderJobLines(subagentIndex, row.jobs),
    );
    return lines.join("\n");
  }

  function renderEpicsBody(
    snap: ReadinessClientSnapshot,
    subagentIndex: Map<string, SubagentInvocation[]>,
  ): string {
    if (snap.epics.length === 0) {
      return "";
    }
    const epicIds = new Set(snap.epics.map((e) => String(e.epic_id)));
    // fn-637.4: the `epicById` + `epicsByNumber` resolver indexes and the
    // completed-epics merge are gone. The summary pill reads each row's
    // `resolved_epic_deps` projection directly (see `renderEpicBlock`), so
    // the renderer doesn't need a cross-epic lookup index anymore.
    const epicsList = snap.epics as Epic[];
    return epicsList
      .map((e) =>
        renderEpicBlock(
          snap,
          subagentIndex,
          epicIds,
          e as unknown as Record<string, unknown>,
        ),
      )
      .join("\n");
  }

  /**
   * Epics-only frame body. Returns one element per output line so the
   * live-shell can consume lines (per-line ANSI diff). The caller joins
   * with `\n` for stdout / sidecar / byte-compare. The bottom jobs list
   * lives in `cli/jobs.ts` (fn-658.3).
   */
  function renderBody(
    snap: ReadinessClientSnapshot,
    subagentIndex: Map<string, SubagentInvocation[]>,
  ): string[] {
    const body = renderEpicsBody(snap, subagentIndex);
    return body === "" ? [] : body.split("\n");
  }

  // fn-660.1: lifecycle + sidecars + copy key + SIGINT moved into
  // `createViewShell` — see `src/view-shell.ts`. Board's only sibling-
  // specific bits are the renderer, the `subscribeReadiness` wiring,
  // and the diagnostics drain (snap-side, never on the body-stable
  // suppression path so every observed ambiguity gets recorded).
  const view = createViewShell<ReadinessClientSnapshot>({
    script: "board",
    title: "board",
    renderBody: (snap) => {
      // Per-frame `job_id → invocations` index — re-entrant sub-agents
      // within one session sit on the same bucket, ordered by
      // `turn_seq asc` so the nested list reads in invocation order.
      // The projection promotes `superseded` natively (task fn-605.2),
      // so no client-side marking pass is required — `subagentLinesFor`
      // stamps the raw `[${status}]` enum verbatim.
      const subagentIndex = new Map<string, SubagentInvocation[]>();
      for (const inv of snap.subagentInvocations) {
        const arr = subagentIndex.get(inv.job_id);
        if (arr === undefined) {
          subagentIndex.set(inv.job_id, [inv]);
        } else {
          arr.push(inv);
        }
      }
      for (const arr of subagentIndex.values()) {
        arr.sort((a, b) => a.turn_seq - b.turn_seq);
      }
      return {
        bodyLines: renderBody(snap, subagentIndex),
        stateJson: { epics: snap.epics },
      };
    },
  });

  function emitFrame(snap: ReadinessClientSnapshot): void {
    // fn-635: drain `snap.readiness.diagnostics` to the JSONL log
    // before the render. The drain is per-snapshot, not per-emit (we
    // want every observed ambiguity recorded even if the render is
    // byte-stable and the view-shell's `lastBody` short-circuits).
    // Best-effort append — `appendDiagnostic` swallows I/O errors so
    // a transient FS hiccup doesn't wedge the frame loop.
    for (const d of snap.readiness.diagnostics) {
      appendDiagnostic(d, diagnosticsLogPath);
    }
    view.emit(snap);
  }

  const handle = subscribeReadiness({
    sockPath,
    idPrefix: "board",
    onSnapshot: emitFrame,
    onLifecycle: view.emitLifecycle,
  });

  view.installSigintHandler(() => handle.dispose());
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the
// canonical entry. Direct invocation via `bun cli/board.ts` would
// bypass the dispatcher's arg-pruning; if you really need it, run
// `bun cli/keeper.ts board <args>` instead.
