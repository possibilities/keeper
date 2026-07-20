import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactKeeperLane,
  type GitResult,
  HELP,
  renderStatusline,
} from "../cli/statusline";
import { runSink, type StatuslineLeaf } from "../cli/statusline-sink";

const LANE_GLYPH = "⑂";
const SEP = "∕";
const NETWORK_GLYPH = "";

function stripAnsi(s: string): string {
  const esc = String.fromCharCode(27);
  return s.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

function payload(
  projectDir = "/Users/test/code/keeper",
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: "sess-abc",
    context_window: {
      used_percentage: 12.6,
      total_input_tokens: 85000,
      context_window_size: 200000,
    },
    workspace: { project_dir: projectDir },
    version: "2.1.204",
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    effort: { level: "xhigh" },
    ...overrides,
  });
}

function fakeGit(projectName = "keeper", branch = "main", diff = "") {
  return (_projectDir: string, args: string[]): GitResult => {
    if (args.join(" ") === "branch --show-current") {
      return { returncode: 0, stdout: `${branch}\n` };
    }
    if (
      args.join(" ") === "rev-parse --path-format=absolute --git-common-dir"
    ) {
      return {
        returncode: 0,
        stdout: `/Users/test/code/${projectName}/.git\n`,
      };
    }
    if (args.join(" ") === "diff --shortstat") {
      return { returncode: 0, stdout: diff };
    }
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
}

describe("statusline render", () => {
  test("uses the soft slash separator and omits a sole account", () => {
    const plain = stripAnsi(
      renderStatusline(payload("/Users/test/code/jobsearch"), {
        env: { KEEPER_ACCOUNT_ROUTE: "default" },
        cwd: "/Users/test/code/jobsearch",
        palette: null,
        runGit: fakeGit("jobsearch"),
      }),
    );

    expect(plain).toBe(
      `13 ${SEP} jobsearch ${SEP} main ${SEP} opus 4.8 ${SEP} xhigh ${SEP} 2.1.204`,
    );
    expect(plain).not.toContain("❘");
    expect(plain).not.toContain("·");
  });

  test("compacts keeper rib lanes and splits dirty diff into its own segment", () => {
    const projectDir =
      "/Users/test/worktrees/keeper-qzvs8i--keeper-epic-" +
      "fn-1193-durable-plan-id-reservation--" +
      "fn-1193-durable-plan-id-reservation.5";
    const branch =
      "keeper/epic/fn-1193-durable-plan-id-reservation--" +
      "fn-1193-durable-plan-id-reservation.5";
    const plain = stripAnsi(
      renderStatusline(payload(projectDir), {
        env: { KEEPER_PLAN_WORKTREE_BRANCH: branch },
        cwd: projectDir,
        palette: null,
        runGit: fakeGit(
          "keeper",
          "ignored",
          "1 file changed, 309 insertions(+), 9 deletions(-)\n",
        ),
      }),
    );

    expect(plain).toContain(`keeper ${SEP} ${LANE_GLYPH} fn-1193.5`);
    expect(plain).toContain(`${LANE_GLYPH} fn-1193.5 ${SEP} +309−9`);
    expect(plain).toContain(`opus 4.8 ${SEP} xhigh ${SEP} 2.1.204`);
    expect(plain).not.toContain("keeper/epic/");
    expect(plain).not.toContain("keeper-qzvs8i");
    expect(plain).not.toContain("durable-plan-id-reservation");
    expect(plain).not.toContain("·");
  });

  test("network and Claude inventory ordinal ride in the final version segment", () => {
    const plain = stripAnsi(
      renderStatusline(payload(), {
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9123",
          KEEPER_ACCOUNT_ROUTE: "claude-swap:17",
          KEEPER_ACCOUNT_ORDINAL: "1",
        },
        cwd: "/Users/test/code/keeper",
        palette: null,
        runGit: fakeGit("keeper"),
      }),
    );

    expect(plain.endsWith(`2.1.204 ${NETWORK_GLYPH} ${SEP} claude-2`)).toBe(
      true,
    );
  });

  test("renders one-based Claude account positions from validated inventory ordinals, never route slots", () => {
    for (const [ordinal, position] of [
      ["0", "1"],
      ["1", "2"],
      ["2", "3"],
    ]) {
      const plain = stripAnsi(
        renderStatusline(payload(), {
          env: {
            KEEPER_ACCOUNT_ROUTE: "claude-swap:99",
            KEEPER_ACCOUNT_ORDINAL: ordinal,
          },
          cwd: "/Users/test/code/keeper",
          palette: null,
          runGit: fakeGit("keeper"),
        }),
      );
      expect(plain.endsWith(`2.1.204 ${SEP} claude-${position}`)).toBe(true);
      expect(plain).not.toContain("claude-99");
    }
  });

  test("an absent or invalid ordinal renders no account segment and never inspects account-like env", () => {
    // No valid KEEPER_ACCOUNT_ORDINAL carrier — the launcher supplied none. The
    // label resolves to "" and the version segment ends at the version, with no
    // trailing account chunk. Route/profile env is NEVER inferred as a label.
    const plain = stripAnsi(
      renderStatusline(payload(), {
        env: {
          KEEPER_ACCOUNT_ROUTE: "claude-swap:2",
          KEEPER_ACCOUNT_ORDINAL: "-1",
          CLAUDE_CONFIG_DIR: "/Users/test/.claude-profiles/multi-claude-2",
          KEEPER_AGENT_CLAUDE_PROFILE: "multi-claude-2",
        },
        cwd: "/Users/test/code/keeper",
        palette: null,
        runGit: fakeGit("keeper"),
      }),
    );
    expect(plain.endsWith("2.1.204")).toBe(true);
    expect(plain).not.toContain("multi-claude-2");
    expect(plain).not.toContain("claude-2");
  });

  test("help is a non-empty machine-command description", () => {
    expect(HELP).toContain("keeper statusline");
    expect(HELP).toContain("Machine-invoked");
  });
});

describe("statusline capture", () => {
  test("one command payload still writes the telemetry leaf", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-statusline-render-"));
    const res = runSink(payload(), dir, 123);
    expect(res.wrote).toBe(true);
    expect(existsSync(join(dir, "sess-abc.json"))).toBe(true);
    const leaf = JSON.parse(
      readFileSync(join(dir, "sess-abc.json"), "utf8"),
    ) as StatuslineLeaf;
    expect(leaf.model_display).toBe("Opus 4.8");
    expect(leaf.effort).toBe("xhigh");
  });
});

describe("keeper plugin statusline settings", () => {
  test("keeper plugin ships the statusLine command", () => {
    const settings = JSON.parse(
      readFileSync("plugins/keeper/settings.json", "utf8"),
    ) as { statusLine?: { type?: string; command?: string } };
    expect(settings.statusLine).toEqual({
      type: "command",
      command: "keeper statusline",
    });
  });

  test("lane compaction keeps task ordinals", () => {
    expect(compactKeeperLane("keeper/epic/fn-1193-long")).toBe(
      `${LANE_GLYPH} fn-1193`,
    );
    expect(compactKeeperLane("keeper/epic/fn-1193-long--fn-1193-long.5")).toBe(
      `${LANE_GLYPH} fn-1193.5`,
    );
  });
});
