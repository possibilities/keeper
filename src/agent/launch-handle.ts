/**
 * The shared launch→{@link ResolvedHandle} glue behind `agent run` (posture-free)
 * and `pair send` (posture-full). It assembles the per-CLI detached launch argv
 * via `buildPairLaunchArgv`, mints the pinned transcript session id, drives
 * `launchKeeperAgentInTmux` DIRECTLY (no subprocess re-exec), and returns a
 * {@link RunLaunchResult}. The pinned {@link ResolvedHandle} is held LOCALLY by
 * the caller's compose — no run.json re-resolution, no cross-process kill margin,
 * no self-transcript-collision exposure. Both callers express their config
 * through ONE seam: the posture rides in via {@link LaunchPosture} (the
 * `buildPairLaunchArgv` opts), every effect via the explicit {@link
 * LaunchHandleDeps}.
 *
 * DEP-GRAPH DISCIPLINE: this module stays db-free (no `src/db.ts` / `bun:sqlite`)
 * — it sits on `cli/agent.ts`'s reach onto the cold-start `keeper plan` path
 * (pinned by the `agent-launch-handle-depgraph` hygiene test).
 */

import { buildPairLaunchArgv } from "../pair-command";
import { parseArgsForAgent } from "./args";
import type { AgentKind } from "./dispatch";
import type { ResolvedHandle } from "./pair-subcommands";
import type { RunLaunchResult } from "./run-capture";
import {
  launchKeeperAgentInTmux,
  parseKeeperAgentTmuxArgs,
  type TmuxCommandRunner,
  TmuxLaunchError,
} from "./tmux-launch";

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
 * `--session-id`, else a freshly minted uuid for a new claude/pi session. Null
 * for codex (no id pin) and for a continue/resume launch (keeps the persisted
 * session). This one id is recorded in run.json `transcriptSessionId`, forwarded
 * into the pane via the `-e KEEPER_AGENT_TMUX_SESSION_ID` carrier, and consumed by
 * the inner re-exec's `--session-id` push — one source of truth, no divergence.
 */
export function tmuxTranscriptSessionId(
  agent: AgentKind,
  args: string[],
  randomUuid: () => string,
): string | null {
  if (agent === "codex") {
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
 * The posture half of the launch seam — the {@link buildPairLaunchArgv} opts the
 * two callers vary. `agent run` pins `readOnly:false` and omits the rest; `pair
 * send` fills the full posture (model/effort/session/preset). `cli`/`prompt`/
 * `launcherArgvPrefix` are NOT here — `cli`/`prompt` are explicit args, the prefix
 * is a launch dep.
 */
export interface LaunchPosture {
  readOnly: boolean;
  model?: string;
  effort?: string;
  session?: string;
  preset?: string;
}

/** The effect half of the seam — every collaborator the launch touches, injected. */
export interface LaunchHandleDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Absolute `tmux` binary; resolved by the caller so a stripped PATH can't ENOENT it. */
  tmuxBin: string;
  launcherStateDir: string;
  /** The argv PREFIX the detached pane re-execs (`[<abs bun>, <abs cli/keeper.ts>, "agent"]`). */
  launcherArgvPrefix: string[];
  randomUuid: () => string;
  runTmuxCommand: TmuxCommandRunner;
  /** Wall clock (ms), sampled as the handle's `startedAtMs`. */
  now: () => number;
  writeErr: (s: string) => void;
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
}

/**
 * Assemble the per-CLI detached launch argv (reusing the pair builder for the
 * native posture flags), strip the cli token, and drive `launchKeeperAgentInTmux`
 * DIRECTLY — no subprocess re-exec. On success the pinned {@link ResolvedHandle}
 * is held LOCALLY by the caller's compose (no run.json re-resolution, no
 * cross-process kill margin, no self-transcript-collision exposure). A
 * parse/launch failure maps to `{ok:false}`; diagnostics go to stderr.
 */
export function launchToResolvedHandle(
  args: LaunchHandleArgs,
): RunLaunchResult {
  const { deps, agent, prompt, posture, stopTimeoutMs } = args;
  // Build with an EMPTY launcherArgvPrefix so the cli token sits first; `.slice(1)`
  // then drops it, leaving the inner args. The REAL prefix rides on the launch
  // request below, where the detached pane re-execs through it.
  const launchArgv = buildPairLaunchArgv({
    launcherArgvPrefix: [],
    cli: agent,
    prompt,
    readOnly: posture.readOnly,
    model: posture.model,
    effort: posture.effort,
    session: posture.session,
    preset: posture.preset,
  });
  const tmuxLaunch = parseKeeperAgentTmuxArgs(launchArgv.slice(1));
  if (tmuxLaunch.error !== null) {
    deps.writeErr(`agent: ${tmuxLaunch.error}\n`);
    return { ok: false, error: tmuxLaunch.error };
  }
  const startedAtMs = deps.now();
  const transcriptSessionId = tmuxTranscriptSessionId(
    agent,
    tmuxLaunch.remainingArgs,
    deps.randomUuid,
  );
  try {
    const result = launchKeeperAgentInTmux({
      agent,
      innerArgs: tmuxLaunch.remainingArgs,
      options: tmuxLaunch.options,
      env: deps.env,
      cwd: deps.cwd,
      transcriptSessionId,
      startedAtMs,
      stateDir: deps.launcherStateDir,
      tmuxBin: deps.tmuxBin,
      launcherArgvPrefix: deps.launcherArgvPrefix,
      randomUuid: deps.randomUuid,
      runTmuxCommand: deps.runTmuxCommand,
    });
    const handle: ResolvedHandle = {
      agent,
      cwd: deps.cwd,
      sessionId: transcriptSessionId,
      startedAtMs,
      transcriptPath: null,
      stopTimeoutMs,
    };
    return { ok: true, handle, runId: result.id };
  } catch (exc) {
    if (exc instanceof TmuxLaunchError) {
      deps.writeErr(`Error: ${exc.message}\n`);
      return { ok: false, error: exc.message };
    }
    throw exc;
  }
}
