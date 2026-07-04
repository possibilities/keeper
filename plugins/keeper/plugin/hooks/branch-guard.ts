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

/** True for `--orphan` in its `=value` form (`--orphan=gh-pages`). The bare
 * `--orphan` is matched by exact equality at the call site; this covers the
 * attached-operand form both `checkout` and `switch` accept. */
function isOrphanFlag(t: string): boolean {
  return t.startsWith("--orphan=");
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
    // Create form: any of -b/-B/--orphan. `--orphan=<x>` (equals form) is the
    // same create, so match the flag with or without an attached `=value`.
    if (
      tokens.some(
        (t) => t === "-b" || t === "-B" || t === "--orphan" || isOrphanFlag(t),
      )
    )
      return true;
    // `git checkout -- <path>` is an explicit file restore — allow.
    if (tokens.includes("--")) return false;
    // Bare `git checkout <X>` with at least one positional and no `--`:
    // ambiguous switch-vs-restore resolves toward BLOCK (human ruling). A bare
    // `git checkout` with only flags (no positional) is not a switch.
    return tokens.some((t) => !t.startsWith("-"));
  }

  if (sub === "switch") {
    // Create form: -c/-C/--create/--orphan. The `--create=<x>` / `--orphan=<x>`
    // equals forms are the same create, so match those flags prefix-aware too.
    if (
      tokens.some(
        (t) =>
          t === "-c" ||
          t === "-C" ||
          t === "--create" ||
          t === "--orphan" ||
          t.startsWith("--create=") ||
          isOrphanFlag(t),
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
    // `git branch <newname> [start-point]` (a positional NAME) creates a branch.
    // A leading flag that consumes no operand (`-f`/`--force`) pushes the
    // new-branch name to a later token, so we cannot inspect tokens[0] alone.
    // Mode-selecting flags make the command never a create: delete
    // (`-d`/`-D`/`--delete`) and rename/move (`-m`/`-M`/`--move`) operate on an
    // existing branch — if any is present, allow regardless of how many
    // positionals follow. Short and long forms classify identically.
    //
    // Copy (`-c`/`-C`/`--copy`) is deliberately ABSENT: copy creates a new
    // branch ref, which is exactly the subagent bypass this guard exists to
    // block, so it falls through to the positional create check and DENIES.
    const modeFlags = new Set(["-d", "-D", "--delete", "-m", "-M", "--move"]);
    if (tokens.some((t) => modeFlags.has(t))) return false;
    // Otherwise scan for the first positional that is not the single-value
    // operand of an upstream/track flag (`-u`/`--set-upstream-to`/`-t`/`--track`).
    // The `=value` forms carry their operand inline and consume no next token.
    const valueFlags = new Set(["-u", "--set-upstream-to", "-t", "--track"]);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as string;
      if (t.startsWith("-")) {
        if (valueFlags.has(t)) i++; // skip this flag's operand token
        continue;
      }
      return true; // a positional that is not a flag operand = create form
    }
    return false; // only flags (or empty) = list/inspect
  }

  if (sub === "worktree") {
    // `git worktree add …` creates a branch/worktree; list/remove/prune allow.
    return tokens[0] === "add";
  }

  if (sub === "stash") {
    // refs/stash is ONE repo-global ref stack shared by every sibling worktree
    // and the human's checkout — git has no per-worktree stash — so a worker's
    // `stash push/pop` displaces files across trees mid-epic. ALLOWLIST, never a
    // deny-list: git keeps adding stash verbs (export/import landed in 2.50), so
    // deny-by-default covers every future verb for free. The three allowed verbs
    // are read-only or ref-free — `list`/`show` only read; `create` writes no
    // ref and materializes nothing. Everything else denies, INCLUDING `pop`/
    // `apply`: they are denied on the "touches the shared stack OR materializes
    // stashed files into THIS tree" axis even though `apply` writes no ref — that
    // materialization was the incident shape, so do NOT relax this to a
    // writes-refs/stash test. Verb-first, never substring matching: the verb is
    // exactly tokens[0] after the global-flag strip. An empty token list (bare
    // `git stash`, which git defines as `push`) or a LEADING FLAG denies — that
    // also closes the `-m <allowlist-word>` operand bypass (`git stash -m show`:
    // tokens[0] is `-m`, a flag, so it denies and never reaches `show`); a future
    // "skip flags then find the verb" refactor must not reintroduce it. Alias-
    // laundered stash (`git -c alias.x=stash x`, repo `[alias] st=stash`) can't
    // be resolved by a dep-free hook — accepted gap; the worker-prose ban backs
    // it up.
    const STASH_ALLOWLIST = new Set(["list", "show", "create"]);
    const verb = tokens[0];
    return verb === undefined || !STASH_ALLOWLIST.has(verb);
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
  "switch git branches, and never touch `git stash` (only list/show/create " +
  "are allowed). refs/stash is ONE stack shared by every sibling worktree and " +
  "the human's checkout, so a worker stash push/pop displaces files across " +
  "trees. Drop the operation. For file-level undo use `git restore <path>` or " +
  "`git checkout -- <path>`; to park work make a temp commit, never stash; " +
  "the orchestrator owns all branch/worktree decisions.";

/** Read all of stdin as text. `Bun.stdin.stream()` avoids the macOS
 * `process.stdin` buffer-until-close hang (Bun #18239). */
async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/** The PreToolUse hook payload fields the branch-guard decision reads. */
export interface BranchGuardPayload {
  tool_name?: string;
  agent_id?: string;
  agent_type?: string;
  tool_input?: { command?: string };
}

/** The canonical PreToolUse deny envelope (exit-0 + JSON; exit 2 would skip
 * JSON processing). `hookSpecificOutput` is the canonical PreToolUse shape. */
export interface BranchGuardDenyEnvelope {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/**
 * Pure decision: the deny envelope to emit for this payload, or null to allow
 * (no output). Encodes the load-bearing INVERSION of commit-guard — deny ONLY
 * in subagent context: `agent_id` (or `agent_type`) present means a worker
 * subagent, so a branch-mutating command DENIES; an absent/empty field means
 * main context (the human or the content-blind orchestrator — INCLUDING main's
 * own in-daemon worktree producer, which shells git with no `agent_id`) and
 * always ALLOWS. A non-Bash tool or a non-branch-mutating command also allows.
 */
export function decideBranchGuard(
  payload: BranchGuardPayload,
): BranchGuardDenyEnvelope | null {
  if (payload.tool_name !== "Bash") return null;
  if (!payload.agent_id && !payload.agent_type) return null;
  const command = payload.tool_input?.command ?? "";
  if (!isBranchMutatingCommand(command)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DENY_REASON,
    },
  };
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const payload = JSON.parse(raw) as BranchGuardPayload;
  const decision = decideBranchGuard(payload);
  if (decision !== null) {
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  }
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the tool call proceed.
});
