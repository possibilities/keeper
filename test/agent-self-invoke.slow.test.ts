/**
 * Real-tmux integration for the detached pane SELF-re-exec seam (fn-929.2). This
 * is the test the risk note demands: a wrong-binary re-exec (daemon.ts / an
 * external agentwrap / a relative path) still returns a SUCCESS launch JSON, so
 * the regression is invisible until the K=3 never-bound breaker trips. So we
 * spawn a REAL detached `keeper agent claude` launch, read back the ACTUAL pane
 * launch script, and assert it re-execs `[<bun>, <abs cli/keeper.ts>, "agent",
 * "claude", …]` — never argv[1].
 *
 * Two proofs:
 *  1. The default (no KEEPER_AGENT_PATH) embeds the REAL resolved cli/keeper.ts —
 *     an absolute path ending in `/cli/keeper.ts`, with the `agent` token, NOT
 *     `daemon.ts` and NOT an `agentwrap` binary.
 *  2. With KEEPER_AGENT_PATH set to a sentinel, the embed uses the SENTINEL —
 *     proof the re-exec target comes from the resolver, INDEPENDENT of the live
 *     argv[1] (the same byte-identical prefix whether keeperd or the CLI spawns).
 *
 * Local/tmux-host best-effort: gated on `which tmux` + `which bun`; skips when
 * absent so non-tmux CI stays green. Teardown ALWAYS kill-servers the per-pid
 * scratch socket so it never leaks a server or touches the human's live tmux.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmuxBin = Bun.which("tmux");
const bunBin = Bun.which("bun");

const socket = `awselftest-${process.pid}`;
// The folded launcher's entry — the REAL cli/keeper.ts the resolver should
// derive when KEEPER_AGENT_PATH is unset.
const keeperEntry = new URL("../cli/keeper.ts", import.meta.url).pathname;

// Minimal PATH carrying only bun + tmux + system dirs (the keeperd / LaunchAgent
// posture: no `~/.bun/bin`). Derived from the discovered binaries.
const strippedPath = Array.from(
  new Set(
    [
      bunBin ? dirname(bunBin) : null,
      tmuxBin ? dirname(tmuxBin) : null,
      "/usr/bin",
      "/bin",
    ].filter((p): p is string => p !== null),
  ),
).join(":");

function killScratchServer(): void {
  if (tmuxBin === null) return;
  try {
    Bun.spawnSync([tmuxBin, "-L", socket, "kill-server"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // best-effort
  }
  const tmuxTmp = process.env.TMUX_TMPDIR || "/tmp";
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null) {
    rmSync(join(tmuxTmp, `tmux-${uid}`, socket), { force: true });
  }
}

afterAll(killScratchServer);

/** Spawn a detached `keeper agent claude` launch on the scratch socket and
 *  return the parsed launch JSON. `extraEnv` augments the stripped env. */
function launchDetached(
  stateDir: string,
  extraEnv: Record<string, string> = {},
): Record<string, unknown> {
  const proc = Bun.spawnSync(
    [
      bunBin as string,
      keeperEntry,
      "agent",
      "claude",
      "--agentwrap-tmux-detached",
      "--agentwrap-no-confirm",
      "--agentwrap-tmux-L",
      socket,
      "--agentwrap-tmux-session",
      "selfprobe",
      "-p",
      "hi",
    ],
    {
      env: {
        PATH: strippedPath,
        // The launcher derives its run-artifact dir from XDG_STATE_HOME →
        // <stateDir>/agentwrap; a per-test dir keeps the launch.sh isolated.
        XDG_STATE_HOME: stateDir,
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  const context = `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
  expect(proc.exitCode, `exit code${context}`).toBe(0);
  const lines = stdout.trim().split("\n").filter(Boolean);
  expect(lines.length, `expected one JSON line${context}`).toBe(1);
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

describe.if(tmuxBin !== null && bunBin !== null)(
  "real-tmux self-invoke re-exec (local/tmux-host best-effort)",
  () => {
    test("the detached pane re-execs the REAL resolved cli/keeper.ts + agent token", () => {
      const stateDir = mkdtempSync(join(tmpdir(), "self-invoke-default-"));
      const parsed = launchDetached(stateDir);

      expect(parsed.schema_version).toBe(1);
      expect(parsed.agent).toBe("claude");

      const launchScript = parsed.launchScript as string;
      expect(typeof launchScript, "launchScript path present").toBe("string");
      const script = readFileSync(launchScript, "utf8");

      // The load-bearing assertion: the embedded re-exec is
      // `<bun> <abs cli/keeper.ts> agent claude …`. We assert the keeper.ts
      // entry, the `agent` token, and the agent — in order — appear quoted.
      expect(script).toContain(`'${keeperEntry}' 'agent' 'claude'`);
      // Negative guards against the silent wrong-binary regressions.
      expect(script).not.toContain("daemon.ts");
      expect(script).not.toMatch(/agentwrap(\.ts|\b)['"]? 'claude'/);
    }, 15_000);

    test("KEEPER_AGENT_PATH overrides the re-exec target (proves it's argv[1]-independent)", () => {
      const stateDir = mkdtempSync(join(tmpdir(), "self-invoke-override-"));
      const sentinel = "/sentinel/abs/keeper.ts";
      const parsed = launchDetached(stateDir, {
        KEEPER_AGENT_PATH: sentinel,
      });

      const launchScript = parsed.launchScript as string;
      const script = readFileSync(launchScript, "utf8");
      // The embed uses the SENTINEL, not the live argv[1] (the real keeper.ts).
      expect(script).toContain(`'${sentinel}' 'agent' 'claude'`);
      expect(script).not.toContain(`'${keeperEntry}' 'agent'`);
    }, 15_000);
  },
);
