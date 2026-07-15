#!/usr/bin/env bun
// PreToolUse(Bash) escalation-role command-family allowlist guard.
//
// Sibling of branch-guard. Where branch-guard hard-denies a SUBAGENT (`agent_id`
// present) from mutating branches, this hook constrains an ESCALATION SESSION
// (unblock / resolve / deconflict / repair) to its role's Bash command-family
// allowlist — the enforcement that survives `--dangerously-skip-permissions`,
// which lets a marked session route around tool-level Edit/Write denies via Bash
// file-writes (heredocs, `>` redirects, `python3 -c`, command substitution).
//
// Jurisdiction is THREE-STATE, keyed on the `KEEPER_ESCALATION_ROLE` PROCESS-ENV
// marker the launcher injects (never a payload field, never a jobs fold):
//   (1) marker set (non-empty) → ENFORCE that role's allowlist, and FAIL CLOSED
//       on any internal error (emit the deny envelope — an uncaught exception
//       exiting 1 would silently DISABLE the guard, so every path stays exit 0).
//   (2) marker absent, `agent_id` present → INERT (that is branch-guard's turf).
//   (3) neither → INERT (a human session keeps the fail-OPEN discipline).
//
// This DELIBERATELY inverts branch-guard's unconditional fail-open: a MARKED
// session fails CLOSED. The inversion is strictly env-gated so a human session
// (no marker) can never be fail-closed. Both Bash guards fire on every call and
// neither may assume the other ran.
//
// Pure function of (payload, env): ZERO subprocess / filesystem / git / DB calls.
// Always exit 0; emit at most one JSON line (the deny envelope) or nothing.

// ---------------------------------------------------------------------------
// Role configuration — the per-role allowlists, as data.
// ---------------------------------------------------------------------------

/** The two diagnosis-only roles: read/inspect the board and repo, never write. */
const DIAGNOSIS_ROLES = new Set(["unblock", "resolve"]);
/** The two write-capable roles: additionally mutate git, `keeper commit-work`,
 *  and run the build/tool families (they land a verified trunk commit). */
const WRITE_CAPABLE_ROLES = new Set(["deconflict", "repair"]);

interface RoleConfig {
  readonly role: string;
  readonly writeCapable: boolean;
}

/** Resolve the marker to a known role config, or `"unknown"` for a non-empty but
 *  unrecognized value (tampering / drift → fail closed, deny everything), or
 *  `null` when there is no marker at all (inert — not this guard's jurisdiction). */
function resolveRole(raw: string | undefined): RoleConfig | "unknown" | null {
  if (raw == null) return null;
  const role = raw.trim();
  if (role === "") return null;
  if (DIAGNOSIS_ROLES.has(role)) return { role, writeCapable: false };
  if (WRITE_CAPABLE_ROLES.has(role)) return { role, writeCapable: true };
  return "unknown";
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
 *  roles get all of git). `branch` is allowed only in its list/inspect forms —
 *  `classifyGitBranch` denies the delete/move/copy/force/upstream/create forms
 *  that mutate refs (branch-guard cannot cover an escalation session — it keys on
 *  an `agent_id` the session lacks). A `-c`/`--config-env` config-injection global
 *  option is denied by `gitConfigInjection`, and an exec-bearing subcommand flag
 *  (`git grep --open-files-in-pager`/`-O`) by `gitReadSubcommandExecFlag`. */
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

/** `git branch` flags that mutate refs or tracking config — denied for a
 *  diagnosis role. The list/inspect forms (bare, `-a`/`-r`/`-v`/`--list`/
 *  `--contains`/…) carry none of these. */
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

/** `git branch` flags whose FOLLOWING token is a filter value (a ref / pattern),
 *  so a bare positional after one is a value, not a branch name to create. Glued
 *  `--flag=value` forms are self-contained and need no lookahead. */
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

/** Build/tool families the write-capable roles allow (the set deconflict's
 *  frontmatter names). `bun` is handled separately — allowed for every role but
 *  restricted to `test`/`run` (diagnosis) and always denied its inline-eval flags. */
const BUILD_TOOL_FAMILIES = new Set([
  "pnpm",
  "npm",
  "uv",
  "cargo",
  "zig",
  "make",
]);

