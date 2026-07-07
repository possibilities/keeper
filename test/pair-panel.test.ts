/**
 * `keeper agent panel start|wait` — the fast-tier regression lock for the
 * cross-OS panel orchestrator (src/pair/panel.ts). Everything OS-specific is
 * injected: a fake `spawn` (records the wrapper argv, never launches), a fake
 * clock + `sleep` (deterministic deadline), and a fake `pidAlive`. The leg
 * outcomes are simulated by seeding each leg's `--output` result file (a `keeper
 * agent run` JSON envelope carrying an `outcome`) plus its `.pidfile` into a real
 * scratch dir, so terminality + the verdict are exercised against real fs without
 * a single real process. The detached-survival case (the keystone proof that legs
 * outlive `start`'s exit and write their result file on macOS) is the REAL-spawn
 * sibling in `test/pair-panel.slow.test.ts` (skipped unless `KEEPER_RUN_SLOW`).
 *
 * Coverage: member resolution (panel hit / single preset / unknown fail-loud);
 * leg + detach-wrapper argv shape (zero setsid/timeout/gtimeout);
 * `start` manifest persist+print + per-member `--preset` legs; `wait` full-success
 * N-of-N (exit 0, ok:true), the outcome→verdict mapping (completed→ok, every other
 * outcome→fail+reason), corrupt-result→fail, 124-timeout, crash-fail via dead pid
 * past grace, content-blindness, manifest round-trip, `--chunk` ceiling, and
 * corrupt/missing manifest.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  type PanelSelections,
  type Preset,
  type PresetCatalog,
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

/** A two-member `default` panel of opus(claude)+codex(codex) catalog presets —
 *  the stand-in for the removed zero-config fallback in the start/wait tests. */
const DEFAULT_CATALOG: PresetCatalog = {
  presets: { opus: preset("claude"), codex: preset("codex") },
};
const DEFAULT_SELECTIONS: PanelSelections = {
  panels: { default: ["opus", "codex"] },
  default: "default",
};

const KEEPER_BIN = "/usr/local/bin/bun";
const KEEPER_AGENT = "/abs/cli/keeper.ts";

/** The default injected boot-epoch: `start` stamps it and `wait` re-derives the
 *  same value, so the reboot guard never spuriously fires (and no test forks the
 *  real kernel probe). A reboot test overrides `bootEpochMs` with a value beyond
 *  BOOT_EPOCH_TOLERANCE_MS of this. */
const TEST_BOOT_EPOCH_MS = 1_700_000_000_000;

interface SpawnCall {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
}

function makeDeps(opts: {
  catalog?: PresetCatalog;
  selections?: PanelSelections;
  clock?: { ms: number };
  pidAlive?: (pid: number) => boolean;
  graceMs?: number;
  pollIntervalMs?: number;
  throwOnSpawn?: (argv: string[]) => boolean;
  bootEpochMs?: PanelDeps["bootEpochMs"];
  readStartTime?: PanelDeps["readStartTime"];
  lock?: PanelDeps["lock"];
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
    loadRegistry: () => ({
      catalog: opts.catalog ?? { presets: {} },
      selections: opts.selections ?? { panels: {}, default: null },
    }),
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
    // Deterministic + fork-free by default: a fixed boot-epoch (start + wait agree)
    // and a start-time probe that can't tell (→ the recycle guard degrades to bare
    // pid liveness). A recycle/reboot test overrides these.
    bootEpochMs: opts.bootEpochMs ?? (() => TEST_BOOT_EPOCH_MS),
    readStartTime: opts.readStartTime ?? (() => null),
    lock: opts.lock,
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

/** Seed a leg's `--output` result file with a `keeper agent run` JSON envelope
 *  carrying the given `outcome` (the field `evaluateLeg` keys off). */
function seedResult(name: string, outcome: string): void {
  writeFileSync(
    join(dir, `${name}.yaml`),
    `${JSON.stringify({
      schema_version: 1,
      outcome,
      message: outcome === "completed" ? "SECRET_ANSWER_DO_NOT_LEAK" : null,
    })}\n`,
  );
}

/** Seed a leg's `.pidfile` with a pid (simulating the detached wrapper having
 *  recorded the leg's real backgrounded pid). */
function seedPidfile(name: string, pid: number): void {
  writeFileSync(join(dir, `${name}.pidfile`), `${pid}\n`);
}

/** Seed a leg's `.starttime` with the wrapper-captured OS start-time (trailing
 *  whitespace + newline mimic real `ps -o lstart=` output, so the read side's trim
 *  is exercised). The recycle guard compares this against `deps.readStartTime`. */
function seedStartfile(name: string, startTime: string): void {
  writeFileSync(join(dir, `${name}.starttime`), `${startTime}    \n`);
}

function readManifest(): PanelManifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

// ---- member resolution ----------------------------------------------------

const EMPTY_SELECTIONS: PanelSelections = { panels: {}, default: null };

test("resolvePanelMembers: panel hit → preset-named members", () => {
  const catalog: PresetCatalog = {
    presets: { rA: preset("claude"), rB: preset("codex") },
  };
  const sel: PanelSelections = {
    panels: { default: ["rA", "rB"] },
    default: "default",
  };
  const r = resolvePanelMembers(catalog, sel, "default");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members).toEqual([
    { name: "rA", harness: "claude", preset: "rA" },
    { name: "rB", harness: "codex", preset: "rB" },
  ]);
});

test("resolvePanelMembers: a single preset → a one-member panel", () => {
  const catalog: PresetCatalog = { presets: { solo: preset("claude") } };
  const r = resolvePanelMembers(catalog, EMPTY_SELECTIONS, "solo");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members).toEqual([
    { name: "solo", harness: "claude", preset: "solo" },
  ]);
});

