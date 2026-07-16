import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanelSelections } from "../src/agent/config";
import {
  type PanelDeps,
  type PanelManifest,
  panelCancel,
  panelStart,
} from "../src/pair/panel";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Panel cancellation owns exact teardown without a manual reap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-lifecycle-"));
  roots.push(dir);
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "settle the owned leg");
  const selections: PanelSelections = {
    panels: {
      one: {
        strength: "standard",
        description: "integration fixture",
        members: ["claude::opus::high"],
      },
    },
    default: "one",
  };
  const spawned: string[][] = [];
  let now = 10;
  let wrapperAlive = true;
  const deps: PanelDeps = {
    keeperBin: "/abs/bun",
    keeperAgentPath: "/abs/keeper.ts",
    env: {},
    cwd: "/work/repo",
    loadRegistry: () => ({ catalog: { presets: {} }, selections }),
    spawn: (argv) => spawned.push(argv),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    pidAlive: () => wrapperAlive,
    readStartTime: () => null,
    bootEpochMs: () => 1_700_000_000_000,
    randomUuid: () => "11111111-2222-4333-8444-555555555555",
    write: () => {},
    writeErr: () => {},
  };

  expect(
    await panelStart(
      {
        promptFile,
        slug: "owned-lifecycle",
        panel: "one",
        dir,
        timeoutSeconds: 30,
      },
      deps,
    ),
  ).toBe(0);

  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as PanelManifest;
  const member = manifest.members[0];
  const attempt = member?.attempts?.[0];
  if (
    member === undefined ||
    attempt?.control == null ||
    attempt.pidfile === null
  ) {
    throw new Error("panel attempt was not fully pre-registered");
  }
  const legArgv = spawned[0] ?? [];
  expect(legArgv[legArgv.indexOf("--control") + 1]).toBe(attempt.control.path);
  expect(
    JSON.parse(legArgv[legArgv.indexOf("--control-owner") + 1] ?? "null"),
  ).toEqual({
    request_id: manifest.request_id,
    member: member.name,
    attempt: 1,
  });

  const exactCommand = [
    "/opt/tmux",
    "-S",
    "/tmp/owned-panel.sock",
    "kill-window",
    "-t",
    "@44",
  ];
  writeFileSync(attempt.pidfile, "404\n");
  writeFileSync(
    attempt.yaml,
    `${JSON.stringify({ schema_version: 1, outcome: "completed" })}\n`,
  );
  writeFileSync(
    attempt.control.path,
    `${JSON.stringify({
      schema_version: 1,
      run_id: "owned-run-44",
      agent: "claude",
      started_at_ms: attempt.launched_at,
      kill_window_command: exactCommand,
      status: "running",
      owner: {
        request_id: attempt.control.request_id,
        member: attempt.control.member,
        attempt: attempt.control.attempt,
      },
    })}\n`,
  );

  const tmuxCalls: string[][] = [];
  deps.runTmuxCommand = (command) => {
    const tombstone = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as PanelManifest;
    expect(tombstone.state).toBe("cancelled");
    expect(tombstone.cleanup_status).toBe("pending");
    tmuxCalls.push(command);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  deps.terminatePid = () => {
    wrapperAlive = false;
  };

  expect(await panelCancel({ dir, cleanupMs: 10 }, deps)).toBe(0);
  expect(tmuxCalls).toEqual([exactCommand]);
  expect(JSON.parse(readFileSync(attempt.control.path, "utf8"))).toMatchObject({
    status: "terminal",
  });
  expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
    state: "cancelled",
    cleanup_status: "settled",
    unresolved_cleanup: [],
  });
});
