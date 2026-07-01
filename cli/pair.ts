#!/usr/bin/env bun
/**
 * `keeper pair send` — fan a task out to another model CLI (claude / codex) via
 * the in-binary `keeper agent` launcher, driven from the orchestrating session's
 * Monitor tool. Owns the pairing ergonomics, delegating the tmux transport +
 * model/effort selection to `keeper agent`.
 *
 * `keeper pair panel start|wait` — the cross-OS panel fan-out the
 * `plan:panel-runner` agent drives (members → detached `keeper pair send` legs →
 * chunked terminality poll → N-of-N verdict). All OS-specific machinery
 * (detachment, polling, deadline-bounding) lives in `src/pair/panel.ts` — zero
 * `setsid`/`timeout`/`gtimeout`. See that module for the start/wait contract.
 *
 * STDOUT IS THE MONITOR EVENT CHANNEL. Every run emits exactly one
 * `[keeper-pair] started ...` line followed by exactly one terminal line —
 * either `[keeper-pair] completed ...` (exit 0) or `[keeper-pair] failed ...`
 * (exit non-zero). The full result YAML is written to `--output`; stdout carries
 * ONLY the event stream. The two-line contract holds on EVERY path, including
 * SIGTERM/timeout (a Monitor kill) and early validation errors.
 *
 * Compose flow (in-process, via the shared `src/agent` run-capture primitives):
 *   1. launch the partner detached through the shared launch→handle helper
 *      (`launchToResolvedHandle`), holding the pinned `ResolvedHandle` locally.
 *   2. `composeRunCapture` drives `runWaitForStop` → `runShowLastMessage` on that
 *      handle IN-PROCESS — no `keeper agent` subprocess re-exec, so no
 *      cross-process kill margin and no self-transcript-collision exposure.
 *   3. map the run-capture outcome to pair's contract: `completed`/`no_message`
 *      write the partner's answer to `--output` (YAML) via write-temp-then-rename
 *      and emit `completed` only AFTER the rename (the Monitor event never points
 *      at a half-written file); every failure outcome emits `failed` + exits 1.
 *
 * Read-only posture is prompting-only: `--read-only` prepends the read-only
 * directive to the partner's prompt and relies on the model following it. keeper
 * enforces nothing — no tool strip, no git audit.
 *
 * Exit taxonomy: 0 = completed; 1 = failed (launch/wait/show error, SIGTERM,
 * timeout); 2 = arg fault (bad flags, missing prompt file).
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ConfigError,
  loadPresetCatalog,
  type Preset,
  resolvePreset,
} from "../src/agent/config";
import {
  type LaunchHandleDeps,
  type LaunchPosture,
  launchToResolvedHandle,
} from "../src/agent/launch-handle";
import {
  runShowLastMessage,
  runWaitForStop,
} from "../src/agent/pair-subcommands";
import {
  composeRunCapture,
  type RunCaptureDeps,
} from "../src/agent/run-capture";
import {
  defaultKeeperAgentStateDir,
  defaultTmuxCommandRunner,
  resolveTmuxBin,
  type TmuxCommandRunner,
} from "../src/agent/tmux-launch";
import { ensureCodexDirTrust } from "../src/codex-trust";
import { buildLauncherArgvPrefix } from "../src/keeper-agent-path";
import { runPanel } from "../src/pair/panel";
import {
  assemblePrompt,
  buildPairOutput,
  DEFAULT_PAIR_SESSION,
  loadRolePrompt,
  PAIR_CLIS,
  type PairCli,
  pairOutputYaml,
  resolvePairKeeperAgentPath,
  stopTimeoutMsFromSeconds,
} from "../src/pair-command";

const HELP = `keeper pair — fan a task out to another model CLI via keeper agent

Usage:
  keeper pair send <prompt-file> --preset <name> --output <path> [options]
  keeper pair send <prompt-file> --cli <claude|codex|pi> --output <path> [options]
  keeper pair panel start <prompt-file> [--panel <name>] [--dir <d>] [--timeout <s>]
  keeper pair panel wait --dir <d> [--chunk <s>]
  keeper pair --help

The 'panel' sub-verb fans a question out to a panel of models as detached
read-only legs, then waits for them token-free (start launches + prints a
manifest; wait blocks one chunk + prints the N-of-N verdict). Run
'keeper pair panel --help' for its options.

stdout is the Monitor event channel: exactly one [keeper-pair] started line then
one terminal line (completed/failed). The partner's final answer is written to
--output as YAML (a 'message' field + transcript/session drill-down). Drive this
from your session's Monitor tool: launch it, then do nothing until the terminal
notification, then read --output.

Options:
  --preset <name>        Named launch-config preset from ~/.config/keeper/presets.yaml;
                         drives harness + model/effort. The recommended interface.
                         Must be a real catalog entry (exit 2 otherwise); run
                         \`keeper agent presets list\` to see the configured names.
  --cli <claude|codex|pi>  Partner CLI (required unless --preset given; a
                           compatibility alias whose harness must agree with --preset)
  --model <m>            Native model (claude --model / codex -m)
  --effort <e>           Reasoning effort (codex only)
  --role <r>             Role prompt: default|planner|codereviewer|coplanner
  --read-only            Read-only posture (prepends a directive; prompting-only)
  --output <path>        Write the result YAML here (required)
  --session <s>          Target tmux session for the partner window
  --timeout <s>          Wait timeout in seconds (default 1800)
  --help, -h             Show this help
`;

const DEFAULT_TIMEOUT_SECONDS = 1800;

/**
 * The process-level seams the in-process compose drives, injected so a test can
 * force a tmux launch failure (a canned `runTmuxCommand`) or canned wait/show
 * outcomes without a real subprocess/tmux. The partner launch env (CLAUDE-stripped
 * per CLI) and the codex directory-trust seed are owned by the shared launch
 * helper (`launchToResolvedHandle`), not derived here.
 */
