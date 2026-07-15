#!/usr/bin/env bun
// PreToolUse(Write|Edit|MultiEdit|NotebookEdit|Bash) wrapped-cell total-edit-denial guard.
//
// Fourth sibling of branch-guard / escalation-guard / wrong-tree-guard. A WRAPPED
// worker cell's `work:worker` is a claude wrapper that delegates ALL implementation
// (code, tests, lint iteration) to the model's serving provider via `keeper agent
// run --resume` and owns only the keeper close-out (`commit-work` + `plan done`).
// Because the dumb-courier wrapper never authors source, this guard is a SINGLE-
// STATE total edit-denial: every source-editing vector is denied for the whole run
// — no phase gate, no result-envelope unlock, nothing forgeable.
//
// Jurisdiction is TWO conditions, both required to fire:
//   (1) the launch-injected `KEEPER_WRAPPED_CELL` env marker is present and
//       non-empty (empty == absent: a native cell always emits an EMPTY carrier,
//       so an empty value is byte-inert — a human or native worker is never
//       blocked), AND
//   (2) the tool payload carries `agent_id`/`agent_type` (the wrapped `work:worker`
//       subagent — the same signal branch-guard keys on). The wrapper's own marked
//       ORCHESTRATOR session (no `agent_id`) stays inert.
//
// Denied for a marked subagent: Edit / MultiEdit / NotebookEdit outright; Write
// whose target resolves INSIDE a tracked repo working tree (a Write OUTSIDE every
// tree — e.g. the scratchpad contract file — is allowed); and every Bash command
// off the delegation + close-out allowlist. The Bash decision is a POSITIVE
// allowlist, never a blocklist (Claude Code's own regex blocklist fell to
// CVE-2025-66032): the whole shell-operator / expansion / redirect / heredoc /
// substitution surface and every re-entrant wrapper (`sh -c`, `env`, xargs-with-
// flags, `find -exec`) are rejected UP FRONT, then only exact command families are
// allowed — so in-tree write vectors (redirect/heredoc/tee/sed -i, git apply/am,
// patch, cp/mv/tar) are all denied as off-list without needing target resolution.
//
// Like escalation-guard (the primary template), a MARKED session fails CLOSED
// (deny) on any command / payload it cannot positively clear, while an unmarked
// session fails OPEN (silent) so a human is never blocked. Every path exits 0 and
// emits AT MOST one JSON line (the deny envelope) or nothing.
//
// node:* imports only (no bun:sqlite / src/db.ts / plan plugin). The Write-target
// git-boundary probe walks the filesystem for a `.git` marker — that probe is
// injected so the decision core stays a pure, in-process-testable seam.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Payload + envelope types.
// ---------------------------------------------------------------------------

/** The PreToolUse hook payload fields the wrapped-guard decision reads. */
export interface WrappedGuardPayload {
  tool_name?: string;
  agent_id?: string;
  agent_type?: string;
  cwd?: string;
  tool_input?: {
    command?: string;
    file_path?: string;
    notebook_path?: string;
  };
}

/** The canonical PreToolUse deny envelope (exit-0 + JSON). */
export interface WrappedGuardDenyEnvelope {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/**
 * The injected filesystem seam for the Write-target tree check. Production wires
 * a node:fs-backed probe; tests pass a fake over a virtual repo layout so the
 * decision core needs no real git.
 */
export interface TreeProbe {
  /** Canonical absolute path of `abs`, resolving symlinks. For a not-yet-existing
   *  (create-new) path, resolve the nearest existing ancestor and re-append the
   *  missing tail. Returns null when even that fails. */
  realpath(abs: string): string | null;
  /** The tracked-repo toplevel containing the already-canonical `resolved` — the
   *  nearest ancestor directory holding a `.git` entry — or null when the path is
   *  in no tracked repo. */
  repoToplevel(resolved: string): string | null;
}

/** Optional private-log sink threaded through the pure core (noop in tests). */
export type LogSink = (record: Record<string, unknown>) => void;
const NOOP_LOG: LogSink = () => {};

// ---------------------------------------------------------------------------
// Shell lexer — quote-aware, single pass. Splits the command into segments of
// tokens and denies the structural bypass constructs (redirects, heredocs,
// command / process substitution) the moment it sees one outside single quotes.
// Adapted from escalation-guard's proven, CVE-hardened lexer.
// ---------------------------------------------------------------------------

type LexResult =
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "segments"; readonly segments: string[][] };

