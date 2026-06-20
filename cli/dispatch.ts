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
 *     arbitrary prompt. `--name` is REQUIRED (the claude session name +
 *     correlation key). A `verb::id`-shaped `--name` WILL bind to that plan row
 *     (feature + hazard — document it).
 *
 * Launch is purely CLIENT-SIDE via `resolveExecBackend(...).ensureLaunched(...)`
 * — no daemon RPC, no synthetic event, no reducer/migration touch — so re-fold
 * determinism and the five-surface RPC-write invariant hold by construction.
 *
 * Exit taxonomy (mirrors `cli/autopilot.ts`): `die` → 1 (resolution / launch
 * failure), arg fault → 2 (mode misuse, bad prompt), `--help` → 0.
 *
 * Session resolution order: `--session` > `$KEEPER_TMUX_SESSION` (non-empty) >
 * `$TMUX`-gated current session > `foreground`. The resolved session is echoed;
 * a `foreground` fallback outside tmux prints a `tmux attach` hint.
 *
 * TOCTOU between the race-guard read and the launch is inherent for a
 * client-side manual hatch and is accepted — the guard is a courtesy, not a
 * lock; `--force` skips it entirely.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  buildDispatchLaunchArgv,
  defaultPlanPrompt,
  parseDispatchKey,
  type RetryDispatchVerb,
  validatePromptBytes,
} from "../src/dispatch-command";
import { resolveExecBackend } from "../src/exec-backend";
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

const HELP = `keeper dispatch — manually fire one claude worker into a tmux window

Usage:
  keeper dispatch <work|close>::<id> [options]      # plan form
  keeper dispatch --prompt "<text>"  --name <n> [options]   # free form
  keeper dispatch --prompt-file <path> --name <n> [options] # free form
  keeper dispatch --help

Plan form resolves the /plan:<verb> <id> prompt + cwd from the daemon and bakes
--name <verb>::<id> so the hook binds a board-visible jobs row. Free form
launches an arbitrary prompt; --name is REQUIRED (the claude session name +
correlation key — a verb::id-shaped --name binds to that plan row).

Options:
  --prompt <text>      Free-form prompt (mutually exclusive with the positional)
  --prompt-file <path> Read the free-form prompt from a file
  --name <n>           claude --name (REQUIRED in free form)
  --session <s>        Target tmux session (overrides every fallback)
  --cwd <dir>          Working dir (free form; defaults to process.cwd())
  --model <m>          Pass --model to claude
  --effort <e>         Pass --effort to claude
  --force              Plan form: skip the race guard
  --dry-run            Print the resolved launch plan; launch nothing
  --sock <path>        Daemon socket path override
  --help, -h           Show this help

Session resolution: --session > $KEEPER_TMUX_SESSION > $TMUX current > foreground.
`;

const FALLBACK_SESSION = "foreground";

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
 * (transport throw) from not-found / empty-cwd (resolution miss) for distinct
 * error text + a clean exit 1 that launches nothing.
 */
export async function resolvePlanCwd(
  query: QueryFn,
  verb: RetryDispatchVerb,
  id: string,
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
 * session > `foreground`. Returns the session plus whether we fell back to
 * `foreground` while OUTSIDE tmux (so the caller can print an attach hint).
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
  // Outside tmux (or the probe failed) → the managed foreground session.
  return { session: FALLBACK_SESSION, attachHint: !inTmux };
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    options: {
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      name: { type: "string" },
      session: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      sock: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
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

  const backend = resolveExecBackend({
    noteLine: (line: string) => process.stderr.write(`${line}\n`),
  });

  let cwd: string;
  let prompt: string;
  let claudeName: string;
  let label: string;

  if (hasPlanKey) {
    // ---- plan form ----
    const keyResult = parseDispatchKey(positional);
    if (!keyResult.ok) {
      // A malformed verb::id key is CLI misuse — exit 2.
      argFault(keyResult.error);
    }
    const { verb, id } = keyResult;
    const query: QueryFn = (collection, filter) =>
      queryCollection(sockPath, collection, filter);
    const cwdResult = await resolvePlanCwd(query, verb, id);
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
    const name = v.name;
    if (name === undefined || name === "") {
      argFault("free form requires --name <n> (the claude session name)");
    }
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
    const promptCheck = validatePromptBytes(prompt);
    if (!promptCheck.ok) {
      // NUL / oversize prompt is CLI misuse — exit 2.
      argFault(promptCheck.error);
    }
    cwd = v.cwd ?? process.cwd();
    claudeName = name;
    label = name;
  }

  const { session, attachHint } = resolveSession({ sessionFlag: v.session });

  const launchArgv = buildDispatchLaunchArgv(shell, {
    cwd,
    claudeName,
    prompt,
    ...(v.model !== undefined ? { model: v.model } : {}),
    ...(v.effort !== undefined ? { effort: v.effort } : {}),
    noConfirm: true,
  });

  if (dryRun) {
    process.stdout.write(`session:     ${session}\n`);
    process.stdout.write(`cwd:         ${cwd}\n`);
    process.stdout.write(`${hasPlanKey ? "key" : "name"}:         ${label}\n`);
    process.stdout.write(
      `prompt-from: ${hasPromptFile ? `file ${v["prompt-file"]}` : hasPlanKey ? "plan" : "--prompt"}\n`,
    );
    process.stdout.write(`argv:        ${JSON.stringify(launchArgv)}\n`);
    process.exit(0);
  }

  // UNNAMED window (empty `name`): the renamer worker labels plan-form windows
  // from the bound jobs row; free-form windows stay unnamed.
  const result = await backend.ensureLaunched(session, launchArgv, cwd, "");
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
