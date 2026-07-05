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
  renderDispatchFailurePill,
  renderTaskCellPills,
  renderTaskPills,
  sessionTelemetryPillSeg,
  startedPill,
  subagentLinesFor,
  validatedPill,
} from "../src/board-render";
import { DEFAULT_MAX_CONCURRENT_PER_ROOT, resolveSockPath } from "../src/db";
import { resolveFailureTarget } from "../src/dispatch-failure-pill";
import type { EpicDepResolution } from "../src/epic-deps";
import {
  formatPill,
  isEpicStarted,
  orderEpicsForScheduling,
  type Verdict,
} from "../src/readiness";
import {
  type ReadinessClientSnapshot,
  subscribeCollection,
  subscribeReadiness,
} from "../src/readiness-client";
import { appendDiagnostic } from "../src/readiness-diagnostics";
import { resolveSnapshotMode, SnapshotCliMisuseError } from "../src/snapshot";
import type {
  Epic,
  HandoffLinkEntry,
  JobLinkEntry,
  ResolvedEpicDep,
  SubagentInvocation,
} from "../src/types";
import { createViewShell } from "../src/view-shell";
// Autopilot banner — the SAME metadata `keeper autopilot` pins at its top, so
// `keeper board` reuses its pure projections + label rather than duplicating
// the wire-decode (single source of truth; these stay byte-identical to the
// autopilot viewer). The module is import-inert (its `import.meta.main` guard
// is neutralized), so pulling these symbols in spins up no second CLI.
import {
  autopilotBannerLabel,
  projectAutopilotMode,
  projectAutopilotPaused,
  projectMaxConcurrentJobs,
  projectMaxConcurrentPerRoot,
  projectWorktreeMode,
} from "./autopilot";

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

