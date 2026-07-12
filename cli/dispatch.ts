#!/usr/bin/env bun
/**
 * `keeper dispatch` — a manual escape hatch to fire ONE `claude` worker into a
 * tmux window by hand, parallel to (and independent of) the server-side
 * autopilot reconciler.
 *
 * Two mutually-exclusive modes:
 *   - **plan form** (`keeper dispatch <work|close>::<id>`): resolves the
 *     canonical `/plan:<verb> <id>` prompt + cwd from the daemon's `epics`
 *     projection, bakes `--name <verb>::<id>` so the SessionStart hook binds a
 *     board-visible `jobs` row (autopilot dedups POST-bind), and refuses (a
 *     best-effort race guard) when a live/pending slot exists or autopilot is
 *     unpaused — unless `--force`.
 *   - **free form** (`--prompt "<text>"` / `--prompt-file <path>`): launches an
 *     arbitrary prompt. `--name` is OPTIONAL and a pure pass-through — when
 *     supplied it is forwarded verbatim as `claude --name <value>` and is NOT a
 *     keeper labeling/correlation concept; when omitted no `--name` is passed at
 *     all. (CAVEAT: keeper's SessionStart hook still scrapes any `claude --name`
 *     keeper-wide, so a `verb::id`-shaped `--name` can still bind to that plan
 *     row — excluding dispatch names from that is a deeper hook change, out of
 *     scope here.) When `dispatch_prompt_prefix` is configured, the free-form
 *     prompt launches as `<prefix> <prompt>` (unless `--no-prefix`); plan form
 *     is never prefixed.
 *
 * Launch is purely CLIENT-SIDE via a direct `keeperAgentLaunch(...)` (keeper's
 * sole launch transport) — no daemon RPC, no synthetic event, no
 * reducer/migration touch — so re-fold determinism and the five-surface
 * RPC-write invariant hold by construction.
 *
 * Exit taxonomy (mirrors `cli/autopilot.ts`): `die` → 1 (resolution / launch
 * failure), arg fault → 2 (mode misuse, bad prompt), `--help` → 0.
 *
 * Session resolution order: `--session` > `$KEEPER_TMUX_SESSION` (non-empty) >
 * `$TMUX`-gated current session > `work`. The resolved session is echoed;
 * a `work` fallback outside tmux prints a `tmux attach` hint.
 *
 * TOCTOU between the race-guard read and the launch is inherent for a
 * client-side manual hatch and is accepted — the guard is a courtesy, not a
 * lock; `--force` skips it entirely.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadMatrixV2, MatrixConfigError } from "../src/agent/matrix";
import { parseTriple } from "../src/agent/triple";
import { KEEPER_ROOT } from "../src/autopilot-worker";
import { GIT_LOCAL_TIMEOUT_MS, gitExec } from "../src/commit-work/git-exec";
import {
  resolveConfig,
  resolveKeeperAgentPath,
  resolveSockPath,
} from "../src/db";
import {
  buildDispatchLaunchArgv,
  type DispatchableVerb,
  defaultPlanPrompt,
  parseDispatchableKey,
  validatePromptBytes,
} from "../src/dispatch-command";
import { assertNever } from "../src/dispatch-failure-key";
import { resolveDispatchLaunchConfig } from "../src/dispatch-launch-config";
import type { LaunchResult, LaunchSpec } from "../src/exec-backend";
import { keeperAgentLaunch } from "../src/exec-backend";
import { buildLauncherArgvPrefix } from "../src/keeper-agent-path";
import type { QueryFrame, Row } from "../src/protocol";
import { loadProviderEquivalenceSnapshot } from "../src/provider-equivalence";
import type { HostMatrixAxes } from "../src/reconcile-core";
import {
  applyProviderConstraint,
  isWrappedCell,
  wrappedEnvelopePath,
} from "../src/reconcile-core";
import {
  composeWorkerCellDir,
  defaultShadowingWorkProbe,
  providerRejectReason,
  resolveWorkerCell,
  type WorkerCellCompose,
} from "../src/worker-cell";
import { KEEPER_EPIC_BRANCH_PREFIX, listWorktrees } from "../src/worktree-git";
import { repoToken } from "../src/worktree-plan";
import { queryCollection } from "./control-rpc";
import { buildParseOptions, DISPATCH_FLAGS } from "./descriptor";

/**
 * The collection-read seam — `queryCollection`'s signature minus the `R` type
 * param. Injected into {@link resolvePlanCwd} / {@link checkRaceGuard} so unit
 * tests drive them with a stub that returns canned rows (or throws to simulate
 * a daemon-unreachable read) without opening a socket.
 */
export type QueryFn = (
  collection: string,
  filter?: QueryFrame["filter"],
) => Promise<Row[]>;

/**
 * The launch seam. Injected into {@link main} so a launch-path test runs against
 * a fake launch (asserting the success / `result.ok === false` branches) without
 * spawning a real tmux window. Defaults to a direct {@link keeperAgentLaunch} into
 * the resolved session.
 *
 * keeper agent is the sole launch transport: it builds its invocation from `spec`
 * (the structured prompt + claude flags) and owns the tmux window, IGNORING the
 * pre-wrapped `argv`. `argv`/`name` are retained at the seam so the dry-run line
 * keeps printing the shell-wrapped argv shape; the launch impl reads `spec`.
 */
export type LaunchFn = (
  session: string,
  argv: string[],
  cwd: string,
  name: string,
  spec: LaunchSpec,
) => Promise<LaunchResult>;

