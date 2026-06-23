/**
 * Pure, dep-free plumbing for `keeper pair` — the pairing helper that fans a
 * task out to another model CLI (claude / codex) via agentwrap as the spawn
 * transport, driven from the orchestrating session's Monitor tool. Ports
 * pairctl's pairing ergonomics (role prompts, read-only posture, output
 * normalization, the Monitor two-line stdout contract) into keeper, delegating
 * the tmux transport + model/effort selection to agentwrap.
 *
 * LEAF-MODULE DISCIPLINE (mirrors `src/dispatch-command.ts`): this module holds
 * the pure builders only — role loading, prompt assembly, the per-CLI agentwrap
 * argv builders, the git changed-files diff, the env strip, and the output-YAML
 * assembly. It imports `js-yaml` (a serialization dep, not the DB graph) and
 * `node:fs`/`node:path`/`node:os` for asset reads; it MUST NOT pull `bun:sqlite`
 * or `./db`. The orchestration (subprocess compose, SIGTERM handler, window
 * reaping, atomic write) lives in the thin `cli/pair.ts` entry.
 *
 * Compose flow keeper drives, mirroring the agentwrap subcommand contract
 * (task .1):
 *   1. `agentwrap <cli> --agentwrap-tmux --agentwrap-tmux-detached
 *      --agentwrap-no-confirm <native flags> <prompt>` → one launch-JSON line
 *      carrying the `id` handle.
 *   2. `agentwrap wait-for-stop <id>` → blocks until the partner's next stop.
 *   3. `agentwrap show-last-message <id>` → the partner's final assistant
 *      message on stdout + a JSON metadata line.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// CLIs, roles, read-only directive
// ---------------------------------------------------------------------------

/** The partner CLIs `keeper pair` can fan out to. Mirrors agentwrap's agent
 *  kinds minus `pi` (no pairctl posture is ported for pi). */
export type PairCli = "claude" | "codex";