const HELP = `keeper board [--sock <path>] [--snapshot | --watch] [--timeout <s>]

Epics-only UI over the keeper subscribe server: one block per open epic
(header, task lines, nested job + sub-agent rows, close row), led by '---'.
Piped/non-TTY auto-detects snapshot mode; a TTY gets the live TUI.

Options:
  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --snapshot       Force one-shot snapshot mode (one frame + a parseable
                   keeper-meta: line, then exit) even on a TTY
  --watch          Force the live subscribe stream even when piped
  --timeout <s>    Snapshot wait before the timeout escape (default ~2s)
  --help           Show this help

TUI keys: ←/h/k prev frame · →/l/j next · g oldest · G/End/Esc live ·
  c copy frame+sidecar paths · q/Ctrl-C quit.

Examples:
  keeper board            # live board, default scope
  keeper board | tail -1  # one-shot snapshot; last line is parseable JSON
  keeper board --watch    # force the live stream even when piped

Pill glyphs use Nerd Font icons and show-defaults; the jobs list and
dead-letter banner are shown by 'keeper jobs'. A red '[failed:<kind>]' pill on
a task or close row marks a sticky dispatch_failures block readiness can't see
(kinds: multi-repo, merge-conflict, dirty-tree, non-ff).
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
/**
 * fn-941: render the iconized verdict pill for a TASK, distinguishing an
 * escalated `runtime-blocked` task from a plain blocked one. When the daemon
 * block-escalation producer has armed a `block_escalations` latch for the task
 * (membership in `escalatedTaskIds`) AND the verdict is `runtime-blocked`, the
 * pill renders `[blocked:escalated]` — "escalation pending / planner notified" —
 * instead of `[blocked:runtime-blocked]`. The `blocked:` prefix keeps it in the
 * amber warn family and inherits the ban glyph (same theming as every other
 * `blocked:*` pill). The escalated flag is read as a coarse yes/no, NOT the
 * latch's internal pending/requested/attempted state. Every other verdict
 * renders the standard {@link formatPill} text. Module-level + exported so a
 * synthetic-state unit test can assert the escalated-vs-plain distinction
 * without standing up the subscribe loop.
 */
export function taskVerdictPill(
  verdict: Verdict,
  taskId: string,
  escalatedTaskIds: ReadonlySet<string>,
): string {
  if (
    verdict.tag === "blocked" &&
    verdict.reason.kind === "runtime-blocked" &&
    escalatedTaskIds.has(taskId)
  ) {
    return iconizePills("[blocked:escalated]");
  }
  return iconizePills(formatPill(verdict));
}

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

/**
 * Per-job handoff edge lines — the sibling of {@link renderJobLinkLines} for
 * the job→job handoff relationship. Unlike `creator`/`refiner` (epic-anchored),
 * a handoff has no epic header to sit under, so these render on the job/session
 * surface off the job's own `handoff_links` array. Each {@link HandoffLinkEntry}
 * is denormalized off the peer `jobs` row at the reducer's write boundary, so
 * the render reads every field straight off the projection — no live-jobs join.
 * The line shape mirrors the job-link line:
 *
 *     {title ?? peer_job_id} [{kind}] [{state}]{apiErrorPillSeg}
 *       [awaiting:<kind>]   ← only when present, own continuation line
 *
 * `kind` is `handoff-from` (the initiator's row, pointing at the handoff-ee) or
 * `handoff-to` (the handoff-ee's row, pointing back at the initiator); the
 * icon-theme stamps the directional glyph, falling back to a missing-glyph pill
 * for the from-side-unknown case. Title falls back to `peer_job_id` when the
 * embedded `title` is null (e.g. an unfolded / orphan peer). Iteration order is
 * the projection's own stored sort — render must NOT re-sort.
 */
export function renderHandoffLinkLines(handoffLinks: unknown): string[] {
  if (!Array.isArray(handoffLinks) || handoffLinks.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const link of handoffLinks as HandoffLinkEntry[]) {
    const label = link.title ?? link.peer_job_id;
    // Same omit-default convention as the job-link line: the resting `stopped`
    // state renders NO pill; only live states stamp one. `pillOrEmpty`
    // self-delimits.
    const stateSeg = pillOrEmpty(link.state, "stopped");
    const awaiting = inputRequestPillSeg(
      link.last_input_request_at,
      link.last_input_request_kind,
    );
    const awaitingPP = permissionPromptPillSeg(
      link.last_permission_prompt_at,
      link.last_permission_prompt_kind,
    );
    out.push(
      `  ${label} ${pill(String(link.kind))}${stateSeg}${apiErrorPillSeg(link.last_api_error_at, link.last_api_error_kind)}`,
    );
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
  // The live sticky-failure sets, fed by a parallel `dispatch_failures`
  // subscription below (the readiness composite is pure and never reads the
  // sticky-failure projection). `closeFailures` is keyed by the RAW close id
  // (`fn-1-a` OR `worktree-finalize:<epic>-<hash>` / `worktree-recover:<path>`)
  // and resolved to its epic at RENDER time via `resolveFailureTarget` — the
  // epic→key join needs the full epic-id set, only present on the readiness
  // snapshot. `workFailures` is keyed by task id (a `work::` id is the task id
  // verbatim, so it resolves in this pass). `renderEpicBlock` reads both to
  // render the `[failed:<kind>]` pill on a jammed close row / blocked task.
  // Mutated in place (clear + re-add) on each edge so the closure identity the
  // renderer captured stays stable.
  const closeFailures = new Map<string, string>();
  const workFailures = new Map<string, string>();
  const seg = (v: unknown) => (v == null ? "" : String(v));

  // Autopilot banner state — the metadata `keeper autopilot` pins at its top
  // (paused/mode/caps/worktree), sourced over the socket from the
  // `autopilot_state` singleton; the armed count reuses `armedSet` above.
  // Seeded to the daemon's boot-safe defaults (paused · yolo · max ∞ · per-root
  // 1 · worktree:off); the first `autopilot_state` edge overwrites them. The
  // banner repaints from the `apBanner()` snapshot of this state on every
  // autopilot_state OR armed_epics edge, and the view-shell restores it after a
  // copy-key flash via the `persistentBannerPill` below.
  const apState = {
    paused: true,
    maxConcurrentJobs: null as number | null,
    maxConcurrentPerRoot: DEFAULT_MAX_CONCURRENT_PER_ROOT,
    mode: "yolo" as "yolo" | "armed",
    worktreeMode: false,
  };
  const apBanner = (): string =>
    autopilotBannerLabel({
      paused: apState.paused,
      maxConcurrentJobs: apState.maxConcurrentJobs,
      maxConcurrentPerRoot: apState.maxConcurrentPerRoot,
      mode: apState.mode,
      armedCount: armedSet.size,
      worktreeMode: apState.worktreeMode,
    });

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
        `    ${seg(job.title)}${roleSeg}${pillOrEmpty(job.state, "stopped")}${apiErrorPillSeg(job.last_api_error_at, job.last_api_error_kind)}${sessionTelemetryPillSeg(job)}`,
      );
      // [awaiting:<kind>] on its own continuation line (six-space indent —
      // same depth as this row's sub-agent lines below).
      if (awaiting !== "") {
        out.push(`      ${awaiting.trimStart()}`);
      }
      if (awaitingPP !== "") {
        out.push(`      ${awaitingPP.trimStart()}`);
      }
      // Handoff edges this job participates in (job→job, NOT epic-anchored).
      // Read defensively off the row — absent ≡ no edges. Indented one level
      // deeper to read as a sub-detail of the job row.
      for (const hline of renderHandoffLinkLines(job.handoff_links)) {
        out.push(`  ${hline}`);
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

  // Resolve the sticky CLOSE failure reason (if any) for this epic. The raw
  // `dispatch_failures` close id is `close::<epic>` OR a worktree-mode
  // `worktree-finalize:<epic>-<hash>` / `worktree-recover:<path>` form, so a
  // bare `closeFailures.get(epicId)` misses the worktree keys. Route each raw
  // key through the shared boundary-checked join and return the reason whose
  // resolved target is this epic. Failures are few → the per-epic scan is cheap.
  function closeFailureReasonFor(
    epicId: string,
    epicIds: readonly string[],
  ): string | undefined {
    for (const [rawId, reason] of closeFailures) {
      const target = resolveFailureTarget(
        { verb: "close", id: rawId, dir: "" },
        epicIds,
      );
      if (target?.kind === "epic" && target.epicId === epicId) {
        return reason;
      }
    }
    return undefined;
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
    const epicId = seg(row.epic_id);
    const lines: string[] = [];
    const epicVerdict = verdictFromMap(snap.readiness.perEpic, epicId);
    // The `{epic_number} {title}` label falls back to `epic_id` when both are
    // null (a pre-`EpicSnapshot` stub row), so the header is never blank.
    // `validatedPill`, `armedPill`, and `startedPill` all omit their default and
    // self-delimit, emitting their pill only at the non-resting value.
    const armedSeg = armedPill(armedSet.has(epicId));
    // `isEpicStarted` is null-safe, so the untyped-row → `Epic` cast (same trust
    // boundary as the seam's `snap.epics as Epic[]`) can't throw the renderer.
    const startedSeg = startedPill(isEpicStarted(row as unknown as Epic));
    const epicHeader = `${dirSeg}${epicHeaderLabel(row.epic_number, row.title, epicId)}${epicDepsSeg}${validatedPill(row.last_validated_at)}${armedSeg}${startedSeg}`;
    const epicHeaderLines =
      epicVerdict.tag === "blocked"
        ? [epicHeader, `  ${iconizePills(formatPill(epicVerdict))}`]
        : [`${epicHeader} ${iconizePills(formatPill(epicVerdict))}`];
    lines.push(...epicHeaderLines, ...renderJobLinkLines(row.job_links));
    // fn-941: the coarse "escalation in flight" set for this snapshot — task ids
    // carrying a `block_escalations` latch row. An escalated `runtime-blocked`
    // task renders `[blocked·escalated]` (planner notified) vs plain `[blocked:…]`.
    const escalatedTaskIds = new Set(
      snap.blockEscalations.map((e) => e.task_id),
    );
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
      // The trailing `[failed:<kind>]` pill sits inline after the verdict (e.g.
      // `[ready] [failed:multi-repo]`) when this task's `work::<task>` dispatch
      // is parked sticky in `dispatch_failures` — readiness can't see it.
      const taskPillSeg = `${taskVerdictPill(taskVerdict, taskId, escalatedTaskIds)}${taskRepoPillSeg(t.target_repo, row.project_dir)}${renderDispatchFailurePill(workFailures.get(taskId))}`;
      const taskIdLines =
        taskVerdict.tag === "blocked"
          ? [`    [${taskId}]`, `    ${taskPillSeg}`]
          : [`    [${taskId}] ${taskPillSeg}`];
      lines.push(
        // `renderTaskPills` consolidates the runtime_status / worker_phase /
        // approval triple, each rendering ONLY at its non-resting value (see
        // `keeper board --help` for the omit-default convention).
        `  ${seg(t.task_number)}. ${seg(t.title)}${taskDepsSeg}${renderTaskCellPills(t)}${renderTaskPills(t, taskVerdict)}`,
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
      // suppression as the task line. A trailing `[failed:<kind>]` pill renders
      // when this epic's `close::<epic>` is parked sticky in `dispatch_failures`
      // — the one signal that distinguishes a dispatchable close row from one
      // the reconciler already tried and that jammed (readiness can't see it).
      `  X. Quality audit and close${renderClosePills(row, closeVerdict)}${renderDispatchFailurePill(closeFailureReasonFor(epicId, [...epicIds]))}`,
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
    // Route the creation-order seed through the single scheduling-order seam:
    // started epics sort first (Rule #1), then `epic_number` within each tier.
    const epicsList = orderEpicsForScheduling(snap.epics as Epic[]);
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
    // Board folds FOUR streams — the readiness composite, the `armed_epics`
    // presence table, the `autopilot_state` singleton (the banner-metadata
    // substrate), and the `dispatch_failures` projection (the close-row
    // sticky-failure pill) — so the snapshot latch holds until ALL FOUR report
    // (readiness via the auto-report in `view.emit`; the other three via the
    // explicit `reportSnapshotStream` calls below).
    mode: mode === "snapshot" ? "snapshot" : "live",
    streamCount: 4,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    // The fixed banner row carries the autopilot metadata, mirroring the top of
    // `keeper autopilot`. Restored here after a copy-key flash expires.
    persistentBannerPill: apBanner,
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

  // Seed the banner immediately so the autopilot metadata is on screen before
  // the first `autopilot_state` edge lands (mirrors the autopilot viewer's
  // pre-snapshot seed).
  view.liveShell.setStatus(apBanner());

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
      // The armed count rides the autopilot banner — repaint it on every edge.
      view.liveShell.setStatus(apBanner());
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

  // The `autopilot_state` singleton feeds the banner's paused/mode/caps/worktree
  // metadata — the same wire row + pure projections `keeper autopilot` reads, so
  // the two banners can't drift. Keyed on `id = 1`; at most one row. An empty
  // result (singleton not yet folded on a fresh board) leaves the boot-default
  // seed untouched. Report to the snapshot latch exactly once (BEFORE the
  // empty-rows path's no-op return so a freshly-booted daemon doesn't hang the
  // snapshot until timeout); inert in live mode.
  let autopilotStreamReported = false;
  const autopilotHandle = subscribeCollection({
    sockPath,
    idPrefix: "board",
    collection: "autopilot_state",
    onRows: (rows) => {
      if (!autopilotStreamReported) {
        autopilotStreamReported = true;
        view.reportSnapshotStream();
      }
      const paused = projectAutopilotPaused(rows);
      if (paused === null) {
        // Singleton not yet folded — keep the seed and wait for the next edge.
        return;
      }
      apState.paused = paused;
      apState.maxConcurrentJobs = projectMaxConcurrentJobs(rows);
      apState.maxConcurrentPerRoot = projectMaxConcurrentPerRoot(rows);
      apState.mode = projectAutopilotMode(rows) ?? "yolo";
      apState.worktreeMode = projectWorktreeMode(rows) ?? false;
      view.liveShell.setStatus(apBanner());
    },
    onLifecycle: view.emitLifecycle,
  });

  // A parallel `dispatch_failures` subscription — the readiness composite is
  // pure and never reads the sticky-failure projection, so a `close::<epic>` OR
  // `work::<task>` dispatch that failed STICKY (e.g. a worktree merge conflict,
  // a multi-repo gate) renders as a dispatchable `[ready]` row with no sign
  // autopilot is jammed. On each edge we rebuild BOTH sticky-failure maps in
  // place in ONE pass: `closeFailures` keyed by the RAW close id (resolved to
  // its epic at render time, so worktree-mode keys join), `workFailures` keyed
  // by task id (a `work::` id is the task id verbatim). Then re-emit so the
  // `[failed:<kind>]` pill repaints live. Report to the snapshot latch exactly
  // once; inert in live mode. No second subscription (no 5th latch / race).
  let closeFailStreamReported = false;
  const closeFailHandle = subscribeCollection({
    sockPath,
    idPrefix: "board",
    collection: "dispatch_failures",
    onRows: (rows) => {
      closeFailures.clear();
      workFailures.clear();
      for (const r of rows) {
        const verb = seg(r.verb);
        const id = seg(r.id);
        if (id === "") {
          continue;
        }
        const reason = seg(r.reason);
        if (verb === "close") {
          closeFailures.set(id, reason);
        } else if (verb === "work") {
          const target = resolveFailureTarget(
            { verb, id, dir: seg(r.dir) },
            [],
          );
          if (target?.kind === "task") {
            workFailures.set(target.taskId, reason);
          }
        }
      }
      // Re-emit BEFORE reporting the stream. `reportSnapshotStream` can resolve
      // the snapshot latch SYNCHRONOUSLY (this is the 4th of four reports), and
      // a resolve reads the captured frame and exits the process — so the
      // capture must already reflect this edge's `closeFailures` mutation, or
      // the snapshot prints the stale pill-less frame. Inert ordering in live
      // mode (no latch). `lastSnap !== null` implies readiness already emitted,
      // so this re-emit never double-reports the primary latch.
      if (lastSnap !== null) {
        emitFrame(lastSnap);
      }
      if (!closeFailStreamReported) {
        closeFailStreamReported = true;
        view.reportSnapshotStream();
      }
    },
    onLifecycle: view.emitLifecycle,
  });

  if (mode === "snapshot") {
    view.runSnapshot(() => {
      handle.dispose();
      armedHandle.dispose();
      autopilotHandle.dispose();
      closeFailHandle.dispose();
    });
  } else {
    view.installSigintHandler(() => {
      handle.dispose();
      armedHandle.dispose();
      autopilotHandle.dispose();
      closeFailHandle.dispose();
    });
  }
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical
// entry; direct `bun cli/board.ts` invocation bypasses the dispatcher's
// arg-pruning.
