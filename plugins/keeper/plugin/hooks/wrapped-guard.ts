#!/usr/bin/env bun
// PreToolUse(Write|Edit|MultiEdit|NotebookEdit|Bash) wrapped-cell total-edit-denial guard.
//
// Fourth sibling of branch-guard / grant-guard / wrong-tree-guard. A WRAPPED
// worker cell's `work:worker` is a claude wrapper that delegates ALL implementation
// (code, tests, lint iteration) to the model's serving provider via `keeper agent
// run --resume` and owns only the keeper close-out (`commit-work` + task-bound
// `plan done`, or an AUDIT_READY self-park).
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
// whose target is not a fresh inert handoff leaf in an owner-private system-temp
// directory (the guard descriptor-writes it, then denies the host Write); and every Bash command
// off the delegation + close-out allowlist. The Bash decision is a POSITIVE
// allowlist, never a blocklist (Claude Code's own regex blocklist fell to
// CVE-2025-66032): the whole shell-operator / expansion / redirect / heredoc /
// substitution surface and every re-entrant wrapper (`sh -c`, `env`, xargs-with-
// flags, `find -exec`) are rejected UP FRONT, then only exact command families are
// allowed — so in-tree write vectors (redirect/heredoc/tee/sed -i, git apply/am,
// patch, cp/mv/tar) are all denied as off-list without needing target resolution.
//
// Like grant-guard, a MARKED session fails CLOSED
// (deny) on any command / payload it cannot positively clear, while an unmarked
// session fails OPEN (silent) so a human is never blocked. Every path exits 0 and
// emits AT MOST one JSON line (the deny envelope) or nothing.
//
// node:* imports only (no bun:sqlite / src/db.ts / plan plugin). The Write-target
// git-boundary probe walks the filesystem for a `.git` marker — that probe is
// injected so the decision core stays a pure, in-process-testable seam.

import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { grantCoversWrite } from "../../../../src/grant-leaf.ts";

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
    content?: string;
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
  /** Existing scratch targets must be inert, singly linked regular files. */
  scratchFileSafe(resolved: string): boolean;
  /** The quality-auditor's submit `--file` must be an EXISTING, singly linked,
   *  non-symlink `.json` under an owner-private system-temp parent — the exact
   *  class of file its scratch Write is allowed to create. `absPath` is the raw
   *  lexical `--file` value so a symlink at the leaf is caught (not followed). */
  auditSubmitFile(absPath: string): boolean;
}

/** Optional private-log sink threaded through the pure core (noop in tests). */
export type LogSink = (record: Record<string, unknown>) => void;
const NOOP_LOG: LogSink = () => {};

/** A grant-override seam: true when a valid escalation grant authorizes a write
 *  to this already-canonical target, so the wrapped total-edit denial yields to
 *  it (an escalation subagent is not the wrapped `work:worker` this guard binds).*/
export type GrantOverride = (canonicalTarget: string) => boolean;
const NO_GRANT: GrantOverride = () => false;

// ---------------------------------------------------------------------------
// Shell lexer — quote-aware, single pass. Splits the command into segments of
// tokens and denies the structural bypass constructs (redirects, heredocs,
// command / process substitution) the moment it sees one outside single quotes.
// The shared CVE-hardened quote-aware lexer (mirrored across the Bash guards).
// ---------------------------------------------------------------------------

type LexResult =
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "segments"; readonly segments: string[][] };

const SUBSTITUTION = "command/process substitution";
const HEREDOC = "a heredoc / here-string redirect";
const REDIRECT = "a file redirect";

