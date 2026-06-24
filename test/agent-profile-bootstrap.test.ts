/**
 * The launcher's profile-dir bootstrap, .claude.json onboarding/trust merge,
 * state-sharing symlinks, model/effort precedence, and the full main()
 * profile-routing drives (explicit / env / auto / single-list-force /
 * fail-open). Two groups:
 *
 *  - Leaf helpers run against a real tmp filesystem. ensureAgentwrapProfileDir /
 *    ensureClaudeStateSharing derive ~/.claude-profiles from homedir(); since
 *    os.homedir() ignores process.env.HOME, they take an injected homeDir seam so
 *    a tmp home isolates them.
 *  - main()-driving tests use the MainDeps harness: the spawn recorder captures
 *    the composed command, the injected picker stubs profile selection, and the
 *    state collaborators are stubbed through the seams (no mock.module).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/agent/main";
import {
  ensureAgentwrapProfileDir,
  ensureClaudeStateSharing,
  ensureProfileClaudeJson,
} from "../src/agent/state-sharing";
import {
  flagValues,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

let savedEnv: NodeJS.ProcessEnv;
let tmpDir: string;
let home: string;

beforeEach(() => {
  savedEnv = process.env;
  tmpDir = mkdtempSync(join(tmpdir(), "agentwrap-bootstrap-"));
  home = join(tmpDir, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  process.env = savedEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

// ── Leaf helpers: profile-dir bootstrap against a tmp home ──────────────────

describe("ensureAgentwrapProfileDir", () => {
  test("creates the profile dir + shared symlinks", () => {
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, '{"theme":"dark"}\n');
    const claudeMd = join(home, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, "# Default Claude\n");

    const log: string[] = [];
    const [profileDir, changed] = ensureAgentwrapProfileDir(
      "multi-claude-1",
      null,
      log,
      home,
    );

    expect(changed).toBe(true);
    expect(profileDir).toBe(join(home, ".claude-profiles", "multi-claude-1"));
    const claudeJson = readJson(join(profileDir, ".claude.json"));
    expect(claudeJson.hasCompletedOnboarding).toBe(true);
    expect(claudeJson.theme).toBe("dark");
    expect(lstatSync(join(profileDir, "settings.json")).isSymbolicLink()).toBe(
      true,
    );
    expect(realpathSync(join(profileDir, "settings.json"))).toBe(
      realpathSync(settings),
    );
    expect(lstatSync(join(profileDir, "CLAUDE.md")).isSymbolicLink()).toBe(
      true,
    );
    expect(realpathSync(join(profileDir, "CLAUDE.md"))).toBe(
      realpathSync(claudeMd),
    );
    expect(log.some((l) => l.includes("Created profile directory"))).toBe(true);
  });

  test("is idempotent for an existing profile", () => {
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, "{}\n");
    const claudeMd = join(home, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, "# Default Claude\n");

    const [firstDir, firstChanged] = ensureAgentwrapProfileDir(
      "multi-claude-1",
      null,
      null,
      home,
    );
    const [secondDir, secondChanged] = ensureAgentwrapProfileDir(
      "multi-claude-1",
      null,
      null,
      home,
    );

    expect(firstChanged).toBe(true);
    expect(secondChanged).toBe(false);
    expect(secondDir).toBe(firstDir);
  });

  test("replaces a real profile settings file with the shared symlink", () => {
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, '{"theme":"dark"}\n');
    const claudeMd = join(home, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, "# Default Claude\n");

    const profileDir = join(home, ".claude-profiles", "multi-claude-1");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "settings.json"), '{"theme":"wrong"}\n');

    const [, changed] = ensureAgentwrapProfileDir(
      "multi-claude-1",
      null,
      null,
      home,
    );

    expect(changed).toBe(true);
    expect(lstatSync(join(profileDir, "settings.json")).isSymbolicLink()).toBe(
      true,
    );
    expect(realpathSync(join(profileDir, "settings.json"))).toBe(
      realpathSync(settings),
    );
    expect(realpathSync(join(profileDir, "CLAUDE.md"))).toBe(
      realpathSync(claudeMd),
    );
  });

  test("repairs profile settings symlink drift", () => {
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, '{"theme":"dark"}\n');
    const claudeMd = join(home, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, "# Default Claude\n");

    const [profileDir, firstChanged] = ensureAgentwrapProfileDir(
      "multi-claude-1",
      null,
      null,
      home,
    );
    const wrong = join(home, "wrong-settings.json");
    writeFileSync(wrong, '{"theme":"wrong"}\n');
    unlinkSync(join(profileDir, "settings.json"));
    symlinkSync(wrong, join(profileDir, "settings.json"));

    const [repairedDir, repairedChanged] = ensureAgentwrapProfileDir(
      "multi-claude-1",
      null,
      null,
      home,
    );

    expect(firstChanged).toBe(true);
    expect(repairedChanged).toBe(true);
    expect(repairedDir).toBe(profileDir);
    expect(realpathSync(join(profileDir, "settings.json"))).toBe(
      realpathSync(settings),
    );
  });
});

// ── ensureProfileClaudeJson onboarding/trust merge ──────────────────────────

describe("ensureProfileClaudeJson", () => {
  test("seeds the required onboarding defaults", () => {
    const profileDir = join(home, ".claude-profiles", "multi-claude-1");
    mkdirSync(profileDir, { recursive: true });

    expect(ensureProfileClaudeJson(profileDir)).toBe(true);
    const claudeJson = readJson(join(profileDir, ".claude.json"));
    expect(claudeJson.hasCompletedOnboarding).toBe(true);
    expect(claudeJson.theme).toBe("dark");
    expect(claudeJson.lastReleaseNotesSeen).toBe("9.9.99");
    expect(claudeJson.projects).toEqual({});
  });

  test("repairs existing state while preserving other projects", () => {
    const profileDir = join(home, ".claude-profiles", "multi-claude-1");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, ".claude.json"),
      `${JSON.stringify({ theme: "light", projects: { example: { isTrusted: true } } }, null, 2)}\n`,
    );

    expect(ensureProfileClaudeJson(profileDir)).toBe(true);
    const claudeJson = readJson(join(profileDir, ".claude.json"));
    expect(claudeJson.hasCompletedOnboarding).toBe(true);
    expect(claudeJson.theme).toBe("dark");
    expect(claudeJson.projects).toEqual({ example: { isTrusted: true } });
  });

  test("trusts requested paths", () => {
    const profileDir = join(home, ".claude-profiles", "multi-claude-1");
    mkdirSync(profileDir, { recursive: true });

    expect(
      ensureProfileClaudeJson(profileDir, ["/Users/mike/code/arthack"]),
    ).toBe(true);
    const claudeJson = readJson(join(profileDir, ".claude.json"));
    expect(
      (claudeJson.projects as Record<string, unknown>)[
        "/Users/mike/code/arthack"
      ],
    ).toEqual({
      allowedTools: [],
      isTrusted: true,
      hasTrustDialogAccepted: true,
    });
  });

  test("repairs an existing trust entry", () => {
    const profileDir = join(home, ".claude-profiles", "multi-claude-1");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      join(profileDir, ".claude.json"),
      `${JSON.stringify(
        {
          projects: {
            "/Users/mike/code/arthack": {
              allowedTools: ["Bash"],
              isTrusted: false,
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    expect(
      ensureProfileClaudeJson(profileDir, ["/Users/mike/code/arthack"]),
    ).toBe(true);
    const claudeJson = readJson(join(profileDir, ".claude.json"));
    expect(
      (claudeJson.projects as Record<string, unknown>)[
        "/Users/mike/code/arthack"
      ],
    ).toEqual({
      allowedTools: [],
      isTrusted: true,
      hasTrustDialogAccepted: true,
    });
  });
});

// ── ensureClaudeStateSharing full shared-symlink repair ─────────────────────

describe("ensureClaudeStateSharing", () => {
  test("repairs the full set of shared symlinks across a profile dir", () => {
    const canonicalDir = join(home, ".claude");
    mkdirSync(canonicalDir, { recursive: true });
    const profileDir = join(home, ".claude-profiles", "multi-claude-1");
    mkdirSync(profileDir, { recursive: true });

    const canonicalSettings = join(canonicalDir, "settings.json");
    writeFileSync(canonicalSettings, '{"theme":"dark"}\n');
    const canonicalClaudeMd = join(canonicalDir, "CLAUDE.md");
    writeFileSync(canonicalClaudeMd, "# Canonical Claude\n");

    writeFileSync(join(canonicalDir, "history.jsonl"), "default history\n");
    mkdirSync(join(canonicalDir, "projects"), { recursive: true });
    writeFileSync(join(profileDir, "history.jsonl"), "profile history\n");
    mkdirSync(join(profileDir, "projects"), { recursive: true });
    writeFileSync(join(profileDir, "projects", "drift.jsonl"), "drift\n");

    ensureClaudeStateSharing(() => ["multi-claude-1"], [], home);

    expect(lstatSync(join(profileDir, "settings.json")).isSymbolicLink()).toBe(
      true,
    );
    expect(readlinkSync(join(profileDir, "settings.json"))).toBe(
      canonicalSettings,
    );
    expect(realpathSync(join(profileDir, "settings.json"))).toBe(
      realpathSync(canonicalSettings),
    );
    expect(readlinkSync(join(profileDir, "CLAUDE.md"))).toBe(canonicalClaudeMd);
    expect(realpathSync(join(profileDir, "history.jsonl"))).toBe(
      realpathSync(join(canonicalDir, "history.jsonl")),
    );
    expect(realpathSync(join(profileDir, "projects"))).toBe(
      realpathSync(join(canonicalDir, "projects")),
    );
  });
});

// ── main() profile routing drives (spawn recorder + injected picker) ────────

/** The env var the launcher exports for the resolved profile. */
function profileEnv(h: ReturnType<typeof makeHarness>): string | undefined {
  return h.deps.env.AGENTWRAP_CLAUDE_PROFILE as string | undefined;
}

