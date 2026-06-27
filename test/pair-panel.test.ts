/**
 * `keeper pair panel start|wait` — the fast-tier regression lock for the
 * cross-OS panel orchestrator (src/pair/panel.ts). Everything OS-specific is
 * injected: a fake `spawn` (records the wrapper argv, never launches), a fake
 * clock + `sleep` (deterministic deadline), and a fake `pidAlive`. The leg
 * outcomes are simulated by writing the `.yaml`/`.log`/`.pidfile` sentinels into
 * a real scratch dir, so terminality + the verdict are exercised against real fs
 * without a single real process. The detached-survival case (the keystone proof
 * that legs outlive `start`'s exit on macOS) is the REAL-spawn sibling in
 * `test/pair-panel.slow.test.ts`.
 *
 * Coverage: member resolution (registry panel / single preset / legacy fallback
 * / pi reject); leg + detach-wrapper argv shape (zero setsid/timeout/gtimeout);
 * `start` manifest persist+print + legacy `--cli` legs; `wait` full-success
 * N-of-N (exit 0, ok:true), mixed-fail (exit 0, ok:false, reason populated),
 * 124-timeout, crash-fail via dead pid past grace, content-blindness, manifest
 * round-trip, `--chunk` ceiling, and corrupt/missing manifest.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  type Preset,
  type PresetRegistry,
} from "../src/agent/config";
import {
  buildDetachWrapperArgv,
  buildPanelLegArgv,
  DETACH_SCRIPT,
  type PanelDeps,
  type PanelManifest,
  type PanelVerdict,
  panelStart,
  panelWait,
  parseManifest,
  resolvePanelMembers,
} from "../src/pair/panel";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pair-panel-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---- helpers --------------------------------------------------------------

function preset(harness: Preset["harness"]): Preset {
  return { harness, model: null, effort: null, thinking: null, role: null };
}

const KEEPER_BIN = "/usr/local/bin/bun";
const KEEPER_AGENT = "/abs/cli/keeper.ts";

interface SpawnCall {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
}

function makeDeps(opts: {
  registry?: PresetRegistry;
  clock?: { ms: number };
  pidAlive?: (pid: number) => boolean;
  graceMs?: number;
  pollIntervalMs?: number;
  throwOnSpawn?: (argv: string[]) => boolean;
}): {
  deps: PanelDeps;
  spawns: SpawnCall[];
  stdout: () => string;
  stderr: () => string;
} {
  const spawns: SpawnCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const clock = opts.clock ?? { ms: 0 };
  const deps: PanelDeps = {
    keeperBin: KEEPER_BIN,
    keeperAgentPath: KEEPER_AGENT,
    env: { PATH: "/usr/bin" },
    cwd: "/work/repo",
    loadRegistry: () => opts.registry ?? { presets: {}, panels: {} },
    spawn: (argv, o) => {
      if (opts.throwOnSpawn?.(argv)) {
        throw new Error("spawn boom");
      }
      spawns.push({ argv, env: o.env, cwd: o.cwd });
    },
    now: () => clock.ms,
    sleep: async (ms) => {
      clock.ms += ms;
    },
    pidAlive: opts.pidAlive ?? (() => false),
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    pollIntervalMs: opts.pollIntervalMs,
    graceMs: opts.graceMs,
  };
  return {
    deps,
    spawns,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

/** Write a prompt file in the scratch dir and return its path. */
function writePrompt(text = "what is the best answer?"): string {
  const p = join(dir, "prompt.txt");
  writeFileSync(p, text);
  return p;
}

function readManifest(): PanelManifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

// ---- member resolution ----------------------------------------------------

test("resolvePanelMembers: registry panel hit → preset-named members", () => {
  const registry: PresetRegistry = {
    presets: { rA: preset("claude"), rB: preset("codex") },
    panels: { default: ["rA", "rB"] },
  };
  const r = resolvePanelMembers(registry, "default");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members).toEqual([
    { name: "rA", harness: "claude", preset: "rA" },
    { name: "rB", harness: "codex", preset: "rB" },
  ]);
});