function skipLineContinuations(command: string, from: number): number {
  let i = from;
  while (command[i] === "\\" && command[i + 1] === "\n") i += 2;
  return i;
}

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
      else if (c === "\\" && next === "\n") i++;
      else if (c === "`") return { kind: "deny", reason: SUBSTITUTION };
      else if (
        c === "$" &&
        command[skipLineContinuations(command, i + 1)] === "("
      )
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
      if (next === "\n") {
        i++;
      } else if (next !== "") {
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
/** System temp roots a `mktemp -d` handoff dir may sit under. `os.tmpdir()` is
 *  the process's own resolution (the launchd `/var/folders/.../T` on macOS); the
 *  literals cover the roots a wrapped worker's shell can name directly when its
 *  env carries a different or absent `TMPDIR`. `pathInside` rejects any escape. */
const SYSTEM_TMP_ROOTS: readonly string[] = [tmpdir(), "/tmp", "/private/tmp"];

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
 *  surface (`agent`), the close-out (`commit-work`, task-bound `plan done` or
 *  AUDIT_READY self-park), and the reads it
 *  orients on (`plan` reads, `session` state, `baseline`). None of these author
 *  source. Every other keeper subcommand is denied except the separately
 *  shape-checked send-only `bus` notice. */
const WRAPPED_KEEPER_SUBCOMMANDS = new Set([
  "agent",
  "session",
  "commit-work",
  "baseline",
]);

const WRAPPED_PLAN_VERBS = new Set([
  "done",
  "block",
  "status",
  "tasks",
  "show",
  "cat",
  "list",
  "epics",
  "reconcile",
  "find-task-commit",
]);

/** Read-only git subcommands allowed for a wrapped worker. Source/index/ref
 *  mutations route through the provider leg or Keeper close-out.
 *  Mirrors grant-guard's read set minus the ref-mutating `branch`, which a
 *  wrapped worker never needs. */
const READONLY_GIT_SUBCOMMANDS = new Set([
  "log",
  "show",
  "diff",
  "status",
  "rev-parse",
  "ls-files",
  "grep",
  "ls-tree",
  "cat-file",
]);

const WRAPPED_PROVIDER_HARNESSES = new Set(["codex", "hermes", "pi"]);
const WRAPPED_PROVIDER_VALUE_OPTIONS = new Set([
  "--model",
  "--preset",
  "--system-file",
  "--session",
  "--name",
  "--output",
  "--stop-timeout",
  "--resume",
]);
const WRAPPED_PROVIDER_BOOLEAN_OPTIONS = new Set(["--reap-window-on-terminal"]);
const RUN_GATE_STEER =
  "Do not retry the same quoting; use a single short, single-line double-quoted " +
  "instruction with no substitutions, with any longer content in --system-file.";

export interface WrappedCommandContext {
  taskId?: string;
  envelopeReference?: string;
  /** The harness-supplied payload `agent_type` of the marked subagent, threaded
   *  from the PreToolUse payload (never env, never the command). It gates the
   *  narrow per-task audit-submit carve-out below — the same unspoofable identity
   *  anchor grant-guard keys the four escalation agents on. */
  agentType?: string;
  /** Injected filesystem seam binding the auditor's submit `--file` to the class
   *  of file it may create (an existing inert `.json` under its owner-private
   *  system-temp scratchpad). Absent in the pure table tests (shape-only); wired
   *  to the TreeProbe in `decideWrappedGuard`. */
  auditFileProbe?: (absoluteFilePath: string) => boolean;
}

/** The static per-task audit gate's `plan:quality-auditor` subagent inherits its
 *  wrapped parent's `KEEPER_WRAPPED_CELL` marker, so the guard fires on it — yet
 *  its ONLY legitimate mutation is persisting findings via `keeper plan audit
 *  submit-task`. `agent_type` is set by the harness, not the subagent (the same
 *  trust anchor grant-guard uses for its escalation set), so admitting exactly
 *  this value cannot be forged by the wrapped courier or any other marked
 *  subagent, and the auditor authors no source (Edit/Write/Task are off in its
 *  agent definition; the guard's other denials stay intact for it). */
const WRAPPED_AUDIT_AGENT_TYPE = "plan:quality-auditor";

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
    if (t.startsWith("-c") && t !== "-c") {
      return "glued git -c configuration injection is forbidden";
    }
    if (t === "-c") {
      const val = tokens[i + 1];
      if (
        val !== "core.fsmonitor=false" &&
        val !== "core.pager=cat" &&
        val !== "log.showSignature=false"
      ) {
        return "git `-c <name>=<value>` config injection (only fixed helper-disabling overrides are permitted)";
      }
      i += 1;
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

/** Raw reset moves a shared branch before Keeper can validate a captured base. */
function classifyGitReset(_resetArgs: string[]): string {
  return "raw `git reset` is forbidden for a wrapped worker; a provider-created commit must be unwound by the provider leg or treated as a tooling failure";
}

function wrappedCommitWorkHasTaskId(
  tokens: string[],
  expectedTask: string | undefined,
): boolean {
  if (expectedTask === undefined) return false;
  for (let index = 2; index < tokens.length; index += 1) {
    const arg = tokens[index] as string;
    if (arg === "--") return false;
    if (arg === "--task-id") return tokens[index + 1] === expectedTask;
    if (arg.startsWith("--task-id=")) {
      return arg.slice("--task-id=".length) === expectedTask;
    }
  }
  return false;
}

/**
 * Narrow jurisdiction carve-out for the per-task audit gate. Admit the findings
 * submit for ONLY the harness-identified `plan:quality-auditor` (see
 * WRAPPED_AUDIT_AGENT_TYPE), ONLY the `submit-task` verb, and ONLY when: the
 * positional TASK_ID equals the launch-bound task; exactly one `--file` and one
 * `--status` (at most one `--project`/`--format`) so no duplicate authority flag
 * slips a value past the guard; and the `--file` is an absolute path the injected
 * `auditFileProbe` confirms is an existing inert `.json` under the auditor's
 * owner-private scratchpad. The `--file -`/stdin form is denied on purpose so the
 * courier lexer's heredoc/redirect denial stays untouched; every other agent_type
 * — the wrapped courier included — and every other `keeper plan audit` shape
 * (submit, gate-check, …) stays denied.
 */
function wrappedAuditSubmitViolation(
  tokens: string[],
  context: WrappedCommandContext,
): string | null {
  if (context.agentType !== WRAPPED_AUDIT_AGENT_TYPE) {
    return "wrapped `keeper plan audit` is permitted only for the quality-auditor's per-task findings submit";
  }
  if (tokens[3] !== "submit-task") {
    return "wrapped `keeper plan audit` permits only the `submit-task` findings submit";
  }
  // Track occurrence COUNTS, not booleans, so a duplicate authority flag in
  // EITHER the glued (`--file=x`) or split (`--file x`) form is denied — the CLI
  // parser's precedence can never resolve a value the guard did not reason over.
  let fileCount = 0;
  let statusCount = 0;
  let projectCount = 0;
  let formatCount = 0;
  let fileValue: string | undefined;
  const positionals: string[] = [];
  for (let index = 4; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq === -1 ? token : token.slice(0, eq);
    const glued = eq === -1 ? undefined : token.slice(eq + 1);
    if (flag === "--file") {
      const value = glued ?? tokens[index + 1];
      if (
        value === undefined ||
        value === "" ||
        value === "-" ||
        value.startsWith("--")
      ) {
        return "wrapped `keeper plan audit submit-task --file` requires a real file PATH (the `-`/stdin+heredoc form is denied — write the findings JSON to a scratch file, then submit that path)";
      }
      fileCount += 1;
      fileValue = value;
      if (glued === undefined) index += 1;
      continue;
    }
    if (flag === "--status") {
      const value = glued ?? tokens[index + 1];
      if (value !== "clean" && value !== "mild" && value !== "severe") {
        return "wrapped `keeper plan audit submit-task --status` must be one of clean/mild/severe";
      }
      statusCount += 1;
      if (glued === undefined) index += 1;
      continue;
    }
    if (flag === "--project") {
      const value = glued ?? tokens[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return "wrapped `keeper plan audit submit-task --project` requires a value";
      }
      projectCount += 1;
      if (glued === undefined) index += 1;
      continue;
    }
    if (flag === "--format") {
      const value = glued ?? tokens[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return "wrapped `keeper plan audit submit-task --format` requires a value";
      }
      formatCount += 1;
      if (glued === undefined) index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      return `wrapped \`keeper plan audit submit-task\` rejects the unrecognized option '${token}'`;
    }
    positionals.push(token);
  }
  if (fileCount !== 1) {
    return "wrapped `keeper plan audit submit-task` requires exactly one --file <path>";
  }
  if (statusCount !== 1) {
    return "wrapped `keeper plan audit submit-task` requires exactly one --status";
  }
  if (projectCount > 1) {
    return "wrapped `keeper plan audit submit-task` permits at most one --project";
  }
  if (formatCount > 1) {
    return "wrapped `keeper plan audit submit-task` permits at most one --format";
  }
  if (positionals.length !== 1) {
    return "wrapped `keeper plan audit submit-task` requires exactly one TASK_ID positional";
  }
  // Bind the submit to the launch-bound task — a marked auditor for task A can
  // never submit or overwrite task B's finding (the same binding done/block use).
  if (context.taskId === undefined || positionals[0] !== context.taskId) {
    return "wrapped `keeper plan audit submit-task` must name the launch-bound task";
  }
  // The findings file is an absolute scratchpad path so the class probe has no
  // cwd ambiguity, and it must point at the exact class of file the auditor may
  // create: an existing inert `.json` under its owner-private system-temp parent.
  const file = fileValue as string;
  if (!isAbsolute(file)) {
    return "wrapped `keeper plan audit submit-task --file` must be an absolute scratchpad path";
  }
  if (context.auditFileProbe && !context.auditFileProbe(file)) {
    return "wrapped `keeper plan audit submit-task --file` must point at an existing inert .json findings file under your private system-temp scratchpad";
  }
  return null;
}

function wrappedPlanViolation(
  tokens: string[],
  context: WrappedCommandContext,
): string | null {
  const verb = tokens[2];
  if (verb === "audit") return wrappedAuditSubmitViolation(tokens, context);
  if (verb === undefined || !WRAPPED_PLAN_VERBS.has(verb)) {
    return "wrapped `keeper plan` permits only task-bound `done`/`block`, the quality-auditor's `audit submit-task`, and read-only status/tasks/show/cat/list/epics/reconcile verbs";
  }
  if (verb !== "done" && verb !== "block") return null;
  if (context.taskId === undefined || tokens[3] !== context.taskId) {
    return `wrapped \`keeper plan ${verb}\` must name the launch-bound task`;
  }
  if (verb === "block") {
    for (const option of tokens.slice(4)) {
      if (option === "--force" || option.startsWith("--force=")) {
        return "wrapped `keeper plan block --force` is forbidden";
      }
    }
    if (tokens.length !== 6 || tokens[4] !== "--reason") {
      return "wrapped `keeper plan block` permits only one --reason value";
    }
    if (!(tokens[5] as string).startsWith("AUDIT_READY:")) {
      return "wrapped `keeper plan block --reason` must start with `AUDIT_READY:`";
    }
    return null;
  }
  for (let index = 4; index < tokens.length; index += 1) {
    const option = tokens[index] as string;
    if (option === "--force" || option.startsWith("--force=")) {
      return "wrapped `keeper plan done --force` is forbidden";
    }
    if (option !== "--summary" && option !== "--evidence") {
      return "wrapped `keeper plan done` permits only --summary/--evidence metadata";
    }
    if (tokens[index + 1] === undefined) {
      return `wrapped \`keeper plan done ${option}\` requires a value`;
    }
    index += 1;
  }
  return null;
}

function wrappedBusViolation(tokens: string[]): string | null {
  return tokens.length === 6 &&
    tokens[2] === "chat" &&
    tokens[3] === "send"
    ? null
    : "wrapped `keeper bus` permits only `keeper bus chat send <target> <message>`";
}

function runGateExcerpt(token: string | undefined): string {
  const sanitized = Array.from(token ?? "<missing>", (char) => {
    const codePoint = char.codePointAt(0) as number;
    return codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      (codePoint >= 0x2060 && codePoint <= 0x206f) ||
      codePoint === 0xfeff
      ? "?"
      : char;
  }).join("");
  let excerpt = "";
  let byteLength = 0;
  let truncated = false;
  for (const char of sanitized) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (byteLength + charBytes > 64) {
      truncated = true;
      break;
    }
    excerpt += char;
    byteLength += charBytes;
  }
  return JSON.stringify(`${excerpt}${truncated ? "… [truncated]" : ""}`);
}

function runGateDeny(
  construct: string,
  positional: readonly string[],
  offendingToken: string | undefined,
): string {
  return (
    `wrapped provider run ${construct}: expected positional count 1, received ` +
    `${positional.length}; first offending token ${runGateExcerpt(offendingToken)}. ` +
    RUN_GATE_STEER
  );
}

function providerRunPositionals(tokens: readonly string[]): string[] {
  const positional: string[] = [];
  for (let index = 4; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    if (WRAPPED_PROVIDER_BOOLEAN_OPTIONS.has(token)) continue;
    if (
      WRAPPED_PROVIDER_VALUE_OPTIONS.has(token) &&
      tokens[index + 1] !== undefined &&
      !(tokens[index + 1] as string).startsWith("--")
    ) {
      index += 1;
    }
  }
  return positional;
}

function wrappedAgentViolation(
  tokens: string[],
  context: WrappedCommandContext,
): string | null {
  const verb = tokens[2];
  if (verb === "providers") {
    return tokens[3] === "resolve" && tokens.length === 6
      ? null
      : "wrapped provider discovery permits only `keeper agent providers resolve <model> <effort>`";
  }
  if (verb === "wait" || verb === "wait-for-stop") {
    if (tokens.length === 4) return null;
    return tokens.length === 6 &&
      tokens[4] === "--stop-timeout" &&
      /^\d+(?:ms|s|m)$/.test(tokens[5] as string)
      ? null
      : `wrapped \`keeper agent ${verb}\` accepts one handle and an optional bounded --stop-timeout`;
  }
  if (verb === "show-last-message") {
    return tokens.length === 4
      ? null
      : "wrapped `keeper agent show-last-message` accepts exactly one handle";
  }
  if (verb !== "run") {
    return "wrapped `keeper agent` permits only constrained provider run/wait/show/providers operations";
  }

  const positional = providerRunPositionals(tokens);
  const provider = tokens[3];
  if (provider === undefined || !WRAPPED_PROVIDER_HARNESSES.has(provider)) {
    return runGateDeny(
      "provider harness construct (expected codex, hermes, or pi)",
      positional,
      provider,
    );
  }

  const values = new Map<string, string>();
  // One-shot leg posture: a wrapped leg must not outlive its landed envelope —
  // a resident leg holds live claims that wedge the wrapper's own commit-work.
  const flags = new Set<string>();
  for (let index = 4; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!token.startsWith("--")) continue;
    if (WRAPPED_PROVIDER_BOOLEAN_OPTIONS.has(token)) {
      if (flags.has(token)) {
        return runGateDeny(
          "duplicate boolean option construct",
          positional,
          token,
        );
      }
      flags.add(token);
      continue;
    }
    if (!WRAPPED_PROVIDER_VALUE_OPTIONS.has(token)) {
      return runGateDeny(
        positional.length > 0
          ? "option-lookalike in instruction prose construct"
          : "unsupported option construct",
        positional,
        token,
      );
    }
    if (values.has(token)) {
      return runGateDeny("duplicate value option construct", positional, token);
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return runGateDeny("missing option value construct", positional, token);
    }
    values.set(token, value);
    index += 1;
  }
  if (positional.length === 0) {
    return runGateDeny("positional count construct", positional, undefined);
  }
  if (positional.length > 1) {
    return runGateDeny("quoting split construct", positional, positional[1]);
  }
  if (positional[0] === "") {
    return runGateDeny(
      "empty positional instruction construct",
      positional,
      "",
    );
  }

  let bindingMismatch = true;
  let bindingOffender: string | undefined;
  if (values.get("--session") !== "wrapped") {
    bindingOffender = values.get("--session");
  } else if (
    context.taskId === undefined ||
    values.get("--name") !== context.taskId
  ) {
    bindingOffender = values.get("--name");
  } else if (
    context.envelopeReference === undefined ||
    values.get("--output") !== context.envelopeReference
  ) {
    bindingOffender = values.get("--output");
  } else if (!/^\d+(?:ms|s|m)$/.test(values.get("--stop-timeout") ?? "")) {
    bindingOffender = values.get("--stop-timeout");
  } else {
    bindingMismatch = false;
  }
  if (bindingMismatch) {
    return runGateDeny(
      "launch-context binding construct (--session/--name/--output/--stop-timeout)",
      positional,
      bindingOffender,
    );
  }

  const resumed = values.has("--resume");
  if (!resumed && !values.has("--system-file")) {
    return runGateDeny(
      "missing --system-file construct on an initial launch",
      positional,
      undefined,
    );
  }
  if (!resumed && values.has("--model") === values.has("--preset")) {
    const modelIndex = tokens.indexOf("--model");
    const presetIndex = tokens.indexOf("--preset");
    const secondSelector =
      modelIndex >= 0 && presetIndex >= 0
        ? tokens[Math.max(modelIndex, presetIndex)]
        : undefined;
    return runGateDeny(
      "model/preset option-count construct (expected exactly one)",
      positional,
      secondSelector,
    );
  }
  return null;
}

