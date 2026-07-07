/**
 * The shared, dep-free launch cluster behind `keeper agent` — the neutral home
 * for the per-CLI detached-launch argv builder, the native flag sets, the
 * CLAUDE* env strip, the read-only directive, and the role-prompt resolver. It
 * is consumed by `agent run`, the panel fan-out, and the pairing entry alike.
 *
 * LEAF-MODULE DISCIPLINE (mirrors `src/dispatch-command.ts`): this module holds
 * the pure builders only. It imports `node:fs`/`node:path`/`node:url` for the
 * role-asset reads and MUST NOT pull `bun:sqlite` or `./db` — it sits on the
 * cold-start launch path (pinned db-free by the `agent-launch-handle-depgraph`
 * hygiene test). The orchestration — the launch→wait→show compose, the SIGTERM
 * handler, the atomic writes — lives in the callers.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_NAME_SET,
  type HarnessName,
  mapKeeperEffortToAxis,
} from "./harness";

// ---------------------------------------------------------------------------
// CLIs, roles, read-only directive
// ---------------------------------------------------------------------------

/** The partner CLIs `keeper agent` can fan out to — the full agent-kind set,
 *  derived from the harness registry (`src/agent/harness.ts`) so the name set
 *  lives in one place. pi launches read-only and read-write like claude/codex;
 *  its read-only posture is the prompt directive only (prompting, not enforcement
 *  — pi has no native sandbox of its own). */
export type AgentCli = HarnessName;

export const AGENT_CLIS: ReadonlySet<string> = HARNESS_NAME_SET;

/** The role prompts, keyed by `--role`. Each maps to an in-repo asset under
 *  `src/agent/prompts/<role>.txt`. An unknown role fails loud at the CLI. */
export const AGENT_ROLES = [
  "default",
  "planner",
  "codereviewer",
  "coplanner",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

/**
 * The read-only directive prepended to the prompt when `--read-only` is set.
 * The directive is the WHOLE read-only mechanism — prompting-only, honest and
 * best-effort. It rides as user-turn text visible in the partner's transcript
 * and relies on the model following it; keeper enforces nothing (no tool strip,
 * no git audit). A partner that ignores it can still touch the tree.
 */
export const READ_ONLY_DIRECTIVE =
  "READ-ONLY EXPLORE SESSION — Do not create, modify, move, or delete any " +
  "file, and do not run any state-changing command (no file writes, no " +
  "`git add`/`git commit`, no installs, no `sed -i`, no `>` redirection to " +
  "files). Read, search, run read-only commands, analyze, and report your " +
  "findings. If the task would require a change, describe the change instead " +
  "of making it.";

/**
 * Resolve the prompts asset dir. The compiled `keeper` binary and the source
 * tree both resolve relative to THIS module's location (`src/agent/launch-config.ts`
 * → `src/agent/prompts/`), so the assets ship alongside the module. Exported for
 * the loader override in tests.
 */
export function promptsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "prompts");
}

/** Discriminated result of {@link loadRolePrompt}. */
export type LoadRoleResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Load a role's system-prompt text from its in-repo asset. Returns a
 * discriminated result so the CLI maps an unknown/unreadable role to a loud
 * failure line rather than throwing. `dir` is injectable for tests; defaults to
 * {@link promptsDir}.
 */
