// Unit tests for the escalation grant confinement layer — all pure and in-process
// (no subprocess / daemon; the reader tier uses real fs over a sandboxed tmpdir).
//
// Three tiers: (1) the per-role Bash allowlist truth table over `evaluateGrantBash`
// — the file-write bypass corpus plus the diagnosis-vs-write-capable split and the
// protected `git config` deny; (2) the `decideGrantGuard` jurisdiction ladder —
// the payload-identity three-state (confined agent → enforce, other/none → inert),
// the grant-gated Edit/Write decisions, protected-path survival, role limits, and
// the fail-closed-in-jurisdiction inversion, over injected deps; (3) the
// `readGrantLeaf` verdict table (valid / absent / expired / tuple-mismatch /
// malformed / TOCTOU-hardlink / non-owner-private) over synthetic leafs.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decideGrantGuard,
  decideGrantGuardInput,
  evaluateGrantBash,
  type GrantGuardDeps,
  productionDeps,
  type RoleConfig,
} from "../plugins/keeper/plugin/hooks/grant-guard.ts";
import {
  deriveGrantLeafPath,
  type GrantDenialCode,
  type GrantExpectation,
  type GrantLeaf,
  type GrantVerdict,
  grantCoverageCode,
  grantCoversWrite,
  grantExpectationFromEnv,
  grantVerdictCode,
  isGrantProtectedPath,
  listGrantLeaves,
  parseGrantDenialCode,
  readGrantLeaf,
  reapGrantLeaves,
  writableRootCovers,
  writeGrantLeaf,
} from "../src/grant-leaf.ts";

// ---------------------------------------------------------------------------
// Tier 1 — evaluateGrantBash truth table
// ---------------------------------------------------------------------------

const DIAGNOSIS: RoleConfig = { role: "unblock", writeCapable: false };
const WRITE: RoleConfig = { role: "resolve", writeCapable: true };

describe("evaluateGrantBash — diagnosis role (no grant / unblocker)", () => {
  const allow = [
    "keeper session state",
    "keeper query jobs",
    "keeper status",
    "keeper escalation-brief unblock::fn-1-x.3",
    "git log --oneline",
    "git show HEAD",
    "git diff HEAD~1",
    "git status",
    "git branch -a",
    "git branch --contains HEAD",
    "rg pattern src/",
    "grep -rn foo .",
    "find . -name '*.ts'",
    "cat package.json",
    "bun test test/grant-guard.test.ts",
    "bun run test:gate",
    "git log --oneline | head -20",
    "timeout 300 bun test test/grant-guard.test.ts",
    "git log --grep 'fix > bug'",
  ];
  for (const cmd of allow) {
    test(`allows: ${cmd}`, () => {
      expect(evaluateGrantBash(cmd, DIAGNOSIS)).toBeNull();
    });
  }

  const deny = [
    // structural write / exec bypass vectors — denied for EVERY role
    "python3 -c 'print(1)'",
    "node -e 'x'",
    "bun -e 'x'",
    "sh -c 'git merge'",
    "echo x > out.txt",
    "cat <<EOF",
    "git log $(rm -rf /)",
    "echo `whoami`",
    "tee out.txt",
    "FOO=1 git status",
    // mutating commands a diagnosis role may not run
    "git commit -m x",
    "git merge origin/main",
    // the EXACT actor-conflict resolver shape — a full object id, `--no-ff` — stays denied for
    // a diagnosis role (it may orient, never mutate).
    "git merge --no-ff aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "keeper commit-work 'x'",
    "uv run build",
    // config injection + protected config write
    "git -c core.fsmonitor=/tmp/x status",
    "git config user.email x",
  ];
  for (const cmd of deny) {
    test(`denies: ${cmd}`, () => {
      expect(evaluateGrantBash(cmd, DIAGNOSIS)).not.toBeNull();
    });
  }
});

describe("evaluateGrantBash — write-capable role (granted resolve/deconflict/repair)", () => {
  const allow = [
    "git merge origin/main",
    // the EXACT rendered actor-conflict resolver command — the pinned source OBJECT id with
    // `--no-ff` — clears the write-capable allowlist (all git except `config`).
    "git merge --no-ff aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "git commit -m x",
    "git checkout --theirs src/x.ts",
    "git add -A",
    "keeper commit-work 'x'",
    "uv run build",
    "git log --oneline",
  ];
  for (const cmd of allow) {
    test(`allows: ${cmd}`, () => {
      expect(evaluateGrantBash(cmd, WRITE)).toBeNull();
    });
  }

  // Structural bypass + protected config stay denied even for a write-capable role.
  const deny = [
    "python3 -c 'x'",
    "echo x > out.txt",
    "cat <<EOF",
    "git commit -m x > log.txt",
    "git log $(whoami)",
    "git config user.name x", // writes .git/config — protected even under grant
  ];
  for (const cmd of deny) {
    test(`denies: ${cmd}`, () => {
      expect(evaluateGrantBash(cmd, WRITE)).not.toBeNull();
    });
  }
});

describe("evaluateGrantBash — static POSIX word reference", () => {
  const reference: ReadonlyArray<{
    name: string;
    command: string;
    referenceArgv: readonly string[] | "non-POSIX";
    expected: "allow" | "deny";
  }> = [
    {
      name: "adjacent quote runs concatenate",
      command: `g""it l'o'g --oneline`,
      referenceArgv: ["git", "log", "--oneline"],
      expected: "allow",
    },
    {
      name: "empty quoted words are preserved",
      command: `"" git log`,
      referenceArgv: ["", "git", "log"],
      expected: "deny",
    },
    {
      name: "comments begin only at a word boundary",
      command: `# comment
git log --oneline`,
      referenceArgv: ["git", "log", "--oneline"],
      expected: "deny",
    },
    {
      name: "backslash-newline is removed before word recognition",
      command: `git \\\n  log --oneline`,
      referenceArgv: ["git", "log", "--oneline"],
      expected: "allow",
    },
    {
      name: "backslash-newline is removed inside double quotes",
      command: `git "l\\
og" --oneline`,
      referenceArgv: ["git", "log", "--oneline"],
      expected: "allow",
    },
    {
      name: "ANSI-C quoting remains a conservative non-POSIX deny",
      command: `$'g\\'it' log`,
      referenceArgv: "non-POSIX",
      expected: "deny",
    },
  ];

  for (const entry of reference) {
    test(`${entry.name}: ${JSON.stringify(entry.referenceArgv)}`, () => {
      const reason = evaluateGrantBash(entry.command, DIAGNOSIS);
      if (entry.expected === "allow") expect(reason).toBeNull();
      else expect(reason).not.toBeNull();
    });
  }
});