const SAFE_PRETTY_FORMATS = new Set([
  "oneline",
  "short",
  "medium",
  "full",
  "fuller",
  "reference",
  "email",
  "mboxrd",
  "raw",
]);

function gitSignatureFormatViolation(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--") break;
    const longFlag = arg.split("=", 1)[0] as string;
    if (
      longFlag.length >= "--show-s".length &&
      "--show-signature".startsWith(longFlag)
    ) {
      return "git signature display may execute a configured verification program";
    }
    if (/%G[?GSFKPT]/.test(arg)) {
      return "git `%G*` formatting may execute a configured verification program";
    }
    const glued = /^(?:--format|--pretty|--tformat)=(.*)$/.exec(arg);
    if (glued) {
      const value = glued[1] as string;
      if (
        arg.startsWith("--pretty=") &&
        !value.startsWith("format:") &&
        !value.startsWith("tformat:") &&
        !SAFE_PRETTY_FORMATS.has(value)
      ) {
        return "configured git pretty-format aliases are forbidden for a wrapped worker";
      }
      continue;
    }
    if (arg === "--format" || arg === "--tformat" || arg === "--pretty") {
      const value = args[index + 1];
      if (value === undefined) continue;
      if (/%G[?GSFKPT]/.test(value)) {
        return "git `%G*` formatting may execute a configured verification program";
      }
      if (
        arg === "--pretty" &&
        !value.startsWith("format:") &&
        !value.startsWith("tformat:") &&
        !SAFE_PRETTY_FORMATS.has(value)
      ) {
        return "configured git pretty-format aliases are forbidden for a wrapped worker";
      }
      index += 1;
    }
  }
  return null;
}

