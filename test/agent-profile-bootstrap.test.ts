/**
 * main()-driving launch-composition pins. There is no Keeper-owned profile farm
 * (retired — see test/agent-state-sharing.test.ts for the surviving
 * global-instruction-guard leaf behaviors): `--x-profile` and
 * `KEEPER_AGENT_PROFILE` no longer create or select a profile dir or bypass the
 * account router for Claude. The resolved claude-swap account supplies
 * `CLAUDE_CONFIG_DIR`; Pi carries no automatic profile selection. This file
 * pins those boundaries plus the launch
 * composition assertions that happen to live alongside them (model override,
 * session env scrub, session-id/name auto-append suppression) via the MainDeps
 * harness: the spawn recorder captures the composed command and the state
 * collaborators are stubbed through the seams (no mock.module).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PresetCatalog } from "../src/agent/config";
import { main } from "../src/agent/main";
import {
  expectExit,
  flagValues,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

let savedEnv: NodeJS.ProcessEnv;
let tmpDir: string;
let home: string;

beforeEach(() => {
  savedEnv = process.env;
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-bootstrap-"));
  home = join(tmpDir, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  process.env = savedEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

const ACCOUNT_CONFIG = "/fake-home/.claude-swap/sessions/1-account";

describe("main() passthrough commands", () => {
  test("a profiled `auth status` passes through without session flags", async () => {
    const h = makeHarness({
      argv: ["--x-profile", "multi-claude-1", "auth", "status"],
      env: {},
      homeBin: join(home, ".local", "bin", "claude"),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      "/fake-home/.local/bin/cswap",
      "run",
      "1",
      "--share-history",
      "--",
      "auth",
      "status",
    ]);
    expect(cmd).not.toContain("--strict-mcp-config");
    expect(cmd).not.toContain("--session-id");
    expect(cmd).not.toContain("--name");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBe(ACCOUNT_CONFIG);
  });

  test("global flags and subcommands pass through the mandatory account route", async () => {
    const h = makeHarness({
      argv: ["--debug", "auth", "status"],
      env: {},
      homeBin: join(home, ".local", "bin", "claude"),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      "/fake-home/.local/bin/cswap",
      "run",
      "1",
      "--share-history",
      "--",
      "--debug",
      "auth",
      "status",
    ]);
    expect(h.routerCalls()).toBe(1);
  });
});

// There is no Keeper-owned profile farm for Claude OR Pi. Every Claude launch
// (auto, --x-profile, --resume) routes through the account router unconditionally;
// Pi carries no automatic profile selection replacement — it always runs
// against its one canonical account.
describe("main() has no profile farm — Claude always routes, Pi always native", () => {
  test("an unpinned Claude launch routes via the account router", async () => {
    const h = makeHarness({ argv: ["--print"], env: {} });
    expect((await runAndCapture(h, main)).length).toBeGreaterThan(0);
    expect(h.routerCalls()).toBe(1);
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBe(ACCOUNT_CONFIG);
  });

  test("an explicit --x-profile still routes via the account router (no effect)", async () => {
    const h = makeHarness({
      argv: ["--x-profile", "multi-claude-1", "--print"],
      env: {},
    });
    await runAndCapture(h, main);
    expect(h.routerCalls()).toBe(1);
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBe(ACCOUNT_CONFIG);
  });

  test("KEEPER_AGENT_PROFILE env is no longer read — the router still runs unconditionally", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: { KEEPER_AGENT_PROFILE: "multi-claude-2" },
    });
    await runAndCapture(h, main);
    expect(h.routerCalls()).toBe(1);
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBe(ACCOUNT_CONFIG);
  });

  test("--resume routes via the account router after shared-state setup", async () => {
    const sessionId = "d64ccaef-beac-4647-933b-db0d6b81704d";
    const h = makeHarness({
      argv: ["--resume", sessionId, "--print"],
      env: {},
    });
    const cmd = await runAndCapture(h, main);
    expect(h.routerCalls()).toBe(1);
    // Resume carries its own session posture — no wrapper --model injected.
    expect(cmd).not.toContain("--model");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBe(ACCOUNT_CONFIG);
  });

  test("Pi has no automatic profile selection — it always launches natively", async () => {
    const h = makeHarness({
      argv: ["--print"],
      agent: "pi",
      env: {},
    });
    await runAndCapture(h, main);
    expect(h.routerCalls()).toBe(0);
    expect(h.deps.env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  test("an explicit Pi --x-profile has no effect — no PI_CODING_AGENT_DIR, no dir created", async () => {
    const h = makeHarness({
      argv: ["--x-profile", "work", "--print"],
      agent: "pi",
      env: {},
    });
    await runAndCapture(h, main);
    expect(h.deps.env.PI_CODING_AGENT_DIR).toBeUndefined();
  });
});

describe("main() Claude session env scrub", () => {
  test("fresh launches drop inherited Claude session identity env", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: {
        CLAUDE_CODE_SESSION_ID: "parent-session",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      },
    });

    await runAndCapture(h, main);

    expect(h.deps.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(h.deps.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(h.deps.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE).toBe("1");
    expect(h.deps.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });
});

// ── model/effort startup overrides through main() ───────────────────────────

describe("main() model override", () => {
  /** A claude_default triple pinning the given model + effort. */
  const claudeDefaultCatalog = (
    model: string,
    effort: string,
  ): PresetCatalog => ({
    presets: {},
    claude_default: { harness: "claude", model, effort },
  });

  test("forwards the configured default model for an interactive launch", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: {},
      presetCatalog: claudeDefaultCatalog("fable", "high"),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd.filter((a) => a === "--model")).toHaveLength(1);
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("fable");
  });

  test("a fresh launch with no default resolvable is fail-loud (exit 2)", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: {},
      presetCatalog: { presets: {} },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.spawned.length).toBe(0);
  });

  test("preserves an explicit --model over the configured default", async () => {
    const h = makeHarness({
      argv: ["--print", "--model", "sonnet", "--effort", "xhigh"],
      env: {},
      presetCatalog: claudeDefaultCatalog("fable", "high"),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd.filter((a) => a === "--model")).toHaveLength(1);
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("sonnet");
  });
});

