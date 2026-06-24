#!/usr/bin/env bun
/**
 * `keeper pair send` — fan a task out to another model CLI (claude / codex) via
 * agentwrap, driven from the orchestrating session's Monitor tool. Owns the
 * pairing ergonomics, delegating the tmux transport + model/effort selection to
 * agentwrap.
 *
 * STDOUT IS THE MONITOR EVENT CHANNEL. Every run emits exactly one
 * `[keeper-pair] started ...` line followed by exactly one terminal line —
 * either `[keeper-pair] completed ...` (exit 0) or `[keeper-pair] failed ...`
 * (exit non-zero). The full result YAML is written to `--output`; stdout carries
 * ONLY the event stream. The two-line contract holds on EVERY path, including
 * SIGTERM/timeout (a Monitor kill) and early validation errors.
 *
 * Compose flow (the agentwrap subcommand contract from task .1):
 *   1. `agentwrap <cli> --agentwrap-tmux --agentwrap-tmux-detached
 *      --agentwrap-no-confirm <native flags> <prompt>` → launch JSON `id`.
 *   2. `agentwrap wait-for-stop <id> --stop-timeout-ms <ms>` → block until the
 *      partner stops; keeper's `--timeout` drives the ms budget (overriding
 *      agentwrap's 600s default) and the widened subprocess-kill margin.
 *   3. `agentwrap show-last-message <id>` → the partner's final message.
 * The partner's final answer is written to `--output` (YAML) via
 * write-temp-then-rename, and `completed` is emitted only AFTER the rename so
 * the Monitor event never points at a half-written file.
 *
 * Read-only posture is layered: the directive (primary) + the per-CLI tool strip
 * (claude `--disallowed-tools`; codex keeps web search) + a git changed-files
 * snapshot taken IN THE PARTNER'S CWD around the wait → `read_only_violation`
 * (detection, not prevention).
 *
 * Exit taxonomy: 0 = completed; 1 = failed (launch/wait/show error, SIGTERM,
 * timeout); 2 = arg fault (bad flags, missing prompt file).
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  assemblePrompt,
  buildPairLaunchArgv,
  buildPairOutput,
  buildShowLastMessageArgv,
  buildWaitForStopArgv,
  DEFAULT_PAIR_SESSION,
  diffGitSnapshots,
  isSelfTranscriptCollision,
  loadRolePrompt,
  PAIR_CLIS,
  type PairCli,
  pairOutputYaml,
  parseGitPorcelain,
  parsePairLaunchJson,
  parseShowLastMessageJson,
  resolvePairAgentwrapPath,
  resolvePairPersistSessions,
  stripClaudeEnv,
} from "../src/pair-command";

const HELP = `keeper pair — fan a task out to another model CLI via agentwrap

Usage:
  keeper pair send <prompt-file> --cli <claude|codex> --output <path> [options]
  keeper pair --help

stdout is the Monitor event channel: exactly one [keeper-pair] started line then
one terminal line (completed/failed). The partner's final answer is written to
--output as YAML (a 'message' field + transcript/session drill-down). Drive this
from your session's Monitor tool: launch it, then do nothing until the terminal
notification, then read --output.

Options:
  --cli <claude|codex>   Partner CLI (required)
  --model <m>            Native model (claude --model / codex -m)
  --effort <e>           Reasoning effort (codex only)
  --role <r>             Role prompt: default|planner|codereviewer|coplanner
  --read-only            Read-only posture (directive + tool strip + git backstop)
  --output <path>        Write the result YAML here (required)
  --session <s>          Target tmux session for the partner window
  --timeout <s>          Wait timeout in seconds (default 1800)
  --help, -h             Show this help
`;

const DEFAULT_TIMEOUT_SECONDS = 1800;

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

/** Capture a `git status --porcelain` snapshot in `cwd`, or null when not a git
 *  repo / git unavailable (the read-only backstop degrades to "no detection"). */