/** Interpreter / shell executables that are NEVER on any allowlist. Listed
 *  explicitly so their deny message names the interpreter class (the exact
 *  observed bypass: `python3 -c`, `sh -c`). Absence from the allowlist alone
 *  already denies them; this only sharpens the reason. `bun` is NOT here — it is
 *  conditionally allowed (test/run) with its eval flags denied. */
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

/** Leading command wrappers whose own tokens are stripped so the WRAPPED command
 *  is the one classified. `xargs` is handled distinctly (bare only; with flags it
 *  denies). */
const WRAPPERS = new Set([
  "timeout",
  "time",
  "nice",
  "nohup",
  "stdbuf",
  "xargs",
]);

/** `find` primaries that execute or delete — the `-exec` bypass class. */
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

/** Ripgrep flags that run a caller-named command. This per-tool blocklist accepts
 *  the same future-exec-flag residual as the git grep `-O` arm: a newly added rg
 *  exec flag passes until this list is updated. `--search-zip` / `-z` is deferred
 *  because it selects fixed decompressors rather than a caller-named command. */
const RG_EXEC_FLAGS = new Set(["--pre", "--pre-glob", "--hostname-bin"]);

/** bun flags/subcommands that evaluate inline code — denied for every role. */
const BUN_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

// ---------------------------------------------------------------------------
// Lexer — quote-aware, single pass. Splits the command into segments of tokens
// and denies the structural bypass constructs (redirects, heredocs, command /
// process substitution) the moment it sees one outside single quotes.
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
 * deny — those are the file-write / arbitrary-exec bypass constructs no
 * escalation role may use (legitimate writes go through the Edit/Write tools).
 * Command substitution (`$(`, backtick) fires inside double quotes too, because a
 * real shell expands it there; single-quoted content stays fully literal.
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
      if (c === "'") {
        inSingle = false;
      } else {
        word += c;
        hasWord = true;
      }
      continue;
    }
    if (inDouble) {
      if (c === '"') {
        inDouble = false;
      } else if (c === "`") {
        return { kind: "deny", reason: SUBSTITUTION };
      } else if (c === "$" && next === "(") {
        return { kind: "deny", reason: SUBSTITUTION };
      } else {
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
      // Backslash escapes the next char into the current word literally.
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
    if ((c === "<" || c === ">") && next === "(") {
      return { kind: "deny", reason: SUBSTITUTION };
    }
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
      // Subshell / group boundary — the inner command is its own segment.
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

/** Strip the leading wrapper tokens (timeout/time/nice/nohup/stdbuf/bare xargs)
 *  from a segment's tokens, returning the wrapped command's tokens — or a deny
 *  reason (xargs-with-flags, or a wrapper with no wrapped command). Bounded loop:
 *  each pass consumes at least the wrapper token. */
function stripWrappers(
  tokens: string[],
): { tokens: string[] } | { deny: string } {
  let rest = tokens;
  // Bound the unwrap depth (a pathological `timeout timeout timeout …`).
  for (let guard = 0; guard < 8; guard++) {
    const head = rest[0];
    if (head === undefined || !WRAPPERS.has(head)) {
      return { tokens: rest };
    }
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
    // The next token is the duration operand; drop it too.
    if (rest[j] !== undefined) j += 1;
    rest = rest.slice(j);
  }
  return { deny: "too many stacked command wrappers" };
}

/** Global git options that consume a SEPARATE following token as their value, so
 *  it is not misread as the subcommand — and so the pre-subcommand injection scan
 *  (bounded at the subcommand index) spans the true global region even when a `-c`
 *  is reordered behind one (`git --namespace x -c a=b log`). The glued
 *  `--opt=value` forms are a single `-`-prefixed token, skipped without lookahead. */
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

/** Deny a git config-injection global option — the vector that turns an
 *  allowlisted read subcommand into arbitrary program execution: `-c
 *  <name>=<value>` (an exec-bearing key like core.fsmonitor / core.pager /
 *  core.sshCommand / diff.external / *.textconv / alias.*) and its
 *  `--config-env=<name>=<envvar>` sibling. Returns a deny reason or null.
 *
 *  Scans only `tokens[1 .. boundary)`, the pre-subcommand global region (boundary
 *  is the subcommand's token index). Git honors `-c` SOLELY as a global — it must
 *  precede the subcommand — so a `-c` AFTER the subcommand is that subcommand's own
 *  flag, not a config global: `git log -c --format=%H` pairs a combined-diff `-c`
 *  with an `=`-bearing token yet is a legitimate read, never scanned here.
 *  `gitSubcommandInfo` consumes valued globals, so a `-c` reordered behind another
 *  global (`git --git-dir d -c x=y status`) still lands inside the scanned region
 *  and denies. */
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
 *  including any unambiguous abbreviation git parse-options accepts (`--op`,
 *  `--ope`, `--open-files`, … up to the full literal), in both bare and
 *  glued-`=<cmd>` forms. Git's minimum unambiguous prefix is `--op` (4 chars):
 *  among grep's `--o*` options (`--only-matching`, `--open-files-in-pager`,
 *  `--or`) only `--op` resolves to the exec alias, while `--o` is ambiguous and
 *  git rejects it outright. So the deny floors at `--op`; a longer `--open` floor
 *  lets the live 4- and 5-char prefixes (`--op`/`--ope`) through to the exec alias
 *  and open a match in a caller-named program. */
function isOpenFilesInPagerAbbrev(arg: string): boolean {
  const eq = arg.indexOf("=");
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  return (
    flag.length >= "--op".length && "--open-files-in-pager".startsWith(flag)
  );
}

/** Deny an exec-bearing or file-writing flag on an allowlisted READ subcommand —
 *  the vectors that turn a whitelisted read into arbitrary program execution or an
 *  arbitrary file write. `git grep --open-files-in-pager[=<cmd>]` (short alias
 *  `-O[<cmd>]`) opens each match in a caller-named program; `--output[=<file>]`
 *  (log/diff/…) writes a caller-named file — a flag, not a shell redirect, so the
 *  lexer's redirect deny never sees it. Scans the post-subcommand args, stopping at
 *  a `--` (after which tokens are patterns/pathspecs, never flags).
 *
 *  The long-form exec alias is matched by unambiguous-prefix (`isOpenFilesInPagerAbbrev`),
 *  since git parse-options accepts any prefix down to `--op`. `-O` is grep's exec
 *  alias only — for diff/log it is a benign order file — so the short form is scoped
 *  to grep. Git honors short-option bundling and `-O` takes an optional glued
 *  argument, so the alias reaches the exec option buried in a cluster
 *  (`-nO<cmd>`/`-iO<cmd>`) whose token starts with a benign flag; the regex fires on
 *  a capital `O` ANYWHERE in a single-dash short-flag cluster — git grep's only
 *  capital-`O` short option is the exec alias, so this over-blocks nothing.
 *  Returns a deny reason or null. */
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

/** Classify the args after a `git branch` subcommand for a diagnosis role. The
 *  list/inspect forms (bare, `-a`/`-r`/`-v`/`--list [<pattern>]`/`--contains
 *  <ref>`/…) are allowed; the delete/move/copy/force/upstream flags and the bare
 *  `branch <name>` create/reset form mutate refs and are denied. */
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
      // A filter flag consumes its following value (a ref / pattern) — skip it so
      // it is not misread as a branch name to create. Consume only a real value
      // token (not another flag), so a mutating flag after it still classifies.
      if (BRANCH_FILTER_VALUE_FLAGS.has(arg)) {
        const nextTok = branchArgs[i + 1];
        if (nextTok !== undefined && !nextTok.startsWith("-")) i += 1;
      }
      continue;
    }
    // A bare positional with no consuming filter flag is a branch name to
    // create / rename / reset — a ref mutation.
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

