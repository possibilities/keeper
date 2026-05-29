#!/usr/bin/env bun
/**
 * keeper-board — a combined "UI" over the read-only NDJSON-over-UDS subscribe
 * server (`src/server-worker.ts`) that streams the epics + jobs +
 * subagent_invocations collections as one frame per change: each frame is
 * the epics body + a `~~~` divider line + the jobs body, both refreshed
 * under the same poll/connect lifecycle so they always show the same
 * wall-clock snapshot of the daemon. `subagent_invocations` rows feed the
 * readiness pill AND nest as indented `[<status>]` lines under the
 * matching job row (in both the embedded-in-epic context and the bottom
 * jobs list), stamping the raw 5-value projection enum
 * `running|ok|failed|unknown|superseded` verbatim — `superseded` is
 * promoted natively by the projection (task fn-605.2). Same-name
 * invocations within one job ADDITIONALLY collapse on the client to a
 * single line representing the most-recent (max turn_seq) row via
 * `collapseSubagentsByName` in `src/readiness-client.ts` — a `(×N)`
 * multiplier and an optional `N stuck` orphan indicator surface the
 * collapsed count and any non-surviving `running` rows. The same
 * collapse feeds readiness, so an orphan `running` row whose matching
 * `SubagentStop` never landed no longer false-blocks predicate 6. Full
 * uncollapsed audit trail stays in sqlite.
 *
 * Frame shape:
 *
 *   {epics body}     ← one block per epic, see `renderEpicBlock` below
 *   ~~~
 *   {jobs body}      ← one row per job, see `projectJobRow` below
 *
 * The jobs body itself is split into two stacked sub-lists separated by a
 * `~~~` line: jobs with NO `plan_verb` (ambient / ad-hoc sessions) on top,
 * jobs WITH a `plan_verb` (planner/worker/closer — epic/task-bound work) on
 * the bottom. So a fully-populated frame can carry TWO `~~~` lines — one
 * between epics and jobs, one inside the jobs section. The empty-side drop
 * rule (below) applies at both levels.
 *
 * Connection / poll / coalesce / first-paint lifecycle is owned by
 * `subscribeReadiness` in `src/readiness-client.ts`. The board is the
 * RENDERER: it owns the sidecar writes, the per-frame `job_id →
 * SubagentInvocation[]` index used to nest sub-agent lines under jobs,
 * the `lastBody` byte-compare that suppresses no-op frames, and the
 * stdout emit. The helper handles the all-three-strict first-paint
 * gate, the per-collection refetch coalesce, the capped-backoff
 * reconnect, the steady-poll backstop, and (load-bearing) reads
 * subagent_invocations through `state.rows` so re-entrant sub-agents
 * sharing one `job_id` all reach `computeReadiness`.
 *
 * Empty-section policy: an empty collection renders as NOTHING (no
 * placeholder text). The `~~~` divider is dropped when either side is
 * empty, so a single populated section reads as a clean block under the
 * `---` lead, and a frame with both sides empty is just the lead. The
 * same rule applies to the jobs section's internal split: if one of the
 * two job partitions is empty, the inner `~~~` is dropped and the
 * populated partition reads as a single flat list.
 *
 * Filters: this view uses the SERVER defaults for both collections — epics:
 * `status = 'open' AND approval != 'approved'`; jobs: live only
 * (`working + stopped`, terminal states hidden). That's the common-case
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
 *   bun scripts/board.ts [--sock <path>]
 *
 *   --sock <path>    Socket path override (else $KEEPER_SOCK, else the
 *                    ~/.local/state/keeper/keeperd.sock default).
 *   --help           Show this help.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { buildDebugSnapshot, copyToClipboard } from "../src/clipboard-debug";
import { resolveSockPath } from "../src/db";
import type { EpicDepResolution } from "../src/epic-deps";
import { createLiveShell } from "../src/live-shell";
import {
  type ClientFrame,
  encodeFrame,
  LineBuffer,
  type ServerFrame,
} from "../src/protocol";
import { formatPill, type Verdict } from "../src/readiness";
import {
  collapseSubagentsByName,
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

const HELP = `keeper-board — combined epics + jobs UI over the keeper subscribe server

Usage: bun scripts/board.ts [--sock <path>]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --help           Show this help

Real TUI mode (alt-screen + keyboard nav) when stdout is a TTY. Keys:
  ←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
  c copy current frame + sidecar paths to clipboard,
  r replay one oldest waiting dead-letter (recovers a dropped hook event),
  q/Ctrl-C quit.
  Per-frame sidecars are indexed; lifecycle + warn output
  is appended to /tmp/keeper-board.<pid>.lifecycle.txt. Session paths
  print on exit.

Renders both views as one frame per change:

  {epics body}      (one block per epic, see epic-header format below)
  ~~~
  {jobs body}       (one row per job: {basename(cwd)} {title} [role] [state])

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
locks; see effectiveRoot in src/readiness.ts). The close row uses the
epic's project_dir directly (no per-row override), so the pill never
appears on the "Quality audit and close" line.

The jobs body is itself split into two stacked sub-lists separated by a '~~~'
line: jobs with NO plan_verb (ambient sessions) on top, jobs WITH a plan_verb
(planner/worker/closer — epic-bound work) on the bottom. A fully-populated
frame can therefore show two '~~~' lines (one between epics and jobs, one
inside the jobs section).

The first frame waits until ALL THREE collections have landed their first
result, so first paint is never half-empty AND the readiness pill is never
computed against a partial snapshot. An empty section renders as NOTHING
(no placeholder text); the ~~~ divider is dropped when either side is
empty (this applies to the inner jobs split too). The page is refetched on
every change signal and on a steady poll; a new frame prints only when the
combined rendered output changes. All three subscriptions ride one
connection; an epics-only change refetches only epics (and vice versa).
Every emitted frame is mirrored to three indexed /tmp sidecar files
(state JSON + frame text + unified diff vs. the previous emit); a session
meta file at /tmp/keeper-board.<pid>.meta.txt accumulates the index.
Connection-lifecycle events are appended to the lifecycle sidecar.
Session sidecar paths print on exit (Ctrl-C).

This view uses the SERVER defaults for all three collections (epics: open +
not-yet-approved; jobs: live only; subagent_invocations: full per-job
timeline). For explicit per-collection filters write a small custom
subscribe client against src/protocol.ts.
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
 * Map a plan_verb to its noun-form role label for the `[{role}]` pill.
 * Returns `null` when the input is null (the caller drops the pill).
 */
