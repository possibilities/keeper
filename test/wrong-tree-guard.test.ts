// Unit tests for plugins/keeper/plugin/hooks/wrong-tree-guard.ts.
//
// Four layers, all pure in-process (the git-boundary decision runs through the
// injected `TreeProbe` seam, never a real subprocess): (1) the Bash write-vector
// target extractor `extractBashTargets` — the best-effort string-parsing
// predicate over redirects/heredocs/tee/sed -i; (2) the path predicates
// (`isProtectedPath`, `isKeeperStatePath`); (3) the `decideWrongTreeGuard`
// decision ladder over a fake probe — the marker-gated inert-allow, the lane /
// non-lane / .keeper / protected split, and fail-open on an unresolvable target;
// (4) ONE real-fs `fsProbe` test proving the `.git`-boundary walk and nearest-
// ancestor realpath against a tmpdir repo+lane layout.

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectTargets,
  decideWrongTreeGuard,
  extractBashTargets,
  fsProbe,
  isKeeperStatePath,
  isProtectedPath,
  type TreeProbe,
  type WrongTreeGuardPayload,
} from "../plugins/keeper/plugin/hooks/wrong-tree-guard.ts";

// ---------------------------------------------------------------------------
// Tier 1 — extractBashTargets truth table
// ---------------------------------------------------------------------------

describe("extractBashTargets", () => {
  const cases: Array<{ cmd: string; targets: string[] }> = [
    // redirect targets
    { cmd: "echo x > /repo/src/a.ts", targets: ["/repo/src/a.ts"] },
    { cmd: "echo x >/repo/src/a.ts", targets: ["/repo/src/a.ts"] },
    { cmd: "echo x >> /repo/log.txt", targets: ["/repo/log.txt"] },
    { cmd: "echo x >| /repo/clobber", targets: ["/repo/clobber"] },
    { cmd: "cmd &> /repo/out", targets: ["/repo/out"] },
    { cmd: "cmd 2> /repo/err", targets: ["/repo/err"] },
    // fd-dup is NOT a file target
    { cmd: "cmd > /repo/out 2>&1", targets: ["/repo/out"] },
    { cmd: "cmd 2>&1", targets: [] },
    // heredoc: the redirect target is captured, the BODY is not re-parsed
    {
      cmd: "cat > /repo/src/x.ts <<EOF\nline one\nline two\nEOF",
      targets: ["/repo/src/x.ts"],
    },
    // a `>` INSIDE a heredoc body must NOT mint a spurious target
    {
      cmd: "cat > /repo/a.txt <<EOF\necho hi > /other/b.txt\nEOF",
      targets: ["/repo/a.txt"],
    },
    // tee (with and without -a), including piped
    { cmd: "tee /repo/f", targets: ["/repo/f"] },
    { cmd: "tee -a /repo/f", targets: ["/repo/f"] },
    { cmd: "echo x | tee /repo/f", targets: ["/repo/f"] },
    {
      cmd: "echo x | tee /repo/f1 /repo/f2",
      targets: ["/repo/f1", "/repo/f2"],
    },
    // sed -i variants — the inline-script positional is dropped, files kept
    { cmd: "sed -i 's/a/b/' /repo/f", targets: ["/repo/f"] },
    { cmd: "sed -i.bak 's/a/b/' /repo/f", targets: ["/repo/f"] },
    {
      cmd: "sed -i -e 's/a/b/' /repo/f1 /repo/f2",
      targets: ["/repo/f1", "/repo/f2"],
    },
    { cmd: "sed --in-place 's/a/b/' /repo/f", targets: ["/repo/f"] },
    // sed WITHOUT -i modifies nothing in place (the > out is a separate target)
    { cmd: "sed 's/a/b/' /repo/f > /repo/out", targets: ["/repo/out"] },
    // read redirect and here-string carry no write target
    { cmd: "cmd < /repo/in", targets: [] },
    { cmd: "cmd <<< data", targets: [] },
    // quoted `>` is literal, not an operator
    { cmd: 'echo "a > b"', targets: [] },
    { cmd: "echo 'x > /repo/nope'", targets: [] },
    // plain read-only commands
    { cmd: "git status", targets: [] },
    { cmd: "cat /repo/f", targets: [] },
    { cmd: "", targets: [] },
    // wrapper-stripped tee
    { cmd: "echo x | sudo tee /repo/f", targets: ["/repo/f"] },
    { cmd: "timeout 5 tee /repo/f", targets: ["/repo/f"] },
  ];
  for (const { cmd, targets } of cases) {
    test(`${JSON.stringify(cmd)} -> ${JSON.stringify(targets)}`, () => {
      expect(extractBashTargets(cmd)).toEqual(targets);
    });
  }
});

