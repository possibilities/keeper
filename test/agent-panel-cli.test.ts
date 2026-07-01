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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    "--panel",
    "default",
    "--dir",
    join(dir, "scratch"),
  ]);
  expect(r.code).toBe(2);
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
  });

  test("an ad-hoc member with readOnly=false drops --read-only + omits posture flags", () => {
    const leg = buildPanelLegArgv({
      keeperBin: AD_HOC_KEEPER_BIN,
      keeperAgentPath: AD_HOC_KEEPER_AGENT,
      prompt: "explore",
      member: { name: "claude", harness: "claude", readOnly: false },
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
});

test("agent panel start: --panel + --preset together → exit 2 (mutually exclusive)", async () => {
  const promptFile = join(dir, "ask.md");
  writeFileSync(promptFile, "question");
  const r = await runAgent([
    "panel",
    "start",
    promptFile,
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
