#!/usr/bin/env bun
/**
 * keeper-board — an epics-only "UI" over the read-only NDJSON-over-UDS
 * subscribe server that streams the epics + subagent_invocations collections
 * (plus jobs as a passive feed for nested per-task / per-link rendering) as one
 * frame per change. Sibling of `cli/jobs.ts`, which owns the bottom jobs list +
 * the dead-letter banner. `subagent_invocations` rows feed the readiness pill
 * AND nest as indented `[<status>]` lines under the matching job row, stamping
 * the raw projection enum `running|ok|failed|unknown|superseded` verbatim.
 * Same-name invocations within one job collapse on the client to a single line
 * (max turn_seq) via `collapseSubagentsByName`; the same collapse feeds
 * readiness, so an orphan `running` row whose `SubagentStop` never landed no
 * longer false-blocks predicate 6.
 *
 * Connection / poll / coalesce / first-paint lifecycle is owned by
 * `subscribeReadiness`. The board is the RENDERER: sidecar writes, the
 * per-frame `job_id → SubagentInvocation[]` nesting index, the `lastBody`
 * byte-compare that suppresses no-op frames, and the stdout emit. It reads
 * subagent_invocations through `state.rows` so re-entrant sub-agents sharing
 * one `job_id` all reach `computeReadiness`.
 *
 * An empty epics collection renders as NOTHING — the frame is just the `---`
 * lead. The view uses the SERVER defaults for the epics collection (`status =
 * 'open' AND approval != 'approved'`); for explicit filters drop down to a
 * custom subscribe client.
 *
 * Embedded SGR codes (`colorizePillsInLine`'s output) are parsed into OpenTUI
 * `StyledText` at paint time by `src/ansi-to-styled.ts`. Sidecars stay PLAIN
 * (the colorizer runs only on `pushFrame` lines, not sidecar / stdout writes).
 *
 * Usage:
 *   keeper board [--sock <path>]
 *   --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise).
 *   --help           Show this help.
 */

import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  apiErrorPillSeg,
  armedPill,
  epicHeaderLabel,
  iconizePills,
  inputRequestPillSeg,
  permissionPromptPillSeg,
  pill,
  pillOrEmpty,
  planVerbLabel,
  renderClosePills,
  renderTaskPills,
  subagentLinesFor,
  validatedPill,
} from "../src/board-render";
import { resolveSockPath } from "../src/db";
import type { EpicDepResolution } from "../src/epic-deps";
import { formatPill, type Verdict } from "../src/readiness";
import {
  type ReadinessClientSnapshot,
  subscribeCollection,
  subscribeReadiness,
} from "../src/readiness-client";
import { appendDiagnostic } from "../src/readiness-diagnostics";
import { resolveSnapshotMode, SnapshotCliMisuseError } from "../src/snapshot";
import type {
  Epic,
  JobLinkEntry,
  ResolvedEpicDep,
  SubagentInvocation,
} from "../src/types";
import { createViewShell } from "../src/view-shell";

// Re-export shims: `test/board.test.ts` and `scripts/drain-dead-letters.ts`
// import these symbols from `../cli/board`, but their definitions live in
// `src/board-render.ts`. New code should import from `src/board-render`
// directly.
export {
  colorizePillsInLine,
  type ReplayDeadLetterRpcResult,
  renderDeadLetterPill,
  sendReplayDeadLetterRpc,
} from "../src/board-render";