/** Direct Bun discovery is targeted only when it names a literal test file. */
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

/** Diagnosis roles may invoke package scripts, never path/option-shaped run targets. */
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

const HISTORY_INSPECTION_VERBS = new Set(["list", "show", "search", "files"]);

/** History search/files may perform their intrinsic History-index refresh,
 * but explicit index maintenance is outside every escalation role's authority. */
function classifyKeeperHistory(tokens: string[]): string | null {
  const verb = tokens[2];
  if (verb === undefined || verb === "--help" || verb === "-h") return null;
  if (HISTORY_INSPECTION_VERBS.has(verb)) return null;
  if (verb !== "index") {
    return `\`keeper history ${verb}\` is not on the escalation allowlist`;
  }

  let action: string | undefined;
  for (let i = 3; i < tokens.length; i++) {
    const arg = tokens[i] as string;
    if (arg === "--help" || arg === "-h" || arg === "--json") continue;
    if (arg === "--format") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--format=")) continue;
    if (arg.startsWith("-")) {
      return `unknown \`keeper history index\` option '${arg}' is denied`;
    }
    if (action !== undefined) {
      return "`keeper history index` accepts at most one action";
    }
    action = arg;
  }
  return action === undefined || action === "status"
    ? null
    : `\`keeper history index ${action}\` is explicit History-index maintenance and denied for escalation sessions`;
}

