/**
 * Pure, dep-free plumbing for `keeper pair` — the pairing helper that fans a
 * task out to another model CLI (claude / codex) via keeper agent as the spawn
 * transport, driven from the orchestrating session's Monitor tool. Owns the
 * pairing ergonomics — role prompts, read-only posture, output normalization,
 * the Monitor two-line stdout contract — and delegates the tmux transport +
 * model/effort selection to keeper agent.
 *
 * LEAF-MODULE DISCIPLINE (mirrors `src/dispatch-command.ts`): this module holds
 * the pure builders only — role loading, prompt assembly, the per-CLI keeper agent
 * argv builders, the git changed-files diff, the env strip, and the output-YAML
 * assembly. It imports `js-yaml` (a serialization dep, not the DB graph) and
 * `node:fs`/`node:path`/`node:os` for asset reads; it MUST NOT pull `bun:sqlite`
 * or `./db`. The orchestration (subprocess compose, SIGTERM handler, atomic
 * write) lives in the thin `cli/pair.ts` entry.
 *
 * Compose flow keeper drives, mirroring the keeper agent subcommand contract
 * (task .1):
 *   1. `keeper agent <cli> --x-tmux --x-tmux-detached
 *      --x-no-confirm <native flags> <prompt>` → one launch-JSON line
 *      carrying the `id` handle.
 *   2. `keeper agent wait-for-stop <id> --stop-timeout-ms <ms>` → blocks until the
 *      partner's next stop; the ms budget forwards keeper's `--timeout` so
 *      keeper agent's stop-wait honors it instead of its own 600s default.
 *   3. `keeper agent show-last-message <id>` → the partner's final assistant
 *      message on stdout + a JSON metadata line.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { resolveKeeperAgentPathDepFree } from "./keeper-agent-path";

// ---------------------------------------------------------------------------
// CLIs, roles, read-only directive
// ---------------------------------------------------------------------------

/** The partner CLIs `keeper pair` can fan out to — keeper agent's full agent-kind
 *  set. pi pairs read-only and read-write like claude/codex; its read-only
 *  posture is the directive + git backstop, reinforced by `--exclude-tools
 *  edit,write` (pi has no native sandbox of its own). */
export type PairCli = "claude" | "codex" | "pi";

export const PAIR_CLIS: ReadonlySet<string> = new Set<PairCli>([
  "claude",
  "codex",
  "pi",
]);

/** The ported role prompts, keyed by `--role`. Each maps to an in-repo asset
 *  under `src/pair/prompts/<role>.txt`. An unknown role fails loud at the CLI. */
export const PAIR_ROLES = [
  "default",
  "planner",
  "codereviewer",
  "coplanner",
] as const;
export type PairRole = (typeof PAIR_ROLES)[number];

export function isPairRole(value: string): value is PairRole {
  return (PAIR_ROLES as readonly string[]).includes(value);
}

/**
 * The read-only directive prepended to the prompt when `--read-only` is set.
 * The directive is the PRIMARY read-only mechanism — purpose-built and visible
 * in the partner's transcript — because the tool strip (`--disallowed-tools`) is
 * leaky (Bash `>` redirection, git, `sed -i` all escape it). The git changed-files
 * snapshot backstops the directive: detection, not prevention.
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
 * tree both resolve relative to THIS module's location (`src/pair-command.ts`
 * → `src/pair/prompts/`), so the assets ship alongside the module. Exported for
 * the loader override in tests.
 */
export function promptsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "pair", "prompts");
}

/** Discriminated result of {@link loadRolePrompt}. */
export type LoadRoleResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Load a role's system-prompt text from its in-repo asset. Returns a
 * discriminated result so the CLI maps an unknown/unreadable role to a loud
 * `[keeper-pair] failed` line rather than throwing. `dir` is injectable for
 * tests; defaults to {@link promptsDir}.
 */
