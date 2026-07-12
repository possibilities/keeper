// Unit tests for plugins/keeper/plugin/hooks/wrapped-guard.ts.
//
// Two pure in-process layers (no subprocess / real fs / daemon): (1) the Bash
// delegation + close-out allowlist truth table over `evaluateWrappedBash` — the
// load-bearing predicate, covering the permitted leg-launch + close-out surface,
// the denied source-editing vectors, the re-entrant wrappers, and the documented
// CVE-2025-66032 shell-bypass corpus as deny vectors; (2) the `decideWrappedGuard`
// decision ladder — the two-condition jurisdiction (marker non-empty AND subagent
// agent_id), the total edit-denial (Edit/MultiEdit/NotebookEdit + in-tree Write),
// the out-of-tree Write allowance, the fail-closed-when-marked / inert-otherwise
// inversion, the parse-ambiguity fail-closed, and the deny-precedence / single-
// state intent. The Write tree check runs against an injected fake TreeProbe over
// a virtual repo layout.

import { describe, expect, test } from "bun:test";

import {
  decideWrappedGuard,
  evaluateWrappedBash,
  type TreeProbe,
  type WrappedGuardPayload,
} from "../plugins/keeper/plugin/hooks/wrapped-guard.ts";

// ---------------------------------------------------------------------------
// Tier 1 — evaluateWrappedBash truth table
// ---------------------------------------------------------------------------

describe("evaluateWrappedBash — the delegation + close-out allowlist", () => {
  const allow = [
    // delegation surface: the blocking leg launch + resume + wait + read (no shell
    // operators — a clean `keeper agent run` is the whole point of the courier)
    "keeper agent run codex --preset gpt-5::high 'implement task'",
    "keeper agent run --resume leg-fn-1-x.2 'address the lint failure'",
    "keeper agent wait leg-fn-1-x.2",
    "keeper agent wait-for-stop leg-fn-1-x.2",
    "keeper agent show-last-message leg-fn-1-x.2",
    "keeper agent providers resolve gpt-5 high",
    // close-out surface
    "keeper commit-work 'feat(scope): implement X'",
    "keeper plan done fn-1-x.2 --summary 'done'",
    // reads / orientation
    "keeper plan cat fn-1-x.2",
    "keeper plan show fn-1-x.2",
    "keeper plan find-task-commit fn-1-x.2",
    "keeper session state",
    "keeper baseline abc123 --wait",
    // read-only + staging git
    "git add src/x.ts",
    "git add -A",
    "git status",
    "git log --oneline",
    "git diff HEAD~1",
    "git show HEAD",
    "git rev-parse HEAD",
    "git reset --soft HEAD~1",
    "git -C /repo log --oneline",
    // commit: the wrapper lands the leg's staged work as its own single commit
    // via the git-add + bare git-commit escape hatch (-m / -F <file> / --trailer)
    "git commit -m 'feat(x): land the leg work'",
    "git commit -F /scratch/msg.txt",
    "git commit --trailer 'Job-Id: job-1' -m msg",
    // combined-diff `-c` is the log/show subcommand's OWN flag, a read
    "git log -c --format=%H",
    // the test runner
    "bun test",
    "bun test test/wrapped-guard.test.ts",
    "bun run test:full",
    // a stripped benign wrapper in front of an allowed command
    "timeout 300 bun test",
    "nohup keeper agent wait leg-x",
    // pipes between two allowlisted commands
    "git log --oneline | git rev-parse HEAD",
    // a `>` INSIDE single quotes is literal — not a redirect
    "git log --grep 'fix > bug'",
    // an empty command runs nothing
    "",
  ];
  for (const cmd of allow) {
    test(`allows: ${cmd}`, () => {
      expect(evaluateWrappedBash(cmd)).toBeNull();
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
    // --- bun run demands a NAMED package script: a path-shaped target could run a
    //     just-written out-of-tree file, and a bare run has no script ---
    "bun run /scratch/gen.ts",
    "bun run ./gen.ts",
    "bun run",
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
    // --- mutating / off-list git (a wrapped worker gets read + staging + commit only) ---
    "git push",
    "git rm src/x.ts",
    "git mv a b",
    "git checkout -- src/x.ts",
    "git restore src/x.ts",
    "git reset --hard HEAD~1",
    "git reset --mixed HEAD~1",
    "git reset",
    "git clean -fd",
    // --- git -c config injection turns an allowlisted read into arbitrary exec ---
    "git -c core.pager=/tmp/x --paginate log",
    "git -c core.sshCommand=/tmp/x log",
    "git --config-env=core.pager=EVIL --paginate log",
    "git --git-dir d -c x=y status",
    // --- exec-bearing / file-writing flags on an allowlisted read subcommand ---
    "git grep --open-files-in-pager=/tmp/evil pattern",
    "git grep -O/tmp/evil pattern",
    "git grep --op=/tmp/evil",
    "git log --output=/tmp/evil",
    "git diff --output /tmp/evil HEAD~1",
    // --- off-list keeper subcommands ---
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
      expect(evaluateWrappedBash(cmd)).not.toBeNull();
    });
  }
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
const OUTSIDE = "/w/scratch"; // not a tracked tree

/** A virtual repo layout: identity realpath (a sentinel resolves to null), and a
 *  longest-prefix `.git`-toplevel over the single tracked repo root. */
function fakeProbe(opts?: { unresolvable?: string[] }): TreeProbe {
  const unresolvable = new Set(opts?.unresolvable ?? []);
  return {
    realpath: (abs) => (unresolvable.has(abs) ? null : abs),
    repoToplevel: (resolved) =>
      resolved === REPO || resolved.startsWith(`${REPO}/`) ? REPO : null,
  };
}

// The marker is the effective wrapped `<model>::<effort>`; any non-empty value marks.
const MARKED = { KEEPER_WRAPPED_CELL: "gpt-5::high" };

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

  test("contains an out-of-tree Write followed by bun run of that file", () => {
    const generated = `${OUTSIDE}/gen.ts`;
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
      "keeper agent run codex --preset gpt-5::high 'go'",
      "keeper agent run --resume leg 'fix lint'",
      "keeper agent wait leg",
      "keeper commit-work 'feat(x): y'",
      "keeper plan done fn-1-x.2 --summary 'done'",
      "keeper session state",
      "git add -A",
      "git status",
      "git commit -m 'feat(x): y'",
      "git reset --soft HEAD~1",
      "bun test",
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
      { KEEPER_ESCALATION_ROLE: "deconflict" },
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
