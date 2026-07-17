/**
 * The shared launch→{@link ResolvedHandle} glue behind `agent run` and its panel
 * legs. Surface-specific handle resolution happens before this seam: a caller
 * resumes a dead target by its handle and refuses a live target in favor of the
 * Agent Bus. Partner names are host-global among tracked jobs; handoff slugs are
 * host-global event-sourced handles whose duplicate exits 3; panel slugs are
 * display/discovery metadata, while the opaque request identity owns the panel
 * request and its controls. This module receives the resolved target and
 * assembles the per-CLI detached launch argv via `buildAgentLaunchArgv`,
 * mints the pinned transcript session id, drives `launchKeeperAgentInTmux`
 * DIRECTLY (no subprocess re-exec), and returns a {@link RunLaunchResult}. The
 * pinned {@link ResolvedHandle} is held LOCALLY by the caller's compose — no
 * run.json re-resolution, no cross-process kill margin, no
 * self-transcript-collision exposure. The caller expresses its config through ONE
 * seam: the posture rides in via {@link LaunchPosture} (the `buildAgentLaunchArgv`
 * opts), every effect via the explicit {@link LaunchHandleDeps}.
 *
 * DEP-GRAPH DISCIPLINE: this module stays db-free (no `src/db.ts` / `bun:sqlite`)
 * — it sits on `cli/agent.ts`'s reach onto the cold-start `keeper plan` path
 * (pinned by the `agent-launch-handle-depgraph` hygiene test).
 */

import { parseArgsForAgent } from "./args";
import type { AgentKind } from "./dispatch";
import { HARNESS_DESCRIPTORS, ResumeLaunchUnsupportedError } from "./harness";
import { buildAgentLaunchArgv, stripClaudeEnv } from "./launch-config";
import type { ResolvedHandle } from "./pair-subcommands";
import {
  PiPromptArtifactsError,
  stampPiPromptCompilerEnv,
} from "./pi-prompt-artifacts";
import type { RunLaunchResult } from "./run-capture";
import {
  launchKeeperAgentInTmux,
  parseKeeperAgentTmuxArgs,
  type TmuxCommandRunner,
  TmuxLaunchError,
} from "./tmux-launch";
import { snapshotInvocationStopFloor } from "./transcript-watch";

function existingSessionId(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--session-id") {
      return args[i + 1] ?? null;
    }
    if (arg.startsWith("--session-id=")) {
      return arg.slice("--session-id=".length) || null;
    }
  }
  return null;
}

/**
 * The pinned transcript session id for a tmux launch: an explicit user
 * `--session-id`, else a freshly minted uuid for a new Claude/Pi session. Null
 * for a continue/resume launch (keeps the persisted session). This one id is
 * recorded in run.json `transcriptSessionId`, forwarded into the pane via the
 * `-e KEEPER_AGENT_TMUX_SESSION_ID` carrier, and consumed by the inner re-exec's
 * `--session-id` push — one source of truth, no divergence.
 */
export function tmuxTranscriptSessionId(
  agent: AgentKind,
  args: string[],
  randomUuid: () => string,
): string | null {
  if (HARNESS_DESCRIPTORS[agent].mintsOwnSessionId) {
    return null;
  }

  const parsed = parseArgsForAgent(args, agent);
  const explicit = existingSessionId(parsed.remainingArgs);
  if (explicit !== null) {
    return explicit;
  }
  if (parsed.hasContinueOrResume) {
    return null;
  }
  return randomUuid();
}

/**
 * The posture half of the launch seam — the {@link buildAgentLaunchArgv} opts the
 * caller varies. A bare `agent run` omits everything; a panel leg fills the full
 * posture (model/effort/session/preset). Read-only is prompting-only (a prompt
 * directive prepended caller-side), so it is NOT a launch-argv posture here.
 * `cli`/`prompt`/`launcherArgvPrefix` are NOT here — `cli`/`prompt` are explicit
 * args, the prefix is a launch dep.
 */
export interface LaunchPosture {
  model?: string;
  effort?: string;
  session?: string;
  preset?: string;
  /** Launch NAME — lands on the tmux window name for every harness and on the
   *  harness-native `--name` for claude/pi. Omitted = no name. */
  name?: string;
}