const SUBSTITUTION = "command/process substitution";
const HEREDOC = "a heredoc / here-string redirect";
const REDIRECT = "a file redirect";

/**
 * Tokenize `command` into segments (split on top-level `; | || && & newline` and
 * `(`/`)` grouping), honoring single/double quotes. A file redirect, heredoc, or
 * command/process substitution seen OUTSIDE single quotes short-circuits to a
 * deny — those are the file-write / arbitrary-exec bypass constructs a wrapped
 * worker may never use. Command substitution (`$(`, backtick) fires inside double
 * quotes too, because a real shell expands it there; single-quoted content stays
 * fully literal.
 */
function lexSegments(command: string): LexResult {
  const segments: string[][] = [];
  let seg: string[] = [];
  let word = "";
  let hasWord = false;
  let inSingle = false;
  let inDouble = false;

  const pushWord = (): void => {
    if (hasWord) {
      seg.push(word);
      word = "";
      hasWord = false;
    }
  };
  const pushSeg = (): void => {
    pushWord();
    if (seg.length > 0) {
      segments.push(seg);
      seg = [];
    }
  };

  const n = command.length;
  for (let i = 0; i < n; i++) {
    const c = command[i] as string;
    const next = i + 1 < n ? command[i + 1] : "";

    if (inSingle) {
      if (c === "'") inSingle = false;
      else {
        word += c;
        hasWord = true;
      }
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === "`") return { kind: "deny", reason: SUBSTITUTION };
      else if (c === "$" && next === "(")
        return { kind: "deny", reason: SUBSTITUTION };
      else {
        word += c;
        hasWord = true;
      }
      continue;
    }

    // --- unquoted ---
    if (c === "'") {
      inSingle = true;
      hasWord = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      hasWord = true;
      continue;
    }
    if (c === "\\") {
      if (next !== "") {
        word += next;
        hasWord = true;
        i++;
      }
      continue;
    }
    if (c === "`") return { kind: "deny", reason: SUBSTITUTION };
    if (c === "$" && next === "(")
      return { kind: "deny", reason: SUBSTITUTION };
    if ((c === "<" || c === ">") && next === "(")
      return { kind: "deny", reason: SUBSTITUTION };
    if (c === "<" && next === "<") return { kind: "deny", reason: HEREDOC };
    if (c === ">" || c === "<") return { kind: "deny", reason: REDIRECT };
    if (c === "&" && next === ">") return { kind: "deny", reason: REDIRECT };
    if (c === "\n" || c === ";") {
      pushSeg();
      continue;
    }
    if (c === "|") {
      pushSeg();
      if (next === "|") i++;
      continue;
    }
    if (c === "&") {
      pushSeg();
      if (next === "&") i++;
      continue;
    }
    if (c === "(" || c === ")") {
      pushSeg();
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      pushWord();
      continue;
    }
    word += c;
    hasWord = true;
  }
  // An unterminated quote is malformed input — fail closed for a marked session.
  if (inSingle || inDouble) {
    return {
      kind: "deny",
      reason: "an unterminated quote (malformed command)",
    };
  }
  pushSeg();
  return { kind: "segments", segments };
}