const HELP = `keeper board — epics-only UI over the keeper subscribe server

Usage: keeper board [--sock <path>] [--snapshot | --watch] [--timeout <s>]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --snapshot       Force one-shot snapshot mode (print one frame + a
                   machine-parseable keeper-meta: line, then exit) even on a TTY
  --watch          Force the live subscribe stream even when piped
  --timeout <s>    Snapshot wait before the timeout escape (default ~2s)
  --help           Show this help

By default, stdout that is NOT a TTY (piped into an agent) auto-detects
snapshot mode; a TTY gets the live TUI. \`CI\` / \`TERM=dumb\` force snapshot.

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

Pills follow the SHOW-DEFAULTS + ICON convention (fn-713 follow-on; reverses
the earlier fn-708 omit-default). Every fixed-slot enum renders an explicit
pill at its current value, defaults included — [pending], [todo], [open],
[unvalidated], [stopped], [ok] all show. Each themed pill carries a Nerd Font
glyph inside the brackets, ahead of a '::' delimiter:
  [<icon>::<text>]   e.g.  [<icon>::ready]   [<icon>::blocked:dep-on-task fn-2]
The glyph is the source of truth; color (applied to the text half) is an
orthogonal reinforcement. Non-state pills — dep refs [#2] / [name#3] — stay
plain (no glyph). The icon set is the 'fa-classic' theme in src/icon-theme.ts;
swap ACTIVE_THEME there to reskin. Presence-based pills ([failed:*],
[awaiting:*], [task-repo:*], [slotted-after-closer], the role pill) still
appear only when their condition holds.

Each epic block opens with a header line of the form:

  ({dir}) {epic_number} {title} [name#dep,name#dep] [validated]? [slotted-after-closer]? [<readiness>]

The [validated] pill appears ONLY when the epic is validated; its absence
encodes 'unvalidated' (flip with 'planctl validate --epic <id>'). A
[blocked:<reason>] readiness pill drops to its own indented line beneath the
header instead of stamping at the end; ready/completed/running stay inline.

The {epic_number} {title} label falls back to {epic_id} when BOTH are null —
a pre-EpicSnapshot stub row (a keeper epic and its tasks fold as two separate
transactions; between them the epic exists with zero tasks and a still-null
number/title). The fallback keeps the header legible and identifiable instead
of collapsing to a blank '({dir})  [unvalidated]' line; such a taskless epic's
close row reads [blocked:epic-no-tasks] (fn-700) until its first task folds.
The row is never hidden ("show it blocked, don't hide").

The cross-epic dependency pills carry the dep's project-name prefix
(e.g. [arthack#633]) so deps that cross topics/projects read unambiguously;
the bare task-dep pills below stay [#n] (same-epic, no prefix needed).

The optional [slotted-after-closer] pill (schema v29) appears only on epics
whose projection carries a non-null created_by_closer_of — i.e. epics minted
by another epic's closer session. Its presence is also what slots the epic
directly below its parent in the default sort (sort_path ASC).

followed (when the epic carries job_links) by one indented creator/refiner
line per linked session —
'{title} [creator|refiner] [state]? [failed:<kind>]?' where the [state] pill
follows omit-default (no pill ≡ 'stopped'; only live states stamp one), with an optional
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
'{n}. {title} [#dep,#dep] [<runtime>]? [worker-done]? [<approval>]?').
The three native fields follow omit-default + de-ambiguation (fn-708):
  - runtime_status: 'todo' elides (default); 'in_progress' / 'done' render
    verbatim; 'blocked' renders as '[rt:blocked]' so the manual planctl block
    flag never collides with the verdict '[blocked:*]' family.
  - worker_phase: 'open' never renders; the 'done' survivor renders as the
    LABELED '[worker-done]' (never bare '[done]', which would collide with
    runtime 'done') and only when the verdict does not already pin done
    (i.e. not 'completed' / 'job-pending' / 'git-uncommitted' / 'git-orphans').
  - approval: 'pending' elides (default); '[rejected]' is dropped when the
    verdict is already '[blocked:job-rejected]' and '[approved]' when the
    verdict is '[completed]' (the word is already on screen).
The block ends with a "Quality audit and close" line for the epic itself —
its '[status]' pill is dropped (the board filter pins it to '[open]') and
its approval pill follows the same omit-default + verdict-aware suppression,
so it usually collapses to just the title + the '[id] <verdict>' line.

Sub-agent invocations nest under their owning job row as one indented
line each — '{subagent_type}{annotations}: {description} [<status>]?' —
where <status> is the raw projection enum and follows omit-default (fn-708):
'ok' (and a null/empty status) renders NO pill (absence ≡ ok); the
non-resting states 'running|failed|unknown|superseded' render verbatim.
'superseded' is rendered (no hiding) so the audit trail of re-entrant
attempts stays visible.

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
from the (epics, jobs, subagent_invocations) snapshot. One blocked reason is
close-row-specific: [blocked:epic-no-tasks] (fn-700) fires on the "Quality
audit and close" row of an epic with ZERO tasks (the partial-projection
window between the EpicSnapshot and TaskSnapshot folds) so the autopilot
never dispatches a closer against an epic with no work. For tasks and the
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
(fn-655, narrowed by fn-663): the close row only locks project_dir when
at least one epic-level non-planner running source is live (an
epic-level close-verb job or an epic-level sub-agent). Planners are
root-exempt — a planner-running close row does NOT claim project_dir
(the planner still blocks its own epic via the per-EPIC mutex, but a
sibling epic's ready task on the same root may dispatch concurrently).
A close row whose running state is purely inherited from a task-level
worker in a different target_repo also does NOT claim project_dir —
the contributing task already holds its own correct root via its
target_repo. See applySingleTaskPerRootMutex in src/readiness.ts for
the full rule.

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
 * Re-export `projectRows` so consumers can keep importing it from the board
 * entry. The canonical home is `src/readiness-client`; import from there.
 */
export { projectRows } from "../src/readiness-client";

/**
 * Render the optional `[task-repo:<basename>]` pill segment when a task's
 * `target_repo` diverges from its epic's `project_dir` — a task whose worker
 * runs in a sibling repo. The same divergence drives which root the per-root
 * mutex claims (see `effectiveRoot` in `src/readiness.ts`); the null+empty
 * fallthrough matches it so the pill never lies about the row's root. Empty /
 * null `target_repo` is the no-override case and returns `""` so the caller
 * can append unconditionally.
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
  return ` ${pill(`task-repo:${basename(tr)}`)}`;
}

/**
 * Cross-epic dependency reference label — `<name>#<number>` extracted from a
 * dep epic id like `arthack-633-git-per-session-file-attribution`. The
 * project-name prefix disambiguates deps that cross topics/projects. Returns
 * `null` when the id doesn't match the `<name>-<number>-<slug>` shape.
 */