test("resolvePanelMembers: a single preset → a one-member panel", () => {
  const registry: PresetRegistry = {
    presets: { solo: preset("claude") },
    panels: {},
  };
  const r = resolvePanelMembers(registry, "solo");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members).toEqual([
    { name: "solo", harness: "claude", preset: "solo" },
  ]);
});

test("resolvePanelMembers: unknown/empty registry → legacy opus+codex fallback", () => {
  const r = resolvePanelMembers({ presets: {}, panels: {} }, "default");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  // Legacy members carry NO preset → launched via --cli.
  expect(r.members).toEqual([
    { name: "opus", harness: "claude" },
    { name: "codex", harness: "codex" },
  ]);
});

test("resolvePanelMembers: a pi panel member is accepted (pair-launchable)", () => {
  const registry: PresetRegistry = {
    presets: { thinker: preset("pi"), rA: preset("claude") },
    panels: { mixed: ["rA", "thinker"] },
  };
  const r = resolvePanelMembers(registry, "mixed");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members).toEqual([
    { name: "rA", harness: "claude", preset: "rA" },
    { name: "thinker", harness: "pi", preset: "thinker" },
  ]);
});

// ---- argv shape ------------------------------------------------------------

test("buildPanelLegArgv: preset member uses --preset; legacy uses --cli; no banned tokens", () => {
  const presetArgv = buildPanelLegArgv({
    keeperBin: KEEPER_BIN,
    keeperAgentPath: KEEPER_AGENT,
    promptPath: "/d/prompt.md",
    member: { name: "rA", harness: "claude", preset: "rA" },
    yamlPath: "/d/rA.yaml",
    timeoutSeconds: 1800,
  });
  expect(presetArgv).toEqual([
    KEEPER_BIN,
    KEEPER_AGENT,
    "pair",
    "send",
    "/d/prompt.md",
    "--preset",
    "rA",
    "--read-only",
    "--session",
    "panels",
    "--output",
    "/d/rA.yaml",
    "--timeout",
    "1800",
  ]);

  const legacyArgv = buildPanelLegArgv({
    keeperBin: KEEPER_BIN,
    keeperAgentPath: KEEPER_AGENT,
    promptPath: "/d/prompt.md",
    member: { name: "codex", harness: "codex" },
    yamlPath: "/d/codex.yaml",
    timeoutSeconds: 1800,
  });
  expect(legacyArgv).toContain("--cli");
  expect(legacyArgv).toContain("codex");
  expect(legacyArgv).not.toContain("--preset");

  const wrapper = buildDetachWrapperArgv(presetArgv);
  expect(wrapper.slice(0, 4)).toEqual(["sh", "-c", DETACH_SCRIPT, "--"]);
  // No coreutils detach/bound commands anywhere — not as the spawn binary, and
  // not inside the detach script (keeper's own `--timeout` FLAG is fine).
  expect(wrapper[0]).toBe("sh");
  for (const banned of ["setsid", "timeout", "gtimeout"]) {
    expect(DETACH_SCRIPT).not.toContain(banned);
    expect(wrapper).not.toContain(banned);
  }
  // The wrapper uses nohup + the env-carried sentinels (not &>>; /bin/sh is bash 3.2).
  expect(DETACH_SCRIPT).toContain("nohup");
  expect(DETACH_SCRIPT).toContain('>"$LOG" 2>&1');
  expect(DETACH_SCRIPT).toContain('echo $! > "$PIDFILE"');
});

// ---- start -----------------------------------------------------------------

