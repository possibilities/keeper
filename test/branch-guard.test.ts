// Unit tests for plugins/keeper/plugin/hooks/branch-guard.ts.
//
// Two layers, both pure in-process (no subprocess): (1) the branch-mutation
// classifier truth table — the load-bearing predicate — over
// `isBranchMutatingCommand`; (2) the `decideBranchGuard` decision ladder,
// covering the load-bearing agent-gate INVERSION in BOTH directions (deny a
// subagent branch op, allow main's own in-daemon worktree producer), the
// deny/allow split, and the canonical deny-envelope shape.

import { describe, expect, test } from "bun:test";

import {
  decideBranchGuard,
  isBranchMutatingCommand,
} from "../plugins/keeper/plugin/hooks/branch-guard.ts";

describe("isBranchMutatingCommand", () => {
  const deny = [
    // checkout create forms
    "git checkout -b feature",
    "git checkout -B feature origin/main",
    "git checkout --orphan gh-pages",
    // switch create forms
    "git switch -c feature",
    "git switch -C feature",
    "git switch --create feature",
    "git switch --orphan new",
    // create-flag equals forms (F1)
    "git switch --create=zzz",
    "git checkout --orphan=gh-pages",
    "git switch --orphan=new",
    // bare switch <ref> (unambiguous switch, no create flag)
    "git switch main",
    "git switch -",
    "git switch --detach",
    // bare checkout <X> with no `--` separator (block per human ruling)
    "git checkout main",
    "git checkout feature-branch",
    // branch <newname>
    "git branch newfeature",
    "git branch newfeature origin/main",
    // branch copy-create — copy creates a new ref, so it BLOCKS (F1); short and
    // long forms classify identically
    "git branch -c newcopy",
    "git branch -C base newcopy",
    "git branch --copy newcopy",
    "git branch --copy base newcopy",
    // branch create behind a leading non-operand flag (F2)
    "git branch --force newbranch",
    "git branch -f newbranch start-point",
    "git branch -f newbranch",
    // worktree add
    "git worktree add ../wt feature",
    // stash — deny-by-default over the shared refs/stash stack. Bare `git
    // stash` == push; every mutating/materializing verb, unknown verbs, and any
    // leading-flag form deny; only list/show/create are allowlisted.
    "git stash",
    "git stash push",
    "git stash push -u -m x",
    "git stash save",
    "git stash pop",
    "git stash apply",
    "git stash apply stash@{0}",
    "git stash drop",
    "git stash clear",
    "git stash store deadbeef",
    "git stash branch b",
    "git stash export",
    "git stash import",
    // flag-only forms (leading flag, no verb token) — all push aliases
    "git stash -u",
    "git stash -p",
    "git stash --all",
    "git stash --include-untracked",
    // `-m <word>` operand bypass: `show` is the message, not a verb — tokens[0]
    // is the `-m` flag, so this denies and must never reach the allowlist
    "git stash -m show",
    // unknown verb — deny-by-default covers verbs git may add later
    "git stash puhs",
    // wrapped / compound / env-prefix / global-flag stash forms
    'sh -c "git stash pop"',
    "git status && git stash",
    "$(git stash pop)",
    "FOO=1 git stash pop",
    "git -C /x stash pop",
    // compound / subshell / env-prefix / global-flag forms
    "cd x && git checkout -b y",
    'sh -c "git switch z"',
    "bash -c 'git checkout -b w'",
    "FOO=1 git checkout -b w",
    "FOO=1 BAR=2 git switch -c w",
    "sudo git checkout -b w",
    "env GIT_AUTHOR_NAME=x git checkout -b w",
    "git -C /path checkout -b v",
    "git --git-dir=/p/.git checkout -b v",
    "git status && git checkout -b late",
    "git status; git switch other",
    "make build | git checkout -b piped",
    "echo hi && (git checkout -b sub)",
    "result=$(git checkout -b cmdsub)",
    "`git switch sub`",
  ];
  for (const cmd of deny) {
    test(`denies: ${cmd}`, () => {
      expect(isBranchMutatingCommand(cmd)).toBe(true);
    });
  }

  const allow = [
    // file-restore forms
    "git checkout -- file.ts",
    "git checkout -- .",
    "git restore file.ts",
    "git restore --staged file.ts",
    // branch inspection / delete / rename (non-create)
    "git branch",
    "git branch -d old",
    "git branch -D old",
    "git branch -m old new",
    // long-form delete/move operate on an existing branch — no false-deny (F3);
    // short and long forms classify identically
    "git branch --delete old",
    "git branch --move old new",
    "git branch --list",
    "git branch -a",
    "git branch -v",
    "git branch -r",
    "git branch --show-current",
    // worktree non-create
    "git worktree list",
    "git worktree remove ../wt",
    // ordinary git
    "git status",
    "git add .",
    "git add -A",
    "git commit -m x",
    "git push",
    "git pull",
    "git fetch origin",
    "git log --oneline",
    "git diff HEAD",
    "git show HEAD",
    // stash allowlist — read-only / ref-free verbs stay allowed (diff flags on
    // show and an operand on create do not change the verb at tokens[0])
    "git stash list",
    "git stash list --oneline",
    "git stash show",
    "git stash show -p",
    "git stash create",
    "git stash create msg",
    // quoted-string false-positive guards: the verb lives inside an echo/grep
    // argument, not at a command boundary
    'git log --grep "git checkout -b"',
    "git commit -m 'git switch'",
    // not git at all
    "ls -la",
    "mygit checkout -b x",
  ];
  for (const cmd of allow) {
    test(`allows: ${cmd}`, () => {
      expect(isBranchMutatingCommand(cmd)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// decision ladder — pure `decideBranchGuard`
// ---------------------------------------------------------------------------

function bashPayload(extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "sess-branch",
    tool_name: "Bash",
    tool_input: { command: "git checkout -b feature" },
    ...extra,
  };
}

describe("decideBranchGuard ladder", () => {
  test("denies a branch-create form when agent_id is present (deny-envelope shape)", () => {
    const decision = decideBranchGuard(bashPayload({ agent_id: "agent-7" }));
    expect(decision).not.toBeNull();
    expect(decision?.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain(
      "work IN PLACE",
    );
  });

  test("denies a branch-switch form when agent_type is present (no agent_id)", () => {
    const decision = decideBranchGuard(
      bashPayload({
        agent_type: "plan:worker-xhigh",
        tool_input: { command: "git switch other" },
      }),
    );
    expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("denies a compound `cd x && git checkout -b y` for a subagent", () => {
    const decision = decideBranchGuard(
      bashPayload({
        agent_id: "agent-7",
        tool_input: { command: "cd sub && git checkout -b y" },
      }),
    );
    expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("denies a subagent `git stash pop`; reason names the shared stash stack and `git restore`", () => {
    const decision = decideBranchGuard(
      bashPayload({
        agent_id: "agent-7",
        tool_input: { command: "git stash pop" },
      }),
    );
    expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = decision?.hookSpecificOutput.permissionDecisionReason ?? "";
    expect(reason).toContain("git stash");
    expect(reason).toContain("refs/stash");
    expect(reason).toContain("shared");
    expect(reason).toContain("git restore <path>");
  });

  test("allows an allowlisted `git stash list` for a subagent", () => {
    expect(
      decideBranchGuard(
        bashPayload({
          agent_id: "agent-7",
          tool_input: { command: "git stash list" },
        }),
      ),
    ).toBeNull();
  });

  test("allows a mutating stash form with NO agent context (main/human)", () => {
    expect(
      decideBranchGuard(
        bashPayload({ tool_input: { command: "git stash pop" } }),
      ),
    ).toBeNull();
  });

  // The allow-main-producer direction is load-bearing: main's own in-daemon
  // worktree producer shells `git worktree add` with NO agent_id, and MUST be
  // allowed — the gate inversion that this branch asserts against the deny one.
  test("allows a branch-create form when agent_id is absent (main context)", () => {
    expect(decideBranchGuard(bashPayload())).toBeNull();
  });

  test("allows main's own worktree-add producer (no agent_id)", () => {
    expect(
      decideBranchGuard(
        bashPayload({
          tool_input: { command: "git worktree add ../wt feature" },
        }),
      ),
    ).toBeNull();
  });

  test("empty-string agent_id counts as absent — allow", () => {
    expect(decideBranchGuard(bashPayload({ agent_id: "" }))).toBeNull();
  });

  test("allows ordinary git for a subagent", () => {
    expect(
      decideBranchGuard(
        bashPayload({
          agent_id: "agent-7",
          tool_input: { command: "git status" },
        }),
      ),
    ).toBeNull();
  });

  test("allows a file-restore checkout for a subagent", () => {
    expect(
      decideBranchGuard(
        bashPayload({
          agent_id: "agent-7",
          tool_input: { command: "git checkout -- src/x.ts" },
        }),
      ),
    ).toBeNull();
  });

  test("non-Bash tool passes for a subagent", () => {
    expect(
      decideBranchGuard(
        bashPayload({
          agent_id: "agent-7",
          tool_name: "Read",
          tool_input: { file_path: "/x" },
        }),
      ),
    ).toBeNull();
  });

  test("a subagent Bash with no command allows (nothing to mutate)", () => {
    expect(
      decideBranchGuard({ tool_name: "Bash", agent_id: "agent-7" }),
    ).toBeNull();
  });
});
