/**
 * Pure resume-descriptor helpers — ONE DISPLAY form plus ONE LAUNCH form,
 * shared by the resume producers.
 *
 *  - DISPLAY ({@link buildResumeCommand}): the human-facing
 *    `claude --resume "<target>"` shell string `scripts/resume.ts` prints.
 *    Byte-unchanged, alias-shaped (a bare `claude` token a human pastes).
 *  - LAUNCH ({@link buildResumeLaunchForm}): the alias-independent,
 *    quoting-safe argv the crash-restore util
 *    ({@link import("../scripts/restore-agents").buildResumeLaunchArgv}) spawns.
 *    It rides an ABSOLUTE `keeper agent` launcher prefix (injected by the
 *    caller) + the resume tokens as positional `"$@"` args, so no `claude`
 *    alias is needed and no shell metacharacter in the session name can fire.
 *    (`keeper bus wake` now resumes via the unified `agentwrapLaunch` transport,
 *    not this form.)
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
 * This is the DISPLAY form — the bare `claude --resume` string a human pastes
 * (`scripts/resume.ts`). The LAUNCH producers do NOT use it (a bare `claude`
 * relies on the `claude → keeper agent claude` alias, which is shell-specific
 * and absent under a `-c` body); they call {@link buildResumeLaunchForm}.
 *
 * fn-10 inverted tier routing: the resume command no longer carries a
 * `--plugin-dir` tier-plugin flag. `claude --resume` re-attaches to an
 * existing session whose plugin set is already pinned, and the `plan` plugin
 * is always loaded, so the tier is irrelevant to re-attachment. The `tier`
 * argument is still THREADED through the resume-descriptor chain (resolved via
 * {@link tierForJobFromEpics}) so keeper's board/projection `task.tier` reads
 * stay intact; it just no longer shapes the emitted argv.
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
 * Build the LAUNCH-form resume argv — the alias-independent, quoting-safe
 * command the two launch producers spawn into a tmux window. Mirrors
 * `buildDispatchLaunchArgv` (`src/dispatch-command.ts`): a login+interactive
 * shell wrapper whose `-c` body is the FIXED literal `"$@" ; exec "$0" -l -i`
 * — NO caller data is interpolated, so a `target` carrying single quotes,
 * `$VAR`, backticks, `$(...)`, a newline, `;`, or a leading dash crosses the
 * shell boundary as a literal positional with zero escaping and cannot fire.
 *
 * Every command token rides as a positional in `"$@"`: the injected absolute
 * launcher `prefix` (`[<bun>, <abs cli/keeper.ts>, "agent"]` from
 * `buildLauncherArgvPrefix`), then `claude`, `--resume`, `<target>`,
 * `--agentwrap-no-confirm`. The absolute prefix is PATH-independent, so the
 * launch never depends on the `claude` alias or on `~/.bun/bin` being on PATH
 * — it survives both the login (profile PATH) and interactive (rc) shells
 * drifting. `prefix` is INJECTED so this builder stays PURE (the same shape
 * by which `shell` is injected).
 *
 * UNLIKE `buildDispatchLaunchArgv`, the command part is NOT `exec`'d: claude
 * must be a child so the trailing `exec "$0" -l -i` hold-open shell survives
 * claude exiting and holds the pane open. The `$0` slot is filled by repeating
 * `shell` so the first real positional is `$1` and `"$@"` runs the full
 * command (without it the prefix's first token is eaten as `$0` → claude
 * launches with no resume). No `cd` and no `--agentwrap-tmux*`: the tmux
 * transport already applies cwd via `new-window -c`, and the launch already
 * runs inside the tmux window the transport opened (a second would
 * double-nest). Identical positional mapping under bash and zsh. Pure.
 */
export function buildResumeLaunchForm(
  shell: string,
  prefix: string[],
  target: string,
): string[] {
  const body = `"$@" ; exec "$0" -l -i`;
  // `shell` fills the explicit `$0` slot so the first prefix token is NOT
  // eaten as $0; the resume tokens then ride as $1.. positionals.
  return [
    shell,
    "-l",
    "-i",
    "-c",
    body,
    shell,
    ...prefix,
    "claude",
    "--resume",
    target,
    "--agentwrap-no-confirm",
  ];
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