const PLAN_VERB_LABELS: Record<string, string> = {
  plan: "planner",
  work: "worker",
  close: "closer",
};

function planVerbLabel(v: unknown): string | null {
  if (v == null) {
    return null;
  }
  const s = typeof v === "string" ? v : "";
  return PLAN_VERB_LABELS[s] ?? s;
}

/**
 * Render the optional `[failed:<kind>]` pill segment from the
 * `jobs.(last_api_error_at, last_api_error_kind)` pair (schema v24 — the
 * two-field signal that replaced the v17 single `rate_limited_at` slot).
 * The reducer stamps both columns together on the dual-case
 * `RateLimited` / `ApiError` fold and clears them together to
 * `(NULL, NULL)` on the next `UserPromptSubmit` revival (see
 * `src/reducer.ts`), so a non-null `at` means "this stoppage was
 * api-error-caused, the human hasn't picked up since".
 *
 * The kind is taken straight off `last_api_error_kind` — one of
 * `rate_limit | authentication_failed | billing_error | server_error |
 * invalid_request | unknown`. Anything outside that allow-list already
 * folded to `"unknown"` at the matcher / reducer boundary (see
 * `matchApiError` in `src/transcript-worker.ts`); the recoverable
 * `max_output_tokens` kind is excluded at the matcher and never lands
 * here.
 *
 * **Paired-NULL invariant.** The reducer guarantees `at` and `kind`
 * move together — both NULL or both non-NULL. The fallback to
 * `"unknown"` when `at` is non-null but `kind` happens to be null is
 * defensive only (should be unreachable); keeps the pill from
 * collapsing to `[failed:]` if a future shape-skew bug appears.
 *
 * Returns the leading `' '` so the caller can append unconditionally —
 * empty string when `at` is null, ` [failed:<kind>]` otherwise. The
 * underlying lifecycle pill (`[stopped]`) is rendered separately from
 * `jobs.state` and always shows first; this annotation stacks after it
 * and is colored red on a TTY via the colorizer's `failed:*` prefix
 * fallback to the `error` bucket.
 */
function apiErrorPillSeg(at: unknown, kind: unknown): string {
  if (at == null) {
    return "";
  }
  const k = typeof kind === "string" && kind.length > 0 ? kind : "unknown";
  return ` [failed:${k}]`;
}

/**
 * Render the optional `[awaiting:<kind>]` pill segment from the
 * `jobs.(last_input_request_at, last_input_request_kind)` pair (schema
 * v25 — the two-field signal cloned one-for-one off fn-616's
 * `apiErrorPillSeg` shape). The reducer stamps both columns together on
 * the `InputRequest` fold (a synthetic event minted by
 * `matchAskUserQuestion` in `src/transcript-worker.ts` when a real
 * assistant turn carries an `AskUserQuestion` tool_use) and clears them
 * together on the next `UserPromptSubmit` / `SessionStart` revival or
 * any `PreToolUse` / `PostToolUse` (the hot-path arms are gated on
 * `last_input_request_at IS NOT NULL`), so a non-null `at` means
 * "this stoppage is awaiting a human answer to an interactive
 * tool-use that fires no hook of its own."
 *
 * The kind is taken straight off `last_input_request_kind` — currently
 * the single-member union `ask_user_question`, future-extensible to
 * any built-in interactive tool that surfaces a question without a
 * hook (e.g. `ExitPlanMode`). No allow-list narrowing here; the kind
 * comes off the matcher / reducer boundary already and renders
 * verbatim.
 *
 * **Paired-NULL invariant.** The reducer guarantees `at` and `kind`
 * move together — both NULL or both non-NULL. The fallback to
 * `"unknown"` when `at` is non-null but `kind` happens to be null is
 * defensive only (should be unreachable); keeps the pill from
 * collapsing to `[awaiting:]` if a future shape-skew bug appears.
 *
 * Returns the leading `' '` so the segment is self-delimiting —
 * empty string when `at` is null, ` [awaiting:<kind>]` otherwise. Unlike
 * `[state]` / `[failed:<kind>]` (which stay inline on the row), every
 * caller drops THIS segment onto its own indented continuation line
 * beneath the row (`.trimStart()`-ed of the leading space) so a
 * long-running interactive stop reads without wrapping. Colored yellow
 * on a TTY via the colorizer's `awaiting:*` prefix fallback to the
 * `warn` bucket.
 */
