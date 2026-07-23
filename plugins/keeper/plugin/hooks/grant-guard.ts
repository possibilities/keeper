#!/usr/bin/env bun
// PreToolUse(Bash|Write|Edit|MultiEdit|NotebookEdit) escalation grant guard.
//
// Sibling of branch-guard / wrong-tree-guard / wrapped-guard. Jurisdiction is
// keyed on the hook payload's SUBAGENT IDENTITY (`agent_type`), not a role marker:
// when `agent_type` names a confined escalation agent (bare or plan:-qualified
// merge-resolver, deconflicter, unblocker, repairer) this hook ENFORCES fail-
// closed; for any other agent_type, and for identity-less top-level calls, it is
// INERT (allow, no output) — a human or ordinary worker is never touched.
//
// A confined subagent's MUTATING calls (Edit/Write/MultiEdit/NotebookEdit, and
// the Bash file-write / arbitrary-exec vectors) are DENIED by default and allowed
// only under a daemon-published grant leaf (src/grant-leaf.ts) whose WHOLE tuple
// validates — parent job, exact agent type, incident instance + fencing
// identities, unexpired, and a matching monotonic fencing token — and whose
// writable root covers the target. Role bounds the surface: the unblocker never
// writes source (diagnosis-only); merge-resolver / deconflicter / repairer write
// within their granted checkout. Protected paths (`.git/config`, git hooks,
// credentials, harness hook/MCP config) stay DENIED even under a valid grant.
//
// Reads are always allowed (an escalation agent must orient); only mutations gate
// on a grant. The Bash surface reuses escalation-guard's CVE-hardened quote-aware
// lexer + role classifier: structural write/exec constructs (redirect, heredoc,
// substitution, interpreters, env-runners) are denied for EVERY role — legitimate
// writes go through the Edit/Write tools, which carry a bounded target path.
//
// node:* + dep-free src/grant-leaf only (no bun:sqlite / db). Deny via the
// permissionDecision envelope; ALWAYS exit 0 (a non-zero exit could fail-close a
// human session); an internal error WHILE IN JURISDICTION denies (fail closed).

import { basename, isAbsolute, resolve } from "node:path";

import {
  type EscalationRole,
  escalationRoleFor,
  type GrantEnv,
  type GrantVerdict,
  grantDenialTag,
  grantExpectationFromEnv,
  grantsDirOf,
  grantVerdictCode,
  isGrantProtectedPath,
  readGrantLeaf,
  realpathNearest,
  roleIsWriteCapable,
  writableRootCovers,
} from "../../../../src/grant-leaf.ts";

// ---------------------------------------------------------------------------
// Role configuration for the Bash classifier (diagnosis vs write-capable).
// ---------------------------------------------------------------------------

export interface RoleConfig {
  readonly role: EscalationRole;
  readonly writeCapable: boolean;
  /** The valid grant's incident id, or null/undefined when there is no valid
   *  grant — bounds which `keeper autopilot retry <verb::id>` the subagent may
   *  run to its OWN incident. */
  readonly incidentId?: string | null;
  /** Launch-bound wrapped task, when this guard runs in a marked wrapped cell. */
  readonly taskId?: string;
}

/** `keeper <sub>` subcommands the read/board subset allows for EVERY role. */
const KEEPER_READ_SUBCOMMANDS = new Set([
  "escalation-brief",
  "session",
  "transcript",
  "plan",
  "query",
  "bus",
  "dispatch",
  "baseline",
  "status",
  "show-job",
]);

/** Read-only git subcommands allowed for the diagnosis roles (write-capable
 *  roles get all of git EXCEPT `config`). `branch` is allowed only in its
 *  list/inspect forms. */
const READONLY_GIT_SUBCOMMANDS = new Set([
  "log",
  "show",
  "diff",
  "status",
  "rev-parse",
  "ls-files",
  "blame",
  "grep",
  "branch",
  "describe",
  "shortlog",
  "ls-tree",
  "cat-file",
]);

const MUTATING_BRANCH_FLAGS = new Set([
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "-f",
  "--force",
  "-u",
  "--set-upstream-to",
  "--set-upstream",
  "--unset-upstream",
  "--edit-description",
]);

const BRANCH_FILTER_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format",
  "--list",
]);

/** Read utilities allowed for EVERY role. `find` is further gated (no `-exec`
 *  / `-delete`); `tee`/`sed`/`awk` are deliberately absent (write / interpreter). */
