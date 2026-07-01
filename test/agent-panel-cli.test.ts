/**
 * `keeper agent panel start|wait` — the routing-parity lock for the panel
 * fan-out exposed under the `agent` namespace. `agent panel` routes into the
 * SAME `src/pair/panel.ts` `runPanel` the `keeper pair panel` branch calls, so
 * the manifest/verdict JSON + exit semantics (0 all-terminal / 124 chunk-elapsed
 * / 2 bad-config) are structurally identical — this suite proves the wiring and
 * asserts byte-identical output against `pair panel` on the same argv.
 *
 * The pure classifier (`splitSubcommand`) is unit-tested directly. Routing is
 * driven through `src/agent/main` main() with a stubbed MainDeps, patching
 * process.{exit,stdout,stderr} (mirroring pair-cli.test.ts) because `runPanel`
 * owns its own stdout + exit code via the process globals, not the injected
 * seams. Only the NON-spawning paths are exercised end-to-end (`wait` reads a
 * seeded manifest + result files; a bad-config `start` fails before any leg
 * spawns) — the real detached-leg launch is the slow-tier sibling
 * `test/pair-panel.slow.test.ts`, never the fast tier.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as pairMain } from "../cli/pair";
import {
  KEEPER_AGENT_HELP,
  splitSubcommand,
  USAGE,
} from "../src/agent/dispatch";
import { main as agentMain } from "../src/agent/main";
import type { PanelManifest, PanelVerdict } from "../src/pair/panel";
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

/** Drive `keeper pair <argv>` through cli/pair main() (the reference wiring). */
async function runPair(argv: string[]): Promise<MainRun> {
  return runCapturing(() => pairMain(argv));
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

test("agent panel wait: verdict is byte-identical to `pair panel wait`", async () => {
  const pdir = seedTerminalPanel();
  const agent = await runAgent([
    "panel",
    "wait",
    "--dir",
    pdir,
    "--chunk",
    "540",
  ]);
  const pair = await runPair([
    "panel",
    "wait",
    "--dir",
    pdir,
    "--chunk",
    "540",
  ]);
  expect(agent.code).toBe(pair.code);
  expect(agent.stdout).toBe(pair.stdout);
  expect(agent.stderr).toBe(pair.stderr);
});

test("agent panel wait: missing manifest → exit 2 (same as pair panel)", async () => {
  const missing = join(dir, "no-such-panel-dir");
  const agent = await runAgent(["panel", "wait", "--dir", missing]);
  const pair = await runPair(["panel", "wait", "--dir", missing]);
  expect(agent.code).toBe(2);
  expect(agent.stderr).toContain("cannot read manifest");
  expect(agent.code).toBe(pair.code);
  expect(agent.stderr).toBe(pair.stderr);
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

test("agent panel: unknown operation → exit 2 (same as pair panel)", async () => {
  const agent = await runAgent(["panel", "frobnicate"]);
  const pair = await runPair(["panel", "frobnicate"]);
  expect(agent.code).toBe(2);
  expect(agent.stderr).toContain("unknown operation");
  expect(agent.code).toBe(pair.code);
  expect(agent.stderr).toBe(pair.stderr);
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
