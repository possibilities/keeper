/**
 * The shared launch→{@link ResolvedHandle} glue behind `agent run` and its panel
 * legs. It assembles the per-CLI detached launch argv via `buildAgentLaunchArgv`,
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

import { fileURLToPath } from "node:url";
import type {
  CodexTrustStatus,
  EnsureCodexDirTrustOptions,
} from "../codex-trust";
import {
  HERMES_SHIM_EVENTS,
  HERMES_SHIM_VERSION,
} from "../hermes-shim-contract";
import type {
  EnsureHermesShimTrustOptions,
  HermesTrustStatus,
} from "../hermes-trust";
import { parseArgsForAgent } from "./args";
import type { AgentKind } from "./dispatch";
import { HARNESS_DESCRIPTORS } from "./harness";
import { buildAgentLaunchArgv, stripClaudeEnv } from "./launch-config";
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
 * for a harness that mints its OWN id keeper can't pin at launch (codex/hermes)
 * and for a continue/resume launch (keeps the persisted session). This one id is
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
   *  harness-native `--name` for claude/pi (codex has none). Omitted = no name. */
  name?: string;
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
  /**
   * Seed codex per-directory trust for the launch cwd (codex-only, fired before
   * the launch) so a detached interactive codex window never hangs on codex's
   * directory-trust prompt. Injected as a seam — not a direct import — so this
   * module keeps its "every effect via LaunchHandleDeps" DI contract and tests
   * stub it (no real `~/.codex` write). Fail-open by contract (never throws).
   */
  ensureCodexDirTrust: (opts: EnsureCodexDirTrustOptions) => CodexTrustStatus;
  /**
   * Seed hermes shell-hook trust for the keeper events-shim (hermes-only, fired
   * before the launch) so a keeper-launched hermes session fires the shim WITHOUT
   * an interactive first-use consent prompt — the M3b live-churn channel. Injected
   * as a seam (not a direct import) so this module keeps its "every effect via
   * LaunchHandleDeps" DI contract and tests stub it (no real `~/.hermes` write).
   * Fail-open by contract (never throws); a deferred/failed seed degrades hermes to
   * presence-only, never blocks the launch.
   */
  ensureHermesShimTrust: (
    opts: EnsureHermesShimTrustOptions,
  ) => HermesTrustStatus;
  /** Wall clock (ms), sampled as the handle's `startedAtMs`. */
  now: () => number;
  writeErr: (s: string) => void;
}

/**
 * The EXACT command hermes runs for the keeper events-shim, registered
 * identically in `<hermes-home>/config.yaml` and its allowlist. Two tokens —
 * `<abs bun> <abs shim path>` — so it depends on neither the shim's exec bit nor
 * `bun` on PATH: the launcher's own bun (`launcherArgvPrefix[0]`) runs the shim
 * resolved relative to THIS module (robust across worktrees). Assumes neither path
 * contains a space (keeper worktree + bin paths never do); a mis-split command
 * merely degrades hermes to presence-only, never errors.
 */
export function hermesShimCommand(launcherArgvPrefix: string[]): string {
  const bun = launcherArgvPrefix[0] ?? "bun";
  const shimPath = fileURLToPath(
    new URL(
      "../../plugins/keeper/plugin/hooks/hermes-events-shim.ts",
      import.meta.url,
    ),
  );
  return `${bun} ${shimPath}`;
}

/**
 * The env the detached partner pane launches with. claude keeps the full
 * inherited env (its `--session-id` pin, not a scrub, keeps the partner
 * transcript distinct); codex/pi get `CLAUDE*` stripped so the orchestrator's
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
 * Assemble the per-CLI detached launch argv (reusing the shared builder for the
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
  const launchArgv = buildAgentLaunchArgv({
    launcherArgvPrefix: [],
    cli: agent,
    prompt,
    model: posture.model,
    effort: posture.effort,
    session: posture.session,
    preset: posture.preset,
    name: posture.name,
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
  // Seed codex trust before the launch (codex-only; keyed on agent, not session
  // id). Fail-open by contract — the seam never throws, so an unseedable trust
  // merely lets codex re-prompt (reaped by the stop-wait timeout), never worse
  // than the headless past. Uses the RAW env (codex reads CODEX_HOME off it).
  if (agent === "codex") {
    deps.ensureCodexDirTrust({ cwd: deps.cwd, env: deps.env });
  }
  // Seed hermes shell-hook trust before the launch (hermes-only; keyed on agent).
  // The seed EDITS the persistent `<hermes-home>/config.yaml`, so it takes effect
  // on the pane's inner `keeper agent hermes` re-exec (which exports KEEPER_JOB_ID
  // + HERMES_ACCEPT_HOOKS) and every later hermes launch. Fail-open — the seam
  // never throws; an unseedable trust merely lets hermes run without the shim
  // (presence-only via the birth record). Uses the RAW env (hermes reads
  // HERMES_HOME off it).
  if (agent === "hermes") {
    deps.ensureHermesShimTrust({
      env: deps.env,
      shimCommand: hermesShimCommand(deps.launcherArgvPrefix),
      events: HERMES_SHIM_EVENTS,
      version: HERMES_SHIM_VERSION,
    });
  }
  try {
    const result = launchKeeperAgentInTmux({
      agent,
      innerArgs: tmuxLaunch.remainingArgs,
      options: tmuxLaunch.options,
      env: launchEnvForAgent(agent, deps.env),
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
