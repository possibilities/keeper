// Unit tests for plugins/keeper/plugin/hooks/escalation-guard.ts.
//
// Two layers, both pure in-process (no subprocess): (1) the per-role allowlist
// truth table over `evaluateEscalationCommand` — the load-bearing predicate,
// covering the observed file-write bypass forms (heredoc, `-c`, `>` redirect,
// tee, command substitution, env-runner, compound off-list) and the
// diagnosis-vs-write-capable split; (2) the `decideEscalationGuard` decision
// ladder — the three-state jurisdiction (marker set → enforce+fail-closed,
// marker absent → inert), the malformed-payload fail-closed/open inversion, and
// the canonical deny-envelope shape.

import { describe, expect, test } from "bun:test";

import {
  decideEscalationGuard,
  evaluateEscalationCommand,
} from "../plugins/keeper/plugin/hooks/escalation-guard.ts";

// The two representative role configs the truth table drives.
const DIAGNOSIS = { role: "unblock", writeCapable: false } as const;
const WRITE = { role: "deconflict", writeCapable: true } as const;

// ---------------------------------------------------------------------------
// Tier 1 — evaluateEscalationCommand truth table
// ---------------------------------------------------------------------------

describe("evaluateEscalationCommand — diagnosis role (unblock/resolve)", () => {
  const allow = [
    // keeper read/board subset
    "keeper escalation-brief unblock::fn-1-x.3",
    "keeper session state",
    "keeper transcript claude session-1 --limit 20",
    "keeper plan unblock fn-1-x.3",
    "keeper query jobs",
    "keeper status",
    "keeper baseline abc123 --wait",
    "keeper bus list",
    "keeper show-job j-1",
    "keeper search-history foo",
    "keeper find-file-history src/x.ts",
    "keeper dispatch work::fn-1-x.3",
    // `keeper autopilot retry` is the one autopilot verb on the allowlist
    "keeper autopilot retry work::fn-1-x.3",
    // botctl (paging)
    "botctl send-message --topic Keeper hello",
    // read-only git
    "git log --oneline",
    "git show HEAD",
    "git diff HEAD~1",
    "git status",
    "git rev-parse HEAD",
    "git blame src/x.ts",
    "git ls-files",
    "git -C /repo log --oneline",
    // combined-diff `-c` is the log/show subcommand's OWN flag (not a `-c` config
    // global), so a post-subcommand `-c` before an `=`-bearing token is a read
    "git log -c --format=%H",
    "git show -c --format=%H",
    // `git branch` list/inspect forms stay allowed (only mutating forms deny)
    "git branch",
    "git branch -a",
    "git branch -r",
    "git branch -v",
    "git branch -vv",
    "git branch --list 'feat/*'",
    "git branch --contains HEAD",
    "git branch --merged main",
    // read utilities
    "rg pattern src/",
    "grep -rn foo .",
    "find . -name '*.ts'",
    "cat package.json",
    "head -50 src/x.ts",
    "tail -n 20 log.txt",
    "wc -l src/x.ts",
    "jq '.foo' file.json",
    // explicit test files + stable named package gates
    "bun test test/escalation-guard.test.ts",
    "bun test test/escalation-guard.test.ts test/wrapped-guard.test.ts",
    "bun test --test-name-pattern role test/escalation-guard.test.ts",
    "bun test --coverage test/escalation-guard.test.ts",
    "bun run test:gate",
    "bun run typecheck",
    // pipes between two allowlisted commands
    "git log --oneline | head -20",
    "keeper query jobs | jq '.'",
    // a stripped wrapper in front of an allowed command
    "timeout 300 bun test test/escalation-guard.test.ts",
    "nohup bun run test:gate",
    // a `>` INSIDE single quotes is literal — not a redirect
    "git log --grep 'fix > bug'",
    // `-O` is grep's exec alias ONLY — for diff/log it names a benign order file,
    // so it must not over-block on those read subcommands
    "git diff -O.git/order HEAD~1",
    "git log -O/tmp/orderfile",
  ];
  for (const cmd of allow) {
    test(`allows: ${cmd}`, () => {
      expect(evaluateEscalationCommand(cmd, DIAGNOSIS)).toBeNull();
    });
  }

  const deny = [
    // interpreter one-liners — the exact observed bypass class
    "python3 -c 'print(1)'",
    'python3 -c "open(1)"',
    "node -e 'x'",
    "ruby -e 'x'",
    "perl -e 'x'",
    "bun -e 'code'",
    "bun --eval 'code'",
    // aggregate discovery must use the named gate (bare/broad/options-only)
    "bun test",
    "bun test .",
    "bun test test",
    "bun test 'test/*.test.*'",
    "bun test --test-name-pattern role",
    "bun test -t fake.test.ts",
    "bun test --watch",
    "bun test --coverage",
    "timeout 300 bun test",
    "nohup bun test --coverage",
    // path-shaped/bare bun run is not a named package script
    "bun run",
    "bun run ./test.ts",
    // shell -c wrappers
    "sh -c 'git status'",
    "bash -c 'ls'",
    // file redirects / tee
    "cat file > out.txt",
    "cat file >> out.txt",
    "git status > status.txt",
    "echo hi > /etc/x",
    "tee out.txt",
    "cat a | tee b",
    // heredoc / here-string
    "python3 <<EOF",
    "cat <<-EOF",
    // command / process substitution
    "git log $(python3 -c 'x')",
    "echo `whoami`",
    "diff <(git show a) <(git show b)",
    // env-assignment prefix + env runner
    "FOO=1 git status",
    "env FOO=1 git status",
    // mutating git is off-list for diagnosis
    "git commit -m x",
    "git push",
    "git add .",
    "git merge feature",
    // git -c config injection turns an allowlisted read subcommand into arbitrary
    // program execution (F1) — every exec-bearing key form denies
    "git -c core.fsmonitor=/tmp/interp status",
    "git -c core.pager=/tmp/x --paginate log",
    "git -c diff.external=/tmp/x diff HEAD~1",
    "git -c core.sshCommand=/tmp/x log",
    "git -c alias.z=!whoami z",
    // the reorder evasion (a config flag after another global option) still denies
    "git -C /repo -c core.pager=/tmp/x log",
    // --config-env is the same config-injection class (value read from an env var)
    "git --config-env=core.pager=EVIL --paginate log",
    // a `-c` global reordered BEHIND another valued global still denies — the scan
    // spans the true pre-subcommand region because gitSubcommandInfo consumes the
    // valued global's value rather than misreading it as the subcommand
    "git --git-dir d -c x=y status",
    "git --namespace log -c core.pager=/tmp/evil log",
    // an exec-bearing flag on an allowlisted read subcommand runs an arbitrary
    // program — `git grep --open-files-in-pager`/`-O` opens matches in a pager
    "git grep --open-files-in-pager=/tmp/evil pattern",
    "git grep -O/tmp/evil pattern",
    // git parse-options accepts any unambiguous prefix of --open-files-in-pager
    // (down to --open) as the same exec alias, in both glued-`=` and
    // space-separated forms — the deny must match by prefix, not exact literal (F1)
    "git grep --open=/tmp/evil",
    "git grep --open-f=/tmp/evil",
    "git grep --open-files=/tmp/evil",
    "git grep --open-files-in=/tmp/evil pattern",
    "git grep --open /tmp/evil",
    "git grep --open-files /tmp/evil",
    // git's true minimum unambiguous prefix is `--op` (4 chars) — among grep's
    // `--o*` options only `--op` resolves to the exec alias — so the 4- and
    // 5-char prefixes reach `cannot exec` and must deny, glued and space-separated
    // (a `--open`-length floor let these through; F1) while `--o` is ambiguous and
    // git rejects it outright, so no correctness need to cover the `--o` boundary
    "git grep --op=/tmp/evil",
    "git grep --ope=/tmp/evil",
    "git grep --op /tmp/evil",
    "git grep --ope /tmp/evil pattern",
    // git's short-option bundling reaches the `-O` exec alias buried in a cluster
    // whose token STARTS with a benign flag (`-n`/`-i`/…) — the deny must catch a
    // capital `O` anywhere in a single-dash short-flag cluster (F1/F2)
    "git grep -nO/tmp/evil pattern",
    "git grep -iO/tmp/evil pattern",
    "git grep -inO/tmp/evil pattern",
    "git grep -O pattern",
    // `git log/diff --output=<file>` writes an arbitrary file for a read-only role
    // — a flag, not a shell redirect, so the lexer's redirect deny misses it (F3)
    "git log --output=/tmp/evil",
    "git diff --output=/tmp/evil HEAD~1",
    "git log --output /tmp/evil",
    // git branch mutating forms mutate refs from a read-only role (F2);
    // branch-guard cannot cover an escalation session (no agent_id)
    "git branch -D feature",
    "git branch -d feature",
    "git branch --delete feature",
    "git branch -f main origin/main",
    "git branch -m old new",
    "git branch -M old new",
    "git branch -c src dst",
    "git branch -u origin/main",
    "git branch --set-upstream-to=origin/main topic",
    "git branch --unset-upstream",
    "git branch --edit-description",
    // a mutating flag sitting in a filter-flag's value slot still classifies — the
    // filter-value lookahead consumes only a REAL value, never a following flag
    "git branch --list -D victim",
    // the bare create/reset form (a positional branch name, no list flag)
    "git branch newbranch",
    "git branch newbranch origin/main",
    // write-capable-only families are off-list for diagnosis
    "keeper commit-work 'msg'",
    "uv run pytest",
    "uv run python3 -c 'x'",
    "cargo build",
    "make",
    "npm install",
    "pnpm install",
    // autopilot verbs other than retry
    "keeper autopilot pause",
    "keeper autopilot play",
    // find -exec / -delete command-runner forms
    "find . -type f -exec cat {} +",
    "find . -name x -delete",
    // xargs with flags
    "xargs -I{} rm {}",
    // the observed compound: a legit prefix AND-chained with the bypass
    "keeper status && uv run python3 -c 'x'",
    "git log && rm -rf /",
    // plainly off-list
    "rm -rf /",
    "unknowncmd foo",
  ];
  for (const cmd of deny) {
    test(`denies: ${cmd}`, () => {
      expect(evaluateEscalationCommand(cmd, DIAGNOSIS)).not.toBeNull();
    });
  }
});