export const PAIR_CLIS: ReadonlySet<string> = new Set<PairCli>([
  "claude",
  "codex",
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
 * Ported verbatim from pairctl (`helpers.py:READ_ONLY_DIRECTIVE`). The directive
 * is the PRIMARY read-only mechanism — purpose-built and visible in the
 * partner's transcript — because the tool strip (`--disallowed-tools`) is leaky
 * (Bash `>` redirection, git, `sed -i` all escape it). The git changed-files
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
 * Build the full prompt the partner receives, mirroring pairctl's turn-1
 * `format_prompt`: prepend the read-only directive (when set), then the role's
 * system prompt, then the user message. Each block is separated by a blank
 * line. `keeper pair` is single-turn (no resume), so this is always the turn-1
 * shape. Pure — exported for tests.
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
// agentwrap argv builders — per-CLI flag sets
// ---------------------------------------------------------------------------

/** Inputs to {@link buildPairLaunchArgv}. */
export interface PairLaunchOpts {
  /** Absolute agentwrap binary path (resolved + `~`-expanded by the caller). */
  agentwrapPath: string;
  /** Partner CLI. */
  cli: PairCli;
  /** The assembled prompt — the FINAL positional argv element. */
  prompt: string;
  /** `--model <m>` (claude `--model`, codex `-m`). Omitted when absent. */
  model?: string;
  /** Reasoning effort (codex only — maps to `-c model_reasoning_effort=`).
   *  Ignored for claude (no effort flag fits the headless surface). */
  effort?: string;
  /** Read-only posture: claude strips edit tools; codex keeps web search. */
  readOnly: boolean;
  /** Target tmux session agentwrap mints/targets. Omitted = agentwrap default. */
  session?: string;
}

/**
 * Build the detached agentwrap launch argv for a pairing partner. Shape:
 *
 *   `<abs-agentwrap> <cli> --agentwrap-tmux --agentwrap-tmux-detached
 *     --agentwrap-no-confirm [--agentwrap-tmux-session <s>]
 *     -- <native cli flags> <prompt>`
 *
 * The native flags differ per CLI (see {@link nativeClaudeArgs} /
 * {@link nativeCodexArgs}). The `--agentwrap-no-confirm` flag suppresses the
 * cwd-confirm prompt; `--agentwrap-tmux-detached` creates the window without
 * stealing focus, so the orchestrating session keeps control. Pure — exported
 * for byte-pin tests.
 */
export function buildPairLaunchArgv(opts: PairLaunchOpts): string[] {
  const wrapperFlags: string[] = [
    "--agentwrap-tmux",
    "--agentwrap-tmux-detached",
    "--agentwrap-no-confirm",
  ];
  if (opts.session !== undefined && opts.session !== "") {
    wrapperFlags.push("--agentwrap-tmux-session", opts.session);
  }
  const native =
    opts.cli === "claude" ? nativeClaudeArgs(opts) : nativeCodexArgs(opts);
  return [
    opts.agentwrapPath,
    opts.cli,
    ...wrapperFlags,
    ...native,
    opts.prompt,
  ];
}

/**
 * Native claude flags for a headless one-shot pairing turn. `--print -p` runs
 * headless; the read-only posture strips the edit tools via `--disallowed-tools`
 * (the directive is the primary guard, the strip reinforces it). The write
 * posture accepts edits + skips permission prompts so the partner can edit.
 * Ported from pairctl's `config/claude.yaml` permission_args. Pure — exported
 * for tests.
 */
export function nativeClaudeArgs(opts: PairLaunchOpts): string[] {
  const args = ["--print", "-p"];
  if (opts.readOnly) {
    // `--disallowed-tools` is variadic — it consumes every following token up to
    // the next flag. It must NOT be the last flag before the trailing prompt
    // positional (`buildPairLaunchArgv` appends the prompt last), or the prompt
    // is swallowed as bogus tool-deny rules and the partner aborts with "Input
    // must be provided … when using --print". Keep the boolean
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
 * Native codex flags for a headless one-shot pairing turn. `exec
 * --skip-git-repo-check --enable web_search_request` runs the partner with web
 * search. codex read-only is carried by the directive ONLY (no native codex
 * flag fits "politely explore" — `-s read-only` would also disable web search),
 * so read-only KEEPS the same exec flags as write and KEEPS `--enable
 * web_search_request`. The git changed-files snapshot backstops it. Ported from
 * pairctl's `config/codex.yaml`. Pure — exported for tests.
 */
export function nativeCodexArgs(opts: PairLaunchOpts): string[] {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--enable",
    "web_search_request",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (opts.model !== undefined && opts.model !== "") {
    args.push("-m", opts.model);
  }
  if (opts.effort !== undefined && opts.effort !== "") {
    // codex `-c` parses TOML, so the value is quoted.
    args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  }
  return args;
}

/** Build the `agentwrap wait-for-stop <handle>` argv. Pure — exported for tests. */
export function buildWaitForStopArgv(
  agentwrapPath: string,
  handle: string,
): string[] {
  return [agentwrapPath, "wait-for-stop", handle];
}

/** Build the `agentwrap show-last-message <handle>` argv. Pure — exported for
 *  tests. */
export function buildShowLastMessageArgv(
  agentwrapPath: string,
  handle: string,
): string[] {
  return [agentwrapPath, "show-last-message", handle];
}

// ---------------------------------------------------------------------------
// agentwrap launch-JSON parsing (the handle contract)
// ---------------------------------------------------------------------------

/** The agentwrap tmux-launch JSON schema `keeper pair` consumes. A drift here
 *  fails loud (never a silent mismatch). Mirrors keeper's
 *  `AGENTWRAP_SCHEMA_VERSION` and agentwrap's `TMUX_SCHEMA_VERSION`. */
export const PAIR_AGENTWRAP_SCHEMA_VERSION = 1;

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
 * Parse agentwrap's launch stdout DEFENSIVELY: scan line-by-line, take the first
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
    if (sv !== PAIR_AGENTWRAP_SCHEMA_VERSION) {
      return {
        ok: false,
        error: `agentwrap launch JSON schema_version ${JSON.stringify(sv)} != ${PAIR_AGENTWRAP_SCHEMA_VERSION} (cross-repo contract drift)`,
      };
    }
    const id = obj.id;
    if (typeof id !== "string" || id === "") {
      return {
        ok: false,
        error: "agentwrap launch JSON carried no run id handle",
      };
    }
    const paneId =
      typeof obj.paneId === "string" && obj.paneId !== "" ? obj.paneId : null;
    return { ok: true, handle: { id, paneId } };
  }
  return {
    ok: false,
    error: sawObjectWithoutSchema
      ? "agentwrap launch JSON carried no schema_version field"
      : "agentwrap emitted no parseable launch JSON line",
  };
}

/**
 * Parse agentwrap's `show-last-message` stdout into the partner's final message
 * + drill-down keys. agentwrap prints the bare message text first, then a JSON
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
    if (obj.schema_version !== PAIR_AGENTWRAP_SCHEMA_VERSION) {
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
      error: "agentwrap show-last-message emitted no parseable metadata line",
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
 * report none. Mirrors pairctl's `_compute_changed_files`. Pure — exported for
 * tests.
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
 * leading spaces — they are part of the porcelain status format. Mirrors
 * pairctl's `_git_status_snapshot`. Pure — exported for tests.
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
 * Strip every `CLAUDE`-prefixed env var from a copy of the base env, mirroring
 * pairctl's env scrub. The partner runs as its own session — leaking the
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
// Output-YAML assembly — pairctl's `--output` contract
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
  /** agentwrap transcript path drill-down pointer. */
  transcriptPath: string | null;
  /** agentwrap run id handle (the session drill-down key). */
  handle: string;
  /** Elapsed wall seconds. */
  elapsedSeconds?: number;
}

/**
 * Assemble the `--output` payload mirroring pairctl's result contract: a top
 * `message` (the partner's final answer), the cli/role echo, the transcript +
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
// agentwrap path resolution (tilde-expanded; mirrors src/db.ts)
// ---------------------------------------------------------------------------

/** Default agentwrap binary path when no override is configured. */
export const DEFAULT_PAIR_AGENTWRAP_PATH = "~/.bun/bin/agentwrap";

/**
 * Resolve the absolute agentwrap binary path for `keeper pair`, tilde-expanding
 * AT RESOLVE TIME (`execvp` does not expand `~`). `KEEPER_AGENTWRAP_PATH` wins;
 * else the default. Kept dep-free of `src/db.ts` (whose `resolveAgentwrapPath`
 * also folds the config key) so this leaf never drags the DB graph — the env
 * override + default cover the pair surface. `env`/`home` injectable for tests.
 */
export function resolvePairAgentwrapPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const override = env.KEEPER_AGENTWRAP_PATH;
  const entry =
    override && override.length > 0 ? override : DEFAULT_PAIR_AGENTWRAP_PATH;
  if (entry === "~") {
    return home;
  }
  if (entry.startsWith("~/")) {
    return join(home, entry.slice(2));
  }
  return entry;
}

