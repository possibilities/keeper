/**
 * `keeper agent panel start|wait` — the fast-tier regression lock for the
 * cross-OS panel orchestrator (src/pair/panel.ts). Everything OS-specific is
 * injected: a fake `spawn` (records the wrapper argv, never launches), a fake
 * clock + `sleep` (deterministic deadline), and a fake `pidAlive`. The leg
 * outcomes are simulated by seeding each leg's `--output` result file (a `keeper
 * agent run` JSON envelope carrying an `outcome`) plus its `.pidfile` into a real
 * scratch dir, so terminality + the verdict are exercised against real fs without
 * a single real process. Detached-process behavior is a manual diagnostic; this suite covers the injected launch contract.
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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  type PanelDefinition,
  type PanelSelections,
} from "../src/agent/config";
import type { MaintenanceMessage } from "../src/maintenance-worker";
import { runPanelPrunePass } from "../src/maintenance-worker";
import {
  buildDetachWrapperArgv,
  buildPanelLegArgv,
  DETACH_SCRIPT,
  type PanelDeps,
  type PanelManifest,
  type PanelManifestMember,
  type PanelVerdict,
  panelCancel,
  panelResume,
  panelStart,
  panelWait,
  parseManifest,
  resolvePanelMembers,
} from "../src/pair/panel";

let dir: string;
let savedStateDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pair-panel-test-"));
  // Every panelStart/panelWait call in this file passes an explicit `dir`
  // (--run-dir), so `keeperStateDir()` is otherwise unused here — sandboxed
  // for the runPanelPrunePass tests below, which rely on `panelPrune`'s
  // hardcoded `<state-dir>/panels/` root.
  savedStateDir = process.env.KEEPER_STATE_DIR;
  process.env.KEEPER_STATE_DIR = dir;
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.KEEPER_STATE_DIR;
  else process.env.KEEPER_STATE_DIR = savedStateDir;
  rmSync(dir, { recursive: true, force: true });
});

// ---- helpers --------------------------------------------------------------

/** Panel-eligible launch triples reused across the fixtures. Distinct models so
 *  their base slugs never collide (the disambiguated slug + ordinal is what the
 *  resolution tests assert). */
const T_CLAUDE = "claude::opus::high";
const T_CODEX = "pi::openai-codex/gpt-5.3::high";
const T_CLAUDE2 = "claude::sonnet::high";
const T_CODEX2 = "pi::openai-codex/gpt-5.1::high";
const T_PI = "pi::glm::high";

/** Build a fixture `PanelDefinition` from an ordered member list — strength +
 *  description are irrelevant to member-resolution/orchestration behavior
 *  here, so every fixture panel shares an arbitrary uniform band + blurb. */
function panelDef(members: string[]): PanelDefinition {
  return { strength: "standard", members, description: "fixture panel." };
}

/** A two-member `default` panel of a Claude + a Pi triple — the stand-in for the
 *  removed zero-config fallback in the start/wait tests. */
const DEFAULT_SELECTIONS: PanelSelections = {
  panels: { default: panelDef([T_CLAUDE, T_CODEX]) },
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
  selections?: PanelSelections;
  clock?: { ms: number };
  pidAlive?: (pid: number) => boolean;
  graceMs?: number;
  pollIntervalMs?: number;
  throwOnSpawn?: (argv: string[]) => boolean;
  bootEpochMs?: PanelDeps["bootEpochMs"];
  readStartTime?: PanelDeps["readStartTime"];
  lock?: PanelDeps["lock"];
  runTmuxCommand?: PanelDeps["runTmuxCommand"];
}): {
  deps: PanelDeps;
  spawns: SpawnCall[];
  tmuxCommands: string[][];
  stdout: () => string;
  stderr: () => string;
} {
  const spawns: SpawnCall[] = [];
  const tmuxCommands: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const clock = opts.clock ?? { ms: 0 };
  const deps: PanelDeps = {
    keeperBin: KEEPER_BIN,
    keeperAgentPath: KEEPER_AGENT,
    env: { PATH: "/usr/bin" },
    cwd: "/work/repo",
    loadRegistry: () => ({
      catalog: { presets: {} },
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
    runTmuxCommand:
      opts.runTmuxCommand ??
      ((command) => {
        tmuxCommands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
  };
  return {
    deps,
    spawns,
    tmuxCommands,
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

function seedControl(
  name: string,
  opts: {
    status?: "running" | "cancelling" | "terminal";
    owner?: { request_id: string; member: string; attempt: number };
  } = {},
): string[] {
  const manifest = readManifest();
  const member = manifest.members.find((candidate) => candidate.name === name);
  const attempt = member?.attempts?.at(-1);
  if (member === undefined || attempt?.control == null) {
    throw new Error(`missing control for ${name}`);
  }
  const owner = opts.owner ?? {
    request_id: attempt.control.request_id,
    member: attempt.control.member,
    attempt: attempt.control.attempt,
  };
  const command = [
    "/opt/tmux",
    "-S",
    `/tmp/${name}.sock`,
    "kill-window",
    "-t",
    `@${attempt.attempt}`,
  ];
  writeFileSync(
    attempt.control.path,
    `${JSON.stringify({
      schema_version: 1,
      run_id: `run-${name}-${attempt.attempt}`,
      agent: member.harness,
      started_at_ms: attempt.launched_at,
      kill_window_command: command,
      status: opts.status ?? "running",
      owner,
    })}\n`,
  );
  return command;
}

function readManifest(): PanelManifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

/** The resolved member slugs (leg names + result-file basenames), in declaration
 *  order, read from the persisted manifest. Leg names are disambiguated
 *  `slugifyTriple`s the resolver mints, so orchestration tests seed + assert by the
 *  slug the resolver actually produced rather than a hand-guessed hash. */
function memberSlugs(): string[] {
  return readManifest().members.map((m) => m.name);
}

// ---- member resolution ----------------------------------------------------

const EMPTY_SELECTIONS: PanelSelections = { panels: {}, default: null };

test("resolvePanelMembers: panel hit → triple members with slug names + ordinals", () => {
  const sel: PanelSelections = {
    panels: { default: panelDef([T_CLAUDE, T_CODEX]) },
    default: "default",
  };
  const r = resolvePanelMembers(sel, "default");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members).toHaveLength(2);
  const [a, b] = r.members;
  expect(a).toMatchObject({ harness: "claude", preset: T_CLAUDE, ordinal: 1 });
  expect(a?.name).toMatch(/^claude-opus-high-[0-9a-z]{6}-1$/);
  expect(b).toMatchObject({ harness: "pi", preset: T_CODEX, ordinal: 1 });
  expect(b?.name).toMatch(/^pi-openai-codex-gpt-5-3-high-[0-9a-z]{6}-1$/);
});

test("resolvePanelMembers: a single triple → a one-member panel", () => {
  const r = resolvePanelMembers(EMPTY_SELECTIONS, T_CLAUDE);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members).toHaveLength(1);
  expect(r.members[0]).toMatchObject({
    harness: "claude",
    preset: T_CLAUDE,
    ordinal: 1,
  });
  expect(r.members[0]?.name).toMatch(/^claude-opus-high-[0-9a-z]{6}-1$/);
});

test("resolvePanelMembers: duplicate identical triples → two ordinal-bearing legs, distinct names", () => {
  const sel: PanelSelections = {
    panels: { dup: panelDef([T_CLAUDE, T_CLAUDE]) },
    default: null,
  };
  const r = resolvePanelMembers(sel, "dup");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members).toHaveLength(2);
  // Same raw triple, 1-based ordinals in declaration order …
  expect(r.members[0]).toMatchObject({ preset: T_CLAUDE, ordinal: 1 });
  expect(r.members[1]).toMatchObject({ preset: T_CLAUDE, ordinal: 2 });
  // … and distinct leg names (the ordinal suffix separates the repeats).
  expect(r.members[0]?.name).not.toBe(r.members[1]?.name);
  expect(r.members[0]?.name).toMatch(/-1$/);
  expect(r.members[1]?.name).toMatch(/-2$/);
});

test("resolvePanelMembers: two distinct triples that slugify identically get distinct names (hash suffix)", () => {
  // `a.b` and `a-b` both slugify to `a-b`, so the base slug collides; the raw
  // triple differs, so the disambiguating hash suffix keeps the leg names apart.
  const t1 = "claude::a.b::high";
  const t2 = "claude::a-b::high";
  const sel: PanelSelections = {
    panels: { coll: panelDef([t1, t2]) },
    default: null,
  };
  const r = resolvePanelMembers(sel, "coll");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members[0]?.preset).toBe(t1);
  expect(r.members[1]?.preset).toBe(t2);
  // Both share the base slug + ordinal 1, so only the hash keeps them apart.
  expect(r.members[0]?.name).toMatch(/^claude-a-b-high-[0-9a-z]{6}-1$/);
  expect(r.members[1]?.name).toMatch(/^claude-a-b-high-[0-9a-z]{6}-1$/);
  expect(r.members[0]?.name).not.toBe(r.members[1]?.name);
});

test("resolvePanelMembers: an unknown name is fail-loud (no fallback)", () => {
  const r = resolvePanelMembers(EMPTY_SELECTIONS, "nonesuch");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("nonesuch");
  expect(r.error).toContain("not a known panel");
});

test("resolvePanelMembers: 'default' dereferences the configured default panel", () => {
  // The default pointer names a panel called `reviewers`, not one literally
  // named `default` — proving `default` is a symbolic pointer, not a frozen name.
  const sel: PanelSelections = {
    panels: { reviewers: panelDef([T_CLAUDE, T_CODEX]) },
    default: "reviewers",
  };
  const r = resolvePanelMembers(sel, "default");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members.map((m) => m.preset)).toEqual([T_CLAUDE, T_CODEX]);
});

test("resolvePanelMembers: 'default' with no configured default is fail-loud naming 'default'", () => {
  const sel: PanelSelections = {
    panels: { reviewers: panelDef([T_CLAUDE]) },
    default: null,
  };
  const r = resolvePanelMembers(sel, "default");
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error).toContain("--panel default");
  expect(r.error).toContain("panel.yaml");
});