// ---------------------------------------------------------------------------
// Wrapper stripping + executable classification.
// ---------------------------------------------------------------------------

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Leading command wrappers whose own tokens are stripped so the WRAPPED command
 *  is the one classified. `xargs` is handled distinctly (bare only; with flags it
 *  denies). `env` is deliberately ABSENT — it is a re-entrant env-runner and stays
 *  off-list (denied). `sh`/`bash`/… are interpreters, denied before this. */
const WRAPPERS = new Set([
  "timeout",
  "time",
  "nice",
  "nohup",
  "stdbuf",
  "xargs",
]);

/** Interpreter / shell executables that are NEVER on the allowlist — an inline
 *  shell / interpreter reopens an exec context the classifier cannot see into.
 *  `bun` is NOT here — its test runner and named package-script surface are
 *  conditionally allowed, with eval flags and path-shaped run targets denied. */
const INTERPRETER_EXECUTABLES = new Set([
  "python",
  "python2",
  "python3",
  "node",
  "deno",
  "ruby",
  "perl",
  "php",
  "osascript",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "tclsh",
  "lua",
  "Rscript",
]);

/** bun flags/subcommands that evaluate inline code — denied. */
const BUN_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

/** The `keeper` top-level subcommands a wrapped worker may run: the delegation
 *  surface (`agent`), the close-out (`commit-work`, `plan done`), and the reads it
 *  orients on (`plan` reads, `session` state, `baseline`). None of these author
 *  source. Every other keeper subcommand is denied. */
const WRAPPED_KEEPER_SUBCOMMANDS = new Set([
  "agent",
  "session",
  "plan",
  "commit-work",
  "baseline",
]);

/** Read-only git subcommands allowed for a wrapped worker (staging `add` and
 *  `reset --soft` are handled separately; source commits route through Keeper).
 *  Mirrors escalation-guard's read set minus the ref-mutating `branch`, which a
 *  wrapped worker never needs. */
const READONLY_GIT_SUBCOMMANDS = new Set([
  "log",
  "show",
  "diff",
  "status",
  "rev-parse",
  "ls-files",
  "blame",
  "grep",
  "describe",
  "shortlog",
  "ls-tree",
  "cat-file",
]);

/**
 * Strip the leading wrapper tokens (timeout/time/nice/nohup/stdbuf/bare xargs)
 * from a segment's tokens, returning the wrapped command's tokens — or a deny
 * reason (xargs-with-flags, or too many stacked wrappers). Bounded loop.
 */
function stripWrappers(
  tokens: string[],
): { tokens: string[] } | { deny: string } {
  let rest = tokens;
  for (let guard = 0; guard < 8; guard++) {
    const head = rest[0];
    if (head === undefined || !WRAPPERS.has(head)) return { tokens: rest };
    if (head === "xargs") {
      if (rest[1]?.startsWith("-")) {
        return {
          deny: "`xargs` with flags (an -I/-exec-style command runner)",
        };
      }
      rest = rest.slice(1);
      continue;
    }
    if (head === "time" || head === "nohup") {
      rest = rest.slice(1);
      continue;
    }
    if (head === "nice") {
      let j = 1;
      if (rest[j] === "-n" && rest[j + 1] !== undefined) j += 2;
      else if (rest[j] !== undefined && /^-(n\d+|\d+)$/.test(rest[j] as string))
        j += 1;
      rest = rest.slice(j);
      continue;
    }
    if (head === "stdbuf") {
      let j = 1;
      while (rest[j] !== undefined && (rest[j] as string).startsWith("-")) {
        const flag = rest[j] as string;
        if (/^-[ioe]$/.test(flag) && rest[j + 1] !== undefined) j += 2;
        else j += 1;
      }
      rest = rest.slice(j);
      continue;
    }
    // timeout: skip its option flags (consuming -s/-k values), then the DURATION.
    let j = 1;
    while (rest[j] !== undefined && (rest[j] as string).startsWith("-")) {
      const flag = rest[j] as string;
      if (
        (flag === "-s" || flag === "-k") &&
        rest[j + 1] !== undefined &&
        !(rest[j + 1] as string).startsWith("-")
      ) {
        j += 2;
      } else {
        j += 1;
      }
    }
    if (rest[j] !== undefined) j += 1;
    rest = rest.slice(j);
  }
  return { deny: "too many stacked command wrappers" };
}

