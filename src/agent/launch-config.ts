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
import { CLAUDE_METADATA_INFERENCE_MAX_INPUT_BYTES } from "./args";
import {
  buildHarnessResumeArgv,
  buildResumeLaunchPromptTail,
  HARNESS_NAME_SET,
  type HarnessName,
  mapKeeperEffortToAxis,
  ResumeLaunchUnsupportedError,
} from "./harness";

// ---------------------------------------------------------------------------
// CLIs, roles, read-only directive
// ---------------------------------------------------------------------------

/** The partner CLIs `keeper agent` can fan out to — the full agent-kind set,
 *  derived from the harness registry (`src/agent/harness.ts`) so the name set
 *  lives in one place. Pi launches read-only and read-write like Claude;
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
 * The final-message contract directive, always prepended to the composed
 * `agent run` prompt (no flag gates it, unlike {@link READ_ONLY_DIRECTIVE}).
 * It exists because a partner can end its turn while a background agent it
 * launched is still working, and even a capture stack that waits for that
 * child to retire is only as good as the eventual final turn — nothing
 * forces that turn to actually consolidate the background results. This
 * directive is the answer-shape half of that contract and the SOLE
 * injection mechanism: skill prose documents it but never re-injects a
 * second variant.
 */
export const FINAL_MESSAGE_DIRECTIVE =
  "FINAL MESSAGE CONTRACT — Your final message in this turn is the captured " +
  "deliverable: it must be one complete, self-contained answer, never a " +
  "summary that refers back to an earlier message or promises a follow-up. " +
  "Avoid background agents and background tasks; if any are already " +
  "running, do not end your turn until every one has finished and its " +
  "results are folded into this one final message.";

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
  /** `--model <m>` for Claude/Pi. Omitted when absent. */
  model?: string;
  /** Keeper reasoning effort, mapped per-harness onto the native second axis at
   *  argv-build time: Pi `--thinking`. Claude ignores it here because effort
   *  rides the run-handler `--effort`. Omitted when absent. */
  effort?: string;
  /** Target tmux session keeper agent mints/targets. Omitted = keeper agent default. */
  session?: string;
  /** A launch triple (`<harness>::<model>::<effort>`) forwarded as `--x-preset
   *  <triple>` so the launcher owns model/effort resolution — the caller never
   *  re-derives them. Omitted = no triple flag (model/effort fall to the explicit
   *  `--model`/`--effort`). */
  preset?: string;
  /** Launch NAME. Rides as `--x-tmux-window-name <name>` (the tmux window name,
   *  EVERY harness) and as the harness-native `--name <name>`. Omitted/empty = no name flag. */
  name?: string;
  /** Resume-launch target: when set, the native builder composes a RESUME
   *  argv (the harness's own resume token/target from {@link
   *  buildHarnessResumeArgv}, any harness-specific extra pins, and the
   *  dash-guarded `prompt` from {@link buildResumeLaunchPromptTail}) instead
   *  of a fresh-launch one. The prompt then rides INSIDE the native builder's
   *  own returned array — {@link buildAgentLaunchArgv} does NOT append it
   *  again — since where it lands relative to the other resume flags is
   *  harness-specific. Omitted/empty = fresh launch, byte-
   *  unchanged. */
  resumeTarget?: string;
  /** claude-only: the FRESH CHILD session uuid `--resume` forks into. Minted
   *  by the CALLER (never generated here — this builder takes it as pure
   *  input) and required whenever `cli === "claude"` and `resumeTarget` is
   *  set; a claude resume launch without it throws {@link
   *  ResumeLaunchUnsupportedError} rather than silently omitting the pin
   *  (which would break strict transcript discovery). */
  resumeSessionId?: string;
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
  pi: nativePiArgs,
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
 *). The `--x-no-confirm` flag suppresses the
 * cwd-confirm prompt; `--x-tmux-detached` creates the window without
 * stealing focus, so the orchestrating session keeps control.
 *
 * `--x-tmux-env KEEPER_TMUX_SESSION=<session>` is injected for every harness
 * with an explicit session. It lands the launch in `jobs` as a tracked job with
 * a birth session: claude stamps it through the SessionStart hook, while Pi's
 * birth-record path reads it through `birthBackendCoordsFromEnv` and
 * `armBirthRecord` for daemon autoclose corroboration.
 *
 * A RESUME launch ({@link AgentLaunchOpts.resumeTarget} set) drops the
 * unconditional trailing `prompt` positional this function otherwise
 * appends — the native builder's own returned array already carries the
 * dash-guarded prompt at the harness-correct position, so appending it again
 * here would double it. A fresh launch (the default) is byte-unchanged.
 * Pure — exported for byte-pin tests.
 */