export interface PairSendSeams {
  cwd: string;
  /** Transcript-resolution home (`homedir()`); the wait/show seams read it. */
  homeDir: string;
  tmuxBin: string;
  launcherStateDir: string;
  randomUuid: () => string;
  runTmuxCommand: TmuxCommandRunner;
  now: () => number;
  waitForStop: RunCaptureDeps["waitForStop"];
  showLastMessage: RunCaptureDeps["showLastMessage"];
}

/** The production seam bindings — the real launcher collaborators + wall clock. */
function productionPairSendSeams(): PairSendSeams {
  return {
    cwd: process.cwd(),
    homeDir: homedir(),
    tmuxBin: resolveTmuxBin(process.env),
    launcherStateDir: defaultKeeperAgentStateDir(process.env),
    randomUuid: () => randomUUID(),
    runTmuxCommand: defaultTmuxCommandRunner,
    now: () => Date.now(),
    waitForStop: runWaitForStop,
    showLastMessage: runShowLastMessage,
  };
}

/** Emit one Monitor event line. The event name + key=value fields render in a
 *  stable order so a Monitor regex never has to tolerate reordering. */
function emitEvent(event: string, fields: Record<string, unknown>): void {
  const parts = [`[keeper-pair] ${event}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") {
      continue;
    }
    parts.push(`${k}=${v}`);
  }
  process.stdout.write(`${parts.join(" ")}\n`);
}

export async function main(
  argv: string[],
  seamsOverride: Partial<PairSendSeams> = {},
): Promise<void> {
  // Sub-verb routing: `send` (fan one task to a partner) and `panel` (fan a
  // question to a panel of detached legs + chunked-wait verdict).
  const sub = argv[0];
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    process.stdout.write(HELP);
    process.exit(sub === undefined ? 2 : 0);
  }
  if (sub === "panel") {
    await runPanel(argv.slice(1));
    return;
  }
  if (sub !== "send") {
    process.stderr.write(
      `pair: unknown sub-verb '${sub}' (expected 'send' or 'panel')\n`,
    );
    process.exit(2);
  }

  // Production seams unless a caller (tests) overrides them. Resolved only on the
  // `send` path so `panel` / `--help` never touch the filesystem probes.
  const seams: PairSendSeams = {
    ...productionPairSendSeams(),
    ...seamsOverride,
  };

  const parsed = parseArgs({
    args: argv.slice(1),
    options: {
      preset: { type: "string" },
      cli: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      role: { type: "string", default: "default" },
      "read-only": { type: "boolean", default: false },
      output: { type: "string" },
      session: { type: "string" },
      timeout: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const v = parsed.values;
  const promptFile = parsed.positionals[0];
  const presetName = v.preset;
  const output = v.output;
  const readOnly = v["read-only"] ?? false;

  // ---- resolve the named preset (dep-free registry; no src/db.ts) ----
  // A preset drives the harness (claude-vs-codex orchestration: env strip, reap
  // policy, codex trust-seed) and an optional role; model/effort are NOT read here
  // — they ride to the launcher via `--x-preset` so the launcher owns
  // resolution. A preset-not-found / malformed registry is CLI misuse → exit 2.
  let preset: Preset | undefined;
  if (presetName !== undefined && presetName !== "") {
    try {
      preset = resolvePreset(loadPresetCatalog(), presetName);
    } catch (err) {
      const msg = err instanceof ConfigError ? err.message : String(err);
      process.stderr.write(`pair: ${msg}\n`);
      process.exit(2);
    }
    // claude|codex|pi all pair-launch, so this only guards a harness outside
    // PAIR_CLIS (a hypothetical future kind), never pi.
    if (!PAIR_CLIS.has(preset.harness)) {
      process.stderr.write(
        `pair: preset '${presetName}' pins harness ${preset.harness}, ` +
          "which pairing does not support (claude|codex|pi only)\n",
      );
      process.exit(2);
    }
    // `--cli` is a compatibility alias; a disagreeing harness fails loud.
    if (v.cli !== undefined && v.cli !== preset.harness) {
      process.stderr.write(
        `pair: --cli ${v.cli} disagrees with preset '${presetName}' harness ` +
          `${preset.harness}\n`,
      );
      process.exit(2);
    }
  }

  // Effective harness: the preset's when given, else the legacy `--cli` flag.
  const cli = preset?.harness ?? v.cli;
  // Effective role: explicit `--role` wins; otherwise the preset's role (if any);
  // otherwise the parseArgs "default". An explicit `--role` is detected by it
  // differing from the default sentinel OR the preset carrying no role.
  const explicitRole = v.role !== undefined && v.role !== "default";
  const role = explicitRole ? v.role : (preset?.role ?? v.role ?? "default");

  // Track whether `started` has been emitted so every failure path still pairs
  // a start with its terminal line (the two-line contract never breaks).
  let startedEmitted = false;
  const fail = (error: string, fields: Record<string, unknown> = {}): never => {
    if (!startedEmitted) {
      emitEvent("started", {
        cli: cli ?? "unknown",
        role,
        output: output ?? "",
        preset: presetName,
      });
      startedEmitted = true;
    }
    emitEvent("failed", {
      cli: cli ?? "unknown",
      output: output ?? "",
      error,
      ...fields,
    });
    process.exit(1);
  };

  // ---- argument validation (arg faults → exit 2 BEFORE any started line) ----
  if (promptFile === undefined) {
    process.stderr.write("pair: missing <prompt-file> positional\n");
    process.exit(2);
  }
  if (cli === undefined || !PAIR_CLIS.has(cli)) {
    process.stderr.write(
      `pair: --cli must be claude|codex|pi (got ${cli ?? "none"}) — ` +
        "pass --cli or --preset\n",
    );
    process.exit(2);
  }
  if (output === undefined || output === "") {
    process.stderr.write("pair: --output <path> is required\n");
    process.exit(2);
  }
  const timeoutSeconds =
    v.timeout !== undefined ? Number(v.timeout) : DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    process.stderr.write(
      `pair: --timeout must be a positive number (got ${v.timeout})\n`,
    );
    process.exit(2);
  }
  // keeper's `--timeout` is authoritative for the partner stop wait. Compute the
  // ms budget ONCE so the emitted `--stop-timeout-ms` flag and the kill margin
  // are provably consistent (a fractional `--timeout` rounds up to ms).
  const stopTimeoutMs = stopTimeoutMsFromSeconds(timeoutSeconds);
  if (v.effort !== undefined && cli !== "codex") {
    process.stderr.write("pair: --effort is only supported for codex\n");
    process.exit(2);
  }

  const pairCli = cli as PairCli;
  const cwd = seams.cwd;
  // The launcher argv prefix (`[bun, cli/keeper.ts, "agent"]`) the partner is
  // launched + waited-on + read through — the folded `keeper agent` launcher.
  const launcherArgvPrefix = buildLauncherArgvPrefix(
    process.execPath,
    resolvePairKeeperAgentPath(),
  );

  // Partner tmux session. Partners land in a stable named session (`pair` by
  // default, `panels` for panel legs) and the window STAYS OPEN after the partner
  // stops — keeper closes no windows; the operator garbage-collects them by hand
  // (attach with `tmux attach -t <session>`). keeper agent's race-safe launch lets
  // concurrent partners share a named session without a create race, so a stable
  // name is safe.
  const sessionName = v.session ?? DEFAULT_PAIR_SESSION;

  // SIGTERM handler: a Monitor kills the process when its timeout_ms expires. We
  // MUST still emit a terminal line (so the orchestrating agent never hangs); the
  // partner's tmux window is left open for inspection.
  process.on("SIGTERM", () => {
    if (!startedEmitted) {
      emitEvent("started", { cli, role, output, preset: presetName });
    }
    emitEvent("failed", { cli, output, error: "killed by monitor timeout" });
    process.exit(1);
  });

  // ---- load role prompt + read the user message ----
  const roleResult = loadRolePrompt(role);
  if (!roleResult.ok) {
    return fail(roleResult.error);
  }
  const systemPrompt = roleResult.text;
  let message: string;
  try {
    message = readFileSync(promptFile, "utf8");
  } catch (err) {
    return fail(
      `cannot read prompt file '${promptFile}': ${(err as Error).message}`,
    );
  }

  const prompt = assemblePrompt({
    message,
    systemPrompt,
    readOnly,
  });

  // Emit `started` BEFORE any subprocess work — the orchestrating agent's
  // "do nothing until the terminal notification" directive hinges on seeing
  // this line the moment keeper pair starts running.
  emitEvent("started", {
    cli,
    preset: presetName,
    role,
    output,
    "read-only": readOnly || undefined,
    timeout: timeoutSeconds,
  });
  startedEmitted = true;

  // ---- launch → wait-for-stop → show-last-message, IN-PROCESS ----
  // The launch + capture run in ONE process on a pinned `ResolvedHandle` held
  // locally for the whole turn (`launchToResolvedHandle` drives the tmux launcher
  // directly; `composeRunCapture` then drives the wait/show seams on that handle).
  // Two guards the old cross-process subprocess compose needed are now
  // structurally unnecessary and intentionally dropped:
  //   - the PATH_CEILING_MS+SLOP_MS subprocess-kill margin: there is no `keeper
  //     agent` subprocess to SIGKILL mid-wait — the wait is an in-process await
  //     bounded by `ResolvedHandle.stopTimeoutMs`, so a slow start cannot race it.
  //   - the self-transcript-collision guard: the launch PINS the partner's
  //     transcript session id and the handle is held locally, so the resolver
  //     never falls back to newest-by-mtime onto the driver's own transcript.
  const posture: LaunchPosture = {
    model: v.model,
    effort: v.effort,
    // Partners land in a stable named session (`pair` by default, `panels` for
    // panel legs). Concurrent launches sharing the name are safe: the launcher
    // recovers from the new-session "duplicate session" TOCTOU by adding a window.
    session: sessionName,
    preset: presetName,
  };
  // The shared helper owns the launch-env posture: claude keeps the full env
  // (its `--session-id` pin keeps the partner transcript distinct), codex/pi get
  // `CLAUDE*` stripped. It also fires the codex directory-trust seed before the
  // launch (fail-open). Pass the RAW env; the helper scrubs per agent.
  const launchDeps: LaunchHandleDeps = {
    env: process.env,
    cwd,
    tmuxBin: seams.tmuxBin,
    launcherStateDir: seams.launcherStateDir,
    launcherArgvPrefix,
    randomUuid: seams.randomUuid,
    runTmuxCommand: seams.runTmuxCommand,
    ensureCodexDirTrust,
    now: seams.now,
    writeErr: (s) => {
      process.stderr.write(s);
    },
  };
  const result = await composeRunCapture(
    {
      waitForStop: seams.waitForStop,
      showLastMessage: seams.showLastMessage,
      now: seams.now,
      launch: () =>
        launchToResolvedHandle({
          deps: launchDeps,
          agent: pairCli,
          prompt,
          posture,
          // keeper's `--timeout` is authoritative for the partner stop wait; it
          // rides onto the handle so the in-process wait honors it over the 600s
          // launcher default.
          stopTimeoutMs,
        }),
    },
    // Transcript resolution reads only homeDir + CODEX_HOME/PI_CODING_AGENT_DIR
    // (never `CLAUDE*`), so the raw env is byte-neutral here — no launch-env
    // scrub is needed for resolution.
    { env: process.env, homeDir: seams.homeDir },
    pairCli,
  );

  // ---- map run-capture's outcome → pair's 0/1/2 contract (ONE exhaustive,
  //      `never`-checked boundary; never leak run-capture's 0/4/2 codes) ----
  // completed/no_message run the success tail (exit 0); no_message is a tool-only
  // final turn that old pair always succeeded on. timed_out/no_transcript/
  // launch_failed `fail()` (exit 1) BEFORE any --output file is written, dropping
  // any partial message. bad_args is defensive — pair validates args pre-compose
  // (exit 2 already happened above) — and the `never` default both exit 1.
  const outcome = result.envelope.outcome;
  switch (outcome) {
    case "completed":
    case "no_message":
      break;
    case "timed_out":
      return fail("partner timed out before stopping");
    case "no_transcript":
      return fail("partner produced no transcript");
    case "launch_failed":
      return fail("keeper agent launch failed");
    case "bad_args":
      return fail("keeper agent rejected the launch arguments");
    default: {
      const unreachable: never = outcome;
      return fail(`unexpected run-capture outcome: ${String(unreachable)}`);
    }
  }

  // ---- success tail: buildPairOutput → YAML → atomic temp-write+rename →
  //      completed AFTER the rename → exit 0 ----
  const elapsedSeconds = result.envelope.elapsed_seconds ?? 0;

  const outputObj = buildPairOutput({
    cli: pairCli,
    role,
    message: result.envelope.message,
    transcriptPath: result.envelope.transcript_path,
    handle: result.envelope.handle ?? "",
    elapsedSeconds,
  });
  const yamlText = pairOutputYaml(outputObj);

  // ---- atomic write: temp file in the output's dir, then rename ----
  const outDir = output.includes("/")
    ? output.slice(0, output.lastIndexOf("/")) || "/"
    : ".";
  const tmpPath = join(
    existsSync(outDir) ? outDir : tmpdir(),
    `.keeper-pair-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    writeFileSync(tmpPath, yamlText);
    renameSync(tmpPath, output);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // already gone
    }
    return fail(`cannot write --output '${output}': ${(err as Error).message}`);
  }

  // Emit `completed` AFTER the rename so the agent reads a file guaranteed to be
  // in place the moment it acts on the event.
  emitEvent("completed", {
    cli,
    preset: presetName,
    output,
    "read-only": readOnly || undefined,
    elapsed: Math.round(elapsedSeconds),
  });
  process.exit(0);
}

if (import.meta.main) {
  void main(Bun.argv.slice(2));
}