const READ_UTILITIES = new Set([
  "rg",
  "grep",
  "find",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "jq",
]);

/** Build/tool families the write-capable roles allow. */
const BUILD_TOOL_FAMILIES = new Set([
  "pnpm",
  "npm",
  "uv",
  "cargo",
  "zig",
  "make",
]);

/** Interpreter / shell executables that are NEVER on any allowlist — inline code
 *  execution reopens a context the classifier cannot see into. */
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

const WRAPPERS = new Set([
  "timeout",
  "time",
  "nice",
  "nohup",
  "stdbuf",
  "xargs",
]);

const FIND_EXEC_PRIMARIES = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

const RG_EXEC_FLAGS = new Set(["--pre", "--pre-glob", "--hostname-bin"]);

const BUN_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

// ---------------------------------------------------------------------------
// Shell lexer — quote-aware, single pass. Denies the structural bypass
// constructs (redirects, heredocs, command / process substitution) on sight.
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
// Per-segment classification against a role's allowlist.
// ---------------------------------------------------------------------------

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

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

function gitConfigInjection(tokens: string[], boundary: number): string | null {
  for (let i = 1; i < boundary; i++) {
    const t = tokens[i] as string;
    if (t === "-c") {
      const val = tokens[i + 1];
      if (val?.includes("=")) {
        return "git `-c <name>=<value>` config injection (an exec-bearing config key turns a command into arbitrary program execution)";
      }
      continue;
    }
    if (t === "--config-env" || t.startsWith("--config-env=")) {
      return "git `--config-env` config injection (reads a config value from an env var — the same exec-bearing bypass as `-c`)";
    }
  }
  return null;
}

function gitGlobalPathOverride(
  tokens: string[],
  boundary: number,
): string | null {
  for (let i = 1; i < boundary; i++) {
    const token = tokens[i] as string;
    if (
      token === "-C" ||
      (token.startsWith("-C") && token.length > 2) ||
      token === "--git-dir" ||
      token.startsWith("--git-dir=") ||
      token === "--work-tree" ||
      token.startsWith("--work-tree=")
    ) {
      return token;
    }
  }
  return null;
}

function isOpenFilesInPagerAbbrev(arg: string): boolean {
  const eq = arg.indexOf("=");
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  return (
    flag.length >= "--op".length && "--open-files-in-pager".startsWith(flag)
  );
}

function gitReadSubcommandExecFlag(
  subArgs: string[],
  sub: string,
): string | null {
  for (const arg of subArgs) {
    if (arg === "--") break;
    if (isOpenFilesInPagerAbbrev(arg)) {
      return "git `--open-files-in-pager` opens matches in a caller-named program (arbitrary program execution from a read subcommand)";
    }
    if (arg === "--output" || arg.startsWith("--output=")) {
      return "git `--output=<file>` writes to a caller-named file (an arbitrary file-write vector from a read subcommand)";
    }
    if (sub === "grep" && /^-[A-Za-z]*O/.test(arg)) {
      return "git grep `-O`/`--open-files-in-pager` opens matches in a caller-named program (arbitrary program execution from a read subcommand)";
    }
  }
  return null;
}

function classifyGitBranch(branchArgs: string[], role: string): string | null {
  for (let i = 0; i < branchArgs.length; i++) {
    const arg = branchArgs[i] as string;
    if (
      MUTATING_BRANCH_FLAGS.has(arg) ||
      arg.startsWith("--set-upstream-to=")
    ) {
      return `git 'branch ${arg}' mutates refs, denied for the diagnosis role '${role}' (bare/list/verbose forms allowed)`;
    }
    if (arg.startsWith("-")) {
      if (BRANCH_FILTER_VALUE_FLAGS.has(arg)) {
        const nextTok = branchArgs[i + 1];
        if (nextTok !== undefined && !nextTok.startsWith("-")) i += 1;
      }
      continue;
    }
    return `git 'branch <name>' (create/reset) mutates refs, denied for the diagnosis role '${role}' (bare/list/verbose forms allowed)`;
  }
  return null;
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
    if (!arg.startsWith("-") && arg.endsWith(".test.ts")) return null;
  }
  return "direct `bun test` requires an explicit `*.test.ts` file (use `bun run test:gate` for aggregate discovery)";
}