/** Injectable seams for {@link main} so integration tests drive the orchestration
 *  without a daemon socket or a real tmux backend. */
export interface MainDeps {
  /** The collection-read transport. Defaults to a real `queryCollection`
   *  against the resolved socket. */
  readonly query?: QueryFn;
  /** The launch transport. Defaults to a direct `keeperAgentLaunch(...)`. */
  readonly launch?: LaunchFn;
  /** The configured global prompt prefix for FREE-FORM dispatches. Defaults to
   *  `resolveConfig().dispatchPromptPrefix`. Injected so tests drive the
   *  prefixing without writing a config.yaml; `undefined` = no prefix. */
  readonly promptPrefix?: string;
  /** On-disk cwd existence probe for plan-form resolution. Defaults to
   *  `existsSync`; injected so a test drives the `cwd-missing` branch (or
   *  asserts a resolved-but-nonexistent fixture path) without a real dir. */
  readonly dirExists?: (dir: string) => boolean;
  /** Epic lane-worktree resolver for a `close::` dispatch. Defaults to the
   *  bounded `git worktree list` probe; injected so a test drives the lane /
   *  fallback branches with a fake worktree list and zero real git. */
  readonly resolveLaneDir?: (
    projectDir: string,
    epicId: string,
  ) => Promise<string | null>;
  /** Scan-dir shadow probe for the `work::` worker-cell resolution. Defaults to
   *  the fresh `defaultShadowingWorkProbe` (a real plugin-config scan); injected
   *  so a test drives the shadowed-cell reject without live config. A dispatch
   *  fires ONE worker, so a per-launch fresh scan is fine (no hot loop). */
  readonly probeShadowingWorkManifest?: () => string | null;
}

const HELP = `keeper dispatch — manually fire one claude worker into a tmux window

Usage:
  keeper dispatch <work|close|unblock|deconflict|repair>::<id> [options]  # plan form
  keeper dispatch --prompt "<text>" [options]       # free form
  keeper dispatch --prompt-file <path> [options]    # free form
  keeper dispatch --help

Plan form resolves the /plan:<verb> <id> prompt + cwd from the daemon and bakes
--name <verb>::<id> so the hook binds a board-visible jobs row. The five
plan-form verbs, by id scope:
  work::fn-N.M      task-scoped  fire the worker in the task's repo
  unblock::fn-N.M   task-scoped  escalation session for a blocked task
  close::fn-N       epic-scoped  close the epic (its lane worktree when present)
  deconflict::fn-N  epic-scoped  escalation session for an epic merge conflict
  repair::<token>   repo-scoped  escalation session for a shared-base-broken repo;
                     <token> is a '<slug>-<hash>' repo token (the SAME convention
                     worktree lane dirs use), resolved to a repo by hashing every
                     epic's project_dir/task target_repo — an unresolvable token
                     is a typed error, never a guess
Free form launches an arbitrary prompt; --name is OPTIONAL and forwarded
verbatim to claude (no keeper labeling). When omitted, no --name is passed at all.

Options:
  --prompt <text>      Free-form prompt (mutually exclusive with the positional)
  --prompt-file <path> Read the free-form prompt from a file
  --name <n>           claude --name (OPTIONAL pass-through in free form)
  --session <s>        Target tmux session (overrides every fallback)
  --cwd <dir>          Working dir (free form; defaults to process.cwd())
  --preset <triple>    A launch triple <harness::model::effort> (claude-only);
                       supplies --model/--effort. Must be a well-formed triple
                       (exit 2 otherwise); run \`keeper agent presets list\` to see
                       the cube. Plan form defaults to the same 'worker' triple the
                       autopilot uses.
  --model <m>          Pass --model to claude (overrides the triple)
  --effort <e>         Pass --effort to claude (overrides the triple)
  --force              Plan form: skip the race guard
  --no-prefix          Free form: bypass the configured dispatch_prompt_prefix
  --dry-run            Print the resolved launch plan; launch nothing
  --sock <path>        Daemon socket path override
  --help, -h           Show this help

Session resolution: --session > $KEEPER_TMUX_SESSION > $TMUX current > work.

Run \`keeper dispatch --agent-help\` for the terse operator runbook.
`;

/** Terse operator runbook (agent-facing), distinct from the full `--help`. */
const AGENT_HELP = `keeper dispatch — operator runbook (agent-facing)

Fire ONE claude worker by hand. Two forms:
  Plan form:  keeper dispatch <work|close|unblock|deconflict>::<id>
              keeper dispatch repair::<repo-token>
              work::fn-N.M and unblock::fn-N.M are task-scoped; close::fn-N and
              deconflict::fn-N are epic-scoped; repair::<token> is REPO-scoped
              (unblock/deconflict/repair boot the escalation session). Resolves
              the /plan:<verb> <id> prompt + cwd from the daemon and bakes
              --name so the hook binds a jobs row.
  Free form:  keeper dispatch --prompt "<text>" [--name <n>] [--cwd <dir>]
              Arbitrary prompt; --name is an OPTIONAL verbatim pass-through.

Preflight:  keeper dispatch <key> --dry-run   # print the resolved launch plan, launch nothing

Exit codes: 0 launched · 1 launch/daemon failure · 2 arg fault (mode misuse,
missing prompt, unknown --preset). NOT for routine plan execution (that is
/plan:work) or resuming a stuck retry (that is keeper autopilot retry).
`;

const FALLBACK_SESSION = "work";