test("start: persists + prints a manifest, launches every leg detached", async () => {
  const registry: PresetRegistry = {
    presets: { rA: preset("claude"), rB: preset("codex") },
    panels: { default: ["rA", "rB"] },
  };
  const { deps, spawns, stdout } = makeDeps({ registry });
  const code = await panelStart(
    { promptFile: writePrompt(), panel: "default", dir, timeoutSeconds: 900 },
    deps,
  );
  expect(code).toBe(0);

  // Two legs spawned, each wrapped in the detach shell carrying its sentinels.
  expect(spawns.length).toBe(2);
  for (const s of spawns) {
    expect(s.argv[0]).toBe("sh");
    expect(s.cwd).toBe("/work/repo");
    expect(typeof s.env.LOG).toBe("string");
    expect(typeof s.env.PIDFILE).toBe("string");
    expect(s.env.PATH).toBe("/usr/bin"); // base env carried through
  }

  // Manifest persisted AND printed identically.
  const persisted = readManifest();
  const printed: PanelManifest = JSON.parse(stdout().trim());
  expect(printed).toEqual(persisted);
  expect(persisted.dir).toBe(dir);
  expect(persisted.members.map((m) => m.name)).toEqual(["rA", "rB"]);
  expect(persisted.members[0]?.yaml).toBe(join(dir, "rA.yaml"));
  expect(persisted.members[0]?.pidfile).toBe(join(dir, "rA.pidfile"));
  // Prompt copied into the scratch dir.
  expect(readFileSync(join(dir, "prompt.md"), "utf8")).toBe(
    "what is the best answer?",
  );
});

test("start: legacy fallback launches opus(--cli claude) + codex(--cli codex)", async () => {
  const { deps, spawns } = makeDeps({});
  const code = await panelStart(
    { promptFile: writePrompt(), panel: "default", dir, timeoutSeconds: 1800 },
    deps,
  );
  expect(code).toBe(0);
  expect(spawns.length).toBe(2);
  const opusLeg = spawns[0]?.argv ?? [];
  const codexLeg = spawns[1]?.argv ?? [];
  expect(opusLeg).toContain("--cli");
  expect(opusLeg).toContain("claude");
  expect(opusLeg).not.toContain("--preset");
  expect(codexLeg).toContain("--cli");
  expect(codexLeg).toContain("codex");
});

test("start: a per-leg spawn failure records a null pidfile (no crash)", async () => {
  // opus spawns fine; codex's spawn throws.
  const { deps } = makeDeps({
    throwOnSpawn: (argv) => argv.join(" ").includes("--cli codex"),
  });
  const code = await panelStart(
    { promptFile: writePrompt(), panel: "default", dir, timeoutSeconds: 1800 },
    deps,
  );
  expect(code).toBe(0);
  const m = readManifest();
  expect(m.members[0]?.pidfile).toBe(join(dir, "opus.pidfile"));
  expect(m.members[1]?.name).toBe("codex");
  expect(m.members[1]?.pidfile).toBeNull();
});

test("start: a ConfigError from the registry exits 2", async () => {
  const { deps, stderr } = makeDeps({});
  deps.loadRegistry = () => {
    throw new ConfigError("bad presets.yaml");
  };
  const code = await panelStart(
    { promptFile: writePrompt(), panel: "default", dir, timeoutSeconds: 1800 },
    deps,
  );
  expect(code).toBe(2);
  expect(stderr()).toContain("bad presets.yaml");
});

// ---- wait ------------------------------------------------------------------

/** Drive start (recording spawn) then return the manifest dir for wait. */
async function startLegacy(): Promise<void> {
  const { deps } = makeDeps({});
  await panelStart(
    { promptFile: writePrompt(), panel: "default", dir, timeoutSeconds: 1800 },
    deps,
  );
}

test("wait: full-success N-of-N → exit 0, ok:true (manifest round-trip)", async () => {
  await startLegacy();
  writeFileSync(join(dir, "opus.yaml"), "message: hi\n");
  writeFileSync(join(dir, "codex.yaml"), "message: yo\n");

  const { deps, stdout } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0);
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(true);
  expect(v.dir).toBe(dir);
  expect(v.members).toEqual([
    {
      name: "opus",
      harness: "claude",
      status: "ok",
      yaml: join(dir, "opus.yaml"),
      reason: null,
    },
    {
      name: "codex",
      harness: "codex",
      status: "ok",
      yaml: join(dir, "codex.yaml"),
      reason: null,
    },
  ]);
});