/** Global git options that consume a SEPARATE following token as their value, so
 *  it is not misread as the subcommand — and so the pre-subcommand injection scan
 *  spans the true global region even when a `-c` is reordered behind one. */
const GIT_VALUED_GLOBAL_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--attr-source",
]);

/** The first non-global token after `git` (the subcommand) and its token index,
 *  or undefined when there is none. A valued global option consumes its following
 *  value token so it is not mistaken for the subcommand. */
function gitSubcommandInfo(
  tokens: string[],
): { name: string; index: number } | undefined {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (GIT_VALUED_GLOBAL_FLAGS.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith("-")) {
      i += 1;
      continue;
    }
    return { name: t, index: i };
  }
  return undefined;
}

/** Deny a git config-injection global option (`-c <name>=<value>` /
 *  `--config-env=…`) — the vector that turns an allowlisted read subcommand into
 *  arbitrary program execution. Scans only the pre-subcommand global region. */
function gitConfigInjection(tokens: string[], boundary: number): string | null {
  for (let i = 1; i < boundary; i++) {
    const t = tokens[i] as string;
    if (t === "-c") {
      const val = tokens[i + 1];
      if (val?.includes("=")) {
        return "git `-c <name>=<value>` config injection (an exec-bearing config key turns an allowlisted read subcommand into arbitrary program execution)";
      }
      continue;
    }
    if (t === "--config-env" || t.startsWith("--config-env=")) {
      return "git `--config-env` config injection (reads a config value from an env var — the same exec-bearing bypass as `-c`)";
    }
  }
  return null;
}

/** True when `arg` is git's `--open-files-in-pager` exec alias in long form,
 *  including any unambiguous abbreviation git parse-options accepts (down to
 *  `--op`), in both bare and glued-`=<cmd>` forms. */
function isOpenFilesInPagerAbbrev(arg: string): boolean {
  const eq = arg.indexOf("=");
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  return (
    flag.length >= "--op".length && "--open-files-in-pager".startsWith(flag)
  );
}

/** Deny an exec-bearing or file-writing flag on an allowlisted READ subcommand:
 *  `git grep --open-files-in-pager[=<cmd>]` / `-O[<cmd>]` (opens matches in a
 *  caller-named program) and `--output[=<file>]` (writes a caller-named file — a
 *  flag, not a shell redirect, so the lexer's redirect deny never sees it). */
function gitReadSubcommandExecFlag(
  subArgs: string[],
  sub: string,
): string | null {
  for (const arg of subArgs) {
    if (arg === "--") break;
    if (isOpenFilesInPagerAbbrev(arg)) {
      return "git `--open-files-in-pager` opens matches in a caller-named program (arbitrary program execution from an allowlisted read subcommand)";
    }
    if (arg === "--output" || arg.startsWith("--output=")) {
      return "git `--output=<file>` writes to a caller-named file (an arbitrary file-write vector from an allowlisted read subcommand)";
    }
    if (sub === "grep" && /^-[A-Za-z]*O/.test(arg)) {
      return "git grep `-O`/`--open-files-in-pager` opens matches in a caller-named program (arbitrary program execution from an allowlisted read subcommand)";
    }
  }
  return null;
}

/** git reset is allowed ONLY in its `--soft` form (moves HEAD, keeps index and
 *  working tree). Bare/`--mixed`/`--hard`/`--merge`/`--keep` can discard staged or
 *  working-tree state, so they are denied. */