function isNamedBunScript(target: string | undefined): boolean {
  return (
    target !== undefined &&
    target.length > 0 &&
    !target.startsWith("-") &&
    !target.includes(".") &&
    !target.includes("/") &&
    !target.includes("\\")
  );
}

function wrappedPlanBlockViolation(
  tokens: string[],
  expectedTask: string | undefined,
): string | null {
  if (expectedTask === undefined || tokens[3] !== expectedTask) {
    return "wrapped `keeper plan block` must name the launch-bound task";
  }
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

/** `keeper autopilot retry <verb::id>` is an incident-CLEARING verb: a granted
 *  subagent may re-arm its OWN incident, never a sibling's. Allowed only when a
 *  valid grant names this exact incident id; a grant-less subagent, a foreign or
 *  missing target, a second target, or an unrecognized option denies. Tracks the
 *  `retry` CLI surface (`<verb::id> [--sock <path>]`); every other `autopilot`
 *  subcommand (pause/play/mode/…) is off-list. */
function classifyAutopilotRetry(
  tokens: string[],
  cfg: RoleConfig,
): string | null {
  if (tokens[2] !== "retry") {
    return `\`keeper autopilot ${tokens[2] ?? ""}\` is not permitted (only \`retry\`)`;
  }
  const incidentId = cfg.incidentId ?? null;
  if (incidentId === null) {
    return "`keeper autopilot retry` requires a valid grant naming the incident it may clear";
  }
  let target: string | undefined;
  for (let i = 3; i < tokens.length; i++) {
    const arg = tokens[i] as string;
    if (arg === "--sock") {
      if (tokens[i + 1] === undefined || tokens[i + 1]?.startsWith("-")) {
        return "`keeper autopilot retry --sock` requires a value";
      }
      i += 1;
      continue;
    }
    if (arg.startsWith("--sock=")) continue;
    if (arg.startsWith("-")) {
      return `\`keeper autopilot retry ${arg}\` carries an unrecognized option`;
    }
    if (target !== undefined) {
      return "`keeper autopilot retry` permits exactly one incident target";
    }
    target = arg;
  }
  if (target === undefined) {
    return "`keeper autopilot retry` requires the granted incident id as its target";
  }
  if (target !== incidentId) {
    return `\`keeper autopilot retry ${target}\` targets a foreign incident; the grant authorizes clearing only '${incidentId}'`;
  }
  return null;
}

/** Classify one already-wrapper-stripped segment's executable against the role.
 *  Returns a deny reason, or null when the command is on the role's allowlist. */
function classifyExecutable(tokens: string[], cfg: RoleConfig): string | null {
  const exe = tokens[0] as string;

  if (INTERPRETER_EXECUTABLES.has(exe)) {
    return `interpreter/shell '${exe}' (inline code execution is never permitted for an escalation subagent)`;
  }

  if (exe === "keeper") {
    const sub = tokens[1];
    if (sub === undefined) return "bare `keeper` with no subcommand";
    if (
      sub === "dispatch" &&
      tokens.slice(2).some((arg) => arg.startsWith("--prompt"))
    ) {
      return "`keeper dispatch --prompt` launches a free-form worker, which is never permitted for an escalation subagent";
    }
    if (sub === "commit-work") {
      return cfg.writeCapable
        ? null
        : `\`keeper commit-work\` is write-capable and denied for the diagnosis role '${cfg.role}'`;
    }
    if (sub === "autopilot") {
      return classifyAutopilotRetry(tokens, cfg);
    }
    if (sub === "plan" && tokens[2] === "block") {
      return wrappedPlanBlockViolation(tokens, cfg.taskId);
    }
    if (KEEPER_READ_SUBCOMMANDS.has(sub)) return null;
    return `\`keeper ${sub}\` is not on the escalation allowlist`;
  }

  if (exe === "git") {
    const sub = gitSubcommandInfo(tokens);
    const boundary = sub?.index ?? tokens.length;
    const injection = gitConfigInjection(tokens, boundary);
    if (injection !== null) {
      return `${injection}, denied for the role '${cfg.role}'`;
    }
    const pathOverride = gitGlobalPathOverride(tokens, boundary);
    if (pathOverride !== null) {
      return `git global path override '${pathOverride}' can redirect repository mutations outside the granted checkout`;
    }
    if (sub === undefined) return "bare `git` with no subcommand";
    // `git config` writes `.git/config` — a protected path, denied for EVERY
    // role even when write-capable.
    if (sub.name === "config") {
      return "git `config` writes repository config (a protected path), denied even under a valid grant";
    }
    if (cfg.writeCapable) return null;
    if (sub.name === "branch") {
      return classifyGitBranch(tokens.slice(sub.index + 1), cfg.role);
    }
    if (READONLY_GIT_SUBCOMMANDS.has(sub.name)) {
      const execFlag = gitReadSubcommandExecFlag(
        tokens.slice(sub.index + 1),
        sub.name,
      );
      if (execFlag !== null) {
        return `${execFlag}, denied for the diagnosis role '${cfg.role}'`;
      }
      return null;
    }
    return `git '${sub.name}' is a mutating/off-list git subcommand, denied for the diagnosis role '${cfg.role}'`;
  }

  if (exe === "agentbot") return null;

  if (exe === "bun") {
    const sub = tokens[1];
    if (
      sub !== undefined &&
      (BUN_EVAL_FLAGS.has(sub) || sub.startsWith("--eval="))
    ) {
      return "`bun` inline-eval (-e/--eval/-p/--print) is never permitted";
    }
    if (sub === "test") return classifyBunTest(tokens);
    if (cfg.writeCapable) return null;
    if (sub === "run" && isNamedBunScript(tokens[2])) return null;
    return `\`bun ${sub ?? ""}\` is not permitted for the diagnosis role '${cfg.role}' (only explicit \`bun test *.test.ts\` / \`bun run <named-package-script>\`)`;
  }

  if (BUILD_TOOL_FAMILIES.has(exe)) {
    return cfg.writeCapable
      ? null
      : `build/tool family '${exe}' is denied for the diagnosis role '${cfg.role}'`;
  }

  if (exe === "find") {
    const bad = tokens.find((t) => FIND_EXEC_PRIMARIES.has(t));
    if (bad !== undefined)
      return `\`find ${bad}\` (a command runner / file deleter)`;
    return null;
  }

  if (exe === "rg") {
    for (const arg of tokens.slice(1)) {
      if (arg === "--") break;
      const flag = arg.split("=", 1)[0] as string;
      if (RG_EXEC_FLAGS.has(flag)) {
        return `\`rg ${flag}\` runs a caller-named command (arbitrary program execution from a read utility)`;
      }
    }
    return null;
  }

  if (READ_UTILITIES.has(exe)) return null;

  return `off-list command '${exe}'`;
}

/**
 * The pure Bash predicate: evaluate a raw command for one role, returning the
 * first violation's reason (deny) or null (every segment is on the allowlist).
 * Structural bypass constructs are caught by the lexer; each segment must then
 * present an allowlisted executable with no env-assignment prefix. Exported for
 * the table-driven tests.
 */
export function evaluateGrantBash(
  command: string,
  cfg: RoleConfig,
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
    const reason = classifyExecutable(stripped.tokens, cfg);
    if (reason !== null) return reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payload + envelope.
// ---------------------------------------------------------------------------

export interface GrantGuardPayload {
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

export interface GrantGuardDenyEnvelope {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

function denyEnvelope(reason: string): GrantGuardDenyEnvelope {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// ---------------------------------------------------------------------------
// Injected seams — keep the decision core pure + in-process testable.
// ---------------------------------------------------------------------------

export interface GrantGuardDeps {
  /** The whole-tuple grant verdict for this subagent, or a non-valid verdict. */
  grantLookup(agentType: string, now: number): GrantVerdict;
  /** Canonicalize a create-new-safe absolute path, or null when unresolvable. */
  realpath(abs: string): string | null;
  /** Producer clock (epoch-ms); a grant validates against it. */
  now(): number;
  /** Launch-bound wrapped task derived from the marked cell's envelope path. */
  wrappedTaskId?: string;
}

type WrappedGrantEnv = GrantEnv & {
  KEEPER_WRAPPED_CELL?: string;
  KEEPER_WRAPPED_ENVELOPE?: string;
};

function wrappedTaskIdFromEnv(env: WrappedGrantEnv): string | undefined {
  if ((env.KEEPER_WRAPPED_CELL ?? "").trim() === "") return undefined;
  const envelope = (env.KEEPER_WRAPPED_ENVELOPE ?? "").trim();
  const file = basename(envelope);
  const taskId = file.endsWith(".json") ? file.slice(0, -5) : "";
  return taskId.match(/^fn-\d+-[a-z0-9-]+\.\d+$/) ? taskId : undefined;
}

export function productionDeps(
  env: WrappedGrantEnv,
  now: () => number = Date.now,
): GrantGuardDeps {
  const wrappedTaskId = wrappedTaskIdFromEnv(env);
  return {
    grantLookup: (agentType, at) => {
      const expectation = grantExpectationFromEnv(env, agentType);
      if (expectation === null) return { kind: "absent" };
      return readGrantLeaf(grantsDirOf(env), expectation, at);
    },
    realpath: realpathNearest,
    now,
    ...(wrappedTaskId === undefined ? {} : { wrappedTaskId }),
  };
}

// ---------------------------------------------------------------------------
// Deny reasons.
// ---------------------------------------------------------------------------

function noGrantReason(
  role: EscalationRole,
  kind: GrantVerdict["kind"],
): string {
  const code = grantVerdictCode(kind);
  return (
    `${grantDenialTag(code)} Escalation subagent (role '${role}') BLOCKED: this ` +
    `mutation requires a valid daemon-published grant, but the typed grant verdict ` +
    `is '${code}'. A confined escalation subagent's writes are denied by default; ` +
    `the daemon publishes an exact-tuple, unexpired grant naming the writable ` +
    `checkout when — and only when — the incident is owned. Only a genuine ` +
    `'grant_expired' verdict may enter a same-session grant-replacement retry; any ` +
    `other code fails closed. Diagnose, or return a typed receipt carrying this code.`
  );
}

const POLICY_TAG = grantDenialTag("command_policy_mismatch");

function protectedReason(target: string): string {
  return (
    `${POLICY_TAG} Escalation subagent BLOCKED: '${target}' is a protected ` +
    `git-config / hook / credential / harness-config path, denied even under a ` +
    `valid grant.`
  );
}

function outsideRootReason(target: string, root: string): string {
  return (
    `${POLICY_TAG} Escalation subagent BLOCKED: '${target}' is outside the grant's ` +
    `writable root '${root}'. A grant authorizes writes ONLY within its granted ` +
    `checkout.`
  );
}

function unblockerReason(): string {
  return (
    `${POLICY_TAG} Escalation subagent BLOCKED: the unblocker role is ` +
    "diagnosis-only and may never write source. Leave the task blocked and return " +
    "a typed receipt."
  );
}

function bashReason(role: EscalationRole, violation: string): string {
  return (
    `${POLICY_TAG} Escalation subagent (role '${role}') denies this Bash command: ` +
    `${violation}. File writes go through the Edit/Write tools (bounded to the ` +
    "granted checkout), never a Bash redirect/heredoc/interpreter. Rework via an " +
    "allowed command, or return a typed receipt."
  );
}

const MALFORMED_REASON =
  `${grantDenialTag("unknown")} Escalation grant guard: the tool payload was ` +
  "malformed or missing its target, so the confined call could not be verified — " +
  "denied (fail closed).";

// ---------------------------------------------------------------------------
// Pure decision core.
// ---------------------------------------------------------------------------

interface ResolvedGrant {
  writableRoot: string | null;
  incidentId: string | null;
  writeCapable: boolean;
  verdictKind: GrantVerdict["kind"];
}

function resolveGrant(
  agentType: string,
  role: EscalationRole,
  deps: GrantGuardDeps,
  now: number,
): ResolvedGrant {
  const verdict = deps.grantLookup(agentType, now);
  const valid = verdict.kind === "valid";
  return {
    writableRoot: valid ? verdict.grant.writable_root : null,
    incidentId: valid ? verdict.grant.incident_id : null,
    // The unblocker never writes source even holding a valid grant.
    writeCapable: valid && roleIsWriteCapable(role),
    verdictKind: verdict.kind,
  };
}

function decideEditTool(
  payload: GrantGuardPayload,
  role: EscalationRole,
  grant: ResolvedGrant,
  deps: GrantGuardDeps,
): GrantGuardDenyEnvelope | null {
  const raw =
    payload.tool_name === "NotebookEdit"
      ? payload.tool_input?.notebook_path
      : payload.tool_input?.file_path;
  if (typeof raw !== "string" || raw.length === 0) {
    return denyEnvelope(MALFORMED_REASON);
  }
  const cwd =
    typeof payload.cwd === "string" && payload.cwd.length > 0
      ? payload.cwd
      : process.cwd();
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const canonical = deps.realpath(abs);
  if (canonical === null) return denyEnvelope(MALFORMED_REASON); // unverifiable → fail closed
  if (isGrantProtectedPath(canonical))
    return denyEnvelope(protectedReason(raw));
  if (role === "unblock") return denyEnvelope(unblockerReason());
  if (!grant.writeCapable) {
    return denyEnvelope(noGrantReason(role, grant.verdictKind));
  }
  if (!writableRootCovers(grant.writableRoot as string, canonical)) {
    return denyEnvelope(outsideRootReason(raw, grant.writableRoot as string));
  }
  return null; // allowed under the grant
}

function decideBash(
  payload: GrantGuardPayload,
  role: EscalationRole,
  grant: ResolvedGrant,
  deps: GrantGuardDeps,
): GrantGuardDenyEnvelope | null {
  const command = payload.tool_input?.command;
  if (typeof command !== "string") return denyEnvelope(MALFORMED_REASON);
  const cfg: RoleConfig = {
    role,
    writeCapable: grant.writeCapable,
    incidentId: grant.incidentId,
    ...(deps.wrappedTaskId === undefined ? {} : { taskId: deps.wrappedTaskId }),
  };
  const violation = evaluateGrantBash(command, cfg);
  if (violation !== null) {
    // A write-capable role whose grant is NOT valid: when the SAME command would
    // clear the allowlist under a live grant, the only reason it failed is the
    // missing authority — surface the TYPED grant code, never a "diagnosis role"
    // narration that would misread an expiry/absence as a permanent role limit.
    if (
      grant.verdictKind !== "valid" &&
      roleIsWriteCapable(role) &&
      evaluateGrantBash(command, { ...cfg, writeCapable: true }) === null
    ) {
      return denyEnvelope(noGrantReason(role, grant.verdictKind));
    }
    return denyEnvelope(bashReason(role, violation));
  }
  // The command cleared the allowlist. A write-capable command (git/build/
  // commit-work) mutates the repo at cwd — bound that cwd to the granted
  // checkout so a write-capable role cannot mutate a foreign tree.
  if (grant.writeCapable) {
    const cwd =
      typeof payload.cwd === "string" && payload.cwd.length > 0
        ? payload.cwd
        : process.cwd();
    const canonicalCwd = deps.realpath(cwd);
    if (
      canonicalCwd === null ||
      !writableRootCovers(grant.writableRoot as string, canonicalCwd)
    ) {
      return denyEnvelope(
        outsideRootReason(cwd, (grant.writableRoot as string) ?? "<none>"),
      );
    }
  }
  return null;
}

/**
 * Pure decision: the deny envelope for this (payload, env), or null to allow.
 * Jurisdiction is payload-identity-keyed: only confined escalation agent
 * identities ENFORCE; every other identity (and a malformed/identity-less
 * payload) is INERT. In jurisdiction the guard fails CLOSED on anything it
 * cannot positively clear.
 */
export function decideGrantGuard(
  payload: unknown,
  deps: GrantGuardDeps,
): GrantGuardDenyEnvelope | null {
  if (payload === null || typeof payload !== "object") return null; // no identity → inert
  const p = payload as GrantGuardPayload;
  const role = escalationRoleFor(p.agent_type);
  if (role === null) return null; // not a confined agent → inert (fail open)

  // IN JURISDICTION — fail CLOSED from here.
  const now = deps.now();
  const grant = resolveGrant(p.agent_type as string, role, deps, now);
  const tool = p.tool_name;
  if (typeof tool === "string" && EDIT_TOOLS.has(tool)) {
    return decideEditTool(p, role, grant, deps);
  }
  if (tool === "Bash") {
    return decideBash(p, role, grant, deps);
  }
  // A non-mutating / non-governed tool reaching a guarded matcher: allow (reads
  // are always permitted; the guard governs Bash + the edit tools only).
  return null;
}

// ---------------------------------------------------------------------------
// Entry point — always exit 0; fail CLOSED in jurisdiction, OPEN otherwise.
// ---------------------------------------------------------------------------

const MAX_STDIN_CHARS = 1_000_000;

interface StdinRead {
  text: string;
  truncated: boolean;
}

/** Read stdin with a bounded parse surface. `Bun.stdin.stream()` avoids the
 *  macOS `process.stdin` buffer-until-close hang (Bun #18239). */
async function readStdin(): Promise<StdinRead> {
  const text = await new Response(Bun.stdin.stream()).text();
  return {
    text: text.slice(0, MAX_STDIN_CHARS),
    truncated: text.length > MAX_STDIN_CHARS,
  };
}

function topLevelConfinedAgentType(head: string): string | undefined {
  let objectDepth = 0;
  let arrayDepth = 0;
  for (let i = 0; i < head.length; i++) {
    const char = head[i] as string;
    if (char === '"') {
      const start = i;
      for (i += 1; i < head.length; i++) {
        if (head[i] === "\\") {
          i += 1;
          continue;
        }
        if (head[i] === '"') break;
      }
      if (i >= head.length) return undefined;
      if (objectDepth !== 1 || arrayDepth !== 0) continue;
      let key: unknown;
      try {
        key = JSON.parse(head.slice(start, i + 1));
      } catch {
        continue;
      }
      if (key !== "agent_type") continue;
      let cursor = i + 1;
      while (/\s/.test(head[cursor] ?? "")) cursor += 1;
      if (head[cursor] !== ":") continue;
      cursor += 1;
      while (/\s/.test(head[cursor] ?? "")) cursor += 1;
      if (head[cursor] !== '"') continue;
      const valueStart = cursor;
      for (cursor += 1; cursor < head.length; cursor++) {
        if (head[cursor] === "\\") {
          cursor += 1;
          continue;
        }
        if (head[cursor] === '"') {
          try {
            const value: unknown = JSON.parse(
              head.slice(valueStart, cursor + 1),
            );
            if (
              typeof value === "string" &&
              escalationRoleFor(value) !== null
            ) {
              return value;
            }
          } catch {
            return undefined;
          }
          i = cursor;
          break;
        }
      }
      if (cursor >= head.length) return undefined;
      continue;
    }
    if (char === "{") objectDepth += 1;
    else if (char === "}") objectDepth -= 1;
    else if (char === "[") arrayDepth += 1;
    else if (char === "]") arrayDepth -= 1;
  }
  return undefined;
}

function decideStdin(
  input: StdinRead,
  deps: GrantGuardDeps,
): GrantGuardDenyEnvelope | null {
  if (input.truncated) {
    return topLevelConfinedAgentType(input.text) === undefined
      ? null
      : denyEnvelope(MALFORMED_REASON);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.text);
  } catch {
    payload = null;
  }
  return decideGrantGuard(payload, deps);
}

export function decideGrantGuardInput(
  raw: string,
  deps: GrantGuardDeps,
): GrantGuardDenyEnvelope | null {
  return decideStdin(
    {
      text: raw.slice(0, MAX_STDIN_CHARS),
      truncated: raw.length > MAX_STDIN_CHARS,
    },
    deps,
  );
}

function emit(decision: GrantGuardDenyEnvelope | null): void {
  if (decision !== null) process.stdout.write(`${JSON.stringify(decision)}\n`);
}

/** True when the payload identifies a confined escalation subagent — the last-
 *  resort catch uses this to decide fail-closed vs fail-open. */
function inJurisdiction(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  return escalationRoleFor((payload as GrantGuardPayload).agent_type) !== null;
}

async function main(): Promise<void> {
  const env = process.env as GrantEnv;
  let input: StdinRead = { text: "", truncated: false };
  try {
    input = await readStdin();
  } catch {
    input = { text: "", truncated: false };
  }
  try {
    emit(decideStdin(input, productionDeps(env)));
  } catch {
    // Internal error: fail CLOSED when even a truncated payload identifies a
    // confined subagent, OPEN otherwise.
    const agentType = input.truncated
      ? topLevelConfinedAgentType(input.text)
      : (() => {
          try {
            const payload: unknown = JSON.parse(input.text);
            return inJurisdiction(payload)
              ? (payload as GrantGuardPayload).agent_type
              : undefined;
          } catch {
            return undefined;
          }
        })();
    if (escalationRoleFor(agentType) !== null)
      emit(denyEnvelope(MALFORMED_REASON));
  }
}

if (import.meta.main) {
  main().catch((): void => {
    // Belt-and-suspenders: never let a rejection escape as a non-zero exit.
  });
}