function epicDepRefFromId(id: string): string | null {
  const m = /^([a-z]+)-(\d+)-/.exec(id);
  return m ? `${m[1]}#${m[2]}` : null;
}

/**
 * Parallel to {@link epicDepRefFromId} for the bare-id form (`fn-N`, no
 * trailing slug). Returns the bare epic number when the id matches; else
 * `null`.
 */
export function epicNumFromIdOrBare(id: string): number | null {
  // Full id: `<name>-<num>-<slug>` — first numeric segment after the project
  // prefix. Bare id: `fn-<num>` exact.
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
 * Pill assembly for one epic's `depends_on_epics` list. Three render shapes:
 * dangling → `?#N`, intra-project → `#N`, cross-project → `<prefix>::#N`.
 * Malformed dangling ids (no extractable number) and found-but-numberless
 * upstreams are dropped. The caller drives `resolveEpicDep` directly so the
 * diagnostics sink stays under its control; this only assembles the refs.
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
 * Projection-driven counterpart to {@link renderEpicDepPills}. Reads the
 * `resolved_epic_deps` array (the reducer's forward-stamp output) and assembles
 * the same three render shapes — `#N`, `<project>::#N`, `?#N` — without
 * invoking the resolver live, so the board pill and predicate 9 in
 * `src/readiness.ts` (same projection) cannot drift. A resolved entry whose
 * `epic_number` is null is dropped.
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
      // `cross_project === true` implies a non-null `project_basename`; guard
      // once and drop the pill on the impossible-null fallback so the renderer
      // stays total.
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
 * header. Each {@link JobLinkEntry} is denormalized off the linked `jobs` row
 * at the reducer's write boundary, so the render reads every field straight off
 * the projection — no live-jobs join, no off-page fallback branch. The line
 * shape is the same whether the linked session is live, terminal, or off-page:
 *
 *     {title ?? job_id} [{kind}] [{state}]{apiErrorPillSeg}
 *       [awaiting:<kind>]   ← only when present, own continuation line
 *
 * Title falls back to `job_id` when the embedded `title` is null. `[state]` and
 * `[failed:<kind>]?` stay inline; the optional `[awaiting:<kind>]` pill drops
 * to its own continuation line so a long interactive stop reads without
 * wrapping. Iteration order is the projection's own `(kind, job_id)` ASC sort.
 */
export function renderJobLinkLines(jobLinks: unknown): string[] {
  if (!Array.isArray(jobLinks) || jobLinks.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const link of jobLinks as JobLinkEntry[]) {
    const label = link.title ?? link.job_id;
    // The lifecycle pill omits the default: the resting `stopped` value renders
    // NO pill; only live states stamp one. `pillOrEmpty` self-delimits.
    const stateSeg = pillOrEmpty(link.state, "stopped");
    const awaiting = inputRequestPillSeg(
      link.last_input_request_at,
      link.last_input_request_kind,
    );
    // Permission-prompt / elicitation awaiting pill, read off the SAME entry
    // and dropped on its OWN continuation line below. The render layer must not
    // assume mutual exclusion with the input-request pill.
    const awaitingPP = permissionPromptPillSeg(
      link.last_permission_prompt_at,
      link.last_permission_prompt_kind,
    );
    out.push(
      `  ${label} ${pill(String(link.kind))}${stateSeg}${apiErrorPillSeg(link.last_api_error_at, link.last_api_error_kind)}`,
    );
    // The [awaiting:<kind>] pill drops to its own continuation line (one indent
    // deeper); [state]/[failed:<kind>] stay inline above.
    if (awaiting !== "") {
      out.push(`    ${awaiting.trimStart()}`);
    }
    if (awaitingPP !== "") {
      out.push(`    ${awaitingPP.trimStart()}`);
    }
  }
  return out;
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      sock: { type: "string" },
      snapshot: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      // parseArgs has no number type — capture as a string and validate
      // manually below (exit 2 on a non-positive / non-numeric value).
      timeout: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  // Resolve the run mode (flag > CI/TERM=dumb > stdout.isTTY !== true).
  // Both `--snapshot` and `--watch` → typed misuse error → exit 2.
  let mode: "snapshot" | "watch";
  try {
    mode = resolveSnapshotMode({
      snapshotFlag: values.snapshot ?? false,
      watchFlag: values.watch ?? false,
      stdoutIsTTY: process.stdout.isTTY,
      env: process.env,
    });
  } catch (err) {
    if (err instanceof SnapshotCliMisuseError) {
      process.stderr.write(`keeper board: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // Validate `--timeout` (seconds) only when snapshotting — a bad value is
  // CLI misuse (exit 2). Watch mode ignores it.
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const secs = Number(values.timeout);
    if (!Number.isFinite(secs) || secs <= 0) {
      process.stderr.write(
        `keeper board: --timeout must be a positive number of seconds (got '${values.timeout}')\n`,
      );
      process.exit(2);
    }
    timeoutMs = Math.round(secs * 1000);
  }

  const sockPath = values.sock ?? resolveSockPath();
  // Readiness diagnostics JSONL log, a sibling of the sock in the state dir.
  // Two processes (board + autopilot) can append concurrently; POSIX O_APPEND
  // under PIPE_BUF gives the atomicity guarantee, no flock.
  const diagnosticsLogPath = join(
    dirname(sockPath),
    "readiness-diagnostics.jsonl",
  );
  // The live explicitly-armed epic-id set, fed by a parallel `armed_epics`
  // presence-table subscription below (the readiness composite doesn't carry
  // it). `renderEpicBlock` reads this to decide the `[armed]` header pill.
  // Mutated in place (clear+re-add) on each edge so the closure identity the
  // renderer captured stays stable.
  const armedSet = new Set<string>();
  const seg = (v: unknown) => (v == null ? "" : String(v));

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
      // Permission-prompt / elicitation awaiting pill on the embedded-job line.
      // Same stacking discipline as the input-request pill above — independent
      // continuation line.
      const awaitingPP = permissionPromptPillSeg(
        job.last_permission_prompt_at,
        job.last_permission_prompt_kind,
      );
      // The role pill is presence-based — omitted only when there is no
      // `plan_verb` (no resting default).
      const role = planVerbLabel(job.plan_verb);
      const roleSeg = role == null ? "" : ` ${pill(role)}`;
      out.push(
        `    ${seg(job.title)}${roleSeg}${pillOrEmpty(job.state, "stopped")}${apiErrorPillSeg(job.last_api_error_at, job.last_api_error_kind)}`,
      );
      // [awaiting:<kind>] on its own continuation line (six-space indent —
      // same depth as this row's sub-agent lines below).
      if (awaiting !== "") {
        out.push(`      ${awaiting.trimStart()}`);
      }
      if (awaitingPP !== "") {
        out.push(`      ${awaitingPP.trimStart()}`);
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
    // Summary pill reads `row.resolved_epic_deps` — the projection maintained
    // by the reducer's forward-stamp + reverse fan-out, shared with predicate 9
    // so they cannot drift. Three render shapes: intra-project `[#N]`,
    // cross-project `[<basename>::#N]`, dangling `[?#N]`.
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
    // `epicIds` is no longer used for filtering; kept in the signature for API
    // stability. Read once to silence the lint.
    void epicIds;
    const epicId = seg(row.epic_id);
    const lines: string[] = [];
    const epicVerdict = verdictFromMap(snap.readiness.perEpic, epicId);
    // `[slotted-after-closer]` pill — appears only when the epic was minted by
    // another epic's closer session (`created_by_closer_of` non-null).
    // Self-delimited (empty when absent, leading space when present).
    const slottedSeg =
      row.created_by_closer_of == null
        ? ""
        : ` ${pill("slotted-after-closer")}`;
    // The `{epic_number} {title}` label falls back to `epic_id` when both are
    // null (a pre-`EpicSnapshot` stub row), so the header is never blank.
    // `validatedPill` and `armedPill` both omit their default and self-delimit,
    // emitting their pill only at the non-resting value.
    const armedSeg = armedPill(armedSet.has(epicId));
    const epicHeader = `${dirSeg}${epicHeaderLabel(row.epic_number, row.title, epicId)}${epicDepsSeg}${validatedPill(row.last_validated_at)}${slottedSeg}${armedSeg}`;
    const epicHeaderLines =
      epicVerdict.tag === "blocked"
        ? [epicHeader, `  ${iconizePills(formatPill(epicVerdict))}`]
        : [`${epicHeader} ${iconizePills(formatPill(epicVerdict))}`];
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
      const taskId = seg(t.task_id);
      const taskVerdict = verdictFromMap(snap.readiness.perTask, taskId);
      // A [blocked:<reason>] verdict drops to its own line beneath the [id]
      // reference; ready/completed/running stay inline. The
      // `[task-repo:<basename>]` divergence pill follows the verdict wherever
      // it lands (see `taskRepoPillSeg`).
      const taskPillSeg = `${iconizePills(formatPill(taskVerdict))}${taskRepoPillSeg(t.target_repo, row.project_dir)}`;
      const taskIdLines =
        taskVerdict.tag === "blocked"
          ? [`    [${taskId}]`, `    ${taskPillSeg}`]
          : [`    [${taskId}] ${taskPillSeg}`];
      lines.push(
        // `renderTaskPills` consolidates the runtime_status / worker_phase /
        // approval triple, each rendering ONLY at its non-resting value (see
        // `keeper board --help` for the omit-default convention).
        `  ${seg(t.task_number)}. ${seg(t.title)}${taskDepsSeg}${renderTaskPills(t, taskVerdict)}`,
        ...taskIdLines,
        ...renderJobLines(subagentIndex, t.jobs),
      );
    }
    const closeVerdict = verdictFromMap(snap.readiness.perCloseRow, epicId);
    // Same rule as the task arm: a [blocked:<reason>] verdict drops to its
    // own line beneath the [id]; ready/completed/running stay inline.
    const closeIdLines =
      closeVerdict.tag === "blocked"
        ? [`    [${epicId}]`, `    ${iconizePills(formatPill(closeVerdict))}`]
        : [`    [${epicId}] ${iconizePills(formatPill(closeVerdict))}`];
    lines.push(
      // The close-row `[status]` pill is dropped — the board filter pins it to
      // `[open]` (a custom-filtered view restores it; see `renderClosePills`).
      // The approval pill follows the same omit-default + verdict-aware
      // suppression as the task line.
      `  X. Quality audit and close${renderClosePills(row, closeVerdict)}`,
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
   * live-shell can consume lines (per-line ANSI diff). The bottom jobs list
   * lives in `cli/jobs.ts`.
   */
  function renderBody(
    snap: ReadinessClientSnapshot,
    subagentIndex: Map<string, SubagentInvocation[]>,
  ): string[] {
    const body = renderEpicsBody(snap, subagentIndex);
    return body === "" ? ["no epics"] : body.split("\n");
  }

  // Lifecycle + sidecars + copy key + SIGINT live in `createViewShell`. Board's
  // only sibling-specific bits are the renderer, the `subscribeReadiness`
  // wiring, and the diagnostics drain.
  const view = createViewShell<ReadinessClientSnapshot>({
    script: "board",
    title: "board",
    // Board folds TWO streams — the readiness composite + the `armed_epics`
    // presence table — so the snapshot latch holds until BOTH report (readiness
    // via the auto-report in `view.emit`, armed_epics via the explicit
    // `reportSnapshotStream` below).
    mode: mode === "snapshot" ? "snapshot" : "live",
    streamCount: 2,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    renderBody: (snap) => {
      // Per-frame `job_id → invocations` index — re-entrant sub-agents within
      // one session share a bucket, ordered by `turn_seq asc`.
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

  // Retain the last readiness snapshot so an `armed_epics` edge landing between
  // readiness frames can repaint the `[armed]` pill immediately. Null until the
  // first frame.
  let lastSnap: ReadinessClientSnapshot | null = null;

  function emitFrame(snap: ReadinessClientSnapshot): void {
    lastSnap = snap;
    // Drain diagnostics per-snapshot (not per-emit) so every observed ambiguity
    // is recorded even when the render is byte-stable and the view-shell's
    // `lastBody` short-circuits. Best-effort — `appendDiagnostic` swallows I/O
    // errors so an FS hiccup doesn't wedge the frame loop.
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

  // A parallel `armed_epics` presence-table subscription — the readiness
  // composite doesn't carry the armed set. On each edge we rebuild `armedSet`
  // in place (clear + re-add) and re-emit the last snapshot so the `[armed]`
  // pill repaints live. Report to the snapshot latch exactly once (the
  // one-shot guard keeps a re-fired edge from over-reporting); inert in live
  // mode.
  let armedStreamReported = false;
  const armedHandle = subscribeCollection({
    sockPath,
    idPrefix: "board",
    collection: "armed_epics",
    onRows: (rows) => {
      armedSet.clear();
      for (const r of rows) {
        const id = seg(r.epic_id);
        if (id !== "") {
          armedSet.add(id);
        }
      }
      if (!armedStreamReported) {
        armedStreamReported = true;
        view.reportSnapshotStream();
      }
      if (lastSnap !== null) {
        emitFrame(lastSnap);
      }
    },
    onLifecycle: view.emitLifecycle,
  });

  if (mode === "snapshot") {
    view.runSnapshot(() => {
      handle.dispose();
      armedHandle.dispose();
    });
  } else {
    view.installSigintHandler(() => {
      handle.dispose();
      armedHandle.dispose();
    });
  }
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical
// entry; direct `bun cli/board.ts` invocation bypasses the dispatcher's
// arg-pruning.