describe("evaluateEscalationCommand — write-capable role (deconflict/repair)", () => {
  // The write-capable additions over diagnosis: mutating git, keeper commit-work,
  // and the build/tool families.
  const allow = [
    "git commit -m 'merge both intents'",
    "git merge feature",
    "git add -A",
    "git push",
    "git checkout -- file.ts",
    // the two diagnosis-role gaps stay OPEN for a write-capable role — they get
    // all of git by design (config injection + branch mutation both pass)
    "git -c core.pager=/tmp/x --paginate log",
    "git branch -D feature",
    "git branch -m old new",
    "git branch newbranch",
    "keeper commit-work 'fix(scope): x'",
    "uv run pytest",
    "cargo build",
    "cargo test",
    "npm install",
    "pnpm install",
    "zig build test",
    "make",
    "bun install",
    "bun test test/escalation-guard.test.ts",
    "bun test --coverage test/escalation-guard.test.ts",
    "bun run test:gate",
    // the build-tool families make the observed compound an ALLOW for a trusted
    // write-capable role — the role split is intentional (authority follows surface)
    "keeper status && uv run python3 -c 'x'",
    // reads still pass
    "git log --oneline",
    "keeper query jobs",
  ];
  for (const cmd of allow) {
    test(`allows: ${cmd}`, () => {
      expect(evaluateEscalationCommand(cmd, WRITE)).toBeNull();
    });
  }

  // Structural bypass bans apply to EVERY role — write-capacity widens the
  // command allowlist, never the redirect/heredoc/interpreter surface.
  const deny = [
    "python3 -c 'x'",
    "node -e 'x'",
    "bun -e 'x'",
    "bun test",
    "bun test .",
    "bun test --watch",
    "bun test --coverage",
    "timeout 300 bun test",
    "sh -c 'git merge'",
    "git commit -m x > log.txt",
    "cat <<EOF",
    "git log $(rm -rf /)",
    "echo `whoami`",
    "FOO=1 git commit -m x",
    "keeper commit-work 'x' > out",
    "tee out.txt",
  ];
  for (const cmd of deny) {
    test(`denies: ${cmd}`, () => {
      expect(evaluateEscalationCommand(cmd, WRITE)).not.toBeNull();
    });
  }
});