test("wait: mixed verdict (one failed log) → exit 0, ok:false, reason populated", async () => {
  await startLegacy();
  writeFileSync(join(dir, "opus.yaml"), "message: hi\n");
  writeFileSync(
    join(dir, "codex.log"),
    "[keeper-pair] started cli=codex\n[keeper-pair] failed cli=codex output=/x error=agentwrap launch exited 1: boom\n",
  );

  const { deps, stdout } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0); // all-terminal, NOT all-success
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(false);
  expect(v.members[0]).toMatchObject({ name: "opus", status: "ok" });
  expect(v.members[1]).toMatchObject({
    name: "codex",
    status: "fail",
    yaml: null,
  });
  expect(v.members[1]?.reason).toBe("agentwrap launch exited 1: boom");
});

test("wait: content-blind — a panelist answer in .yaml never reaches the verdict", async () => {
  await startLegacy();
  writeFileSync(join(dir, "opus.yaml"), "message: SECRET_ANSWER_DO_NOT_LEAK\n");
  writeFileSync(
    join(dir, "codex.yaml"),
    "message: SECRET_ANSWER_DO_NOT_LEAK\n",
  );

  const { deps, stdout } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0);
  expect(stdout()).not.toContain("SECRET_ANSWER_DO_NOT_LEAK");
});

test("wait: a non-terminal leg with a live pid → exit 124 when the chunk elapses", async () => {
  await startLegacy();
  // opus is done; codex is still running (pid alive, no yaml, no terminal log).
  writeFileSync(join(dir, "opus.yaml"), "message: hi\n");
  writeFileSync(join(dir, "codex.pidfile"), "4242\n");

  const { deps } = makeDeps({ pidAlive: (pid) => pid === 4242 });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(124);
});

test("wait: a dead pid past the startup grace → crash fail (exit 0, ok:false)", async () => {
  await startLegacy();
  writeFileSync(join(dir, "opus.yaml"), "message: hi\n");
  // codex never wrote a yaml or a terminal log line; its pid is gone.
  writeFileSync(join(dir, "codex.pidfile"), "4242\n");

  const { deps, stdout } = makeDeps({ pidAlive: () => false, graceMs: 0 });
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0);
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(false);
  expect(v.members[1]?.status).toBe("fail");
  expect(v.members[1]?.reason).toContain("exited before producing output");
});

test("wait: a null-pidfile (launch-failed) leg is a terminal fail", async () => {
  // Hand-write a manifest with a null pidfile (start's spawn-failure record).
  const manifest: PanelManifest = {
    dir,
    members: [
      {
        name: "codex",
        harness: "codex",
        yaml: join(dir, "codex.yaml"),
        log: join(dir, "codex.log"),
        pidfile: null,
      },
    ],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));

  const { deps, stdout } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0);
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(false);
  expect(v.members[0]?.reason).toContain("failed to launch");
});

test("wait: --chunk above the ceiling is rejected (exit 2)", async () => {
  await startLegacy();
  const { deps, stderr } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 9999 }, deps);
  expect(code).toBe(2);
  expect(stderr()).toContain("ceiling");
});

test("wait: missing manifest → exit 2", async () => {
  const { deps, stderr } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(2);
  expect(stderr()).toContain("cannot read manifest");
});

test("wait: corrupt manifest → exit 2", async () => {
  writeFileSync(join(dir, "manifest.json"), "{not json");
  const { deps, stderr } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(2);
  expect(stderr()).toContain("cannot read manifest");
});

test("parseManifest: rejects a malformed members entry", () => {
  const r = parseManifest({ dir: "/d", members: [{ name: "x" }] });
  expect(r.ok).toBe(false);
});