export function loadRolePrompt(
  role: string,
  dir: string = promptsDir(),
): LoadRoleResult {
  if (!isAgentRole(role)) {
    return {
      ok: false,
      error: `unknown role '${role}'; available: ${AGENT_ROLES.join(", ")}`,
    };
  }
  const path = join(dir, `${role}.txt`);
  try {
    return { ok: true, text: readFileSync(path, "utf8").trim() };
  } catch (err) {
    return {
      ok: false,
      error: `cannot read role prompt '${role}' at ${path}: ${(err as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// keeper agent argv builders — per-CLI flag sets
// ---------------------------------------------------------------------------

/** Inputs to {@link buildAgentLaunchArgv}. */
export interface AgentLaunchOpts {
  /** The launcher argv PREFIX (`[<bun>, <abs cli/keeper.ts>, "agent"]`) the spawn
   *  execs to reach the folded `keeper agent` launcher (built by the caller from
   *  `process.execPath` + the resolved keeper-agent path). The `cli` token + flags
   *  are appended, yielding `<bun> <keeper.ts> agent <cli> …`. */
  launcherArgvPrefix: readonly string[];
  /** Partner CLI. */
  cli: AgentCli;
  /** The assembled prompt — the FINAL positional argv element. */
  prompt: string;
  /** `--model <m>` (claude/pi `--model`, codex `-m`). Omitted when absent. */
  model?: string;
  /** Keeper reasoning effort, mapped per-harness onto the native second axis at
   *  argv-build time: codex `-c model_reasoning_effort=`, pi `--thinking`. Claude
   *  and hermes ignore it here (claude effort rides the run-handler `--effort`;
   *  hermes has no second axis). Omitted when absent. */
  effort?: string;
  /** Target tmux session keeper agent mints/targets. Omitted = keeper agent default. */
  session?: string;
  /** A named launch-config preset forwarded as `--x-preset <name>` so the
   *  launcher owns model/effort resolution — the caller never re-derives them.
   *  Omitted = no preset flag (model/effort fall to the explicit
   *  `--model`/`--effort`). */
  preset?: string;
  /** Launch NAME. Rides as `--x-tmux-window-name <name>` (the tmux window name,
   *  EVERY harness) and, for claude/pi only, as the harness-native `--name <name>`
   *  (codex has no native name flag). Omitted/empty = no name flag. */
  name?: string;
}

/** Per-harness native-flag builder table — the descriptor-lookup form of the old
 *  `cli === "claude" ? … : …` chain. Byte-identical: each entry is the harness's
 *  existing pure builder. (The builders are hoisted function declarations, so the
 *  table resolves them regardless of textual order.) */
const NATIVE_ARGS_BUILDERS: Record<
  AgentCli,
  (opts: AgentLaunchOpts) => string[]
> = {
  claude: nativeClaudeArgs,
  codex: nativeCodexArgs,
  pi: nativePiArgs,
  hermes: nativeHermesArgs,
};

/**
 * Build the detached `keeper agent` launch argv for a partner. Shape:
 *
 *   `<bun> <abs cli/keeper.ts> agent <cli> --x-tmux
 *     --x-tmux-detached --x-no-confirm
 *     [--x-preset <name>]
 *     [--x-tmux-session <s>] [--x-tmux-env KEEPER_TMUX_SESSION=<s>]
 *     <native cli flags> <prompt>`
 *
 * The `[<bun>, <keeper.ts>, "agent"]` prefix is `launcherArgvPrefix` (resolved by
 * the caller from `process.execPath` + the resolved keeper-agent path), since under
 * keeper `process.argv[1]` is `cli/keeper.ts` / `src/daemon.ts` — neither carries
 * the `agent` token. The native flags differ per CLI (see {@link nativeClaudeArgs}
 * / {@link nativeCodexArgs}). The `--x-no-confirm` flag suppresses the
 * cwd-confirm prompt; `--x-tmux-detached` creates the window without
 * stealing focus, so the orchestrating session keeps control.
 *
 * `--x-tmux-env KEEPER_TMUX_SESSION=<session>` is injected for the
 * CLAUDE path only (mirroring `buildKeeperAgentLaunchArgv` in
 * `src/exec-backend.ts`): it is the binding carrier that lands the partner in
 * the `jobs` projection as a tracked job — the launcher injects it into the pane
 * env via tmux `-e`, so the SessionStart hook stamps the session name as the
 * partner's birth session (`plan_verb` NULL — a tracked-but-non-plan job). codex
 * also launches as an interactive TUI now, but fires no keeper hooks, so it never
 * becomes a tracked job and omits the carrier (it stays UNTRACKED and is reaped
 * CLI-side). The carrier needs a session to name, so it is added only when
 * `session` is present. Pure — exported for byte-pin tests.
 */
export function buildAgentLaunchArgv(opts: AgentLaunchOpts): string[] {
  const wrapperFlags: string[] = [
    "--x-tmux",
    "--x-tmux-detached",
    "--x-no-confirm",
  ];
  // The named preset rides as a launcher flag so `keeper agent` owns model/effort
  // resolution (an explicit flag/env still wins over the preset). The caller never
  // re-derives model/effort from the preset — it only reads the preset's harness.
  if (opts.preset !== undefined && opts.preset !== "") {
    wrapperFlags.push("--x-preset", opts.preset);
  }
  if (opts.session !== undefined && opts.session !== "") {
    wrapperFlags.push("--x-tmux-session", opts.session);
    if (opts.cli === "claude") {
      wrapperFlags.push("--x-tmux-env", `KEEPER_TMUX_SESSION=${opts.session}`);
    }
  }
  // The name lands on the tmux window name UNIFORMLY (every harness) via the
  // launcher's window-name knob; the harness-native `--name` (claude/pi) is added
  // in the per-CLI native args, so codex legs carry no native name flag.
  if (opts.name !== undefined && opts.name !== "") {
    wrapperFlags.push("--x-tmux-window-name", opts.name);
  }
  const native = NATIVE_ARGS_BUILDERS[opts.cli](opts);
  return [
    ...opts.launcherArgvPrefix,
    opts.cli,
    ...wrapperFlags,
    ...native,
    opts.prompt,
  ];
}

/**
 * Native claude flags for a one-turn partner launched as an INTERACTIVE
 * TUI (not headless `--print`). The interactive shape is what registers the
 * partner as a tracked `jobs` row — keeper agent binds the pane via the
 * `KEEPER_TMUX_SESSION` env carrier {@link buildAgentLaunchArgv} injects, and the
 * SessionStart hook stamps the birth session onto the row. Posture-independent:
 * read-only is carried by the prompt directive alone (no tool strip), so the
 * flags are the same either way — `--permission-mode acceptEdits
 * --dangerously-skip-permissions` so the single-turn partner never stalls on a
 * permission prompt. Pure — exported for tests.
 */
export function nativeClaudeArgs(opts: AgentLaunchOpts): string[] {
  const args: string[] = [
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
  ];
  if (opts.model !== undefined && opts.model !== "") {
    args.push("--model", opts.model);
  }
  // The harness-native session name; an explicit `--name` suppresses the
  // interactive auto-mint on the detached re-exec.
  if (opts.name !== undefined && opts.name !== "") {
    args.push("--name", opts.name);
  }
  return args;
}

/**
 * Native codex flags for a one-turn partner launched as an INTERACTIVE
 * TUI (not the headless `codex exec` one-shot). `--dangerously-bypass-approvals
 * -and-sandbox` runs the turn in YOLO mode so it never stalls on an approval
 * prompt; `-m`/`-c model_reasoning_effort` are valid global/interactive flags.
 * Web search is ON by default in the interactive TUI, so the deprecated `--enable
 * web_search_request` is dropped (and `exec`/`--skip-git-repo-check` are
 * exec-only with no interactive analog). codex read-only is carried by the
 * prompt directive ONLY (no native codex flag fits "politely explore" — `-s
 * read-only` would also disable web search), so read-only KEEPS the same flags
 * as write; keeper enforces nothing. The detached interactive window does
 * not hang on codex's directory-trust prompt because the launch pre-seeds the
 * cwd's trust (via `src/codex-trust.ts`, fail-open) before launch. Pure —
 * exported for tests.
 */
export function nativeCodexArgs(opts: AgentLaunchOpts): string[] {
  const args = ["--dangerously-bypass-approvals-and-sandbox"];
  if (opts.model !== undefined && opts.model !== "") {
    args.push("-m", opts.model);
  }
  if (opts.effort !== undefined && opts.effort !== "") {
    // codex `-c` parses TOML, so the value is quoted. The keeper effort maps onto
    // codex's reasoning band via the descriptor (keeper `max` → codex `xhigh`).
    const band = mapKeeperEffortToAxis("codex", opts.effort);
    args.push("-c", `model_reasoning_effort="${band}"`);
  }
  return args;
}

/**
 * Native pi flags for a one-turn partner launched as an INTERACTIVE TUI.
 * pi has NO per-tool approval gate and NO native sandbox — tools are gated only
 * by allow/deny lists, so it never stalls on an approval prompt (no
 * `--dangerously-*` analog exists or is needed). `-na` (`--no-approve`) makes the
 * partner IGNORE the repo's project-local `.pi/` resources for this run — partner
 * isolation mirroring the CLAUDE*-env strip — which ALSO sidesteps pi's
 * directory-trust prompt (the one headless hang), so pi needs no trust-seeder the
 * way codex does (its `trust.json` is a shared profile path a seeder would
 * collide with). Posture-independent: pi read-only is carried by the prompt
 * directive alone (no `--exclude-tools` strip — bash stays leaky, so a strip was
 * never a sandbox), so the flags are the same either way. pi's second axis is
 * `--thinking`; a keeper effort maps onto it via the descriptor (keeper `max` →
 * pi `xhigh`). Pure — exported for tests.
 */
export function nativePiArgs(opts: AgentLaunchOpts): string[] {
  // `-na` (--no-approve): ignore project-local `.pi/` resources for this run.
  const args = ["-na"];
  if (opts.model !== undefined && opts.model !== "") {
    args.push("--model", opts.model);
  }
  // pi's second axis is `--thinking`; the keeper effort maps onto pi's band
  // vocabulary via the descriptor (keeper `max` → pi `xhigh`).
  if (opts.effort !== undefined && opts.effort !== "") {
    args.push("--thinking", mapKeeperEffortToAxis("pi", opts.effort));
  }
  // The harness-native session name; an explicit `--name` suppresses the
  // interactive auto-mint on the detached re-exec.
  if (opts.name !== undefined && opts.name !== "") {
    args.push("--name", opts.name);
  }
  return args;
}

/**
 * Native hermes flags for a one-turn partner. `--yolo` runs the turn with no
 * approval gate so a detached pane never stalls; `-m <model>` sets the model
 * (hermes has no effort/thinking axis, so neither is emitted). Hermes has NO
 * interactive first-turn prompt positional (unlike claude/pi) — the prompt must
 * ride its `-z/--oneshot` flag — so this builder ENDS with `-z`, making the
 * trailing `opts.prompt` that {@link buildAgentLaunchArgv} appends the value of
 * `-z`: `hermes --yolo -m <model> -z <prompt>`. The one-shot prints only the
 * final message and records the session in hermes's store for post-stop capture.
 * Hermes has no native `--name` flag (like codex), so `opts.name` rides only the
 * tmux window name. Consent for its shell hooks is seeded via the
 * `HERMES_ACCEPT_HOOKS=1` pane env (set by the inner launch), not a flag here.
 * Pure — exported for tests.
 */
export function nativeHermesArgs(opts: AgentLaunchOpts): string[] {
  const args = ["--yolo"];
  if (opts.model !== undefined && opts.model !== "") {
    args.push("-m", opts.model);
  }
  args.push("-z");
  return args;
}

// ---------------------------------------------------------------------------
// Env strip — CLAUDE* removal before the partner pane
// ---------------------------------------------------------------------------

/**
 * Strip every `CLAUDE`-prefixed env var from a copy of the base env. The
 * partner runs as its own session — leaking the
 * orchestrator's `CLAUDE*` env (config dir, session ids, project context) would
 * cross-contaminate its identity. Returns a fresh object; the input is never
 * mutated. Pure — exported for tests.
 *
 * DEFENSE-IN-DEPTH, not the load-bearing gate. The gate is
 * `launchScriptEnv`'s 5-key allowlist (which already excludes `ANTHROPIC*` /
 * `*_API_KEY` / `DYLD_*`): the partner pane's real env is that allowlist + the
 * tmux-server env + the login-shell re-source, and `DYLD_*`/`LD_*` are already
 * hard-blocked on the `--x-tmux-env` injection channel. Do NOT add
 * `ANTHROPIC*`/`*_API_KEY` stripping here — a claude partner needs its own auth,
 * and stripping it would break the partner outright.
 */
export function stripClaudeEnv(
  base: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !k.startsWith("CLAUDE")) {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// pi extension arming (M3b live-state)
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk path to keeper's ephemeral pi extension
 * (`plugins/keeper/pi-extension/keeper-events.ts`). Like {@link promptsDir}, it
 * resolves relative to THIS module's location so it holds under both the source
 * tree and a `bun link`ed binary (`src/agent/` → repo root → `plugins/…`). The
 * file must ship as source `.ts`: pi loads it via jiti, outside the keeper build.
 */
export function piExtensionPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "plugins",
    "keeper",
    "pi-extension",
    "keeper-events.ts",
  );
}

/**
 * The pi native flags that arm the keeper extension: `["-e", <path>]` when the
 * extension file is present, else `[]`. FAIL-OPEN existence check is the load
 * -bearing guard — pi ABORTS the launch on an `-e` path that does not exist, so a
 * partial checkout must degrade to presence-only rather than break every pi
 * launch. `exists` is injected for tests; defaults to {@link existsSync}. Pure
 * over its inputs.
 */
export function piExtensionArgs(
  exists: (path: string) => boolean = existsSync,
): string[] {
  const path = piExtensionPath();
  return exists(path) ? ["-e", path] : [];
}
