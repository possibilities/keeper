/**
 * SLOW real-tmux quarantine. Drives the actual `tmux/keeper-guard.conf` against
 * a throwaway `tmux -L <uniq>` server: the `.conf` is a static config fragment
 * whose whole contract IS tmux's own parsing of the three-level
 * `if-shell`/`confirm-before`/`-c "#{pane_current_path}"` quoting and the
 * indexed `session-created[42]` hook. There is no pure seam to extract — the
 * point is real-tmux behavior — so it is slow-quarantined out of the fast tier
 * (added to the `test` script's `--path-ignore-patterns`; `test:full` runs it).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const CONF = join(import.meta.dir, "..", "tmux", "keeper-guard.conf");
const SOCK = `keeperguard-${process.pid}-${Date.now()}`;

function tmux(...args: string[]): { code: number; stdout: string } {
  const r = Bun.spawnSync({
    cmd: ["tmux", "-L", SOCK, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stdout: r.stdout.toString().trim() };
}

let tmuxAvailable = true;

beforeAll(() => {
  const v = Bun.spawnSync({
    cmd: ["tmux", "-V"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (v.exitCode !== 0) {
    tmuxAvailable = false;
    return;
  }
  // Bootstrap a scratch session so the server exists, then source the .conf.
  tmux("-f", "/dev/null", "new-session", "-d", "-s", "scratch");
  const sourced = tmux("source-file", CONF);
  expect(sourced.code).toBe(0);
});

afterAll(() => {
  if (tmuxAvailable) {
    tmux("kill-server");
  }
});

describe("keeper-guard.conf real tmux", () => {
  test("stamps @keeper_managed_session=1 on a managed-named session", () => {
    if (!tmuxAvailable) return;
    tmux("new-session", "-d", "-s", "pair");
    const marker = tmux(
      "display-message",
      "-p",
      "-t",
      "=pair:",
      "#{@keeper_managed_session}",
    );
    expect(marker.stdout).toBe("1");
  });

  test("leaves a human-named session unstamped (empty marker)", () => {
    if (!tmuxAvailable) return;
    tmux("new-session", "-d", "-s", "myproj");
    const marker = tmux(
      "display-message",
      "-p",
      "-t",
      "=myproj:",
      "#{@keeper_managed_session}",
    );
    expect(marker.stdout).toBe("");
  });

  test("wraps the c and | create-keys in if-shell + confirm-before", () => {
    if (!tmuxAvailable) return;
    const cBind = tmux("list-keys", "-T", "prefix", "c").stdout;
    expect(cBind).toContain("if-shell -F");
    expect(cBind).toContain("@keeper_managed_session");
    expect(cBind).toContain("confirm-before");
    expect(cBind).toContain("new-window");

    const pipeBind = tmux("list-keys", "-T", "prefix", "|").stdout;
    expect(pipeBind).toContain("if-shell -F");
    expect(pipeBind).toContain("confirm-before");
  });

  test("the | else-branch is the byte-identical unwrapped split command", () => {
    if (!tmuxAvailable) return;
    const pipeBind = tmux("list-keys", "-T", "prefix", "|").stdout;
    // The non-managed (else) branch must run the human's command verbatim, so a
    // human session behaves exactly as splitting.conf binds it.
    expect(pipeBind).toContain(`"split-window -h -c '#{pane_current_path}'"`);
  });
});
