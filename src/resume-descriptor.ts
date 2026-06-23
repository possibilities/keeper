/**
 * Pure resume-descriptor helpers shared by `scripts/resume.ts`, the restore
 * worker (epic fn-677, T3), and the `scripts/restore-agents.ts` util (T4) —
 * the three places that build a "this is the `claude --resume` command that
 * re-attaches to job X" descriptor. Extracting these here is THE invariant
 * that makes the trio byte-identical by construction: one formula, three
 * call sites.
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

import type { Epic, Job, Task } from "./types";

const seg = (v: unknown): string => (v == null ? "" : String(v));

/**
 * The `--resume` target for a job: its latest session NAME (`title`) when it has
 * one, else the `job_id` (the Claude session id) for a job that never carried a
 * name. `title` tracks the newest `name_history` entry, so this is the CURRENT
 * name keeper knows — resolved live from the jobs projection at resume time,
 * never a frozen one. `claude --resume "<name>"` filters the /resume picker to
 * that session; an exact `job_id` resolves directly. A degenerate job with no
 * name and no id coerces to the empty string (the producer invariant says this
 * never happens). Pure.
 */
export function resumeTarget(job: Pick<Job, "title" | "job_id">): string {
  const name = seg(job.title);
  return name !== "" ? name : seg(job.job_id);
}

/**
 * Build the resume shell command for a job. Mirrors `buildWorkerCommand`'s
 * `cd`-prefix shape, but the payload is `--resume "<target>"` instead of
 * `--name ... '/plan:<verb> ...'`. A null/empty `cwd` drops the `cd` prefix
 * (same degenerate-path rule as `buildWorkerCommand`).
 *
 * fn-10 inverted tier routing: the resume command no longer carries a
 * `--plugin-dir` tier-plugin flag. `claude --resume` re-attaches to an
 * existing session whose plugin set is already pinned, and the `plan` plugin
 * is always loaded, so the tier is irrelevant to re-attachment. The `tier`
 * argument is still THREADED through the resume-descriptor chain (resolved via
 * {@link tierForJobFromEpics}) so keeper's board/projection `task.tier` reads
 * stay intact and the three resume-command producers agree by construction;
 * it just no longer shapes the emitted argv.
 *
 * `target` is the job's latest name (`title`), falling back to its `job_id`
 * (see {@link resumeTarget}). `claude --resume "<value>"` resolves an exact
 * session id directly, or filters the /resume picker by the value as a search
 * term — so the current display name re-attaches to that session. Double-quoted
 * because a promoted name can contain spaces. Pure.
 */
export function buildResumeCommand(
  cwd: string,
  target: string,
  _tier: string | null,
): string {
  const cdPrefix = cwd === "" ? "" : `cd ${cwd} && `;
  return `${cdPrefix}claude --resume "${target}" --agentwrap-no-confirm`;
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
 * tier — the substrate that makes the three resume-command producers
 * byte-identical.
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