/** The effect half of the seam — every collaborator the launch touches, injected. */
export interface LaunchHandleDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Absolute `tmux` binary; resolved by the caller so a stripped PATH can't ENOENT it. */
  tmuxBin: string;
  launcherStateDir: string;
  transcriptHomeDir?: string;
  /** The argv PREFIX the detached pane re-execs (`[<abs bun>, <abs cli/keeper.ts>, "agent"]`). */
  launcherArgvPrefix: string[];
  randomUuid: () => string;
  runTmuxCommand: TmuxCommandRunner;
  /** Wall clock (ms), sampled as the handle's `startedAtMs`. */
  now: () => number;
  writeErr: (s: string) => void;
}

/**
 * The env the detached partner pane launches with. claude keeps the full
 * inherited env (its `--session-id` pin, not a scrub, keeps the partner
 * transcript distinct); Pi gets `CLAUDE*` stripped so the orchestrator's
 * identity never leaks into the headless partner. An agent-conditional DEFAULT,
 * never a user flag — it is identity-isolation, not credential-security. Pure —
 * exported for the byte-pin tests.
 */
export function launchEnvForAgent(
  agent: AgentKind,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return agent === "claude"
    ? env
    : stripClaudeEnv(env as Record<string, string | undefined>);
}

/**
 * Resume-launch inputs for {@link launchToResolvedHandle}. When present, the
 * launch composes a RESUME argv (via {@link buildAgentLaunchArgv}'s resume opts)
 * instead of a fresh one, and the returned handle carries `isResume` plus the
 * harness-correct pinned session id for discovery. The caller resolves its
 * surface-specific handle, routes a live target to the Agent Bus, and mints any
 * child id — this module just threads the resolved values through. Omitted =
 * fresh launch, byte-unchanged.
 */
export interface LaunchResume {
  /** The native resume token forwarded to the harness (buildAgentLaunchArgv's
   *  `resumeTarget`): Claude parent uuid or Pi session id. */
  target: string;
  /** claude-only: the fresh CHILD uuid `--resume` forks into (buildAgentLaunchArgv's
   *  `resumeSessionId`), minted by the caller. Undefined for the other harnesses,
   *  which resume their existing session in place. */
  childSessionId?: string;
  /** The handle's `sessionId` — the strict-pin transcript-discovery key AND the
   *  envelope resume_target base: Claude → the child uuid; Pi → the resumed
   *  session's own id. */
  sessionId: string | null;
}

/** Inputs to {@link launchToResolvedHandle}. */
export interface LaunchHandleArgs {
  deps: LaunchHandleDeps;
  agent: AgentKind;
  /** The assembled prompt — the FINAL positional argv element. */
  prompt: string;
  posture: LaunchPosture;
  /** Caller-supplied stop-wait ceiling threaded into the handle; null = default. */
  stopTimeoutMs: number | null;
  /** Resume-launch inputs; omitted = a fresh launch (byte-unchanged). */
  resume?: LaunchResume;
}

/**
 * Assemble the per-CLI detached launch argv (reusing the shared builder for the
 * native posture flags), strip the cli token, and drive `launchKeeperAgentInTmux`
 * DIRECTLY — no subprocess re-exec. On success the pinned {@link ResolvedHandle}
 * is held LOCALLY by the caller's compose (no run.json re-resolution, no
 * cross-process kill margin, no self-transcript-collision exposure). A
 * parse/launch failure maps to `{ok:false}`; diagnostics go to stderr.
 *
 * A RESUME launch ({@link LaunchHandleArgs.resume} set) composes the harness's
 * native resume argv instead of a fresh one, pins the resumed session's id on the
 * handle (so strict discovery + the envelope resume_target resolve it), and marks
 * the handle `isResume`. An unsupported resume composition maps to `{ok:false}` like a tmux error.
 */
