// Unit tests for plugins/keeper/plugin/hooks/wrapped-guard.ts.
//
// Two pure in-process layers (no subprocess / real fs / daemon): (1) the Bash
// delegation + close-out allowlist truth table over `evaluateWrappedBash` — the
// load-bearing predicate, covering the permitted leg-launch + close-out surface,
// the denied source-editing vectors, the re-entrant wrappers, and the documented
// CVE-2025-66032 shell-bypass corpus as deny vectors; (2) the `decideWrappedGuard`
// decision ladder — the two-condition jurisdiction (marker non-empty AND subagent
// agent_id OR agent_type, either anchoring it), the SendMessage constant total
// deny (no grant lifts it, a typed BLOCKED category returns to the parent, an
// identity-less caller stays inert), the total edit-denial (Edit/MultiEdit/
// NotebookEdit + in-tree Write), the out-of-tree Write allowance, the
// fail-closed-when-marked / inert-otherwise inversion, the parse-ambiguity
// fail-closed, and the deny-precedence / single-state intent. The Write tree
// check runs against an injected fake TreeProbe over a virtual repo layout.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditSubmitFileSafe,
  decideWrappedGuard,
  evaluateWrappedBash,
  fsProbe,
  type TreeProbe,
  type WrappedGuardPayload,
  writeAtomicWrappedHandoff,
} from "../plugins/keeper/plugin/hooks/wrapped-guard.ts";
import {
  type GrantLeaf,
  grantCoversWrite,
  writeGrantLeaf,
} from "../src/grant-leaf.ts";

// ---------------------------------------------------------------------------
// Tier 1 — evaluateWrappedBash truth table
// ---------------------------------------------------------------------------

describe("evaluateWrappedBash — the delegation + close-out allowlist", () => {
  const context = {
    taskId: "fn-1-x.2",
    envelopeReference: "$KEEPER_WRAPPED_ENVELOPE",
  };
  const gitRead =
    "git -c core.fsmonitor=false -c core.pager=cat -c log.showSignature=false --no-pager";
  const allow = [
    // delegation surface: the blocking leg launch + resume + wait + read (no shell
    // operators — a clean `keeper agent run` is the whole point of the courier)
    "keeper agent run codex 'implement task' --preset gpt-5::high --system-file /tmp/contract.md --session wrapped --name fn-1-x.2 --output \"$KEEPER_WRAPPED_ENVELOPE\" --stop-timeout 300s",
    "keeper agent run codex 'implement task' --preset gpt-5::high --system-file /tmp/contract.md --session wrapped --name fn-1-x.2 --output \"$KEEPER_WRAPPED_ENVELOPE\" --stop-timeout 300s --reap-window-on-terminal",
    "keeper agent run codex 'address the lint failure' --resume leg-fn-1-x.2 --session wrapped --name fn-1-x.2 --output \"$KEEPER_WRAPPED_ENVELOPE\" --stop-timeout 300s",
    "keeper agent wait leg-fn-1-x.2",
    "keeper agent wait-for-stop leg-fn-1-x.2",
    "keeper agent show-last-message leg-fn-1-x.2",
    "keeper agent providers resolve gpt-5 high",
    `mktemp -d ${join(tmpdir(), "keeper-wrapped-XXXXXX")}`,
    // a wrapped worker whose env resolves a different/absent TMPDIR must be able
    // to name a system-temp root directly — the keeper-wrapped basename is the boundary
    "mktemp -d /tmp/keeper-wrapped-XXXXXX",
    "mktemp -d /private/tmp/keeper-wrapped-XXXXXX",
    "mktemp -d /private/tmp/claude-501/keeper-wrapped-XXXXXX",
    // close-out surface
    "keeper commit-work --task-id fn-1-x.2 'feat(scope): implement X'",
    "keeper plan done fn-1-x.2 --summary 'done'",
    "keeper plan done fn-1-x.2 --summary 'done' --no-op-reason 'no code landed'",
    "keeper plan done fn-1-x.2 --no-op-reason 'doc-only follow-up'",
    // reads / orientation
    "keeper plan cat fn-1-x.2",
    "keeper plan show fn-1-x.2",
    "keeper plan find-task-commit fn-1-x.2",
    "keeper session state",
    "keeper baseline abc123 --wait",
    // read-only git
    `${gitRead} status`,
    `${gitRead} log --no-ext-diff --no-textconv --oneline`,
    `${gitRead} diff --no-ext-diff --no-textconv HEAD~1`,
    `${gitRead} show --no-ext-diff --no-textconv HEAD`,
    "git rev-parse HEAD",
    `git -C /repo -c core.fsmonitor=false -c core.pager=cat -c log.showSignature=false --no-pager log --no-ext-diff --no-textconv --oneline`,
    // combined-diff `-c` is the log/show subcommand's OWN flag, a read
    `${gitRead} log --no-ext-diff --no-textconv -c --format=%H`,
    // a stripped benign wrapper in front of an allowed command
    "nohup keeper agent wait leg-x",
    // pipes between two allowlisted commands
    `${gitRead} log --no-ext-diff --no-textconv --oneline | git rev-parse HEAD`,
    // a `>` INSIDE single quotes is literal — not a redirect
    `${gitRead} log --no-ext-diff --no-textconv --grep 'fix > bug'`,
    // an empty command runs nothing
    "",
  ];
  for (const cmd of allow) {
    test(`allows: ${cmd}`, () => {
      expect(evaluateWrappedBash(cmd, context)).toBeNull();
    });
  }

  const deny = [
    // --- interpreters / inline shells (the native-write bypass class) ---
    'python3 -c \'open("x","w")\'',
    'node -e \'require("fs").writeFileSync("x","y")\'',
    "ruby -e 'x'",
    "perl -e 'x'",
    "sh -c 'echo hi > src/x.ts'",
    "bash -c 'ls'",
    "bun -e 'code'",
    "bun --eval 'code'",
    "bun -p 'code'",
    // --- repository tests/scripts are transitive code execution ---
    "bun test",
    "bun test .",
    "bun test test",
    "bun test 'test/*.test.*'",
    "bun test --test-name-pattern allow",
    "bun test -t fake.test.ts",
    "bun test --watch",
    "bun test --coverage",
    "timeout 300 bun test",
    "nohup bun test --coverage",
    "bun test test/wrapped-guard.test.ts",
    "bun test test/wrapped-guard.test.ts test/escalation-guard.test.ts",
    "bun test --test-name-pattern allow test/wrapped-guard.test.ts",
    "bun test --coverage test/wrapped-guard.test.ts",
    "bun run test:gate",
    "bun run test:full",
    "timeout 300 bun test test/wrapped-guard.test.ts",
    "nohup bun run test:gate",
    // --- bun run demands a NAMED package script: a path-shaped target could run a
    //     just-written out-of-tree file, and a bare run has no script ---
    "bun run start",
    "bun run /scratch/gen.ts",
    "bun run ./gen.ts",
    "bun run",
    "mktemp -d /tmp/arbitrary-XXXXXX",
    "mktemp /tmp/keeper-wrapped-XXXXXX",
    // a keeper-wrapped basename OUTSIDE every system-temp root is still denied
    "mktemp -d /home/mike/keeper-wrapped-XXXXXX",
    "mktemp -d /etc/keeper-wrapped-XXXXXX",
    // a `..` escape out of an accepted temp root is still denied
    "mktemp -d /tmp/../etc/keeper-wrapped-XXXXXX",
    // --- in-tree write vectors: redirect / heredoc / here-string / tee / sed -i ---
    "echo hacked > src/x.ts",
    "echo more >> src/x.ts",
    "git show HEAD:src/x.ts > src/x.ts",
    "cat <<EOF > src/x.ts",
    "cat <<-EOF",
    "cat a | tee src/x.ts",
    "tee src/x.ts",
    "sed -i 's/a/b/' src/x.ts",
    "gsed -i 's/a/b/' src/x.ts",
    // --- content-injecting git / file ops (all off-list) ---
    "git apply /tmp/patch.diff",
    "git am /tmp/patch.mbox",
    "patch -p1 < /tmp/patch.diff",
    "patch src/x.ts /tmp/patch.diff",
    "cp /tmp/evil.ts src/x.ts",
    "mv /tmp/evil.ts src/x.ts",
    "tar -x -f /tmp/payload.tar",
    "tar xf /tmp/payload.tar",
    // --- mutating / off-list git (source commits route through commit-work) ---
    "git add src/x.ts",
    "git add -A",
    "git commit -m 'feat(x): land the leg work'",
    "git commit -F /scratch/msg.txt",
    "git commit --trailer 'Job-Id: job-1' -m msg",
    "keeper commit-work 'feat(x): missing trusted task'",
    "keeper commit-work -- --task-id",
    "keeper commit-work --task-id fn-1-other.9 'wrong task'",
    "keeper agent run claude 'escape' --model opus --system-file /tmp/c.md --session wrapped --name fn-1-x.2 --output \"$KEEPER_WRAPPED_ENVELOPE\" --stop-timeout 300s",
    "keeper agent run codex 'unbound nested agent' --model gpt-5",
    "keeper agent run codex 'dup reap flag' --preset gpt-5::high --system-file /tmp/contract.md --session wrapped --name fn-1-x.2 --output \"$KEEPER_WRAPPED_ENVELOPE\" --stop-timeout 300s --reap-window-on-terminal --reap-window-on-terminal",
    "keeper agent run codex 'valueless boolean impostor' --preset gpt-5::high --system-file /tmp/contract.md --session wrapped --name fn-1-x.2 --output \"$KEEPER_WRAPPED_ENVELOPE\" --stop-timeout 300s --detach",
    "git push",
    "git rm src/x.ts",
    "git mv a b",
    "git checkout -- src/x.ts",
    "git restore src/x.ts",
    "git reset --soft HEAD~1",
    "git reset --hard HEAD~1",
    "git reset --mixed HEAD~1",
    "git reset",
    "git clean -fd",
    // --- git -c config injection turns an allowlisted read into arbitrary exec ---
    "git -c core.pager=/tmp/x --paginate log",
    "git -c core.sshCommand=/tmp/x log",
    "git --config-env=core.pager=EVIL --paginate log",
    "git --git-dir d -c x=y status",
    "git -ccore.pager=/tmp/x log",
    "git --no-pager --paginate log",
    "git cat-file --filters HEAD:file",
    `${gitRead} show --no-ext-diff --no-textconv --textconv HEAD`,
    `${gitRead} log --no-ext-diff --no-textconv --show-signature`,
    `${gitRead} log --no-ext-diff --no-textconv --format=%GG`,
    `${gitRead} show --no-ext-diff --no-textconv --pretty=repoAlias HEAD`,
    "git -c core.fsmonitor=false -c core.pager=cat --no-pager log --no-ext-diff --no-textconv --oneline",
    // --- exec-bearing / file-writing flags on an allowlisted read subcommand ---
    "git grep --open-files-in-pager=/tmp/evil pattern",
    "git grep -O/tmp/evil pattern",
    "git grep --op=/tmp/evil",
    "git log --output=/tmp/evil",
    "git diff --output /tmp/evil HEAD~1",
    // --- off-list keeper subcommands / mutating plan verbs ---
    "keeper plan scaffold --file /tmp/plan.yaml",
    "keeper plan refine-apply fn-1-x --file /tmp/delta.yaml",
    "keeper plan claim fn-1-x.2",
    "keeper plan done fn-1-other.9 --summary done",
    "keeper plan done fn-1-x.2 --force",
    "keeper plan done fn-1-x.2 --project /tmp/other",
    // --no-op-reason is a split-form value option; the glued form is off-list.
    "keeper plan done fn-1-x.2 --no-op-reason=escape",
    "keeper plan done fn-1-x.2 --no-op-reason",
    "keeper prompt render",
    "keeper tabs restore",
    "keeper dispatch work::fn-1-x.2",
    // --- re-entrant wrappers / env runners ---
    "env FOO=1 keeper agent wait leg-x",
    "xargs -I{} cp {} src/",
    "find . -name '*.ts' -exec cp /tmp/evil {} +",
    // --- env-assignment prefix ---
    "FOO=1 keeper agent wait leg-x",
    "GIT_EDITOR=vi git commit",
    // --- plainly off-list ---
    "rm -rf src/",
    "vim src/x.ts",
    "unknowncmd foo",
  ];
  for (const cmd of deny) {
    test(`denies: ${cmd}`, () => {
      expect(evaluateWrappedBash(cmd, context)).not.toBeNull();
    });
  }
});