// ── session-flag auto-append: joined forms must suppress like split forms ────

// A real project dir two levels under the OS home → the cwd gate passes
// silently (it reads the shell PWD against homedir()).
const PROJECT_PWD = join(homedir(), "code", "proj");

/** A fresh launch (prompt, no continuation) with the given extra args. */
function freshLaunch(extra: string[]): ReturnType<typeof makeHarness> {
  return makeHarness({
    argv: [...extra, "hello world"],
    env: { PWD: PROJECT_PWD },
  });
}

describe("session-id + name auto-append suppression", () => {
  test("a bare fresh launch appends exactly one --session-id and one --name", async () => {
    const cmd = await runAndCapture(freshLaunch([]), main);
    expect(flagValues(cmd, "--session-id")).toEqual([
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(flagValues(cmd, "--name").length).toBe(1);
  });

  test("--session-id=X (joined) suppresses the appended --session-id", async () => {
    const cmd = await runAndCapture(freshLaunch(["--session-id=abc"]), main);
    expect(flagValues(cmd, "--session-id")).toEqual(["abc"]);
  });

  test("--session-id X (split) suppresses the appended --session-id", async () => {
    const cmd = await runAndCapture(freshLaunch(["--session-id", "abc"]), main);
    expect(flagValues(cmd, "--session-id")).toEqual(["abc"]);
  });

  test("--name=foo (joined) suppresses the appended --name", async () => {
    const cmd = await runAndCapture(freshLaunch(["--name=foo"]), main);
    expect(flagValues(cmd, "--name")).toEqual(["foo"]);
  });

  test("--name foo (split) suppresses the appended --name", async () => {
    const cmd = await runAndCapture(freshLaunch(["--name", "foo"]), main);
    expect(flagValues(cmd, "--name")).toEqual(["foo"]);
  });

  test("-n foo (short) suppresses the appended --name", async () => {
    const cmd = await runAndCapture(freshLaunch(["-n", "foo"]), main);
    expect(flagValues(cmd, "--name")).toEqual([]);
    expect(cmd).toContain("-n");
  });
});