function die(message: string): never {
  process.stderr.write(`dispatch: ${message}\n`);
  process.exit(1);
}

function argFault(message: string): never {
  process.stderr.write(`dispatch: ${message}\n`);
  process.exit(2);
}

/** Minimal shape of an `epics` row we read for cwd + worker-cell resolution.
 *  The `model`/`tier` axes ride the epics-projection `tasks[]` elements the same
 *  walk already reads (`src/reducer.ts` serializes both), so the launcher
 *  resolves the task's `{model, tier}` cell from one fetch, one source. */
interface EpicRow extends Row {
  epic_id?: string;
  project_dir?: string | null;
  tasks?: Array<{
    task_id?: string;
    target_repo?: string | null;
    model?: string | null;
    tier?: string | null;
  }> | null;
}

/**
 * Resolve the epic's lane worktree dir from a SINGLE bounded `git worktree list`
 * in `projectDir`, filtered to the epic base branch `keeper/epic/<epicId>`.
 * Returns the lane path, or null when no lane worktree is registered (a
 * non-worktree epic, or the lane was torn down). Any git failure / timeout fails
 * open to null — the caller falls back to `project_dir` with a warning. Bounded
 * to one local git op so a manual `close::` dispatch never spawns unbounded work.
 */
async function resolveEpicLaneWorktree(
  projectDir: string,
  epicId: string,
): Promise<string | null> {
  const target = `${KEEPER_EPIC_BRANCH_PREFIX}${epicId}`;
  let entries: Awaited<ReturnType<typeof listWorktrees>>;
  try {
    entries = await listWorktrees(projectDir, (args, opts) =>
      gitExec(args, { ...opts, timeoutMs: GIT_LOCAL_TIMEOUT_MS }),
    );
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.branch === null) {
      continue;
    }
    const short = e.branch.startsWith("refs/heads/")
      ? e.branch.slice("refs/heads/".length)
      : e.branch;
    if (short === target) {
      return e.path;
    }
  }
  return null;
}

/**
 * Resolve the launch cwd for a plan-form dispatch from the `epics` projection.
 * Mirrors the reconciler's cwd rules (`src/autopilot-worker.ts`):
 *   - work: the parent epic's `tasks[]` entry → `target_repo ?? project_dir`.
 *   - close: the epic lane worktree (`keeper/epic/<epic_id>`) when one is
 *     registered — so a lane-only commit set is visible — else `project_dir`.
 * Returns a discriminated result so the caller distinguishes daemon-unreachable
 * (transport throw) from not-found / empty-cwd / cwd-missing (resolution miss)
 * for distinct error text + a clean exit 1 that launches nothing. On the close
 * fallback the result carries a `warning` the caller prints (best-effort note,
 * never a launch block).
 *
 * `dirExists` is the on-disk existence probe (defaults to `existsSync`),
 * injected for tests. A resolved cwd that does not exist on disk — typically a
 * renamed-away repo dir — fails LOUD with `cwd-missing: <path>` instead of
 * launching a worker into a stale path that silently never runs. Remediation:
 * `keeper plan mv-repo <old> <new>`. `resolveLaneDir` is the lane-resolution
 * seam (defaults to the bounded git probe), injected for tests.
 */
export async function resolvePlanCwd(
  query: QueryFn,
  verb: DispatchableVerb,
  id: string,
  dirExists: (dir: string) => boolean = existsSync,
  resolveLaneDir: (
    projectDir: string,
    epicId: string,
  ) => Promise<string | null> = resolveEpicLaneWorktree,
): Promise<
  | {
      ok: true;
      cwd: string;
      warning?: string;
      /** The matched `work` task's cell axes off the same `tasks[]` walk (both
       *  serialized on the projection element) — the launcher resolves the
       *  {model, tier} worker cell from these. Absent for `close` rows. */
      model?: string | null;
      tier?: string | null;
    }
  | { ok: false; error: string }