export function loadRolePrompt(
  role: string,
  dir: string = promptsDir(),
): LoadRoleResult {
  if (!isPairRole(role)) {
    return {
      ok: false,
      error: `unknown role '${role}'; available: ${PAIR_ROLES.join(", ")}`,
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
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Build the full prompt the partner receives: prepend the read-only directive
 * (when set), then the role's system prompt, then the user message. Each block
 * is separated by a blank line. `keeper pair` is single-turn (no resume), so
 * this is always the turn-1 shape. Pure — exported for tests.
 */
export function assemblePrompt(args: {
  message: string;
  systemPrompt: string;
  readOnly: boolean;
}): string {
  const parts: string[] = [];
  if (args.readOnly) {
    parts.push(READ_ONLY_DIRECTIVE);
  }
  if (args.systemPrompt !== "") {
    parts.push(`System: ${args.systemPrompt}`);
  }
  parts.push(`User: ${args.message}`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// keeper agent argv builders — per-CLI flag sets
// ---------------------------------------------------------------------------

/** Inputs to {@link buildPairLaunchArgv}. */
export interface PairLaunchOpts {
  /** The launcher argv PREFIX (`[<bun>, <abs cli/keeper.ts>, "agent"]`) the spawn
   *  execs to reach the folded `keeper agent` launcher (built by the caller from
   *  `process.execPath` + `resolvePairKeeperAgentPath`). The `cli` token + flags
   *  are appended, yielding `<bun> <keeper.ts> agent <cli> …`. */
  launcherArgvPrefix: readonly string[];
  /** Partner CLI. */
  cli: PairCli;
  /** The assembled prompt — the FINAL positional argv element. */
  prompt: string;
  /** `--model <m>` (claude/pi `--model`, codex `-m`). Omitted when absent. */
  model?: string;
  /** Reasoning effort (codex only — maps to `-c model_reasoning_effort=`).
   *  Ignored for claude (no effort flag fits the headless surface). */
  effort?: string;
  /** Read-only posture: claude strips edit tools; codex keeps web search. */
  readOnly: boolean;
  /** Target tmux session keeper agent mints/targets. Omitted = keeper agent default. */
  session?: string;
  /** A named launch-config preset forwarded as `--x-preset <name>` so the
   *  launcher owns model/effort resolution — pair never re-derives them. Omitted
   *  = no preset flag (model/effort fall to the explicit `--model`/`--effort`). */
  preset?: string;
}

/**
 * Build the detached `keeper agent` launch argv for a pairing partner. Shape:
 *
 *   `<bun> <abs cli/keeper.ts> agent <cli> --x-tmux
 *     --x-tmux-detached --x-no-confirm
 *     [--x-preset <name>]
 *     [--x-tmux-session <s>] [--x-tmux-env KEEPER_TMUX_SESSION=<s>]
 *     <native cli flags> <prompt>`
 *
 * The `[<bun>, <keeper.ts>, "agent"]` prefix is `launcherArgvPrefix` (resolved by
 * the caller from `process.execPath` + `resolvePairKeeperAgentPath`), since under
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
 * CLI-side via the synchronous `shouldReap = pairCli !== "claude"` path). The
 * carrier needs a session to name, so it is added only when `session` is present.
 * Pure — exported for byte-pin tests.
 */
export function buildPairLaunchArgv(opts: PairLaunchOpts): string[] {
  const wrapperFlags: string[] = [
    "--x-tmux",
    "--x-tmux-detached",
    "--x-no-confirm",
  ];
  // The named preset rides as a launcher flag so `keeper agent` owns model/effort
  // resolution (explicit > env > preset > yaml > native). pair never re-derives
  // model/effort from the preset — it only reads the preset's harness/role itself.
  if (opts.preset !== undefined && opts.preset !== "") {
    wrapperFlags.push("--x-preset", opts.preset);
  }
  if (opts.session !== undefined && opts.session !== "") {
    wrapperFlags.push("--x-tmux-session", opts.session);
    if (opts.cli === "claude") {
      wrapperFlags.push("--x-tmux-env", `KEEPER_TMUX_SESSION=${opts.session}`);
    }
  }
  const native =
    opts.cli === "claude"
      ? nativeClaudeArgs(opts)
      : opts.cli === "codex"
        ? nativeCodexArgs(opts)
        : nativePiArgs(opts);
  return [
    ...opts.launcherArgvPrefix,
    opts.cli,
    ...wrapperFlags,
    ...native,
    opts.prompt,
  ];
}

/**
 * Native claude flags for a one-turn pairing partner launched as an INTERACTIVE
 * TUI (not headless `--print`). The interactive shape is what registers the
 * partner as a tracked `jobs` row — keeper agent binds the pane via the
 * `KEEPER_TMUX_SESSION` env carrier {@link buildPairLaunchArgv} injects, and the
 * SessionStart hook stamps the birth session onto the row. The read-only posture
 * strips the edit tools via `--disallowed-tools` (the directive is the primary
 * guard, the strip reinforces it); the write posture accepts edits. Both keep
 * `--dangerously-skip-permissions` so the single-turn partner never stalls on a
 * permission prompt. Pure — exported for tests.
 */
export function nativeClaudeArgs(opts: PairLaunchOpts): string[] {
  const args: string[] = [];
  if (opts.readOnly) {
    // `--disallowed-tools` is variadic — it consumes every following token up to
    // the next flag. It must NOT be the last flag before the trailing prompt
    // positional (`buildPairLaunchArgv` appends the prompt last), or the prompt
    // is swallowed as bogus tool-deny rules. Keep the boolean
    // `--dangerously-skip-permissions` last so the prompt survives as a clean
    // positional.
    args.push(
      "--disallowed-tools",
      "Edit,Write,NotebookEdit",
      "--dangerously-skip-permissions",
    );
  } else {
    args.push(
      "--permission-mode",
      "acceptEdits",
      "--dangerously-skip-permissions",
    );
  }
  if (opts.model !== undefined && opts.model !== "") {
    args.push("--model", opts.model);
  }
  return args;
}

/**
 * Native codex flags for a one-turn pairing partner launched as an INTERACTIVE
 * TUI (not the headless `codex exec` one-shot). `--dangerously-bypass-approvals
 * -and-sandbox` runs the turn in YOLO mode so it never stalls on an approval
 * prompt; `-m`/`-c model_reasoning_effort` are valid global/interactive flags.
 * Web search is ON by default in the interactive TUI, so the deprecated `--enable
 * web_search_request` is dropped (and `exec`/`--skip-git-repo-check` are
 * exec-only with no interactive analog). codex read-only is carried by the
 * directive ONLY (no native codex flag fits "politely explore" — `-s read-only`
 * would also disable web search), so read-only KEEPS the same flags as write; the
 * git changed-files snapshot backstops it. The detached interactive window does
 * not hang on codex's directory-trust prompt because `keeper pair` pre-seeds the
 * cwd's trust (cli/pair.ts → src/codex-trust.ts, fail-open) before launch. Pure —
 * exported for tests.
 */
export function nativeCodexArgs(opts: PairLaunchOpts): string[] {
  const args = ["--dangerously-bypass-approvals-and-sandbox"];
  if (opts.model !== undefined && opts.model !== "") {
    args.push("-m", opts.model);
  }
  if (opts.effort !== undefined && opts.effort !== "") {
    // codex `-c` parses TOML, so the value is quoted.
    args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  }
  return args;
}

/**
 * Native pi flags for a one-turn pairing partner launched as an INTERACTIVE TUI.
 * pi has NO per-tool approval gate and NO native sandbox — tools are gated only
 * by allow/deny lists, so it never stalls on an approval prompt (no
 * `--dangerously-*` analog exists or is needed). `-na` (`--no-approve`) makes the
 * partner IGNORE the repo's project-local `.pi/` resources for this run — partner
 * isolation mirroring the CLAUDE*-env strip — which ALSO sidesteps pi's
 * directory-trust prompt (the one headless hang), so pi needs no trust-seeder the
 * way codex does (its `trust.json` is a shared profile path a seeder would
 * collide with). Read-only ADDS `--exclude-tools edit,write` (pi's lowercase
 * built-in tool names) as REINFORCEMENT only — the directive + git changed-files
 * snapshot stay the real read-only guards (bash stays leaky, so the strip is not
 * a sandbox). pi uses `thinking`, never `effort`; pairing routes neither here.
 * pi's `--exclude-tools` takes a single comma-joined value (NOT variadic like
 * claude's `--disallowed-tools`), so it can sit last before the trailing prompt
 * positional `buildPairLaunchArgv` appends. Pure — exported for tests.
 */
export function nativePiArgs(opts: PairLaunchOpts): string[] {
  // `-na` (--no-approve): ignore project-local `.pi/` resources for this run.
  const args = ["-na"];
  if (opts.model !== undefined && opts.model !== "") {
    args.push("--model", opts.model);
  }
  if (opts.readOnly) {
    args.push("--exclude-tools", "edit,write");
  }
  return args;
}

/** keeper's `--timeout` (seconds) → the stop-wait budget in ms, the single value
 *  driving BOTH the emitted `--stop-timeout-ms` flag and the subprocess-kill
 *  margin. A fractional `--timeout` rounds UP to ms granularity so the partner is
 *  never short-changed. Pure — exported for tests + the kill-margin calc. */
export function stopTimeoutMsFromSeconds(timeoutSeconds: number): number {
  return Math.ceil(timeoutSeconds * 1000);
}

/** Build the `keeper agent wait-for-stop <handle> --stop-timeout-ms <ms>` argv.
 *  `launcherArgvPrefix` is `[<bun>, <keeper.ts>, "agent"]`. The `stopTimeoutMs`
 *  forwards keeper's resolved `--timeout` budget so the launcher's stop-wait
 *  honors it instead of its own 600s default — keeper is authoritative. Pure —
 *  exported for tests. */
export function buildWaitForStopArgv(
  launcherArgvPrefix: readonly string[],
  handle: string,
  stopTimeoutMs: number,
): string[] {
  return [
    ...launcherArgvPrefix,
    "wait-for-stop",
    handle,
    "--stop-timeout-ms",
    String(stopTimeoutMs),
  ];
}

/** Build the `keeper agent show-last-message <handle>` argv.
 *  `launcherArgvPrefix` is `[<bun>, <keeper.ts>, "agent"]`. Pure — exported for
 *  tests. */
export function buildShowLastMessageArgv(
  launcherArgvPrefix: readonly string[],
  handle: string,
): string[] {
  return [...launcherArgvPrefix, "show-last-message", handle];
}

// ---------------------------------------------------------------------------
// keeper agent launch-JSON parsing (the handle contract)
// ---------------------------------------------------------------------------

/** The keeper agent tmux-launch JSON schema `keeper pair` consumes. A drift here
 *  fails loud (never a silent mismatch). Mirrors keeper's
 *  `KEEPER_AGENT_SCHEMA_VERSION` and keeper agent's `TMUX_SCHEMA_VERSION`. */
export const PAIR_KEEPER_AGENT_SCHEMA_VERSION = 1;

/** The fields `keeper pair` reads off the launch JSON: the `id` handle (passed
 *  to wait/show) and the `paneId` (passed to tmux kill-window for reaping). */
export interface PairLaunchHandle {
  id: string;
  paneId: string | null;
}

/** Discriminated result of {@link parsePairLaunchJson}. */
export type ParseLaunchResult =
  | { ok: true; handle: PairLaunchHandle }
  | { ok: false; error: string };

/**
 * Parse keeper agent's launch stdout DEFENSIVELY: scan line-by-line, take the first
 * line that `JSON.parse`es to an object carrying a matching `schema_version`,
 * and pull the `id` handle + `paneId`. A schema drift, a missing `id`, or no
 * parseable line each fail loud. Pure — exported for tests.
 */
export function parsePairLaunchJson(stdout: string): ParseLaunchResult {
  let sawObjectWithoutSchema = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed == null || typeof parsed !== "object") {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const sv = obj.schema_version;
    if (sv === undefined) {
      sawObjectWithoutSchema = true;
      continue;
    }
    if (sv !== PAIR_KEEPER_AGENT_SCHEMA_VERSION) {
      return {
        ok: false,
        error: `keeper agent launch JSON schema_version ${JSON.stringify(sv)} != ${PAIR_KEEPER_AGENT_SCHEMA_VERSION} (cross-repo contract drift)`,
      };
    }
    const id = obj.id;
    if (typeof id !== "string" || id === "") {
      return {
        ok: false,
        error: "keeper agent launch JSON carried no run id handle",
      };
    }
    const paneId =
      typeof obj.paneId === "string" && obj.paneId !== "" ? obj.paneId : null;
    return { ok: true, handle: { id, paneId } };
  }
  return {
    ok: false,
    error: sawObjectWithoutSchema
      ? "keeper agent launch JSON carried no schema_version field"
      : "keeper agent emitted no parseable launch JSON line",
  };
}

/**
 * Parse keeper agent's `show-last-message` stdout into the partner's final message
 * + drill-down keys. keeper agent prints the bare message text first, then a JSON
 * metadata line (`{schema_version, agent, transcriptPath, found, message}`). We
 * read the message from the JSON `message` field (authoritative — it carries the
 * `null` empty-turn signal); `transcriptPath` is the drill-down pointer. Returns
 * the parsed final message (or `null` for a tool-only/refusal turn) + transcript
 * path. Pure — exported for tests.
 */
export interface ShowLastMessageParsed {
  message: string | null;
  found: boolean;
  transcriptPath: string | null;
}

export type ParseShowResult =
  | { ok: true; result: ShowLastMessageParsed }
  | { ok: false; error: string };

export function parseShowLastMessageJson(stdout: string): ParseShowResult {
  // The JSON metadata line is the LAST parseable schema_version object — the
  // bare message text precedes it and may itself contain `{`-leading lines, so
  // scan all lines and keep the last valid contract object.
  let last: ShowLastMessageParsed | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed == null || typeof parsed !== "object") {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.schema_version !== PAIR_KEEPER_AGENT_SCHEMA_VERSION) {
      continue;
    }
    if (!("found" in obj) && !("message" in obj)) {
      continue;
    }
    last = {
      message: typeof obj.message === "string" ? obj.message : null,
      found: obj.found === true,
      transcriptPath:
        typeof obj.transcriptPath === "string" ? obj.transcriptPath : null,
    };
  }
  if (last === null) {
    return {
      ok: false,
      error:
        "keeper agent show-last-message emitted no parseable metadata line",
    };
  }
  return { ok: true, result: last };
}

// ---------------------------------------------------------------------------
// git changed-files snapshot — read-only backstop (detection, not prevention)
// ---------------------------------------------------------------------------

/**
 * Diff two `git status --porcelain` snapshots (each a set of porcelain lines)
 * into the sorted list of changed file paths. A `null` snapshot (not a git repo
 * / git unavailable) yields an empty diff — we cannot detect a violation, so we
 * report none. Pure — exported for tests.
 */
export function diffGitSnapshots(
  before: ReadonlySet<string> | null,
  after: ReadonlySet<string> | null,
): string[] {
  if (before === null || after === null) {
    return [];
  }
  const files: string[] = [];
  for (const line of after) {
    if (before.has(line)) {
      continue;
    }
    if (line.length > 3) {
      let path = line.slice(3).trim();
      if (path.includes(" -> ")) {
        path = path.split(" -> ").at(-1) as string;
      }
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * Parse `git status --porcelain` stdout into a set of lines. Does NOT strip
 * leading spaces — they are part of the porcelain status format. Pure —
 * exported for tests.
 */
export function parseGitPorcelain(stdout: string): Set<string> {
  const trimmed = stdout.replace(/\n+$/, "");
  if (trimmed === "") {
    return new Set();
  }
  return new Set(trimmed.split("\n"));
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
// Output-YAML assembly — the `--output` result contract
// ---------------------------------------------------------------------------

/** Inputs to {@link buildPairOutput}. */
export interface PairOutputOpts {
  /** Partner CLI. */
  cli: PairCli;
  /** Role used. */
  role: string;
  /** The partner's final assistant message (null for a tool-only/refusal turn). */
  message: string | null;
  /** Read-only posture. */
  readOnly: boolean;
  /** Files the tree showed as changed around the wait (read-only violation when
   *  non-empty and `readOnly`). */
  changedFiles: string[];
  /** keeper agent transcript path drill-down pointer. */
  transcriptPath: string | null;
  /** keeper agent run id handle (the session drill-down key). */
  handle: string;
  /** Elapsed wall seconds. */
  elapsedSeconds?: number;
}

/**
 * Assemble the `--output` payload: a top `message` (the partner's final
 * answer), the cli/role echo, the transcript +
 * session drill-down keys, and — on a read-only run that touched the tree — a
 * `read_only_violation` list flagging the leak. Returns the structured object;
 * the caller serializes it to YAML. Pure — exported for tests.
 */
export function buildPairOutput(opts: PairOutputOpts): Record<string, unknown> {
  const out: Record<string, unknown> = {
    cli: opts.cli,
    role: opts.role,
    message: opts.message ?? "",
  };
  if (opts.readOnly) {
    out.read_only = true;
  }
  if (opts.changedFiles.length > 0) {
    out.changed_files = [...opts.changedFiles];
    if (opts.readOnly) {
      // A read-only run must never touch the tree. If it did, the sandbox was
      // bypassed (the directive ignored / a Bash escape) — surface it loudly.
      // A distinct array copy (not an alias of `changed_files`) so the YAML
      // serializes both inline rather than emitting an anchor/alias.
      out.read_only_violation = [...opts.changedFiles];
    }
  }
  if (opts.elapsedSeconds !== undefined) {
    out.elapsed_seconds = Math.round(opts.elapsedSeconds * 10) / 10;
  }
  out.handle = opts.handle;
  if (opts.transcriptPath !== null) {
    out.transcript_path = opts.transcriptPath;
  }
  return out;
}

/** Serialize a pair-output object to YAML text. Centralized so the CLI and
 *  tests share one serializer. */
export function pairOutputYaml(output: Record<string, unknown>): string {
  return yaml.dump(output, { lineWidth: -1 });
}

/**
 * Self-collision guard: true when the partner's resolved transcript belongs to
 * the DRIVER, not the spawned partner. claude-code transcripts are
 * `<session-uuid>.jsonl`; when the resolver falls back to newest-by-mtime it can
 * win the driver's concurrently-written transcript, so its basename (minus the
 * `.jsonl` suffix) equals the driver's `CLAUDE_CODE_SESSION_ID`. On a match the
 * caller must emit `failed` (`error=self-transcript-collision`) rather than a
 * bogus `completed` carrying the driver's own answer. `null`/empty inputs never
 * collide. Pure — exported for tests.
 */
export function isSelfTranscriptCollision(
  transcriptPath: string | null,
  driverSessionId: string | null | undefined,
): boolean {
  if (
    transcriptPath == null ||
    transcriptPath === "" ||
    driverSessionId == null ||
    driverSessionId === ""
  ) {
    return false;
  }
  const base = transcriptPath.slice(transcriptPath.lastIndexOf("/") + 1);
  const sessionId = base.endsWith(".jsonl")
    ? base.slice(0, -".jsonl".length)
    : base;
  return sessionId === driverSessionId;
}

// ---------------------------------------------------------------------------
// keeper-agent launcher path resolution (tilde-expanded; mirrors src/db.ts)
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute keeper CLI entry the pair path launches partners through
 * (`<bun> <this path> agent <cli> …`) — the folded `keeper agent` launcher.
 * db.ts-free (delegates to the shared {@link resolveKeeperAgentPathDepFree} leaf
 * so this surface never drags the DB graph): `KEEPER_AGENT_PATH` > the derived
 * `cli/keeper.ts` default. `env`/`home` injectable for tests.
 */
export function resolvePairKeeperAgentPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return resolveKeeperAgentPathDepFree(env, home);
}

// ---------------------------------------------------------------------------
// tmux session naming
// ---------------------------------------------------------------------------

/** Default tmux session for `keeper pair` partners when `--session` is absent.
 *  A stable named session (not a per-launch unique name) so partners are easy to
 *  find/attach; keeper agent's race-safe launch lets concurrent partners share it. */
export const DEFAULT_PAIR_SESSION = "pair";