test("resolvePanelMembers: an unknown name is fail-loud (no fallback)", () => {
  const r = resolvePanelMembers({ presets: {} }, EMPTY_SELECTIONS, "nonesuch");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("nonesuch");
});

test("resolvePanelMembers: 'default' dereferences the configured default panel", () => {
  // The default pointer names a panel called `reviewers`, not one literally
  // named `default` — proving `default` is a symbolic pointer, not a frozen name.
  const catalog: PresetCatalog = {
    presets: { rA: preset("claude"), rB: preset("codex") },
  };
  const sel: PanelSelections = {
    panels: { reviewers: ["rA", "rB"] },
    default: "reviewers",
  };
  const r = resolvePanelMembers(catalog, sel, "default");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members).toEqual([
    { name: "rA", harness: "claude", preset: "rA" },
    { name: "rB", harness: "codex", preset: "rB" },
  ]);
});

test("resolvePanelMembers: 'default' with no configured default is fail-loud naming 'default'", () => {
  const catalog: PresetCatalog = { presets: { rA: preset("claude") } };
  const sel: PanelSelections = { panels: { reviewers: ["rA"] }, default: null };
  const r = resolvePanelMembers(catalog, sel, "default");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("--panel default");
  expect(r.error).toContain("panel.yaml");
});

test("resolvePanelMembers: a pi single-preset is accepted (pair-launchable)", () => {
  // pi is capturable, so it is panel-eligible both in panel.yaml (the load gate)
  // and here as a single pi catalog preset used directly as --panel
  // (resolvePanelMembers gates on AGENT_CLIS, derived from the harness registry).
  const catalog: PresetCatalog = { presets: { thinker: preset("pi") } };
  const r = resolvePanelMembers(catalog, EMPTY_SELECTIONS, "thinker");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members).toEqual([
    { name: "thinker", harness: "pi", preset: "thinker" },
  ]);
});

// ---- argv shape ------------------------------------------------------------

test("buildPanelLegArgv: agent run leg with --preset; presetless leg drops it; no banned tokens", () => {
  const presetArgv = buildPanelLegArgv({
    keeperBin: KEEPER_BIN,
    keeperAgentPath: KEEPER_AGENT,
    prompt: "what is the best answer?",
    member: { name: "rA", harness: "claude", preset: "rA" },
    slug: "my-run",
    yamlPath: "/d/rA.yaml",
    stopTimeoutMs: 1_800_000,
  });
  expect(presetArgv).toEqual([
    KEEPER_BIN,
    KEEPER_AGENT,
    "agent",
    "run",
    "claude",
    "what is the best answer?",
    "--preset",
    "rA",
    "--read-only",
    "--session",
    "panels",
    "--output",
    "/d/rA.yaml",
    "--stop-timeout",
    "1800000ms",
    "--name",
    "panel::my-run::rA",
  ]);

  // A presetless member keeps its harness as the `<cli>` positional and drops the
  // `--preset` flag entirely.
  const presetlessArgv = buildPanelLegArgv({
    keeperBin: KEEPER_BIN,
    keeperAgentPath: KEEPER_AGENT,
    prompt: "q",
    member: { name: "codex", harness: "codex" },
    slug: "my-run",
    yamlPath: "/d/codex.yaml",
    stopTimeoutMs: 1_800_000,
  });
  expect(presetlessArgv.slice(0, 5)).toEqual([
    KEEPER_BIN,
    KEEPER_AGENT,
    "agent",
    "run",
    "codex",
  ]);
  expect(presetlessArgv).not.toContain("--preset");
  expect(presetlessArgv).not.toContain("--cli");

  const wrapper = buildDetachWrapperArgv(presetArgv);
  expect(wrapper.slice(0, 4)).toEqual(["sh", "-c", DETACH_SCRIPT, "--"]);
  // No coreutils detach/bound commands anywhere — not as the spawn binary, and
  // not inside the detach script (keeper's own `--stop-timeout` FLAG is fine —
  // it is a distinct token, never the bare `timeout` binary).
  expect(wrapper[0]).toBe("sh");
  for (const banned of ["setsid", "timeout", "gtimeout"]) {
    expect(DETACH_SCRIPT).not.toContain(banned);
    expect(wrapper).not.toContain(banned);
  }
  // The wrapper uses nohup + the env-carried sentinels (not &>>; /bin/sh is bash 3.2).
  expect(DETACH_SCRIPT).toContain("nohup");
  expect(DETACH_SCRIPT).toContain('>"$LOG" 2>&1');
  expect(DETACH_SCRIPT).toContain('echo $! > "$PIDFILE"');
  // It captures the leg's OS start-time atomically (temp-then-mv) as the recycle
  // guard's identity anchor, probing the SAME `$!` after the pidfile write.
  expect(DETACH_SCRIPT).toContain("ps -o lstart= -p $!");
  expect(DETACH_SCRIPT).toContain('mv -f "$STARTFILE.tmp" "$STARTFILE"');
  // Ambient locale/TZ so it byte-matches the same-machine live probe — forcing UTC
  // would shift the hour and false-flag every leg as recycled.
  expect(DETACH_SCRIPT).not.toContain("TZ=UTC");
  expect(DETACH_SCRIPT).not.toContain("LC_ALL=C");
});

