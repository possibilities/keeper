/**
 * `keeper agent panel start|wait` — the routing lock for the panel fan-out
 * exposed under the `agent` namespace. `agent panel` routes into
 * `src/pair/panel.ts` `runPanel`, so the manifest/verdict JSON + exit semantics
 * (0 all-terminal / 124 chunk-elapsed / 2 bad-config) come straight from that
 * engine — this suite proves the wiring and pins the observable output.
 *
 * The pure classifier (`splitSubcommand`) is unit-tested directly. Routing is
 * driven through `src/agent/main` main() with a stubbed MainDeps, patching
 * process.{exit,stdout,stderr} because `runPanel`
 * owns its own stdout + exit code via the process globals, not the injected
 * seams. Only the NON-spawning paths are exercised end-to-end (`wait` reads a
 * seeded manifest + result files; a bad-config `start` fails before any leg
 * spawns) — the real detached-leg launch is the slow-tier sibling
 * `test/pair-panel.slow.test.ts`, never the fast tier.
 *
 * The ad-hoc single-member (pairing = a panel of one) coverage sits here too:
 * `resolveAdHocMember`/`buildPanelLegArgv` are unit-tested pure, and `panelStart`
 * is driven with injected deps (a fake spawn capturing the leg argv) to prove an
 * ad-hoc `--preset`/`--cli` member builds a 1-entry manifest whose leg carries the
 * resolved harness/model/effort + a `--role` `--system` block, while the mutual
 * exclusion (`--panel` vs `--preset`/`--cli`) routes to exit 2.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDuration } from "../cli/duration";
import type {
  PanelDefinition,
  PanelSelections,
  Preset,
  PresetCatalog,
} from "../src/agent/config";
import {
  KEEPER_AGENT_HELP,
  splitSubcommand,
  USAGE,
} from "../src/agent/dispatch";
import { loadRolePrompt } from "../src/agent/launch-config";
import { main as agentMain } from "../src/agent/main";
import {
  buildPanelLegArgv,
  PANEL_HELP,
  type PanelDeps,
  type PanelManifest,
  type PanelManifestMember,
  type PanelPruneResult,
  type PanelStatus,
  type PanelVerdict,
  panelPrune,
  panelResume,
  panelStart,
  panelStatus,
  parseManifest,
  resolveAdHocMember,
} from "../src/pair/panel";
import { makeHarness } from "./helpers/agent-main-harness";
import { sandboxEnv } from "./helpers/sandbox-env";

// ---------------------------------------------------------------------------
// splitSubcommand classification (pure)
// ---------------------------------------------------------------------------

test("splitSubcommand: `panel start …` classifies, carrying start + flags in rest", () => {
  expect(
    splitSubcommand(["panel", "start", "/p.md", "--panel", "default"]),
  ).toEqual({
    kind: "panel",
    rest: ["start", "/p.md", "--panel", "default"],
  });
});

test("splitSubcommand: `panel wait …` classifies, carrying wait + flags in rest", () => {
  expect(
    splitSubcommand(["panel", "wait", "--run-dir", "/d", "--chunk", "540"]),
  ).toEqual({
    kind: "panel",
    rest: ["wait", "--run-dir", "/d", "--chunk", "540"],
  });
});

test("splitSubcommand: bare `panel` classifies with an empty rest", () => {
  expect(splitSubcommand(["panel"])).toEqual({ kind: "panel", rest: [] });
});

test("splitSubcommand: strips exactly one token — a second `panel` survives in rest", () => {
  expect(splitSubcommand(["panel", "panel"])).toEqual({
    kind: "panel",
    rest: ["panel"],
  });
});

// ---------------------------------------------------------------------------
// End-to-end routing (agent main → runPanel), process globals patched
// ---------------------------------------------------------------------------

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

interface MainRun {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

let dir: string;
const TOUCHED_ENV_KEYS = [
  "KEEPER_DB",
  "KEEPER_DEAD_LETTER_DIR",
  "KEEPER_LANE_DIRT_SPOOL_DIR",
  "KEEPER_DROP_LOG",
  "KEEPER_RESTORE_FILE",
  "KEEPER_BACKSTOP_LOG",
  "KEEPER_BUS_DB",
  "KEEPER_BUS_SOCK",
  "KEEPER_CONFIG",
  "KEEPER_CONFIG_DIR",
  "KEEPER_STATE_DIR",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-panel-cli-"));
  savedEnv = {};
  for (const k of TOUCHED_ENV_KEYS) savedEnv[k] = process.env[k];
  const env = sandboxEnv({
    tmpDir: dir,
    dbPath: join(dir, "keeper.db"),
    extra: {
      // Point the config resolvers at an empty sandboxed dir so a `start` with a
      // configured --panel hard-fails exit 2 BEFORE any real leg spawns, and the
      // user's real presets never bleed in.
      KEEPER_CONFIG: join(dir, "no-such-config.yaml"),
      KEEPER_CONFIG_DIR: dir,
      // The durable panel-state root — sandboxed so `start` without `--run-dir` never
      // pollutes the real ~/.local/state/keeper.
      KEEPER_STATE_DIR: join(dir, "keeper-state"),
    },
  });
  for (const k of TOUCHED_ENV_KEYS) {
    if (env[k] !== undefined) process.env[k] = env[k];
    else delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Drive an entry that owns stdout + process.exit directly, capturing both. */
async function runCapturing(fn: () => Promise<unknown>): Promise<MainRun> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const realExit = process.exit.bind(process);
  let code: number | undefined;
  process.stdout.write = ((s: string | Uint8Array) => {
    out.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    err.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new ExitError(code);
  }) as typeof process.exit;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.exit = realExit;
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** Drive `keeper agent <argv>` through src/agent/main with a stubbed MainDeps. */
async function runAgent(argv: string[]): Promise<MainRun> {
  const h = makeHarness({ argv, rawArgv: true });
  return runCapturing(() => agentMain(h.deps));
}