> {
  // repair::<repo-token> is REPO-scoped, not epic/task-scoped — id is a repo
  // token, never an fn-shaped ref, so it can't join the `epics` filter below by
  // epic_id. Resolve it by scanning every epic for a project_dir or task
  // target_repo that hashes to the token (the SAME `repoToken` derivation
  // worktree lane paths use), landing the session in that repo's SHARED
  // checkout — never a lane-or-project resolution. An unresolvable token is a
  // typed error, never a guess.
  if (verb === "repair") {
    let allRows: EpicRow[];
    try {
      allRows = (await query("epics")) as EpicRow[];
    } catch (err) {
      return {
        ok: false,
        error: `cannot reach daemon to resolve cwd (${(err as Error).message})`,
      };
    }
    const seen = new Set<string>();
    for (const epic of allRows) {
      const candidates: string[] = [];
      if (typeof epic.project_dir === "string" && epic.project_dir !== "") {
        candidates.push(epic.project_dir);
      }
      for (const t of epic.tasks ?? []) {
        if (typeof t.target_repo === "string" && t.target_repo !== "") {
          candidates.push(t.target_repo);
        }
      }
      for (const dir of candidates) {
        if (seen.has(dir)) {
          continue;
        }
        seen.add(dir);
        if (repoToken(dir) === id) {
          if (!dirExists(dir)) {
            return { ok: false, error: `cwd-missing: ${dir}` };
          }
          return { ok: true, cwd: dir };
        }
      }
    }
    return {
      ok: false,
      error:
        `unknown repo token '${id}': no epic's project_dir or task target_repo ` +
        "hashes to it (see `keeper query epics`)",
    };
  }

  // work: id is a task id `fn-N-slug.M` whose parent epic is the `fn-N-slug`
  // prefix. close: id IS the epic id. The epic filter resolves both. The two
  // epic/task-scoped escalation verbs mirror those shapes exactly —
  // `unblock::<task>` is task-scoped like work, `deconflict::<epic>` is
  // epic-scoped like close — so each resolves its cwd through the same branch
  // (the unblock session runs in the blocked task's repo; the deconflict
  // session runs in the epic lane where the merge conflict lives, exactly
  // like the resolver).
  const taskScoped = verb === "work" || verb === "unblock";
  const epicScoped = verb === "close" || verb === "deconflict";
  const epicId = taskScoped ? id.replace(/\.\d+$/, "") : id;
  let rows: EpicRow[];
  try {
    rows = (await query("epics", { epic_id: epicId })) as EpicRow[];
  } catch (err) {
    return {
      ok: false,
      error: `cannot reach daemon to resolve cwd (${(err as Error).message})`,
    };
  }
  const epic = rows.find((r) => r.epic_id === epicId);
  if (epic === undefined) {
    return {
      ok: false,
      error: `no epic '${epicId}' in the board (unknown id, or the daemon hasn't folded it yet)`,
    };
  }
  const projectDir =
    typeof epic.project_dir === "string" ? epic.project_dir : "";
  if (epicScoped) {
    if (projectDir === "") {
      return { ok: false, error: `epic '${epicId}' has no project_dir` };
    }
    if (!dirExists(projectDir)) {
      return { ok: false, error: `cwd-missing: ${projectDir}` };
    }
    // Worktree epic: run the closer IN the epic lane (as the reconciler does) so
    // a lane-only commit set is visible. No lane worktree (non-worktree epic, or
    // torn down) → fall back to project_dir with a note.
    let laneDir: string | null;
    try {
      laneDir = await resolveLaneDir(projectDir, epicId);
    } catch {
      laneDir = null;
    }
    if (laneDir !== null && dirExists(laneDir)) {
      return { ok: true, cwd: laneDir };
    }
    return {
      ok: true,
      cwd: projectDir,
      warning: `no epic lane worktree for '${epicId}'; launching close in ${projectDir}`,
    };
  }
  // work / unblock: walk the parent epic's tasks for the matching task id.
  const task = (epic.tasks ?? []).find((t) => t.task_id === id);
  if (task === undefined) {
    return {
      ok: false,
      error: `no task '${id}' under epic '${epicId}'`,
    };
  }
  const cwd =
    typeof task.target_repo === "string" && task.target_repo !== ""
      ? task.target_repo
      : projectDir;
  if (cwd === "") {
    return {
      ok: false,
      error: `task '${id}' resolves to an empty cwd (no target_repo and no epic project_dir)`,
    };
  }
  if (!dirExists(cwd)) {
    return { ok: false, error: `cwd-missing: ${cwd}` };
  }
  // Carry the task's cell axes off the SAME element — the caller resolves the
  // {model, tier} worker cell from these (single fetch, single source; main()
  // never re-walks the projection).
  return {
    ok: true,
    cwd,
    model: task.model ?? null,
    tier: task.tier ?? null,
  };
}

/**
 * Plan-form race guard. Best-effort scan: refuses (naming the tripped condition
 * and the right-path recovery) when a `pending_dispatches` row for the key
 * exists, autopilot is unpaused, or a `working`/`stopped` job carries the plan
 * key (client-side scan — `jobs` has no `plan_verb`/`plan_ref` filter). Each
 * refusal names the recovery BEFORE `--force` (the caller appends the `--force`
 * suffix, keeping it last): a stopped-but-live worker warm-resumes over the bus,
 * a dead one is reclaimed. Returns the tripped-condition string, or `null` when
 * clear. Skipped by the caller under `--force`.
 *
 * A daemon-unreachable read here is treated as "clear" — the launch surface
 * itself will fail loudly if the daemon is truly gone, and a manual hatch must
 * not be blocked by a transient read error.
 */
export async function checkRaceGuard(
  query: QueryFn,
  verb: DispatchableVerb,
  id: string,
): Promise<string | null> {
  const key = `${verb}::${id}`;
  try {
    const pending = await query("pending_dispatches", { verb, id });
    if (pending.length > 0) {
      return `a pending dispatch for ${key} is already in flight (pending_dispatches)`;
    }
    const state = await query("autopilot_state", { id: 1 });
    const paused = state[0]?.paused;
    if (paused === 0 || paused === false) {
      return "autopilot is unpaused — it may dispatch this key itself; pause it first";
    }
    // jobs has no plan_verb/plan_ref filter — scan the live set client-side.
    const jobs = await query("jobs");
    const live = jobs.find(
      (j) =>
        j.plan_verb === verb &&
        j.plan_ref === id &&
        (j.state === "working" || j.state === "stopped"),
    );
    if (live !== undefined) {
      // A stopped worker still occupies the slot (its launcher pane survives).
      // Name the right path first: warm-resume its session over the bus if it's
      // live, else reclaim the dead pane — --force (caller suffix) is last.
      if (live.state === "stopped") {
        return `a stopped worker for ${key} still holds the slot (job state=stopped); warm-resume its session over the bus, or reclaim the dead pane`;
      }
      return `a live worker for ${key} is running (job state=working); let it finish`;
    }
  } catch {
    // Transient read failure — do not block a manual launch on it.
    return null;
  }
  return null;
}