export function launchToResolvedHandle(
  args: LaunchHandleArgs,
): RunLaunchResult {
  const { deps, agent, prompt, posture, stopTimeoutMs, resume } = args;
  if (agent === "pi") {
    try {
      stampPiPromptCompilerEnv(deps.env, {
        executablePath: deps.launcherArgvPrefix[0] ?? "",
        keeperCliPath: deps.launcherArgvPrefix[1] ?? "",
      });
    } catch (exc) {
      if (exc instanceof PiPromptArtifactsError) {
        deps.writeErr(`agent: ${exc.message}\n`);
        return { ok: false, error: exc.message };
      }
      throw exc;
    }
  }
  // Build with an EMPTY launcherArgvPrefix so the cli token sits first; `.slice(1)`
  // then drops it, leaving the inner args. The REAL prefix rides on the launch
  // request below, where the detached pane re-execs through it. A resume launch
  // threads the harness's own resume token/pins through the resume opts (the
  // builder embeds the dash-guarded prompt at the harness-correct position).
  let launchArgv: string[];
  try {
    launchArgv = buildAgentLaunchArgv({
      launcherArgvPrefix: [],
      cli: agent,
      prompt,
      model: posture.model,
      effort: posture.effort,
      session: posture.session,
      preset: posture.preset,
      name: posture.name,
      resumeTarget: resume?.target,
      resumeSessionId: resume?.childSessionId,
    });
  } catch (exc) {
    // A harness that cannot compose a resume launch (Claude missing the child
    // uuid; Pi handed a leading-dash prompt it can't dash-guard) is a
    // launch failure, not a crash — surface it as `{ok:false}` like a tmux error.
    if (exc instanceof ResumeLaunchUnsupportedError) {
      deps.writeErr(`agent: ${exc.message}\n`);
      return { ok: false, error: exc.message };
    }
    throw exc;
  }
  const tmuxLaunch = parseKeeperAgentTmuxArgs(launchArgv.slice(1));
  if (tmuxLaunch.error !== null) {
    deps.writeErr(`agent: ${tmuxLaunch.error}\n`);
    return { ok: false, error: tmuxLaunch.error };
  }
  const startedAtMs = deps.now();
  // A resume launch pins the resumed session's id on the HANDLE for discovery
  // (claude → the forked child uuid, which also rides the argv's own --session-id;
  // Pi resumes its existing session id). The pane env carrier stays null so
  // no fresh --session-id is minted or double-pushed — the inner re-exec keeps the
  // native resume argv verbatim (it skips the mint whenever --resume/--continue is
  // present). A fresh launch keeps the minted-uuid carrier, byte-unchanged.
  const transcriptSessionId = resume
    ? null
    : tmuxTranscriptSessionId(agent, tmuxLaunch.remainingArgs, deps.randomUuid);
  const discoverySessionId = resume?.sessionId ?? transcriptSessionId;
  const lifecycleJobId =
    resume !== undefined && agent === "pi"
      ? deps.randomUuid()
      : discoverySessionId;
  if (lifecycleJobId !== null) {
    tmuxLaunch.options.env = [
      ...tmuxLaunch.options.env.filter(([key]) => key !== "KEEPER_JOB_ID"),
      ["KEEPER_JOB_ID", lifecycleJobId],
    ];
  }
  const invocationStopFloor =
    resume !== undefined && deps.transcriptHomeDir !== undefined
      ? snapshotInvocationStopFloor({
          agent,
          cwd: deps.cwd,
          env: deps.env,
          homeDir: deps.transcriptHomeDir,
          startedAtMs,
          sessionId: discoverySessionId,
          isResume: true,
        })
      : null;
  try {
    const result = launchKeeperAgentInTmux({
      agent,
      innerArgs: tmuxLaunch.remainingArgs,
      options: tmuxLaunch.options,
      env: launchEnvForAgent(agent, deps.env),
      cwd: deps.cwd,
      transcriptSessionId,
      resolvedTranscriptSessionId: discoverySessionId,
      startedAtMs,
      lifecycleJobId,
      invocationStopFloor,
      isResume: resume !== undefined,
      stateDir: deps.launcherStateDir,
      tmuxBin: deps.tmuxBin,
      launcherArgvPrefix: deps.launcherArgvPrefix,
      randomUuid: deps.randomUuid,
      runTmuxCommand: deps.runTmuxCommand,
    });
    const handle: ResolvedHandle = {
      agent,
      cwd: deps.cwd,
      sessionId: discoverySessionId,
      startedAtMs,
      transcriptPath: null,
      stopTimeoutMs,
      isResume: resume !== undefined,
      ...(lifecycleJobId !== null ? { lifecycleJobId } : {}),
      ...(invocationStopFloor !== null ? { invocationStopFloor } : {}),
    };
    if (result.killWindowCommand === null) {
      throw new TmuxLaunchError(
        "detached tmux launch returned no exact teardown target",
      );
    }
    return {
      ok: true,
      handle,
      runId: result.id,
      killWindowCommand: result.killWindowCommand,
    };
  } catch (exc) {
    if (exc instanceof TmuxLaunchError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return { ok: false, error: exc.message };
    }
    throw exc;
  }
}
