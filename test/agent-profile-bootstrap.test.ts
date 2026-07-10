/**
 * The launcher's profile-dir bootstrap, .claude.json onboarding/trust merge,
 * state-sharing symlinks, model/effort precedence, and the full main()
 * profile-routing drives (explicit / env / auto / single-list-force /
 * fail-open). Two groups:
 *
 *  - Leaf helpers run against a real tmp filesystem. ensureKeeperAgentProfileDir /
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
import type { PresetCatalog } from "../src/agent/config";
import { main } from "../src/agent/main";
import {
  assertProfileDirNameAllowed,
  ensureClaudeStateSharing,
  ensureKeeperAgentPiProfileDir,
  ensureKeeperAgentProfileDir,
  ensurePiStateSharing,
  ensureProfileClaudeJson,
  StateError,
} from "../src/agent/state-sharing";
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

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

// ── Leaf helpers: profile-dir bootstrap against a tmp home ──────────────────

describe("ensureKeeperAgentProfileDir", () => {
  test("creates the profile dir + shared symlinks", () => {
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, '{"theme":"dark"}\n');
    const claudeMd = join(home, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, "# Default Claude\n");

    const log: string[] = [];
    const [profileDir, changed] = ensureKeeperAgentProfileDir(
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

    const [firstDir, firstChanged] = ensureKeeperAgentProfileDir(
      "multi-claude-1",
      null,
      null,
      home,
    );
    const [secondDir, secondChanged] = ensureKeeperAgentProfileDir(
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

    const [, changed] = ensureKeeperAgentProfileDir(
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

    const [profileDir, firstChanged] = ensureKeeperAgentProfileDir(
      "multi-claude-1",
      null,
      null,
      home,
    );
    const wrong = join(home, "wrong-settings.json");
    writeFileSync(wrong, '{"theme":"wrong"}\n');
    unlinkSync(join(profileDir, "settings.json"));
    symlinkSync(wrong, join(profileDir, "settings.json"));

    const [repairedDir, repairedChanged] = ensureKeeperAgentProfileDir(
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

  test("repairs session-resource drift for an explicit profile", () => {
    const canonicalDir = join(home, ".claude");
    mkdirSync(canonicalDir, { recursive: true });
    const settings = join(canonicalDir, "settings.json");
    writeFileSync(settings, '{"theme":"dark"}\n');
    writeFileSync(join(canonicalDir, "CLAUDE.md"), "# Default Claude\n");
    mkdirSync(join(canonicalDir, "session-env", "main-session"), {
      recursive: true,
    });

    const profileDir = join(home, ".claude-profiles", "multi-claude-1");
    mkdirSync(join(profileDir, "session-env", "profile-session"), {
      recursive: true,
    });

    const [, changed] = ensureKeeperAgentProfileDir(
      "multi-claude-1",
      null,
      null,
      home,
    );

    expect(changed).toBe(true);
    expect(lstatSync(join(profileDir, "session-env")).isSymbolicLink()).toBe(
      true,
    );
    expect(realpathSync(join(profileDir, "session-env"))).toBe(
      realpathSync(join(canonicalDir, "session-env")),
    );
    expect(
      lstatSync(
        join(canonicalDir, "session-env", "main-session"),
      ).isDirectory(),
    ).toBe(true);
    expect(
      lstatSync(
        join(canonicalDir, "session-env", "profile-session"),
      ).isDirectory(),
    ).toBe(true);
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
    mkdirSync(join(canonicalDir, "session-env", "main-session"), {
      recursive: true,
    });
    writeFileSync(join(profileDir, "history.jsonl"), "profile history\n");
    mkdirSync(join(profileDir, "projects"), { recursive: true });
    writeFileSync(join(profileDir, "projects", "drift.jsonl"), "drift\n");
    mkdirSync(join(profileDir, "session-env", "profile-session"), {
      recursive: true,
    });

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
    expect(lstatSync(join(profileDir, "session-env")).isSymbolicLink()).toBe(
      true,
    );
    expect(realpathSync(join(profileDir, "session-env"))).toBe(
      realpathSync(join(canonicalDir, "session-env")),
    );
    expect(
      lstatSync(
        join(canonicalDir, "session-env", "main-session"),
      ).isDirectory(),
    ).toBe(true);
    expect(
      lstatSync(
        join(canonicalDir, "session-env", "profile-session"),
      ).isDirectory(),
    ).toBe(true);
  });
});

// ── assertProfileDirNameAllowed reserved/path-escape guard ──────────────────

describe("assertProfileDirNameAllowed", () => {
  test("accepts a normal profile name", () => {
    expect(() => assertProfileDirNameAllowed("multi-claude-1")).not.toThrow();
    expect(() => assertProfileDirNameAllowed("a_b-2")).not.toThrow();
  });

  test("rejects the reserved set (trimmed)", () => {
    for (const name of ["", "default", " default ", "auto", "  "]) {
      expect(() => assertProfileDirNameAllowed(name)).toThrow(StateError);
    }
  });

  test("rejects path-escape: separators, '..', and NUL", () => {
    for (const name of ["a/b", "a\\b", "../x", "x/..", "a\0b"]) {
      expect(() => assertProfileDirNameAllowed(name)).toThrow(StateError);
    }
  });

  test("rejects an over-255-byte name", () => {
    expect(() => assertProfileDirNameAllowed("a".repeat(256))).toThrow(
      StateError,
    );
    expect(() => assertProfileDirNameAllowed("a".repeat(255))).not.toThrow();
  });

  test("rejects off-allowlist characters", () => {
    for (const name of ["Default", "a b", "café", "x.y"]) {
      expect(() => assertProfileDirNameAllowed(name)).toThrow(StateError);
    }
  });

  test("error message carries the name + reason, never an absolute path", () => {
    for (const name of ["default", "a/b", "../x"]) {
      let message = "";
      try {
        assertProfileDirNameAllowed(name);
      } catch (exc) {
        message = (exc as Error).message;
      }
      expect(message).not.toContain("/Users");
      expect(message).not.toContain(home);
      expect(message).not.toContain(".claude-profiles");
    }
  });
});

// ── the four mkdir sites refuse a reserved/escaping profile name ─────────────

describe("profile-dir mkdir sites reject reserved/escaping names", () => {
  test("ensureKeeperAgentProfileDir (claude) throws for a reserved name", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    expect(() =>
      ensureKeeperAgentProfileDir("default", null, null, home),
    ).toThrow(StateError);
    expect(() =>
      ensureKeeperAgentProfileDir("../escape", null, null, home),
    ).toThrow(StateError);
  });

  test("ensureKeeperAgentPiProfileDir (pi) throws for a reserved name", () => {
    expect(() => ensureKeeperAgentPiProfileDir("default", null, home)).toThrow(
      StateError,
    );
    expect(() => ensureKeeperAgentPiProfileDir("a/b", null, home)).toThrow(
      StateError,
    );
  });

  test("ensureKeeperAgentPiProfileDir (pi) creates a valid profile dir", () => {
    const [profileDir, changed] = ensureKeeperAgentPiProfileDir(
      "multi-claude-1",
      null,
      home,
    );
    expect(changed).toBe(true);
    expect(profileDir).toBe(join(home, ".pi-profiles", "multi-claude-1"));
    expect(lstatSync(profileDir).isDirectory()).toBe(true);
  });

  test("ensureClaudeStateSharing loop throws for an escaping profile name", () => {
    expect(() => ensureClaudeStateSharing(() => ["a/b"], null, home)).toThrow(
      StateError,
    );
  });

  test("ensurePiStateSharing loop throws for an escaping profile name", () => {
    expect(() => ensurePiStateSharing(() => ["../x"], null, home)).toThrow(
      StateError,
    );
  });
});

// ── main() profile routing drives (spawn recorder + injected picker) ────────

/** The env var the launcher exports for the resolved profile. */
function profileEnv(h: ReturnType<typeof makeHarness>): string | undefined {
  return h.deps.env.KEEPER_AGENT_CLAUDE_PROFILE as string | undefined;
}