function safeGitReadViolation(
  tokens: string[],
  sub: { name: string; index: number },
): string | null {
  let noPager = false;
  let fsmonitorDisabled = false;
  let pagerPinned = false;
  let signaturesDisabled = false;
  for (let index = 1; index < sub.index; index += 1) {
    const token = tokens[index] as string;
    if (token === "--no-pager" || token === "-P") {
      noPager = true;
      continue;
    }
    if (token === "--paginate" || token === "-p") {
      return "git pagination is forbidden for a wrapped worker";
    }
    if (token === "-c") {
      const value = tokens[index + 1];
      if (value === "core.fsmonitor=false") fsmonitorDisabled = true;
      else if (value === "core.pager=cat") pagerPinned = true;
      else if (value === "log.showSignature=false") signaturesDisabled = true;
      else {
        return "git -c is limited to the fixed helper-disabling hardening overrides";
      }
      index += 1;
    }
  }
  const args = tokens.slice(sub.index + 1);
  if (
    sub.name === "cat-file" &&
    args.some((arg) =>
      new Set(["--filters", "--textconv"]).has(arg.split("=")[0] as string),
    )
  ) {
    return "git cat-file filters/textconv may execute configured repository helpers";
  }
  if (new Set(["rev-parse", "ls-tree", "cat-file"]).has(sub.name)) {
    return null;
  }
  if (!noPager || !fsmonitorDisabled || !pagerPinned) {
    return "configured Git helpers are disabled only by the required `-c core.fsmonitor=false -c core.pager=cat --no-pager` prefix";
  }
  if (new Set(["diff", "log", "show"]).has(sub.name)) {
    if (
      !args.includes("--no-ext-diff") ||
      !args.includes("--no-textconv") ||
      args.includes("--ext-diff") ||
      args.includes("--textconv")
    ) {
      return `git ${sub.name} requires --no-ext-diff and --no-textconv to suppress configured executables`;
    }
  }
  if (sub.name === "log" || sub.name === "show") {
    if (!signaturesDisabled) {
      return `git ${sub.name} requires -c log.showSignature=false to suppress configured verification programs`;
    }
    const signatureViolation = gitSignatureFormatViolation(args);
    if (signatureViolation !== null) return signatureViolation;
  }
  if (sub.name === "grep" && args.includes("--textconv")) {
    return "git grep --textconv may execute a configured helper";
  }
  return null;
}