// ---- start -----------------------------------------------------------------

test("start: persists + prints a manifest, launches every leg detached", async () => {
  const catalog: PresetCatalog = {
    presets: { rA: preset("claude"), rB: preset("codex") },
  };
  const selections: PanelSelections = {
    panels: { default: ["rA", "rB"] },
    default: "default",
  };
  const { deps, spawns, stdout } = makeDeps({ catalog, selections });
  const code = await panelStart(
    {
      promptFile: writePrompt(),
      slug: "my-run",
      panel: "default",
      dir,
      timeoutSeconds: 900,
    },
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
    // The wrapped leg is `agent run`, and the panel's --timeout (s) is translated
    // to a --stop-timeout ms duration (900s → 900000ms).
    const leg = s.argv.slice(4);
    expect(leg.slice(0, 4)).toEqual([KEEPER_BIN, KEEPER_AGENT, "agent", "run"]);
    const tIdx = leg.indexOf("--stop-timeout");
    expect(leg[tIdx + 1]).toBe("900000ms");
    // Each leg is named panel::<slug>::<member> so the run + preset are visible.
    const nameIdx = leg.indexOf("--name");
    expect(leg[nameIdx + 1]).toMatch(/^panel::my-run::(rA|rB)$/);
  }

  // Manifest persisted AND printed identically.
  const persisted = readManifest();
  const printed: PanelManifest = JSON.parse(stdout().trim());
  expect(printed).toEqual(persisted);
  expect(persisted.dir).toBe(dir);
  expect(persisted.slug).toBe("my-run");
  expect(persisted.members.map((m) => m.name)).toEqual(["rA", "rB"]);
  expect(persisted.members[0]?.yaml).toBe(join(dir, "rA.yaml"));
  expect(persisted.members[0]?.pidfile).toBe(join(dir, "rA.pidfile"));
  // Prompt copied into the scratch dir.
  expect(readFileSync(join(dir, "prompt.md"), "utf8")).toBe(
    "what is the best answer?",
  );
});

test("start: an absent --panel uses the panel.yaml default, launching each via --preset", async () => {
  const { deps, spawns } = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: DEFAULT_SELECTIONS,
  });
  const code = await panelStart(
    {
      promptFile: writePrompt(),
      slug: "run-x",
      panel: undefined,
      dir,
      timeoutSeconds: 1800,
    },
    deps,
  );
  expect(code).toBe(0);
  expect(spawns.length).toBe(2);
  const opusLeg = spawns[0]?.argv ?? [];
  const codexLeg = spawns[1]?.argv ?? [];
  expect(opusLeg).toContain("--preset");
  expect(opusLeg).toContain("opus");
  expect(opusLeg).not.toContain("--cli");
  expect(codexLeg).toContain("--preset");
  expect(codexLeg).toContain("codex");
});

test("start: no --panel and no default panel is fail-loud (exit 2)", async () => {
  const { deps, stderr } = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: { panels: { default: ["opus", "codex"] }, default: null },
  });
  const code = await panelStart(
    {
      promptFile: writePrompt(),
      slug: "run-x",
      panel: undefined,
      dir,
      timeoutSeconds: 1800,
    },
    deps,
  );
  expect(code).toBe(2);
  expect(stderr()).toContain("no default panel");
});

test("start: an explicit --panel default resolves the configured default panel", async () => {
  // The default pointer names `reviewers`, so `--panel default` must dereference
  // it (git-HEAD style) rather than look for a panel literally named `default`.
  const { deps, spawns } = makeDeps({
    catalog: { presets: { opus: preset("claude"), codex: preset("codex") } },
    selections: {
      panels: { reviewers: ["opus", "codex"] },
      default: "reviewers",
    },
  });
  const code = await panelStart(
    {
      promptFile: writePrompt(),
      slug: "run-x",
      panel: "default",
      dir,
      timeoutSeconds: 1800,
    },
    deps,
  );
  expect(code).toBe(0);
  expect(spawns.length).toBe(2);
  expect(spawns[0]?.argv).toContain("opus");
  expect(spawns[1]?.argv).toContain("codex");
});

test("start: --panel default with no configured default is fail-loud naming what was typed", async () => {
  const { deps, stderr } = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: { panels: { reviewers: ["opus", "codex"] }, default: null },
  });
  const code = await panelStart(
    {
      promptFile: writePrompt(),
      slug: "run-x",
      panel: "default",
      dir,
      timeoutSeconds: 1800,
    },
    deps,
  );
  expect(code).toBe(2);
  // Distinct from the no-flag guard: this message names `--panel default`.
  expect(stderr()).toContain("--panel default given");
});