function classifyGitReset(resetArgs: string[]): string | null {
  const destructive = new Set([
    "--mixed",
    "--hard",
    "--merge",
    "--keep",
    "-p",
    "--patch",
  ]);
  if (resetArgs.some((a) => destructive.has(a))) {
    return "git `reset` with a working-tree/index-discarding mode (only `reset --soft` is permitted for a wrapped worker)";
  }
  if (resetArgs.includes("--soft")) return null;
  return "git `reset` is permitted only in its `--soft` form for a wrapped worker (bare reset defaults to --mixed and unstages)";
}

const BUN_TEST_VALUE_FLAGS = new Set([
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--coverage-reporter",
  "--coverage-dir",
  "--test-name-pattern",
  "-t",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--path-ignore-patterns",
  "--changed",
  "--parallel",
  "--parallel-delay",
  "--shard",
  "--preload",
]);

/** A direct Bun test is targeted only when it names a literal TypeScript test
 * file. Directories, globs, and option-only/name/watch/coverage forms are broad
 * discovery and must go through the named package gate. */
function classifyBunTest(tokens: string[]): string | null {
  const args = tokens.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      return args
        .slice(i + 1)
        .some((value) => !value.startsWith("-") && value.endsWith(".test.ts"))
        ? null
        : "direct `bun test` requires an explicit `*.test.ts` file (use `bun run test:gate` for aggregate discovery)";
    }
    if (BUN_TEST_VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith("-") && arg.endsWith(".test.ts")) {
      return null;
    }
  }
  return "direct `bun test` requires an explicit `*.test.ts` file (use `bun run test:gate` for aggregate discovery)";
}

/** Classify one already-wrapper-stripped segment's executable for a wrapped
 *  worker. Returns a deny reason, or null when the command is on the allowlist. */
function classifyWrappedExecutable(tokens: string[]): string | null {
  const exe = tokens[0] as string;

  if (INTERPRETER_EXECUTABLES.has(exe)) {
    return `interpreter/shell '${exe}' (inline code execution is never permitted for a wrapped worker — delegate to the provider leg)`;
  }

  if (exe === "keeper") {
    const sub = tokens[1];
    if (sub === undefined) return "bare `keeper` with no subcommand";
    if (WRAPPED_KEEPER_SUBCOMMANDS.has(sub)) return null;
    return `\`keeper ${sub}\` is not on the wrapped-worker allowlist (permitted: agent, session, plan, commit-work, baseline)`;
  }

  if (exe === "git") {
    const sub = gitSubcommandInfo(tokens);
    const injection = gitConfigInjection(tokens, sub?.index ?? tokens.length);
    if (injection !== null) return injection;
    if (sub === undefined) return "bare `git` with no subcommand";
    if (sub.name === "add") return null; // staging
    if (sub.name === "commit")
      return "raw `git commit` is forbidden; pass the provider's versioned path manifest to `keeper commit-work --adopt-from <file>`";
    if (sub.name === "reset")
      return classifyGitReset(tokens.slice(sub.index + 1));
    if (READONLY_GIT_SUBCOMMANDS.has(sub.name)) {
      const execFlag = gitReadSubcommandExecFlag(
        tokens.slice(sub.index + 1),
        sub.name,
      );
      if (execFlag !== null) return execFlag;
      return null;
    }
    return `git '${sub.name}' is not a permitted git subcommand for a wrapped worker (read + \`add\` / \`reset --soft\` only; source commits use keeper commit-work)`;
  }

  if (exe === "bun") {
    const sub = tokens[1];
    if (
      sub !== undefined &&
      (BUN_EVAL_FLAGS.has(sub) || sub.startsWith("--eval="))
    ) {
      return "`bun` inline-eval (-e/--eval/-p/--print) is never permitted";
    }
    if (sub === "test") return classifyBunTest(tokens);
    if (sub === "run") {
      const target = tokens[2];
      if (
        target !== undefined &&
        target.length > 0 &&
        !target.startsWith("-") &&
        !target.includes(".") &&
        !target.includes("/") &&
        !target.includes("\\")
      ) {
        return null;
      }
      return "`bun run` requires a named package script (file-path and option targets are not permitted)";
    }
    return `\`bun ${sub ?? ""}\` is not permitted (only \`bun test\` or \`bun run <named-package-script>\`)`;
  }

  return `off-list command '${exe}' (a wrapped worker's Bash surface is the delegation + close-out allowlist only)`;
}

