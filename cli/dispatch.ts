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
import { parseArgs } from "node:util";
import {
  ConfigError,
  loadPresetCatalog,
  type Preset,
  resolvePreset,
} from "../src/agent/config";
import { resolveWorkerLaunchConfig } from "../src/autopilot-worker";
import {
  resolveConfig,
  resolveKeeperAgentPath,
  resolveSockPath,
} from "../src/db";
import {
  buildDispatchLaunchArgv,
  defaultPlanPrompt,
  parseDispatchKey,
  type RetryDispatchVerb,
  validatePromptBytes,
} from "../src/dispatch-command";
import type { LaunchResult, LaunchSpec } from "../src/exec-backend";
import { keeperAgentLaunch } from "../src/exec-backend";
import { buildLauncherArgvPrefix } from "../src/keeper-agent-path";
import type { QueryFrame, Row } from "../src/protocol";
import { queryCollection } from "./control-rpc";

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
}

const HELP = `keeper dispatch — manually fire one claude worker into a tmux window

Usage:
  keeper dispatch <work|close>::<id> [options]      # plan form
  keeper dispatch --prompt "<text>" [options]       # free form
  keeper dispatch --prompt-file <path> [options]    # free form
  keeper dispatch --help

Plan form resolves the /plan:<verb> <id> prompt + cwd from the daemon and bakes
--name <verb>::<id> so the hook binds a board-visible jobs row. Free form
launches an arbitrary prompt; --name is OPTIONAL and forwarded verbatim to
claude (no keeper labeling). When omitted, no --name is passed at all.

Options:
  --prompt <text>      Free-form prompt (mutually exclusive with the positional)
  --prompt-file <path> Read the free-form prompt from a file
  --name <n>           claude --name (OPTIONAL pass-through in free form)
  --session <s>        Target tmux session (overrides every fallback)
  --cwd <dir>          Working dir (free form; defaults to process.cwd())
  --preset <name>      Named launch-config preset from ~/.config/keeper/presets.yaml
                       (claude-only); supplies --model/--effort. Must be a real
                       catalog entry (exit 2 otherwise); run \`keeper agent presets
                       list\` to see the names. Plan form defaults to the same
                       'worker' preset the autopilot uses.
  --model <m>          Pass --model to claude (overrides the preset)
  --effort <e>         Pass --effort to claude (overrides the preset)
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
  Plan form:  keeper dispatch work::fn-N.M    (or close::fn-N)
              Resolves the /plan:<verb> <id> prompt + cwd from the daemon and
              bakes --name so the hook binds a board-visible jobs row.
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

/** Minimal shape of an `epics` row we read for cwd resolution. */
interface EpicRow extends Row {
  epic_id?: string;
  project_dir?: string | null;
  tasks?: Array<{ task_id?: string; target_repo?: string | null }> | null;
}

/**
 * Resolve the launch cwd for a plan-form dispatch from the `epics` projection.
 * Mirrors the reconciler's cwd rules (`src/autopilot-worker.ts`):
 *   - work: the parent epic's `tasks[]` entry → `target_repo ?? project_dir`.
 *   - close: the epic's `project_dir`.
 * Returns a discriminated result so the caller distinguishes daemon-unreachable
 * (transport throw) from not-found / empty-cwd / cwd-missing (resolution miss)
 * for distinct error text + a clean exit 1 that launches nothing.
 *
 * `dirExists` is the on-disk existence probe (defaults to `existsSync`),
 * injected for tests. A resolved cwd that does not exist on disk — typically a
 * renamed-away repo dir — fails LOUD with `cwd-missing: <path>` instead of
 * launching a worker into a stale path that silently never runs. Remediation:
 * `keeper plan mv-repo <old> <new>`.
 */
export async function resolvePlanCwd(
  query: QueryFn,
  verb: RetryDispatchVerb,
  id: string,
  dirExists: (dir: string) => boolean = existsSync,
): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  // work: id is a task id `fn-N-slug.M` whose parent epic is the `fn-N-slug`
  // prefix. close: id IS the epic id. The epic filter resolves both.
  const epicId = verb === "work" ? id.replace(/\.\d+$/, "") : id;
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
  if (verb === "close") {
    if (projectDir === "") {
      return { ok: false, error: `epic '${epicId}' has no project_dir` };
    }
    if (!dirExists(projectDir)) {
      return { ok: false, error: `cwd-missing: ${projectDir}` };
    }
    return { ok: true, cwd: projectDir };
  }
  // work: walk the parent epic's tasks for the matching task id.
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
  return { ok: true, cwd };
}

/**
 * Plan-form race guard. Best-effort scan: refuses (naming the tripped
 * condition) when a `pending_dispatches` row for the key exists, autopilot is
 * unpaused, or a live/`working` job carries the plan key (client-side scan —
 * `jobs` has no `plan_verb`/`plan_ref` filter). Returns the tripped-condition
 * string, or `null` when clear. Skipped by the caller under `--force`.
 *
 * A daemon-unreachable read here is treated as "clear" — the launch surface
 * itself will fail loudly if the daemon is truly gone, and a manual hatch must
 * not be blocked by a transient read error.
 */
export async function checkRaceGuard(
  query: QueryFn,
  verb: RetryDispatchVerb,
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
      return "autopilot is unpaused — it may dispatch this key itself; pause it or pass --force";
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
      return `a live job for ${key} already occupies a slot (job state=${String(live.state)})`;
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
    options: {
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      name: { type: "string" },
      session: { type: "string" },
      cwd: { type: "string" },
      preset: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      force: { type: "boolean", default: false },
      "no-prefix": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      sock: { type: "string" },
      help: { type: "boolean", default: false },
      "agent-help": { type: "boolean", default: false },
    },
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

  // ---- resolve model/effort (claude-only) ----
  // Precedence per field: explicit --model/--effort > --preset > worker preset
  // (plan form only) > none. Dispatch widens to claude alone for now — LaunchSpec
  // carries only claude model/effort (codex/pi dispatch is a follow-up). The
  // plan-form default is the SAME `worker` preset the autopilot resolves, so a
  // hand-fired plan worker is byte-identical to an automated one.
  let baseModel: string | undefined;
  let baseEffort: string | undefined;
  if (hasPlanKey) {
    const worker = resolveWorkerLaunchConfig();
    baseModel = worker.model;
    baseEffort = worker.effort;
  }
  if (v.preset !== undefined && v.preset !== "") {
    let preset: Preset;
    try {
      preset = resolvePreset(loadPresetCatalog(), v.preset);
    } catch (err) {
      argFault(err instanceof ConfigError ? err.message : String(err));
    }
    if (preset.harness !== "claude") {
      argFault(
        `--preset ${v.preset} pins harness ${preset.harness}; dispatch is ` +
          "claude-only (codex/pi dispatch is a follow-up)",
      );
    }
    // A partial preset layers over the worker/plan base per field.
    if (preset.model !== null) baseModel = preset.model;
    if (preset.effort !== null) baseEffort = preset.effort;
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

  if (hasPlanKey) {
    // ---- plan form ----
    const keyResult = parseDispatchKey(positional);
    if (!keyResult.ok) {
      // A malformed verb::id key is CLI misuse — exit 2.
      argFault(keyResult.error);
    }
    const { verb, id } = keyResult;
    const query: QueryFn =
      deps.query ??
      ((collection, filter) => queryCollection(sockPath, collection, filter));
    const cwdResult = await resolvePlanCwd(
      query,
      verb,
      id,
      deps.dirExists ?? existsSync,
    );
    if (!cwdResult.ok) {
      die(cwdResult.error);
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
