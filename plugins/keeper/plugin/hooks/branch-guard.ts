#!/usr/bin/env bun
// PreToolUse(Bash) branch-mutation hard-deny dispatcher.
//
// Hard-blocks a SUBAGENT (a `/plan:work` worker, detected via `agent_id` /
// `agent_type` presence in the hook payload) from creating OR switching git
// branches: a worker must work in place on the current branch. This INVERTS the
// commit-guard agent gate — commit-guard early-returns when `agent_id` is
// present (worker context is allowed to commit); branch-guard DENIES when
// `agent_id` is present and ALLOWS when absent. The human's own interactive
// session and the content-blind /plan:work orchestrator both run with no
// `agent_id`, so they are never affected.
//
// Pure function of the payload: ZERO subprocess / filesystem / git / DB calls.
// Fails OPEN on every path (exit 0, no decision) — a false deny against a real
// human action is worse than a missed accidental branch.

/** A command boundary: start-of-string, a shell separator (`&&`, `||`, `;`,
 * `|`, newline), a subshell/group open (`(`), or a command substitution open
 * (`$(`, backtick). After the boundary we tolerate leading `VAR=val` env
 * prefixes and `sudo`/`env` wrappers, then require a `git` token. */
const GIT_INVOCATION =
  /(?:^|[;&|\n(`]|\$\()[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|env)[ \t]+)*git\b([^;&|\n)`]*)/g;

/** Strip git global flags that may precede the subcommand: `-C <dir>`,
 * `--git-dir=…`, `--work-tree=…`, `-c <cfg>`, `-c<cfg>`, `--namespace=…`, and
 * the bare boolean globals (`-p`/`--paginate`, `--no-pager`, `--bare`, etc.)
 * so the FIRST remaining token is the subcommand. */
function stripGlobalFlags(args: string): string {
  let rest = args.trim();
  for (;;) {
    // `-C <dir>` / `-c <cfg>` consume a following value token.
    let m = rest.match(/^(?:-C|-c)[ \t]+\S+[ \t]*/);
    if (m) {
      rest = rest.slice(m[0].length);
      continue;
    }
    // `--git-dir=…`, `--work-tree=…`, `--namespace=…`, `-c<cfg>`, and the bare
    // boolean globals — single token, no value to consume.
    m = rest.match(
      /^(?:--git-dir=\S*|--work-tree=\S*|--namespace=\S*|-c\S+|-p|--paginate|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|--icase-pathspecs)[ \t]+/,
    );
    if (m) {
      rest = rest.slice(m[0].length);
      continue;
    }
    break;
  }
  return rest;
}

/** Split the post-subcommand argument string into whitespace tokens, stopping
 * at the first shell separator so we never read into the next command. */
function subcommandTokens(afterVerb: string): string[] {
  const cut = afterVerb.split(/[;&|\n)`]|\$\(/, 1)[0] ?? "";
  return cut.trim().length ? cut.trim().split(/[ \t]+/) : [];
}

/** True when this `git <subcommand> <args…>` form creates or switches a branch.
 * `args` is everything after `git` for one invocation (global flags included).*/
function isBranchMutatingInvocation(args: string): boolean {
  const stripped = stripGlobalFlags(args);
  const headMatch = stripped.match(/^(\S+)([\s\S]*)$/);
  if (!headMatch) return false;
  const sub = headMatch[1];
  const tokens = subcommandTokens(headMatch[2] ?? "");

  if (sub === "checkout") {
    // Create form: any of -b/-B/--orphan.
    if (tokens.some((t) => t === "-b" || t === "-B" || t === "--orphan"))
      return true;
    // `git checkout -- <path>` is an explicit file restore — allow.
    if (tokens.includes("--")) return false;
    // Bare `git checkout <X>` with at least one positional and no `--`:
    // ambiguous switch-vs-restore resolves toward BLOCK (human ruling). A bare
    // `git checkout` with only flags (no positional) is not a switch.
    return tokens.some((t) => !t.startsWith("-"));
  }

  if (sub === "switch") {
    // Create form: -c/-C/--create/--orphan.
    if (
      tokens.some(
        (t) => t === "-c" || t === "-C" || t === "--create" || t === "--orphan",
      )
    )
      return true;
    // Bare `git switch <ref>` (a positional, no create flag) — unambiguous
    // switch, block. `git switch -` (previous branch) and `--detach` both move
    // HEAD off the current branch, so any positional, `-`, or `--detach` blocks.
    if (tokens.some((t) => !t.startsWith("-") || t === "-" || t === "--detach"))
      return true;
    return false;
  }

  if (sub === "branch") {
    // `git branch <newname>` (a bare positional) creates a branch. List/delete/
    // rename/move and the inspection flags are all allowed. A flag that takes a
    // value (`-d`/`-D`/`-m`/`-M`/`-u`/`--set-upstream-to`) consumes its operand,
    // so we only deny when a NON-flag positional appears that is not such an
    // operand. Simplest robust rule: deny only if the FIRST token is a bare
    // positional (create form is `git branch <name> [start-point]`).
    const first = tokens[0];
    if (first === undefined) return false; // bare `git branch` = list
    return !first.startsWith("-");
  }

  if (sub === "worktree") {
    // `git worktree add …` creates a branch/worktree; list/remove/prune allow.
    return tokens[0] === "add";
  }

  return false;
}

/** Matches a `sh -c '<body>'` / `bash -c "<body>"` wrapper and captures the
 * quoted command body so we can scan INSIDE it — the opening quote is not a
 * command boundary in `GIT_INVOCATION`, so a wrapped `git switch z` would slip
 * through the top-level scan otherwise. Tolerates `/bin/sh`, env-prefixes, and
 * `sudo`/`env`. The body capture is greedy-to-the-matching-quote. */
const SHELL_WRAPPER =
  /(?:^|[;&|\n(`]|\$\()[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|env)[ \t]+)*(?:\/[^\s]*\/)?(?:sh|bash|zsh|dash)[ \t]+-c[ \t]+(?:'([^']*)'|"([^"]*)")/g;

