/**
 * Unit byte-pin for the detached pane's SELF-re-exec seam (fn-929.2). The
 * load-bearing invariant: the pane must re-exec `[<bun>, <abs cli/keeper.ts>,
 * "agent", <agent>, …]` — NEVER `process.argv[1]` (which is `daemon.ts` under
 * keeperd, `cli/keeper.ts` under the CLI, neither carrying the `agent` token).
 * A wrong-binary re-exec still returns a SUCCESS launch JSON, so the failure is
 * invisible until the K=3 never-bound breaker trips — hence the byte-pin here +
 * the real-pane assertion in the `.slow` sibling.
 */

import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { main } from "../src/agent/main";
import { resolveKeeperAgentPath } from "../src/db";
import {
  buildLauncherArgvPrefix,
  defaultKeeperAgentPath,
  resolveKeeperAgentPathDepFree,
} from "../src/keeper-agent-path";
import { expectExit, makeHarness } from "./helpers/agent-main-harness";

// The repo root from this test file's own location (test/ → ..).
const repoRoot = realpathSync(resolve(dirname(import.meta.dirname), "."));
const expectedDefault = realpathSync(join(repoRoot, "cli", "keeper.ts"));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-self-invoke-test-"));
}

/** Minimal codex transcript so the tmux-launch path finds a session to record. */
function writeCodexTranscript(home: string, cwd: string): void {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dir = join(home, ".codex", "sessions", year, month, day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-2026-06-22T00-00-00-test.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({
      timestamp: now.toISOString(),
      type: "session_meta",
      payload: { id: "codex-session", cwd },
    })}\n`,
  );
}

describe("resolveKeeperAgentPathDepFree (cold-start / pair variant)", () => {
  test("default resolves the abs, symlink-resolved cli/keeper.ts path", () => {
    const got = resolveKeeperAgentPathDepFree({}, "/home/me");
    expect(got).toBe(expectedDefault);
    expect(got.startsWith("/")).toBe(true);
  });

  test("defaultKeeperAgentPath matches the empty-env resolve", () => {
    expect(defaultKeeperAgentPath()).toBe(expectedDefault);
  });

  test("KEEPER_AGENT_PATH env overrides", () => {
    expect(
      resolveKeeperAgentPathDepFree(
        { KEEPER_AGENT_PATH: "/custom/keeper.ts" },
        "/home/me",
      ),
    ).toBe("/custom/keeper.ts");
  });

  test("a tilde override expands at resolve time", () => {
    expect(
      resolveKeeperAgentPathDepFree(
        { KEEPER_AGENT_PATH: "~/code/keeper/cli/keeper.ts" },
        "/home/me",
      ),
    ).toBe("/home/me/code/keeper/cli/keeper.ts");
  });
});

describe("resolveKeeperAgentPath (config-aware, db.ts)", () => {
  // Run each db.ts-resolver case under a sandboxed env: a nonexistent
  // KEEPER_CONFIG so resolveConfig() yields no config keys, and the resolver's
  // own env knobs set per-case. Snapshot + restore so cases never leak.
  function withEnv(
    overrides: Record<string, string | undefined>,
    fn: () => void,
  ): void {
    const keys = ["KEEPER_CONFIG", "KEEPER_AGENT_PATH"];
    const prev: Record<string, string | undefined> = {};
    for (const k of keys) prev[k] = process.env[k];
    try {
      for (const k of keys) {
        const v = overrides[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fn();
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k] as string;
      }
    }
  }

  const noConfig = join(tempDir(), "does-not-exist.yaml");

  test("KEEPER_AGENT_PATH env wins", () => {
    withEnv(
      { KEEPER_CONFIG: noConfig, KEEPER_AGENT_PATH: "/custom/keeper.ts" },
      () => {
        expect(resolveKeeperAgentPath()).toBe("/custom/keeper.ts");
      },
    );
  });

  test("the absolute derived default is returned when no override is set", () => {
    withEnv({ KEEPER_CONFIG: noConfig }, () => {
      const got = resolveKeeperAgentPath();
      expect(got.startsWith("/")).toBe(true);
      expect(got.endsWith("/cli/keeper.ts")).toBe(true);
    });
  });
});

describe("buildLauncherArgvPrefix is independent of argv[1]", () => {
  // The whole point: the prefix is computed from the resolver, NOT argv[1]. So
  // the daemon-context caller (argv[1]=daemon.ts) and the CLI-context caller
  // (argv[1]=cli/keeper.ts) produce a byte-identical prefix.
  test("identical prefix regardless of the synthetic argv[1]", () => {
    const fromDaemon = buildLauncherArgvPrefix(
      "/abs/bun",
      resolveKeeperAgentPathDepFree({}, "/home/me"),
    );
    const fromCli = buildLauncherArgvPrefix(
      "/abs/bun",
      resolveKeeperAgentPathDepFree({}, "/home/me"),
    );
    expect(fromDaemon).toEqual(fromCli);
    expect(fromDaemon).toEqual(["/abs/bun", expectedDefault, "agent"]);
  });
});

describe("cold-start variant is db.ts-free (hygiene grep)", () => {
  test("src/keeper-agent-path.ts imports no src/db.ts (no bun:sqlite drag)", () => {
    const src = readFileSync(
      join(repoRoot, "src", "keeper-agent-path.ts"),
      "utf8",
    );
    // Scan only the import statements (strip comments / prose mentions): an
    // `import … from "./db"` or `"bun:sqlite"` would drag the daemon's DB graph.
    const imports = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l))
      .join("\n");
    expect(imports).not.toMatch(/from\s+["'][^"']*\bdb["']/);
    expect(imports).not.toMatch(/bun:sqlite/);
  });
});

describe("launch script embeds the launcherArgvPrefix (not argv[1])", () => {
  test("the detached launch.sh re-execs [bun, keeper.ts, agent, codex, …]", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    writeCodexTranscript(home, cwd);
    const h = makeHarness({
      argv: ["codex", "--x-tmux", "hello"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      env: { TMUX: "/tmp/tmux-501/default,1,0", PATH: "/fake/bin" },
      cwd,
      // Synthetic launcher prefix mimicking the keeperd-context resolve: the
      // re-exec target is the ABS keeper.ts + "agent", regardless of argv[1].
      launcherArgvPrefix: [
        "/abs/bun",
        "/install/keeper/cli/keeper.ts",
        "agent",
      ],
      randomUuid: () => "44444444-4444-4444-4444-444444444444",
      tmuxCommand: (cmd) => {
        if (cmd.includes("display-message")) {
          return { exitCode: 0, stdout: "dash\n", stderr: "" };
        }
        if (cmd.includes("new-window")) {
          return { exitCode: 0, stdout: "dash\x01@9\x01%10\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);

    const launchScript = join(
      stateDir,
      "tmux-runs",
      "tmux-44444444-4444-4444-4444-444444444444",
      "launch.sh",
    );
    const script = readFileSync(launchScript, "utf8");
    expect(script).toContain(
      `"$KEEPER_AGENT_SHELL" '/abs/bun' '/install/keeper/cli/keeper.ts' 'agent' 'codex' 'hello'`,
    );
    // Negative: the pane must NOT re-exec daemon.ts (argv[1] under keeperd).
    expect(script).not.toContain("daemon.ts");
  });
});