test("start: a per-leg spawn failure records a null pidfile (no crash)", async () => {
  // opus spawns fine; codex's spawn throws.
  const { deps } = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: DEFAULT_SELECTIONS,
    throwOnSpawn: (argv) => argv.join(" ").includes("--preset codex"),
  });
  const code = await panelStart(
    {
      promptFile: writePrompt(),
      slug: "run-x",
      panel: "default",
      dir,
      timeoutSeconds: 1800,
    },
    deps,
  );
  expect(code).toBe(0);
  const m = readManifest();
  expect(m.members[0]?.pidfile).toBe(join(dir, "opus.pidfile"));
  expect(m.members[1]?.name).toBe("codex");
  expect(m.members[1]?.pidfile).toBeNull();
});

test("start: a ConfigError from the config load exits 2", async () => {
  const { deps, stderr } = makeDeps({});
  deps.loadRegistry = () => {
    throw new ConfigError("bad presets.yaml");
  };
  const code = await panelStart(
    {
      promptFile: writePrompt(),
      slug: "run-x",
      panel: "default",
      dir,
      timeoutSeconds: 1800,
    },
    deps,
  );
  expect(code).toBe(2);
  expect(stderr()).toContain("bad presets.yaml");
});

// ---- reconcile (idempotent-by-slug re-issue) -------------------------------

const RECONCILE_BOOT = 1_700_000_000_000;

test("reconcile: reuses terminal legs (completed AND failed), leaves a live leg, relaunches a dead no-result leg to g2", async () => {
  const catalog: PresetCatalog = {
    presets: {
      done: preset("claude"),
      failed: preset("codex"),
      dead: preset("claude"),
      live: preset("codex"),
    },
  };
  const selections: PanelSelections = {
    panels: { quad: ["done", "failed", "dead", "live"] },
    default: "quad",
  };
  const prompt = writePrompt("reconcile me");

  // First fan-out (fresh): all four legs launch at generation 1.
  const first = makeDeps({
    catalog,
    selections,
    bootEpochMs: () => RECONCILE_BOOT,
  });
  expect(
    await panelStart(
      {
        promptFile: prompt,
        slug: "quad",
        panel: "quad",
        dir,
        timeoutSeconds: 900,
      },
      first.deps,
    ),
  ).toBe(0);
  expect(first.spawns.length).toBe(4);

  // Simulate leg outcomes: done→completed, failed→a failed result (both terminal);
  // dead→dead pid + no result; live→live pid + no result.
  seedResult("done", "completed");
  seedResult("failed", "timed_out");
  seedPidfile("dead", 5555);
  seedPidfile("live", 4242);

  // Re-issue the SAME start: same boot, graceMs 0 (the dead pid is not grace-held),
  // and pidAlive true only for the live pid.
  const second = makeDeps({
    catalog,
    selections,
    bootEpochMs: () => RECONCILE_BOOT,
    graceMs: 0,
    pidAlive: (pid) => pid === 4242,
  });
  expect(
    await panelStart(
      {
        promptFile: prompt,
        slug: "quad",
        panel: "quad",
        dir,
        timeoutSeconds: 900,
      },
      second.deps,
    ),
  ).toBe(0);

  // Only the dead no-result leg relaunched, to a new-generation result path.
  expect(second.spawns.length).toBe(1);
  const leg = second.spawns[0]?.argv.slice(4) ?? [];
  expect(leg[leg.indexOf("--name") + 1]).toBe("panel::quad::dead");
  expect(leg[leg.indexOf("--output") + 1]).toBe(join(dir, "dead.g2.yaml"));

  const m = readManifest();
  expect(m.generation).toBe(2);
  const byName = Object.fromEntries(m.members.map((x) => [x.name, x]));
  // Terminal legs kept their generation-1 paths (reused, never relaunched).
  expect(byName.done?.yaml).toBe(join(dir, "done.yaml"));
  expect(byName.failed?.yaml).toBe(join(dir, "failed.yaml"));
  // The live leg is left untouched (still its gen-1 path).
  expect(byName.live?.yaml).toBe(join(dir, "live.yaml"));
  // The dead leg repointed to gen 2 (both result + pidfile).
  expect(byName.dead?.yaml).toBe(join(dir, "dead.g2.yaml"));
  expect(byName.dead?.pidfile).toBe(join(dir, "dead.g2.pidfile"));
});

test("reconcile: a boot mismatch relaunches every non-terminal leg (even a live pid); a completed leg is still reused", async () => {
  const catalog: PresetCatalog = {
    presets: { done: preset("claude"), running: preset("codex") },
  };
  const selections: PanelSelections = {
    panels: { duo: ["done", "running"] },
    default: "duo",
  };
  const prompt = writePrompt("reboot me");

  const first = makeDeps({
    catalog,
    selections,
    bootEpochMs: () => RECONCILE_BOOT,
  });
  await panelStart(
    { promptFile: prompt, slug: "duo", panel: "duo", dir, timeoutSeconds: 900 },
    first.deps,
  );
  seedResult("done", "completed");
  seedPidfile("running", 4242); // a pid that was alive pre-reboot

  // Re-issue after a reboot: the derived boot-epoch jumps an hour beyond tolerance.
  // Even though the pid still reads "alive", a pre-reboot pid can't be trusted.
  const second = makeDeps({
    catalog,
    selections,
    bootEpochMs: () => RECONCILE_BOOT + 60 * 60_000,
    pidAlive: () => true,
  });
  expect(
    await panelStart(
      {
        promptFile: prompt,
        slug: "duo",
        panel: "duo",
        dir,
        timeoutSeconds: 900,
      },
      second.deps,
    ),
  ).toBe(0);

  // Only the non-terminal leg relaunched; the completed leg was reused.
  expect(second.spawns.length).toBe(1);
  const leg = second.spawns[0]?.argv.slice(4) ?? [];
  expect(leg[leg.indexOf("--name") + 1]).toBe("panel::duo::running");
  const m = readManifest();
  expect(m.generation).toBe(2);
  // The boot-epoch is re-stamped to the current boot.
  expect(m.boot_epoch_ms).toBe(RECONCILE_BOOT + 60 * 60_000);
  const byName = Object.fromEntries(m.members.map((x) => [x.name, x]));
  expect(byName.done?.yaml).toBe(join(dir, "done.yaml")); // reused gen 1
  expect(byName.running?.yaml).toBe(join(dir, "running.g2.yaml")); // relaunched
});