/** Classify one already-wrapper-stripped segment's executable against the role.
 *  Returns a deny reason, or null when the command is on the role's allowlist. */
function classifyExecutable(tokens: string[], cfg: RoleConfig): string | null {
  const exe = tokens[0] as string;

  if (INTERPRETER_EXECUTABLES.has(exe)) {
    return `interpreter/shell '${exe}' (inline code execution is never permitted for an escalation session)`;
  }

  if (exe === "keeper") {
    const sub = tokens[1];
    if (sub === undefined) return "bare `keeper` with no subcommand";
    if (
      sub === "dispatch" &&
      tokens.slice(2).some((arg) => arg.startsWith("--prompt"))
    ) {
      return "`keeper dispatch --prompt` launches a free-form worker, which is never permitted for an escalation session";
    }
    if (sub === "commit-work") {
      return cfg.writeCapable
        ? null
        : `\`keeper commit-work\` is write-capable and denied for the diagnosis role '${cfg.role}'`;
    }
    if (sub === "autopilot") {
      // Only `keeper autopilot retry` — never pause/play — is on the allowlist.
      return tokens[2] === "retry"
        ? null
        : `\`keeper autopilot ${tokens[2] ?? ""}\` is not permitted (only \`retry\`)`;
    }
    if (sub === "history") return classifyKeeperHistory(tokens);
    if (KEEPER_READ_SUBCOMMANDS.has(sub)) return null;
    return `\`keeper ${sub}\` is not on the escalation allowlist`;
  }

  if (exe === "git") {
    if (cfg.writeCapable) return null;
    const sub = gitSubcommandInfo(tokens);
    const injection = gitConfigInjection(tokens, sub?.index ?? tokens.length);
    if (injection !== null) {
      return `${injection}, denied for the diagnosis role '${cfg.role}'`;
    }
    if (sub === undefined) return "bare `git` with no subcommand";
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

  // `botctl` is external; its only observed call shape is `send-message --topic`,
  // and no exec or file-write flag is known to exist on it.
  if (exe === "botctl") return null;

  if (exe === "bun") {
    const sub = tokens[1];
    if (
      sub !== undefined &&
      (BUN_EVAL_FLAGS.has(sub) || sub.startsWith("--eval="))
    ) {
      return "`bun` inline-eval (-e/--eval/-p/--print) is never permitted";
    }
    // Aggregate discovery is denied for every role; use the stable named gate.
    if (sub === "test") return classifyBunTest(tokens);
    if (cfg.writeCapable) return null; // any other non-eval bun subcommand
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
        return `\`rg ${flag}\` runs a caller-named command (arbitrary program execution from an allowlisted read utility)`;
      }
    }
    return null;
  }

  if (READ_UTILITIES.has(exe)) return null;

  return `off-list command '${exe}'`;
}

/**
 * The pure predicate: evaluate a raw Bash command for one role, returning the
 * first violation's reason (deny) or null (every segment is on the allowlist).
 * Structural bypass constructs (redirect/heredoc/substitution) are caught by the
 * lexer; each segment must then present an allowlisted executable, with no
 * environment-assignment prefix. Exported for the table-driven tests.
 */
