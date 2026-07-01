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
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
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
  type PanelDeps,
  type PanelManifest,
  type PanelVerdict,
  panelStart,
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
    splitSubcommand(["panel", "wait", "--dir", "/d", "--chunk", "540"]),
  ).toEqual({ kind: "panel", rest: ["wait", "--dir", "/d", "--chunk", "540"] });
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
      // The durable panel-state root — sandboxed so `start` without `--dir` never
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
    `${JSON.stringify({ schema_version: 1, outcome: "completed", message: null })}\n`,
  );
  return pdir;
}

test("agent panel wait: terminal panel → exit 0 + verdict JSON (content-blind)", async () => {
  const pdir = seedTerminalPanel();
  const r = await runAgent(["panel", "wait", "--dir", pdir, "--chunk", "540"]);
  expect(r.code).toBe(0);
  const v: PanelVerdict = JSON.parse(r.stdout.trim());
  expect(v.ok).toBe(true);
  expect(v.dir).toBe(pdir);
  expect(v.members.map((m) => m.name)).toEqual(["opus", "codex"]);
  // The verdict never leaks a panelist's answer.
  expect(r.stdout).not.toContain("SECRET_ANSWER_DO_NOT_LEAK");
});

test("agent panel wait: missing manifest → exit 2", async () => {
  const missing = join(dir, "no-such-panel-dir");
  const agent = await runAgent(["panel", "wait", "--dir", missing]);
  expect(agent.code).toBe(2);
  expect(agent.stderr).toContain("cannot read manifest");
});

test("agent panel wait: no --dir → exit 2", async () => {
  const r = await runAgent(["panel", "wait"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--dir");
});

test("agent panel wait: --chunk above the ceiling → exit 2", async () => {
  const pdir = seedTerminalPanel();
  const r = await runAgent(["panel", "wait", "--dir", pdir, "--chunk", "9999"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("ceiling");
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
    "--dir",
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
    "--dir",
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
    "--dir",
    join(dir, "scratch-emptyslug"),
  ]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("slugifies to nothing");
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

  test("a configured 2-member panel names each leg panel::<slug>::<its-preset>", async () => {
    const promptFile = join(dir, "ask.md");
    writeFileSync(promptFile, "what is the best answer?");
    const pdir = join(dir, "fanout");
    const spawns: AdHocSpawn[] = [];
    const deps: PanelDeps = {
      ...makeAdHocDeps().deps,
      loadRegistry: () => ({
        catalog: {
          presets: {
            "opus-x": mkPreset("claude"),
            "codex-x": mkPreset("codex"),
          },
        },
        selections: { panels: { duo: ["opus-x", "codex-x"] }, default: null },
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
    // Each leg's --name carries ITS OWN preset, not a shared one.
    const legA = legOf(spawns[0] as AdHocSpawn);
    const legB = legOf(spawns[1] as AdHocSpawn);
    expect(legA[legA.indexOf("--name") + 1]).toBe("panel::duo-run::opus-x");
    expect(legB[legB.indexOf("--name") + 1]).toBe("panel::duo-run::codex-x");
    // The manifest records the run slug top-level.
    const manifest: PanelManifest = JSON.parse(
      readFileSync(join(pdir, "manifest.json"), "utf8"),
    );
    expect(manifest.slug).toBe("duo-run");
  });
});

describe("panelStart (durable slug-keyed dir + boot-epoch manifest)", () => {
  test("without --dir → writes keeperStateDir()/panels/<slug>/ (0700); manifest carries boot_epoch_ms + per-leg launched_at", async () => {
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

  test("--dir override wins (no durable dir minted); the boot-epoch seam is injected", async () => {
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
        catalog: {
          presets: {
            "opus-x": mkPreset("claude"),
            "codex-x": mkPreset("codex"),
          },
        },
        selections: { panels: { duo: ["opus-x", "codex-x"] }, default: null },
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

  test("tolerates an absent boot-epoch (pre-durable manifest) → defaults 0 / gen 1 / launched_at null", () => {
    const r = parseManifest({
      dir: "/d",
      slug: "run-x",
      members: [
        { name: "x", harness: "codex", yaml: "/d/x.yaml", pidfile: null },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.boot_epoch_ms).toBe(0);
    expect(r.manifest.generation).toBe(1);
    expect(r.manifest.members[0]?.launched_at).toBeNull();
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
    "--dir",
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
      "--dir",
      join(dir, `scratch-orphan-${flag}`),
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`--${flag}`);
    expect(r.stderr).toContain("--preset");
  });
}