/** Injectable seam for {@link resolveSession} so tests drive the precedence
 *  without reading the real env or spawning tmux. */
export interface ResolveSessionDeps {
  /** The `--session` flag value (undefined when unset). */
  readonly sessionFlag: string | undefined;
  /** Env source — defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** `$TMUX`-gated current-session probe → the session name, or `null` when
   *  the probe fails / returns empty. Defaults to a real `tmux display-message`
   *  spawn; the caller only invokes it when `$TMUX` is set. */
  readonly probeCurrentSession?: () => string | null;
}

function probeCurrentTmuxSession(): string | null {
  const res = Bun.spawnSync([
    "tmux",
    "display-message",
    "-p",
    "#{session_name}",
  ]);
  if (res.exitCode !== 0) {
    return null;
  }
  const name = res.stdout.toString().trim();
  return name === "" ? null : name;
}

/**
 * Resolve the target tmux session per the documented precedence:
 * `--session` > `$KEEPER_TMUX_SESSION` (non-empty) > `$TMUX`-gated current
 * session > `work`. Returns the session plus whether we fell back to
 * `work` while OUTSIDE tmux (so the caller can print an attach hint).
 */
export function resolveSession(deps: ResolveSessionDeps): {
  session: string;
  attachHint: boolean;
} {
  const env = deps.env ?? process.env;
  if (deps.sessionFlag !== undefined && deps.sessionFlag !== "") {
    return { session: deps.sessionFlag, attachHint: false };
  }
  const envSession = env.KEEPER_TMUX_SESSION;
  if (envSession !== undefined && envSession !== "") {
    return { session: envSession, attachHint: false };
  }
  const inTmux = env.TMUX !== undefined && env.TMUX !== "";
  if (inTmux) {
    const probe = deps.probeCurrentSession ?? probeCurrentTmuxSession;
    const name = probe();
    if (name !== null) {
      return { session: name, attachHint: false };
    }
  }
  // Outside tmux (or the probe failed) → the managed work session.
  return { session: FALLBACK_SESSION, attachHint: !inTmux };
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    // Derived from the pure-data descriptor (ADR 0008).
    options: buildParseOptions(DISPATCH_FLAGS),
    allowPositionals: true,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.values["agent-help"]) {
    process.stdout.write(AGENT_HELP);
    process.exit(0);
  }

  const v = parsed.values;
  const sockPath = v.sock ?? resolveSockPath();
  const shell = process.env.SHELL ?? "/bin/sh";
  const dryRun = v["dry-run"] ?? false;

  const positional = parsed.positionals[0];
  const hasPlanKey = positional !== undefined;
  const hasPromptText = v.prompt !== undefined;
  const hasPromptFile = v["prompt-file"] !== undefined;
  const isFreeForm = hasPromptText || hasPromptFile;

  // Mode mutual-exclusion: exactly one of (positional key) or (free-form prompt).
  if (hasPlanKey && isFreeForm) {
    argFault(
      "modes are mutually exclusive: pass EITHER a <verb>::<id> positional OR --prompt/--prompt-file, not both",
    );
  }
  if (!hasPlanKey && !isFreeForm) {
    argFault(
      "nothing to dispatch: pass a <verb>::<id> positional OR --prompt/--prompt-file (see --help)",
    );
  }
  if (hasPromptText && hasPromptFile) {
    argFault("--prompt and --prompt-file are mutually exclusive");
  }
  if (parsed.positionals.length > 1) {
    argFault(
      `plan form takes exactly one <verb>::<id> positional (got ${parsed.positionals.length})`,
    );
  }

  // Parse the plan-form key up-front (the WIDER dispatchable set, so the two
  // escalation verbs are accepted) — the model/effort default below selects the
  // escalation vs worker launch config by verb, and the plan-form block reuses
  // the parsed pair. A malformed verb::id key is CLI misuse — exit 2.
  let planVerb: DispatchableVerb | undefined;
  let planId: string | undefined;
  if (hasPlanKey) {
    const keyResult = parseDispatchableKey(positional);
    if (!keyResult.ok) {
      argFault(keyResult.error);
    }
    planVerb = keyResult.verb;
    planId = keyResult.id;
  }

  // ---- resolve model/effort (claude-only) ----
  // Precedence per field: explicit --model/--effort > --preset triple >
  // dispatch[verb] triple (plan form only) > floor. Dispatch widens to claude
  // alone for now — LaunchSpec carries only claude model/effort (codex/pi dispatch
  // is a follow-up). The plan default resolves the verb's `dispatch:` row (ADR
  // 0040), floored to the same WORKER_*/ESCALATION_* constants the daemon path
  // uses — so a manual `keeper dispatch <verb>::<id>` launches byte-identically to
  // the autopilot's launch for that verb.
  let baseModel: string | undefined;
  let baseEffort: string | undefined;
  if (hasPlanKey) {
    const base = resolveDispatchLaunchConfig(planVerb as DispatchableVerb);
    baseModel = base.model;
    baseEffort = base.effort;
  }
  if (v.preset !== undefined && v.preset !== "") {
    const parsed = parseTriple(v.preset);
    if (!parsed.ok) {
      argFault(`--preset ${parsed.error}`);
    }
    const triple = parsed.triple;
    if (triple.harness !== "claude") {
      argFault(
        `--preset ${v.preset} pins harness ${triple.harness}; dispatch is ` +
          "claude-only (codex/pi dispatch is a follow-up)",
      );
    }
    // The triple carries both model and effort; each layers over the worker/plan
    // base, and the explicit --model/--effort flags below still win per field.
    baseModel = triple.model;
    baseEffort = triple.effort;
  }
  // Explicit flags win over any preset/worker default.
  const model = v.model ?? baseModel;
  const effort = v.effort ?? baseEffort;

  // Launch directly through `keeper agent` (keeper's sole launch transport) into
  // the resolved session — the same transport as the autopilot path. The
  // pre-wrapped `argv` is ignored; the launcher builds its invocation from `spec`.
  const launcherArgvPrefix = buildLauncherArgvPrefix(
    process.execPath,
    resolveKeeperAgentPath(),
  );
  const launch: LaunchFn =
    deps.launch ??
    ((session, _argv, cwd, name, spec) =>
      keeperAgentLaunch({
        noteLine: (line: string) => process.stderr.write(`${line}\n`),
        launcherArgvPrefix,
        session,
        cwd,
        label: name !== "" ? name : `session=${session}`,
        spec,
      }));

  let cwd: string;
  let prompt: string;
  // claude `--name` value. Plan form bakes `verb::id` (board-binding); free form
  // forwards `--name` verbatim ONLY when supplied (undefined = no `--name`).
  let claudeName: string | undefined;
  // Neutral status label for the dry-run line + post-launch message. In plan
  // form it is the `verb::id` key; in free form it is the prompt source — never
  // the free-form `--name` (which is a pure claude pass-through, not a keeper
  // labeling/correlation concept).
  let label: string;
  // The resolved per-cell worker `--plugin-dir` for a `work::` plan launch whose
  // task carries an in-matrix {model, tier}; undefined for a cell-less work row,
  // and NEVER set for close / free-form launches (those stay byte-identical).
  let workerPluginDir: string | undefined;
  // The DISPATCHED cell + constraint (ADR 0047) when the `worker_provider` pin
  // translated this `work::` launch's assigned cell into the other family — the
  // KEEPER_PLAN_DISPATCHED_* env carriers; undefined on an unconstrained /
  // same-family launch (byte-identical, empty carriers). Set alongside
  // `workerPluginDir` in the plan-form block below.
  let dispatchedCellModel: string | undefined;
  let dispatchedCellTier: string | undefined;
  let dispatchCellConstraint: string | undefined;
  // The wrapped-cell guard marker (task .1) for a `work::` launch whose EFFECTIVE
  // cell is wrapped — the KEEPER_WRAPPED_* env carriers; undefined for a native /
  // cell-less / free-form launch (byte-identical, empty carriers). Set alongside
  // `workerPluginDir` in the plan-form block, so a hand-fired wrapped worker is
  // guarded identically to an autopilot one.
  let dispatchWrappedCell: string | undefined;
  let dispatchWrappedEnvelope: string | undefined;

  if (hasPlanKey) {
    // ---- plan form ----
    // Parsed up-front (see the model/effort block) — reuse the pair here.
    const verb = planVerb as DispatchableVerb;
    const id = planId as string;
    const query: QueryFn =
      deps.query ??
      ((collection, filter) => queryCollection(sockPath, collection, filter));
    const cwdResult = await resolvePlanCwd(
      query,
      verb,
      id,
      deps.dirExists ?? existsSync,
      deps.resolveLaneDir ?? resolveEpicLaneWorktree,
    );
    if (!cwdResult.ok) {
      die(cwdResult.error);
    }
    if (cwdResult.warning !== undefined) {
      process.stderr.write(`dispatch: ${cwdResult.warning}\n`);
    }
    cwd = cwdResult.cwd;
    prompt = defaultPlanPrompt(verb, id);
    claudeName = `${verb}::${id}`;
    label = `${verb}::${id}`;

    if (!(v.force ?? false)) {
      const tripped = await checkRaceGuard(query, verb, id);
      if (tripped !== null) {
        die(
          `refusing to dispatch ${claudeName}: ${tripped} (pass --force to override)`,
        );
      }
    }

    // Worktree-mode refusal — `work::` only, AFTER the race guard. While the
    // board runs worktree mode ON, autopilot gives each ready task its own lane
    // worktree; a hand-fired worker into the shared checkout is wrong-topology
    // (concurrent lanes collide). Refuse loud naming BOTH recoveries, unless
    // `--force` deliberately launches into the shared checkout (the repo's
    // fail-closed-unless-force precedent). Read the singleton `worktree_mode`
    // client-side via the SAME query seam as the race guard (`worktree_mode === 1`
    // is ON, every other value OFF); a daemon-unreachable read FAILS OPEN like
    // the race guard — a down daemon means this manual hatch IS the recovery.
    // Runs under `--dry-run` too, so the dry-run reflects the refusal a real run
    // would hit rather than printing misleading argv. Ephemeral stderr only — no
    // synthetic event, no board row. `close::`, resume, and free-form are untouched.
    if (verb === "work" && !(v.force ?? false)) {
      let worktreeMode = false;
      try {
        const st = await query("autopilot_state", { id: 1 });
        worktreeMode = st[0]?.worktree_mode === 1;
      } catch {
        // Transient read failure — fail open, do not block a manual launch.
      }
      if (worktreeMode) {
        die(
          `refusing to dispatch ${claudeName} into the shared checkout: the board is in ` +
            "worktree mode, so autopilot provisions a per-task lane worktree — let " +
            "autopilot dispatch it (pause it and it resumes on play), or re-run with " +
            "--force to deliberately launch in the shared checkout",
        );
      }
    }

    // Resolve the task's per-cell worker plugin — `work::` only. Compose the
    // {model, tier} cell fresh from the projection axes `resolvePlanCwd` carried,
    // LOADING the host matrix itself at invocation (`composeWorkerCellDir`), then run
    // the SAME resolution seam the autopilot producer uses (fresh filesystem probes
    // here; the producer injects its per-cycle memoized shadow closure). A
    // partial/absent cell (either axis null) launches cell-less exactly like the
    // producer — parity, never a reject. Any reject exits 1 with a three-part
    // actionable error (what was being launched, which cell/matrix is wrong, what to
    // do next) instead of spawning a doomed worker. Runs under `--dry-run` too so it
    // reflects the reject a real run would hit. The switch is closed by `assertNever`
    // — a new reject kind fails compilation here.
    if (verb === "work") {
      // Apply the `worker_provider` pin (ADR 0047) BEFORE composing the cell so a
      // manual dispatch and autopilot resolve the SAME dispatched cell for the same
      // task + pin. Read the pin client-side (same query seam as the worktree
      // refusal); a daemon-unreachable read FAILS OPEN (dispatch the assigned cell).
      const assignedModel = cwdResult.model ?? null;
      const assignedTier = cwdResult.tier ?? null;
      let composeModel = assignedModel;
      let composeTier = assignedTier;
      let providerReject: WorkerCellCompose["providerReject"];
      let workerProvider: "claude" | "codex" | null = null;
      // Load the host-matrix axes ONCE — reused for the provider-constraint
      // target-on-host check AND the wrapped-cell marker below. A bad matrix defers
      // to composeWorkerCellDir's own bad-matrix reject (ranks first): axes stays
      // null, translation is skipped, and the assigned cell composes (then rejects).
      let axes: HostMatrixAxes | null = null;
      try {
        const m = loadMatrixV2();
        axes = {
          models: m.subagentModels,
          effortsByModel: m.effortsByModel,
          efforts: m.efforts,
          driverByModel: m.driverByModel,
        };
      } catch (err) {
        if (!(err instanceof MatrixConfigError)) throw err;
      }
      try {
        const st = await query("autopilot_state", { id: 1 });
        const raw = (st[0] as { worker_provider?: unknown } | undefined)
          ?.worker_provider;
        workerProvider = raw === "claude" || raw === "codex" ? raw : null;
      } catch {
        // Transient read failure — fail open, dispatch the assigned cell.
      }
      if (
        workerProvider !== null &&
        assignedModel !== null &&
        assignedTier !== null &&
        axes !== null
      ) {
        const result = applyProviderConstraint(
          { model: assignedModel, effort: assignedTier },
          workerProvider,
          loadProviderEquivalenceSnapshot(),
          axes,
        );
        if (result.kind === "reject") {
          providerReject = {
            reason: result.reason,
            provider: result.provider,
            direction: result.direction,
            assigned: result.assigned,
            target: result.target,
            ...(result.detail !== undefined ? { detail: result.detail } : {}),
          };
        } else if (result.kind === "translated") {
          composeModel = result.cell.model;
          composeTier = result.cell.effort;
          dispatchedCellModel = result.cell.model;
          dispatchedCellTier = result.cell.effort;
          dispatchCellConstraint = workerProvider;
        }
      }
      const compose: WorkerCellCompose =
        providerReject !== undefined
          ? { pluginDir: null, providerReject }
          : composeWorkerCellDir(composeModel, composeTier);
      const cell = resolveWorkerCell(compose, {
        dirExists: deps.dirExists ?? existsSync,
        probeShadow:
          deps.probeShadowingWorkManifest ?? defaultShadowingWorkProbe,
      });
      if (!cell.ok) {
        switch (cell.kind) {
          case "bad-matrix":
            die(
              `refusing to launch ${claudeName}: the host worker matrix is ` +
                `${cell.state} — ${cell.detail} Then retry (worker-cell-bad-matrix)`,
            );
            break;
          case "provider-reject":
            // Fail-closed under the pin — NEVER a fallback to the assigned
            // provider. Same three-reason prose the autopilot sticky carries.
            die(
              `refusing to launch ${claudeName}: ${providerRejectReason(cell)}`,
            );
            break;
          case "out-of-matrix":
            die(
              `refusing to launch ${claudeName}: its {model, tier} resolves no valid ` +
                `worker cell — ${cell.message}; fix the task's model/tier in the plan ` +
                "or regenerate the worker matrix",
            );
            break;
          case "missing":
            die(
              `refusing to launch ${claudeName}: the worker-cell plugin manifest is ` +
                `absent under ${cell.pluginDir} — regenerate via 'keeper prompt ` +
                `render-plugin-templates --project-root ${join(KEEPER_ROOT, "plugins", "plan")}' ` +
                "(without it claude --plugin-dir falls back to the dir basename and " +
                "'/plan:work' cannot resolve 'work:worker')",
            );
            break;
          case "shadowed":
            die(
              `refusing to launch ${claudeName}: a non-cell 'work'-named plugin at ` +
                `${cell.shadowManifest} would steal 'work:worker' from the ` +
                `'${cell.pluginDir}' cell at launch (silent wrong-worker spawn) — ` +
                "remove or rename it, then retry",
            );
            break;
          default:
            assertNever(cell);
        }
      } else {
        // null pluginDir = cell-less → no `--plugin-dir` (byte-identical to a
        // close/free-form launch); a resolved cell threads its absolute dir.
        workerPluginDir = cell.pluginDir ?? undefined;
        // Wrapped-cell guard marker off the EFFECTIVE cell (task .1) — the SAME
        // predicate the autopilot producer uses, so a hand-fired wrapped worker is
        // marked (and guarded) identically. Present only for a wrapped cell; a
        // native / cell-less launch leaves both undefined → empty carriers.
        if (
          axes !== null &&
          composeModel !== null &&
          composeTier !== null &&
          isWrappedCell(axes, composeModel)
        ) {
          dispatchWrappedCell = `${composeModel}::${composeTier}`;
          dispatchWrappedEnvelope = wrappedEnvelopePath(cwd, id);
        }
      }
    }
  } else {
    // ---- free form ----
    if (hasPromptFile) {
      const path = v["prompt-file"] as string;
      try {
        prompt = readFileSync(path, "utf8");
      } catch (err) {
        die(`cannot read --prompt-file '${path}': ${(err as Error).message}`);
      }
    } else {
      prompt = v.prompt as string;
    }
    // Global prompt prefix (config `dispatch_prompt_prefix`) — FREE FORM ONLY.
    // When set, prepend `<prefix> ` so the worker launches with
    // `<prefix> <prompt>`. The NUL/96 KB guard below runs on the FINAL prefixed
    // prompt, and `--dry-run` reflects it. The plan-form branch is untouched.
    // `--no-prefix` bypasses the configured prefix for a single invocation.
    const promptPrefix =
      deps.promptPrefix ?? resolveConfig().dispatchPromptPrefix;
    if (
      !(v["no-prefix"] ?? false) &&
      promptPrefix !== undefined &&
      promptPrefix !== ""
    ) {
      prompt = `${promptPrefix} ${prompt}`;
    }
    const promptCheck = validatePromptBytes(prompt);
    if (!promptCheck.ok) {
      // NUL / oversize prompt is CLI misuse — exit 2.
      argFault(promptCheck.error);
    }
    cwd = v.cwd ?? process.cwd();
    // `--name` (when supplied) is forwarded verbatim to `claude` and nothing
    // else — an empty `--name ""` is treated as absent. It is NOT reused for the
    // keeper-side label.
    claudeName = v.name !== undefined && v.name !== "" ? v.name : undefined;
    label = hasPromptFile ? `file ${v["prompt-file"]}` : "--prompt";
  }

  const { session, attachHint } = resolveSession({ sessionFlag: v.session });

  const launchArgv = buildDispatchLaunchArgv(shell, {
    cwd,
    claudeName,
    prompt,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(workerPluginDir !== undefined ? { pluginDir: workerPluginDir } : {}),
    noConfirm: true,
  });

  if (dryRun) {
    process.stdout.write(`session:     ${session}\n`);
    process.stdout.write(`cwd:         ${cwd}\n`);
    // Plan form keys off the board `verb::id`; free form has no keeper label, so
    // the resolved `--name` (if any) is already visible in the argv below.
    if (hasPlanKey) process.stdout.write(`key:         ${label}\n`);
    process.stdout.write(
      `prompt-from: ${hasPromptFile ? `file ${v["prompt-file"]}` : hasPlanKey ? "plan" : "--prompt"}\n`,
    );
    process.stdout.write(`argv:        ${JSON.stringify(launchArgv)}\n`);
    process.exit(0);
  }

  // Structured spec keeper agent builds its unwrapped invocation from (it ignores
  // the pre-wrapped `launchArgv`). Mirrors the flags already baked into
  // `launchArgv` — that parity keeps the dry-run argv line honest.
  const spec: LaunchSpec = {
    prompt,
    ...(claudeName !== undefined ? { claudeName } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(workerPluginDir !== undefined ? { pluginDir: workerPluginDir } : {}),
    // The dispatched-cell carriers (ADR 0047) — set only when the pin translated
    // this launch's assigned cell, so keeper agent emits the KEEPER_PLAN_DISPATCHED_*
    // env exactly as the autopilot producer does; absent → empty carriers.
    ...(dispatchedCellModel !== undefined
      ? { dispatchedModel: dispatchedCellModel }
      : {}),
    ...(dispatchedCellTier !== undefined
      ? { dispatchedTier: dispatchedCellTier }
      : {}),
    ...(dispatchCellConstraint !== undefined
      ? { dispatchConstraint: dispatchCellConstraint }
      : {}),
    // The wrapped-cell guard carriers (task .1) — set only for a wrapped effective
    // cell, so keeper agent emits the KEEPER_WRAPPED_* env exactly as the autopilot
    // producer does; absent → empty carriers (a native worker the guard ignores).
    ...(dispatchWrappedCell !== undefined
      ? { wrappedCell: dispatchWrappedCell }
      : {}),
    ...(dispatchWrappedEnvelope !== undefined
      ? { wrappedEnvelope: dispatchWrappedEnvelope }
      : {}),
  };

  // UNNAMED window (empty `name`): the renamer worker labels plan-form windows
  // from the bound jobs row; free-form windows stay unnamed.
  const result = await launch(session, launchArgv, cwd, "", spec);
  if (!result.ok) {
    die(`launch failed: ${result.error}`);
  }

  process.stdout.write(`dispatched ${label} → session ${session}\n`);
  if (attachHint) {
    process.stdout.write(
      `  (not inside tmux — attach with: tmux attach -t ${session})\n`,
    );
  }
}

if (import.meta.main) {
  void main(Bun.argv.slice(2));
}
