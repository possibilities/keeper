/**
 * Pure resume-descriptor helpers — ONE DISPLAY form, shared by the resume
 * surfaces.
 *
 *  - DISPLAY ({@link buildResumeCommand}): the human-facing resume shell string
 *    `scripts/resume.ts` prints. PER-HARNESS: `claude --resume "<uuid>"` for
 *    claude, or the harness's own native form (`codex resume`, `pi --session`,
 *    `hermes --resume`) off the descriptor registry.
 *
 * There is NO separate LAUNCH form here: `keeper bus wake` and crash-restore
 * both resume via keeper's sole launch transport (`keeperAgentLaunch` in resume
 * mode, `src/exec-backend.ts`), which builds the harness-native resume invocation
 * itself. {@link resumeTarget} is the shared key both paths resolve — per-harness:
 * the session UUID for claude, the stored native id for codex/pi/hermes.
 *
 * Everything in this module is PURE — no socket, no fs, no `Date.now()`, no
 * env reads. `scripts/resume.ts` still owns the lazy per-epic UDS fetch loop
 * (one round-trip per distinct work-job epic, memoized); the worker (which
 * subscribes to the full epics projection in one shot) builds an
 * `epicsById: Map<string, Epic>` up front and calls
 * {@link tierForJobFromEpics} with it. Both paths end up at the same tier
 * string — the tier keeper still reads for the board/projection (fn-10
 * inverted tier routing: the worker is spawned as `plan:worker-<tier>` from
 * the emitted `worker_agent`, not selected via a `--plugin-dir` flag).
 */

import { HARNESS_DESCRIPTORS, harnessOrClaude } from "./agent/harness";
import type { Epic, Job, Task } from "./types";

const seg = (v: unknown): string => (v == null ? "" : String(v));

/**
 * The harness-native resume target for a job — the token its OWN `--resume` argv
 * needs, resolved per-harness from the launching-harness tag:
 *
 *  - claude (NULL/`"claude"` harness): the `job_id` — the Claude session UUID.
 *    `claude --resume "<uuid>"` resolves the EXACT session (browser-grade
 *    restore), where a name would only fuzzy-filter the /resume picker. pi pins
 *    its session id at launch too, but stores it in `resume_target`.
 *  - codex/pi/hermes: the stored `jobs.resume_target` — the harness's own native
 *    resume id (codex/hermes back-fill it post-stop, pi at seed). NULL/empty when
 *    keeper never resolved one, which renders that agent NOT-RESUMABLE (an empty
 *    string the restore surfaces surfaces with a reason, never a broken argv).
 *
 * The session's latest `title` feeds the DISPLAY label only (a candidate's
 * `label`), never the resume key. A degenerate claude job with no id coerces to
 * the empty string (the producer invariant says this never happens); a title
 * never rescues an empty id — a name is not an exact resume key. Pure.
 */
export function resumeTarget(
  job: Pick<Job, "job_id"> & {
    harness?: string | null;
    resume_target?: string | null;
  },
): string {
  if (harnessOrClaude(job.harness) === "claude") {
    return seg(job.job_id);
  }
  return seg(job.resume_target);
}

/**
 * Build the resume shell command for a job. Mirrors `buildWorkerCommand`'s
 * `cd`-prefix shape, but the payload is `--resume "<target>"` instead of
 * `--name ... '/plan:<verb> ...'`. A null/empty `cwd` drops the `cd` prefix
 * (same degenerate-path rule as `buildWorkerCommand`).
 *
 * This is the DISPLAY form — the bare `claude --resume` string a human pastes
 * (`scripts/resume.ts`). The launch surfaces (`keeper bus wake`, crash-restore)
 * do NOT use it (a bare `claude` relies on the `claude → keeper agent claude`
 * alias, which is shell-specific); they resume via `keeperAgentLaunch` in resume
 * mode (`src/exec-backend.ts`), which builds the `--resume <target>` argv off an
 * absolute launcher prefix.
 *
 * fn-10 inverted tier routing: the resume command no longer carries a
 * `--plugin-dir` tier-plugin flag. `claude --resume` re-attaches to an
 * existing session whose plugin set is already pinned, and the `plan` plugin
 * is always loaded, so the tier is irrelevant to re-attachment. The `tier`
 * argument is still THREADED through the resume-descriptor chain (resolved via
 * {@link tierForJobFromEpics}) so keeper's board/projection `task.tier` reads
 * stay intact; it just no longer shapes the emitted argv.
 *
 * `target` is the harness-native resume target (see {@link resumeTarget}). The
 * DISPLAY twin is per-harness: claude renders `claude --resume "<uuid>"`; a
 * non-claude harness renders its OWN native form — `codex resume "<t>"`,
 * `pi --session "<t>"`, `hermes --resume "<t>"` — off the descriptor's
 * `binaryName` + resume token. Neither carries a keeper launcher-only flag, so
 * the emitted string runs in any shell, alias or not. The
 * `cd <cwd> &&` prefix is LOAD-BEARING: a session id resolves only within the
 * session's project dir plus its git worktrees, so a present `cwd` must prefix
 * the command for resolution to succeed; a missing/torn-down cwd drops the prefix
 * and surfaces as that one resume's failure, never a batch abort. Double-quoted
 * for shape parity with `buildWorkerCommand`. Pure.
 */
export function buildResumeCommand(
  cwd: string,
  target: string,
  _tier: string | null,
  harness?: string | null,
): string {
  const cdPrefix = cwd === "" ? "" : `cd ${cwd} && `;
  const descriptor = HARNESS_DESCRIPTORS[harnessOrClaude(harness)];
  if (descriptor.name === "claude") {
    return `${cdPrefix}claude --resume "${target}"`;
  }
  return `${cdPrefix}${descriptor.binaryName} ${descriptor.resumeArgv.token} "${target}"`;
}

/**
 * Pure tier lookup for a `work`-bound job, given an in-memory `epicsById` map.
 * The job's `plan_ref` is the task id (`<epic-slug>.<N>`); strip the suffix
 * for the epic id, look up the epic in the map, find the matching task, return
 * `task.tier`. Returns `null` for any job that isn't a `work` job, has no
 * parseable task ref, or whose epic/task isn't in the map / has no tier.
 *
 * Pure: no I/O, no fetch. `scripts/resume.ts` keeps its lazy per-epic UDS
 * fetch loop and calls this helper once it has the epic; the restore worker
 * builds its `epicsById` up front from the same `epics` projection the
 * autopilot worker reads and calls this helper directly. Same formula, same
 * tier across the DISPLAY and LAUNCH producers.
 */
export function tierForJobFromEpics(
  job: Job,
  epicsById: Map<string, Epic>,
): string | null {
  if (job.plan_verb !== "work" || job.plan_ref == null) {
    return null;
  }
  const ref = seg(job.plan_ref);
  const taskMatch = /^(.+)\.\d+$/.exec(ref);
  if (taskMatch === null) {
    return null;
  }
  const epicId = taskMatch[1];
  const epic = epicsById.get(epicId);
  if (epic === undefined) {
    return null;
  }
  const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
  const task = tasks.find((t: Task) => seg(t.task_id) === ref);
  if (task === undefined || task.tier == null || seg(task.tier) === "") {
    return null;
  }
  return seg(task.tier);
}
