#!/usr/bin/env bun
/**
 * `keeper pair send` — fan a task out to another model CLI (claude / codex) via
 * the in-binary `keeper agent` launcher, driven from the orchestrating session's
 * Monitor tool. Owns the pairing ergonomics, delegating the tmux transport +
 * model/effort selection to `keeper agent`.
 *
 * STDOUT IS THE MONITOR EVENT CHANNEL. Every run emits exactly one
 * `[keeper-pair] started ...` line followed by exactly one terminal line —
 * either `[keeper-pair] completed ...` (exit 0) or `[keeper-pair] failed ...`
 * (exit non-zero). The full result YAML is written to `--output`; stdout carries
 * ONLY the event stream. The two-line contract holds on EVERY path, including
 * SIGTERM/timeout (a Monitor kill) and early validation errors.
 *
 * Compose flow (the `keeper agent` subcommand contract):
 *   1. `keeper agent <cli> --agentwrap-tmux --agentwrap-tmux-detached
 *      --agentwrap-no-confirm <native flags> <prompt>` → launch JSON `id`.
 *   2. `keeper agent wait-for-stop <id> --stop-timeout-ms <ms>` → block until the
 *      partner stops; keeper's `--timeout` drives the ms budget (overriding
 *      the subcommand's 600s default) and the widened subprocess-kill margin.
 *   3. `keeper agent show-last-message <id>` → the partner's final message.
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
  ConfigError,
  loadPresetRegistry,
  type Preset,
  resolvePreset,
} from "../src/agent/config";
import { ensureCodexDirTrust } from "../src/codex-trust";
import { resolveConfig } from "../src/db";
import { buildLauncherArgvPrefix } from "../src/keeper-agent-path";
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
  resolveDisableAutoclose,
  resolvePairKeeperAgentPath,
  stopTimeoutMsFromSeconds,
  stripClaudeEnv,
} from "../src/pair-command";

const HELP = `keeper pair — fan a task out to another model CLI via keeper agent

Usage:
  keeper pair send <prompt-file> --preset <name> --output <path> [options]
  keeper pair send <prompt-file> --cli <claude|codex> --output <path> [options]
  keeper pair --help

stdout is the Monitor event channel: exactly one [keeper-pair] started line then
one terminal line (completed/failed). The partner's final answer is written to
--output as YAML (a 'message' field + transcript/session drill-down). Drive this
from your session's Monitor tool: launch it, then do nothing until the terminal
notification, then read --output.

Options:
  --preset <name>        Named launch-config preset (~/.config/agentwrap/presets.yaml);
                         drives harness + model/effort. The recommended interface.
  --cli <claude|codex>   Partner CLI (required unless --preset given; a
                         compatibility alias whose harness must agree with --preset)
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

// Subprocess-kill margin over the stop-wait budget. agentwrap runs its ≤30s
// path-discovery wait SEQUENTIALLY before the stop-wait clock starts, so its
// worst-case clean (retryable exit-4) return is ~`stopTimeoutMs + 30s`. The kill
// MUST sit strictly above that, or a slow start SIGKILLs agentwrap mid-wait —
// yielding a raw `waitRes === null` "killed" instead of the clean retryable exit.
// PATH_CEILING_MS mirrors agentwrap's `DEFAULT_PATH_TIMEOUT_MS` (loose coupling,
// NOT a cross-repo import): a future bump there prompts a glance here.
const PATH_CEILING_MS = 30_000;
const SLOP_MS = 5_000;

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
  // — they ride to the launcher via `--agentwrap-preset` so the launcher owns
  // resolution. A preset-not-found / malformed registry is CLI misuse → exit 2.
  let preset: Preset | undefined;
  if (presetName !== undefined && presetName !== "") {
    try {
      preset = resolvePreset(loadPresetRegistry(), presetName);
    } catch (err) {
      const msg = err instanceof ConfigError ? err.message : String(err);
      process.stderr.write(`pair: ${msg}\n`);
      process.exit(2);
    }
    // PairCli excludes pi: a preset pinning pi handed to pair fails loud.
    if (!PAIR_CLIS.has(preset.harness)) {
      process.stderr.write(
        `pair: preset '${presetName}' pins harness ${preset.harness}, ` +
          "which pairing does not support (claude|codex only)\n",
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
      `pair: --cli must be claude|codex (got ${cli ?? "none"}) — ` +
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
  const cwd = process.cwd();
  // The launcher argv prefix (`[bun, cli/keeper.ts, "agent"]`) the partner is
  // launched + waited-on + read through — the folded `keeper agent` launcher.
  const launcherArgvPrefix = buildLauncherArgvPrefix(
    process.execPath,
    resolvePairKeeperAgentPath(),
  );

  // Partner tmux session + autoclose policy. The window-kill is split by CLI:
  //   - claude launches as a tracked interactive TUI job (the `KEEPER_TMUX_SESSION`
  //     carrier), so the DAEMON reaper's managed-session arm (task .2) owns its
  //     autoclose past the idle grace. The CLI NEVER synchronously reaps a claude
  //     window — doing so would race the answer-capture against the kill.
  //   - codex/pi fire no keeper hooks → they never become tracked jobs → the
  //     daemon cannot reap them, so the CLI keeps the synchronous reap here.
  // Either way a session listed in `disable-autoclose` (the ONE knob, shared with
  // the daemon arm via `resolveConfig().disableAutoclose`; default EMPTY) is left
  // open + interactive for inspection — attach with `tmux attach -t <session>`.
  // agentwrap's race-safe launch lets concurrent partners share a named session
  // without a create race, so a stable name is safe.
  const sessionName = v.session ?? DEFAULT_PAIR_SESSION;
  const isAutocloseDisabled = resolveDisableAutoclose(
    resolveConfig().disableAutoclose,
  );
  const shouldReap = pairCli !== "claude" && !isAutocloseDisabled(sessionName);

  // SIGTERM handler: a Monitor kills the process when its timeout_ms expires. We
  // MUST still emit a terminal line (so the orchestrating agent never hangs) AND
  // reap the partner's tmux window when `shouldReap` holds (codex/pi only — a
  // claude window is the daemon reaper's to autoclose). The pane id is captured
  // into `reapPaneId` the moment the launch JSON is parsed.
  let reapPaneId: string | null = null;
  const reap = (): void => {
    if (shouldReap) {
      killWindow(reapPaneId);
    }
  };
  process.on("SIGTERM", () => {
    reap();
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

  // Partner env. The CLAUDE path launches as an INTERACTIVE TUI bound into the
  // `jobs` projection (the `KEEPER_TMUX_SESSION` carrier in the launch argv): it
  // KEEPS the inherited env so agentwrap's own `--session-id` pin — not an env
  // scrub — is what keeps the partner transcript distinct from the driver's; the
  // self-collision guard below still backstops the resolver. codex fires no
  // keeper hooks and stays headless, so it keeps the CLAUDE* env strip that
  // prevents the orchestrator's identity from leaking into the partner pane.
  const env =
    pairCli === "claude"
      ? (Object.fromEntries(
          Object.entries(process.env).filter(([, val]) => val !== undefined),
        ) as Record<string, string>)
      : stripClaudeEnv(process.env as Record<string, string | undefined>);

  // Read-only backstop: snapshot the tree in the partner's cwd BEFORE the
  // partner can run (i.e. before the launch), so a write the partner makes
  // during its detached turn shows up against this baseline. `after` is taken
  // once the partner has stopped; the diff is the changed-files set. Detection,
  // not prevention — the directive + tool strip are the guards (see module doc).
  const beforeSnapshot = readOnly ? gitSnapshot(cwd) : null;

  // codex launches as an interactive TUI, which would hang on codex's
  // "Do you trust the contents of this directory?" prompt in a never-trusted cwd.
  // Pre-seed the cwd's per-directory trust into codex's own config dir. Fail-open
  // by contract (never throws, never blocks): if it can't seed, codex merely
  // re-prompts and the wait-for-stop timeout reaps the window — never worse than
  // the headless past. claude fires no trust prompt, so this is codex-only.
  if (pairCli === "codex") {
    ensureCodexDirTrust({ cwd, env: process.env });
  }

  // ---- 1. launch the partner detached ----
  const launchArgv = buildPairLaunchArgv({
    launcherArgvPrefix,
    cli: pairCli,
    prompt,
    readOnly,
    ...(presetName !== undefined && presetName !== ""
      ? { preset: presetName }
      : {}),
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
      `agentwrap launch produced no result (bad launcher '${launcherArgvPrefix.join(" ")}'?)`,
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
  // keeper's `--timeout` drives `--stop-timeout-ms` (agentwrap's stop-wait budget,
  // overriding its 600s default) AND a widened subprocess-kill margin sitting
  // strictly above agentwrap's worst-case clean return (stop budget + ≤30s path
  // discovery + slop) so a slow agentwrap start never gets SIGKILLed mid-wait.
  const waitRes = runAgentwrap(
    buildWaitForStopArgv(launcherArgvPrefix, handle, stopTimeoutMs),
    env,
    cwd,
    stopTimeoutMs + PATH_CEILING_MS + SLOP_MS,
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
    buildShowLastMessageArgv(launcherArgvPrefix, handle),
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
  // for the codex/pi path (for a claude partner `reap` is a no-op — the daemon
  // reaper owns its autoclose — and a `disable-autoclose` session likewise stays
  // open + interactive for inspection).
  reap();

  // Self-collision guard (defense-in-depth behind the agentwrap session-id pin):
  // if the resolver fell back to newest-by-mtime and won the DRIVER's own
  // concurrently-written transcript, never surface that as a `completed` carrying
  // a bogus answer — fail loud. The driver's session id is read straight off the
  // orchestrator's OWN process env (always present here, independent of whatever
  // env the partner pane inherited).
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
    preset: presetName,
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