/** Classify one already-wrapper-stripped segment's executable for a wrapped
 *  worker. Returns a deny reason, or null when the command is on the allowlist. */
function classifyWrappedExecutable(
  tokens: string[],
  context: WrappedCommandContext,
): string | null {
  const exe = tokens[0] as string;

  if (INTERPRETER_EXECUTABLES.has(exe)) {
    return `interpreter/shell '${exe}' (inline code execution is never permitted for a wrapped worker — delegate to the provider leg)`;
  }

  if (exe === "keeper") {
    const sub = tokens[1];
    if (sub === undefined) return "bare `keeper` with no subcommand";
    if (sub === "commit-work") {
      return wrappedCommitWorkHasTaskId(tokens, context.taskId)
        ? null
        : "wrapped `keeper commit-work` requires the launch-bound --task-id";
    }
    if (sub === "plan") return wrappedPlanViolation(tokens, context);
    if (sub === "agent") return wrappedAgentViolation(tokens, context);
    if (sub === "bus") return wrappedBusViolation(tokens);
    if (WRAPPED_KEEPER_SUBCOMMANDS.has(sub)) return null;
    return `\`keeper ${sub}\` is not on the wrapped-worker allowlist (permitted: agent, session, bounded plan reads/done/AUDIT_READY block, commit-work, baseline)`;
  }

  if (exe === "git") {
    const sub = gitSubcommandInfo(tokens);
    const injection = gitConfigInjection(tokens, sub?.index ?? tokens.length);
    if (injection !== null) return injection;
    if (sub === undefined) return "bare `git` with no subcommand";
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
      return safeGitReadViolation(tokens, sub);
    }
    return `git '${sub.name}' is not a permitted git subcommand for a wrapped worker (read-only Git only; source commits use keeper commit-work)`;
  }

  if (exe === "mktemp") {
    const template = tokens[2];
    if (
      tokens.length === 3 &&
      tokens[1] === "-d" &&
      template !== undefined &&
      isAbsolute(template) &&
      // A wrapped worker cannot discover the hook's own `os.tmpdir()` value (the
      // per-process launchd `/var/folders/.../T` on macOS), so accept any
      // recognized system-temp root it CAN name — the `keeper-wrapped-*XXXXXX`
      // basename below is the security boundary, not the specific temp root, and
      // `pathInside` still rejects any `..` escape out of the accepted root.
      SYSTEM_TMP_ROOTS.some((root) => pathInside(root, template)) &&
      /^keeper-wrapped-[A-Za-z0-9._-]*X{6,}$/.test(basename(template))
    ) {
      return null;
    }
    return "mktemp is limited to `mktemp -d <system-tmp>/keeper-wrapped-XXXXXX` private handoff directories";
  }

  if (exe === "bun") {
    const sub = tokens[1];
    if (
      sub !== undefined &&
      (BUN_EVAL_FLAGS.has(sub) || sub.startsWith("--eval="))
    ) {
      return "`bun` inline-eval (-e/--eval/-p/--print) is never permitted";
    }
    return "repository-defined Bun scripts/tests are transitive code execution; run them in the provider leg, never the write-denied wrapper";
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
export function evaluateWrappedBash(
  command: string,
  context: WrappedCommandContext = {},
): string | null {
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
    const reason = classifyWrappedExecutable(stripped.tokens, context);
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
  "(`keeper commit-work` + `keeper plan done` or an AUDIT_READY self-park).";

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
    `task-bound \`keeper plan done\`/AUDIT_READY \`block\` + bounded reads, ` +
    `\`keeper session state\`, and the ` +
    `read-only git surface (log / status / diff / show / rev-parse). ` +
    `Repository-defined tests/scripts execute only inside the provider leg. ` +
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

function pathInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function wrappedCommandContext(
  env: Record<string, string | undefined>,
): WrappedCommandContext {
  const envelope = (env.KEEPER_WRAPPED_ENVELOPE ?? "").trim();
  const file = basename(envelope);
  const taskId = file.endsWith(".json") ? file.slice(0, -5) : "";
  return {
    ...(taskId.match(/^fn-\d+-[a-z0-9-]+\.\d+$/) ? { taskId } : {}),
    ...(envelope !== ""
      ? { envelopeReference: "$KEEPER_WRAPPED_ENVELOPE" }
      : {}),
  };
}

function scratchWriteAllowed(
  raw: string,
  cwd: string,
  probe: TreeProbe,
): boolean {
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const target = probe.realpath(abs);
  if (target === null) {
    return false;
  }
  // Accept a handoff write under ANY recognized system-temp root (realpath-
  // normalized, so `/tmp`→`/private/tmp` and the launchd `/var/folders/.../T`
  // all reconcile) — the `.json|.txt|.md` + `scratchFileSafe` gates below, not
  // the specific temp root, are the security boundary. Mirrors the mktemp check.
  const scratchRoots = SYSTEM_TMP_ROOTS.map((r) => probe.realpath(r)).filter(
    (r): r is string => r !== null,
  );
  if (!scratchRoots.some((root) => pathInside(root, target))) {
    return false;
  }
  // Wrapped scratch files are inert handoff data only. Executable/script-shaped
  // output is unnecessary and would turn a later allowlisted command into an
  // arbitrary source-write trampoline.
  return /\.(?:json|txt|md)$/i.test(target) && probe.scratchFileSafe(target);
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
  grantOverride: GrantOverride = NO_GRANT,
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
  const resolvedProbe = probe ?? fsProbe();

  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    // A validly-granted escalation subagent (a different agent_type than the
    // wrapped work:worker) may edit within its granted checkout — its grant
    // overrides the total-edit denial; protected paths remain excluded by the
    // grant itself. Otherwise deny REGARDLESS of the target path.
    const raw =
      tool === "NotebookEdit"
        ? p.tool_input?.notebook_path
        : p.tool_input?.file_path;
    if (typeof raw === "string" && raw.length > 0) {
      const cwd =
        typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : process.cwd();
      const canonical = resolvedProbe.realpath(
        isAbsolute(raw) ? raw : resolve(cwd, raw),
      );
      if (canonical !== null && grantOverride(canonical)) return null;
    }
    return denyEnvelope(editToolReason(tool));
  }

  if (tool === "Write") {
    const fp = p.tool_input?.file_path;
    if (typeof fp !== "string" || fp.length === 0) {
      return denyEnvelope(MALFORMED_REASON);
    }
    const cwd =
      typeof p.cwd === "string" && p.cwd.length > 0 ? p.cwd : process.cwd();
    const inTree = writeTargetInTree(fp, cwd, resolvedProbe, log);
    if (inTree === null) return denyEnvelope(MALFORMED_REASON); // unresolvable → fail closed
    if (!inTree) {
      if (scratchWriteAllowed(fp, cwd, resolvedProbe)) {
        // The quality-auditor's scratch Write is its findings file only — an
        // inert `.json`, narrower than the courier's `.json/.txt/.md` handoff
        // class — binding what it can create to what the submit carve-out reads.
        if (p.agent_type === WRAPPED_AUDIT_AGENT_TYPE) {
          const abs = isAbsolute(fp) ? fp : resolve(cwd, fp);
          const resolved = resolvedProbe.realpath(abs);
          if (resolved === null || !/\.json$/i.test(resolved)) {
            return denyEnvelope(
              "Wrapped quality-auditor BLOCKED: its scratch Write is limited to an inert .json findings file under its private system temporary scratchpad (.txt/.md are not the findings class).",
            );
          }
        }
        return null;
      }
      return denyEnvelope(
        "Wrapped-cell worker BLOCKED: out-of-tree Write is limited to inert .json/.txt/.md handoff files under the system temporary directory.",
      );
    }
    const abs = isAbsolute(fp) ? fp : resolve(cwd, fp);
    const canonical = resolvedProbe.realpath(abs);
    // An escalation grant covering this in-tree target overrides the denial.
    if (canonical !== null && grantOverride(canonical)) return null;
    const toplevel = resolvedProbe.repoToplevel(canonical ?? abs) ?? "";
    return denyEnvelope(writeInTreeReason(fp, toplevel));
  }

  if (tool === "Bash") {
    const command = p.tool_input?.command;
    if (typeof command !== "string") return denyEnvelope(MALFORMED_REASON);
    const context = wrappedCommandContext(env);
    // Thread the harness-supplied payload identity so the audit-submit carve-out
    // can gate on it (env carries the task/envelope binding; agent_type is the
    // payload's, the same anchor grant-guard trusts for its escalation set).
    if (typeof p.agent_type === "string") context.agentType = p.agent_type;
    // Bind the auditor's submit `--file` to the file class it may create.
    context.auditFileProbe = (abs) => resolvedProbe.auditSubmitFile(abs);
    const violation = evaluateWrappedBash(command, context);
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
function scratchFileSafe(resolved: string): boolean {
  try {
    // Existing handoffs are never rewritten: that would leave an inode
    // validation→Write gap in which a hardlink/symlink replacement could target
    // caller-owned bytes. Every handoff write gets a fresh lexical leaf.
    lstatSync(resolved);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try {
      const parent = lstatSync(realpathSync(dirname(resolved)));
      const getuid = process.getuid;
      return (
        parent.isDirectory() &&
        (parent.mode & 0o077) === 0 &&
        (getuid === undefined || parent.uid === getuid.call(process))
      );
    } catch {
      return false;
    }
  }
}

/** The submit `--file` must be the class of file the auditor's scratch Write
 *  creates: an EXISTING regular non-symlink `.json`, single-linked, under an
 *  owner-private system-temp parent. `lexicalAbs` is lstat'd directly (never
 *  realpath'd first) so a symlink AT the leaf is rejected, not followed. */
export function auditSubmitFileSafe(lexicalAbs: string): boolean {
  try {
    if (!/\.json$/i.test(lexicalAbs)) return false;
    const leaf = lstatSync(lexicalAbs);
    if (!leaf.isFile() || leaf.nlink !== 1) return false;
    const parentReal = realpathSync(dirname(lexicalAbs));
    const parent = lstatSync(parentReal);
    const getuid = process.getuid;
    const ownerPrivate =
      parent.isDirectory() &&
      (parent.mode & 0o077) === 0 &&
      (getuid === undefined || parent.uid === getuid.call(process));
    if (!ownerPrivate) return false;
    const tempRoots = SYSTEM_TMP_ROOTS.map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return null;
      }
    }).filter((root): root is string => root !== null);
    return tempRoots.some((root) => pathInside(root, parentReal));
  } catch {
    return false;
  }
}