test("evaluateEscalationCommand: the deny reason NAMES the offending command / construct", () => {
  expect(
    evaluateEscalationCommand("uv run python3 -c 'x'", DIAGNOSIS),
  ).toContain("uv");
  expect(evaluateEscalationCommand("python3 -c 'x'", DIAGNOSIS)).toContain(
    "python3",
  );
  expect(evaluateEscalationCommand("cat f > out", DIAGNOSIS)).toContain(
    "redirect",
  );
  expect(evaluateEscalationCommand("cat <<EOF", DIAGNOSIS)).toContain(
    "heredoc",
  );
  expect(evaluateEscalationCommand("git log $(whoami)", DIAGNOSIS)).toContain(
    "substitution",
  );
  expect(
    evaluateEscalationCommand("git -c core.fsmonitor=/tmp/x status", DIAGNOSIS),
  ).toContain("config injection");
  expect(
    evaluateEscalationCommand("git branch -D feature", DIAGNOSIS),
  ).toContain("mutates refs");
});

// ---------------------------------------------------------------------------
// Tier 2 — decideEscalationGuard jurisdiction ladder
// ---------------------------------------------------------------------------

function bashPayload(command: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "sess-esc",
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  };
}

describe("decideEscalationGuard ladder", () => {
  test("denies an off-list command for a marked (unblock) session — deny-envelope shape", () => {
    const decision = decideEscalationGuard(
      bashPayload("python3 -c 'open(1)'"),
      { KEEPER_ESCALATION_ROLE: "unblock" },
    );
    expect(decision).not.toBeNull();
    expect(decision?.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = decision?.hookSpecificOutput.permissionDecisionReason ?? "";
    expect(reason).toContain("unblock");
    expect(reason).toContain("python3");
  });

  test("allows an on-list command for a marked session (null → no output)", () => {
    expect(
      decideEscalationGuard(bashPayload("git log --oneline"), {
        KEEPER_ESCALATION_ROLE: "unblock",
      }),
    ).toBeNull();
  });

  test("a write-capable role's commit-work passes where diagnosis denies it", () => {
    expect(
      decideEscalationGuard(bashPayload("keeper commit-work 'x'"), {
        KEEPER_ESCALATION_ROLE: "deconflict",
      }),
    ).toBeNull();
    expect(
      decideEscalationGuard(bashPayload("keeper commit-work 'x'"), {
        KEEPER_ESCALATION_ROLE: "unblock",
      }),
    ).not.toBeNull();
  });

  test("all four roles resolve (unblock/resolve diagnosis, deconflict/repair write)", () => {
    // A mutating-git command: allowed for the two write-capable roles, denied for
    // the two diagnosis roles.
    for (const role of ["deconflict", "repair"]) {
      expect(
        decideEscalationGuard(bashPayload("git commit -m x"), {
          KEEPER_ESCALATION_ROLE: role,
        }),
      ).toBeNull();
    }
    for (const role of ["unblock", "resolve"]) {
      expect(
        decideEscalationGuard(bashPayload("git commit -m x"), {
          KEEPER_ESCALATION_ROLE: role,
        }),
      ).not.toBeNull();
    }
  });

  test("a compound where any segment is off-list denies for a marked session", () => {
    expect(
      decideEscalationGuard(
        bashPayload("keeper status && uv run python3 -c 'x'"),
        { KEEPER_ESCALATION_ROLE: "unblock" },
      ),
    ).not.toBeNull();
  });

  test("no marker + agent_id present → inert (branch-guard's turf), even for an off-list command", () => {
    expect(
      decideEscalationGuard(
        bashPayload("python3 -c 'x'", { agent_id: "agent-7" }),
        {},
      ),
    ).toBeNull();
  });

  test("no marker + no agent_id (human session) → inert, fail open", () => {
    expect(decideEscalationGuard(bashPayload("python3 -c 'x'"), {})).toBeNull();
  });

  test("an empty / whitespace role marker counts as absent → inert", () => {
    expect(
      decideEscalationGuard(bashPayload("python3 -c 'x'"), {
        KEEPER_ESCALATION_ROLE: "",
      }),
    ).toBeNull();
    expect(
      decideEscalationGuard(bashPayload("python3 -c 'x'"), {
        KEEPER_ESCALATION_ROLE: "   ",
      }),
    ).toBeNull();
  });

  test("a role marker is trimmed before matching", () => {
    // Padding must not defeat enforcement (off-list still denies) nor allow-listing.
    expect(
      decideEscalationGuard(bashPayload("python3 -c 'x'"), {
        KEEPER_ESCALATION_ROLE: "  unblock  ",
      }),
    ).not.toBeNull();
    expect(
      decideEscalationGuard(bashPayload("git log"), {
        KEEPER_ESCALATION_ROLE: "  unblock  ",
      }),
    ).toBeNull();
  });

  test("an unrecognized role value denies every Bash command (fail closed)", () => {
    const decision = decideEscalationGuard(bashPayload("git log"), {
      KEEPER_ESCALATION_ROLE: "bogus-role",
    });
    expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("a non-Bash tool passes for a marked session (this guard governs Bash only)", () => {
    expect(
      decideEscalationGuard(
        {
          tool_name: "Read",
          tool_input: { file_path: "/x" },
        },
        { KEEPER_ESCALATION_ROLE: "unblock" },
      ),
    ).toBeNull();
  });

  test("a malformed payload denies for a marked session, allows (silent) for an unmarked one", () => {
    // Non-object payload (a JSON.parse of garbage collapses to this at the caller).
    expect(
      decideEscalationGuard(null, { KEEPER_ESCALATION_ROLE: "unblock" }),
    ).not.toBeNull();
    expect(decideEscalationGuard(null, {})).toBeNull();
    // A Bash payload missing its command string is malformed → fail closed.
    expect(
      decideEscalationGuard(
        { tool_name: "Bash", tool_input: {} },
        { KEEPER_ESCALATION_ROLE: "unblock" },
      ),
    ).not.toBeNull();
    expect(
      decideEscalationGuard({ tool_name: "Bash", tool_input: {} }, {}),
    ).toBeNull();
  });

  test("an empty-string command is inert (nothing runs) for a marked session", () => {
    expect(
      decideEscalationGuard(bashPayload(""), {
        KEEPER_ESCALATION_ROLE: "unblock",
      }),
    ).toBeNull();
  });
});