function inputRequestPillSeg(at: unknown, kind: unknown): string {
  if (at == null) {
    return "";
  }
  const k = typeof kind === "string" && kind.length > 0 ? kind : "unknown";
  return ` [awaiting:${k}]`;
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

/**
 * ANSI SGR sequences for the pill palette. Five semantic buckets keyed off
 * exact pill strings (plus `blocked:*`, `failed:*`, and `awaiting:*`
 * prefix fallbacks) so the colorizer stays purely string-driven — no
 * structural knowledge of which column a pill came from. Standard
 * 16-color ANSI for cross-terminal portability.
 *
 * Bucket rationale:
 *   - active  (bright cyan): in motion right now, look here
 *   - success (green):       positive resolution
 *   - error   (red):         failure / needs intervention
 *   - warn    (yellow):      blocked / something is in the way
 *   - faded   (dim gray):    terminal + historical / recede
 *
 * Tokens NOT in this table render uncolored on purpose — once everything
 * else is colored, the eye picks `pending` / `todo` / `unvalidated` /
 * `unknown` / `open` and the role labels (`planner|worker|closer|creator|
 * refiner`) out by ABSENCE of color. Coloring them too is noise.
 *
 * Only the inner token gets the SGR; the brackets stay default so the
 * pill grid is still scannable.
 */
const SGR = {
  active: "\x1b[96m",
  success: "\x1b[32m",
  error: "\x1b[31m",
  warn: "\x1b[33m",
  faded: "\x1b[2;37m",
  reset: "\x1b[0m",
} as const;

type PillBucket = Exclude<keyof typeof SGR, "reset">;

const PILL_COLORS: Record<string, PillBucket> = {
  running: "active",
  in_progress: "active",
  working: "active",
  // Schema v29: the `[slotted-after-closer]` epic-header pill (rendered
  // when `epics.created_by_closer_of != null`). Active/cyan bucket — this
  // is "live, structural relationship visible to the human" rather than
  // a success/error/warn state. See `renderEpicBlock` for the placement.
  "slotted-after-closer": "active",
  ok: "success",
  approved: "success",
  validated: "success",
  ready: "success",
  done: "success",
  failed: "error",
  rejected: "error",
  killed: "error",
  // fn-635: a structurally-broken cross-project epic dep (full-id miss,
  // bare-id miss, or ambiguous bare-id with no same-project disambiguator)
  // renders red — distinct from the amber `[blocked]` family. The
  // colorizer's prefix branch below routes `blocked:dep-on-epic-dangling
  // <id>` to this bucket; the bare `[dep-on-epic-dangling]` token (e.g.
  // a future direct-pill render path) also lands here via exact match.
  "dep-on-epic-dangling": "error",
  blocked: "warn",
  completed: "faded",
  superseded: "faded",
  exited: "faded",
  stopped: "faded",
};

/**
 * Apply SGR coloring to bracketed pill tokens in a single rendered line.
 * Pure string→string: matches `[<token>]`, looks the inner token up in
 * `PILL_COLORS`, and falls back to the `warn` bucket for any `blocked:*`
 * payload (so `[blocked:dep-on-task fn-614.2]` colors the same as
 * `[blocked]`) AND to the `error` bucket for any `failed:*` payload (so
 * the six `[failed:<kind>]` api-error pills minted by `apiErrorPillSeg`
 * color the same as a bare `[failed]`) AND to the `warn` bucket for any
 * `awaiting:*` payload (so the `[awaiting:<kind>]` input-request pills
 * minted by `inputRequestPillSeg` — currently just
 * `[awaiting:ask_user_question]`, future-extensible to any built-in
 * interactive tool — color the same as a bare `[blocked]`) AND to the
 * `warn` bucket for any `task-repo:*` payload (so the
 * `[task-repo:<basename>]` divergence pill minted by `taskRepoPillSeg`
 * colors the same as `[blocked]`) AND to the `active` (cyan) bucket for
 * any `running:*` payload (so the `[running:<kind>]` motion pills minted
 * by `formatPill` for the four reasons split out of `BlockReason` —
 * `job-running`, `sub-agent-running`, `planner-running`, and (fn-638.4)
 * `sub-agent-stale` — color the same as a bare `[running]`, EXCEPT the
 * `running:sub-agent-stale` payload, which is routed to the `warn`
 * (yellow) bucket by a more-specific branch above the generic
 * `running:*` fallback so a possibly-stuck orphan sub-agent renders
 * distinctly from fresh in-flight work). Unknown tokens pass through
 * verbatim.
 *
 * Module-level + exported so `test/board.test.ts` can assert the coloring
 * contract without standing up the subscribe loop. Sidecars and the
 * byte-compare body stay plain — only the lines shipped to `pushFrame`
 * pass through this helper, gated on the TTY + NO_COLOR check in `main`.
 */
export function colorizePillsInLine(line: string): string {
  return line.replace(/\[([^\]]+)\]/g, (match, inner: string) => {
    let bucket = PILL_COLORS[inner];
    // fn-635: route `blocked:dep-on-epic-dangling <id>` to the `error`
    // bucket (red) — distinct from the amber `blocked:*` family. This
    // check MUST precede the generic `blocked:` → `warn` fallback below,
    // otherwise a dangling dep would render amber. The exact-match
    // `PILL_COLORS["dep-on-epic-dangling"] = "error"` entry above
    // handles the bare-token path; this prefix branch handles the
    // wrapped `blocked:dep-on-epic-dangling <upstream>` payload.
    if (
      bucket === undefined &&
      inner.startsWith("blocked:dep-on-epic-dangling")
    ) {
      bucket = "error";
    }
    if (bucket === undefined && inner.startsWith("blocked:")) {
      bucket = "warn";
    }
    if (bucket === undefined && inner.startsWith("failed:")) {
      bucket = "error";
    }
    if (bucket === undefined && inner.startsWith("awaiting:")) {
      bucket = "warn";
    }
    if (bucket === undefined && inner.startsWith("task-repo:")) {
      bucket = "warn";
    }
    // fn-643.5: `[dead-letter:N]` is the persistent banner pill the board
    // stamps when the daemon's `dead_letters` collection has waiting rows.
    // Warn/yellow bucket — "things to fix right now," same family as
    // `[blocked]` / `[awaiting:*]` / `[task-repo:*]`. The pill is dropped
    // entirely at count 0 (renderDeadLetterPill returns ""), so the
    // colorizer only sees this branch when there is actually a backlog.
    if (bucket === undefined && inner.startsWith("dead-letter:")) {
      bucket = "warn";
    }
    // fn-638.4: route `running:sub-agent-stale` to the `warn` bucket
    // (yellow) so a possibly-stuck orphan sub-agent renders distinctly
    // from a fresh `running:*` (cyan). Placed BEFORE the generic
    // `running:*` → `active` fallback so the more-specific staleness
    // signal wins. The other three `RunningReason` kinds
    // (`job-running`, `sub-agent-running`, `planner-running`) fall
    // through to `active` as before.
    if (bucket === undefined && inner === "running:sub-agent-stale") {
      bucket = "warn";
    }
    if (bucket === undefined && inner.startsWith("running:")) {
      bucket = "active";
    }
    if (bucket === undefined) {
      return match;
    }
    return `[${SGR[bucket]}${inner}${SGR.reset}]`;
  });
}