export function evaluateEscalationCommand(
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
// Decision + envelope.
// ---------------------------------------------------------------------------

/** The PreToolUse hook payload fields the escalation-guard decision reads. */
export interface EscalationGuardPayload {
  tool_name?: string;
  tool_input?: { command?: string };
}

/** The canonical PreToolUse deny envelope (exit-0 + JSON). */
export interface EscalationGuardDenyEnvelope {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

function denyEnvelope(reason: string): EscalationGuardDenyEnvelope {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** Build the operator-facing deny reason for a role-scoped command violation. */
function commandDenyReason(role: string, violation: string): string {
  return (
    `Escalation role '${role}' denies this Bash command: ${violation}. ` +
    "This role's allowlist governs Bash even under --dangerously-skip-permissions " +
    "(file writes go through the Edit/Write tools, never a Bash redirect/heredoc/" +
    "interpreter). Rework via an allowed command, or return a typed BLOCKED: if the " +
    "role genuinely needs a wider surface."
  );
}

const MALFORMED_REASON =
  "Escalation role guard: the Bash payload was malformed or missing its command " +
  "string, so the command could not be verified — denied (fail closed).";

const UNKNOWN_ROLE_REASON =
  "Escalation role guard: KEEPER_ESCALATION_ROLE is set to an unrecognized value, " +
  "so no allowlist applies — every Bash command is denied (fail closed).";

/**
 * Pure decision: the deny envelope for this (payload, env), or null to allow (no
 * output). Encodes the three-state jurisdiction and the fail-CLOSED-for-marked
 * inversion. `env` is read for the `KEEPER_ESCALATION_ROLE` marker ONLY.
 *
 *   - No marker → null (inert: branch-guard's / the human's turf, fail open).
 *   - Marker + a non-Bash tool → null (this guard governs Bash only).
 *   - Marker + Bash + on-list command → null (allow).
 *   - Marker + Bash + off-list command → deny envelope naming the violation.
 *   - Marker + malformed payload (non-object, missing/typeless command) → deny.
 *   - Unrecognized marker value → deny every Bash command (fail closed).
 */
export function decideEscalationGuard(
  payload: unknown,
  env: Record<string, string | undefined>,
): EscalationGuardDenyEnvelope | null {
  const cfg = resolveRole(env.KEEPER_ESCALATION_ROLE);
  if (cfg === null) return null; // unmarked → inert, fail open

  // Marked → fail CLOSED on anything we cannot positively clear.
  if (payload === null || typeof payload !== "object") {
    return denyEnvelope(MALFORMED_REASON);
  }
  const p = payload as EscalationGuardPayload;
  // The hook is registered on the Bash matcher, so a non-Bash tool_name is an
  // explicit other-tool call this guard does not govern — allow. Anything else
  // (Bash, or an absent/malformed tool_name reaching a Bash-only hook) is treated
  // as a Bash call and must clear the allowlist.
  if (typeof p.tool_name === "string" && p.tool_name !== "Bash") return null;

  const command = p.tool_input?.command;
  if (typeof command !== "string") return denyEnvelope(MALFORMED_REASON);

  if (cfg === "unknown") return denyEnvelope(UNKNOWN_ROLE_REASON);

  const violation = evaluateEscalationCommand(command, cfg);
  if (violation === null) return null;
  return denyEnvelope(commandDenyReason(cfg.role, violation));
}

// ---------------------------------------------------------------------------
// Entry point — always exit 0; fail CLOSED for a marked session, OPEN otherwise.
// ---------------------------------------------------------------------------

/** Read all of stdin as text. `Bun.stdin.stream()` avoids the macOS
 *  `process.stdin` buffer-until-close hang (Bun #18239). */
async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

function emit(decision: EscalationGuardDenyEnvelope | null): void {
  if (decision !== null) {
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  }
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
    // A parse failure under a marker is a malformed payload → decideEscalationGuard
    // fails closed on the non-object; an unmarked session stays silent.
    emit(decideEscalationGuard(parsed ? payload : null, env));
  } catch {
    // Last-resort internal error: fail CLOSED for a marked session, OPEN otherwise.
    if (resolveRole(env.KEEPER_ESCALATION_ROLE) !== null) {
      emit(denyEnvelope(MALFORMED_REASON));
    }
  }
}

main().catch(() => {
  // Belt-and-suspenders: if main() itself rejects, fail CLOSED for a marked
  // session (re-reading the env marker cannot throw), OPEN otherwise.
  if (resolveRole(process.env.KEEPER_ESCALATION_ROLE) !== null) {
    emit(denyEnvelope(MALFORMED_REASON));
  }
});