export function buildAgentLaunchArgv(opts: AgentLaunchOpts): string[] {
  const wrapperFlags: string[] = [
    "--x-tmux",
    "--x-tmux-detached",
    "--x-no-confirm",
  ];
  // The launch triple rides as a launcher flag so `keeper agent` owns model/effort
  // resolution (an explicit flag/env still wins over the triple). The caller never
  // re-derives model/effort from the triple — it only reads the triple's harness.
  if (opts.preset !== undefined && opts.preset !== "") {
    wrapperFlags.push("--x-preset", opts.preset);
  }
  if (opts.session !== undefined && opts.session !== "") {
    wrapperFlags.push("--x-tmux-session", opts.session);
    wrapperFlags.push("--x-tmux-env", `KEEPER_TMUX_SESSION=${opts.session}`);
  }
  // The name lands on the tmux window name UNIFORMLY (every harness) via the
  // launcher's window-name knob; the harness-native `--name` (claude/pi) is added
  // in the per-CLI native args.
  if (opts.name !== undefined && opts.name !== "") {
    wrapperFlags.push("--x-tmux-window-name", opts.name);
  }
  const native = NATIVE_ARGS_BUILDERS[opts.cli](opts);
  const isResumeLaunch =
    opts.resumeTarget !== undefined && opts.resumeTarget !== "";
  return [
    ...opts.launcherArgvPrefix,
    opts.cli,
    ...wrapperFlags,
    ...native,
    ...(isResumeLaunch ? [] : [opts.prompt]),
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
 * permission prompt.
 *
 * RESUME mode ({@link AgentLaunchOpts.resumeTarget} set) appends `--resume
 * <target> --session-id <resumeSessionId> --fork-session -- <prompt>` —
 * probe-settled (docs/adr/0034): `--resume <parent>` forks a NEW child
 * session file, so keeper pins the child id via `--session-id --fork-session`
 * to keep strict transcript discovery resolving it, and the caller-minted
 * `resumeSessionId` is REQUIRED (never generated here — a resume launch
 * missing it throws {@link ResumeLaunchUnsupportedError} rather than silently
 * omitting the pin). The trailing `--` end-of-options guard is
 * probe-verified against a live claude binary (a leading-dash prompt
 * otherwise parses as an unknown option). Pure — exported for tests.
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
  if (opts.resumeTarget !== undefined && opts.resumeTarget !== "") {
    if (opts.resumeSessionId === undefined || opts.resumeSessionId === "") {
      throw new ResumeLaunchUnsupportedError(
        "claude resume launch requires resumeSessionId — the fresh child uuid `--resume` forks into, minted by the caller",
      );
    }
    args.push(
      ...buildHarnessResumeArgv("claude", opts.resumeTarget),
      "--session-id",
      opts.resumeSessionId,
      "--fork-session",
      ...buildResumeLaunchPromptTail("claude", opts.prompt),
    );
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
 * way a persistent shared-profile seeder would. Posture-independent: pi read-only is carried by the prompt
 * directive alone (no `--exclude-tools` strip — bash stays leaky, so a strip was
 * never a sandbox), so the flags are the same either way. pi's second axis is
 * `--thinking`; a keeper effort maps onto it via the descriptor (keeper `max` →
 * pi `xhigh`).
 *
 * RESUME mode ({@link AgentLaunchOpts.resumeTarget} set) appends `--session
 * <target> <prompt>` — live-probed for this capability (pi has no ADR-settled
 * fact): a bogus resume target reaches pi's OWN "no session found" runtime
 * error rather than an argv-parse error, confirming the composition. A
 * leading-dash prompt, however, is genuinely UNSUPPORTED — probe-verified pi
 * honors neither a `--` end-of-options guard nor an `=`-joined form for this
 * bare positional — so {@link buildResumeLaunchPromptTail} throws {@link
 * ResumeLaunchUnsupportedError} rather than emit a shape pi could misread as
 * a new flag. Pure — exported for tests.
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
  if (opts.resumeTarget !== undefined && opts.resumeTarget !== "") {
    args.push(
      ...buildHarnessResumeArgv("pi", opts.resumeTarget),
      ...buildResumeLaunchPromptTail("pi", opts.prompt),
    );
  }
  return args;
}

// ---------------------------------------------------------------------------
// Managed account route — the claude-swap wrapper composition
// ---------------------------------------------------------------------------

export { CLAUDE_METADATA_INFERENCE_MAX_INPUT_BYTES } from "./args";
export const CLAUDE_METADATA_INFERENCE_MAX_OUTPUT_BYTES = 32 * 1024;
export const CLAUDE_METADATA_INFERENCE_TIMEOUT_MS = 20_000;
export const CLAUDE_METADATA_INFERENCE_MODEL = "haiku";
export const CLAUDE_METADATA_INFERENCE_EFFORT = "low";
export const CLAUDE_METADATA_INFERENCE_SCHEMA =
  '{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":80}},"required":["name"],"additionalProperties":false}';

export const CLAUDE_METADATA_INFERENCE_SYSTEM_PROMPT =
  "Generate a short session title (3-6 words) for the supplied conversation. " +
  "Prioritize the user's requests, goals, and repeated themes over assistant " +
  "implementation detail. Return only the schema-constrained name.";

const CLAUDE_METADATA_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

/** Compose the fixed, non-persistent Claude metadata process behind one managed route. */
export function buildClaudeMetadataInferenceArgv(opts: {
  claudeBin: string;
  cswapBin: string;
  slot: number;
  input: string;
}): string[] {
  const inputBytes = Buffer.byteLength(opts.input, "utf8");
  if (
    opts.input.trim() === "" ||
    inputBytes > CLAUDE_METADATA_INFERENCE_MAX_INPUT_BYTES ||
    opts.input.includes("\0")
  ) {
    throw new Error("Claude metadata input is unusable or over its byte cap");
  }
  const nativeClaudeArgv = [
    opts.claudeBin,
    "--print",
    "--model",
    CLAUDE_METADATA_INFERENCE_MODEL,
    "--effort",
    CLAUDE_METADATA_INFERENCE_EFFORT,
    "--safe-mode",
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    CLAUDE_METADATA_INFERENCE_SCHEMA,
    "--system-prompt",
    CLAUDE_METADATA_INFERENCE_SYSTEM_PROMPT,
    "--",
    opts.input,
  ];
  return composeManagedClaudeArgv({
    cswapBin: opts.cswapBin,
    slot: opts.slot,
    nativeClaudeArgv,
  });
}

/** Materialize only host basics plus PII-free route attribution for metadata inference. */
export function buildClaudeMetadataInferenceEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  route: { id: string; accountOrdinal?: number },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CLAUDE_METADATA_ENV_ALLOWLIST) {
    const value = inherited[key];
    if (value !== undefined) env[key] = value;
  }
  env.KEEPER_ACCOUNT_ROUTE = route.id;
  if (route.accountOrdinal !== undefined) {
    env.KEEPER_ACCOUNT_ORDINAL = String(route.accountOrdinal);
  }
  return env;
}