/**
 * Render the persistent `[dead-letter:N]` warn pill for the banner status
 * line. `N` is the native waiting-row count from the `dead_letters`
 * collection (descriptor `defaultFilter: { status: "waiting" }`); zero
 * returns an empty string so the banner drops the pill cleanly when there
 * is no backlog. A `null` / negative input also collapses to empty —
 * defensive against a malformed snapshot. The returned string is plain
 * text; the banner colorizer applies `warn` (yellow) via the
 * `dead-letter:*` prefix branch in {@link colorizePillsInLine}.
 *
 * Module-level + exported so `test/board.test.ts` can assert the pill
 * shape without standing up the subscribe loop.
 */
export function renderDeadLetterPill(waitingCount: number): string {
  if (!Number.isFinite(waitingCount) || waitingCount <= 0) {
    return "";
  }
  return `[dead-letter:${waitingCount}]`;
}

/**
 * Hard upper bound on how long the `r` replay keypress waits for the
 * `replay_dead_letter` RPC to reply. The handler's bridge already
 * deadlines on the worker→main round-trip (`src/server-worker.ts`); 5s
 * mirrors approve.ts's RESPONSE_TIMEOUT_MS so the board never wedges
 * on a stuck daemon.
 */
const REPLAY_DEAD_LETTER_TIMEOUT_MS = 5000;

/**
 * Shape of a successful `replay_dead_letter` RPC reply.
 * `recovered_dl_id: null` is the "nothing to replay" no-op ack; a string
 * value is the freshly-recovered row's `dl_id` (the row that flipped
 * `waiting → recovered`). Mirrors `ReplayDeadLetterResult` in
 * `src/rpc-handlers.ts` — kept structural here so the board doesn't
 * pull a server-side import.
 */
export interface ReplayDeadLetterRpcResult {
  recovered_dl_id: string | null;
}

/**
 * One-shot RPC client for `replay_dead_letter`. Opens a fresh UDS
 * connection (the board's subscribe socket is read-only — RPCs ride
 * SEPARATE connections per the approve.ts pattern), sends a single
 * `rpc` frame, awaits the matching `rpc_result` / `error` frame by id,
 * closes. Rejects with an Error carrying the human-readable reason on
 * connect-fail, transport error, malformed frame, server-side close
 * before reply, server `error` frame, or
 * REPLAY_DEAD_LETTER_TIMEOUT_MS elapsing post-connect.
 *
 * Module-level + exported so `test/board.test.ts` can stand up a mock
 * server and exercise the wire shape without the live-shell loop.
 *
 * The `connect` parameter is optional for test injection only —
 * production callers pass nothing and get the real `Bun.connect`.
 */