describe("evaluateWrappedBash — launch-bound AUDIT_READY block", () => {
  const context = {
    taskId: "fn-1-x.2",
    envelopeReference: "$KEEPER_WRAPPED_ENVELOPE",
  };

  test("allows the launch-bound task with an AUDIT_READY-prefixed reason", () => {
    expect(
      evaluateWrappedBash(
        "keeper plan block fn-1-x.2 --reason 'AUDIT_READY: abc123 committed'",
        context,
      ),
    ).toBeNull();
  });

  test("denies an AUDIT_READY block for a foreign task", () => {
    const reason = evaluateWrappedBash(
      "keeper plan block fn-1-other.9 --reason 'AUDIT_READY: abc123 committed'",
      context,
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("launch-bound task");
  });

  test("denies a launch-bound block whose reason is not AUDIT_READY", () => {
    const reason = evaluateWrappedBash(
      "keeper plan block fn-1-x.2 --reason 'TOOLING_FAILURE: provider failed'",
      context,
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("must start with `AUDIT_READY:`");
  });

  test("denies --force on an otherwise valid launch-bound AUDIT_READY block", () => {
    const reason = evaluateWrappedBash(
      "keeper plan block fn-1-x.2 --reason 'AUDIT_READY: abc123 committed' --force",
      context,
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("plan block --force");
  });
});

describe("evaluateWrappedBash — quality-auditor per-task submit carve-out", () => {
  // The per-task audit gate's static `plan:quality-auditor` inherits the wrapped
  // parent's marker; the carve-out admits ONLY its findings submit, ONLY in the
  // `submit-task --file <path> --status <s>` shape, and ONLY for that agent_type.
  // The file-class probe fails closed (absence denies), so the pure shape tests
  // inject a permissive probe; the fs-backed class enforcement is covered by the
  // production-path and real-fs suites below.
  const auditor = {
    taskId: "fn-1-x.2",
    envelopeReference: "$KEEPER_WRAPPED_ENVELOPE",
    agentType: "plan:quality-auditor",
    auditFileProbe: () => true,
  };

  const allow = [
    "keeper plan audit submit-task fn-1-x.2 --file /tmp/finding.json --status mild",
    // option order is free; --status may precede --file
    "keeper plan audit submit-task fn-1-x.2 --status clean --file /tmp/finding.json",
    // --project pin + a claude scratchpad path + severe verdict
    'keeper plan audit submit-task fn-1-x.2 --project "/repo" --status severe --file /private/tmp/claude-501/x/finding.json',
    // glued option=value forms
    "keeper plan audit submit-task fn-1-x.2 --file=/tmp/finding.json --status=mild",
    // an explicit output format is a benign passthrough
    "keeper plan audit submit-task fn-1-x.2 --file /tmp/finding.json --status mild --format json",
  ];
  for (const cmd of allow) {
    test(`allows for the quality-auditor: ${cmd}`, () => {
      expect(evaluateWrappedBash(cmd, auditor)).toBeNull();
    });
  }

  const denyShapes = [
    // the stdin+heredoc form stays denied (the lexer is untouched) — a real path
    // is mandatory
    "keeper plan audit submit-task fn-1-x.2 --status mild --file -",
    // required options missing
    "keeper plan audit submit-task fn-1-x.2 --status mild",
    "keeper plan audit submit-task fn-1-x.2 --file /tmp/f.json",
    // out-of-enum status
    "keeper plan audit submit-task fn-1-x.2 --file /tmp/f.json --status bogus",
    // the epic-scoped submit (clobbers the close report) is never admitted
    "keeper plan audit submit fn-1-x --file /tmp/r.md --findings 0 --risk Low",
    // gate-check is the orchestrator's read, not the wrapped auditor's write
    "keeper plan audit gate-check fn-1-x.2",
    // stray extra positional / unknown option / forbidden --force
    "keeper plan audit submit-task fn-1-x.2 extra --file /tmp/f.json --status mild",
    "keeper plan audit submit-task fn-1-x.2 --file /tmp/f.json --status mild --force",
  ];
  for (const cmd of denyShapes) {
    test(`denies an out-of-shape audit command even for the auditor: ${cmd}`, () => {
      expect(evaluateWrappedBash(cmd, auditor)).not.toBeNull();
    });
  }

  test("the carve-out grants ONLY audit submit-task — other mutating verbs stay denied", () => {
    // a source-edit vector
    expect(
      evaluateWrappedBash("echo hacked > src/x.ts", auditor),
    ).not.toBeNull();
    // a plan mutation off the wrapped allowlist
    expect(
      evaluateWrappedBash("keeper plan claim fn-1-x.2", auditor),
    ).not.toBeNull();
    // an off-list keeper subcommand
    expect(
      evaluateWrappedBash("keeper dispatch work::fn-1-x.2", auditor),
    ).not.toBeNull();
  });

  test("the identical audit submit is denied for any other agent_type (wrapper / sibling / absent)", () => {
    const cmd =
      "keeper plan audit submit-task fn-1-x.2 --file /tmp/finding.json --status mild";
    // the wrapped courier itself
    expect(
      evaluateWrappedBash(cmd, { ...auditor, agentType: "work:worker" }),
    ).not.toBeNull();
    // a sibling escalation subagent
    expect(
      evaluateWrappedBash(cmd, { ...auditor, agentType: "plan:unblocker" }),
    ).not.toBeNull();
    // agent_type absent entirely (an agent_id-only courier)
    expect(
      evaluateWrappedBash(cmd, {
        taskId: "fn-1-x.2",
        envelopeReference: "$KEEPER_WRAPPED_ENVELOPE",
      }),
    ).not.toBeNull();
  });

  test("binds the submit to the launch-bound task id", () => {
    // a marked auditor for task A cannot submit/overwrite task B's finding
    const wrongTask = evaluateWrappedBash(
      "keeper plan audit submit-task fn-1-other.9 --file /tmp/finding.json --status mild",
      auditor,
    );
    expect(wrongTask).not.toBeNull();
    expect(wrongTask).toContain("launch-bound task");
    // absent launch-bound context → denied (no id to bind against)
    expect(
      evaluateWrappedBash(
        "keeper plan audit submit-task fn-1-x.2 --file /tmp/finding.json --status mild",
        { agentType: "plan:quality-auditor" },
      ),
    ).not.toBeNull();
    // a relative --file has no unambiguous absolute scratchpad path → denied
    expect(
      evaluateWrappedBash(
        "keeper plan audit submit-task fn-1-x.2 --file rel/finding.json --status mild",
        auditor,
      ),
    ).not.toBeNull();
  });

  test("denies a duplicate authority flag in either the split or glued form", () => {
    const dup = [
      // two --file (split), so parser precedence can't pick an unreasoned value
      "keeper plan audit submit-task fn-1-x.2 --file /tmp/a.json --file /tmp/b.json --status mild",
      // glued + split duplicate of --file
      "keeper plan audit submit-task fn-1-x.2 --file=/tmp/a.json --status mild --file /tmp/b.json",
      // duplicate --status
      "keeper plan audit submit-task fn-1-x.2 --file /tmp/a.json --status mild --status clean",
      // duplicate --project
      "keeper plan audit submit-task fn-1-x.2 --file /tmp/a.json --status mild --project /a --project /b",
    ];
    for (const cmd of dup) {
      expect(evaluateWrappedBash(cmd, auditor)).not.toBeNull();
    }
  });

  test("fails CLOSED when the file-class probe is not wired (absent probe → deny)", () => {
    // an otherwise-valid submit whose context omits auditFileProbe: the guard
    // cannot positively clear the file class, so it denies rather than allowing.
    const { auditFileProbe: _omit, ...noProbe } = auditor;
    expect(
      evaluateWrappedBash(
        "keeper plan audit submit-task fn-1-x.2 --file /tmp/finding.json --status mild",
        noProbe,
      ),
    ).not.toBeNull();
  });
});

describe("evaluateWrappedBash — observed launch shapes and static POSIX word reference", () => {
  const context = {
    taskId: "fn-1-x.2",
    envelopeReference: "$KEEPER_WRAPPED_ENVELOPE",
  };
  const observedContext = {
    taskId: "fn-1354-own-pi-skill-shorthands.2",
    envelopeReference: "$KEEPER_WRAPPED_ENVELOPE",
  };
  const contract = "/private/tmp/keeper-wrapped-249pt0/contract.md";
  const observedLaunches = [
    `keeper agent run pi 'You are implementing one task in the arthack repo. Work in place and run tests until green.' \\\n  --model openai-codex/gpt-5.6-sol --system-file ${contract} \\\n  --session wrapped --name fn-1354-own-pi-skill-shorthands.2 \\\n  --output "$KEEPER_WRAPPED_ENVELOPE" --stop-timeout 480000ms`,
    `keeper agent run pi 'Read the task brief and implement it in this repo.' \\\n  --resume 4ad8de58-52b3-4de9-b500-53a8a1941a44 \\\n  --session wrapped --name fn-1354-own-pi-skill-shorthands.2 \\\n  --output "$KEEPER_WRAPPED_ENVELOPE" --stop-timeout 480000ms`,
    `keeper agent run pi 'line one
line two
line three' --model openai-codex/gpt-5.6-sol --system-file ${contract} --session wrapped --name fn-1354-own-pi-skill-shorthands.2 --output "$KEEPER_WRAPPED_ENVELOPE" --stop-timeout 480000ms`,
  ];

  for (const command of observedLaunches) {
    test(`allows observed single-argv launch: ${JSON.stringify(command.slice(0, 80))}`, () => {
      expect(evaluateWrappedBash(command, observedContext)).toBeNull();
    });
  }

  const suffix =
    `--model gpt-5 --system-file ${contract} --session wrapped ` +
    `--name fn-1-x.2 --output "$KEEPER_WRAPPED_ENVELOPE" --stop-timeout 300s`;
  const reference: ReadonlyArray<{
    name: string;
    command: string;
    referenceInstructionArgv: readonly string[] | "non-POSIX";
    expected: "allow" | "deny";
  }> = [
    {
      name: "adjacent quote runs concatenate into one word",
      command: `keeper agent run codex "implement "'task' ${suffix}`,
      referenceInstructionArgv: ["implement task"],
      expected: "allow",
    },
    {
      name: "an empty quoted word is preserved",
      command: `keeper agent run codex "" ${suffix}`,
      referenceInstructionArgv: [""],
      expected: "deny",
    },
    {
      name: "a hash inside a word is literal",
      command: `keeper agent run codex "implement"#task ${suffix}`,
      referenceInstructionArgv: ["implement#task"],
      expected: "allow",
    },
    {
      name: "a comment begins only at a word boundary",
      command: `keeper agent run codex "implement task" ${suffix} # ignored by POSIX shells`,
      referenceInstructionArgv: ["implement task"],
      expected: "deny",
    },
    {
      name: "backslash-newline is removed before word recognition",
      command: `keeper agent run codex "implement task" \\\n  ${suffix}`,
      referenceInstructionArgv: ["implement task"],
      expected: "allow",
    },
    {
      name: "backslash-newline is removed inside double quotes",
      command: `keeper agent run codex "implement task" --model gpt-5 --system-file ${contract} --session wrapped --name "fn-1-x.\\
2" --output "$KEEPER_WRAPPED_ENVELOPE" --stop-timeout 300s`,
      referenceInstructionArgv: ["implement task"],
      expected: "allow",
    },
    {
      name: "ANSI-C quoting remains a conservative non-POSIX deny",
      command: `keeper agent run codex $'can\\'t retry' ${suffix}`,
      referenceInstructionArgv: "non-POSIX",
      expected: "deny",
    },
  ];

  for (const entry of reference) {
    test(`${entry.name}: ${JSON.stringify(entry.referenceInstructionArgv)}`, () => {
      const reason = evaluateWrappedBash(entry.command, context);
      if (entry.expected === "allow") expect(reason).toBeNull();
      else expect(reason).not.toBeNull();
    });
  }
});

describe("evaluateWrappedBash — actionable provider run-gate denials", () => {
  const context = {
    taskId: "fn-1-x.2",
    envelopeReference: "$KEEPER_WRAPPED_ENVELOPE",
  };
  const binding =
    '--session wrapped --name fn-1-x.2 --output "$KEEPER_WRAPPED_ENVELOPE" --stop-timeout 300s';
  const cases = [
    {
      construct: "provider harness",
      command: `keeper agent run claude "implement task" --model opus --system-file /tmp/contract.md ${binding}`,
    },
    {
      construct: "option-lookalike in instruction prose",
      command: `keeper agent run codex implement this --carefully --model gpt-5 --system-file /tmp/contract.md ${binding}`,
    },
    {
      construct: "duplicate boolean option",
      command: `keeper agent run codex "implement task" --model gpt-5 --system-file /tmp/contract.md ${binding} --reap-window-on-terminal --reap-window-on-terminal`,
    },
    {
      construct: "duplicate value option",
      command: `keeper agent run codex "implement task" --model gpt-5 --model gpt-5 --system-file /tmp/contract.md ${binding}`,
    },
    {
      construct: "missing option value",
      command: `keeper agent run codex "implement task" --model --system-file /tmp/contract.md ${binding}`,
    },
    {
      construct: "positional count",
      command: `keeper agent run codex --model gpt-5 --system-file /tmp/contract.md ${binding}`,
    },
    {
      construct: "quoting split",
      command: `keeper agent run codex implement task --model gpt-5 --system-file /tmp/contract.md ${binding}`,
    },
    {
      construct: "empty positional instruction",
      command: `keeper agent run codex "" --model gpt-5 --system-file /tmp/contract.md ${binding}`,
    },
    {
      construct: "launch-context binding",
      command:
        'keeper agent run codex "implement task" --model gpt-5 --system-file /tmp/contract.md --session other --name fn-1-x.2 --output "$KEEPER_WRAPPED_ENVELOPE" --stop-timeout 300s',
    },
    {
      construct: "missing --system-file",
      command: `keeper agent run codex "implement task" --model gpt-5 ${binding}`,
    },
    {
      construct: "model/preset option-count",
      command: `keeper agent run codex "implement task" --model gpt-5 --preset gpt-5::high --system-file /tmp/contract.md ${binding}`,
    },
  ];

  for (const row of cases) {
    test(`names and steers: ${row.construct}`, () => {
      const reason = evaluateWrappedBash(row.command, context);
      expect(reason).toContain(row.construct);
      expect(reason).toMatch(/expected positional count 1, received \d+/);
      expect(reason).toContain("first offending token ");
      expect(reason).toContain("Do not retry the same quoting");
      expect(reason).toContain(
        "single short, single-line double-quoted instruction",
      );
      expect(reason).toContain("--system-file");
    });
  }

  test("distinguishes option-lookalike prose from a quoting split", () => {
    const optionReason = evaluateWrappedBash(cases[1].command, context);
    const splitReason = evaluateWrappedBash(cases[6].command, context);
    expect(optionReason).toContain("option-lookalike in instruction prose");
    expect(optionReason).not.toContain("quoting split");
    expect(splitReason).toContain("quoting split");
    expect(splitReason).not.toContain("option-lookalike in instruction prose");
  });

  test("bounds and sanitizes the first offending token excerpt", () => {
    const offending = `${"x".repeat(96)}\n\t\u0000tail`;
    const reason = evaluateWrappedBash(
      `keeper agent run codex "implement task" "${offending}" --model gpt-5 --system-file /tmp/contract.md ${binding}`,
      context,
    );
    expect(reason).toContain("quoting split");
    expect(reason).toContain("[truncated]");
    expect(reason).not.toContain(offending);
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("\t");
    expect(reason).not.toContain("\u0000");
    expect((reason ?? "").length).toBeLessThan(500);
  });
});

describe("evaluateWrappedBash — CVE-2025-66032 shell-bypass corpus (deny vectors)", () => {
  // The blocklist-bypass class that must be rejected UP FRONT by the positive
  // allowlist: substitution, compound operators smuggling an off-list segment,
  // process substitution, and wrapper re-entry. Each MUST deny even though it may
  // begin with an allowlisted prefix.
  const corpus = [
    // command substitution (both forms), inside and outside quotes
    "keeper agent wait $(python3 -c 'x')",
    "keeper agent wait `whoami`",
    'keeper agent wait "$(rm -rf src)"',
    `keeper agent wait "$\\
(evil)"`,
    `keeper agent wait "$\\
\\
(evil)"`,
    // process substitution
    "diff <(git show a) <(git show b)",
    // compound where a LATER segment is the bypass (allowlisted prefix + off-list)
    "keeper session state && python3 -c 'x'",
    "git status; cp /tmp/evil src/x.ts",
    "git log --oneline | sh",
    "keeper plan cat fn-1 || echo x > src/y.ts",
    // background operator smuggling a second command
    "keeper agent wait leg & rm -rf src",
    // env-runner + interpreter, the exact observed drift shape
    "env sh -c 'edit src'",
    // a redirect appended after a legit close-out command
    "keeper commit-work 'x' > /tmp/out",
  ];
  for (const cmd of corpus) {
    test(`denies bypass: ${cmd}`, () => {
      expect(evaluateWrappedBash(cmd)).not.toBeNull();
    });
  }
});

test("evaluateWrappedBash: the deny reason NAMES the offending construct / command", () => {
  expect(evaluateWrappedBash("echo x > src/y.ts")).toContain("redirect");
  expect(evaluateWrappedBash("cat <<EOF")).toContain("heredoc");
  expect(evaluateWrappedBash("keeper agent wait `x`")).toContain(
    "substitution",
  );
  expect(evaluateWrappedBash("python3 -c 'x'")).toContain("python3");
  expect(evaluateWrappedBash("git push")).toContain("push");
  expect(evaluateWrappedBash("keeper prompt render")).toContain("allowlist");
});

// ---------------------------------------------------------------------------
// Tier 2 — decideWrappedGuard jurisdiction ladder
// ---------------------------------------------------------------------------

const REPO = "/w/repo";
const OUTSIDE = join(tmpdir(), "keeper-wrapped-test"); // inert scratch root

/** A virtual repo layout: identity realpath (a sentinel resolves to null), and a
 *  longest-prefix `.git`-toplevel over the single tracked repo root. */
function fakeProbe(opts?: {
  unresolvable?: string[];
  auditSubmitFile?: (abs: string) => boolean;
}): TreeProbe {
  const unresolvable = new Set(opts?.unresolvable ?? []);
  return {
    realpath: (abs) => (unresolvable.has(abs) ? null : abs),
    repoToplevel: (resolved) =>
      resolved === REPO || resolved.startsWith(`${REPO}/`) ? REPO : null,
    scratchFileSafe: () => true,
    auditSubmitFile: opts?.auditSubmitFile ?? (() => true),
  };
}

// The marker is the effective wrapped `<model>::<effort>`; any non-empty value marks.
const MARKED = {
  KEEPER_WRAPPED_CELL: "gpt-5::high",
  KEEPER_WRAPPED_ENVELOPE:
    "/repo/.keeper/state/wrapped-envelopes/fn-1-x.2.json",
};

function bashPayload(
  command: string,
  extra: Record<string, unknown> = {},
): WrappedGuardPayload {
  return {
    tool_name: "Bash",
    agent_id: "agent-7",
    cwd: REPO,
    tool_input: { command },
    ...extra,
  } as WrappedGuardPayload;
}
function writePayload(
  file: string,
  extra: Record<string, unknown> = {},
): WrappedGuardPayload {
  return {
    tool_name: "Write",
    agent_id: "agent-7",
    cwd: REPO,
    tool_input: { file_path: file },
    ...extra,
  } as WrappedGuardPayload;
}
function editPayload(
  tool: string,
  file: string,
  extra: Record<string, unknown> = {},
): WrappedGuardPayload {
  return {
    tool_name: tool,
    agent_id: "agent-7",
    cwd: REPO,
    tool_input: { file_path: file },
    ...extra,
  } as WrappedGuardPayload;
}

function decide(
  payload: unknown,
  env: Record<string, string | undefined> = MARKED,
) {
  return decideWrappedGuard(payload, env, fakeProbe());
}

describe("decideWrappedGuard — bounded bus chat send", () => {
  const busDenyReason =
    "Wrapped-cell worker BLOCKED: this Bash command is off the delegation + " +
    "close-out allowlist: wrapped `keeper bus` permits only `keeper bus chat " +
    "send <target> <message>`. Permitted: `keeper agent` (run/--resume/wait/" +
    "wait-for-stop/show-last-message/providers), `keeper commit-work`, " +
    "task-bound `keeper plan done`/AUDIT_READY `block` + bounded reads, " +
    "`keeper session state`, and the read-only git surface (log / status / diff / " +
    "show / rev-parse). Repository-defined tests/scripts execute only inside the " +
    "provider leg. Every source-editing vector — redirects, heredocs, tee, sed -i, " +
    "patch, cp/mv/tar, git apply/am, interpreters, and re-entrant shells — is denied.";
  const cases: Array<{ command: string; expectedReason: string | null }> = [
    {
      command:
        'keeper bus chat send work::fn-1-claimant.3 "please release the contested paths after commit-work refusal"',
      expectedReason: null,
    },
    {
      command: "keeper bus watch work::fn-1-x.2",
      expectedReason: busDenyReason,
    },
    { command: "keeper bus list", expectedReason: busDenyReason },
    {
      command: "keeper bus chat send work::fn-1-claimant.3",
      expectedReason: busDenyReason,
    },
    {
      command:
        'keeper bus chat send work::fn-1-claimant.3 "please release" extra',
      expectedReason: busDenyReason,
    },
    {
      command: "keeper bus chat receive work::fn-1-claimant.3 message",
      expectedReason: busDenyReason,
    },
  ];

  for (const { command, expectedReason } of cases) {
    test(`${expectedReason === null ? "allows" : "denies"}: ${command}`, () => {
      const decision = decide(bashPayload(command));
      if (expectedReason === null) {
        expect(decision).toBeNull();
      } else {
        expect(decision).toEqual({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: expectedReason,
          },
        });
      }
    });
  }
});

describe("decideWrappedGuard — quality-auditor audit-submit carve-out (full marked flow)", () => {
  // The full wrapped max → AUDIT_READY → auditor-submit path at the decision seam:
  // under the wrapped marker, the static auditor subagent (agent_type set by the
  // harness) persists its findings; the wrapper and every sibling stay denied.
  const submit =
    "keeper plan audit submit-task fn-1-x.2 --file /private/tmp/claude-501/x/finding.json --status mild";

  test("allows the marked quality-auditor's per-task submit (--file path form)", () => {
    expect(
      decide(bashPayload(submit, { agent_type: "plan:quality-auditor" })),
    ).toBeNull();
  });

  test("still denies a NON-audit mutating verb for the marked quality-auditor", () => {
    const decision = decide(
      bashPayload("echo hacked > src/x.ts", {
        agent_type: "plan:quality-auditor",
      }),
    );
    expect(decision).not.toBeNull();
    expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("denies the identical submit for the wrapped courier and every other marked subagent", () => {
    expect(
      decide(bashPayload(submit, { agent_type: "work:worker" })),
    ).not.toBeNull();
    expect(
      decide(bashPayload(submit, { agent_type: "repairer" })),
    ).not.toBeNull();
    // an agent_id-only courier: jurisdiction fires (marked + agent_id) but with no
    // agent_type the carve-out never applies.
    expect(decide(bashPayload(submit))).not.toBeNull();
  });

  test("denies the stdin+heredoc submit shape even for the marked auditor (lexer untouched)", () => {
    const heredoc =
      "keeper plan audit submit-task fn-1-x.2 --status mild --file - <<'FINDING_EOF'\n{}\nFINDING_EOF";
    expect(
      decide(bashPayload(heredoc, { agent_type: "plan:quality-auditor" })),
    ).not.toBeNull();
  });

  test("stays inert for an UNMARKED auditor payload — a native close-audit is never blocked", () => {
    expect(
      decideWrappedGuard(
        bashPayload(submit, { agent_type: "plan:quality-auditor" }),
        {},
        fakeProbe(),
      ),
    ).toBeNull();
  });

  // The Write path the auditor composes its findings file through is the existing
  // carve-out: an inert out-of-tree scratch .json is allowed (materialized as the
  // descriptor-bound atomic handoff in production), an in-tree write is denied —
  // and those semantics hold for this agent_type exactly as for any marked cell.
  test("ALLOWS the auditor's inert out-of-tree scratch .json Write (the findings file)", () => {
    expect(
      decide(
        writePayload(`${OUTSIDE}/finding.json`, {
          agent_type: "plan:quality-auditor",
        }),
      ),
    ).toBeNull();
  });

  test("DENIES the auditor's in-tree Write — the audit carve-out grants no source-write path", () => {
    const decision = decide(
      writePayload(`${REPO}/src/x.ts`, { agent_type: "plan:quality-auditor" }),
    );
    expect(decision).not.toBeNull();
    expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("DENIES the auditor's out-of-tree NON-.json scratch Write (.txt/.md are not the findings class)", () => {
    const txt = decide(
      writePayload(`${OUTSIDE}/finding.txt`, {
        agent_type: "plan:quality-auditor",
      }),
    );
    expect(txt).not.toBeNull();
    expect(txt?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("the courier's broader out-of-tree .txt/.md handoff class is UNCHANGED (the .json narrowing is auditor-only)", () => {
    expect(decide(writePayload(`${OUTSIDE}/contract.md`))).toBeNull();
    expect(
      decide(
        writePayload(`${OUTSIDE}/handoff.txt`, { agent_type: "work:worker" }),
      ),
    ).toBeNull();
  });
});

describe("auditSubmitFileSafe — submit --file must be an existing private-scratch .json", () => {
  // Real fs, sandboxed under a per-test mkdtemp (mode 0700 → owner-private).
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kw-audit-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("accepts an existing regular .json under an owner-private temp parent", () => {
    const f = join(dir, "finding.json");
    writeFileSync(f, "{}", { mode: 0o600 });
    expect(auditSubmitFileSafe(f)).toBe(true);
  });

  test("rejects a non-existent path", () => {
    expect(auditSubmitFileSafe(join(dir, "ghost.json"))).toBe(false);
  });

  test("rejects a symlink at the leaf (lstat, never followed)", () => {
    const real = join(dir, "real.json");
    writeFileSync(real, "{}");
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    expect(auditSubmitFileSafe(link)).toBe(false);
  });

  test("rejects a non-.json file", () => {
    const f = join(dir, "finding.txt");
    writeFileSync(f, "{}");
    expect(auditSubmitFileSafe(f)).toBe(false);
  });

  test("rejects a group/other-accessible (non-owner-private) parent", () => {
    chmodSync(dir, 0o755);
    const f = join(dir, "finding.json");
    writeFileSync(f, "{}");
    expect(auditSubmitFileSafe(f)).toBe(false);
  });
});

describe("decideWrappedGuard — auditor submit --file class (real fs, production probe)", () => {
  const env = {
    KEEPER_WRAPPED_CELL: "gpt-5::high",
    KEEPER_WRAPPED_ENVELOPE:
      "/repo/.keeper/state/wrapped-envelopes/fn-1-x.2.json",
  };
  const auditorBash = (command: string) =>
    ({
      tool_name: "Bash",
      agent_type: "plan:quality-auditor",
      cwd: REPO,
      tool_input: { command },
    }) as WrappedGuardPayload;

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kw-audit-decide-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("FLOW: writeAtomicWrappedHandoff creates the leaf → auditSubmitFileSafe accepts it → submit is admitted", () => {
    // The whole procedure through the PRODUCTION creation path (never a
    // writeFileSync fabrication): the guard's atomic handoff materializes the
    // descriptor-bound .json, the class probe clears it, and the submit lands.
    const leaf = join(dir, "finding.json");
    expect(writeAtomicWrappedHandoff(leaf, '{"findings":[]}', REPO)).toBe(true);
    expect(auditSubmitFileSafe(leaf)).toBe(true);
    expect(
      decideWrappedGuard(
        auditorBash(
          `keeper plan audit submit-task fn-1-x.2 --file ${leaf} --status mild`,
        ),
        env,
        fsProbe(),
      ),
    ).toBeNull();
  });

  test("DENIES the submit when --file is a symlink or missing", () => {
    const real = join(dir, "real.json");
    writeFileSync(real, "{}");
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    for (const path of [link, join(dir, "ghost.json")]) {
      expect(
        decideWrappedGuard(
          auditorBash(
            `keeper plan audit submit-task fn-1-x.2 --file ${path} --status mild`,
          ),
          env,
          fsProbe(),
        ),
      ).not.toBeNull();
    }
  });

  test("DENIES the submit when the file-class probe rejects --file (e.g. outside the private scratchpad)", () => {
    expect(
      decideWrappedGuard(
        auditorBash(
          "keeper plan audit submit-task fn-1-x.2 --file /tmp/finding.json --status mild",
        ),
        env,
        fakeProbe({ auditSubmitFile: () => false }),
      ),
    ).not.toBeNull();
  });
});

describe("decideWrappedGuard — jurisdiction ladder", () => {
  test("inert (null) when unmarked — a human / native worker is never blocked", () => {
    expect(decide(editPayload("Edit", `${REPO}/src/x.ts`), {})).toBeNull();
    expect(decide(bashPayload("python3 -c 'x'"), {})).toBeNull();
  });

  test("an empty / whitespace marker counts as absent → inert", () => {
    expect(
      decide(editPayload("Edit", `${REPO}/src/x.ts`), {
        KEEPER_WRAPPED_CELL: "",
      }),
    ).toBeNull();
    expect(
      decide(editPayload("Edit", `${REPO}/src/x.ts`), {
        KEEPER_WRAPPED_CELL: "   ",
      }),
    ).toBeNull();
  });

  test("inert when marked but the payload lacks agent_id/agent_type (the wrapper's orchestrator)", () => {
    const orchestratorEdit = {
      tool_name: "Edit",
      cwd: REPO,
      tool_input: { file_path: `${REPO}/src/x.ts` },
    };
    expect(decide(orchestratorEdit)).toBeNull();
    const orchestratorBash = {
      tool_name: "Bash",
      cwd: REPO,
      tool_input: { command: "python3 -c 'x'" },
    };
    expect(decide(orchestratorBash)).toBeNull();
  });

  test("fires for a subagent keyed by agent_type alone (no agent_id)", () => {
    const p = {
      tool_name: "Edit",
      agent_type: "work:worker",
      cwd: REPO,
      tool_input: { file_path: `${REPO}/src/x.ts` },
    };
    expect(decide(p)).not.toBeNull();
  });
});

describe("decideWrappedGuard — total edit-denial for a marked subagent", () => {
  for (const tool of ["Edit", "MultiEdit", "NotebookEdit"]) {
    test(`denies ${tool} outright (in-tree), deny-envelope shape`, () => {
      const d = decide(editPayload(tool, `${REPO}/src/x.ts`));
      expect(d).not.toBeNull();
      expect(d?.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(d?.hookSpecificOutput.permissionDecisionReason).toContain(tool);
    });

    test(`denies ${tool} even for a path OUTSIDE the tree — the out-of-tree allowance is Write's alone`, () => {
      expect(
        decide(editPayload(tool, `${OUTSIDE}/contract.md`)),
      ).not.toBeNull();
    });
  }

  test("denies a Write INSIDE the tracked tree", () => {
    const d = decide(writePayload(`${REPO}/src/x.ts`));
    expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(d?.hookSpecificOutput.permissionDecisionReason).toContain("tracked");
  });

  test("ALLOWS a Write OUTSIDE every tracked tree (the scratchpad contract file)", () => {
    expect(decide(writePayload(`${OUTSIDE}/contract.md`))).toBeNull();
  });

  test("denies out-of-tree writes outside inert system-temp handoff files", () => {
    expect(
      decide(writePayload("/w/scratch/contract.md"))?.hookSpecificOutput
        .permissionDecision,
    ).toBe("deny");
    expect(
      decide(writePayload(`${OUTSIDE}/gen.ts`))?.hookSpecificOutput
        .permissionDecision,
    ).toBe("deny");
  });

  test("rejects a hard-linked scratch handoff target", () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-wrapped-hardlink-"));
    try {
      const repo = join(root, "repo");
      const scratch = join(root, "handoff.json");
      mkdirSync(join(repo, ".git"), { recursive: true });
      const tracked = join(repo, "package.json");
      writeFileSync(tracked, "{}\n");
      linkSync(tracked, scratch);
      const denied = decideWrappedGuard(
        {
          tool_name: "Write",
          agent_id: "agent-7",
          cwd: repo,
          tool_input: { file_path: scratch },
        },
        MARKED,
        fsProbe(),
      );
      expect(denied?.hookSpecificOutput.permissionDecision).toBe("deny");

      rmSync(scratch);
      expect(
        decideWrappedGuard(
          {
            tool_name: "Write",
            agent_id: "agent-7",
            cwd: repo,
            tool_input: { file_path: scratch },
          },
          MARKED,
          fsProbe(),
        ),
      ).toBeNull();

      writeFileSync(scratch, "{}\n", { mode: 0o600 });
      expect(
        decideWrappedGuard(
          {
            tool_name: "Write",
            agent_id: "agent-7",
            cwd: repo,
            tool_input: { file_path: scratch },
          },
          MARKED,
          fsProbe(),
        )?.hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ALLOWS a handoff Write into a /private/tmp keeper-wrapped dir (temp-root reconciliation)", () => {
    if (process.platform !== "darwin") return;
    const root = mkdtempSync(join("/private/tmp", "keeper-wrapped-privtmp-"));
    try {
      // a wrapped worker's handoff dir may sit under /private/tmp (not the
      // launchd tmpdir); the inert .json write into it is allowed
      expect(
        decideWrappedGuard(
          {
            tool_name: "Write",
            agent_id: "agent-7",
            cwd: root,
            tool_input: { file_path: join(root, "handoff.json") },
          },
          MARKED,
          fsProbe(),
        ),
      ).toBeNull();
      // ...but a non-inert (executable-shaped) extension in the same dir is still denied
      expect(
        decideWrappedGuard(
          {
            tool_name: "Write",
            agent_id: "agent-7",
            cwd: root,
            tool_input: { file_path: join(root, "gen.ts") },
          },
          MARKED,
          fsProbe(),
        )?.hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("atomic handoff creation is exclusive and never follows a hardlink", () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-wrapped-atomic-"));
    try {
      const handoff = join(root, "manifest.json");
      expect(writeAtomicWrappedHandoff(handoff, '{"ok":true}\n', root)).toBe(
        true,
      );
      expect(readFileSync(handoff, "utf8")).toBe('{"ok":true}\n');
      expect(writeAtomicWrappedHandoff(handoff, "replacement\n", root)).toBe(
        false,
      );
      expect(readFileSync(handoff, "utf8")).toBe('{"ok":true}\n');

      const source = join(root, "source.txt");
      const alias = join(root, "message.txt");
      writeFileSync(source, "caller-owned\n");
      linkSync(source, alias);
      expect(writeAtomicWrappedHandoff(alias, "attacker\n", root)).toBe(false);
      expect(readFileSync(source, "utf8")).toBe("caller-owned\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("contains an out-of-tree Write followed by bun run of that file", () => {
    const generated = `${OUTSIDE}/contract.json`;
    expect(decide(writePayload(generated))).toBeNull();
    expect(
      decide(bashPayload(`bun run ${generated}`))?.hookSpecificOutput
        .permissionDecision,
    ).toBe("deny");
  });

  test("denies every in-tree Bash write vector for a marked subagent", () => {
    for (const cmd of [
      "echo x > src/x.ts",
      "cat <<EOF > src/x.ts",
      "cat a | tee src/x.ts",
      "sed -i 's/a/b/' src/x.ts",
      "git apply /tmp/p.diff",
      "git am /tmp/p.mbox",
      "patch -p1 < /tmp/p.diff",
      "cp /tmp/evil src/x.ts",
      "mv /tmp/evil src/x.ts",
      "tar -x -f /tmp/p.tar",
    ]) {
      expect(
        decide(bashPayload(cmd))?.hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    }
  });

  test("permits the delegation + close-out Bash surface for a marked subagent", () => {
    for (const cmd of [
      "keeper agent run codex 'go' --preset gpt-5::high --system-file /tmp/contract.md --session wrapped --name fn-1-x.2 --output \"$KEEPER_WRAPPED_ENVELOPE\" --stop-timeout 300s",
      "keeper agent run codex 'fix lint' --resume leg --session wrapped --name fn-1-x.2 --output \"$KEEPER_WRAPPED_ENVELOPE\" --stop-timeout 300s",
      "keeper agent wait leg",
      "keeper commit-work --task-id fn-1-x.2 'feat(x): y'",
      "keeper plan done fn-1-x.2 --summary 'done'",
      "keeper session state",
      "git -c core.fsmonitor=false -c core.pager=cat --no-pager status",
    ]) {
      expect(decide(bashPayload(cmd))).toBeNull();
    }
  });
});

describe("decideWrappedGuard — fail-closed discipline", () => {
  test("deny on parse ambiguity (an unterminated quote) for a marked subagent", () => {
    expect(
      decide(bashPayload("keeper agent wait 'leg"))?.hookSpecificOutput
        .permissionDecision,
    ).toBe("deny");
  });

  test("a non-object payload denies for a marked session, allows (silent) for an unmarked one", () => {
    expect(decide(null)?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decideWrappedGuard(null, {}, fakeProbe())).toBeNull();
  });

  test("a Bash payload missing its command string is malformed → fail closed", () => {
    const p = { tool_name: "Bash", agent_id: "a", tool_input: {} };
    expect(decide(p)?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("a Write payload missing its file_path is malformed → fail closed", () => {
    const p = { tool_name: "Write", agent_id: "a", tool_input: {} };
    expect(decide(p)?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("an unresolvable Write target fails closed (deny)", () => {
    const target = `${OUTSIDE}/ghost`;
    const d = decideWrappedGuard(
      writePayload(target),
      MARKED,
      fakeProbe({ unresolvable: [target] }),
    );
    expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("an unrecognized tool on the guarded matcher fails closed for a marked subagent", () => {
    const p = {
      tool_name: "SomeFutureWriteTool",
      agent_id: "a",
      tool_input: { file_path: `${REPO}/x` },
    };
    expect(decide(p)?.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("decideWrappedGuard — deny-precedence / single-state intent", () => {
  // The guard is a single-state total edit-denial: an edit is denied REGARDLESS of
  // any sibling allow signal — there is no phase gate and no result-envelope
  // unlock, so no extra env or payload field flips a deny to an allow.
  test("an Edit deny is invariant to arbitrary extra env (no envelope / phase unlock)", () => {
    const base = decide(editPayload("Edit", `${REPO}/src/x.ts`));
    expect(base?.hookSpecificOutput.permissionDecision).toBe("deny");
    for (const extraEnv of [
      { KEEPER_WRAPPED_ENVELOPE: "/tmp/leg-result.json" },
      { KEEPER_WRAPPED_GUARD_PHASE: "closeout" },
    ]) {
      const d = decideWrappedGuard(
        editPayload("Edit", `${REPO}/src/x.ts`),
        { ...MARKED, ...extraEnv },
        fakeProbe(),
      );
      expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  test("an Edit deny is invariant to a leg-result field on the payload", () => {
    const d = decide(
      editPayload("Edit", `${REPO}/src/x.ts`, {
        tool_input: {
          file_path: `${REPO}/src/x.ts`,
          leg_result: "ok",
        },
      }),
    );
    expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Grant override — a validly-granted escalation subagent (a different agent_type
// than the wrapped work:worker) is exempted from the total edit-denial without
// weakening the default posture.
// ---------------------------------------------------------------------------

describe("decideWrappedGuard — escalation grant override", () => {
  const grantAll: (t: string) => boolean = () => true;
  const grantNone: (t: string) => boolean = () => false;

  test("a covered Edit is allowed under the grant override", () => {
    expect(
      decideWrappedGuard(
        editPayload("Edit", `${REPO}/src/x.ts`),
        MARKED,
        fakeProbe(),
        undefined,
        grantAll,
      ),
    ).toBeNull();
  });

  test("a covered in-tree Write is allowed under the grant override", () => {
    expect(
      decideWrappedGuard(
        writePayload(`${REPO}/src/x.ts`),
        MARKED,
        fakeProbe(),
        undefined,
        grantAll,
      ),
    ).toBeNull();
  });

  test("without the override, Edit and in-tree Write still deny (posture preserved)", () => {
    expect(
      decideWrappedGuard(
        editPayload("Edit", `${REPO}/src/x.ts`),
        MARKED,
        fakeProbe(),
        undefined,
        grantNone,
      )?.hookSpecificOutput.permissionDecision,
    ).toBe("deny");
    expect(
      decideWrappedGuard(
        writePayload(`${REPO}/src/x.ts`),
        MARKED,
        fakeProbe(),
        undefined,
        grantNone,
      )?.hookSpecificOutput.permissionDecision,
    ).toBe("deny");
    // The default (no override argument) matches the grant-none posture.
    expect(
      decide(editPayload("Edit", `${REPO}/src/x.ts`))?.hookSpecificOutput
        .permissionDecision,
    ).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Synthetic-leaf grant matrix — the PRODUCTION override (`grantCoversWrite` over
// a real owner-private leaf) lifting the total-edit denial for a validly-granted
// escalation subagent, and the wrapped courier staying fully denied even when a
// SIBLING escalation agent holds a grant.
// ---------------------------------------------------------------------------

describe("decideWrappedGuard — grant leaf override (synthetic leafs)", () => {
  function makeGrant(over: Partial<GrantLeaf> = {}): GrantLeaf {
    return {
      schema_version: 1,
      parent_job_id: "job-1",
      agent_type: "repairer",
      incident_id: "repair::keeper",
      attempt_id: "att-1",
      instance_event_id: 42,
      writable_root: REPO,
      role: "repair",
      expires_at: 10_000,
      fencing_token: 7,
      ...over,
    };
  }

  function grantEnv(dir: string): Record<string, string | undefined> {
    return {
      ...MARKED,
      KEEPER_GRANT_DIR: dir,
      KEEPER_GRANT_PARENT_JOB: "job-1",
      KEEPER_GRANT_INCIDENT: "repair::keeper",
      KEEPER_GRANT_FENCING_TOKEN: "7",
    };
  }

  // The production override closure — the payload's agent_type + env + now through
  // grantCoversWrite over the real leaf, exactly as main() wires it.
  function overrideFor(
    agentType: string | undefined,
    env: Record<string, string | undefined>,
    now: number,
  ): (canonicalTarget: string) => boolean {
    return (canonicalTarget) =>
      grantCoversWrite(env, agentType, canonicalTarget, now);
  }

  test("a granted repairer's in-tree Edit is allowed (denial lifted)", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      writeGrantLeaf(dir, makeGrant());
      const env = grantEnv(dir);
      expect(
        decideWrappedGuard(
          editPayload("Edit", `${REPO}/src/x.ts`, { agent_type: "repairer" }),
          env,
          fakeProbe(),
          undefined,
          overrideFor("repairer", env, 5_000),
        ),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a granted repairer's in-tree Write is allowed (denial lifted)", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      writeGrantLeaf(dir, makeGrant());
      const env = grantEnv(dir);
      expect(
        decideWrappedGuard(
          writePayload(`${REPO}/src/x.ts`, { agent_type: "repairer" }),
          env,
          fakeProbe(),
          undefined,
          overrideFor("repairer", env, 5_000),
        ),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a write outside the granted root still denies", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      writeGrantLeaf(dir, makeGrant({ writable_root: "/w/elsewhere" }));
      const env = grantEnv(dir);
      expect(
        decideWrappedGuard(
          editPayload("Edit", `${REPO}/src/x.ts`, { agent_type: "repairer" }),
          env,
          fakeProbe(),
          undefined,
          overrideFor("repairer", env, 5_000),
        )?.hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an expired grant does not lift the denial", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      writeGrantLeaf(dir, makeGrant({ expires_at: 1_000 }));
      const env = grantEnv(dir);
      expect(
        decideWrappedGuard(
          editPayload("Edit", `${REPO}/src/x.ts`, { agent_type: "repairer" }),
          env,
          fakeProbe(),
          undefined,
          overrideFor("repairer", env, 5_000), // now past expiry
        )?.hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the wrapped courier stays edit-denied even when a SIBLING holds a grant", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      writeGrantLeaf(dir, makeGrant()); // a valid repairer grant sits on disk
      const env = grantEnv(dir);
      // The courier is the wrapped work:worker — grantCoversWrite is false for any
      // non-escalation agent_type, so the total-edit denial stands.
      expect(
        decideWrappedGuard(
          editPayload("Edit", `${REPO}/src/x.ts`, {
            agent_type: "work:worker",
          }),
          env,
          fakeProbe(),
          undefined,
          overrideFor("work:worker", env, 5_000),
        )?.hookSpecificOutput.permissionDecision,
      ).toBe("deny");
      // The classic courier carries no agent_type at all — still denied.
      expect(
        decideWrappedGuard(
          editPayload("Edit", `${REPO}/src/x.ts`),
          env,
          fakeProbe(),
          undefined,
          overrideFor(undefined, env, 5_000),
        )?.hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SendMessage total denial — a wrapped subagent's message escalation is never
// read under the dumb-courier wrapper and silently hangs the worker, so it is
// denied for EVERY target with a constant, payload-free envelope that no grant
// lifts. Unmarked sessions and identity-less marked calls (the /plan:work
// orchestrator's own warm-resume SendMessage) stay byte-inert.
// ---------------------------------------------------------------------------

function sendMessagePayload(
  extra: Record<string, unknown> = {},
  input: Record<string, unknown> = { to: "team-lead", message: "please help" },
): WrappedGuardPayload {
  return {
    tool_name: "SendMessage",
    agent_id: "agent-7",
    cwd: REPO,
    tool_input: input,
    ...extra,
  } as WrappedGuardPayload;
}

describe("decideWrappedGuard — SendMessage total denial", () => {
  test("a marked subagent's SendMessage is denied with the park-BLOCKED envelope", () => {
    const d = decide(sendMessagePayload());
    expect(d).not.toBeNull();
    expect(d?.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = d?.hookSpecificOutput.permissionDecisionReason ?? "";
    // states the whole contract: do not retry, do not message again, hand up typed
    expect(reason).toContain("SendMessage tool is denied");
    expect(reason).toContain("Do not retry");
    expect(reason).toContain("do not send another message");
    expect(reason).toContain(
      "RETURNING the fitting typed category to the parent",
    );
    // uses the wrapped partial's existing typed-status vocabulary verbatim
    expect(reason).toContain("BLOCKED: EXTERNAL_BLOCKED");
    expect(reason).toContain("TOOLING_FAILURE");
    expect(reason).toContain("DEPENDENCY_BLOCKED");
    expect(reason).toContain("SHARED_BASE_BROKEN");
  });

  test("the denial reason is CONSTANT and bounded — zero payload interpolation", () => {
    const a = decide(
      sendMessagePayload({}, { to: "team-lead", message: "help A" }),
    );
    const b = decide(
      sendMessagePayload(
        { agent_id: "other-agent" },
        { to: "someone-else", message: '"quoted" & injected ${x}' },
      ),
    );
    const ra = a?.hookSpecificOutput.permissionDecisionReason ?? "";
    const rb = b?.hookSpecificOutput.permissionDecisionReason ?? "";
    // identical across different targets/messages/identities → no interpolation
    expect(ra).toBe(rb);
    // and none of the (attacker-influenced) payload bytes leak into the reason
    expect(ra).not.toContain("injected");
    expect(ra).not.toContain("someone-else");
    // bounded, not payload-scaled
    expect(ra.length).toBeLessThan(800);
  });

  test("either identity anchor fires: agent_id-only AND agent_type-only both deny when marked", () => {
    // agent_id present, agent_type absent
    expect(
      decide({
        tool_name: "SendMessage",
        agent_id: "agent-7",
        cwd: REPO,
        tool_input: { to: "lead", message: "x" },
      })?.hookSpecificOutput.permissionDecision,
    ).toBe("deny");
    // agent_type present, agent_id absent
    expect(
      decide({
        tool_name: "SendMessage",
        agent_type: "work:worker",
        cwd: REPO,
        tool_input: { to: "lead", message: "x" },
      })?.hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  test("unmarked session + SendMessage stays inert (no output)", () => {
    expect(decide(sendMessagePayload(), {})).toBeNull();
    // a whitespace-only marker counts as absent → inert
    expect(
      decide(sendMessagePayload(), { KEEPER_WRAPPED_CELL: "   " }),
    ).toBeNull();
  });

  test("marked but identity-less top-level SendMessage stays inert (the /plan:work orchestrator's warm-resume)", () => {
    // work.md.tmpl Phase 2b sends SendMessage from the marked-env top-level context
    // with NO subagent identity — that warm-resume path must survive byte-inert.
    const orchestrator = {
      tool_name: "SendMessage",
      cwd: REPO,
      tool_input: { to: "worker-agent-id", message: "finish implementation" },
    };
    expect(decide(orchestrator)).toBeNull();
  });

  test("no grant lifts the SendMessage denial (the arm returns before any grant/override path)", () => {
    const grantAll: (t: string) => boolean = () => true;
    expect(
      decideWrappedGuard(
        sendMessagePayload({ agent_type: "repairer" }),
        MARKED,
        fakeProbe(),
        undefined,
        grantAll,
      )?.hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });
});

describe("wrapped-guard hooks.json matcher routes SendMessage", () => {
  // Production-shaped: the pure decision denies (above) AND the sole hooks.json
  // actually routes a SendMessage PreToolUse to this shim — a pure test whose
  // matcher never routed would be a silent no-op in production.
  test("the sole hooks.json registers wrapped-guard on a PreToolUse matcher that routes SendMessage", () => {
    const hooksPath = join(
      import.meta.dir,
      "..",
      "plugins",
      "keeper",
      "hooks",
      "hooks.json",
    );
    const data = JSON.parse(readFileSync(hooksPath, "utf-8")) as {
      hooks: {
        PreToolUse?: Array<{
          matcher?: string;
          hooks: Array<{ command?: string }>;
        }>;
      };
    };
    const wrappedMatchers = (data.hooks.PreToolUse ?? [])
      .filter((e) =>
        e.hooks.some((h) => (h.command ?? "").includes("wrapped-guard.ts")),
      )
      .map((e) => e.matcher ?? "");
    expect(wrappedMatchers.length).toBeGreaterThan(0);
    // at least one wrapped-guard matcher, treated as a regex, routes SendMessage
    expect(wrappedMatchers.some((m) => new RegExp(m).test("SendMessage"))).toBe(
      true,
    );
    // and SendMessage is a real alternation member, not a substring accident
    expect(
      wrappedMatchers.some((m) => m.split("|").includes("SendMessage")),
    ).toBe(true);
    // the Bash matcher must NOT accidentally route SendMessage
    expect(new RegExp("Bash").test("SendMessage")).toBe(false);
  });
});