export function fsProbe(): TreeProbe {
  return {
    realpath: realpathNearest,
    repoToplevel: repoToplevelOf,
    scratchFileSafe,
    auditSubmitFile: auditSubmitFileSafe,
  };
}

const MAX_ATOMIC_HANDOFF_BYTES = 1_048_576;
const WRAPPED_O_CLOEXEC = process.platform === "darwin" ? 0x1000000 : 0o2000000;

/**
 * Materialize an allowed handoff through O_EXCL|O_NOFOLLOW, then let the hook
 * deny the host Write. The checked leaf can never be an existing hardlink and
 * no validation→open window can truncate caller-owned bytes.
 */
export function writeAtomicWrappedHandoff(
  raw: string,
  content: string,
  cwd: string,
): boolean {
  const probe = fsProbe();
  if (!scratchWriteAllowed(raw, cwd, probe)) return false;
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > MAX_ATOMIC_HANDOFF_BYTES) return false;
  const lexical = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const path = probe.realpath(lexical);
  if (path === null) return false;
  const parentPath = dirname(path);
  let parentBefore: ReturnType<typeof lstatSync>;
  try {
    parentBefore = lstatSync(parentPath);
    if (
      !parentBefore.isDirectory() ||
      realpathSync(parentPath) !== parentPath
    ) {
      return false;
    }
  } catch {
    return false;
  }
  let fd: number | null = null;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        WRAPPED_O_CLOEXEC,
      0o600,
    );
    const descriptorBeforeWrite = fstatSync(fd);
    const lexicalAfterOpen = lstatSync(path);
    const parentAfterOpen = lstatSync(parentPath);
    if (
      !descriptorBeforeWrite.isFile() ||
      descriptorBeforeWrite.nlink !== 1 ||
      lexicalAfterOpen.dev !== descriptorBeforeWrite.dev ||
      lexicalAfterOpen.ino !== descriptorBeforeWrite.ino ||
      parentAfterOpen.dev !== parentBefore.dev ||
      parentAfterOpen.ino !== parentBefore.ino ||
      realpathSync(parentPath) !== parentPath
    ) {
      return false;
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (count <= 0) return false;
      offset += count;
    }
    fsyncSync(fd);
    const descriptor = fstatSync(fd);
    const lexical = lstatSync(path);
    return (
      descriptor.isFile() &&
      descriptor.nlink === 1 &&
      (descriptor.mode & 0o111) === 0 &&
      lexical.dev === descriptor.dev &&
      lexical.ino === descriptor.ino
    );
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
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
    const candidate = parsed ? payload : null;
    const now = Date.now();
    const candidateAgentType =
      candidate !== null && typeof candidate === "object"
        ? (candidate as WrappedGuardPayload).agent_type
        : undefined;
    const grantOverride = (canonicalTarget: string): boolean =>
      grantCoversWrite(env, candidateAgentType, canonicalTarget, now);
    const decision = decideWrappedGuard(
      candidate,
      env,
      fsProbe(),
      makeLogSink(env),
      grantOverride,
    );
    // A grant-covered Write is a real in-tree source write the guard cleared — it
    // must reach the host, NOT be diverted into the scratch-handoff suppression.
    const writeCandidate =
      candidate !== null && typeof candidate === "object"
        ? (candidate as WrappedGuardPayload)
        : null;
    const writeGrantCovered =
      writeCandidate?.tool_name === "Write" &&
      typeof writeCandidate.tool_input?.file_path === "string" &&
      (() => {
        const fp = writeCandidate.tool_input.file_path as string;
        const cwd =
          typeof writeCandidate.cwd === "string" &&
          writeCandidate.cwd.length > 0
            ? writeCandidate.cwd
            : process.cwd();
        const canonical = fsProbe().realpath(
          isAbsolute(fp) ? fp : resolve(cwd, fp),
        );
        return canonical !== null && grantOverride(canonical);
      })();
    if (
      decision === null &&
      !writeGrantCovered &&
      isWrappedMarked(env) &&
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as WrappedGuardPayload).tool_name === "Write" &&
      ((candidate as WrappedGuardPayload).agent_id !== undefined ||
        (candidate as WrappedGuardPayload).agent_type !== undefined)
    ) {
      const write = candidate as WrappedGuardPayload;
      const path = write.tool_input?.file_path;
      const content = write.tool_input?.content;
      const cwd =
        typeof write.cwd === "string" && write.cwd.length > 0
          ? write.cwd
          : process.cwd();
      if (
        typeof path === "string" &&
        typeof content === "string" &&
        writeAtomicWrappedHandoff(path, content, cwd)
      ) {
        emit(
          denyEnvelope(
            `ATOMIC_HANDOFF_WRITTEN: '${path}' was created descriptor-bound; the host Write is intentionally suppressed. Treat this receipt as success and never retry this leaf.`,
          ),
        );
      } else {
        emit(
          denyEnvelope(
            "Wrapped-cell atomic handoff creation failed closed; choose a fresh inert leaf in a new private keeper-wrapped temp directory.",
          ),
        );
      }
    } else {
      emit(decision);
    }
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