/** Seed a scratch panel dir with a manifest + two completed leg result files. */
function seedTerminalPanel(): string {
  const pdir = mkdtempSync(join(dir, "panel-"));
  const manifest: PanelManifest = {
    dir: pdir,
    slug: "seed-run",
    members: [
      {
        name: "opus",
        harness: "claude",
        yaml: join(pdir, "opus.yaml"),
        pidfile: join(pdir, "opus.pidfile"),
      },
      {
        name: "codex",
        harness: "codex",
        yaml: join(pdir, "codex.yaml"),
        pidfile: join(pdir, "codex.pidfile"),
      },
    ],
  };
  writeFileSync(join(pdir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(
    join(pdir, "opus.yaml"),
    `${JSON.stringify({ schema_version: 1, outcome: "completed", message: "SECRET_ANSWER_DO_NOT_LEAK" })}\n`,
  );
  writeFileSync(
    join(pdir, "codex.yaml"),
    `${JSON.stringify({ schema_version: 1, outcome: "completed", message: "codex answer body" })}\n`,
  );
  return pdir;
}

/** Seed a scratch panel dir whose single leg "completed" with no answer text. */
function seedEmptyMessagePanel(): string {
  const pdir = mkdtempSync(join(dir, "panel-"));
  const manifest: PanelManifest = {
    dir: pdir,
    slug: "empty-run",
    members: [
      {
        name: "codex",
        harness: "codex",
        yaml: join(pdir, "codex.yaml"),
        pidfile: join(pdir, "codex.pidfile"),
      },
    ],
  };
  writeFileSync(join(pdir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(
    join(pdir, "codex.yaml"),
    `${JSON.stringify({ schema_version: 1, outcome: "completed", message: null })}\n`,
  );
  return pdir;
}

test("agent panel wait: terminal panel → exit 0 + verdict JSON (content-blind)", async () => {
  const pdir = seedTerminalPanel();
  const r = await runAgent([
    "panel",
    "wait",
    "--run-dir",
    pdir,
    "--chunk",
    "540s",
  ]);
  expect(r.code).toBe(0);
  const v: PanelVerdict = JSON.parse(r.stdout.trim());
  expect(v.ok).toBe(true);
  expect(v.dir).toBe(pdir);
  expect(v.members.map((m) => m.name)).toEqual(["opus", "codex"]);
  // The verdict never leaks a panelist's answer.
  expect(r.stdout).not.toContain("SECRET_ANSWER_DO_NOT_LEAK");
});

test("agent panel wait: completed leg with empty message → fail (empty_message)", async () => {
  const pdir = seedEmptyMessagePanel();
  const r = await runAgent([
    "panel",
    "wait",
    "--run-dir",
    pdir,
    "--chunk",
    "540s",
  ]);
  expect(r.code).toBe(0);
  const v: PanelVerdict = JSON.parse(r.stdout.trim());
  expect(v.ok).toBe(false);
  expect(v.members[0]?.status).toBe("fail");
  expect(v.members[0]?.reason).toBe("empty_message");
});

test("agent panel wait: missing manifest → exit 2", async () => {
  const missing = join(dir, "no-such-panel-dir");
  const agent = await runAgent(["panel", "wait", "--run-dir", missing]);
  expect(agent.code).toBe(2);
  expect(agent.stderr).toContain("cannot read manifest");
});

test("agent panel wait: no --run-dir → exit 2", async () => {
  const r = await runAgent(["panel", "wait"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--run-dir");
});

test("agent panel wait: --chunk above the ceiling → exit 2", async () => {
  const pdir = seedTerminalPanel();
  const r = await runAgent([
    "panel",
    "wait",
    "--run-dir",
    pdir,
    "--chunk",
    "9999s",
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("ceiling");
});

test("agent panel wait: a unitless --chunk exits 2 with the self-healing unit hint", async () => {
  const pdir = seedTerminalPanel();
  const r = await runAgent([
    "panel",
    "wait",
    "--run-dir",
    pdir,
    "--chunk",
    "540",
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("needs a unit");
});

test("agent panel start: a missing/empty config is fail-loud exit 2 (no leg spawns)", async () => {
  const promptFile = join(dir, "ask.md");
  writeFileSync(promptFile, "what is the best answer?");
  // KEEPER_CONFIG_DIR is an empty sandboxed dir → the preset catalog load throws
  // ConfigError → runPanel's panelStart returns 2 BEFORE resolving members or
  // spawning any detached leg.
  const r = await runAgent([
    "panel",
    "start",
    promptFile,
    "--slug",
    "cfg-run",
    "--panel",
    "default",
    "--run-dir",
    join(dir, "scratch"),
  ]);
  expect(r.code).toBe(2);
});

test("agent panel start: a missing --slug → exit 2 with a panel-scoped message", async () => {
  const promptFile = join(dir, "ask.md");
  writeFileSync(promptFile, "what is the best answer?");
  // The slug gate fires BEFORE the config load, so this is a distinct slug fault,
  // never masked by the sandbox's missing config.
  const r = await runAgent([
    "panel",
    "start",
    promptFile,
    "--panel",
    "default",
    "--run-dir",
    join(dir, "scratch-noslug"),
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--slug is required");
});

test("agent panel start: a --slug that slugifies to nothing → exit 2", async () => {
  const promptFile = join(dir, "ask.md");
  writeFileSync(promptFile, "what is the best answer?");
  const r = await runAgent([
    "panel",
    "start",
    promptFile,
    "--slug",
    "...",
    "--panel",
    "default",
    "--run-dir",
    join(dir, "scratch-emptyslug"),
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("slugifies to nothing");
});

test("agent panel start: a unitless --timeout exits 2 with the self-healing unit hint", async () => {
  const promptFile = join(dir, "ask.md");
  writeFileSync(promptFile, "what is the best answer?");
  // --timeout is parsed before the slug gate + config load, so a bare promptFile
  // is enough to reach the rejection without a working config.
  const r = await runAgent(["panel", "start", promptFile, "--timeout", "30"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("needs a unit");
});

test("agent panel: bare sub-verb → exit 2", async () => {
  const r = await runAgent(["panel"]);
  expect(r.code).toBe(2);
});

test("agent panel: unknown operation → exit 2", async () => {
  const agent = await runAgent(["panel", "frobnicate"]);
  expect(agent.code).toBe(2);
  expect(agent.stderr).toContain("unknown operation");
});

test("agent panel --help → exit 0", async () => {
  const r = await runAgent(["panel", "--help"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("panel");
});

// ---------------------------------------------------------------------------
// USAGE / wrapper help document the panel sub-verb
// ---------------------------------------------------------------------------

test("top-level USAGE documents `agent panel start|wait`", () => {
  expect(USAGE).toContain("keeper agent panel start");
  expect(USAGE).toContain("keeper agent panel wait");
  // The now-required --slug rides the start synopsis.
  expect(USAGE).toContain("--slug");
});

test("wrapper KEEPER_AGENT_HELP documents the panel sub-verb", () => {
  expect(KEEPER_AGENT_HELP).toContain("Panel fan-out");
  expect(KEEPER_AGENT_HELP).toContain("keeper agent panel wait");
});

// ---------------------------------------------------------------------------
// Ad-hoc single member (pairing = a panel of one)
// ---------------------------------------------------------------------------

const AD_HOC_KEEPER_BIN = "/usr/local/bin/bun";
const AD_HOC_KEEPER_AGENT = "/abs/cli/keeper.ts";
/** A fixed derived boot instant injected via `deps.bootEpochMs` so the manifest's
 *  boot-epoch is deterministic (os.uptime is not injectable). */
const FIXED_BOOT_EPOCH_MS = 1_700_000_000_000;

function mkPreset(
  harness: Preset["harness"],
  overrides: Partial<Preset> = {},
): Preset {
  return {
    harness,
    model: null,
    effort: null,
    thinking: null,
    role: null,
    ...overrides,
  };
}

/** A catalog with one codex preset for the ad-hoc `--preset` member. */
const AD_HOC_CATALOG: PresetCatalog = {
  presets: { "codex-review": mkPreset("codex", { model: "gpt-5" }) },
};
const AD_HOC_SELECTIONS: PanelSelections = { panels: {}, default: null };

/** Build a fixture `PanelDefinition` from an ordered member list — strength +
 *  description are irrelevant to leg-naming/spawn-argv behavior here, so every
 *  fixture panel shares an arbitrary uniform band + blurb. */
function panelDef(members: string[]): PanelDefinition {
  return { strength: "standard", members, description: "fixture panel." };
}

interface AdHocSpawn {
  argv: string[];
}

/** `panelStart` deps with a fake spawn recording each leg argv (no real
 *  process), a fixed clock, and a fake registry serving {@link AD_HOC_CATALOG}. */
function makeAdHocDeps(): { deps: PanelDeps; spawns: AdHocSpawn[] } {
  const spawns: AdHocSpawn[] = [];
  const deps: PanelDeps = {
    keeperBin: AD_HOC_KEEPER_BIN,
    keeperAgentPath: AD_HOC_KEEPER_AGENT,
    env: { PATH: "/usr/bin" },
    cwd: "/work/repo",
    loadRegistry: () => ({
      catalog: AD_HOC_CATALOG,
      selections: AD_HOC_SELECTIONS,
    }),
    spawn: (argv) => {
      spawns.push({ argv });
    },
    now: () => 0,
    sleep: async () => {},
    pidAlive: () => false,
    write: () => {},
    writeErr: () => {},
    bootEpochMs: () => FIXED_BOOT_EPOCH_MS,
  };
  return { deps, spawns };
}

/** Strip the `sh -c <script> --` detach wrapper prefix → the leg argv. */
function legOf(spawn: AdHocSpawn): string[] {
  return spawn.argv.slice(4);
}

describe("resolveAdHocMember (pure)", () => {
  test("--preset resolves the catalog harness + carries the preset name", () => {
    const r = resolveAdHocMember(AD_HOC_CATALOG, {
      preset: "codex-review",
      readOnly: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.members).toEqual([
      {
        name: "codex-review",
        harness: "codex",
        preset: "codex-review",
        model: undefined,
        effort: undefined,
        system: undefined,
        readOnly: true,
      },
    ]);
  });

  test("--cli is a bare harness with explicit model/effort, no preset", () => {
    const r = resolveAdHocMember(AD_HOC_CATALOG, {
      cli: "codex",
      model: "gpt-5",
      effort: "high",
      readOnly: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.members).toEqual([
      {
        name: "codex",
        harness: "codex",
        preset: undefined,
        model: "gpt-5",
        effort: "high",
        system: undefined,
        readOnly: false,
      },
    ]);
  });

  test("--preset + --cli together → mutually exclusive error", () => {
    const r = resolveAdHocMember(AD_HOC_CATALOG, {
      preset: "codex-review",
      cli: "codex",
      readOnly: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("mutually exclusive");
  });

  test("--effort on a non-codex member → error", () => {
    const r = resolveAdHocMember(AD_HOC_CATALOG, {
      cli: "claude",
      effort: "high",
      readOnly: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("--effort is only supported for codex");
  });

  test("an unknown preset / harness / empty selector each fail loud", () => {
    expect(
      resolveAdHocMember(AD_HOC_CATALOG, { preset: "nope", readOnly: true }).ok,
    ).toBe(false);
    expect(
      resolveAdHocMember(AD_HOC_CATALOG, { cli: "bogus", readOnly: true }).ok,
    ).toBe(false);
    expect(resolveAdHocMember(AD_HOC_CATALOG, { readOnly: true }).ok).toBe(
      false,
    );
  });
});

describe("buildPanelLegArgv (ad-hoc posture)", () => {
  test("threads --system/--model/--effort and forwards --read-only", () => {
    const leg = buildPanelLegArgv({
      keeperBin: AD_HOC_KEEPER_BIN,
      keeperAgentPath: AD_HOC_KEEPER_AGENT,
      prompt: "review this",
      member: {
        name: "codex",
        harness: "codex",
        model: "gpt-5",
        effort: "high",
        system: "You are a code reviewer.",
        readOnly: true,
      },
      slug: "adhoc-run",
      yamlPath: "/d/codex.yaml",
      stopTimeoutMs: 900000,
    });
    expect(leg.slice(0, 5)).toEqual([
      AD_HOC_KEEPER_BIN,
      AD_HOC_KEEPER_AGENT,
      "agent",
      "run",
      "codex",
    ]);
    expect(leg[leg.indexOf("--system") + 1]).toBe("You are a code reviewer.");
    expect(leg[leg.indexOf("--model") + 1]).toBe("gpt-5");
    expect(leg[leg.indexOf("--effort") + 1]).toBe("high");
    expect(leg).toContain("--read-only");
    // The leg is named panel::<slug>::<member.name>.
    expect(leg[leg.indexOf("--name") + 1]).toBe("panel::adhoc-run::codex");
  });

  test("an ad-hoc member with readOnly=false drops --read-only + omits posture flags", () => {
    const leg = buildPanelLegArgv({
      keeperBin: AD_HOC_KEEPER_BIN,
      keeperAgentPath: AD_HOC_KEEPER_AGENT,
      prompt: "explore",
      member: { name: "claude", harness: "claude", readOnly: false },
      slug: "adhoc-run",
      yamlPath: "/d/claude.yaml",
      stopTimeoutMs: 900000,
    });
    expect(leg).not.toContain("--read-only");
    expect(leg).not.toContain("--system");
    expect(leg).not.toContain("--model");
    expect(leg).not.toContain("--effort");
    expect(leg).not.toContain("--preset");
  });
});

describe("panelStart (ad-hoc member fan-out)", () => {
  test("--preset member → 1-entry manifest; leg carries harness + --preset", async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "what is the best answer?");
    const pdir = join(dir, "adhoc-preset");
    const { deps, spawns } = makeAdHocDeps();
    const code = await panelStart(
      {
        promptFile,
        slug: "adhoc-run",
        panel: undefined,
        adHoc: { preset: "codex-review", readOnly: true },
        dir: pdir,
        timeoutSeconds: 900,
      },
      deps,
    );
    expect(code).toBe(0);
    expect(spawns.length).toBe(1);
    const leg = legOf(spawns[0] as AdHocSpawn);
    expect(leg.slice(0, 5)).toEqual([
      AD_HOC_KEEPER_BIN,
      AD_HOC_KEEPER_AGENT,
      "agent",
      "run",
      "codex",
    ]);
    expect(leg[leg.indexOf("--preset") + 1]).toBe("codex-review");
    expect(leg).toContain("--read-only");
    // The ad-hoc leg is named panel::<slug>::<member.name>.
    expect(leg[leg.indexOf("--name") + 1]).toBe(
      "panel::adhoc-run::codex-review",
    );
    const manifest: PanelManifest = JSON.parse(
      readFileSync(join(pdir, "manifest.json"), "utf8"),
    );
    expect(manifest.members).toHaveLength(1);
    expect(manifest.members[0]?.name).toBe("codex-review");
    expect(manifest.members[0]?.harness).toBe("codex");
  });

  test("--cli member with --model/--effort → 1-entry manifest; leg carries them", async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "explore the repo");
    const pdir = join(dir, "adhoc-cli");
    const { deps, spawns } = makeAdHocDeps();
    const code = await panelStart(
      {
        promptFile,
        slug: "adhoc-run",
        panel: undefined,
        adHoc: {
          cli: "codex",
          model: "gpt-5",
          effort: "high",
          readOnly: false,
        },
        dir: pdir,
        timeoutSeconds: 900,
      },
      deps,
    );
    expect(code).toBe(0);
    expect(spawns.length).toBe(1);
    const leg = legOf(spawns[0] as AdHocSpawn);
    expect(leg[4]).toBe("codex");
    expect(leg[leg.indexOf("--model") + 1]).toBe("gpt-5");
    expect(leg[leg.indexOf("--effort") + 1]).toBe("high");
    expect(leg).not.toContain("--preset");
    expect(leg).not.toContain("--read-only");
    const manifest: PanelManifest = JSON.parse(
      readFileSync(join(pdir, "manifest.json"), "utf8"),
    );
    expect(manifest.members).toHaveLength(1);
    expect(manifest.members[0]?.name).toBe("codex");
  });

  test("--role codereviewer rides the leg as --system with the catalog text", async () => {
    // The role catalog resolves to real in-repo prompt text (the CLI layer does
    // this before panelStart); here we resolve it the same way + assert it lands
    // on the leg as an `agent run --system` block.
    const roleResult = loadRolePrompt("codereviewer");
    expect(roleResult.ok).toBe(true);
    if (!roleResult.ok) return;
    expect(roleResult.text.length).toBeGreaterThan(0);

    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "review this diff");
    const pdir = join(dir, "adhoc-role");
    const { deps, spawns } = makeAdHocDeps();
    const code = await panelStart(
      {
        promptFile,
        slug: "adhoc-run",
        panel: undefined,
        adHoc: { cli: "claude", system: roleResult.text, readOnly: true },
        dir: pdir,
        timeoutSeconds: 900,
      },
      deps,
    );
    expect(code).toBe(0);
    const leg = legOf(spawns[0] as AdHocSpawn);
    expect(leg[leg.indexOf("--system") + 1]).toBe(roleResult.text);
  });

  test("a configured 2-member panel names each leg panel::<slug>::<its-member-slug>", async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "what is the best answer?");
    const pdir = join(dir, "fanout");
    const spawns: AdHocSpawn[] = [];
    const deps: PanelDeps = {
      ...makeAdHocDeps().deps,
      loadRegistry: () => ({
        catalog: { presets: {} },
        selections: {
          panels: {
            duo: panelDef(["claude::opus::high", "codex::gpt-5.3::high"]),
          },
          default: null,
        },
      }),
      spawn: (argv) => {
        spawns.push({ argv });
      },
    };
    const code = await panelStart(
      {
        promptFile,
        slug: "duo-run",
        panel: "duo",
        dir: pdir,
        timeoutSeconds: 900,
      },
      deps,
    );
    expect(code).toBe(0);
    expect(spawns.length).toBe(2);
    // Each leg's --name carries ITS OWN disambiguated member slug, and --preset the
    // raw triple.
    const legA = legOf(spawns[0] as AdHocSpawn);
    const legB = legOf(spawns[1] as AdHocSpawn);
    expect(legA[legA.indexOf("--name") + 1]).toMatch(
      /^panel::duo-run::claude-opus-high-[0-9a-z]{6}-1$/,
    );
    expect(legA[legA.indexOf("--preset") + 1]).toBe("claude::opus::high");
    expect(legB[legB.indexOf("--name") + 1]).toMatch(
      /^panel::duo-run::codex-gpt-5-3-high-[0-9a-z]{6}-1$/,
    );
    expect(legB[legB.indexOf("--preset") + 1]).toBe("codex::gpt-5.3::high");
    // The manifest records the run slug top-level.
    const manifest: PanelManifest = JSON.parse(
      readFileSync(join(pdir, "manifest.json"), "utf8"),
    );
    expect(manifest.slug).toBe("duo-run");
  });

  test("--timeout <dur> maps the accepted unit to the leg's --stop-timeout ms", async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "what is the best answer?");
    const pdir = join(dir, "adhoc-timeout");
    const { deps, spawns } = makeAdHocDeps();
    // Mirrors runPanel's own `dur.ms / 1000` → `timeoutSeconds * 1000` mapping
    // for a `--timeout 5m` flag.
    const dur = parseDuration("5m");
    expect(dur.ok).toBe(true);
    if (!dur.ok) return;
    const code = await panelStart(
      {
        promptFile,
        slug: "adhoc-run",
        panel: undefined,
        adHoc: { preset: "codex-review", readOnly: true },
        dir: pdir,
        timeoutSeconds: dur.ms / 1000,
      },
      deps,
    );
    expect(code).toBe(0);
    const leg = legOf(spawns[0] as AdHocSpawn);
    expect(leg[leg.indexOf("--stop-timeout") + 1]).toBe("300000ms");
  });
});

describe("panelStart (durable slug-keyed dir + boot-epoch manifest)", () => {
  test("without --run-dir → writes keeperStateDir()/panels/<slug>/ (0700); manifest carries boot_epoch_ms + per-leg launched_at", async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "what is the best answer?");
    const { deps, spawns } = makeAdHocDeps();
    const code = await panelStart(
      {
        promptFile,
        slug: "durable-run",
        panel: undefined,
        adHoc: { preset: "codex-review", readOnly: true },
        timeoutSeconds: 900,
      },
      deps,
    );
    expect(code).toBe(0);
    expect(spawns.length).toBe(1);

    // The run lives at the deterministic slug-keyed durable path under the
    // sandboxed KEEPER_STATE_DIR — a restarted driver rediscovers it from the slug.
    const panelDir = join(dir, "keeper-state", "panels", "durable-run");
    expect(existsSync(join(panelDir, "manifest.json"))).toBe(true);
    // 0700 — private per-user state.
    expect(statSync(panelDir).mode & 0o777).toBe(0o700);

    const manifest: PanelManifest = JSON.parse(
      readFileSync(join(panelDir, "manifest.json"), "utf8"),
    );
    expect(manifest.dir).toBe(panelDir);
    expect(manifest.boot_epoch_ms).toBe(FIXED_BOOT_EPOCH_MS);
    expect(manifest.generation).toBe(1);
    expect(manifest.members).toHaveLength(1);
    // The leg spawned OK → launched_at stamped (deps.now() === 0) + pidfile set.
    expect(manifest.members[0]?.launched_at).toBe(0);
    expect(typeof manifest.members[0]?.pidfile).toBe("string");
  });

  test("--run-dir override wins (no durable dir minted); the boot-epoch seam is injected", async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "q");
    const pdir = join(dir, "override-dir");
    const { deps } = makeAdHocDeps();
    const code = await panelStart(
      {
        promptFile,
        slug: "override-run",
        panel: undefined,
        adHoc: { preset: "codex-review", readOnly: true },
        dir: pdir,
        timeoutSeconds: 900,
      },
      deps,
    );
    expect(code).toBe(0);
    expect(
      existsSync(join(dir, "keeper-state", "panels", "override-run")),
    ).toBe(false);
    const manifest: PanelManifest = JSON.parse(
      readFileSync(join(pdir, "manifest.json"), "utf8"),
    );
    expect(manifest.dir).toBe(pdir);
    expect(manifest.boot_epoch_ms).toBe(FIXED_BOOT_EPOCH_MS);
  });

  test("skeleton is on disk BEFORE the spawn loop; a spawn-throw records pidfile:null + launched_at:null", async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "q");
    const pdir = join(dir, "skeleton-run");
    // A 2-member panel whose SECOND leg's spawn throws. The spawn fn snapshots the
    // on-disk manifest at its first call to prove the skeleton was written first.
    let manifestAtFirstSpawn: PanelManifest | null = null;
    let spawnCount = 0;
    const deps: PanelDeps = {
      ...makeAdHocDeps().deps,
      loadRegistry: () => ({
        catalog: { presets: {} },
        selections: {
          panels: {
            duo: panelDef(["claude::opus::high", "codex::gpt-5.3::high"]),
          },
          default: null,
        },
      }),
      spawn: () => {
        spawnCount += 1;
        if (manifestAtFirstSpawn === null) {
          manifestAtFirstSpawn = JSON.parse(
            readFileSync(join(pdir, "manifest.json"), "utf8"),
          );
        }
        if (spawnCount === 2) {
          throw new Error("spawn boom");
        }
      },
    };
    const code = await panelStart(
      {
        promptFile,
        slug: "skeleton-run",
        panel: "duo",
        dir: pdir,
        timeoutSeconds: 900,
      },
      deps,
    );
    expect(code).toBe(0);

    // At the first spawn the skeleton was already on disk: both legs present, both
    // pidfiles set (intended), no launched_at yet, boot-epoch stamped.
    expect(manifestAtFirstSpawn).not.toBeNull();
    const skel = manifestAtFirstSpawn as unknown as PanelManifest;
    expect(skel.members).toHaveLength(2);
    expect(skel.members.every((m) => typeof m.pidfile === "string")).toBe(true);
    expect(skel.members.every((m) => m.launched_at === null)).toBe(true);
    expect(skel.boot_epoch_ms).toBe(FIXED_BOOT_EPOCH_MS);

    // Final: leg 1 launched (pidfile + launched_at); leg 2's spawn threw → pidfile
    // null (the launch-failed signal wait reads) + launched_at null.
    const manifest: PanelManifest = JSON.parse(
      readFileSync(join(pdir, "manifest.json"), "utf8"),
    );
    expect(typeof manifest.members[0]?.pidfile).toBe("string");
    expect(manifest.members[0]?.launched_at).toBe(0);
    expect(manifest.members[1]?.pidfile).toBeNull();
    expect(manifest.members[1]?.launched_at).toBeNull();
  });
});

describe("panelStart (reconcile / idempotent-by-slug)", () => {
  test("re-issuing the same slug reuses a terminal leg — no re-fan-out", async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "what is the best answer?");
    const panelDir = join(dir, "keeper-state", "panels", "resume-run");
    const first = makeAdHocDeps();
    await panelStart(
      {
        promptFile,
        slug: "resume-run",
        panel: undefined,
        adHoc: { preset: "codex-review", readOnly: true },
        timeoutSeconds: 900,
      },
      first.deps,
    );
    expect(first.spawns.length).toBe(1);
    // The single leg completed (a terminal result file lands in the durable dir).
    writeFileSync(
      join(panelDir, "codex-review.yaml"),
      `${JSON.stringify({ schema_version: 1, outcome: "completed", message: null })}\n`,
    );
    const second = makeAdHocDeps();
    const code = await panelStart(
      {
        promptFile,
        slug: "resume-run",
        panel: undefined,
        adHoc: { preset: "codex-review", readOnly: true },
        timeoutSeconds: 900,
      },
      second.deps,
    );
    expect(code).toBe(0);
    expect(second.spawns.length).toBe(0); // reused, never re-fanned-out
    const manifest: PanelManifest = JSON.parse(
      readFileSync(join(panelDir, "manifest.json"), "utf8"),
    );
    expect(manifest.generation).toBe(1);
  });

  test("explicit resume replaces a no-result dead leg on the same request", async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "q");
    const panelDir = join(dir, "keeper-state", "panels", "relaunch-run");
    const first = makeAdHocDeps();
    await panelStart(
      {
        promptFile,
        slug: "relaunch-run",
        panel: undefined,
        adHoc: { preset: "codex-review", readOnly: true },
        timeoutSeconds: 900,
      },
      first.deps,
    );
    // The leg recorded a pidfile but died before any result (dead pid).
    writeFileSync(join(panelDir, "codex-review.pidfile"), "9999\n");
    // graceMs 0 so the same-boot dead pid is not grace-held; makeAdHocDeps's
    // pidAlive already reads dead.
    const base = makeAdHocDeps();
    const deps2: PanelDeps = { ...base.deps, graceMs: 0 };
    const code = await panelResume(
      {
        promptFile,
        slug: "relaunch-run",
        panel: undefined,
        adHoc: { preset: "codex-review", readOnly: true },
        timeoutSeconds: 900,
      },
      deps2,
    );
    expect(code).toBe(0);
    expect(base.spawns.length).toBe(1);
    const leg = legOf(base.spawns[0] as AdHocSpawn);
    expect(leg[leg.indexOf("--output") + 1]).toBe(
      join(panelDir, "codex-review.g2.yaml"),
    );
    const manifest: PanelManifest = JSON.parse(
      readFileSync(join(panelDir, "manifest.json"), "utf8"),
    );
    expect(manifest.generation).toBe(2);
  });

  test("a member-set mismatch on re-issue exits 2 (no relaunch)", async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "same q");
    const first = makeAdHocDeps();
    await panelStart(
      {
        promptFile,
        slug: "collide-run",
        panel: undefined,
        adHoc: { preset: "codex-review", readOnly: true },
        timeoutSeconds: 900,
      },
      first.deps,
    );
    // Same prompt + slug, a DIFFERENT member (--cli codex → name "codex").
    const second = makeAdHocDeps();
    const code = await panelStart(
      {
        promptFile,
        slug: "collide-run",
        panel: undefined,
        adHoc: { cli: "codex", readOnly: true },
        timeoutSeconds: 900,
      },
      second.deps,
    );
    expect(code).toBe(2);
    expect(second.spawns.length).toBe(0);
  });
});

describe("parseManifest (durable fields)", () => {
  test("round-trips boot_epoch_ms + generation + per-leg launched_at", () => {
    const r = parseManifest({
      dir: "/d",
      slug: "run-x",
      boot_epoch_ms: 42,
      generation: 3,
      members: [
        {
          name: "x",
          harness: "codex",
          yaml: "/d/x.yaml",
          pidfile: "/d/x.pidfile",
          launched_at: 7,
        },
        {
          name: "y",
          harness: "claude",
          yaml: "/d/y.yaml",
          pidfile: null,
          launched_at: null,
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.boot_epoch_ms).toBe(42);
    expect(r.manifest.generation).toBe(3);
    expect(r.manifest.members[0]?.launched_at).toBe(7);
    expect(r.manifest.members[1]?.launched_at).toBeNull();
  });

  test("rejects a malformed boot_epoch_ms (present but not a number)", () => {
    const r = parseManifest({
      dir: "/d",
      slug: "run-x",
      boot_epoch_ms: "not-a-number",
      members: [
        { name: "x", harness: "codex", yaml: "/d/x.yaml", pidfile: null },
      ],
    });
    expect(r.ok).toBe(false);
  });

  test("rejects a malformed per-leg launched_at", () => {
    const r = parseManifest({
      dir: "/d",
      slug: "run-x",
      members: [
        {
          name: "x",
          harness: "codex",
          yaml: "/d/x.yaml",
          pidfile: null,
          launched_at: "soon",
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  test("tolerates an absent boot-epoch (pre-durable manifest) → boot_epoch_ms undefined (NOT 0) / gen 1 / launched_at null", () => {
    const r = parseManifest({
      dir: "/d",
      slug: "run-x",
      members: [
        { name: "x", harness: "codex", yaml: "/d/x.yaml", pidfile: null },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Absence is preserved as undefined (never coerced to 0) so `wait`'s reboot
    // guard fails OPEN on a pre-durable manifest instead of reading 0 as a reboot.
    expect(r.manifest.boot_epoch_ms).toBeUndefined();
    expect(r.manifest.generation).toBe(1);
    expect(r.manifest.members[0]?.launched_at).toBeNull();
  });

  test("threads a per-leg startfile when present; tolerates its absence (→ null)", () => {
    const r = parseManifest({
      dir: "/d",
      slug: "run-x",
      members: [
        {
          name: "x",
          harness: "codex",
          yaml: "/d/x.yaml",
          pidfile: "/d/x.pidfile",
          startfile: "/d/x.starttime",
        },
        { name: "y", harness: "claude", yaml: "/d/y.yaml", pidfile: null },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.members[0]?.startfile).toBe("/d/x.starttime");
    expect(r.manifest.members[1]?.startfile).toBeNull();
  });

  test("rejects a malformed per-leg startfile (present but not a string)", () => {
    const r = parseManifest({
      dir: "/d",
      slug: "run-x",
      members: [
        {
          name: "x",
          harness: "codex",
          yaml: "/d/x.yaml",
          pidfile: null,
          startfile: 42,
        },
      ],
    });
    expect(r.ok).toBe(false);
  });
});

test("agent panel start: --panel + --preset together → exit 2 (mutually exclusive)", async () => {
  const promptFile = join(dir, "ask.md");
  writeFileSync(promptFile, "question");
  const r = await runAgent([
    "panel",
    "start",
    promptFile,
    "--slug",
    "mx-run",
    "--panel",
    "default",
    "--preset",
    "codex-review",
    "--run-dir",
    join(dir, "scratch-mx"),
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("mutually exclusive");
});

// An ad-hoc override flag with no --preset/--cli selector would be silently
// dropped onto the configured path — fail loud instead (finding F1/F4).
for (const flag of ["model", "effort", "role"] as const) {
  test(`agent panel start: --${flag} without a selector → exit 2 (fail loud, not silent drop)`, async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "question");
    const r = await runAgent([
      "panel",
      "start",
      promptFile,
      "--slug",
      "orphan-run",
      "--panel",
      "default",
      `--${flag}`,
      "x",
      "--run-dir",
      join(dir, `scratch-orphan-${flag}`),
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`--${flag}`);
    expect(r.stderr).toContain("--preset");
  });
}

// ---------------------------------------------------------------------------
// status / prune helpers (injected deps + KEEPER_STATE_DIR sandbox)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** `panelStatus`/`panelPrune` deps with a fixed clock, a pid-liveness predicate,
 *  and an optional lock seam. Captures stdout/stderr. graceMs is pinned so the
 *  launched_at grace is deterministic. */
function makeProbeDeps(opts: {
  now: number;
  alive?: (pid: number) => boolean;
  readStartTime?: PanelDeps["readStartTime"];
  lock?: PanelDeps["lock"];
}): { deps: PanelDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const deps: PanelDeps = {
    keeperBin: "/bun",
    keeperAgentPath: "/keeper.ts",
    env: {},
    cwd: "/",
    loadRegistry: () => ({
      catalog: { presets: {} },
      selections: { panels: {}, default: null },
    }),
    spawn: () => {},
    now: () => opts.now,
    sleep: async () => {},
    pidAlive: opts.alive ?? (() => false),
    // Fork-free default (the recycle guard degrades to bare liveness); a recycle
    // test injects a probe that mismatches the seeded startfile.
    readStartTime: opts.readStartTime ?? (() => null),
    lock: opts.lock,
    write: (s) => {
      out.push(s);
    },
    writeErr: (s) => {
      err.push(s);
    },
    graceMs: 3000,
  };
  return { deps, out, err };
}

/** Write a manifest + optional pidfile/result files into a run dir. */
function seedRunDir(
  d: string,
  slug: string,
  members: PanelManifestMember[],
  opts: { sentinel?: boolean; pids?: Record<string, string> } = {},
): void {
  mkdirSync(d, { recursive: true });
  if (opts.sentinel !== false) {
    writeFileSync(join(d, "started-at"), "0\n");
  }
  writeFileSync(
    join(d, "manifest.json"),
    JSON.stringify({ dir: d, slug, members } satisfies PanelManifest),
  );
  for (const [pidfile, pid] of Object.entries(opts.pids ?? {})) {
    writeFileSync(pidfile, `${pid}\n`);
  }
}

// ---------------------------------------------------------------------------
// panel status — non-blocking per-leg snapshot, launched_at grace
// ---------------------------------------------------------------------------

describe("panelStatus (launched_at grace, no false running)", () => {
  test("classifies completed/failed/running/absent per leg", () => {
    const pdir = mkdtempSync(join(dir, "status-"));
    const NOW = 1_000_000;
    const members: PanelManifestMember[] = [
      {
        name: "done",
        harness: "claude",
        yaml: join(pdir, "done.yaml"),
        pidfile: join(pdir, "done.pid"),
        launched_at: NOW - 10_000,
      },
      {
        name: "bad",
        harness: "codex",
        yaml: join(pdir, "bad.yaml"),
        pidfile: join(pdir, "bad.pid"),
        launched_at: NOW - 10_000,
      },
      {
        name: "live",
        harness: "claude",
        yaml: join(pdir, "live.yaml"),
        pidfile: join(pdir, "live.pid"),
        launched_at: NOW - 10_000,
      },
      {
        name: "deadold",
        harness: "codex",
        yaml: join(pdir, "deadold.yaml"),
        pidfile: join(pdir, "deadold.pid"),
        launched_at: NOW - 10_000,
      },
      {
        name: "deadnew",
        harness: "claude",
        yaml: join(pdir, "deadnew.yaml"),
        pidfile: join(pdir, "deadnew.pid"),
        launched_at: NOW - 100,
      },
      {
        name: "nolaunch",
        harness: "codex",
        yaml: join(pdir, "nolaunch.yaml"),
        pidfile: null,
        launched_at: null,
      },
      {
        name: "gone",
        harness: "claude",
        yaml: join(pdir, "gone.yaml"),
        pidfile: join(pdir, "gone.pid"),
        launched_at: null,
      },
    ];
    writeFileSync(
      join(pdir, "manifest.json"),
      JSON.stringify({
        dir: pdir,
        slug: "status-run",
        boot_epoch_ms: 1,
        generation: 2,
        members,
      }),
    );
    writeFileSync(
      join(pdir, "done.yaml"),
      JSON.stringify({ outcome: "completed", message: "done answer" }),
    );
    writeFileSync(
      join(pdir, "bad.yaml"),
      JSON.stringify({ outcome: "timed_out" }),
    );
    writeFileSync(join(pdir, "live.pid"), "111\n");
    writeFileSync(join(pdir, "deadold.pid"), "222\n");
    writeFileSync(join(pdir, "deadnew.pid"), "333\n");
    // "gone" pidfile is intentionally absent → readPid null + launched_at null → absent.

    const { deps, out } = makeProbeDeps({
      now: NOW,
      alive: (pid) => pid === 111,
    });
    const code = panelStatus({ dir: pdir }, deps);
    expect(code).toBe(0);
    const snap: PanelStatus = JSON.parse(out.join("").trim());
    const byName = Object.fromEntries(
      snap.members.map((m) => [m.name, m.status]),
    );
    expect(byName.done).toBe("completed");
    expect(byName.bad).toBe("failed");
    expect(byName.live).toBe("running");
    // A long-dead no-result leg reads failed (past grace), NEVER a phantom running.
    expect(byName.deadold).toBe("failed");
    // Within its own launched_at grace → still running (pidfile may not be written).
    expect(byName.deadnew).toBe("running");
    expect(byName.nolaunch).toBe("failed");
    expect(byName.gone).toBe("absent");
    expect(snap.all_terminal).toBe(false);
    expect(snap.slug).toBe("status-run");
    expect(snap.generation).toBe(2);
    // The completed leg carries its result path; the snapshot never reads content.
    const done = snap.members.find((m) => m.name === "done");
    expect(done?.yaml).toBe(join(pdir, "done.yaml"));
  });

  test("all-terminal snapshot → all_terminal true", () => {
    const pdir = mkdtempSync(join(dir, "status-term-"));
    seedRunDir(pdir, "term-run", [
      {
        name: "x",
        harness: "codex",
        yaml: join(pdir, "x.yaml"),
        pidfile: null,
        launched_at: null,
      },
    ]);
    writeFileSync(
      join(pdir, "x.yaml"),
      JSON.stringify({ outcome: "completed", message: "x answer" }),
    );
    const { deps, out } = makeProbeDeps({ now: 0 });
    expect(panelStatus({ dir: pdir }, deps)).toBe(0);
    const snap: PanelStatus = JSON.parse(out.join("").trim());
    expect(snap.all_terminal).toBe(true);
  });

  test("missing manifest → exit 2", () => {
    const { deps, err } = makeProbeDeps({ now: 0 });
    expect(panelStatus({ dir: join(dir, "no-such") }, deps)).toBe(2);
    expect(err.join("")).toContain("cannot read manifest");
  });

  test("recycle guard: a live pid with a mismatched start-time reads failed, never running", () => {
    const pdir = mkdtempSync(join(dir, "status-recycle-"));
    const NOW = 1_000_000;
    writeFileSync(
      join(pdir, "manifest.json"),
      JSON.stringify({
        dir: pdir,
        slug: "recycle-run",
        generation: 1,
        members: [
          {
            name: "live",
            harness: "claude",
            yaml: join(pdir, "live.yaml"),
            pidfile: join(pdir, "live.pid"),
            startfile: join(pdir, "live.starttime"),
            launched_at: NOW - 10_000, // well past the grace
          },
        ],
      }),
    );
    writeFileSync(join(pdir, "live.pid"), "111\n");
    writeFileSync(join(pdir, "live.starttime"), "STORED    \n");
    const { deps, out } = makeProbeDeps({
      now: NOW,
      alive: (pid) => pid === 111, // kill(pid,0) says alive...
      readStartTime: (pid) => (pid === 111 ? "RECYCLED" : null), // ...a different proc
    });
    expect(panelStatus({ dir: pdir }, deps)).toBe(0);
    const snap: PanelStatus = JSON.parse(out.join("").trim());
    // A recycled pid past grace reads failed — never a phantom running.
    expect(snap.members[0]?.status).toBe("failed");
    expect(snap.all_terminal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wait/status routing — --slug resolves the durable dir, --run-dir wins
// ---------------------------------------------------------------------------

/** Seed a terminal run at the durable slug path under the sandboxed state dir. */
function seedDurableTerminal(slug: string): string {
  const panelDir = join(dir, "keeper-state", "panels", slug);
  mkdirSync(panelDir, { recursive: true });
  writeFileSync(
    join(panelDir, "manifest.json"),
    JSON.stringify({
      dir: panelDir,
      slug,
      generation: 1,
      members: [
        {
          name: "opus",
          harness: "claude",
          yaml: join(panelDir, "opus.yaml"),
          pidfile: null,
        },
      ],
    }),
  );
  writeFileSync(
    join(panelDir, "opus.yaml"),
    JSON.stringify({ outcome: "completed", message: "opus answer" }),
  );
  return panelDir;
}

test("agent panel wait --slug: resolves the durable slug dir", async () => {
  const panelDir = seedDurableTerminal("resolve-run");
  const r = await runAgent([
    "panel",
    "wait",
    "--slug",
    "resolve-run",
    "--chunk",
    "540s",
  ]);
  expect(r.code).toBe(0);
  const v: PanelVerdict = JSON.parse(r.stdout.trim());
  expect(v.dir).toBe(panelDir);
  expect(v.ok).toBe(true);
});

test("agent panel wait: --run-dir wins when both --run-dir and --slug are given", async () => {
  const pdir = seedTerminalPanel();
  const r = await runAgent([
    "panel",
    "wait",
    "--run-dir",
    pdir,
    "--slug",
    "nonexistent",
    "--chunk",
    "540s",
  ]);
  expect(r.code).toBe(0);
  const v: PanelVerdict = JSON.parse(r.stdout.trim());
  expect(v.dir).toBe(pdir);
});

test("agent panel wait --slug: an unknown/pruned slug → exit 2 (missing manifest)", async () => {
  const r = await runAgent(["panel", "wait", "--slug", "never-started"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("cannot read manifest");
});

test("agent panel wait: neither --run-dir nor --slug → exit 2", async () => {
  const r = await runAgent(["panel", "wait"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--run-dir");
});

test("agent panel status --slug: prints the snapshot, exit 0", async () => {
  seedDurableTerminal("snap-run");
  const r = await runAgent(["panel", "status", "--slug", "snap-run"]);
  expect(r.code).toBe(0);
  const snap: PanelStatus = JSON.parse(r.stdout.trim());
  expect(snap.slug).toBe("snap-run");
  expect(snap.members[0]?.status).toBe("completed");
});

test("agent panel status: neither --run-dir nor --slug → exit 2", async () => {
  const r = await runAgent(["panel", "status"]);
  expect(r.code).toBe(2);
});

// ---------------------------------------------------------------------------
// Retired spelling — the run-dir flag is --run-dir; the old --dir hard-fails
// (unknown option → exit 2), never silently ignored, on every sub-verb.
// ---------------------------------------------------------------------------

for (const op of ["wait", "status", "start"] as const) {
  test(`agent panel ${op}: the retired --dir spelling hard-fails exit 2`, async () => {
    const r = await runAgent(["panel", op, "--dir", join(dir, "whatever")]);
    expect(r.code).toBe(2);
  });
}

// ---------------------------------------------------------------------------
// panel prune — lock + live-pid + TTL gates, TOCTOU-safe delete
// ---------------------------------------------------------------------------

describe("panelPrune (lock-free AND pid-dead AND past TTL)", () => {
  test("an aged-out lock-free pid-dead dir is trashed then removed", () => {
    const root = join(dir, "keeper-state", "panels");
    const d = join(root, "old-run");
    seedRunDir(
      d,
      "old-run",
      [
        {
          name: "x",
          harness: "codex",
          yaml: join(d, "x.yaml"),
          pidfile: join(d, "x.pid"),
        },
      ],
      { pids: { [join(d, "x.pid")]: "9999" } },
    );
    const { deps, out } = makeProbeDeps({
      now: Date.now() + 10 * DAY_MS,
      alive: () => false,
    });
    expect(panelPrune({ ttlMs: 1000 }, deps)).toBe(0);
    expect(existsSync(d)).toBe(false);
    const res: PanelPruneResult = JSON.parse(out.join("").trim());
    expect(res.pruned).toContain("old-run");
    expect(res.kept).not.toContain("old-run");
  });

  test("a dir with a live leg pid is kept regardless of age", () => {
    const root = join(dir, "keeper-state", "panels");
    const d = join(root, "live-run");
    seedRunDir(
      d,
      "live-run",
      [
        {
          name: "x",
          harness: "codex",
          yaml: join(d, "x.yaml"),
          pidfile: join(d, "x.pid"),
        },
      ],
      { pids: { [join(d, "x.pid")]: "111" } },
    );
    const { deps, out } = makeProbeDeps({
      now: Date.now() + 10 * DAY_MS,
      alive: (pid) => pid === 111,
    });
    panelPrune({ ttlMs: 1000 }, deps);
    expect(existsSync(d)).toBe(true);
    const res: PanelPruneResult = JSON.parse(out.join("").trim());
    expect(res.kept).toContain("live-run");
    expect(res.pruned).not.toContain("live-run");
  });

  test("prune veto: a recycled leg pid (start-time drift) no longer keeps a dir alive", () => {
    const root = join(dir, "keeper-state", "panels");
    const d = join(root, "recycled-run");
    seedRunDir(
      d,
      "recycled-run",
      [
        {
          name: "x",
          harness: "codex",
          yaml: join(d, "x.yaml"),
          pidfile: join(d, "x.pid"),
          startfile: join(d, "x.starttime"),
        },
      ],
      { pids: { [join(d, "x.pid")]: "111" } },
    );
    writeFileSync(join(d, "x.starttime"), "STORED    \n");
    const { deps, out } = makeProbeDeps({
      now: Date.now() + 10 * DAY_MS,
      alive: (pid) => pid === 111, // kill(pid,0) says alive...
      readStartTime: (pid) => (pid === 111 ? "RECYCLED" : null), // ...but recycled
    });
    panelPrune({ ttlMs: 1000 }, deps);
    // The recycled pid is not a live leg → the aged-out dir is reclaimed.
    expect(existsSync(d)).toBe(false);
    const res: PanelPruneResult = JSON.parse(out.join("").trim());
    expect(res.pruned).toContain("recycled-run");
    expect(res.kept).not.toContain("recycled-run");
  });

  test("a lock-held dir (start/reconcile mid-flight) is skipped", () => {
    const root = join(dir, "keeper-state", "panels");
    const d = join(root, "locked-run");
    seedRunDir(d, "locked-run", []);
    const { deps, out } = makeProbeDeps({
      now: Date.now() + 10 * DAY_MS,
      lock: (lockPath) =>
        lockPath.includes("locked-run") ? null : { release: (): void => {} },
    });
    panelPrune({ ttlMs: 1000 }, deps);
    expect(existsSync(d)).toBe(true);
    const res: PanelPruneResult = JSON.parse(out.join("").trim());
    expect(res.kept).toContain("locked-run");
  });

  test("a fresh dir (within TTL) is kept", () => {
    const root = join(dir, "keeper-state", "panels");
    const d = join(root, "fresh-run");
    seedRunDir(d, "fresh-run", []);
    const { deps, out } = makeProbeDeps({
      now: Date.now(),
      alive: () => false,
    });
    panelPrune({}, deps); // default 3-day TTL — the sentinel is seconds old.
    expect(existsSync(d)).toBe(true);
    const res: PanelPruneResult = JSON.parse(out.join("").trim());
    expect(res.kept).toContain("fresh-run");
  });

  test("a dir without a started-at sentinel is un-ageable → kept", () => {
    const root = join(dir, "keeper-state", "panels");
    const d = join(root, "no-sentinel");
    seedRunDir(d, "no-sentinel", [], { sentinel: false });
    const { deps, out } = makeProbeDeps({
      now: Date.now() + 10 * DAY_MS,
      alive: () => false,
    });
    panelPrune({ ttlMs: 1000 }, deps);
    expect(existsSync(d)).toBe(true);
    const res: PanelPruneResult = JSON.parse(out.join("").trim());
    expect(res.kept).toContain("no-sentinel");
  });

  test("a missing panels root → empty result, exit 0", () => {
    const { deps, out } = makeProbeDeps({ now: Date.now() });
    expect(panelPrune({}, deps)).toBe(0);
    const res: PanelPruneResult = JSON.parse(out.join("").trim());
    expect(res.pruned).toEqual([]);
    expect(res.kept).toEqual([]);
  });
});

test("agent panel prune: routes + prints a result, exit 0", async () => {
  const r = await runAgent(["panel", "prune"]);
  expect(r.code).toBe(0);
  const res: PanelPruneResult = JSON.parse(r.stdout.trim());
  expect(Array.isArray(res.pruned)).toBe(true);
  expect(Array.isArray(res.kept)).toBe(true);
});

// ---------------------------------------------------------------------------
// panelStart writes the prune age anchor
// ---------------------------------------------------------------------------

test("panelStart writes a started-at sentinel on fresh start (prune age anchor)", async () => {
  const promptFile = join(dir, "ask.md");
  writeFileSync(promptFile, "q");
  const { deps } = makeAdHocDeps();
  await panelStart(
    {
      promptFile,
      slug: "sentinel-run",
      panel: undefined,
      adHoc: { preset: "codex-review", readOnly: true },
      timeoutSeconds: 900,
    },
    deps,
  );
  const panelDir = join(dir, "keeper-state", "panels", "sentinel-run");
  expect(existsSync(join(panelDir, "started-at"))).toBe(true);
});

// ---------------------------------------------------------------------------
// Synopsis surfaces document the three new verbs
// ---------------------------------------------------------------------------

test("PANEL_HELP documents status + prune + wait --slug", () => {
  expect(PANEL_HELP).toContain("panel status");
  expect(PANEL_HELP).toContain("panel prune");
  expect(PANEL_HELP).toContain("--slug");
});

test("top-level USAGE documents panel status + prune", () => {
  expect(USAGE).toContain("keeper agent panel status");
  expect(USAGE).toContain("keeper agent panel prune");
});

test("wrapper KEEPER_AGENT_HELP documents panel status + prune", () => {
  expect(KEEPER_AGENT_HELP).toContain("keeper agent panel status");
  expect(KEEPER_AGENT_HELP).toContain("keeper agent panel prune");
});
