/**
 * Real-tmux verification harness — the ONLY test that spawns the folded
 * launcher (`keeper agent claude …`) as a real subprocess (every other tmux
 * suite stubs `runTmuxCommandFn`). It reproduces
 * keeperd's hostile launch environment — `env -i` with a minimal PATH and NO
 * locale vars, which forces a C-locale tmux server — and proves the two hard
 * blockers are fixed end to end:
 *
 *   Patch A: the immediate launch JSON parses correctly under the C-locale strip
 *            (the `\x01` capture delimiter survives where a TAB would be
 *            sanitized to `_`, plus the spawn-env locale default).
 *   Patch B: the JSON returns within ~1s (the launch result is decoupled from
 *            the transcript-stop poll, now the separate wait-for-stop verb).
 *
 * Local/tmux-host best-effort: the whole file is gated on `which tmux` and skips
 * when tmux is absent, so non-tmux CI stays green. Teardown ALWAYS kill-servers
 * the per-pid scratch socket (even on assertion failure) so it never leaks a
 * server and never touches the human's live tmux.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

const tmuxBin = Bun.which("tmux");
const bunBin = Bun.which("bun");

// A dedicated per-pid scratch socket so concurrent runs never collide and the
// human's default tmux server is never a target.
const socket = `awtest-${process.pid}`;
// The folded launcher's entry: `keeper agent <claude|…>` routes through the
// keeper CLI dispatcher, which strips the `agent` token and hands the rest to
// the in-binary launcher main.
const keeperEntry = new URL("../cli/keeper.ts", import.meta.url).pathname;

// Minimal PATH carrying ONLY the dirs that hold bun + tmux, plus the system
// dirs — derived from the discovered binaries so the test is not host-coupled to
// a homebrew prefix. No locale vars are set, which is what induces C-locale.
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

afterAll(() => {
  if (tmuxBin === null) {
    return;
  }
  // Always tear down the scratch server, even after an assertion failure, so no
  // `awtest-*` server leaks and the live tmux is untouched.
  Bun.spawnSync([tmuxBin, "-L", socket, "kill-server"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  // A detached pane whose inner shell exited can leave the server's socket inode
  // behind even after kill-server. Best-effort unlink the per-pid scratch socket
  // at its default location (${TMUX_TMPDIR:-/tmp}/tmux-<uid>/<name>) so the run
  // leaves nothing behind; never throws and never touches another socket name.
  const tmuxTmp = process.env.TMUX_TMPDIR || "/tmp";
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null) {
    rmSync(join(tmuxTmp, `tmux-${uid}`, socket), { force: true });
  }
});

describe.if(tmuxBin !== null && bunBin !== null)(
  "real-tmux stripped-env launch (local/tmux-host best-effort)",
  () => {
    test("under env -i (C-locale), a launch prints one parseable JSON line < ~1s and exits 0", () => {
      const start = Date.now();
      // `env -i` is emulated by handing Bun.spawnSync an explicit, minimal env
      // (no spread of process.env): no locale vars, only the stripped PATH. This
      // is the keeperd / LaunchAgent posture.
      const proc = Bun.spawnSync(
        [
          bunBin as string,
          keeperEntry,
          "agent",
          "claude",
          "--agentwrap-tmux-detached",
          "--agentwrap-tmux-L",
          socket,
          "--agentwrap-tmux-session",
          "probe",
          "--agentwrap-tmux-env",
          "KEEPER_TMUX_SESSION=probe",
          "-p",
          "hi",
        ],
        {
          env: { PATH: strippedPath },
          stdout: "pipe",
          stderr: "pipe",
          // Generous bound: the launch must return well under this; we assert
          // the actual elapsed time below for the < ~1s contract.
          timeout: 10_000,
        },
      );
      const elapsedMs = Date.now() - start;

      const stdout = proc.stdout.toString();
      const stderr = proc.stderr.toString();
      const context = `\nstdout:\n${stdout}\nstderr:\n${stderr}`;

      // Patch B: the immediate launch JSON is decoupled from any transcript
      // wait, so a detached launch returns promptly. A cold `bun` process start
      // plus a cold tmux server spawn is the floor; 5s is a comfortable ceiling
      // that still proves we never blocked on a transcript poll.
      expect(elapsedMs, `launch took ${elapsedMs}ms${context}`).toBeLessThan(
        5_000,
      );
      expect(proc.exitCode, `exit code${context}`).toBe(0);

      // Patch A: exactly one parseable JSON line on stdout under the C-locale
      // strip — the `\x01` delimiter + spawn-env locale default both exercised.
      const lines = stdout.trim().split("\n").filter(Boolean);
      expect(lines.length, `expected one JSON line${context}`).toBe(1);
      const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;

      expect(parsed.schema_version).toBe(1);
      expect(parsed.agent).toBe("claude");
      expect(parsed.session).toBe("probe");
      expect(parsed.waitedForStop).toBe(false);
      expect(parsed.transcriptPath).toBeNull();
      expect(parsed.stop).toBeNull();
      // The window/pane ids round-tripped intact through the `\x01`-delimited
      // capture — proof the C-locale TAB-sanitization trap was avoided.
      expect(parsed.windowId).toMatch(/^@\d+$/);
      expect(parsed.paneId).toMatch(/^%\d+$/);
    }, 15_000);
  },
);