/** Pure predicate: does the raw command string contain ANY subagent-forbidden
 * git branch create/switch form? Scans EVERY git invocation in the string
 * (compound `&&`/`;`/`|`, subshells, command substitution all open a command
 * boundary the regex recognizes), then recurses into any `sh -c`/`bash -c`
 * quoted body so a shell-wrapper-smuggled branch verb is still caught. Anchoring
 * `git` on a real command boundary is what keeps `git log --grep "git checkout
 * -b"` an ALLOW — the inner verb sits after a quote, not a boundary char. */
export function isBranchMutatingCommand(command: string): boolean {
  GIT_INVOCATION.lastIndex = 0;
  for (;;) {
    const m = GIT_INVOCATION.exec(command);
    if (m === null) break;
    if (isBranchMutatingInvocation(m[1] ?? "")) return true;
  }
  SHELL_WRAPPER.lastIndex = 0;
  for (;;) {
    const m = SHELL_WRAPPER.exec(command);
    if (m === null) return false;
    const body = m[1] ?? m[2] ?? "";
    if (body && isBranchMutatingCommand(body)) return true;
  }
}

const DENY_REASON =
  "Subagents must work IN PLACE on the current branch — never create or " +
  "switch git branches. Drop the branch operation. For file-level undo use " +
  "`git restore <path>` or `git checkout -- <path>`; the orchestrator owns " +
  "all branch/worktree decisions.";

/** Read all of stdin as text. `Bun.stdin.stream()` avoids the macOS
 * `process.stdin` buffer-until-close hang (Bun #18239). */
async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/** Emit the PreToolUse deny envelope (exit-0 + JSON; exit 2 would skip JSON
 * processing). The hookSpecificOutput shape is canonical on PreToolUse. */
function emitDeny(reason: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const payload = JSON.parse(raw) as {
    tool_name?: string;
    agent_id?: string;
    agent_type?: string;
    tool_input?: { command?: string };
  };

  if (payload.tool_name !== "Bash") return;
  // Load-bearing INVERSION of commit-guard: deny ONLY in subagent context.
  // `agent_id` (or `agent_type`) present means a worker subagent; an absent /
  // empty field means main context (the human or the orchestrator) — allow.
  if (!payload.agent_id && !payload.agent_type) return;

  const command = payload.tool_input?.command ?? "";
  if (!isBranchMutatingCommand(command)) return;

  emitDeny(DENY_REASON);
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the tool call proceed.
});