test("resolvePanelMembers: a pi single triple is accepted (panel-eligible)", () => {
  // pi is capturable AND carries a thinking axis, so a pi triple is panel-eligible
  // both in panel.yaml (the load gate) and here as a single --panel triple.
  const r = resolvePanelMembers(EMPTY_SELECTIONS, T_PI);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.members[0]).toMatchObject({
    harness: "pi",
    preset: T_PI,
    ordinal: 1,
  });
});

// ---- argv shape ------------------------------------------------------------

test("buildPanelLegArgv: leg carries the RAW triple as --preset + the slug as --name; presetless leg drops --preset; no banned tokens", () => {
  // The forwarded `--preset` is the raw triple (identity); only display surfaces
  // (`--name`, the output basename) take the slug.
  const slug = "claude-opus-high-abc123-1";
  const presetArgv = buildPanelLegArgv({
    keeperBin: KEEPER_BIN,
    keeperAgentPath: KEEPER_AGENT,
    prompt: "what is the best answer?",
    member: { name: slug, harness: "claude", preset: T_CLAUDE, ordinal: 1 },
    slug: "my-run",
    yamlPath: `/d/${slug}.yaml`,
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
    T_CLAUDE,
    "--read-only",
    "--session",
    "panels",
    "--output",
    `/d/${slug}.yaml`,
    "--stop-timeout",
    "1800000ms",
    "--name",
    `panel::my-run::${slug}`,
    "--reap-window-on-terminal",
  ]);

  // A presetless member keeps its harness as the `<cli>` positional and drops the
  // `--preset` flag entirely.
  const presetlessArgv = buildPanelLegArgv({
    keeperBin: KEEPER_BIN,
    keeperAgentPath: KEEPER_AGENT,
    prompt: "q",
    member: { name: "pi", harness: "pi" },
    slug: "my-run",
    yamlPath: "/d/codex.yaml",
    stopTimeoutMs: 1_800_000,
  });
  expect(presetlessArgv.slice(0, 5)).toEqual([
    KEEPER_BIN,
    KEEPER_AGENT,
    "agent",
    "run",
    "pi",
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
  const selections: PanelSelections = {
    panels: { default: panelDef([T_CLAUDE, T_CODEX]) },
    default: "default",
  };
  const { deps, spawns, stdout } = makeDeps({ selections });
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
    // Each leg is named panel::<slug>::<member-slug> (a disambiguated slugifyTriple).
    const nameIdx = leg.indexOf("--name");
    expect(leg[nameIdx + 1]).toMatch(
      /^panel::my-run::(claude-opus-high|pi-openai-codex-gpt-5-3-high)-[0-9a-z]{6}-1$/,
    );
  }

  // Manifest persisted AND printed identically.
  const persisted = readManifest();
  const printed: PanelManifest = JSON.parse(stdout().trim());
  expect(printed).toEqual(persisted);
  expect(persisted.dir).toBe(dir);
  expect(persisted.slug).toBe("my-run");
  const [a, b] = persisted.members;
  const requestId = persisted.request_id;
  if (requestId === undefined) throw new Error("missing panel request id");
  expect(a?.name).toMatch(/^claude-opus-high-[0-9a-z]{6}-1$/);
  expect(b?.name).toMatch(/^pi-openai-codex-gpt-5-3-high-[0-9a-z]{6}-1$/);
  // The result-file + pidfile basenames derive from the disambiguated slug.
  expect(a?.yaml).toBe(join(dir, `${a?.name}.yaml`));
  expect(a?.pidfile).toBe(join(dir, `${a?.name}.pidfile`));
  for (const [index, member] of persisted.members.entries()) {
    const attempt = member.attempts?.[0];
    if (attempt?.control == null) throw new Error("missing attempt control");
    expect(attempt.control).toEqual({
      path: join(dir, `${member.name}.control.json`),
      request_id: requestId,
      member: member.name,
      attempt: 1,
    });
    const leg = spawns[index]?.argv ?? [];
    const controlIndex = leg.indexOf("--control");
    const ownerIndex = leg.indexOf("--control-owner");
    expect(leg[controlIndex + 1]).toBe(attempt.control.path);
    expect(JSON.parse(leg[ownerIndex + 1] ?? "null")).toEqual({
      request_id: requestId,
      member: member.name,
      attempt: 1,
    });
  }
  // Prompt copied into the scratch dir.
  expect(readFileSync(join(dir, "prompt.md"), "utf8")).toBe(
    "what is the best answer?",
  );
});

test("start pre-registers every control association before the first spawn", async () => {
  const launched = makeDeps({ selections: DEFAULT_SELECTIONS });
  let checked = false;
  launched.deps.spawn = () => {
    if (checked) return;
    checked = true;
    const manifest = readManifest();
    expect(manifest.members).toHaveLength(2);
    expect(
      manifest.members.every((member) => member.attempts?.[0]?.control != null),
    ).toBe(true);
  };

  expect(
    await panelStart(
      {
        promptFile: writePrompt("pre-register"),
        slug: "pre-register",
        panel: "default",
        dir,
        timeoutSeconds: 900,
      },
      launched.deps,
    ),
  ).toBe(0);
  expect(checked).toBe(true);
});

test("start: an absent --panel uses the panel.yaml default, launching each via --preset", async () => {
  const { deps, spawns } = makeDeps({ selections: DEFAULT_SELECTIONS });
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
  // The forwarded --preset is the raw triple, verbatim.
  expect(opusLeg).toContain("--preset");
  expect(opusLeg).toContain(T_CLAUDE);
  expect(opusLeg).not.toContain("--cli");
  expect(codexLeg).toContain("--preset");
  expect(codexLeg).toContain(T_CODEX);
});

test("start: no --panel and no default panel is fail-loud (exit 2)", async () => {
  const { deps, stderr } = makeDeps({
    selections: {
      panels: { default: panelDef([T_CLAUDE, T_CODEX]) },
      default: null,
    },
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
    selections: {
      panels: { reviewers: panelDef([T_CLAUDE, T_CODEX]) },
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
  expect(spawns[0]?.argv).toContain(T_CLAUDE);
  expect(spawns[1]?.argv).toContain(T_CODEX);
});

test("start: --panel default with no configured default is fail-loud naming what was typed", async () => {
  const { deps, stderr } = makeDeps({
    selections: {
      panels: { reviewers: panelDef([T_CLAUDE, T_CODEX]) },
      default: null,
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
  expect(code).toBe(2);
  // Distinct from the no-flag guard: this message names `--panel default`.
  expect(stderr()).toContain("--panel default given");
});

test("start: a per-leg spawn failure records a null pidfile (no crash)", async () => {
  // The claude leg spawns fine; the codex leg's spawn throws.
  const { deps } = makeDeps({
    selections: DEFAULT_SELECTIONS,
    throwOnSpawn: (argv) => argv.join(" ").includes(T_CODEX),
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
  expect(m.members[0]?.harness).toBe("claude");
  expect(typeof m.members[0]?.pidfile).toBe("string");
  expect(m.members[1]?.harness).toBe("pi");
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

test("resume: reuses terminal legs, leaves a live leg, and explicitly replaces a dead attempt", async () => {
  const selections: PanelSelections = {
    panels: { quad: panelDef([T_CLAUDE, T_CODEX, T_CLAUDE2, T_CODEX2]) },
    default: "quad",
  };
  const prompt = writePrompt("reconcile me");

  // First fan-out (fresh): all four legs launch at generation 1.
  const first = makeDeps({ selections, bootEpochMs: () => RECONCILE_BOOT });
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
  // The resolved leg slugs, in declaration order (done, failed, dead, live).
  const [done, failed, dead, live] = memberSlugs() as [
    string,
    string,
    string,
    string,
  ];

  // Simulate leg outcomes: done→completed, failed→a failed result (both terminal);
  // dead→dead pid + no result; live→live pid + no result.
  seedResult(done, "completed");
  seedResult(failed, "timed_out");
  seedPidfile(dead, 5555);
  seedPidfile(live, 4242);

  // Re-issue the SAME start: same boot, graceMs 0 (the dead pid is not grace-held),
  // and pidAlive true only for the live pid.
  const second = makeDeps({
    selections,
    bootEpochMs: () => RECONCILE_BOOT,
    graceMs: 0,
    pidAlive: (pid) => pid === 4242,
  });
  expect(
    await panelResume(
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
  expect(leg[leg.indexOf("--name") + 1]).toBe(`panel::quad::${dead}`);
  expect(leg[leg.indexOf("--output") + 1]).toBe(join(dir, `${dead}.g2.yaml`));

  const m = readManifest();
  expect(m.generation).toBe(2);
  const byName = Object.fromEntries(m.members.map((x) => [x.name, x]));
  // Terminal legs kept their generation-1 paths (reused, never relaunched).
  expect(byName[done]?.yaml).toBe(join(dir, `${done}.yaml`));
  expect(byName[failed]?.yaml).toBe(join(dir, `${failed}.yaml`));
  // The live leg is left untouched (still its gen-1 path).
  expect(byName[live]?.yaml).toBe(join(dir, `${live}.yaml`));
  // The dead leg repointed to gen 2 (both result + pidfile).
  expect(byName[dead]?.yaml).toBe(join(dir, `${dead}.g2.yaml`));
  expect(byName[dead]?.pidfile).toBe(join(dir, `${dead}.g2.pidfile`));
});

test("resume: a boot mismatch replaces every non-terminal leg while reusing completed legs", async () => {
  const selections: PanelSelections = {
    panels: { duo: panelDef([T_CLAUDE, T_CODEX]) },
    default: "duo",
  };
  const prompt = writePrompt("reboot me");

  const first = makeDeps({ selections, bootEpochMs: () => RECONCILE_BOOT });
  await panelStart(
    { promptFile: prompt, slug: "duo", panel: "duo", dir, timeoutSeconds: 900 },
    first.deps,
  );
  const [done, running] = memberSlugs() as [string, string];
  seedResult(done, "completed");
  seedPidfile(running, 4242); // a pid that was alive pre-reboot

  // Re-issue after a reboot: the derived boot-epoch jumps an hour beyond tolerance.
  // Even though the pid still reads "alive", a pre-reboot pid can't be trusted.
  const second = makeDeps({
    selections,
    bootEpochMs: () => RECONCILE_BOOT + 60 * 60_000,
    pidAlive: () => true,
  });
  expect(
    await panelResume(
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
  expect(leg[leg.indexOf("--name") + 1]).toBe(`panel::duo::${running}`);
  const m = readManifest();
  expect(m.generation).toBe(2);
  // The boot-epoch is re-stamped to the current boot.
  expect(m.boot_epoch_ms).toBe(RECONCILE_BOOT + 60 * 60_000);
  const byName = Object.fromEntries(m.members.map((x) => [x.name, x]));
  expect(byName[done]?.yaml).toBe(join(dir, `${done}.yaml`)); // reused gen 1
  expect(byName[running]?.yaml).toBe(join(dir, `${running}.g2.yaml`)); // relaunched
});

test("reconcile: a same-boot leg launched within grace is left (not relaunched) despite a dead pid", async () => {
  const selections: PanelSelections = {
    panels: { solo: panelDef([T_CLAUDE]) },
    default: "solo",
  };
  const prompt = writePrompt("grace me");
  const clock = { ms: 1000 };

  const first = makeDeps({
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
  const [fresh] = memberSlugs() as [string];
  seedPidfile(fresh, 7777); // pid recorded, but the process reads dead

  // Re-issue at the same clock (launched_at === now) with a generous grace and a
  // dead pid: the leg is too fresh to trust the dead reading → LEFT, not relaunched.
  const second = makeDeps({
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
  const [opus, codex] = memberSlugs() as [string, string];
  seedResult(opus, "completed");
  seedResult(codex, "failed"); // a terminal fail still counts — resume is not retry

  const second = makeDeps({
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
  const selA: PanelSelections = {
    panels: { p: panelDef([T_CLAUDE, T_CODEX]) },
    default: "p",
  };
  const prompt = writePrompt("same prompt");
  const first = makeDeps({ selections: selA });
  await panelStart(
    { promptFile: prompt, slug: "run-x", panel: "p", dir, timeoutSeconds: 900 },
    first.deps,
  );

  // Re-issue with the SAME prompt but a DIFFERENT member set (the codex triple
  // swapped for a second claude triple).
  const selB: PanelSelections = {
    panels: { p: panelDef([T_CLAUDE, T_CLAUDE2]) },
    default: "p",
  };
  const second = makeDeps({ selections: selB });
  const code = await panelStart(
    { promptFile: prompt, slug: "run-x", panel: "p", dir, timeoutSeconds: 900 },
    second.deps,
  );
  expect(code).toBe(2);
  expect(second.spawns.length).toBe(0);
  expect(second.stderr()).toContain("different member set");
});

test("start: one reservation has an opaque identity and never implicitly re-fans out", async () => {
  const prompt = writePrompt("one fanout");
  const first = makeDeps({ selections: DEFAULT_SELECTIONS, graceMs: 0 });
  first.deps.randomUuid = () => "11111111-2222-4333-8444-555555555555";
  await panelStart(
    {
      promptFile: prompt,
      slug: "owned",
      panel: "default",
      dir,
      timeoutSeconds: 900,
    },
    first.deps,
  );
  const initial = readManifest();
  expect(initial.request_id).toBe("11111111-2222-4333-8444-555555555555");
  expect(initial.argument_digest).toMatch(/^[0-9a-f]{64}$/);
  expect(initial.normal_fanout_started).toBe(true);
  expect(initial.members.every((m) => m.attempts?.length === 1)).toBe(true);

  const second = makeDeps({ selections: DEFAULT_SELECTIONS, graceMs: 0 });
  expect(
    await panelStart(
      {
        promptFile: prompt,
        slug: "owned",
        panel: "default",
        dir,
        timeoutSeconds: 900,
      },
      second.deps,
    ),
  ).toBe(0);
  expect(second.spawns).toHaveLength(0);
  expect(readManifest().request_id).toBe(initial.request_id);
});

test("resume is capped to one replacement attempt per member", async () => {
  const selections: PanelSelections = {
    panels: { one: panelDef([T_CLAUDE]) },
    default: "one",
  };
  const prompt = writePrompt("bounded resume");
  await panelStart(
    {
      promptFile: prompt,
      slug: "bounded",
      panel: "one",
      dir,
      timeoutSeconds: 900,
    },
    makeDeps({ selections }).deps,
  );
  const [name] = memberSlugs() as [string];
  seedPidfile(name, 10);
  const firstResume = makeDeps({ selections, graceMs: 0 });
  await panelResume(
    {
      promptFile: prompt,
      slug: "bounded",
      panel: "one",
      dir,
      timeoutSeconds: 900,
    },
    firstResume.deps,
  );
  expect(firstResume.spawns).toHaveLength(1);
  writeFileSync(join(dir, `${name}.g2.pidfile`), "11\n");
  const secondResume = makeDeps({ selections, graceMs: 0 });
  await panelResume(
    {
      promptFile: prompt,
      slug: "bounded",
      panel: "one",
      dir,
      timeoutSeconds: 900,
    },
    secondResume.deps,
  );
  expect(secondResume.spawns).toHaveLength(0);
  expect(readManifest().members[0]?.attempts).toHaveLength(2);
});

test("cancel tombstones first, tears down exact live attempts, and is idempotent", async () => {
  const selections: PanelSelections = {
    panels: { one: panelDef([T_CLAUDE]) },
    default: "one",
  };
  const prompt = writePrompt("cancel me");
  const launched = makeDeps({ selections });
  await panelStart(
    {
      promptFile: prompt,
      slug: "cancel",
      panel: "one",
      dir,
      timeoutSeconds: 900,
    },
    launched.deps,
  );
  const [name] = memberSlugs() as [string];
  seedPidfile(name, 42);
  const exactCommand = seedControl(name);
  let alive = true;
  const cancel = makeDeps({ selections, pidAlive: () => alive });
  const signalled: number[] = [];
  cancel.deps.terminatePid = (pid) => {
    const tombstone = readManifest();
    expect(tombstone.state).toBe("cancelled");
    expect(tombstone.cleanup_status).toBe("pending");
    signalled.push(pid);
    alive = false;
  };
  expect(await panelCancel({ dir, cleanupMs: 10 }, cancel.deps)).toBe(0);
  expect(cancel.tmuxCommands).toEqual([exactCommand]);
  expect(signalled).toEqual([42]);
  expect(readManifest()).toMatchObject({
    state: "cancelled",
    cleanup_status: "settled",
  });
  expect(await panelCancel({ dir, cleanupMs: 10 }, cancel.deps)).toBe(0);
  expect(signalled).toEqual([42]);
});

test("cancel reports a launched member with an absent pidfile as unresolved", async () => {
  const selections: PanelSelections = {
    panels: { one: panelDef([T_CLAUDE]) },
    default: "one",
  };
  await panelStart(
    {
      promptFile: writePrompt("pidfile race"),
      slug: "pidfile-race",
      panel: "one",
      dir,
      timeoutSeconds: 900,
    },
    makeDeps({ selections }).deps,
  );
  const [member] = readManifest().members;
  expect(member?.attempts?.[0]?.launched_at).not.toBeNull();
  expect(member?.pidfile).not.toBeNull();
  expect(existsSync(member?.pidfile ?? "")).toBe(false);
  seedControl(member?.name ?? "");

  const cancel = makeDeps({ selections, pollIntervalMs: 1 });
  expect(await panelCancel({ dir, cleanupMs: 2 }, cancel.deps)).toBe(1);

  const cancelled = readManifest();
  const identity = `${cancelled.members[0]?.name}#1`;
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.cleanup_status).toBe("failed");
  expect(cancelled.unresolved_cleanup).toEqual([identity]);
  expect(cancelled.members[0]?.attempts?.[0]?.state).toBe("cleanup_failed");
});

test("cancel reports exact unresolved identities and duplicate cancellation does not signal twice", async () => {
  const selections: PanelSelections = {
    panels: { one: panelDef([T_CLAUDE]) },
    default: "one",
  };
  const prompt = writePrompt("wedged cleanup");
  await panelStart(
    {
      promptFile: prompt,
      slug: "wedged",
      panel: "one",
      dir,
      timeoutSeconds: 900,
    },
    makeDeps({ selections }).deps,
  );
  const [name] = memberSlugs() as [string];
  seedPidfile(name, 77);
  seedControl(name);
  const cancel = makeDeps({
    selections,
    pidAlive: (pid) => pid === 77,
    pollIntervalMs: 1,
  });
  let signals = 0;
  cancel.deps.terminatePid = () => {
    signals += 1;
  };
  expect(await panelCancel({ dir, cleanupMs: 2 }, cancel.deps)).toBe(1);
  expect(JSON.parse(cancel.stdout().trim()).unresolved).toEqual([`${name}#1`]);
  expect(await panelCancel({ dir, cleanupMs: 2 }, cancel.deps)).toBe(1);
  expect(signals).toBe(1);
});

test("cancel refuses to signal a recycled pid", async () => {
  const selections: PanelSelections = {
    panels: { one: panelDef([T_CLAUDE]) },
    default: "one",
  };
  const prompt = writePrompt("recycled cancel");
  await panelStart(
    {
      promptFile: prompt,
      slug: "recycled",
      panel: "one",
      dir,
      timeoutSeconds: 900,
    },
    makeDeps({ selections }).deps,
  );
  const [name] = memberSlugs() as [string];
  seedPidfile(name, 88);
  seedStartfile(name, "ORIGINAL");
  seedControl(name);
  const cancel = makeDeps({
    selections,
    pidAlive: () => true,
    readStartTime: () => "FOREIGN",
  });
  let signalled = false;
  cancel.deps.terminatePid = () => {
    signalled = true;
  };
  expect(await panelCancel({ dir, cleanupMs: 1 }, cancel.deps)).toBe(0);
  expect(signalled).toBe(false);
});

test("cancel consumes a result-bearing attempt's exact control", async () => {
  const selections: PanelSelections = {
    panels: { one: panelDef([T_CLAUDE]) },
    default: "one",
  };
  await panelStart(
    {
      promptFile: writePrompt("result first"),
      slug: "result-first",
      panel: "one",
      dir,
      timeoutSeconds: 900,
    },
    makeDeps({ selections }).deps,
  );
  const [name] = memberSlugs() as [string];
  seedResult(name, "completed");
  seedPidfile(name, 101);
  const exactCommand = seedControl(name);
  const cancel = makeDeps({ selections, pidAlive: () => false });

  expect(await panelCancel({ dir, cleanupMs: 1 }, cancel.deps)).toBe(0);
  expect(cancel.tmuxCommands).toEqual([exactCommand]);
  expect(readManifest().cleanup_status).toBe("settled");
});

test.each(["missing", "malformed", "ownership-mismatch", "legacy"])(
  "cancel fails closed for a %s control without derived teardown",
  async (kind) => {
    const selections: PanelSelections = {
      panels: { one: panelDef([T_CLAUDE]) },
      default: "one",
    };
    await panelStart(
      {
        promptFile: writePrompt(kind),
        slug: `bad-${kind}`,
        panel: "one",
        dir,
        timeoutSeconds: 900,
      },
      makeDeps({ selections }).deps,
    );
    const [name] = memberSlugs() as [string];
    seedPidfile(name, 202);
    const manifest = readManifest();
    const attempt = manifest.members[0]?.attempts?.[0];
    if (attempt?.control == null) throw new Error("missing fixture control");
    if (kind === "malformed") {
      writeFileSync(attempt.control.path, "{}\n");
    } else if (kind === "ownership-mismatch") {
      seedControl(name, {
        owner: {
          request_id: "foreign-request",
          member: name,
          attempt: 1,
        },
      });
    } else if (kind === "legacy") {
      delete attempt.control;
      writeFileSync(
        join(dir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    }
    const cancel = makeDeps({ selections, pidAlive: () => true });
    let signalled = false;
    cancel.deps.terminatePid = () => {
      signalled = true;
    };

    expect(await panelCancel({ dir, cleanupMs: 0 }, cancel.deps)).toBe(1);
    expect(cancel.tmuxCommands).toEqual([]);
    expect(signalled).toBe(false);
    expect(readManifest()).toMatchObject({
      state: "cancelled",
      cleanup_status: "failed",
      unresolved_cleanup: [`${name}#1`],
    });
  },
);

test("failed exact cleanup remains retryable and converges through already-absent", async () => {
  const selections: PanelSelections = {
    panels: { one: panelDef([T_CLAUDE]) },
    default: "one",
  };
  await panelStart(
    {
      promptFile: writePrompt("retry cleanup"),
      slug: "retry-cleanup",
      panel: "one",
      dir,
      timeoutSeconds: 900,
    },
    makeDeps({ selections }).deps,
  );
  const [name] = memberSlugs() as [string];
  seedPidfile(name, 303);
  seedControl(name);
  const first = makeDeps({
    selections,
    pidAlive: () => false,
    runTmuxCommand: () => ({
      exitCode: 1,
      stdout: "",
      stderr: "permission denied",
    }),
  });
  expect(await panelCancel({ dir, cleanupMs: 1 }, first.deps)).toBe(1);
  expect(readManifest().cleanup_status).toBe("failed");

  const second = makeDeps({
    selections,
    pidAlive: () => false,
    runTmuxCommand: () => ({
      exitCode: 1,
      stdout: "",
      stderr: "can't find window: @1",
    }),
  });
  expect(await panelCancel({ dir, cleanupMs: 1 }, second.deps)).toBe(0);
  expect(readManifest()).toMatchObject({
    state: "cancelled",
    cleanup_status: "settled",
    unresolved_cleanup: [],
  });
});

test("a marked panel member cannot reserve a nested panel request", async () => {
  const marked = makeDeps({ selections: DEFAULT_SELECTIONS });
  marked.deps.env.KEEPER_PANEL_MEMBER = "parent-request";
  expect(
    await panelStart(
      {
        promptFile: writePrompt(),
        slug: "nested",
        panel: "default",
        dir,
        timeoutSeconds: 900,
      },
      marked.deps,
    ),
  ).toBe(2);
  expect(marked.spawns).toHaveLength(0);
  expect(existsSync(join(dir, "manifest.json"))).toBe(false);
});

// ---- wait ------------------------------------------------------------------

/** Drive start (recording spawn) against the default claude+codex panel, then
 *  return the two resolved leg slugs `[claude, codex]` so the caller can seed leg
 *  outcomes for wait by the name the resolver actually minted. */
async function startLegacy(): Promise<[string, string]> {
  const { deps } = makeDeps({
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
  return memberSlugs() as [string, string];
}

test("wait: full-success N-of-N → exit 0, ok:true (manifest round-trip)", async () => {
  const [opus, codex] = await startLegacy();
  seedResult(opus, "completed");
  seedResult(codex, "completed");

  const { deps, stdout } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0);
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(true);
  expect(v.dir).toBe(dir);
  expect(v.members).toEqual([
    {
      name: opus,
      harness: "claude",
      status: "ok",
      yaml: join(dir, `${opus}.yaml`),
      reason: null,
    },
    {
      name: codex,
      harness: "pi",
      status: "ok",
      yaml: join(dir, `${codex}.yaml`),
      reason: null,
    },
  ]);
});

test("wait: mixed verdict (one failed outcome) → exit 0, ok:false, reason=outcome", async () => {
  const [opus, codex] = await startLegacy();
  seedResult(opus, "completed");
  seedResult(codex, "timed_out");

  const { deps, stdout } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0); // all-terminal, NOT all-success
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(false);
  expect(v.members[0]).toMatchObject({ name: opus, status: "ok" });
  expect(v.members[1]).toMatchObject({
    name: codex,
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
    const [opus, codex] = await startLegacy();
    seedResult(opus, "completed");
    seedResult(codex, outcome);
    const { deps, stdout } = makeDeps({});
    const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
    expect(code).toBe(0);
    const v: PanelVerdict = JSON.parse(stdout().trim());
    expect(v.ok).toBe(false);
    expect(v.members[1]).toMatchObject({
      name: codex,
      status: "fail",
      yaml: null,
      reason: outcome,
    });
  }
});

test("wait: a present-but-unparseable result file → fail (reason=corrupt-result)", async () => {
  const [opus, codex] = await startLegacy();
  seedResult(opus, "completed");
  // A half-written / non-JSON present file — never throws out of wait.
  writeFileSync(join(dir, `${codex}.yaml`), "{not json");

  const { deps, stdout } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0);
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(false);
  expect(v.members[1]).toMatchObject({
    name: codex,
    status: "fail",
    reason: "corrupt-result",
  });
});

test("wait: content-blind — a panelist answer in the result file never reaches the verdict", async () => {
  const [opus, codex] = await startLegacy();
  // seedResult stamps the SECRET marker into each completed envelope's `message`.
  seedResult(opus, "completed");
  seedResult(codex, "completed");

  const { deps, stdout } = makeDeps({});
  const code = await panelWait({ dir, chunkSeconds: 540 }, deps);
  expect(code).toBe(0);
  expect(stdout()).not.toContain("SECRET_ANSWER_DO_NOT_LEAK");
});

test("wait: a non-terminal leg with a live pid → exit 124 when the chunk elapses", async () => {
  const [opus, codex] = await startLegacy();
  // opus is done; codex is still running (pid alive, no result file).
  seedResult(opus, "completed");
  writeFileSync(join(dir, `${codex}.pidfile`), "4242\n");

  const { deps } = makeDeps({ pidAlive: (pid) => pid === 4242 });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(124);
});

test("wait: a dead pid past the startup grace → crash fail (exit 0, ok:false)", async () => {
  const [opus, codex] = await startLegacy();
  seedResult(opus, "completed");
  // codex never wrote a result file; its pid is gone (crash-without-file).
  writeFileSync(join(dir, `${codex}.pidfile`), "4242\n");

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

test("wait: a successful launch missing its pidfile terminalizes after grace", async () => {
  const launched = makeDeps({ selections: DEFAULT_SELECTIONS, graceMs: 0 });
  await panelStart(
    {
      promptFile: writePrompt(),
      slug: "missing-pid",
      panel: "default",
      dir,
      timeoutSeconds: 900,
    },
    launched.deps,
  );
  const waited = makeDeps({ graceMs: 0 });
  expect(await panelWait({ dir, chunkSeconds: 1 }, waited.deps)).toBe(0);
  const verdict = JSON.parse(waited.stdout()) as PanelVerdict;
  expect(verdict.ok).toBe(false);
  expect(verdict.members[0]?.reason).toBe(
    "launched but left no pidfile or result",
  );
});

test("wait: a null-pidfile (launch-failed) leg is a terminal fail", async () => {
  // Hand-write a manifest with a null pidfile (start's spawn-failure record).
  const manifest: PanelManifest = {
    dir,
    slug: "run-x",
    members: [
      {
        name: "pi",
        harness: "pi",
        yaml: join(dir, "pi.yaml"),
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
    members: [{ name: "x", harness: "pi", yaml: "/d/x.yaml", pidfile: null }],
  });
  expect(r.ok).toBe(false);
});

// ---- start-time capture (recycle-guard anchor) -----------------------------

test("start: each leg carries a startfile path and the detach wrapper receives $STARTFILE", async () => {
  const { deps, spawns } = makeDeps({
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
  const [opus, codexSlug] = await startLegacy();
  seedResult(opus, "completed");
  seedPidfile(codexSlug, 4242); // the pid is occupied...
  seedStartfile(codexSlug, "STORED"); // ...but by a different process now
  const { deps, stdout } = makeDeps({
    pidAlive: (pid) => pid === 4242, // kill(pid,0) says alive
    readStartTime: (pid) => (pid === 4242 ? "RECYCLED" : null), // ≠ stored
    graceMs: 0,
  });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(0); // terminal, NOT 124 — the recycled pid is treated as dead
  const v: PanelVerdict = JSON.parse(stdout().trim());
  expect(v.ok).toBe(false);
  const codex = v.members.find((m) => m.name === codexSlug);
  expect(codex?.status).toBe("fail");
  expect(codex?.reason).toContain("exited before producing a result file");
});

test("wait recycle guard: a MATCHING start-time keeps the leg live (times out 124)", async () => {
  const [opus, codex] = await startLegacy();
  seedResult(opus, "completed");
  seedPidfile(codex, 4242);
  seedStartfile(codex, "STORED");
  const { deps } = makeDeps({
    pidAlive: (pid) => pid === 4242,
    readStartTime: (pid) => (pid === 4242 ? "STORED" : null), // == stored → same proc
    graceMs: 0,
  });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(124); // still running → chunk elapses
});

test("wait recycle guard: a null live probe fails OPEN (leg stays live)", async () => {
  const [opus, codex] = await startLegacy();
  seedResult(opus, "completed");
  seedPidfile(codex, 4242);
  seedStartfile(codex, "STORED");
  const { deps } = makeDeps({
    pidAlive: (pid) => pid === 4242,
    readStartTime: () => null, // can't tell → trust bare pid liveness
    graceMs: 0,
  });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(124); // fail-open → still running
});

test("wait recycle guard: a missing stored start-time degrades to bare pid liveness (no probe)", async () => {
  const [opus, codex] = await startLegacy();
  seedResult(opus, "completed");
  seedPidfile(codex, 4242);
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
  const [opus, codex] = await startLegacy();
  seedResult(opus, "completed");
  seedPidfile(codex, 4242);
  seedStartfile(codex, "STORED");
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

test("resume recycle guard: a live recycled pid is explicitly replaced", async () => {
  const selections: PanelSelections = {
    panels: { one: panelDef([T_CLAUDE]) },
    default: "one",
  };
  const prompt = writePrompt("recycle me");
  const first = makeDeps({ selections });
  await panelStart(
    { promptFile: prompt, slug: "one", panel: "one", dir, timeoutSeconds: 900 },
    first.deps,
  );
  const [solo] = memberSlugs() as [string];
  seedPidfile(solo, 4242);
  seedStartfile(solo, "STORED");
  const second = makeDeps({
    selections,
    graceMs: 0,
    pidAlive: (pid) => pid === 4242,
    readStartTime: (pid) => (pid === 4242 ? "RECYCLED" : null), // ≠ stored → recycled
  });
  expect(
    await panelResume(
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
  const selections: PanelSelections = {
    panels: { one: panelDef([T_CLAUDE]) },
    default: "one",
  };
  const prompt = writePrompt("keep me");
  const first = makeDeps({ selections });
  await panelStart(
    { promptFile: prompt, slug: "one", panel: "one", dir, timeoutSeconds: 900 },
    first.deps,
  );
  const [solo] = memberSlugs() as [string];
  seedPidfile(solo, 4242);
  seedStartfile(solo, "STORED");
  const second = makeDeps({
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
  const [opus, codex] = await startLegacy(); // stamps boot_epoch_ms = TEST_BOOT_EPOCH_MS
  seedResult(opus, "completed"); // a leg that finished pre-reboot
  seedPidfile(codex, 4242); // a non-terminal leg
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
  const codexMember = v.members.find((m) => m.name === codex);
  expect(codexMember?.status).toBe("fail");
  expect(codexMember?.reason).toBe("machine-rebooted");
  // A leg that finished before the reboot keeps its real verdict (reused).
  expect(v.members.find((m) => m.name === opus)?.status).toBe("ok");
});

test("wait reboot guard: an absent boot-epoch (pre-durable manifest) does NOT fire the guard", async () => {
  // Hand-write a pre-durable manifest (no boot_epoch_ms) + a live non-terminal leg.
  const manifest: PanelManifest = {
    dir,
    slug: "run-x",
    members: [
      {
        name: "pi",
        harness: "pi",
        yaml: join(dir, "pi.yaml"),
        pidfile: join(dir, "pi.pidfile"),
      },
    ],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  seedPidfile("pi", 4242);
  const { deps } = makeDeps({
    pidAlive: (pid) => pid === 4242,
    bootEpochMs: () => TEST_BOOT_EPOCH_MS + 999 * 60_000, // no stored epoch to compare
  });
  const code = await panelWait({ dir, chunkSeconds: 1 }, deps);
  expect(code).toBe(124); // guard never fires → leg stays running → times out
});

test("wait reboot+recycle: a reboot supersedes the recycle check (Guard B wins, distinct reason)", async () => {
  const [opus, codex] = await startLegacy();
  seedResult(opus, "completed");
  seedPidfile(codex, 4242);
  seedStartfile(codex, "STORED");
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
  const codexMember = v.members.find((m) => m.name === codex);
  expect(codexMember?.reason).toBe("machine-rebooted"); // not "exited before…"
});

test("wait is strictly read-only: a reboot verdict writes nothing to the manifest", async () => {
  const [opus, codex] = await startLegacy();
  seedResult(opus, "completed");
  seedPidfile(codex, 4242);
  const before = readFileSync(join(dir, "manifest.json"), "utf8");
  const { deps } = makeDeps({
    pidAlive: (pid) => pid === 4242,
    bootEpochMs: () => TEST_BOOT_EPOCH_MS + 60 * 60_000,
  });
  await panelWait({ dir, chunkSeconds: 540 }, deps);
  const after = readFileSync(join(dir, "manifest.json"), "utf8");
  expect(after).toBe(before); // no relaunch, no re-stamp — wait never writes
});

// ---------------------------------------------------------------------------
// runPanelPrunePass (src/maintenance-worker.ts) — the fn-1248 item 5 auto-
// reaper wiring. panelPrune's own reap gates (lock/pid/TTL/recycle) are
// already exercised in test/agent-panel-cli.test.ts; these only prove the
// periodic-pass wrapper invokes it, relays a log ONLY when it reaped
// something, and preserves live/locked/pid-alive dirs exactly as panelPrune
// itself does.
// ---------------------------------------------------------------------------

const PRUNE_DAY_MS = 24 * 60 * 60 * 1000;

/** `runPanelPrunePass` deps: a fixed clock + pid/lock/start-time seams. `spawn`
 *  and `write` both throw if ever reached — the prune path never calls
 *  `spawn`, and `runPanelPrunePass` MUST intercept `write` itself (never pass
 *  a caller-supplied sink through to `panelPrune`, see its doc). */
function makePruneDeps(opts: {
  now: number;
  alive?: (pid: number) => boolean;
  readStartTime?: PanelDeps["readStartTime"];
  lock?: PanelDeps["lock"];
}): PanelDeps {
  return {
    keeperBin: KEEPER_BIN,
    keeperAgentPath: KEEPER_AGENT,
    env: {},
    cwd: dir,
    loadRegistry: () => ({
      catalog: { presets: {} },
      selections: { panels: {}, default: null },
    }),
    spawn: () => {
      throw new Error("runPanelPrunePass must never spawn");
    },
    now: () => opts.now,
    sleep: async () => {},
    pidAlive: opts.alive ?? (() => false),
    readStartTime: opts.readStartTime ?? (() => null),
    lock: opts.lock,
    write: () => {
      throw new Error("runPanelPrunePass must intercept write, not forward it");
    },
    writeErr: () => {},
  };
}

/** Seed a panel run dir (manifest + started-at sentinel + optional pidfiles)
 *  under `root`, mirroring agent-panel-cli.test.ts's `seedRunDir`. */
function seedPruneDir(
  root: string,
  slug: string,
  members: PanelManifestMember[],
  opts: { sentinel?: boolean; pids?: Record<string, string> } = {},
): string {
  const d = join(root, slug);
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
  return d;
}

test("runPanelPrunePass reaps an aged-out lock-free pid-dead dir and relays a log naming it", () => {
  const root = join(dir, "panels");
  const pidfile = join(root, "old-run", "x.pid");
  const d = seedPruneDir(
    root,
    "old-run",
    [
      {
        name: "x",
        harness: "pi",
        yaml: join(root, "old-run", "x.yaml"),
        pidfile,
      },
    ],
    { pids: { [pidfile]: "9999" } },
  );
  const deps = makePruneDeps({
    now: Date.now() + 10 * PRUNE_DAY_MS,
    alive: () => false,
  });
  const msgs: MaintenanceMessage[] = [];
  runPanelPrunePass(
    (m) => msgs.push(m),
    () => false,
    deps,
  );
  expect(existsSync(d)).toBe(false);
  expect(msgs).toHaveLength(1);
  const msg = msgs[0];
  expect(msg.kind).toBe("maintenance-log");
  if (msg.kind === "maintenance-log") {
    expect(msg.message).toContain("old-run");
  }
});

test("runPanelPrunePass preserves an aged run with unsettled exact controls", () => {
  const root = join(dir, "panels");
  const d = seedPruneDir(root, "unsettled-run", [
    {
      name: "x",
      harness: "pi",
      yaml: join(root, "unsettled-run", "x.yaml"),
      pidfile: null,
    },
  ]);
  const manifestPath = join(d, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(
    manifestPath,
    JSON.stringify({
      ...manifest,
      state: "cancelled",
      cancellation_requested_at: 1,
      cleanup_status: "failed",
      unresolved_cleanup: ["x#1"],
    }),
  );
  const msgs: MaintenanceMessage[] = [];
  runPanelPrunePass(
    (message) => msgs.push(message),
    () => false,
    makePruneDeps({ now: Date.now() + 10 * PRUNE_DAY_MS }),
  );
  expect(existsSync(d)).toBe(true);
  expect(msgs).toEqual([]);
});

test("runPanelPrunePass preserves a live-pid dir and relays no log (nothing reaped)", () => {
  const root = join(dir, "panels");
  const pidfile = join(root, "live-run", "x.pid");
  const d = seedPruneDir(
    root,
    "live-run",
    [
      {
        name: "x",
        harness: "pi",
        yaml: join(root, "live-run", "x.yaml"),
        pidfile,
      },
    ],
    { pids: { [pidfile]: "111" } },
  );
  const deps = makePruneDeps({
    now: Date.now() + 10 * PRUNE_DAY_MS,
    alive: (pid) => pid === 111,
  });
  const msgs: MaintenanceMessage[] = [];
  runPanelPrunePass(
    (m) => msgs.push(m),
    () => false,
    deps,
  );
  expect(existsSync(d)).toBe(true);
  expect(msgs).toHaveLength(0);
});

test("runPanelPrunePass preserves a lock-held dir (start/reconcile mid-flight)", () => {
  const root = join(dir, "panels");
  const d = seedPruneDir(root, "locked-run", []);
  const deps = makePruneDeps({
    now: Date.now() + 10 * PRUNE_DAY_MS,
    lock: (lockPath) =>
      lockPath.includes("locked-run") ? null : { release: (): void => {} },
  });
  const msgs: MaintenanceMessage[] = [];
  runPanelPrunePass(
    (m) => msgs.push(m),
    () => false,
    deps,
  );
  expect(existsSync(d)).toBe(true);
  expect(msgs).toHaveLength(0);
});

test("runPanelPrunePass preserves a recycle-guarded live dir (matching start-time, not bare pid liveness)", () => {
  const root = join(dir, "panels");
  const pidfile = join(root, "id-run", "x.pid");
  const startfile = join(root, "id-run", "x.starttime");
  const d = seedPruneDir(
    root,
    "id-run",
    [
      {
        name: "x",
        harness: "pi",
        yaml: join(root, "id-run", "x.yaml"),
        pidfile,
        startfile,
      },
    ],
    { pids: { [pidfile]: "111" } },
  );
  writeFileSync(startfile, "SAME\n");
  const deps = makePruneDeps({
    now: Date.now() + 10 * PRUNE_DAY_MS,
    alive: (pid) => pid === 111,
    readStartTime: (pid) => (pid === 111 ? "SAME" : null),
  });
  const msgs: MaintenanceMessage[] = [];
  runPanelPrunePass(
    (m) => msgs.push(m),
    () => false,
    deps,
  );
  expect(existsSync(d)).toBe(true);
  expect(msgs).toHaveLength(0);
});

test("runPanelPrunePass is a no-op when shutting down — dir untouched, nothing relayed", () => {
  const root = join(dir, "panels");
  const pidfile = join(root, "old-run", "x.pid");
  const d = seedPruneDir(
    root,
    "old-run",
    [
      {
        name: "x",
        harness: "pi",
        yaml: join(root, "old-run", "x.yaml"),
        pidfile,
      },
    ],
    { pids: { [pidfile]: "9999" } },
  );
  const deps = makePruneDeps({
    now: Date.now() + 10 * PRUNE_DAY_MS,
    alive: () => false,
  });
  const msgs: MaintenanceMessage[] = [];
  runPanelPrunePass(
    (m) => msgs.push(m),
    () => true,
    deps,
  );
  expect(existsSync(d)).toBe(true); // would-be-eligible dir never even scanned
  expect(msgs).toHaveLength(0);
});