describe("evaluateGrantBash — CVE-2025-66032 shell-bypass corpus", () => {
  const corpus = [
    "git log $(python3 -c 'x')",
    "git log `whoami`",
    'git log "$(rm -rf src)"',
    `git log "$\\
(whoami)"`,
    `git log "$\\
\\
(whoami)"`,
    "diff <(git show a) <(git show b)",
    "git status; cp /tmp/evil src/x.ts",
    "git log --oneline | sh",
    "git status && python3 -c 'x'",
    "git status & rm -rf src",
    "env sh -c 'edit src'",
    "git log > /tmp/out",
  ];
  for (const command of corpus) {
    test(`denies bypass: ${command}`, () => {
      expect(evaluateGrantBash(command, WRITE)).not.toBeNull();
    });
  }
});

test("evaluateGrantBash: the deny reason names the offending construct", () => {
  expect(evaluateGrantBash("cat f > out", WRITE)).toContain("redirect");
  expect(evaluateGrantBash("cat <<EOF", WRITE)).toContain("heredoc");
  expect(evaluateGrantBash("git log $(whoami)", WRITE)).toContain(
    "substitution",
  );
  expect(evaluateGrantBash("python3 -c 'x'", WRITE)).toContain("python3");
  expect(evaluateGrantBash("git config user.email x", WRITE)).toContain(
    "config",
  );
});

// ---------------------------------------------------------------------------
// Tier 2 — decideGrantGuard jurisdiction ladder
// ---------------------------------------------------------------------------

const ROOT = "/repo/checkout";

function validGrant(writableRoot = ROOT): GrantVerdict {
  return {
    kind: "valid",
    grant: {
      schema_version: 1,
      parent_job_id: "job-1",
      agent_type: "merge-resolver",
      incident_id: "close::fn-1-x",
      attempt_id: "att-1",
      instance_event_id: 42,
      writable_root: writableRoot,
      role: "resolve",
      expires_at: 9_999_999,
      fencing_token: 7,
    },
  };
}

function deps(opts?: {
  grant?: GrantVerdict;
  realpath?: (abs: string) => string | null;
}): GrantGuardDeps {
  return {
    grantLookup: () => opts?.grant ?? { kind: "absent" },
    realpath: opts?.realpath ?? ((abs) => abs),
    now: () => 1000,
  };
}

function editPayload(
  tool: string,
  agentType: string | undefined,
  filePath: string,
): unknown {
  return {
    tool_name: tool,
    agent_id: agentType === undefined ? undefined : "a-1",
    agent_type: agentType,
    cwd: ROOT,
    tool_input: { file_path: filePath },
  };
}

function bashPayload(
  agentType: string | undefined,
  command: string,
  cwd = ROOT,
): unknown {
  return {
    tool_name: "Bash",
    agent_id: agentType === undefined ? undefined : "a-1",
    agent_type: agentType,
    cwd,
    tool_input: { command },
  };
}

describe("decideGrantGuard — jurisdiction (payload identity)", () => {
  test("a non-escalation subagent is inert even on an off-list mutation", () => {
    expect(
      decideGrantGuard(
        editPayload("Edit", "general-purpose", `${ROOT}/src/x.ts`),
        deps(),
      ),
    ).toBeNull();
    expect(
      decideGrantGuard(bashPayload("work:worker", "echo x > out"), deps()),
    ).toBeNull();
  });

  test("an identity-less top-level call is inert", () => {
    expect(
      decideGrantGuard(
        editPayload("Edit", undefined, `${ROOT}/src/x.ts`),
        deps(),
      ),
    ).toBeNull();
    expect(
      decideGrantGuard(bashPayload(undefined, "echo x > out"), deps()),
    ).toBeNull();
  });

  test("a malformed (non-object) payload is inert — no identity to key on", () => {
    expect(decideGrantGuard(null, deps())).toBeNull();
    expect(decideGrantGuard("garbage", deps())).toBeNull();
    expect(decideGrantGuard(42, deps())).toBeNull();
  });

  test("bare and plan-qualified confined agent types establish jurisdiction", () => {
    for (const agentType of [
      "merge-resolver",
      "deconflicter",
      "unblocker",
      "repairer",
      "plan:merge-resolver",
      "plan:deconflicter",
      "plan:unblocker",
      "plan:repairer",
    ]) {
      // With no grant, a mutating Edit is denied — proof the guard is enforcing.
      expect(
        decideGrantGuard(
          editPayload("Edit", agentType, `${ROOT}/src/x.ts`),
          deps(),
        ),
      ).not.toBeNull();
    }
  });
});