test("reconcile: a same-boot leg launched within grace is left (not relaunched) despite a dead pid", async () => {
  const catalog: PresetCatalog = {
    presets: { fresh: preset("claude") },
  };
  const selections: PanelSelections = {
    panels: { solo: ["fresh"] },
    default: "solo",
  };
  const prompt = writePrompt("grace me");
  const clock = { ms: 1000 };

  const first = makeDeps({
    catalog,
    selections,
    clock,
    bootEpochMs: () => RECONCILE_BOOT,
  });
  await panelStart(
    {
      promptFile: prompt,
      slug: "solo",
      panel: "solo",
      dir,
      timeoutSeconds: 900,
    },
    first.deps,
  );
  seedPidfile("fresh", 7777); // pid recorded, but the process reads dead

  // Re-issue at the same clock (launched_at === now) with a generous grace and a
  // dead pid: the leg is too fresh to trust the dead reading → LEFT, not relaunched.
  const second = makeDeps({
    catalog,
    selections,
    clock,
    bootEpochMs: () => RECONCILE_BOOT,
    graceMs: 5000,
    pidAlive: () => false,
  });
  expect(
    await panelStart(
      {
        promptFile: prompt,
        slug: "solo",
        panel: "solo",
        dir,
        timeoutSeconds: 900,
      },
      second.deps,
    ),
  ).toBe(0);
  expect(second.spawns.length).toBe(0);
  expect(readManifest().generation).toBe(1);
});

test("reconcile: an all-terminal re-issue is a no-op (no relaunch, generation unchanged)", async () => {
  const first = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: DEFAULT_SELECTIONS,
    bootEpochMs: () => RECONCILE_BOOT,
  });
  const prompt = writePrompt();
  await panelStart(
    {
      promptFile: prompt,
      slug: "run-x",
      panel: "default",
      dir,
      timeoutSeconds: 900,
    },
    first.deps,
  );
  seedResult("opus", "completed");
  seedResult("codex", "failed"); // a terminal fail still counts — resume is not retry

  const second = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: DEFAULT_SELECTIONS,
    bootEpochMs: () => RECONCILE_BOOT,
  });
  expect(
    await panelStart(
      {
        promptFile: prompt,
        slug: "run-x",
        panel: "default",
        dir,
        timeoutSeconds: 900,
      },
      second.deps,
    ),
  ).toBe(0);
  expect(second.spawns.length).toBe(0);
  expect(readManifest().generation).toBe(1);
});

test("reconcile: lock contention fails fast (exit 2), no legs spawned", async () => {
  const { deps, spawns, stderr } = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: DEFAULT_SELECTIONS,
    lock: () => null, // another driver already holds the slug
  });
  const code = await panelStart(
    {
      promptFile: writePrompt(),
      slug: "run-x",
      panel: "default",
      dir,
      timeoutSeconds: 900,
    },
    deps,
  );
  expect(code).toBe(2);
  expect(spawns.length).toBe(0);
  expect(stderr()).toContain("locked by another driver");
});

test("reconcile: the lock is released after a successful start (a fresh handle can re-acquire)", async () => {
  let releases = 0;
  const handle = {
    release: () => {
      releases += 1;
    },
  };
  const { deps } = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: DEFAULT_SELECTIONS,
    lock: () => handle,
  });
  expect(
    await panelStart(
      {
        promptFile: writePrompt(),
        slug: "run-x",
        panel: "default",
        dir,
        timeoutSeconds: 900,
      },
      deps,
    ),
  ).toBe(0);
  expect(releases).toBe(1);
});

test("reconcile: a prompt mismatch refuses the resume (exit 2), no relaunch", async () => {
  const first = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: DEFAULT_SELECTIONS,
  });
  await panelStart(
    {
      promptFile: writePrompt("original prompt"),
      slug: "run-x",
      panel: "default",
      dir,
      timeoutSeconds: 900,
    },
    first.deps,
  );
  // Re-issue the same slug with a DIFFERENT prompt-file content.
  const other = join(dir, "other-prompt.txt");
  writeFileSync(other, "a completely different prompt");
  const second = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: DEFAULT_SELECTIONS,
  });
  const code = await panelStart(
    {
      promptFile: other,
      slug: "run-x",
      panel: "default",
      dir,
      timeoutSeconds: 900,
    },
    second.deps,
  );
  expect(code).toBe(2);
  expect(second.spawns.length).toBe(0);
  expect(second.stderr()).toContain("different prompt");
});