// ---------------------------------------------------------------------------
// Tier 2 — path predicates
// ---------------------------------------------------------------------------

describe("isProtectedPath", () => {
  const protectedPaths = [
    "/w/lane/.git/config",
    "/w/primary/.git/config",
    "/home/me/.git-credentials",
    "/home/me/.netrc",
    "/home/me/.ssh/id_rsa",
    "/home/me/.ssh/config",
    "/home/me/.aws/credentials",
  ];
  for (const p of protectedPaths) {
    test(`protected: ${p}`, () => expect(isProtectedPath(p)).toBe(true));
  }
  const okPaths = [
    "/w/lane/src/config.ts",
    "/w/lane/.gitignore",
    "/w/lane/.git/HEAD", // only .git/config is protected, not all of .git
    "/w/lane/config",
    "/home/me/.awsconfig",
  ];
  for (const p of okPaths) {
    test(`not protected: ${p}`, () => expect(isProtectedPath(p)).toBe(false));
  }
});

describe("isKeeperStatePath", () => {
  test("under <toplevel>/.keeper is plan state", () => {
    expect(
      isKeeperStatePath("/w/primary/.keeper/tasks/f.json", "/w/primary"),
    ).toBe(true);
    expect(isKeeperStatePath("/w/primary/.keeper", "/w/primary")).toBe(true);
  });
  test("a sibling directory named .keeperish is not", () => {
    expect(isKeeperStatePath("/w/primary/.keeperish/x", "/w/primary")).toBe(
      false,
    );
  });
  test("src is not plan state", () => {
    expect(isKeeperStatePath("/w/primary/src/x.ts", "/w/primary")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — decideWrongTreeGuard decision ladder (fake probe)
// ---------------------------------------------------------------------------

const LANE = "/w/lane";
const PRIMARY = "/w/primary";

/** A virtual repo layout: identity realpath (a sentinel resolves to null), and a
 *  longest-prefix `.git`-toplevel over a fixed set of repo roots. */
function fakeProbe(opts?: { unresolvable?: string[] }): TreeProbe {
  const unresolvable = new Set(opts?.unresolvable ?? []);
  const repos = [LANE, PRIMARY];
  return {
    realpath: (abs) => (unresolvable.has(abs) ? null : abs),
    repoToplevel: (resolved) => {
      let best: string | null = null;
      for (const r of repos) {
        if (resolved === r || resolved.startsWith(`${r}/`)) {
          if (best === null || r.length > best.length) best = r;
        }
      }
      return best;
    },
  };
}

const LANE_ENV = { KEEPER_PLAN_WORKTREE: LANE };

function writePayload(file: string): WrongTreeGuardPayload {
  return { tool_name: "Write", cwd: LANE, tool_input: { file_path: file } };
}
function bashPayload(command: string): WrongTreeGuardPayload {
  return { tool_name: "Bash", cwd: LANE, tool_input: { command } };
}

function decide(
  payload: WrongTreeGuardPayload,
  env: Record<string, string | undefined> = LANE_ENV,
) {
  return decideWrongTreeGuard(payload, env, fakeProbe());
}

describe("decideWrongTreeGuard — direct tools", () => {
  test("denies a Write into a non-lane tracked repo (deny-envelope shape)", () => {
    const d = decide(writePayload(`${PRIMARY}/src/x.ts`));
    expect(d).not.toBeNull();
    expect(d?.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(d?.hookSpecificOutput.permissionDecisionReason).toContain("lane");
    expect(d?.hookSpecificOutput.permissionDecisionReason).toContain(PRIMARY);
  });

  test("allows a Write into the worker's own lane", () => {
    expect(decide(writePayload(`${LANE}/src/x.ts`))).toBeNull();
  });

  test("allows a Write to plan state under the primary repo's .keeper", () => {
    expect(decide(writePayload(`${PRIMARY}/.keeper/tasks/f.json`))).toBeNull();
  });

  test("Edit and MultiEdit target file_path the same way", () => {
    const edit: WrongTreeGuardPayload = {
      tool_name: "Edit",
      cwd: LANE,
      tool_input: { file_path: `${PRIMARY}/src/x.ts` },
    };
    const multi: WrongTreeGuardPayload = {
      tool_name: "MultiEdit",
      cwd: LANE,
      tool_input: { file_path: `${PRIMARY}/src/x.ts` },
    };
    expect(decide(edit)?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decide(multi)?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(
      decide({ ...edit, tool_input: { file_path: `${LANE}/a.ts` } }),
    ).toBeNull();
  });

  test("a non-write tool (Read) is unaffected", () => {
    expect(
      decide({
        tool_name: "Read",
        cwd: LANE,
        tool_input: { file_path: `${PRIMARY}/x` },
      }),
    ).toBeNull();
  });

  test("allows a write outside every tracked repo (temp/scratch/home)", () => {
    expect(decide(writePayload("/tmp/scratch/x.txt"))).toBeNull();
  });
});

describe("decideWrongTreeGuard — protected denylist", () => {
  test("denies .git/config in the PRIMARY repo", () => {
    const d = decide(writePayload(`${PRIMARY}/.git/config`));
    expect(d?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(d?.hookSpecificOutput.permissionDecisionReason).toContain(
      "protected",
    );
  });
  test("denies .git/config in the worker's OWN lane (regardless of lane)", () => {
    expect(
      decide(writePayload(`${LANE}/.git/config`))?.hookSpecificOutput
        .permissionDecision,
    ).toBe("deny");
  });
  test("denies a credential-shaped path", () => {
    expect(
      decide(writePayload(`${PRIMARY}/.netrc`))?.hookSpecificOutput
        .permissionDecision,
    ).toBe("deny");
  });
});

describe("decideWrongTreeGuard — Bash write vectors", () => {
  const denied = [
    `echo x > ${PRIMARY}/src/x.ts`,
    `cat > ${PRIMARY}/src/x.ts <<EOF\nbody\nEOF`,
    `echo x | tee ${PRIMARY}/src/x.ts`,
    `sed -i 's/a/b/' ${PRIMARY}/src/x.ts`,
  ];
  for (const cmd of denied) {
    test(`denies: ${cmd.split("\n")[0]}`, () => {
      expect(
        decide(bashPayload(cmd))?.hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    });
  }
  test("allows a Bash write into the own lane", () => {
    expect(decide(bashPayload(`echo x > ${LANE}/notes.txt`))).toBeNull();
  });
  test("allows a read-only Bash command", () => {
    expect(decide(bashPayload(`grep -rn foo ${PRIMARY}/src`))).toBeNull();
  });
});

describe("decideWrongTreeGuard — jurisdiction and fail-open", () => {
  test("an UNMARKED session is entirely unaffected (allow-all)", () => {
    expect(decide(writePayload(`${PRIMARY}/src/x.ts`), {})).toBeNull();
  });
  test("an empty KEEPER_PLAN_WORKTREE is inert", () => {
    expect(
      decide(writePayload(`${PRIMARY}/src/x.ts`), { KEEPER_PLAN_WORKTREE: "" }),
    ).toBeNull();
  });
  test("a whitespace-only marker is inert", () => {
    expect(
      decide(writePayload(`${PRIMARY}/src/x.ts`), {
        KEEPER_PLAN_WORKTREE: "  ",
      }),
    ).toBeNull();
  });
  test("an unresolvable target fails OPEN (allow)", () => {
    const bad = `${PRIMARY}/nonexist/x.ts`;
    const d = decideWrongTreeGuard(
      writePayload(bad),
      LANE_ENV,
      fakeProbe({ unresolvable: [bad] }),
    );
    expect(d).toBeNull();
  });
  test("an unresolvable LANE fails OPEN (allow)", () => {
    const d = decideWrongTreeGuard(
      writePayload(`${PRIMARY}/src/x.ts`),
      LANE_ENV,
      fakeProbe({ unresolvable: [LANE] }),
    );
    expect(d).toBeNull();
  });
  test("a malformed payload fails OPEN (allow)", () => {
    expect(
      decideWrongTreeGuard(
        null as unknown as WrongTreeGuardPayload,
        LANE_ENV,
        fakeProbe(),
      ),
    ).toBeNull();
  });
});

describe("collectTargets", () => {
  test("Bash routes through the extractor; Write returns file_path", () => {
    expect(collectTargets(bashPayload("echo x > /a/b"))).toEqual(["/a/b"]);
    expect(collectTargets(writePayload("/a/b"))).toEqual(["/a/b"]);
    expect(
      collectTargets({ tool_name: "Read", tool_input: { file_path: "/a" } }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tier 4 — the real node:fs probe over a tmpdir repo+lane layout
// ---------------------------------------------------------------------------

describe("fsProbe (real filesystem)", () => {
  test("walks to the nearest .git boundary and resolves create-new paths", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "wrong-tree-")));
    try {
      // A primary-like repo (.git DIRECTORY) and a sibling lane (.git FILE).
      const repo = join(base, "repo");
      const lane = join(base, "lane");
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(repo, "src"), { recursive: true });
      mkdirSync(lane, { recursive: true });
      writeFileSync(
        join(lane, ".git"),
        "gitdir: /elsewhere/.git/worktrees/lane\n",
      );

      const probe = fsProbe();

      // A create-new file deep in the lane resolves via nearest existing ancestor.
      const newInLane = join(lane, "src", "new.ts");
      const resolvedLane = probe.realpath(newInLane);
      expect(resolvedLane).toBe(join(lane, "src", "new.ts"));
      expect(probe.repoToplevel(resolvedLane as string)).toBe(lane);

      // A file in the sibling repo walks up to the repo's .git DIRECTORY.
      const inRepo = join(repo, "src", "x.ts");
      const resolvedRepo = probe.realpath(inRepo) as string;
      expect(probe.repoToplevel(resolvedRepo)).toBe(repo);

      // A path outside any tracked repo has no toplevel.
      expect(probe.repoToplevel(base)).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("end-to-end decide with the real probe denies a foreign-tree write", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "wrong-tree-e2e-")));
    try {
      const repo = join(base, "repo");
      const lane = join(base, "lane");
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(lane, { recursive: true });
      writeFileSync(join(lane, ".git"), "gitdir: /elsewhere\n");
      const env = { KEEPER_PLAN_WORKTREE: lane };

      const foreign: WrongTreeGuardPayload = {
        tool_name: "Write",
        cwd: lane,
        tool_input: { file_path: join(repo, "src", "x.ts") },
      };
      expect(
        decideWrongTreeGuard(foreign, env, fsProbe())?.hookSpecificOutput
          .permissionDecision,
      ).toBe("deny");

      const own: WrongTreeGuardPayload = {
        tool_name: "Write",
        cwd: lane,
        tool_input: { file_path: join(lane, "src", "y.ts") },
      };
      expect(decideWrongTreeGuard(own, env, fsProbe())).toBeNull();

      const planState: WrongTreeGuardPayload = {
        tool_name: "Write",
        cwd: lane,
        tool_input: { file_path: join(repo, ".keeper", "tasks", "z.json") },
      };
      expect(decideWrongTreeGuard(planState, env, fsProbe())).toBeNull();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