/**
 * The pure Bash predicate: evaluate a raw command for a wrapped worker, returning
 * the first violation's reason (deny) or null (every segment is on the
 * allowlist). Structural bypass constructs (redirect/heredoc/substitution) are
 * caught by the lexer; each segment must then present an allowlisted executable
 * with no environment-assignment prefix. Exported for the table-driven tests.
 */
export function evaluateWrappedBash(command: string): string | null {
  const lexed = lexSegments(command);
  if (lexed.kind === "deny") return lexed.reason;
  for (const tokens of lexed.segments) {
    if (tokens.length === 0) continue;
    if (ENV_ASSIGN.test(tokens[0] as string)) {
      return `an environment-assignment prefix ('${tokens[0]}')`;
    }
    const stripped = stripWrappers(tokens);
    if ("deny" in stripped) return stripped.deny;
    if (stripped.tokens.length === 0)
      return "a command wrapper with no command";
    const reason = classifyWrappedExecutable(stripped.tokens);
    if (reason !== null) return reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deny reasons + envelope.
// ---------------------------------------------------------------------------

function denyEnvelope(reason: string): WrappedGuardDenyEnvelope {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

const DELEGATE_HINT =
  "A wrapped (delegated) worker never authors source — delegate all " +
  "implementation, tests, and lint iteration to the provider leg via " +
  "`keeper agent run --resume`, then own only the keeper close-out " +
  "(`keeper commit-work` + `keeper plan done`).";

function editToolReason(tool: string): string {
  return `Wrapped-cell worker BLOCKED: the ${tool} tool is denied outright. ${DELEGATE_HINT}`;
}

function writeInTreeReason(target: string, toplevel: string): string {
  return (
    `Wrapped-cell worker BLOCKED: Write to '${target}' lands inside the tracked ` +
    `repo working tree '${toplevel}'. ${DELEGATE_HINT} (A Write OUTSIDE every ` +
    `tracked tree — e.g. the scratchpad contract file — is allowed.)`
  );
}

function bashReason(violation: string): string {
  return (
    `Wrapped-cell worker BLOCKED: this Bash command is off the delegation + ` +
    `close-out allowlist: ${violation}. Permitted: \`keeper agent\` (run/--resume/` +
    `wait/wait-for-stop/show-last-message/providers), \`keeper commit-work\`, ` +
    `\`keeper plan done\` + reads, \`keeper session state\`, the permitted git ` +
    `surface (add / reset --soft / log / status / diff / show / rev-parse), ` +
    `and explicit \`bun test *.test.ts\` / named \`bun run test:gate\` gates. ` +
    `Every source-editing vector — redirects, heredocs, tee, sed -i, ` +
    `patch, cp/mv/tar, git apply/am, interpreters, and re-entrant shells — is denied.`
  );
}

const MALFORMED_REASON =
  "Wrapped-cell worker guard: the tool payload was malformed or missing its " +
  "target, so it could not be verified — denied (fail closed).";

function unknownToolReason(tool: string): string {
  return (
    `Wrapped-cell worker guard: the tool '${tool}' reached the guard on a guarded ` +
    `matcher and could not be positively cleared — denied (fail closed).`
  );
}

// ---------------------------------------------------------------------------
// Pure decision core.
// ---------------------------------------------------------------------------

/** True when the wrapped-cell marker is present and non-empty (empty == absent,
 *  the always-emitted native-cell carrier). */
export function isWrappedMarked(
  env: Record<string, string | undefined>,
): boolean {
  return (env.KEEPER_WRAPPED_CELL ?? "").trim() !== "";
}

/** Classify a Write target: true when it resolves inside a tracked repo tree,
 *  false when outside every tree, null when unresolvable. */
function writeTargetInTree(
  raw: string,
  cwd: string,
  probe: TreeProbe,
  log: LogSink,
): boolean | null {
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const resolved = probe.realpath(abs);
  if (resolved === null) {
    log({ event: "write-unresolvable", target: raw });
    return null;
  }
  const toplevel = probe.repoToplevel(resolved);
  if (toplevel === null) {
    log({ event: "write-outside-tree", target: raw, resolved });
    return false;
  }
  log({ event: "write-in-tree", target: raw, resolved, toplevel });
  return true;
}

/**
 * Pure decision: the deny envelope for this (payload, env), or null to allow (no
 * output). The jurisdiction is two-condition (marker non-empty AND subagent
 * `agent_id`); a marked session fails CLOSED on anything it cannot positively
 * clear, an unmarked one is inert (fail open). A non-Write edit tool is denied
 * outright; a Write is denied only in-tree; a Bash command must clear the
 * delegation + close-out allowlist.
 */
export function decideWrappedGuard(
  payload: unknown,
  env: Record<string, string | undefined>,
  probe?: TreeProbe,
  log: LogSink = NOOP_LOG,
): WrappedGuardDenyEnvelope | null {
  if (!isWrappedMarked(env)) return null; // unmarked → inert, fail open

  // Marked → fail CLOSED on a payload we cannot read (agent_id / target unknown).
  if (payload === null || typeof payload !== "object") {
    return denyEnvelope(MALFORMED_REASON);
  }
  const p = payload as WrappedGuardPayload;

  // Fire ONLY for the wrapped `work:worker` subagent — the wrapper's own marked
  // orchestrator session (no agent_id) stays inert, as does a human.
  if (!p.agent_id && !p.agent_type) return null;

  const tool = p.tool_name;

  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    // Deny-precedence / single-state: an edit tool is denied REGARDLESS of the
    // target path (even one outside the tree) — the out-of-tree allowance is
    // Write's alone, and there is no phase / envelope unlock.
    return denyEnvelope(editToolReason(tool));
  }

  if (tool === "Write") {
    const fp = p.tool_input?.file_path;
    if (typeof fp !== "string" || fp.length === 0) {
      return denyEnvelope(MALFORMED_REASON);
    }
    const cwd =
      typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : process.cwd();
    const resolvedProbe = probe ?? fsProbe();
    const inTree = writeTargetInTree(fp, cwd, resolvedProbe, log);
    if (inTree === null) return denyEnvelope(MALFORMED_REASON); // unresolvable → fail closed
    if (!inTree) return null; // outside every tracked tree → allow
    const abs = isAbsolute(fp) ? fp : resolve(cwd, fp);
    const toplevel =
      resolvedProbe.repoToplevel(resolvedProbe.realpath(abs) ?? abs) ?? "";
    return denyEnvelope(writeInTreeReason(fp, toplevel));
  }

  if (tool === "Bash") {
    const command = p.tool_input?.command;
    if (typeof command !== "string") return denyEnvelope(MALFORMED_REASON);
    const violation = evaluateWrappedBash(command);
    if (violation === null) return null; // allowlisted → allow
    return denyEnvelope(bashReason(violation));
  }

  // A tool we do not recognize reached a guarded matcher for a marked subagent —
  // fail closed (we cannot positively clear an unknown edit-capable tool).
  return denyEnvelope(
    unknownToolReason(typeof tool === "string" ? tool : "<none>"),
  );
}

// ---------------------------------------------------------------------------
// Production filesystem probe (node:fs).
// ---------------------------------------------------------------------------

/** Canonicalize `abs`, falling back to the nearest existing ancestor + missing
 *  tail for a create-new path; null when nothing on the chain resolves. */
function realpathNearest(abs: string): string | null {
  try {
    return realpathSync(abs);
  } catch {
    const tail: string[] = [];
    let cur = abs;
    for (let guard = 0; guard < 4096; guard++) {
      const parent = dirname(cur);
      if (parent === cur) return null;
      tail.unshift(basename(cur));
      cur = parent;
      try {
        return join(realpathSync(cur), ...tail);
      } catch {
        // keep walking up
      }
    }
    return null;
  }
}

/** The nearest ancestor directory of the already-canonical `resolved` holding a
 *  `.git` entry (a worktree's `.git` FILE counts), or null when none. */
function repoToplevelOf(resolved: string): string | null {
  let cur: string;
  try {
    cur =
      existsSync(resolved) && statSync(resolved).isDirectory()
        ? resolved
        : dirname(resolved);
  } catch {
    cur = dirname(resolved);
  }
  for (let guard = 0; guard < 4096; guard++) {
    try {
      if (existsSync(join(cur, ".git"))) return cur;
    } catch {
      // treat a probe error as "no marker here" and keep walking up
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** The node:fs-backed probe wired into production. */
export function fsProbe(): TreeProbe {
  return { realpath: realpathNearest, repoToplevel: repoToplevelOf };
}

// ---------------------------------------------------------------------------
// Private logging — single-line JSON, size-bounded, NEVER host stdout.
// ---------------------------------------------------------------------------

function logPath(env: Record<string, string | undefined>): string {
  const override = (env.KEEPER_WRAPPED_GUARD_LOG ?? "").trim();
  if (override !== "") return override;
  return join(homedir(), ".local", "state", "keeper", "wrapped-guard.log");
}

function makeLogSink(env: Record<string, string | undefined>): LogSink {
  return (record) => {
    try {
      const p = logPath(env);
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      let line = JSON.stringify({ ts: new Date().toISOString(), ...record });
      if (line.length > 4096) line = `${line.slice(0, 4096)}…`;
      appendFileSync(p, `${line}\n`, { mode: 0o600 });
    } catch {
      // best-effort; a logging failure is never fatal and never surfaces.
    }
  };
}

// ---------------------------------------------------------------------------
// Entry point — always exit 0; fail CLOSED for a marked session, OPEN otherwise.
// ---------------------------------------------------------------------------

/** Read all of stdin as text (size-bounded). `Bun.stdin.stream()` avoids the
 *  macOS `process.stdin` buffer-until-close hang (Bun #18239). */
async function readStdin(): Promise<string> {
  const text = await new Response(Bun.stdin.stream()).text();
  return text.length > 1_000_000 ? text.slice(0, 1_000_000) : text;
}

function emit(decision: WrappedGuardDenyEnvelope | null): void {
  if (decision !== null) process.stdout.write(`${JSON.stringify(decision)}\n`);
}

async function main(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    raw = "";
  }
  let payload: unknown = null;
  let parsed = false;
  try {
    payload = JSON.parse(raw);
    parsed = true;
  } catch {
    parsed = false;
  }
  try {
    // A parse failure under a marker is a malformed payload → decideWrappedGuard
    // fails closed on the non-object; an unmarked session stays silent.
    emit(
      decideWrappedGuard(
        parsed ? payload : null,
        env,
        fsProbe(),
        makeLogSink(env),
      ),
    );
  } catch {
    // Last-resort internal error: fail CLOSED for a marked session, OPEN otherwise.
    if (isWrappedMarked(env)) emit(denyEnvelope(MALFORMED_REASON));
  }
}

if (import.meta.main) {
  main().catch(() => {
    if (isWrappedMarked(process.env as Record<string, string | undefined>)) {
      emit(denyEnvelope(MALFORMED_REASON));
    }
  });
}