test("reconcile: a member-set mismatch refuses the resume (exit 2)", async () => {
  const catalogA: PresetCatalog = {
    presets: { a1: preset("claude"), a2: preset("codex") },
  };
  const selA: PanelSelections = { panels: { p: ["a1", "a2"] }, default: "p" };
  const prompt = writePrompt("same prompt");
  const first = makeDeps({ catalog: catalogA, selections: selA });
  await panelStart(
    { promptFile: prompt, slug: "run-x", panel: "p", dir, timeoutSeconds: 900 },
    first.deps,
  );

  // Re-issue with the SAME prompt but a DIFFERENT member set (a2 → b2).
  const catalogB: PresetCatalog = {
    presets: { a1: preset("claude"), b2: preset("codex") },
  };
  const selB: PanelSelections = { panels: { p: ["a1", "b2"] }, default: "p" };
  const second = makeDeps({ catalog: catalogB, selections: selB });
  const code = await panelStart(
    { promptFile: prompt, slug: "run-x", panel: "p", dir, timeoutSeconds: 900 },
    second.deps,
  );
  expect(code).toBe(2);
  expect(second.spawns.length).toBe(0);
  expect(second.stderr()).toContain("different member set");
});

// ---- wait ------------------------------------------------------------------

/** Drive start (recording spawn) against the default opus+codex panel, then
 *  return so the caller can simulate leg outcomes for wait. */
async function startLegacy(): Promise<void> {
  const { deps } = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: DEFAULT_SELECTIONS,
  });
  await panelStart(
    {
      promptFile: writePrompt(),
      slug: "run-x",
      panel: "default",
      dir,
      timeoutSeconds: 1800,
    },
    deps,
  );
}

test("wait: full-success N-of-N → exit 0, ok:true (manifest round-trip)", async () => {
  await startLegacy();
  seedResult("opus", "completed");
  seedResult("codex", "completed");

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

test("wait: mixed verdict (one failed outcome) → exit 0, ok:false, reason=outcome", async () => {
  await startLegacy();
  seedResult("opus", "completed");
  seedResult("codex", "timed_out");

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
  // The failing leg's reason is the envelope's `outcome`, verbatim.
  expect(v.members[1]?.reason).toBe("timed_out");
});

test("wait: every non-completed outcome maps to fail with reason=outcome", async () => {
  for (const outcome of [
    "no_message",
    "no_transcript",
    "launch_failed",
    "bad_args",
  ]) {
    await startLegacy();
    seedResult("opus", "completed");
    seedResult("codex", outcome);
    const { deps, stdout } = makeDeps({});
    const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
    expect(code).toBe(0);
    const v: PanelVerdict = JSON.parse(stdout().trim());
    expect(v.ok).toBe(false);
    expect(v.members[1]).toMatchObject({
      name: "codex",
      status: "fail",
      yaml: null,
      reason: outcome,
    });
  }
});

test("wait: a present-but-unparseable result file → fail (reason=corrupt-result)", async () => {
  await startLegacy();
  seedResult("opus", "completed");
  // A half-written / non-JSON present file — never throws out of wait.
  writeFileSync(join(dir, "codex.yaml"), "{not json");

  const { deps, stdout } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0);
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(false);
  expect(v.members[1]).toMatchObject({
    name: "codex",
    status: "fail",
    reason: "corrupt-result",
  });
});

test("wait: content-blind — a panelist answer in the result file never reaches the verdict", async () => {
  await startLegacy();
  // seedResult stamps the SECRET marker into each completed envelope's `message`.
  seedResult("opus", "completed");
  seedResult("codex", "completed");

  const { deps, stdout } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0);
  expect(stdout()).not.toContain("SECRET_ANSWER_DO_NOT_LEAK");
});

test("wait: a non-terminal leg with a live pid → exit 124 when the chunk elapses", async () => {
  await startLegacy();
  // opus is done; codex is still running (pid alive, no result file).
  seedResult("opus", "completed");
  writeFileSync(join(dir, "codex.pidfile"), "4242\n");

  const { deps } = makeDeps({ pidAlive: (pid) => pid === 4242 });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(124);
});

test("wait: a dead pid past the startup grace → crash fail (exit 0, ok:false)", async () => {
  await startLegacy();
  seedResult("opus", "completed");
  // codex never wrote a result file; its pid is gone (crash-without-file).
  writeFileSync(join(dir, "codex.pidfile"), "4242\n");

  const { deps, stdout } = makeDeps({ pidAlive: () => false, graceMs: 0 });
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0);
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(false);
  expect(v.members[1]?.status).toBe("fail");
  expect(v.members[1]?.reason).toContain(
    "exited before producing a result file",
  );
});

