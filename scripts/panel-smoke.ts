#!/usr/bin/env bun
/**
 * Bounded, operator-invoked panel lifecycle smoke. It admits one uniquely named
 * request, polls only that run directory, and always settles it through exact
 * panel cancellation before reporting registered survivors.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isRunControlArtifact } from "../src/agent/run-capture";
import { keeperStateDir } from "../src/keeper-state-dir";
import type { PanelManifest } from "../src/pair/panel";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const parsed = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    panel: { type: "string" },
    "outer-timeout": { type: "string", default: "120" },
    "abort-after": { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (parsed.values.help) {
  process.stdout.write(`Usage: bun scripts/panel-smoke.ts --panel <small-panel> [--outer-timeout 120] [--abort-after 5]\n
Runs one unique, 2-3 member configured panel. --abort-after exercises explicit
operator cancellation; without it the script waits for a terminal verdict. The
hard outer timeout always aborts and the final JSON reports exact registered
survivors.\n`);
  process.exit(0);
}

const panel = parsed.values.panel;
if (panel === undefined || panel.trim() === "") {
  process.stderr.write(
    "panel-smoke: --panel <small configured panel> is required\n",
  );
  process.exit(2);
}

function positiveSeconds(raw: string | undefined, flag: string): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    process.stderr.write(
      `panel-smoke: --${flag} must be a positive number of seconds\n`,
    );
    process.exit(2);
  }
  return value;
}

const outerSeconds = positiveSeconds(
  parsed.values["outer-timeout"],
  "outer-timeout",
) as number;
const abortAfterSeconds = positiveSeconds(
  parsed.values["abort-after"],
  "abort-after",
);
if (outerSeconds < 20) {
  process.stderr.write(
    "panel-smoke: --outer-timeout must be at least 20 seconds (10 seconds are reserved for exact cleanup)\n",
  );
  process.exit(2);
}
const invocationId = randomUUID();
const slug = `lifecycle-smoke-${invocationId}`;
const runDir = join(keeperStateDir(), "panels", slug);
const promptPath = join(runDir, "smoke-inquiry.txt");
const deadline = Date.now() + outerSeconds * 1_000;
const operationDeadline = deadline - 10_000;
const keeperEntry = resolve(import.meta.dir, "../cli/keeper.ts");
mkdirSync(runDir, { recursive: true, mode: 0o700 });
writeFileSync(
  promptPath,
  "Independently identify one lifecycle invariant that a bounded panel runner should verify. Return a concise answer and do not convene another panel.\n",
);

async function command(
  args: string[],
  budgetMs: number,
): Promise<CommandResult> {
  const proc = Bun.spawn([process.execPath, keeperEntry, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      proc.kill("SIGTERM");
    },
    Math.max(1, budgetMs),
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return {
    exitCode,
    stdout: stdout.slice(-8_192),
    stderr: stderr.slice(-8_192),
    timedOut,
  };
}

function readManifest(): PanelManifest | null {
  try {
    return JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function registeredPids(manifest: PanelManifest | null): Array<{
  id: string;
  pid: number;
}> {
  const found: Array<{ id: string; pid: number }> = [];
  for (const member of manifest?.members ?? []) {
    for (const attempt of member.attempts ?? []) {
      if (attempt.pidfile === null) continue;
      try {
        const pid = Number.parseInt(readFileSync(attempt.pidfile, "utf8"), 10);
        if (Number.isInteger(pid) && pid > 0)
          found.push({ id: `${member.name}#${attempt.attempt}`, pid });
      } catch {
        // A child that never published a pid has no signalable registered identity.
      }
    }
  }
  return found;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function inspectExactControls(manifest: PanelManifest | null): {
  unresolved: string[];
  liveWindows: string[];
} {
  const unresolved: string[] = [];
  const liveWindows: string[] = [];
  const requestId = manifest?.request_id ?? manifest?.slug;
  for (const member of manifest?.members ?? []) {
    for (const attempt of member.attempts ?? []) {
      if (attempt.launched_at === null) continue;
      const id = `${member.name}#${attempt.attempt}`;
      const association = attempt.control;
      let artifact: unknown;
      try {
        artifact =
          association == null
            ? null
            : JSON.parse(readFileSync(association.path, "utf8"));
      } catch {
        artifact = null;
      }
      if (
        association == null ||
        association.request_id !== requestId ||
        association.member !== member.name ||
        association.attempt !== attempt.attempt ||
        !isRunControlArtifact(artifact) ||
        artifact.owner?.request_id !== requestId ||
        artifact.owner.member !== member.name ||
        artifact.owner.attempt !== attempt.attempt
      ) {
        unresolved.push(id);
        continue;
      }
      if (artifact.status !== "terminal") unresolved.push(id);
      const exactWindow = artifact.kill_window_command.at(-1) as string;
      const probe = Bun.spawnSync(
        [
          ...artifact.kill_window_command.slice(0, -3),
          "display-message",
          "-p",
          "-t",
          exactWindow,
          "#{window_id}",
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 2_000 },
      );
      const observed = new TextDecoder().decode(probe.stdout).trim();
      if (
        probe.exitedDueToTimeout ||
        probe.exitCode === null ||
        (probe.exitCode === 0 && observed === exactWindow) ||
        (probe.exitCode !== 0 &&
          !/(?:can't find (?:window|session)|no server running|no sessions|session not found|window not found)/i.test(
            new TextDecoder().decode(probe.stderr),
          ))
      ) {
        liveWindows.push(id);
      }
    }
  }
  return {
    unresolved: [...new Set(unresolved)].sort(),
    liveWindows: [...new Set(liveWindows)].sort(),
  };
}

let start: CommandResult | null = null;
let terminal: unknown = null;
let cancellation: unknown = null;
let failure: string | null = null;
let aborted = false;

try {
  start = await command(
    [
      "agent",
      "panel",
      "start",
      promptPath,
      "--slug",
      slug,
      "--panel",
      panel,
      "--run-dir",
      runDir,
      "--timeout",
      `${Math.max(5, Math.floor(outerSeconds))}s`,
    ],
    Math.min(15_000, Math.max(1, operationDeadline - Date.now())),
  );
  if (start.exitCode !== 0 || start.timedOut) {
    failure = `start failed (exit ${start.exitCode}${start.timedOut ? ", timed out" : ""})`;
  }

  const launched = readManifest()?.members.length ?? 0;
  if (failure === null && (launched < 2 || launched > 3)) {
    failure = `configured smoke panel must contain 2-3 members (resolved ${launched})`;
  }

  const abortAt =
    abortAfterSeconds === null ? null : Date.now() + abortAfterSeconds * 1_000;
  while (failure === null && terminal === null) {
    if (
      Date.now() >= operationDeadline ||
      (abortAt !== null && Date.now() >= abortAt)
    ) {
      aborted = true;
      break;
    }
    const remainingMs = operationDeadline - Date.now();
    const chunkSeconds = Math.max(
      1,
      Math.min(5, Math.floor(remainingMs / 1_000)),
    );
    const waited = await command(
      [
        "agent",
        "panel",
        "wait",
        "--run-dir",
        runDir,
        "--chunk",
        `${chunkSeconds}s`,
      ],
      Math.min(7_000, Math.max(1, remainingMs)),
    );
    if (waited.exitCode === 0) {
      terminal = JSON.parse(waited.stdout.trim());
      break;
    }
    if (waited.exitCode !== 124) {
      failure = `wait failed (exit ${waited.exitCode}${waited.timedOut ? ", timed out" : ""})`;
    }
  }
} catch (error) {
  failure = (error as Error).message;
} finally {
  const remainingMs = Math.max(1, Math.min(10_000, deadline - Date.now()));
  const cancelled = await command(
    ["agent", "panel", "cancel", "--run-dir", runDir],
    remainingMs,
  );
  try {
    cancellation = JSON.parse(cancelled.stdout.trim());
  } catch {
    cancellation = {
      exit_code: cancelled.exitCode,
      timed_out: cancelled.timedOut,
      error: cancelled.stderr.trim(),
    };
  }
}

const finalManifest = readManifest();
const launches = (finalManifest?.members ?? []).flatMap((member) =>
  (member.attempts ?? []).filter((attempt) => attempt.launched_at !== null),
).length;
const wrapperSurvivors = registeredPids(finalManifest).filter(({ pid }) =>
  isAlive(pid),
);
const exactControls = inspectExactControls(finalManifest);
const terminalOutcomes =
  terminal ??
  (finalManifest === null
    ? null
    : {
        state: finalManifest.state ?? null,
        members: finalManifest.members.map((member) => ({
          name: member.name,
          attempts: (member.attempts ?? []).map((attempt) => ({
            attempt: attempt.attempt,
            state: attempt.state,
          })),
        })),
      });
const report = {
  schema_version: 1,
  invocation_id: invocationId,
  request_id: finalManifest?.request_id ?? null,
  run_dir: runDir,
  panel,
  launch_count: launches,
  terminal_outcomes: terminalOutcomes,
  aborted,
  cancellation_settlement: cancellation,
  wrapper_survivor_count: wrapperSurvivors.length,
  wrapper_survivors: wrapperSurvivors.map(({ id }) => id),
  unresolved_control_count: exactControls.unresolved.length,
  unresolved_controls: exactControls.unresolved,
  exact_window_survivor_count: exactControls.liveWindows.length,
  exact_window_survivors: exactControls.liveWindows,
  exact_survivor_count:
    wrapperSurvivors.length +
    exactControls.unresolved.length +
    exactControls.liveWindows.length,
  exact_survivors: [
    ...wrapperSurvivors.map(({ id }) => `wrapper:${id}`),
    ...exactControls.unresolved.map((id) => `control:${id}`),
    ...exactControls.liveWindows.map((id) => `window:${id}`),
  ],
  failure,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(
  failure === null &&
    finalManifest?.cleanup_status === "settled" &&
    report.exact_survivor_count === 0
    ? 0
    : 1,
);