describe("decideGrantGuardInput — plan-qualified Task agent", () => {
  const planRepairerAgentType = "plan:repairer";

  function planRepairerGrant(writableRoot: string): GrantLeaf {
    return {
      schema_version: 1,
      parent_job_id: "job-1",
      agent_type: planRepairerAgentType,
      incident_id: "repair::keeper",
      attempt_id: "att-1",
      instance_event_id: 42,
      writable_root: writableRoot,
      role: "repair",
      expires_at: 10_000,
      fencing_token: 7,
    };
  }

  function planRepairerEnv(dir: string) {
    return {
      KEEPER_GRANT_DIR: dir,
      KEEPER_GRANT_PARENT_JOB: "job-1",
      KEEPER_GRANT_INCIDENT: "repair::keeper",
      KEEPER_GRANT_FENCING_TOKEN: "7",
      KEEPER_GRANT_ATTEMPT: "att-1",
      KEEPER_GRANT_INSTANCE_EVENT: "42",
    };
  }

  function spawnedWritePayload(root: string, target: string): string {
    return JSON.stringify({
      tool_name: "Edit",
      agent_id: "task-1",
      agent_type: planRepairerAgentType,
      cwd: root,
      tool_input: { file_path: target },
    });
  }

  test('Task(subagent_type="plan:repairer") writes are denied without a grant leaf and allowed with one', () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-plan-repairer-grant-"));
    try {
      const root = join(dir, "checkout");
      const target = join(root, "src", "x.ts");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(target, "export const x = 1;\n");
      const env = planRepairerEnv(join(dir, "grants"));
      const payload = spawnedWritePayload(root, target);
      const deps = () => productionDeps(env, () => 5_000);

      const denied = decideGrantGuardInput(payload, deps());
      expect(denied?.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(
        writeGrantLeaf(env.KEEPER_GRANT_DIR, planRepairerGrant(root)),
      ).toBe(true);
      expect(decideGrantGuardInput(payload, deps())).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decideGrantGuard — edit tools", () => {
  test("denied by default (no grant) for a confined agent", () => {
    const d = decideGrantGuard(
      editPayload("Edit", "merge-resolver", `${ROOT}/src/x.ts`),
      deps(),
    );
    expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(d?.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });

  test("allowed under a valid grant covering the target", () => {
    expect(
      decideGrantGuard(
        editPayload("Edit", "merge-resolver", `${ROOT}/src/x.ts`),
        deps({ grant: validGrant() }),
      ),
    ).toBeNull();
  });

  test("denied when the target is outside the grant's writable root", () => {
    expect(
      decideGrantGuard(
        editPayload("Edit", "merge-resolver", "/other/repo/x.ts"),
        deps({ grant: validGrant() }),
      ),
    ).not.toBeNull();
  });

  test("a protected path is denied even under a valid grant covering it", () => {
    for (const p of [
      `${ROOT}/.git/config`,
      `${ROOT}/.git/hooks/pre-commit`,
      `${ROOT}/.mcp.json`,
      `${ROOT}/.claude/settings.json`,
      `${ROOT}/plugins/keeper/hooks/hooks.json`,
      `${ROOT}/sub/.aws/credentials`,
    ]) {
      const d = decideGrantGuard(
        editPayload("Edit", "merge-resolver", p),
        deps({ grant: validGrant() }),
      );
      expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  test("the unblocker never writes source, even holding a valid grant", () => {
    // A valid grant whose role would be write-capable does not lift the unblocker
    // diagnosis-only limit — the guard keys the limit on the payload agent_type.
    const d = decideGrantGuard(
      editPayload("Edit", "unblocker", `${ROOT}/src/x.ts`),
      deps({ grant: validGrant() }),
    );
    expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("Write and MultiEdit gate identically to Edit", () => {
    expect(
      decideGrantGuard(
        editPayload("Write", "merge-resolver", `${ROOT}/src/x.ts`),
        deps({ grant: validGrant() }),
      ),
    ).toBeNull();
    expect(
      decideGrantGuard(
        editPayload("MultiEdit", "merge-resolver", `${ROOT}/src/x.ts`),
        deps(),
      ),
    ).not.toBeNull();
  });

  test("a missing file_path denies (malformed in jurisdiction)", () => {
    expect(
      decideGrantGuard(
        {
          tool_name: "Edit",
          agent_id: "a-1",
          agent_type: "merge-resolver",
          cwd: ROOT,
          tool_input: {},
        },
        deps({ grant: validGrant() }),
      ),
    ).not.toBeNull();
  });

  test("an unresolvable target denies (cannot verify → fail closed)", () => {
    expect(
      decideGrantGuard(
        editPayload("Edit", "merge-resolver", `${ROOT}/src/x.ts`),
        deps({ grant: validGrant(), realpath: () => null }),
      ),
    ).not.toBeNull();
  });

  test("an expired / mismatched grant denies", () => {
    for (const verdict of [
      { kind: "expired" } as GrantVerdict,
      { kind: "tuple-mismatch", detail: "parent job" } as GrantVerdict,
      { kind: "malformed", detail: "x" } as GrantVerdict,
    ]) {
      expect(
        decideGrantGuard(
          editPayload("Edit", "merge-resolver", `${ROOT}/src/x.ts`),
          deps({ grant: verdict }),
        ),
      ).not.toBeNull();
    }
  });
});

describe("decideGrantGuard — Bash", () => {
  test("reads are allowed without a grant", () => {
    expect(
      decideGrantGuard(
        bashPayload("merge-resolver", "git log --oneline"),
        deps(),
      ),
    ).toBeNull();
  });

  test("a git mutation is denied without a grant, allowed under one (cwd in root)", () => {
    expect(
      decideGrantGuard(bashPayload("merge-resolver", "git merge x"), deps()),
    ).not.toBeNull();
    expect(
      decideGrantGuard(
        bashPayload("merge-resolver", "git merge x"),
        deps({ grant: validGrant() }),
      ),
    ).toBeNull();
  });

  test("the rendered pinned fast-forward `git merge --ff-only <40-hex oid>` is allowed under a valid grant, denied without / expired", () => {
    const cmd = `git merge --ff-only ${"a".repeat(40)}`;
    // No grant → denied.
    expect(
      decideGrantGuard(bashPayload("merge-resolver", cmd), deps()),
    ).not.toBeNull();
    // Valid grant, cwd in the writable root → allowed.
    expect(
      decideGrantGuard(
        bashPayload("merge-resolver", cmd),
        deps({ grant: validGrant() }),
      ),
    ).toBeNull();
    // Expired grant → denied.
    expect(
      decideGrantGuard(
        bashPayload("merge-resolver", cmd),
        deps({ grant: { kind: "expired" } }),
      ),
    ).not.toBeNull();
  });

  test("a structural write vector is denied even under a valid grant", () => {
    expect(
      decideGrantGuard(
        bashPayload("merge-resolver", "echo x > src/out.ts"),
        deps({ grant: validGrant() }),
      ),
    ).not.toBeNull();
  });

  test("a write-capable command with cwd outside the writable root is denied", () => {
    expect(
      decideGrantGuard(
        bashPayload("merge-resolver", "git merge x", "/other/repo"),
        deps({ grant: validGrant() }),
      ),
    ).not.toBeNull();
  });

  test("git global path overrides cannot escape the writable root", () => {
    const commands = [
      "git -C /foreign/repo commit -m x",
      "git --work-tree /foreign/repo commit -m x",
      "git --git-dir=/foreign/repo/.git commit -m x",
    ];
    for (const command of commands) {
      const decision = decideGrantGuard(
        bashPayload("merge-resolver", command),
        deps({ grant: validGrant() }),
      );
      expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain(
        "outside",
      );
    }
  });

  test("the unblocker's Bash is diagnosis-only even under a valid grant", () => {
    expect(
      decideGrantGuard(
        bashPayload("unblocker", "git merge x"),
        deps({ grant: validGrant() }),
      ),
    ).not.toBeNull();
    expect(
      decideGrantGuard(bashPayload("unblocker", "git log"), deps()),
    ).toBeNull();
  });
});

describe("decideGrantGuard — launch-bound AUDIT_READY block", () => {
  const wrappedDeps = () =>
    productionDeps(
      {
        KEEPER_WRAPPED_CELL: "gpt-5::high",
        KEEPER_WRAPPED_ENVELOPE:
          "/repo/.keeper/state/wrapped-envelopes/fn-1-x.2.json",
      },
      () => 1_000,
    );

  test("allows the launch-bound task with an AUDIT_READY-prefixed reason", () => {
    expect(
      decideGrantGuard(
        bashPayload(
          "unblocker",
          "keeper plan block fn-1-x.2 --reason 'AUDIT_READY: abc123 committed'",
        ),
        wrappedDeps(),
      ),
    ).toBeNull();
  });

  test("denies an AUDIT_READY block for a foreign task", () => {
    const decision = decideGrantGuard(
      bashPayload(
        "unblocker",
        "keeper plan block fn-1-other.9 --reason 'AUDIT_READY: abc123 committed'",
      ),
      wrappedDeps(),
    );
    expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain(
      "launch-bound task",
    );
  });

  test("denies a launch-bound block whose reason is not AUDIT_READY", () => {
    const decision = decideGrantGuard(
      bashPayload(
        "unblocker",
        "keeper plan block fn-1-x.2 --reason 'TOOLING_FAILURE: provider failed'",
      ),
      wrappedDeps(),
    );
    expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain(
      "must start with `AUDIT_READY:`",
    );
  });

  test("denies --force on an otherwise valid launch-bound AUDIT_READY block", () => {
    const decision = decideGrantGuard(
      bashPayload(
        "unblocker",
        "keeper plan block fn-1-x.2 --reason 'AUDIT_READY: abc123 committed' --force",
      ),
      wrappedDeps(),
    );
    expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain(
      "plan block --force",
    );
  });
});

// ---------------------------------------------------------------------------
// Incident-clearing retry — `keeper autopilot retry <verb::id>` is bound to the
// grant's OWN incident id; a granted subagent re-arms its own incident only.
// ---------------------------------------------------------------------------

describe("decideGrantGuard — incident-clearing retry", () => {
  function grantFor(
    agentType: GrantLeaf["agent_type"],
    role: GrantLeaf["role"],
    incidentId: string,
  ): GrantVerdict {
    return {
      kind: "valid",
      grant: {
        schema_version: 1,
        parent_job_id: "job-1",
        agent_type: agentType,
        incident_id: incidentId,
        attempt_id: "att-1",
        instance_event_id: 42,
        writable_root: ROOT,
        role,
        expires_at: 9_999_999,
        fencing_token: 7,
      },
    };
  }
  const repairGrant = grantFor("repairer", "repair", "repair::keeper");

  test("a granted subagent may retry its OWN incident", () => {
    expect(
      decideGrantGuard(
        bashPayload("repairer", "keeper autopilot retry repair::keeper"),
        deps({ grant: repairGrant }),
      ),
    ).toBeNull();
  });

  test("retrying a SIBLING's incident is denied", () => {
    const d = decideGrantGuard(
      bashPayload("repairer", "keeper autopilot retry repair::other-repo"),
      deps({ grant: repairGrant }),
    );
    expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(d?.hookSpecificOutput.permissionDecisionReason).toContain("foreign");
  });

  test("a close-incident resolver retries only its own close key", () => {
    expect(
      decideGrantGuard(
        bashPayload("merge-resolver", "keeper autopilot retry close::fn-1-x"),
        deps({ grant: validGrant() }),
      ),
    ).toBeNull();
    expect(
      decideGrantGuard(
        bashPayload("merge-resolver", "keeper autopilot retry close::fn-2-y"),
        deps({ grant: validGrant() }),
      ),
    ).not.toBeNull();
  });

  test("retry is denied without a valid grant (no incident to match)", () => {
    const noGrant: Array<GrantVerdict | undefined> = [
      undefined, // absent
      { kind: "expired" },
      { kind: "tuple-mismatch", detail: "incident" },
    ];
    for (const verdict of noGrant) {
      expect(
        decideGrantGuard(
          bashPayload("repairer", "keeper autopilot retry repair::keeper"),
          deps(verdict === undefined ? {} : { grant: verdict }),
        ),
      ).not.toBeNull();
    }
  });

  test("retry with no target, or a second target, is denied", () => {
    expect(
      decideGrantGuard(
        bashPayload("repairer", "keeper autopilot retry"),
        deps({ grant: repairGrant }),
      ),
    ).not.toBeNull();
    expect(
      decideGrantGuard(
        bashPayload(
          "repairer",
          "keeper autopilot retry repair::keeper repair::keeper",
        ),
        deps({ grant: repairGrant }),
      ),
    ).not.toBeNull();
  });

  test("the optional --sock flag rides alongside the granted target", () => {
    expect(
      decideGrantGuard(
        bashPayload(
          "repairer",
          "keeper autopilot retry repair::keeper --sock /tmp/k.sock",
        ),
        deps({ grant: repairGrant }),
      ),
    ).toBeNull();
  });

  test("a non-retry autopilot subcommand stays denied", () => {
    for (const cmd of [
      "keeper autopilot play",
      "keeper autopilot pause",
      "keeper autopilot mode yolo",
    ]) {
      expect(
        decideGrantGuard(
          bashPayload("repairer", cmd),
          deps({ grant: repairGrant }),
        ),
      ).not.toBeNull();
    }
  });

  test("retry is incident-keyed, not write-keyed — the unblocker clears its own", () => {
    const unblockGrant = grantFor("unblocker", "unblock", "close::fn-9-z");
    expect(
      decideGrantGuard(
        bashPayload("unblocker", "keeper autopilot retry close::fn-9-z"),
        deps({ grant: unblockGrant }),
      ),
    ).toBeNull();
    // ...but never a sibling's incident.
    expect(
      decideGrantGuard(
        bashPayload("unblocker", "keeper autopilot retry close::fn-1-x"),
        deps({ grant: unblockGrant }),
      ),
    ).not.toBeNull();
  });
});

test("decideGrantGuard: a non-governed read tool is inert for a confined agent", () => {
  expect(
    decideGrantGuard(
      {
        tool_name: "Read",
        agent_id: "a-1",
        agent_type: "merge-resolver",
        tool_input: { file_path: `${ROOT}/x` },
      },
      deps(),
    ),
  ).toBeNull();
});

test("decideGrantGuardInput denies a truncated confined payload", () => {
  const raw = JSON.stringify({
    tool_name: "Write",
    agent_id: "a-1",
    agent_type: "merge-resolver",
    cwd: ROOT,
    tool_input: {
      file_path: `${ROOT}/src/large.ts`,
      content: "x".repeat(1_100_000),
    },
  });
  const decision = decideGrantGuardInput(raw, deps());
  expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain(
    "malformed",
  );
});

test("decideGrantGuardInput keeps a truncated ordinary-agent payload inert", () => {
  const raw = JSON.stringify({
    tool_name: "Write",
    agent_type: "general-purpose",
    tool_input: { content: "x".repeat(1_100_000) },
  });
  expect(decideGrantGuardInput(raw, deps())).toBeNull();
});

// ---------------------------------------------------------------------------
// Path predicates
// ---------------------------------------------------------------------------

describe("path predicates", () => {
  test("writableRootCovers", () => {
    expect(writableRootCovers("/repo", "/repo/src/x.ts")).toBe(true);
    expect(writableRootCovers("/repo", "/repo")).toBe(true);
    expect(writableRootCovers("/repo", "/repo-other/x")).toBe(false);
    expect(writableRootCovers("/repo", "/other/x")).toBe(false);
    expect(writableRootCovers("relative", "/repo/x")).toBe(false);
  });

  test("isGrantProtectedPath", () => {
    for (const p of [
      "/r/.git/config",
      "/r/.git/hooks/pre-commit",
      "/r/.aws/credentials",
      "/home/u/.ssh/id_rsa",
      "/r/.git-credentials",
      "/r/.netrc",
      "/r/.mcp.json",
      "/r/.claude/settings.json",
      "/r/.claude/settings.local.json",
      "/r/x/.claude-plugin/plugin.json",
      "/r/plugins/keeper/hooks/hooks.json",
    ]) {
      expect(isGrantProtectedPath(p)).toBe(true);
    }
    for (const p of [
      "/r/src/x.ts",
      "/r/.gitignore",
      "/r/config.ts",
      "/r/docs/settings.md",
    ]) {
      expect(isGrantProtectedPath(p)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — readGrantLeaf verdict table over synthetic leafs
// ---------------------------------------------------------------------------

function makeGrant(over: Partial<GrantLeaf> = {}): GrantLeaf {
  return {
    schema_version: 1,
    parent_job_id: "job-1",
    agent_type: "merge-resolver",
    incident_id: "close::fn-1-x",
    attempt_id: "att-1",
    instance_event_id: 42,
    writable_root: "/repo/checkout",
    role: "resolve",
    expires_at: 10_000,
    fencing_token: 7,
    ...over,
  };
}

function baseExpectation(): GrantExpectation {
  return {
    parentJobId: "job-1",
    agentType: "merge-resolver",
    incidentId: "close::fn-1-x",
    fencingToken: 7,
  };
}

describe("readGrantLeaf / writeGrantLeaf verdicts", () => {
  test("write then read round-trips as valid", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      expect(writeGrantLeaf(dir, makeGrant())).toBe(true);
      const v = readGrantLeaf(dir, baseExpectation(), 5_000);
      expect(v.kind).toBe("valid");
      if (v.kind === "valid") {
        expect(v.grant.writable_root).toBe("/repo/checkout");
        expect(v.grant.fencing_token).toBe(7);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the writer canonicalizes a symlinked writable root", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      const actualRoot = join(dir, "actual-checkout");
      const aliasRoot = join(dir, "alias-checkout");
      mkdirSync(actualRoot);
      symlinkSync(actualRoot, aliasRoot, "dir");
      const canonicalRoot = realpathSync(actualRoot);

      expect(writeGrantLeaf(dir, makeGrant({ writable_root: aliasRoot }))).toBe(
        true,
      );
      const verdict = readGrantLeaf(dir, baseExpectation(), 5_000);
      expect(verdict.kind).toBe("valid");
      if (verdict.kind === "valid") {
        expect(verdict.grant.writable_root).toBe(canonicalRoot);
        expect(
          writableRootCovers(
            verdict.grant.writable_root,
            join(canonicalRoot, "src", "x.ts"),
          ),
        ).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("absent when no leaf exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      expect(readGrantLeaf(dir, baseExpectation(), 5_000).kind).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("absent when the grants dir is empty/relative", () => {
    expect(readGrantLeaf("", baseExpectation(), 5_000).kind).toBe("absent");
    expect(readGrantLeaf("rel/dir", baseExpectation(), 5_000).kind).toBe(
      "absent",
    );
  });

  test("expired when now is at/after the deadline", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      writeGrantLeaf(dir, makeGrant({ expires_at: 1_000 }));
      expect(readGrantLeaf(dir, baseExpectation(), 5_000).kind).toBe("expired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tuple-mismatch on any differing identity field", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      writeGrantLeaf(dir, makeGrant());
      const mism = [
        { ...baseExpectation(), fencingToken: 99 },
        { ...baseExpectation(), incidentId: "close::other" },
        { ...baseExpectation(), attemptId: "att-2" },
        { ...baseExpectation(), instanceEventId: 999 },
      ];
      for (const exp of mism) {
        expect(readGrantLeaf(dir, exp, 5_000).kind).toBe("tuple-mismatch");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a parent-job / agent-type mismatch reads as absent (path is keyed on them)", () => {
    // The derived path itself keys on (parentJob, agentType), so a mismatch there
    // points at a non-existent leaf — absent, not tuple-mismatch.
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      writeGrantLeaf(dir, makeGrant());
      expect(
        readGrantLeaf(
          dir,
          { ...baseExpectation(), parentJobId: "job-2" },
          5_000,
        ).kind,
      ).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed on non-JSON / shape-invalid bytes at the derived path", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      const path = deriveGrantLeafPath(dir, "job-1", "merge-resolver");
      writeFileSync(path, "not json", { mode: 0o600 });
      expect(readGrantLeaf(dir, baseExpectation(), 5_000).kind).toBe(
        "malformed",
      );
      writeFileSync(path, JSON.stringify({ schema_version: 1 }), {
        mode: 0o600,
      });
      expect(readGrantLeaf(dir, baseExpectation(), 5_000).kind).toBe(
        "malformed",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed on a role that does not match the agent type", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      const path = deriveGrantLeafPath(dir, "job-1", "merge-resolver");
      writeFileSync(
        path,
        JSON.stringify(makeGrant({ role: "unblock" })), // resolve expected
        { mode: 0o600 },
      );
      expect(readGrantLeaf(dir, baseExpectation(), 5_000).kind).toBe(
        "malformed",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed (anti-TOCTOU) when the leaf is hardlinked (nlink !== 1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      const path = deriveGrantLeafPath(dir, "job-1", "merge-resolver");
      writeFileSync(path, JSON.stringify(makeGrant()), { mode: 0o600 });
      linkSync(path, join(dir, "attacker-hardlink"));
      expect(readGrantLeaf(dir, baseExpectation(), 5_000).kind).toBe(
        "malformed",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed when the leaf is not owner-private (group/world accessible)", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      const path = deriveGrantLeafPath(dir, "job-1", "merge-resolver");
      writeFileSync(path, JSON.stringify(makeGrant()), { mode: 0o600 });
      chmodSync(path, 0o644);
      expect(readGrantLeaf(dir, baseExpectation(), 5_000).kind).toBe(
        "malformed",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// grantCoversWrite — the shared sibling-guard override, env-driven
// ---------------------------------------------------------------------------

function withGrantTmp(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("grant enumeration and in-session owner discovery", () => {
  test("listGrantLeaves counts valid owner-private grants in fencing order", () => {
    withGrantTmp((dir) => {
      expect(
        writeGrantLeaf(
          dir,
          makeGrant({ parent_job_id: "job-2", fencing_token: 9 }),
        ),
      ).toBe(true);
      expect(
        writeGrantLeaf(
          dir,
          makeGrant({ parent_job_id: "job-1", fencing_token: 7 }),
        ),
      ).toBe(true);
      expect(
        listGrantLeaves(dir).map((grant) => [
          grant.parent_job_id,
          grant.fencing_token,
        ]),
      ).toEqual([
        ["job-1", 7],
        ["job-2", 9],
      ]);
    });
  });

  test("listGrantLeaves finds the active holder beyond 256 entries", () => {
    withGrantTmp((dir) => {
      for (let token = 1; token <= 256; token += 1) {
        const grant = makeGrant({
          parent_job_id: `job-expired-${token}`,
          expires_at: 4_000,
          fencing_token: token,
        });
        writeFileSync(
          deriveGrantLeafPath(dir, grant.parent_job_id, grant.agent_type),
          JSON.stringify(grant),
          { mode: 0o600 },
        );
      }
      expect(listGrantLeaves(dir)).toHaveLength(256);

      const active = makeGrant({
        parent_job_id: "job-active-after-cap",
        expires_at: 20_000,
        fencing_token: 257,
      });
      writeFileSync(
        deriveGrantLeafPath(dir, active.parent_job_id, active.agent_type),
        JSON.stringify(active),
        { mode: 0o600 },
      );

      const leaves = listGrantLeaves(dir);
      expect(leaves).toHaveLength(257);
      expect(
        leaves
          .filter((grant) => 5_000 < grant.expires_at)
          .map((grant) => grant.parent_job_id),
      ).toEqual(["job-active-after-cap"]);
    });
  });

  test("reapGrantLeaves drains expired dead owners in bounded batches and retains the fencing floor", () => {
    withGrantTmp((dir) => {
      const deadOwners = new Set<string>();
      for (let token = 1; token <= 258; token += 1) {
        const parentJobId = `job-dead-${token}`;
        deadOwners.add(parentJobId);
        const grant = makeGrant({
          parent_job_id: parentJobId,
          expires_at: 4_000,
          fencing_token: token,
        });
        writeFileSync(
          deriveGrantLeafPath(dir, grant.parent_job_id, grant.agent_type),
          JSON.stringify(grant),
          { mode: 0o600 },
        );
      }
      const expiredDeadOwner = (grant: GrantLeaf) =>
        grant.expires_at <= 5_000 && deadOwners.has(grant.parent_job_id);

      const first = reapGrantLeaves(dir, expiredDeadOwner);
      expect(first.reaped).toBe(256);
      expect(listGrantLeaves(dir).map((grant) => grant.fencing_token)).toEqual([
        257, 258,
      ]);
      const second = reapGrantLeaves(dir, expiredDeadOwner, first.nextCursor);
      expect(second.reaped).toBe(1);
      expect(listGrantLeaves(dir).map((grant) => grant.fencing_token)).toEqual([
        258,
      ]);
      expect(
        reapGrantLeaves(dir, expiredDeadOwner, second.nextCursor).reaped,
      ).toBe(0);
    });
  });

  test("reapGrantLeaves fails open when its owner probe throws", () => {
    withGrantTmp((dir) => {
      for (const token of [7, 8]) {
        const grant = makeGrant({
          parent_job_id: `job-${token}`,
          expires_at: 4_000,
          fencing_token: token,
        });
        writeFileSync(
          deriveGrantLeafPath(dir, grant.parent_job_id, grant.agent_type),
          JSON.stringify(grant),
          { mode: 0o600 },
        );
      }
      expect(
        reapGrantLeaves(dir, () => {
          throw new Error("liveness unavailable");
        }).reaped,
      ).toBe(0);
      expect(listGrantLeaves(dir).map((grant) => grant.fencing_token)).toEqual([
        7, 8,
      ]);
    });
  });

  test("a running owner discovers only its own repairer leaf", () => {
    withGrantTmp((dir) => {
      const root = join(dir, "repo");
      mkdirSync(root);
      expect(
        writeGrantLeaf(
          dir,
          makeGrant({
            agent_type: "plan:repairer",
            role: "repair",
            writable_root: root,
            incident_id: "repair::repo-abc",
            owner_task_id: "fn-1-x.1",
          }),
        ),
      ).toBe(true);
      const env = {
        KEEPER_GRANT_DIR: dir,
        CLAUDE_CODE_SESSION_ID: "job-1",
      };
      const target = join(realpathSync(root), "fix.ts");
      expect(grantCoversWrite(env, "plan:repairer", target, 5_000)).toBe(true);
      expect(
        grantCoversWrite(
          { ...env, CLAUDE_CODE_SESSION_ID: "job-other" },
          "plan:repairer",
          target,
          5_000,
        ),
      ).toBe(false);
    });
  });
});

describe("grantCoversWrite (env + real leaf)", () => {
  function grantEnv(dir: string) {
    return {
      KEEPER_GRANT_DIR: dir,
      KEEPER_GRANT_PARENT_JOB: "job-1",
      KEEPER_GRANT_INCIDENT: "close::fn-1-x",
      KEEPER_GRANT_FENCING_TOKEN: "7",
    };
  }

  test("covers a target inside the writable root for a write-capable agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      writeGrantLeaf(dir, makeGrant());
      const env = grantEnv(dir);
      expect(
        grantCoversWrite(
          env,
          "merge-resolver",
          "/repo/checkout/src/x.ts",
          5_000,
        ),
      ).toBe(true);
      // outside the root
      expect(
        grantCoversWrite(env, "merge-resolver", "/other/x.ts", 5_000),
      ).toBe(false);
      // protected path inside the root
      expect(
        grantCoversWrite(
          env,
          "merge-resolver",
          "/repo/checkout/.git/config",
          5_000,
        ),
      ).toBe(false);
      // expired
      expect(
        grantCoversWrite(
          env,
          "merge-resolver",
          "/repo/checkout/src/x.ts",
          50_000,
        ),
      ).toBe(false);
      // unblocker is never write-capable
      expect(
        grantCoversWrite(env, "unblocker", "/repo/checkout/src/x.ts", 5_000),
      ).toBe(false);
      // non-escalation agent
      expect(
        grantCoversWrite(env, "work:worker", "/repo/checkout/src/x.ts", 5_000),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("false when the env lacks a core expectation field", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-grant-"));
    try {
      writeGrantLeaf(dir, makeGrant());
      expect(
        grantCoversWrite(
          { KEEPER_GRANT_DIR: dir, KEEPER_GRANT_PARENT_JOB: "job-1" },
          "merge-resolver",
          "/repo/checkout/src/x.ts",
          5_000,
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Part A — first-non-empty launch-identity selection (the daemon-launched
// KEEPER_JOB_ID="" mis-bind that read every valid grant as absent).
// ---------------------------------------------------------------------------

describe("grantExpectationFromEnv — first-non-empty launch identity", () => {
  test("a present-but-empty KEEPER_JOB_ID falls through to CLAUDE_CODE_SESSION_ID and validates the exact leaf", () => {
    withGrantTmp((dir) => {
      const grant = makeGrant({
        parent_job_id: "owner-session",
        agent_type: "plan:merge-resolver",
      });
      expect(writeGrantLeaf(dir, grant)).toBe(true);
      const env = {
        KEEPER_GRANT_DIR: dir,
        KEEPER_JOB_ID: "",
        CLAUDE_CODE_SESSION_ID: "owner-session",
      };
      const exp = grantExpectationFromEnv(env, "plan:merge-resolver");
      expect(exp).not.toBeNull();
      expect(exp?.parentJobId).toBe("owner-session");
      // End-to-end: the launch-anchored expectation validates the real leaf.
      expect(readGrantLeaf(dir, exp as GrantExpectation, 5_000).kind).toBe(
        "valid",
      );
    });
  });

  test("a whitespace-only KEEPER_JOB_ID also falls through", () => {
    withGrantTmp((dir) => {
      expect(
        writeGrantLeaf(
          dir,
          makeGrant({
            parent_job_id: "owner-session",
            agent_type: "plan:merge-resolver",
          }),
        ),
      ).toBe(true);
      const exp = grantExpectationFromEnv(
        {
          KEEPER_GRANT_DIR: dir,
          KEEPER_JOB_ID: "   ",
          CLAUDE_CODE_SESSION_ID: "owner-session",
        },
        "plan:merge-resolver",
      );
      expect(exp?.parentJobId).toBe("owner-session");
    });
  });

  test("a non-empty KEEPER_JOB_ID keeps precedence over CLAUDE_CODE_SESSION_ID", () => {
    withGrantTmp((dir) => {
      expect(
        writeGrantLeaf(
          dir,
          makeGrant({
            parent_job_id: "job-launch",
            agent_type: "plan:merge-resolver",
          }),
        ),
      ).toBe(true);
      const exp = grantExpectationFromEnv(
        {
          KEEPER_GRANT_DIR: dir,
          KEEPER_JOB_ID: "job-launch",
          CLAUDE_CODE_SESSION_ID: "session-launch",
        },
        "plan:merge-resolver",
      );
      expect(exp?.parentJobId).toBe("job-launch");
    });
  });

  test("a foreign session id finds no leaf → null (still fails closed)", () => {
    withGrantTmp((dir) => {
      writeGrantLeaf(
        dir,
        makeGrant({
          parent_job_id: "owner-session",
          agent_type: "plan:merge-resolver",
        }),
      );
      expect(
        grantExpectationFromEnv(
          {
            KEEPER_GRANT_DIR: dir,
            KEEPER_JOB_ID: "",
            CLAUDE_CODE_SESSION_ID: "intruder",
          },
          "plan:merge-resolver",
        ),
      ).toBeNull();
    });
  });

  test("both identities empty/blank → null (no launch identity)", () => {
    expect(
      grantExpectationFromEnv(
        {
          KEEPER_GRANT_DIR: "/some/dir",
          KEEPER_JOB_ID: "",
          CLAUDE_CODE_SESSION_ID: "   ",
        },
        "plan:merge-resolver",
      ),
    ).toBeNull();
  });

  test("explicit KEEPER_GRANT_PARENT_JOB keeps precedence over the launch identity", () => {
    const exp = grantExpectationFromEnv(
      {
        KEEPER_GRANT_PARENT_JOB: "explicit-parent",
        KEEPER_GRANT_INCIDENT: "close::fn-1-x",
        KEEPER_GRANT_FENCING_TOKEN: "7",
        KEEPER_JOB_ID: "job-launch",
        CLAUDE_CODE_SESSION_ID: "session-launch",
      },
      "plan:merge-resolver",
    );
    expect(exp?.parentJobId).toBe("explicit-parent");
    expect(exp?.fencingToken).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Part B — typed verdict/denial codes threaded through the shared coverage seam
// and surfaced in the grant-guard deny envelope.
// ---------------------------------------------------------------------------

describe("grantCoverageCode — typed coverage outcome", () => {
  function grantEnv(dir: string, over?: Record<string, string>) {
    return {
      KEEPER_GRANT_DIR: dir,
      KEEPER_GRANT_PARENT_JOB: "job-1",
      KEEPER_GRANT_INCIDENT: "close::fn-1-x",
      KEEPER_GRANT_FENCING_TOKEN: "7",
      ...over,
    };
  }

  test("resolve AND deconflict both cover an in-root target under their live exact grants", () => {
    withGrantTmp((dir) => {
      writeGrantLeaf(
        dir,
        makeGrant({ agent_type: "plan:merge-resolver", role: "resolve" }),
      );
      writeGrantLeaf(
        dir,
        makeGrant({ agent_type: "plan:deconflicter", role: "deconflict" }),
      );
      const env = grantEnv(dir);
      expect(
        grantCoverageCode(
          env,
          "plan:merge-resolver",
          "/repo/checkout/src/x.ts",
          5_000,
        ),
      ).toBe("valid");
      expect(
        grantCoverageCode(
          env,
          "plan:deconflicter",
          "/repo/checkout/src/x.ts",
          5_000,
        ),
      ).toBe("valid");
    });
  });

  test("an expired grant is grant_expired, NEVER grant_absent", () => {
    withGrantTmp((dir) => {
      writeGrantLeaf(
        dir,
        makeGrant({
          agent_type: "plan:merge-resolver",
          role: "resolve",
          expires_at: 10_000,
        }),
      );
      expect(
        grantCoverageCode(
          grantEnv(dir),
          "plan:merge-resolver",
          "/repo/checkout/src/x.ts",
          50_000,
        ),
      ).toBe("grant_expired");
    });
  });

  test("a wrong fencing token is tuple_mismatch", () => {
    withGrantTmp((dir) => {
      writeGrantLeaf(
        dir,
        makeGrant({ agent_type: "plan:merge-resolver", role: "resolve" }),
      );
      expect(
        grantCoverageCode(
          grantEnv(dir, { KEEPER_GRANT_FENCING_TOKEN: "99" }),
          "plan:merge-resolver",
          "/repo/checkout/src/x.ts",
          5_000,
        ),
      ).toBe("tuple_mismatch");
    });
  });

  test("outside-root and protected paths are command_policy_mismatch under a valid grant", () => {
    withGrantTmp((dir) => {
      writeGrantLeaf(
        dir,
        makeGrant({ agent_type: "plan:merge-resolver", role: "resolve" }),
      );
      const env = grantEnv(dir);
      expect(
        grantCoverageCode(env, "plan:merge-resolver", "/other/x.ts", 5_000),
      ).toBe("command_policy_mismatch");
      expect(
        grantCoverageCode(
          env,
          "plan:merge-resolver",
          "/repo/checkout/.git/config",
          5_000,
        ),
      ).toBe("command_policy_mismatch");
    });
  });

  test("a diagnosis-only unblocker and a non-escalation agent are command_policy_mismatch", () => {
    withGrantTmp((dir) => {
      const env = grantEnv(dir);
      expect(
        grantCoverageCode(env, "unblocker", "/repo/checkout/src/x.ts", 5_000),
      ).toBe("command_policy_mismatch");
      expect(
        grantCoverageCode(env, "work:worker", "/repo/checkout/src/x.ts", 5_000),
      ).toBe("command_policy_mismatch");
    });
  });

  test("a missing leaf is grant_absent", () => {
    withGrantTmp((dir) => {
      expect(
        grantCoverageCode(
          grantEnv(dir),
          "plan:merge-resolver",
          "/repo/checkout/src/x.ts",
          5_000,
        ),
      ).toBe("grant_absent");
    });
  });

  test("grantCoversWrite stays a boolean view of grantCoverageCode", () => {
    withGrantTmp((dir) => {
      writeGrantLeaf(
        dir,
        makeGrant({ agent_type: "plan:merge-resolver", role: "resolve" }),
      );
      const env = grantEnv(dir);
      expect(
        grantCoversWrite(
          env,
          "plan:merge-resolver",
          "/repo/checkout/src/x.ts",
          5_000,
        ),
      ).toBe(true);
      expect(
        grantCoversWrite(
          env,
          "plan:merge-resolver",
          "/repo/checkout/src/x.ts",
          50_000,
        ),
      ).toBe(false);
    });
  });
});

describe("grantVerdictCode / parseGrantDenialCode round-trip", () => {
  const PAIRS: Array<[GrantVerdict["kind"], GrantDenialCode]> = [
    ["valid", "valid"],
    ["absent", "grant_absent"],
    ["expired", "grant_expired"],
    ["tuple-mismatch", "tuple_mismatch"],
    ["malformed", "unknown"],
  ];
  for (const [kind, code] of PAIRS) {
    test(`'${kind}' → '${code}'`, () => {
      expect(grantVerdictCode(kind)).toBe(code);
    });
  }

  test("parseGrantDenialCode reads a tagged reason and rejects an untagged one", () => {
    expect(
      parseGrantDenialCode("[keeper-grant-verdict=grant_expired] blah"),
    ).toBe("grant_expired");
    expect(parseGrantDenialCode("free-form prose, no marker")).toBeNull();
    expect(parseGrantDenialCode("[keeper-grant-verdict=bogus] x")).toBeNull();
  });
});

describe("grant-guard deny envelope carries the typed verdict code", () => {
  const CASES: Array<[GrantVerdict, GrantDenialCode]> = [
    [{ kind: "absent" }, "grant_absent"],
    [{ kind: "expired" }, "grant_expired"],
    [{ kind: "tuple-mismatch", detail: "fencing token" }, "tuple_mismatch"],
    [{ kind: "malformed", detail: "leaf shape invalid" }, "unknown"],
  ];
  for (const [verdict, code] of CASES) {
    test(`an edit-tool mutation under a '${verdict.kind}' grant denies with code '${code}'`, () => {
      const d = decideGrantGuard(
        editPayload("Edit", "plan:merge-resolver", `${ROOT}/src/x.ts`),
        deps({ grant: verdict }),
      );
      expect(
        parseGrantDenialCode(
          d?.hookSpecificOutput.permissionDecisionReason ?? "",
        ),
      ).toBe(code);
    });
  }

  test("a grant_absent mis-bind is NEVER narrated as grant_expired", () => {
    const d = decideGrantGuard(
      editPayload("Edit", "plan:merge-resolver", `${ROOT}/src/x.ts`),
      deps({ grant: { kind: "absent" } }),
    );
    const reason = d?.hookSpecificOutput.permissionDecisionReason ?? "";
    expect(parseGrantDenialCode(reason)).toBe("grant_absent");
    // The machine-keyable marker is grant_absent — the expiry marker is absent
    // (the reason PROSE may mention grant_expired only as an explanation).
    expect(reason).toContain("[keeper-grant-verdict=grant_absent]");
    expect(reason).not.toContain("[keeper-grant-verdict=grant_expired]");
  });

  test("a protected path and an outside-root target deny with command_policy_mismatch under a valid grant", () => {
    const protectedDeny = decideGrantGuard(
      editPayload("Edit", "plan:merge-resolver", `${ROOT}/.git/config`),
      deps({ grant: validGrant() }),
    );
    expect(
      parseGrantDenialCode(
        protectedDeny?.hookSpecificOutput.permissionDecisionReason ?? "",
      ),
    ).toBe("command_policy_mismatch");
    const outsideDeny = decideGrantGuard(
      editPayload("Edit", "plan:merge-resolver", "/elsewhere/x.ts"),
      deps({ grant: validGrant() }),
    );
    expect(
      parseGrantDenialCode(
        outsideDeny?.hookSpecificOutput.permissionDecisionReason ?? "",
      ),
    ).toBe("command_policy_mismatch");
  });

  test("a write-capable bash command under an expired grant surfaces grant_expired, not a diagnosis-role narration", () => {
    const d = decideGrantGuard(
      bashPayload("plan:merge-resolver", "keeper commit-work 'x'"),
      deps({ grant: { kind: "expired" } }),
    );
    const reason = d?.hookSpecificOutput.permissionDecisionReason ?? "";
    expect(parseGrantDenialCode(reason)).toBe("grant_expired");
    expect(reason).not.toContain("diagnosis role");
  });

  test("a genuine command-policy bash violation is command_policy_mismatch even for a write-capable role", () => {
    const d = decideGrantGuard(
      bashPayload("plan:merge-resolver", "python3 -c 'x'"),
      deps({ grant: validGrant() }),
    );
    expect(
      parseGrantDenialCode(
        d?.hookSpecificOutput.permissionDecisionReason ?? "",
      ),
    ).toBe("command_policy_mismatch");
  });

  test("end-to-end: an EXPIRED real leaf denies an edit with grant_expired through productionDeps", () => {
    withGrantTmp((dir) => {
      writeGrantLeaf(
        dir,
        makeGrant({
          agent_type: "plan:merge-resolver",
          role: "resolve",
          expires_at: 10_000,
        }),
      );
      const env = {
        KEEPER_GRANT_DIR: dir,
        KEEPER_GRANT_PARENT_JOB: "job-1",
        KEEPER_GRANT_INCIDENT: "close::fn-1-x",
        KEEPER_GRANT_FENCING_TOKEN: "7",
      };
      const payload = JSON.stringify(
        editPayload("Edit", "plan:merge-resolver", "/repo/checkout/src/x.ts"),
      );
      const d = decideGrantGuardInput(
        payload,
        productionDeps(env, () => 50_000),
      );
      expect(
        parseGrantDenialCode(
          d?.hookSpecificOutput.permissionDecisionReason ?? "",
        ),
      ).toBe("grant_expired");
    });
  });
});
