/**
 * Keeper-spawned worker/resume panes run `cd <dir> && claude …` through
 * interactive zsh; whenever the target dir is not exactly two levels under home
 * the cwd gate would block on a keystroke and hang the pane.
 * `--x-no-confirm` suppresses that gate at every depth. The contract:
 * (1) with the flag in a non-project cwd the cwd check never runs, (2) the flag
 * is stripped from the claude argv, (3) without the flag the check still runs.
 *
 * The Python harness replaced `_check_cwd_in_project_root` with a recorder; here
 * the check is `checkCwdInProjectRoot`, which (in a non-project cwd) writes a
 * "not a project directory" warning to stdout — its presence on the out sink is
 * the run/skip detector. PWD is forced to a non-depth-2 path (the gate reads the
 * shell's logical $PWD, not deps.cwd). The flag is consumed by parseArgs before
 * remainingArgs is built, so it can never reach the spawned command.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { main } from "../src/agent/main";
import { makeHarness, runAndCapture } from "./helpers/agent-main-harness";

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  // Restore the env OBJECT reference (not just keys) so a stray mutation in
  // main() (KEEPER_ACCOUNT_ROUTE / CLAUDE_CODE_DISABLE_AUTO_MEMORY writes) never leaks.
  savedEnv = process.env;
});
afterEach(() => {
  process.env = savedEnv;
});

// A path that is NOT exactly two components under the real home → the cwd gate
// would warn (and, without the flag, prompt). /tmp is outside home (depth 0).
const NON_PROJECT_PWD = "/tmp/keeper-pane-deep/worker";

function ranCwdCheck(out: string[]): boolean {
  return out.some((s) => s.includes("not a project directory"));
}

describe("--x-no-confirm", () => {
  test("skips the cwd check in a non-project cwd", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "hello"],
      env: { PWD: NON_PROJECT_PWD },
    });
    await runAndCapture(h, main);
    expect(ranCwdCheck(h.out)).toBe(false);
  });

  test("strips the flag from the claude command", async () => {
    const h = makeHarness({
      argv: ["--x-no-confirm", "hello"],
      env: { PWD: NON_PROJECT_PWD },
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).not.toContain("--x-no-confirm");
  });

  test("without the flag the cwd check still runs (behavior unchanged)", async () => {
    // readChar returns "y" so the warned gate continues to Popen instead of
    // exiting 1 — we only need to observe that the check ran.
    const h = makeHarness({
      argv: ["hello"],
      env: { PWD: NON_PROJECT_PWD },
    });
    h.deps.readChar = () => "y";
    await runAndCapture(h, main);
    expect(ranCwdCheck(h.out)).toBe(true);
  });
});