export type ClaudeWorkspaceTrustMerge =
  | { ok: true; changed: boolean; body: string }
  | { ok: false; error: string };

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Merge the two non-interactive workspace approvals without replacing siblings. */
export function mergeClaudeWorkspaceTrust(
  body: string,
  cwd: string,
): ClaudeWorkspaceTrustMerge {
  let config: unknown;
  try {
    config = JSON.parse(body);
  } catch {
    return { ok: false, error: "Claude account config is malformed JSON" };
  }
  if (!isJsonRecord(config)) {
    return { ok: false, error: "Claude account config is not an object" };
  }
  const projectsValue = config.projects;
  if (projectsValue !== undefined && !isJsonRecord(projectsValue)) {
    return {
      ok: false,
      error: "Claude account projects config is not an object",
    };
  }
  const projects = projectsValue ?? {};
  const projectValue = projects[cwd];
  if (projectValue !== undefined && !isJsonRecord(projectValue)) {
    return { ok: false, error: "Claude workspace config is not an object" };
  }
  const project = projectValue ?? {};
  if (
    project.hasTrustDialogAccepted === true &&
    project.hasClaudeMdExternalIncludesApproved === true
  ) {
    return { ok: true, changed: false, body };
  }
  projects[cwd] = {
    ...project,
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: true,
  };
  config.projects = projects;
  return {
    ok: true,
    changed: true,
    body: `${JSON.stringify(config, null, 2)}\n`,
  };
}