describe("main() passthrough commands", () => {
  test("a profiled `auth status` passes through without session flags", async () => {
    const h = makeHarness({
      argv: ["--x-profile", "multi-claude-1", "auth", "status"],
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

  test("an explicit --x-profile auto still invokes the router", async () => {
    const h = makeHarness({
      argv: ["--x-profile", "auto", "--print"],
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
      profileDir: join(home, ".claude-profiles", "multi-claude-1"),
    });
    const cmd = await runAndCapture(h, main);
    expect(h.pickerCalls()).toBe(1);
    // Resume carries its own session posture — the harness default pointer never
    // injects a model onto it (fresh-only), so no wrapper --model is added.
    expect(cmd).not.toContain("--model");
    expect(profileEnv(h)).toBe("multi-claude-1");
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBe(
      join(home, ".claude-profiles", "multi-claude-1"),
    );
  });

  test("a picker failure falls back to the native default account", async () => {
    const h = makeHarness({
      argv: ["--x-profile", "auto", "--print"],
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

describe("main() explicit + env profile precedence", () => {
  test("an explicit profile bypasses the router", async () => {
    const h = makeHarness({
      argv: ["--x-profile", "multi-claude-1", "--print"],
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

  test("KEEPER_AGENT_PROFILE env bypasses the router", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: { KEEPER_AGENT_PROFILE: "multi-claude-2" },
      pickProfile: () => {
        throw new Error(
          "router should not run when KEEPER_AGENT_PROFILE is set",
        );
      },
      profileDir: join(home, ".claude-profiles", "multi-claude-2"),
    });
    await runAndCapture(h, main);
    expect(h.pickerCalls()).toBe(0);
    expect(profileEnv(h)).toBe("multi-claude-2");
  });

  test("a CLI profile wins over the env profile", async () => {
    const h = makeHarness({
      argv: ["--x-profile", "multi-claude-1", "--print"],
      env: { KEEPER_AGENT_PROFILE: "multi-claude-2" },
      profileDir: join(home, ".claude-profiles", "multi-claude-1"),
    });
    await runAndCapture(h, main);
    expect(h.bootstrappedProfiles).toEqual(["multi-claude-1"]);
    expect(profileEnv(h)).toBe("multi-claude-1");
  });

  test("KEEPER_AGENT_PROFILE=auto keeps the router", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: { KEEPER_AGENT_PROFILE: "auto" },
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => "multi-claude-1",
      profileDir: join(home, ".claude-profiles", "multi-claude-1"),
    });
    await runAndCapture(h, main);
    expect(h.pickerCalls()).toBe(1);
    expect(profileEnv(h)).toBe("multi-claude-1");
  });

  test("KEEPER_AGENT_PROFILE=default uses the native account (no router, no config dir)", async () => {
    const h = makeHarness({
      argv: ["--print"],
      env: { KEEPER_AGENT_PROFILE: "default" },
      pickProfile: () => {
        throw new Error(
          "router should not run when KEEPER_AGENT_PROFILE=default",
        );
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
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => "default",
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
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => "default",
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
      listProfiles: () => ["default", "multi-claude-1"],
      pickProfile: () => "default",
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