// ---------------------------------------------------------------------------
// tmux session naming + autoclose policy
// ---------------------------------------------------------------------------

/** Default tmux session for `keeper pair` partners when `--session` is absent.
 *  A stable named session (not a per-launch unique name) so partners are easy to
 *  find/attach; agentwrap's race-safe launch lets concurrent partners share it. */
export const DEFAULT_PAIR_SESSION = "pair";

/**
 * tmux session names EXEMPT from autoclose. A partner whose session is exempt is
 * left open + interactive after its turn (attach with `tmux attach -t <name>`)
 * instead of having its window reaped; every other session autocloses. `panels`
 * holds `/plan:panel` legs, `pair` holds default `keeper pair` partners — both
 * kept open for inspection by default.
 */
export const DEFAULT_PAIR_PERSIST_SESSIONS: readonly string[] = [
  "panels",
  DEFAULT_PAIR_SESSION,
];

/**
 * Resolve the set of tmux session names exempt from autoclose. Default is
 * {@link DEFAULT_PAIR_PERSIST_SESSIONS}; `KEEPER_PAIR_PERSIST_SESSIONS` overrides
 * with a comma-separated list (an empty value → autoclose everything). Mirrors
 * {@link resolvePairAgentwrapPath}'s env-override pattern so this leaf stays
 * dep-free of `src/db.ts`. `env` injectable for tests.
 */
export function resolvePairPersistSessions(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const override = env.KEEPER_PAIR_PERSIST_SESSIONS;
  if (override === undefined) {
    return new Set(DEFAULT_PAIR_PERSIST_SESSIONS);
  }
  return new Set(
    override
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
}