describe("main() passthrough commands", () => {
  test("a profiled `auth status` passes through without session flags", async () => {
    const h = makeHarness({
      argv: ["--agentwrap-profile", "multi-claude-1", "auth", "status"],
      env: {},
      homeBin: join(home, ".local", "bin", "claude"),
      profileDir: join(home, ".claude-profiles", "multi-claude-1"),
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      join(home, ".local", "bin", "claude"),
      "auth",
      "status",
    ]);
    expect(cmd).not.toContain("--strict-mcp-config");
    expect(cmd).not.toContain("--session-id");
    expect(cmd).not.toContain("--name");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBe(
      join(home, ".claude-profiles", "multi-claude-1"),
    );
  });

  test("native global flags pass through with subcommands; router not run", async () => {
    const h = makeHarness({
      argv: ["--debug", "auth", "status"],
      env: {},
      homeBin: join(home, ".local", "bin", "claude"),
      pickProfile: () => {
        throw new Error("router should not run for passthrough commands");
      },
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      join(home, ".local", "bin", "claude"),
      "--debug",
      "auth",
      "status",
    ]);
    expect(h.pickerCalls()).toBe(0);
  });
});

describe("main() auto profile routing", () => {
  test("defaults to auto routing and exports the resolved profile", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: {},
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => "default",
    });
    expect((await runAndCapture(h, main)).length).toBeGreaterThan(0);
    expect(h.pickerCalls()).toBe(1);
    // "default" normalizes to the native account internally, but the env var
    // surfaces "default" via the wrapper's default-account handling.
    expect(profileEnv(h)).toBe("default");
  });

  test("an explicit --agentwrap-profile auto still invokes the router", async () => {
    const h = makeHarness({
      argv: ["--agentwrap-profile", "auto", "--print"],
      env: {},
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => "default",
    });
    await runAndCapture(h, main);
    expect(h.pickerCalls()).toBe(1);
  });

  test("the router's named profile is exported", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: {},
      listProfiles: () => ["multi-claude-1", "multi-claude-2"],
      pickProfile: () => "multi-claude-2",
      profileDir: join(home, ".claude-profiles", "multi-claude-2"),
    });
    await runAndCapture(h, main);
    expect(profileEnv(h)).toBe("multi-claude-2");
  });

  test("a single-profile list forces that profile without calling the picker", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: {},
      listProfiles: () => ["multi-claude-2"],
      pickProfile: () => {
        throw new Error(
          "single-profile list should force, not call the picker",
        );
      },
      profileDir: join(home, ".claude-profiles", "multi-claude-2"),
    });
    await runAndCapture(h, main);
    expect(h.pickerCalls()).toBe(0);
    expect(profileEnv(h)).toBe("multi-claude-2");
  });

  test("a list fail-open (listProfiles throws) still routes via the picker", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: {},
      listProfiles: () => {
        throw new Error("simulated catalog failure");
      },
      pickProfile: () => "default",
    });
    await runAndCapture(h, main);
    expect(h.pickerCalls()).toBe(1);
    expect(profileEnv(h)).toBe("default");
  });

  test("--resume uses the auto router after shared-state setup", async () => {
    const sessionId = "d64ccaef-beac-4647-933b-db0d6b81704d";
    const h = makeHarness({
      argv: ["--resume", sessionId, "--print"],
      env: {},
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => "multi-claude-1",
      launcherModel: "fable",
      profileDir: join(home, ".claude-profiles", "multi-claude-1"),
    });
    const cmd = await runAndCapture(h, main);
    expect(h.pickerCalls()).toBe(1);
    expect(cmd.filter((a) => a === "--model")).toHaveLength(1);
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("fable");
    expect(profileEnv(h)).toBe("multi-claude-1");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBe(
      join(home, ".claude-profiles", "multi-claude-1"),
    );
  });

  test("a picker failure falls back to the native default account", async () => {
    const h = makeHarness({
      argv: ["--agentwrap-profile", "auto", "--print"],
      env: {},
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => {
        throw new Error("agentusage exploded");
      },
    });
    await runAndCapture(h, main);
    expect(profileEnv(h)).toBe("default");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

describe("main() explicit + env profile precedence", () => {
  test("an explicit profile bypasses the router", async () => {
    const h = makeHarness({
      argv: ["--agentwrap-profile", "multi-claude-1", "--print"],
      env: {},
      pickProfile: () => {
        throw new Error("router should not run for explicit profiles");
      },
      profileDir: join(home, ".claude-profiles", "multi-claude-1"),
    });
    await runAndCapture(h, main);
    expect(h.pickerCalls()).toBe(0);
    expect(profileEnv(h)).toBe("multi-claude-1");
  });

  test("AGENTWRAP_PROFILE env bypasses the router", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: { AGENTWRAP_PROFILE: "multi-claude-2" },
      pickProfile: () => {
        throw new Error("router should not run when AGENTWRAP_PROFILE is set");
      },
      profileDir: join(home, ".claude-profiles", "multi-claude-2"),
    });
    await runAndCapture(h, main);
    expect(h.pickerCalls()).toBe(0);
    expect(profileEnv(h)).toBe("multi-claude-2");
  });

  test("a CLI profile wins over the env profile", async () => {
    const h = makeHarness({
      argv: ["--agentwrap-profile", "multi-claude-1", "--print"],
      env: { AGENTWRAP_PROFILE: "multi-claude-2" },
      profileDir: join(home, ".claude-profiles", "multi-claude-1"),
    });
    await runAndCapture(h, main);
    expect(h.bootstrappedProfiles).toEqual(["multi-claude-1"]);
    expect(profileEnv(h)).toBe("multi-claude-1");
  });

  test("AGENTWRAP_PROFILE=auto keeps the router", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: { AGENTWRAP_PROFILE: "auto" },
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => "multi-claude-1",
      profileDir: join(home, ".claude-profiles", "multi-claude-1"),
    });
    await runAndCapture(h, main);
    expect(h.pickerCalls()).toBe(1);
    expect(profileEnv(h)).toBe("multi-claude-1");
  });

  test("AGENTWRAP_PROFILE=default uses the native account (no router, no config dir)", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: { AGENTWRAP_PROFILE: "default" },
      pickProfile: () => {
        throw new Error("router should not run when AGENTWRAP_PROFILE=default");
      },
    });
    await runAndCapture(h, main);
    expect(profileEnv(h)).toBe("default");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(h.pickerCalls()).toBe(0);
  });
});

// ── model/effort startup overrides through main() ───────────────────────────

describe("main() model override", () => {
  test("forwards the configured default model for an interactive launch", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: {},
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => "default",
      launcherModel: "fable",
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd.filter((a) => a === "--model")).toHaveLength(1);
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("fable");
  });

  test("sends no --model when the launcher config is absent", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: {},
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => "default",
      launcherModel: null,
    });
    const cmd = await runAndCapture(h, main);
    expect(cmd).not.toContain("--model");
  });

  test("preserves an explicit --model over the configured default", async () => {
    const h = makeHarness({
      argv: ["--print", "--model", "sonnet"],
      env: {},
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => "default",
      launcherModel: "fable",
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