export async function sendReplayDeadLetterRpc(
  sockPath: string,
  connect?: (path: string) => Promise<{
    write(data: string): void;
    end(): void;
  }>,
): Promise<ReplayDeadLetterRpcResult> {
  const rpcId = crypto.randomUUID();
  const send: ClientFrame = {
    type: "rpc",
    id: rpcId,
    method: "replay_dead_letter",
    params: {},
  };
  return new Promise<ReplayDeadLetterRpcResult>((resolve, reject) => {
    const buffer = new LineBuffer();
    let settled = false;
    let sock: { end(): void } | null = null;
    const settle = (
      err: Error | null,
      value: ReplayDeadLetterRpcResult | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        sock?.end();
      } catch {
        // already torn down
      }
      if (err) {
        reject(err);
      } else if (value) {
        resolve(value);
      } else {
        reject(new Error("internal: settle called with neither err nor value"));
      }
    };
    const timeout = setTimeout(() => {
      settle(
        new Error(
          `no response from daemon within ${REPLAY_DEAD_LETTER_TIMEOUT_MS}ms`,
        ),
        null,
      );
    }, REPLAY_DEAD_LETTER_TIMEOUT_MS);
    timeout.unref?.();

    const handleFrame = (frame: ServerFrame): void => {
      if ((frame as { id?: string }).id !== rpcId) {
        // Unrelated frame — discard. The dispatcher today never leaks
        // unrelated frames into an RPC reply path, but the discipline
        // matches approve.ts's defensive id-match.
        return;
      }
      if (frame.type === "rpc_result") {
        const value = frame.value as { recovered_dl_id?: string | null };
        const recovered =
          typeof value?.recovered_dl_id === "string"
            ? value.recovered_dl_id
            : null;
        settle(null, { recovered_dl_id: recovered });
        return;
      }
      if (frame.type === "error") {
        settle(new Error(`server error ${frame.code}: ${frame.message}`), null);
        return;
      }
      settle(new Error(`unexpected frame type: ${frame.type}`), null);
    };

    const factory =
      connect ??
      ((path: string) =>
        Bun.connect({
          unix: path,
          socket: {
            open(s) {
              sock = s as unknown as { end(): void };
              s.write(encodeFrame(send));
            },
            data(_s, chunk) {
              let lines: string[];
              try {
                lines = buffer.push(chunk.toString("utf8"));
              } catch (err) {
                settle(
                  new Error(`protocol error: ${(err as Error).message}`),
                  null,
                );
                return;
              }
              for (const line of lines) {
                if (line.trim().length === 0) continue;
                let frame: ServerFrame;
                try {
                  frame = JSON.parse(line) as ServerFrame;
                } catch (err) {
                  settle(
                    new Error(
                      `malformed server frame: ${(err as Error).message}`,
                    ),
                    null,
                  );
                  return;
                }
                handleFrame(frame);
              }
            },
            close() {
              settle(
                new Error("daemon closed connection before responding"),
                null,
              );
            },
            error(_s, err) {
              settle(new Error(`socket error: ${err.message}`), null);
            },
          },
        }) as unknown as Promise<{ write(data: string): void; end(): void }>);

    factory(sockPath).catch((err: Error) => {
      settle(
        new Error(`failed to connect to ${sockPath}: ${err.message}`),
        null,
      );
    });
  });
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

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
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
  const log = (s: string) => process.stdout.write(`${s}\n`);
  // Forward-reference slot for the `c`-key copy handler — wired to a real
  // closure further down once `lastFrameText`, sidecar paths, and
  // `noteLine` are in scope. The wrapper passed to createLiveShell stays
  // stable across the swap.
  let onKey: ((key: string) => void) | undefined;
  const liveShell = createLiveShell({
    enabled: true,
    title: "board",
    onUnhandledKey: (key) => onKey?.(key),
  });
  let frameCount = 0;

  // Color is for human eyes on a TTY. Pipes / redirects / NO_COLOR stay
  // plain so consumers (grep, diff, `tee` to a file) see clean text.
  // Sidecars are ALWAYS plain — only the lines passed to `pushFrame`
  // pass through the colorizer.
  const colorEnabled =
    process.stdout.isTTY === true && process.env.NO_COLOR == null;

  // `lastBody` byte-compares the COMBINED body — internal row churn that
  // doesn't surface in the render is invisible by design.
  let lastBody: string | null = null;

  // fn-643.5: latest waiting dead-letter count from the readiness
  // snapshot. Persistent banner pill `[dead-letter:N]` reflects this on
  // every frame; the replay-key flash temporarily overrides the banner
  // via setStatus(), and the per-flash timer restores
  // `setStatus(persistentBannerPill())` so the pill never disappears
  // unintentionally. `0` (or null) collapses the pill to empty —
  // dropped cleanly.
  let waitingDeadLetterCount = 0;
  // Pre-colorized banner status string for the persistent dead-letter
  // pill. Recomputed every frame and after every flash timer. Empty
  // string when there's no backlog (banner shows nothing).
  function persistentBannerPill(): string {
    const raw = renderDeadLetterPill(waitingDeadLetterCount);
    if (raw === "") {
      return "";
    }
    return colorEnabled ? colorizePillsInLine(raw) : raw;
  }

  const seg = (v: unknown) => (v == null ? "" : String(v));

  // --- epic rendering ---

  /**
   * Per-job sub-agent lines. Reads from the per-frame `subagentIndex`
   * built by `emitFrame` and closed-over via the render context. Same-
   * name invocations within one job collapse to a single line via
   * `collapseSubagentsByName` — see that helper's docstring for the
   * operating assumption (no parallel like-named sub-agents in
   * practice). Each line carries
   * `{subagent_type}{annotations}: {description} [pill]` — `description`
   * is dropped when null/empty so the pill stays anchored next to the
   * type. `annotations` is a parenthesized comma-joined block that
   * appears only when there's something to say:
   *   - `×N` when the group folded more than one row
   *   - `N stuck` when one or more non-surviving rows are still
   *     `status='running'` (orphans whose `SubagentStop` never landed)
   * A clean group of one row renders with no parenthesized block.
   * `indent` is supplied per caller: embedded jobs (already three-
   * space indented inside an epic block) get six spaces; bottom-
   * section jobs (flush left) get three. Returns `[]` for jobs with
   * no recorded invocations so callers can spread unconditionally.
   */
  function subagentLinesFor(
    subagentIndex: Map<string, SubagentInvocation[]>,
    jobId: string,
    indent: string,
  ): string[] {
    const hits = subagentIndex.get(jobId);
    if (hits === undefined || hits.length === 0) {
      return [];
    }
    const groups = collapseSubagentsByName(hits);
    return groups.map((g) => {
      const type = g.row.subagent_type ?? "subagent";
      const desc = g.row.description ?? "";
      const annotations: string[] = [];
      if (g.count > 1) {
        annotations.push(`×${g.count}`);
      }
      if (g.stuck > 0) {
        annotations.push(`${g.stuck} stuck`);
      }
      const annSeg =
        annotations.length === 0 ? "" : ` (${annotations.join(", ")})`;
      const head = `${type}${annSeg}`;
      const label = desc === "" ? head : `${head}: ${desc}`;
      return `${indent}${label} [${seg(g.row.status)}]`;
    });
  }

  // `renderJobLinkLines` lives at module scope (exported) — see above —
  // so `test/board.test.ts` can assert the line shape without standing
  // up the full subscribe loop.

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

  // --- job rendering ---

  function projectJobRow(row: Record<string, unknown>): string {
    const title = seg(row.title);
    const cwd = row.cwd == null ? "" : basename(String(row.cwd));
    const cwdSeg = cwd === "" ? "" : `(${cwd}) `;
    const role = planVerbLabel(row.plan_verb);
    const roleSeg = role == null ? "" : ` [${role}]`;
    const awaiting = inputRequestPillSeg(
      row.last_input_request_at,
      row.last_input_request_kind,
    );
    const head = `${cwdSeg}${title}${roleSeg} [${seg(row.state)}]${apiErrorPillSeg(row.last_api_error_at, row.last_api_error_kind)}`;
    // [awaiting:<kind>] drops to its own continuation line (two-space indent —
    // same depth as this row's sub-agent lines, appended by the caller).
    return awaiting === "" ? head : `${head}\n  ${awaiting.trimStart()}`;
  }

  /**
   * Jobs body is split into two stacked sub-lists by `plan_verb` presence:
   * no-role (ambient sessions) on top, with-role (planner/worker/closer —
   * epic-bound work) on the bottom, joined by a `~~~` line. Within each
   * partition we preserve server order, and each job row is followed by
   * its `subagentLinesFor` block (three-space indent — one level under
   * the flush-left job line). Same empty-side drop rule as the outer
   * `renderBody`: a partition with zero rows yields just the other one,
   * no divider; both empty yields `""`.
   *
   * The helper delivers `jobs` as a `Map<job_id, Job>` (no ordered slice),
   * so we iterate via `jobs.values()` — the Map preserves insertion order
   * and the helper's `result`-handler inserts in wire order, so server
   * order is preserved.
   */
  function renderJobsBody(
    snap: ReadinessClientSnapshot,
    subagentIndex: Map<string, SubagentInvocation[]>,
  ): string {
    if (snap.jobs.size === 0) {
      return "";
    }
    const noRole: string[] = [];
    const withRole: string[] = [];
    for (const [id, row] of snap.jobs) {
      const block = [
        projectJobRow(row as unknown as Record<string, unknown>),
        ...subagentLinesFor(subagentIndex, id, "  "),
      ].join("\n");
      if ((row as unknown as Record<string, unknown>).plan_verb == null) {
        noRole.push(block);
      } else {
        withRole.push(block);
      }
    }
    const top = noRole.join("\n");
    const bottom = withRole.join("\n");
    if (top === "") {
      return bottom;
    }
    if (bottom === "") {
      return top;
    }
    return `${top}\n~~~\n${bottom}`;
  }

  /**
   * Combined frame body: epics on top, jobs on the bottom, a `~~~` divider
   * on its own line between them (no blank-line padding — the divider IS
   * the visual break). The divider is dropped when either side is empty,
   * so a single populated section reads as a clean block; both empty
   * yields an empty body (the frame is just the `---` lead). Same `---`
   * lead as the sibling scripts — there's still one frame per change.
   *
   * Returns one element per output line so the live-shell can consume
   * lines (per-line ANSI diff). The caller joins with `\n` for stdout /
   * sidecar / byte-compare.
   */
  function renderBody(
    snap: ReadinessClientSnapshot,
    subagentIndex: Map<string, SubagentInvocation[]>,
  ): string[] {
    const e = renderEpicsBody(snap, subagentIndex);
    const j = renderJobsBody(snap, subagentIndex);
    let body: string;
    if (e === "") {
      body = j;
    } else if (j === "") {
      body = e;
    } else {
      body = `${e}\n~~~\n${j}`;
    }
    return body === "" ? [] : body.split("\n");
  }

  // Internal scratch path for the previous frame text — fed to `diff -u` as
  // its "before" file. Overwritten each tick; not surfaced in the meta note.
  const prevFrameTmp = `/tmp/keeper-board.${process.pid}.prev.frame.txt`;
  // Session-level meta file: one tab-separated line per frame (index +
  // per-frame sidecar paths). Accumulates across the session so every past
  // frame remains inspectable.
  const metaSidecar = `/tmp/keeper-board.${process.pid}.meta.txt`;
  // The alt-screen owns stdout, so per-frame / per-event chatter goes here.
  // Lifecycle events and warn lines append here instead; tail -f from another
  // pane to watch.
  const lifecycleSidecar = `/tmp/keeper-board.${process.pid}.lifecycle.txt`;
  // Route warn/lifecycle output to the sidecar.
  const noteLine = (s: string): void => {
    try {
      appendFileSync(lifecycleSidecar, `${s}\n`);
    } catch {
      // best-effort — the sidecar is observational
    }
  };
  // In-memory copy of the last emitted frame's body+lead, used as the
  // "before" side of the per-frame unified diff. `null` until the first
  // frame lands (sentinel written instead).
  let lastFrameText: string | null = null;

  function writeSidecars(
    snap: ReadinessClientSnapshot,
    frameText: string,
  ): void {
    const sState = `/tmp/keeper-board.${process.pid}.state.${frameCount}.json`;
    const sFrame = `/tmp/keeper-board.${process.pid}.frame.${frameCount}.txt`;
    const sDiff = `/tmp/keeper-board.${process.pid}.diff.${frameCount}.txt`;
    const stateJson = {
      epics: snap.epics,
      jobs: Array.from(snap.jobs.values()),
    };
    try {
      writeFileSync(sState, `${JSON.stringify(stateJson, null, 2)}\n`);
      writeFileSync(sFrame, `${frameText}\n`);
    } catch (err) {
      noteLine(`# warn: sidecar write failed: ${(err as Error).message}`);
    }
    // Per-frame unified diff against the previous emit. Uses system `diff -u`
    // so the output is the universally-readable unified-diff format. `diff -u`
    // exits 1 when files differ — that's expected here (we only get here when
    // the body changed), so we ignore the exit code and take stdout. First
    // frame has no prior, so we write a sentinel.
    let diffText: string;
    if (lastFrameText == null) {
      diffText = "# first frame — no previous to diff against\n";
    } else {
      try {
        writeFileSync(prevFrameTmp, `${lastFrameText}\n`);
        const proc = Bun.spawnSync({
          cmd: ["diff", "-u", prevFrameTmp, sFrame],
        });
        diffText = proc.stdout.toString();
        if (diffText.length === 0) {
          diffText = "# diff: no textual difference\n";
        }
      } catch (err) {
        diffText = `# diff failed: ${(err as Error).message}\n`;
      }
    }
    try {
      writeFileSync(sDiff, diffText);
    } catch (err) {
      noteLine(`# warn: diff sidecar write failed: ${(err as Error).message}`);
    }
    try {
      appendFileSync(
        metaSidecar,
        `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
      );
    } catch (err) {
      noteLine(`# warn: meta write failed: ${(err as Error).message}`);
    }
    lastFrameText = frameText;
  }

  /**
   * Helper-driven snapshot callback. Builds the per-frame `job_id →
   * invocations` index, renders the combined body, byte-compares against
   * the last emit, and writes sidecars + stdout when the render changes.
   * The helper handles the all-three-strict first-paint gate AND the
   * `computeReadiness` call — `snap.readiness` is fully populated when
   * we get here.
   */
  function emitFrame(snap: ReadinessClientSnapshot): void {
    // fn-635: drain `snap.readiness.diagnostics` to the JSONL log before
    // building the render. The drain is per-snapshot, not per-emit (we
    // want every observed ambiguity recorded even if the render is
    // byte-stable and `lastBody` short-circuits). Best-effort append —
    // `appendDiagnostic` swallows I/O errors so a transient FS hiccup
    // doesn't wedge the frame loop.
    for (const d of snap.readiness.diagnostics) {
      appendDiagnostic(d, diagnosticsLogPath);
    }
    // fn-643.5: refresh the persistent banner pill BEFORE the
    // body-stability short-circuit below — the dead-letter count can
    // change independently of the body (a new waiting row landing while
    // the epics/jobs render stays byte-stable). Always re-stamp the
    // banner so the pill reflects every snapshot, even snapshots where
    // the body byte-compare drops the frame. `setStatus` is itself a
    // no-op when the string is unchanged.
    waitingDeadLetterCount = snap.deadLetters.length;
    liveShell.setStatus(persistentBannerPill());
    // Per-frame `job_id → invocations` index — re-entrant sub-agents within
    // one session sit on the same `job_id` bucket, ordered by `turn_seq asc`
    // so the nested list reads in invocation order. The projection now
    // promotes `superseded` natively (task fn-605.2), so no client-side
    // marking pass is required — `subagentLinesFor` stamps the raw
    // `[${status}]` enum verbatim.
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
    const bodyLines = renderBody(snap, subagentIndex);
    const body = bodyLines.join("\n");
    if (body === lastBody) {
      return;
    }
    lastBody = body;
    frameCount += 1;
    const frameText = ["---", ...bodyLines].join("\n");
    // Only lines shipped to the screen pick up SGR coloring. Gated on TTY +
    // NO_COLOR so piped/redirected output stays clean. `---` is kept in
    // frameText for sidecars/non-TTY output but not passed to the shell.
    const linesForShell = colorEnabled
      ? bodyLines.map(colorizePillsInLine)
      : bodyLines;
    liveShell.pushFrame(linesForShell);
    writeSidecars(snap, frameText);
  }

  function emitLifecycle(
    event: string,
    detail: Record<string, unknown> = {},
  ): void {
    const lines: string[] = ["...", `event: ${event}`];
    for (const [k, v] of Object.entries(detail)) {
      lines.push(`${k}: ${String(v)}`);
    }
    lines.push("...");
    try {
      appendFileSync(lifecycleSidecar, `${lines.join("\n")}\n`);
    } catch {
      // best-effort
    }
    // On disconnect, clear `lastBody` so the next first-paint emits even
    // if the post-reconnect snapshot happens to match the last pre-
    // disconnect body byte-for-byte. (The helper resets its own collection
    // state and re-gates first-paint behind all three `result`s.)
    if (event === "disconnected") {
      lastBody = null;
    }
  }

  // Shared banner-flash timer. `c` (copy) and `r` (replay-dead-letter)
  // both push a transient `[...]` status pill into the banner via
  // `setStatus`; this single timer restores the persistent
  // `[dead-letter:N]` (or empty) pill after the flash window. One timer
  // (vs. per-key) means a fresh flash from EITHER key cancels a
  // still-pending restore from the OTHER — last-flash-wins, no leaked
  // banner state.
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleFlashRestore(): void {
    if (flashTimer !== undefined) {
      clearTimeout(flashTimer);
    }
    flashTimer = setTimeout(() => {
      flashTimer = undefined;
      liveShell.setStatus(persistentBannerPill());
    }, 1500);
  }

  // `c` copies a debug snapshot (current frame + sidecar paths) to
  // the clipboard via `pbcopy`. Flashes `[copied frame N]` / `[copy
  // failed]` in the banner via setStatus; the shared flash-restore
  // timer puts the persistent dead-letter pill back after ~1.5 s.
  // Skipped silently before the first frame lands.
  function handleCopyKey(): void {
    if (lastFrameText == null) {
      return;
    }
    const payload = buildDebugSnapshot({
      script: "board",
      pid: process.pid,
      frame: lastFrameText,
      frameNumber: frameCount,
      metaSidecar,
      lifecycleSidecar,
      nowIso: new Date().toISOString(),
    });
    const flashed = frameCount;
    void copyToClipboard(payload).then((res) => {
      if (res.ok) {
        liveShell.setStatus(`[copied frame ${flashed}]`);
      } else {
        noteLine(`# warn: clipboard copy failed: ${res.error}`);
        liveShell.setStatus("[copy failed]");
      }
      scheduleFlashRestore();
    });
  }

  // `r` recovers ONE oldest waiting dead-letter via the `replay_dead_letter`
  // RPC over a fresh short-lived UDS connection (board's subscribe socket
  // is read-only; the RPC dispatch rides a SEPARATE connection per the
  // approve.ts pattern). Flashes `[replaying…]` immediately, then
  // `[recovered <dl_id>]` / `[nothing to replay]` / `[replay failed:
  // <reason>]` on the RPC reply. A single-flight guard suppresses
  // double-fires while a replay is in flight — the keypress would
  // otherwise stack pending RPCs. The persistent `[dead-letter:N]` pill
  // drops on the next frame (the recovered row leaves the waiting page);
  // the recovered session appears via its `events`-side fold.
  let replayInFlight = false;
  function handleReplayKey(): void {
    if (replayInFlight) {
      // Already a replay in flight — refuse silently rather than queue
      // another. The flash timer will restore the banner soon enough.
      return;
    }
    replayInFlight = true;
    liveShell.setStatus("[replaying…]");
    // Do NOT schedule the flash restore yet — the `[replaying…]` pill
    // must persist until the RPC resolves. The reply path schedules
    // the restore AFTER stamping the final flash text.
    void sendReplayDeadLetterRpc(sockPath)
      .then(
        (result) => {
          if (result.recovered_dl_id === null) {
            liveShell.setStatus("[nothing to replay]");
          } else {
            liveShell.setStatus(`[recovered ${result.recovered_dl_id}]`);
          }
          scheduleFlashRestore();
        },
        (err: Error) => {
          noteLine(`# warn: dead-letter replay failed: ${err.message}`);
          // Trim a possibly-multiline error message into a single
          // banner-safe segment. The full message lives in the
          // lifecycle sidecar via the noteLine above.
          const oneLine = err.message.split("\n", 1)[0] ?? err.message;
          liveShell.setStatus(`[replay failed: ${oneLine}]`);
          scheduleFlashRestore();
        },
      )
      .finally(() => {
        replayInFlight = false;
      });
  }

  onKey = (key: string): void => {
    if (key === "c") {
      handleCopyKey();
      return;
    }
    if (key === "r") {
      handleReplayKey();
      return;
    }
  };

  const handle = subscribeReadiness({
    sockPath,
    idPrefix: "board",
    onSnapshot: emitFrame,
    onLifecycle: emitLifecycle,
  });

  process.on("SIGINT", () => {
    // Terminal restoration before subscription teardown.
    liveShell.dispose();
    handle.dispose();
    log("...");
    log(`meta: ${metaSidecar}`);
    log(`lifecycle: ${lifecycleSidecar}`);
    log("...");
    process.exit(0);
  });
}

// Entry-point guard — only run when invoked as a script, not when imported
// (the test suite re-imports `projectRows` from this module).
if (import.meta.main) {
  await main();
}