test("wait: a null-pidfile (launch-failed) leg is a terminal fail", async () => {
  // Hand-write a manifest with a null pidfile (start's spawn-failure record).
  const manifest: PanelManifest = {
    dir,
    slug: "run-x",
    members: [
      {
        name: "codex",
        harness: "codex",
        yaml: join(dir, "codex.yaml"),
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
  const r = parseManifest({
    dir: "/d",
    slug: "run-x",
    members: [{ name: "x" }],
  });
  expect(r.ok).toBe(false);
});

test("parseManifest: rejects a manifest missing a top-level slug", () => {
  const r = parseManifest({
    dir: "/d",
    members: [
      { name: "x", harness: "codex", yaml: "/d/x.yaml", pidfile: null },
    ],
  });
  expect(r.ok).toBe(false);
});

// ---- start-time capture (recycle-guard anchor) -----------------------------

test("start: each leg carries a startfile path and the detach wrapper receives $STARTFILE", async () => {
  const { deps, spawns } = makeDeps({
    catalog: DEFAULT_CATALOG,
    selections: DEFAULT_SELECTIONS,
  });
  await panelStart(
    {
      promptFile: writePrompt(),
      slug: "run-x",
      panel: "default",
      dir,
      timeoutSeconds: 900,
    },
    deps,
  );
  const m = readManifest();
  for (const mem of m.members) {
    expect(mem.startfile).toBe(join(dir, `${mem.name}.starttime`));
  }
  // The wrapper needs $STARTFILE (beside $PIDFILE) to write the capture.
  for (const s of spawns) {
    expect(s.env.PIDFILE).toBeDefined();
    expect(s.env.STARTFILE).toContain(".starttime");
  }
});

// ---- Guard A: pid-recycle identity cross-check -----------------------------

test("wait recycle guard: a live pid whose start-time drifted reads DEAD (not running)", async () => {
  await startLegacy();
  seedResult("opus", "completed");
  seedPidfile("codex", 4242); // the pid is occupied...
  seedStartfile("codex", "STORED"); // ...but by a different process now
  const { deps, stdout } = makeDeps({
    pidAlive: (pid) => pid === 4242, // kill(pid,0) says alive
    readStartTime: (pid) => (pid === 4242 ? "RECYCLED" : null), // ≠ stored
    graceMs: 0,
  });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(0); // terminal, NOT 124 — the recycled pid is treated as dead
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(false);
  const codex = v.members.find((m) => m.name === "codex");
  expect(codex?.status).toBe("fail");
  expect(codex?.reason).toContain("exited before producing a result file");
});

test("wait recycle guard: a MATCHING start-time keeps the leg live (times out 124)", async () => {
  await startLegacy();
  seedResult("opus", "completed");
  seedPidfile("codex", 4242);
  seedStartfile("codex", "STORED");
  const { deps } = makeDeps({
    pidAlive: (pid) => pid === 4242,
    readStartTime: (pid) => (pid === 4242 ? "STORED" : null), // == stored → same proc
    graceMs: 0,
  });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(124); // still running → chunk elapses
});

test("wait recycle guard: a null live probe fails OPEN (leg stays live)", async () => {
  await startLegacy();
  seedResult("opus", "completed");
  seedPidfile("codex", 4242);
  seedStartfile("codex", "STORED");
  const { deps } = makeDeps({
    pidAlive: (pid) => pid === 4242,
    readStartTime: () => null, // can't tell → trust bare pid liveness
    graceMs: 0,
  });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(124); // fail-open → still running
});

test("wait recycle guard: a missing stored start-time degrades to bare pid liveness (no probe)", async () => {
  await startLegacy();
  seedResult("opus", "completed");
  seedPidfile("codex", 4242);
  // NO seedStartfile — the wrapper's capture failed / a pre-durable leg.
  const probeCalls: number[] = [];
  const { deps } = makeDeps({
    pidAlive: (pid) => pid === 4242,
    readStartTime: (pid) => {
      probeCalls.push(pid);
      return "IRRELEVANT-MISMATCH";
    },
    graceMs: 0,
  });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(124); // bare pidAlive → running
  expect(probeCalls).toEqual([]); // an absent stored value short-circuits the probe
});

test("wait recycle guard: the start-time probe runs at most ONCE per leg across poll ticks (memoized)", async () => {
  await startLegacy();
  seedResult("opus", "completed");
  seedPidfile("codex", 4242);
  seedStartfile("codex", "STORED");
  let probeCount = 0;
  const { deps } = makeDeps({
    pidAlive: (pid) => pid === 4242,
    readStartTime: (pid) => {
      if (pid === 4242) probeCount++;
      return "STORED"; // matches → live across every tick
    },
    graceMs: 0,
    pollIntervalMs: 100, // ~10 ticks inside a 1s chunk
  });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(124); // stayed running the whole chunk
  expect(probeCount).toBe(1); // …but forked the probe just once
});

test("reconcile recycle guard: a live pid with a mismatched start-time RELAUNCHES (not left)", async () => {
  const catalog: PresetCatalog = { presets: { solo: preset("claude") } };
  const selections: PanelSelections = {
    panels: { one: ["solo"] },
    default: "one",
  };
  const prompt = writePrompt("recycle me");
  const first = makeDeps({ catalog, selections });
  await panelStart(
    { promptFile: prompt, slug: "one", panel: "one", dir, timeoutSeconds: 900 },
    first.deps,
  );
  seedPidfile("solo", 4242);
  seedStartfile("solo", "STORED");
  const second = makeDeps({
    catalog,
    selections,
    graceMs: 0,
    pidAlive: (pid) => pid === 4242,
    readStartTime: (pid) => (pid === 4242 ? "RECYCLED" : null), // ≠ stored → recycled
  });
  expect(
    await panelStart(
      {
        promptFile: prompt,
        slug: "one",
        panel: "one",
        dir,
        timeoutSeconds: 900,
      },
      second.deps,
    ),
  ).toBe(0);
  // A recycled pid is not a live leg → the leg relaunches to generation 2.
  expect(second.spawns.length).toBe(1);
  expect(readManifest().generation).toBe(2);
});

test("reconcile recycle guard: a MATCHING start-time leaves the live leg untouched", async () => {
  const catalog: PresetCatalog = { presets: { solo: preset("claude") } };
  const selections: PanelSelections = {
    panels: { one: ["solo"] },
    default: "one",
  };
  const prompt = writePrompt("keep me");
  const first = makeDeps({ catalog, selections });
  await panelStart(
    { promptFile: prompt, slug: "one", panel: "one", dir, timeoutSeconds: 900 },
    first.deps,
  );
  seedPidfile("solo", 4242);
  seedStartfile("solo", "STORED");
  const second = makeDeps({
    catalog,
    selections,
    graceMs: 0,
    pidAlive: (pid) => pid === 4242,
    readStartTime: (pid) => (pid === 4242 ? "STORED" : null), // == stored → same proc
  });
  expect(
    await panelStart(
      {
        promptFile: prompt,
        slug: "one",
        panel: "one",
        dir,
        timeoutSeconds: 900,
      },
      second.deps,
    ),
  ).toBe(0);
  expect(second.spawns.length).toBe(0); // left running
  expect(readManifest().generation).toBe(1);
});

// ---- Guard B: reboot-in-wait ------------------------------------------------

test("wait reboot guard: a boot-epoch mismatch fails non-terminal legs 'machine-rebooted' and returns promptly", async () => {
  await startLegacy(); // stamps manifest boot_epoch_ms = TEST_BOOT_EPOCH_MS
  seedResult("opus", "completed"); // a leg that finished pre-reboot
  seedPidfile("codex", 4242); // a non-terminal leg
  const clock = { ms: 0 };
  const { deps, stdout } = makeDeps({
    clock,
    pidAlive: (pid) => pid === 4242, // even "alive", a pre-reboot pid is dead
    bootEpochMs: () => TEST_BOOT_EPOCH_MS + 60 * 60_000, // an hour on → reboot
  });
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0); // exit-code contract preserved (0, ok:false)
  expect(clock.ms).toBe(0); // prompt — never slept a poll tick (no spin to 124)
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(false);
  const codex = v.members.find((m) => m.name === "codex");
  expect(codex?.status).toBe("fail");
  expect(codex?.reason).toBe("machine-rebooted");
  // A leg that finished before the reboot keeps its real verdict (reused).
  expect(v.members.find((m) => m.name === "opus")?.status).toBe("ok");
});

test("wait reboot guard: an absent boot-epoch (pre-durable manifest) does NOT fire the guard", async () => {
  // Hand-write a pre-durable manifest (no boot_epoch_ms) + a live non-terminal leg.
  const manifest: PanelManifest = {
    dir,
    slug: "run-x",
    members: [
      {
        name: "codex",
        harness: "codex",
        yaml: join(dir, "codex.yaml"),
        pidfile: join(dir, "codex.pidfile"),
      },
    ],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  seedPidfile("codex", 4242);
  const { deps } = makeDeps({
    pidAlive: (pid) => pid === 4242,
    bootEpochMs: () => TEST_BOOT_EPOCH_MS + 999 * 60_000, // no stored epoch to compare
  });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(124); // guard never fires → leg stays running → times out
});

test("wait reboot+recycle: a reboot supersedes the recycle check (Guard B wins, distinct reason)", async () => {
  await startLegacy();
  seedResult("opus", "completed");
  seedPidfile("codex", 4242);
  seedStartfile("codex", "STORED");
  const clock = { ms: 0 };
  const { deps, stdout } = makeDeps({
    clock,
    pidAlive: (pid) => pid === 4242,
    readStartTime: (pid) => (pid === 4242 ? "STORED" : null), // Guard A alone → LIVE
    bootEpochMs: () => TEST_BOOT_EPOCH_MS + 60 * 60_000, // …but a reboot supersedes
    graceMs: 0,
  });
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0);
  expect(clock.ms).toBe(0); // prompt
  const v: PanelVerdict = JSON.parse(stdout().trim());
  const codex = v.members.find((m) => m.name === "codex");
  expect(codex?.reason).toBe("machine-rebooted"); // not "exited before…"
});

test("wait is strictly read-only: a reboot verdict writes nothing to the manifest", async () => {
  await startLegacy();
  seedResult("opus", "completed");
  seedPidfile("codex", 4242);
  const before = readFileSync(join(dir, "manifest.json"), "utf8");
  const { deps } = makeDeps({
    pidAlive: (pid) => pid === 4242,
    bootEpochMs: () => TEST_BOOT_EPOCH_MS + 60 * 60_000,
  });
  await panelWait({ dir, chunkSeconds: 540 }, deps);
  const after = readFileSync(join(dir, "manifest.json"), "utf8");
  expect(after).toBe(before); // no relaunch, no re-stamp — wait never writes
});