/**
 * Compose the managed claude-swap wrapper argv around an already-built native
 * Claude command. The account router's MANAGED decision routes a launch through
 * claude-swap's public `run` contract:
 *
 *   `<cswap> run <slot> --share-history -- <native Claude args…>`
 *
 * The native Claude EXECUTABLE (`nativeClaudeArgv[0]`) is DROPPED: `cswap run`
 * resolves `claude` from PATH itself and execs it with everything after `--`, so
 * only the ARGUMENTS carry through — byte-for-byte, in order. `run` MUST be the
 * first cswap token, and `--` is the end-of-options guard ahead of the forwarded
 * Claude args. `--share-history` gives every account one unified conversation
 * history, which is what makes the per-launch account choice orthogonal to a
 * resume/restore (cross-account resume stays conversation-correct). The wrapper
 * neither re-derives nor reorders the native argv — model, effort, session id,
 * resume/fork pins, permissions, plugins, MCP, statusline, and a leading-dash
 * prompt all pass through transparently. Pure — exported for byte-pin tests.
 */
export function composeManagedClaudeArgv(opts: {
  cswapBin: string;
  slot: number;
  nativeClaudeArgv: readonly string[];
}): string[] {
  if (!Number.isSafeInteger(opts.slot) || opts.slot <= 0) {
    throw new Error("claude-swap slot must be a positive integer");
  }
  return [
    opts.cswapBin,
    "run",
    String(opts.slot),
    "--share-history",
    "--",
    ...opts.nativeClaudeArgv.slice(1),
  ];
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

export const PI_CODEX_POOL_PACKAGE_NAME =
  "@earendil-works/keeper-pi-codex-pool";
export const PI_CODEX_POOL_PACKAGE_VERSION = "0.1.0";

export interface PiCodexPoolExtensionResolution {
  args: string[];
  health: "ready" | "missing" | "incompatible";
  problem_code: "companion-missing" | "companion-incompatible" | null;
}

export function piCodexPoolPackagePath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "integrations",
    "pi-codex-pool",
  );
}

export function resolvePiCodexPoolExtension(
  packageRoot = piCodexPoolPackagePath(),
  exists: (path: string) => boolean = existsSync,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): PiCodexPoolExtensionResolution {
  const manifestPath = join(packageRoot, "package.json");
  const sourcePath = join(packageRoot, "src", "index.ts");
  if (!exists(manifestPath) || !exists(sourcePath)) {
    return {
      args: [],
      health: "missing",
      problem_code: "companion-missing",
    };
  }
  try {
    const manifest = JSON.parse(read(manifestPath)) as Record<string, unknown>;
    const pi = manifest.pi as { extensions?: unknown } | undefined;
    const peers = manifest.peerDependencies as
      | Record<string, unknown>
      | undefined;
    const source = read(sourcePath);
    const compatible =
      manifest.name === PI_CODEX_POOL_PACKAGE_NAME &&
      manifest.version === PI_CODEX_POOL_PACKAGE_VERSION &&
      manifest.private === true &&
      JSON.stringify(pi?.extensions) === JSON.stringify(["./src/index.ts"]) &&
      typeof peers?.["@earendil-works/pi-ai"] === "string" &&
      typeof peers?.["@earendil-works/pi-coding-agent"] === "string" &&
      source.includes("openAICodexResponsesApi") &&
      source.includes("KEEPER_PI_CODEX_POOL_MODE") &&
      source.includes("KEEPER_PI_CODEX_POOL_INITIAL_ALIAS");
    if (!compatible) {
      return {
        args: [],
        health: "incompatible",
        problem_code: "companion-incompatible",
      };
    }
    return {
      args: ["-e", sourcePath],
      health: "ready",
      problem_code: null,
    };
  } catch {
    return {
      args: [],
      health: "incompatible",
      problem_code: "companion-incompatible",
    };
  }
}
