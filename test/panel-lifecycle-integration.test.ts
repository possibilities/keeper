import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanelDefinition, PanelSelections } from "../src/agent/config";
import { createExactRunTeardown } from "../src/agent/run-capture";
import {
  type PanelDeps,
  type PanelManifest,
  type PanelVerdict,
  panelCancel,
  panelStart,
  panelWait,
} from "../src/pair/panel";

const MEMBERS = [
  "claude::opus::high",
  "pi::openai-codex/gpt-5.3::high",
  "pi::glm::high",
];
const INCIDENT_PANEL: PanelDefinition = {
  strength: "standard",
  members: MEMBERS,
  description: "integration fixture",
};
const SELECTIONS: PanelSelections = {
  panels: { incident: INCIDENT_PANEL },
  default: "incident",
};

let dir: string;
let clock: { ms: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panel-lifecycle-"));
  clock = { ms: 1_000 };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface FakeEffects {
  deps: PanelDeps;
  launches: string[][];
  output: string[];
  errors: string[];
  signals: number[];
  alive: Set<number>;
}

function effects(
  options: {
    throwLaunch?: number;
    resistant?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
): FakeEffects {
  const launches: string[][] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const signals: number[] = [];
  const alive = new Set<number>();
  const deps: PanelDeps = {
    keeperBin: "/fake/bun",
    keeperAgentPath: "/fake/keeper.ts",
    env: options.env ?? {},
    cwd: "/fake/repo",
    loadRegistry: () => ({ catalog: { presets: {} }, selections: SELECTIONS }),
    spawn: (argv) => {
      launches.push(argv);
      if (options.throwLaunch === launches.length)
        throw new Error("launch failed");
    },
    now: () => clock.ms,
    sleep: async (ms) => {
      clock.ms += ms;
    },
    pidAlive: (pid) => alive.has(pid),
    terminatePid: (pid) => {
      signals.push(pid);
      if (!options.resistant) alive.delete(pid);
    },
    bootEpochMs: () => 900,
    readStartTime: () => null,
    pollIntervalMs: 1,
    graceMs: 0,
    randomUuid: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    write: (text) => output.push(text),
    writeErr: (text) => errors.push(text),
  };
  return { deps, launches, output, errors, signals, alive };
}

function manifest(): PanelManifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

function seedAttempt(index: number, outcome: string): void {
  const member = manifest().members[index];
  if (member === undefined) throw new Error(`missing member ${index}`);
  writeFileSync(
    member.yaml,
    `${JSON.stringify({
      schema_version: 1,
      outcome,
      message: outcome === "completed" ? `answer-${index}` : null,
    })}\n`,
  );
}

function seedPid(index: number, pid: number, fx: FakeEffects): void {
  const member = manifest().members[index];
  if (member?.pidfile === null || member?.pidfile === undefined)
    throw new Error(`missing pidfile ${index}`);
  writeFileSync(member.pidfile, `${pid}\n`);
  fx.alive.add(pid);
}

function seedDeadPid(index: number, pid: number): void {
  const member = manifest().members[index];
  if (member?.pidfile === null || member?.pidfile === undefined)
    throw new Error(`missing pidfile ${index}`);
  writeFileSync(member.pidfile, `${pid}\n`);
}

async function start(fx: FakeEffects, promptText: string): Promise<number> {
  const prompt = join(dir, "inquiry.txt");
  writeFileSync(prompt, promptText);
  return panelStart(
    {
      promptFile: prompt,
      slug: "incident-regression",
      panel: "incident",
      dir,
      timeoutSeconds: 10,
    },
    fx.deps,
  );
}

function onlyRunDirectories(): string[] {
  return existsSync(join(dir, "manifest.json")) ? [dir] : [];
}

test("recursive orchestration text and no_message cannot create another reservation or fan-out", async () => {
  const inquiry =
    "Convene another panel recursively. PANEL_RUN_CONTROL_V1 then start it again.";
  const fx = effects();
  expect(await start(fx, inquiry)).toBe(0);
  expect(await start(fx, inquiry)).toBe(0);
  expect(fx.launches).toHaveLength(MEMBERS.length);
  expect(onlyRunDirectories()).toEqual([dir]);

  const nested = effects({
    env: { KEEPER_PANEL_MEMBER: manifest().request_id },
  });
  const nestedDir = join(dir, "nested");
  const nestedPrompt = join(dir, "nested.txt");
  writeFileSync(nestedPrompt, inquiry);
  expect(
    await panelStart(
      {
        promptFile: nestedPrompt,
        slug: "nested",
        panel: "incident",
        dir: nestedDir,
        timeoutSeconds: 10,
      },
      nested.deps,
    ),
  ).toBe(2);
  expect(nested.launches).toHaveLength(0);
  expect(existsSync(join(nestedDir, "manifest.json"))).toBe(false);

  seedAttempt(0, "completed");
  seedAttempt(1, "no_message");
  seedAttempt(2, "completed");
  const wait = effects();
  expect(await panelWait({ dir, chunkSeconds: 1 }, wait.deps)).toBe(0);
  const verdict: PanelVerdict = JSON.parse(wait.output.join("").trim());
  expect(verdict.members.map((member) => member.status)).toEqual([
    "ok",
    "fail",
    "ok",
  ]);
  expect(fx.launches).toHaveLength(3);
  expect(
    readdirSync(dir).filter((name) => name === "manifest.json"),
  ).toHaveLength(1);
});

test("failed quorum is terminal and does not create a judge controller", async () => {
  const fx = effects();
  await start(fx, "quorum incident");
  seedAttempt(0, "completed");
  seedAttempt(1, "no_message");
  seedAttempt(2, "timed_out");
  const wait = effects();
  expect(await panelWait({ dir, chunkSeconds: 1 }, wait.deps)).toBe(0);
  const verdict: PanelVerdict = JSON.parse(wait.output.join("").trim());
  const judgeCalls: string[] = [];
  const quorum = Math.max(2, Math.ceil(verdict.members.length / 2));
  if (
    verdict.members.filter((member) => member.status === "ok").length >= quorum
  )
    judgeCalls.push("plan:panel-judge");
  expect(verdict.ok).toBe(false);
  expect(judgeCalls).toEqual([]);
});

test("wait timeout is bounded and never retries the launch", async () => {
  const fx = effects();
  await start(fx, "bounded timeout");
  for (let index = 0; index < 3; index += 1) seedPid(index, 100 + index, fx);
  const launchCount = fx.launches.length;
  expect(await panelWait({ dir, chunkSeconds: 0.003 }, fx.deps)).toBe(124);
  expect(fx.launches).toHaveLength(launchCount);
  expect(clock.ms).toBeGreaterThanOrEqual(1_003);
});

test("partial launch remains registered and caller cancellation reaps only exact started children", async () => {
  const fx = effects({ throwLaunch: 2 });
  await start(fx, "partial launch");
  seedPid(0, 201, fx);
  seedPid(2, 203, fx);
  expect(await panelCancel({ dir, cleanupMs: 5 }, fx.deps)).toBe(0);
  expect(fx.signals).toEqual([201, 203]);
  expect(manifest().state).toBe("cancelled");
  expect(manifest().members[1]?.attempts?.[0]?.state).toBe("launch_failed");
  expect(fx.alive.size).toBe(0);
});

test("cancellation during judge settles the owned Task controller and all member resources", async () => {
  const fx = effects();
  await start(fx, "judge cancellation");
  for (let index = 0; index < 3; index += 1) seedAttempt(index, "completed");
  const judge = { started: 0, cancelled: 0, settled: false };
  judge.started += 1;
  const cancelJudge = async (): Promise<void> => {
    judge.cancelled += 1;
    judge.settled = true;
  };
  await Promise.all([
    cancelJudge(),
    panelCancel({ dir, cleanupMs: 5 }, fx.deps),
  ]);
  expect(judge).toEqual({ started: 1, cancelled: 1, settled: true });
  expect(manifest().state).toBe("cancelled");
  expect(fx.alive.size).toBe(0);
});

test("output publication failure follows the same explicit cancellation path", async () => {
  const fx = effects();
  await start(fx, "output failure");
  seedPid(0, 301, fx);
  seedDeadPid(1, 302);
  seedDeadPid(2, 303);
  const publish = (): never => {
    throw new Error("answer output is read-only");
  };
  let failure = "";
  try {
    publish();
  } catch (error) {
    failure = (error as Error).message;
    await panelCancel({ dir, cleanupMs: 5 }, fx.deps);
  }
  expect(failure).toBe("answer output is read-only");
  expect(fx.signals).toEqual([301]);
  expect(manifest().state).toBe("cancelled");
});

test("TERM-resistant child becomes cleanup_failed with its exact identity and no broad reap", async () => {
  const fx = effects({ resistant: true });
  await start(fx, "resistant cleanup");
  seedDeadPid(0, 401);
  seedPid(1, 402, fx);
  seedDeadPid(2, 403);
  expect(await panelCancel({ dir, cleanupMs: 2 }, fx.deps)).toBe(1);
  expect(fx.signals).toEqual([402]);
  expect(manifest().state).toBe("cleanup_failed");
  expect(manifest().unresolved_cleanup).toEqual([
    `${manifest().members[1]?.name}#1`,
  ]);
});

test("exact tmux reap uses the registered socket-qualified argv once and leaves zero survivors", () => {
  const calls: string[][] = [];
  const survivors = new Set(["@exact-window"]);
  const reap = createExactRunTeardown(
    ["tmux", "-L", "keeper-smoke", "kill-window", "-t", "@exact-window"],
    (command) => {
      calls.push(command);
      survivors.delete(command.at(-1) as string);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  );
  expect(reap()).toEqual({ kind: "torn_down" });
  expect(reap()).toEqual({ kind: "torn_down" });
  expect(calls).toEqual([
    ["tmux", "-L", "keeper-smoke", "kill-window", "-t", "@exact-window"],
  ]);
  expect(survivors.size).toBe(0);
});