function gitSnapshot(cwd: string): Set<string> | null {
  try {
    const res = Bun.spawnSync(["git", "status", "--porcelain"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (res.exitCode !== 0) {
      return null;
    }
    return parseGitPorcelain(res.stdout.toString());
  } catch {
    return null;
  }
}

/** Run an agentwrap subcommand, returning the captured stdout + exit code, or
 *  null on a spawn failure (ENOENT / kill). Env is the CLAUDE-stripped partner
 *  env; cwd is the partner's target repo. */
function runAgentwrap(
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs?: number,
): { exitCode: number; stdout: string; stderr: string } | null {
  try {
    const res = Bun.spawnSync(argv, {
      env,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
    return {
      exitCode: res.exitCode,
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
    };
  } catch {
    return null;
  }
}

/** Best-effort tmux window reap by pane id. Never throws. */
function killWindow(paneId: string | null): void {
  if (paneId === null || paneId === "") {
    return;
  }
  try {
    Bun.spawnSync(["tmux", "kill-window", "-t", paneId], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // Best-effort — the window may already be gone.
  }
}

export async function main(argv: string[]): Promise<void> {
  // Sub-verb routing: only `send` is supported today.
  const sub = argv[0];
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    process.stdout.write(HELP);
    process.exit(sub === undefined ? 2 : 0);
  }
  if (sub !== "send") {
    process.stderr.write(`pair: unknown sub-verb '${sub}' (expected 'send')\n`);
    process.exit(2);
  }

  const parsed = parseArgs({
    args: argv.slice(1),
    options: {
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
  const cli = v.cli;
  const output = v.output;
  const role = v.role ?? "default";
  const readOnly = v["read-only"] ?? false;

  // Track whether `started` has been emitted so every failure path still pairs
  // a start with its terminal line (the two-line contract never breaks).
  let startedEmitted = false;
  const fail = (error: string, fields: Record<string, unknown> = {}): never => {
    if (!startedEmitted) {
      emitEvent("started", {
        cli: cli ?? "unknown",
        role,
        output: output ?? "",
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
      `pair: --cli must be claude|codex (got ${cli ?? "none"})\n`,
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
  if (v.effort !== undefined && cli !== "codex") {
    process.stderr.write("pair: --effort is only supported for codex\n");
    process.exit(2);
  }

  const pairCli = cli as PairCli;
  const cwd = process.cwd();
  const agentwrapPath = resolvePairAgentwrapPath();

  // Partner tmux session + autoclose policy. A partner whose session opts out of
  // autoclose (default-exempt: `panels` / `pair`) is left open + interactive for
  // inspection — attach with `tmux attach -t <session>`; every other session is
  // autoclosed, its window reaped once we have the answer (and on any failure /
  // timeout path). agentwrap's race-safe launch lets concurrent partners share a
  // named session without a create race, so a stable name is safe.
  const sessionName = v.session ?? DEFAULT_PAIR_SESSION;
  const shouldReap = !resolvePairPersistSessions().has(sessionName);

  // SIGTERM handler: a Monitor kills the process when its timeout_ms expires. We
  // MUST still emit a terminal line (so the orchestrating agent never hangs) AND
  // reap the partner's tmux window unless its session opts out of autoclose. The
  // pane id is captured into `reapPaneId` the moment the launch JSON is parsed.
  let reapPaneId: string | null = null;
  const reap = (): void => {
    if (shouldReap) {
      killWindow(reapPaneId);
    }
  };
  process.on("SIGTERM", () => {
    reap();
    if (!startedEmitted) {
      emitEvent("started", { cli, role, output });
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
    role,
    output,
    "read-only": readOnly || undefined,
    timeout: timeoutSeconds,
  });
  startedEmitted = true;

  const env = stripClaudeEnv(process.env as Record<string, string | undefined>);

  // Read-only backstop: snapshot the tree in the partner's cwd BEFORE the
  // partner can run (i.e. before the launch), so a write the partner makes
  // during its detached turn shows up against this baseline. `after` is taken
  // once the partner has stopped; the diff is the changed-files set. Detection,
  // not prevention — the directive + tool strip are the guards (see module doc).
  const beforeSnapshot = readOnly ? gitSnapshot(cwd) : null;

  // ---- 1. launch the partner detached ----
  const launchArgv = buildPairLaunchArgv({
    agentwrapPath,
    cli: pairCli,
    prompt,
    readOnly,
    ...(v.model !== undefined ? { model: v.model } : {}),
    ...(v.effort !== undefined ? { effort: v.effort } : {}),
    // Partners land in a stable named session (`pair` by default, `panels` for
    // panel legs). Concurrent launches sharing the name are safe: agentwrap's
    // launch recovers from the new-session "duplicate session" TOCTOU by adding a
    // window to the now-existing session.
    session: sessionName,
  });
  const startMs = Date.now();
  const launchRes = runAgentwrap(launchArgv, env, cwd);
  if (launchRes === null) {
    return fail(
      `agentwrap launch produced no result (bad path '${agentwrapPath}'?)`,
    );
  }
  if (launchRes.exitCode !== 0) {
    return fail(
      `agentwrap launch exited ${launchRes.exitCode}: ${launchRes.stderr.trim()}`,
    );
  }
  const launchParse = parsePairLaunchJson(launchRes.stdout);
  if (!launchParse.ok) {
    return fail(launchParse.error);
  }
  const handle = launchParse.handle.id;
  reapPaneId = launchParse.handle.paneId;

  // ---- 2. wait for the partner to stop ----
  const waitRes = runAgentwrap(
    buildWaitForStopArgv(agentwrapPath, handle),
    env,
    cwd,
    timeoutSeconds * 1000,
  );
  if (waitRes === null || waitRes.exitCode !== 0) {
    reap();
    const detail =
      waitRes === null
        ? "spawn failed / killed"
        : `exit ${waitRes.exitCode}: ${waitRes.stderr.trim()}`;
    return fail(`agentwrap wait-for-stop failed (${detail})`);
  }

  // ---- 3. read the partner's final message ----
  const showRes = runAgentwrap(
    buildShowLastMessageArgv(agentwrapPath, handle),
    env,
    cwd,
  );
  if (showRes === null || showRes.exitCode !== 0) {
    reap();
    const detail =
      showRes === null
        ? "spawn failed / killed"
        : `exit ${showRes.exitCode}: ${showRes.stderr.trim()}`;
    return fail(`agentwrap show-last-message failed (${detail})`);
  }
  const showParse = parseShowLastMessageJson(showRes.stdout);
  if (!showParse.ok) {
    reap();
    return fail(showParse.error);
  }

  // The partner has stopped and we have the message; autoclose its window now
  // (unless its session opted out, in which case `reap` is a no-op and the
  // window stays open + interactive for inspection).
  reap();

  // Self-collision guard (defense-in-depth behind the agentwrap session-id pin):
  // if the resolver fell back to newest-by-mtime and won the DRIVER's own
  // concurrently-written transcript, never surface that as a `completed` carrying
  // a bogus answer — fail loud. Read the driver's session id from the orchestrator
  // env (before stripClaudeEnv scrubbed it for the partner).
  if (
    isSelfTranscriptCollision(
      showParse.result.transcriptPath,
      process.env.CLAUDE_CODE_SESSION_ID,
    )
  ) {
    return fail("self-transcript-collision");
  }

  const afterSnapshot = readOnly ? gitSnapshot(cwd) : null;
  const changedFiles = diffGitSnapshots(beforeSnapshot, afterSnapshot);
  const elapsedSeconds = (Date.now() - startMs) / 1000;

  if (readOnly && changedFiles.length > 0) {
    process.stderr.write(
      `[keeper-pair] WARNING: read-only run reported ${changedFiles.length} changed file(s); ` +
        `the sandbox may have been bypassed: ${changedFiles.join(", ")}\n`,
    );
  }

  const outputObj = buildPairOutput({
    cli: pairCli,
    role,
    message: showParse.result.message,
    readOnly,
    changedFiles,
    transcriptPath: showParse.result.transcriptPath,
    handle,
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
    output,
    "read-only": readOnly || undefined,
    changed: changedFiles.length > 0 ? changedFiles.length : undefined,
    elapsed: Math.round(elapsedSeconds),
  });
  process.exit(0);
}

if (import.meta.main) {
  void main(Bun.argv.slice(2));
}
