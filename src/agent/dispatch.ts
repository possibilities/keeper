/**
 * Subcommand dispatch — the pre-pass that runs before any wrapper logic.
 * `keeper agent` is a subcommand dispatcher. `splitSubcommand` strips exactly ONE
 * leading agent token and hands the rest to the launcher flow, so the composed
 * agent argv stays byte-identical to what the bare launcher produced.
 * `keeper agent claude claude` keeps the second `claude` as a prompt arg; the same
 * contract applies to `codex` and `pi`.
 *
 * Informational flags (`-h`/`--help`, `-v`/`--version`) and the bare/unknown
 * invocation are owned here — they print and exit before `parseArgs` and the
 * passthrough scan ever see the argv.
 */

import pkg from "../../package.json" with { type: "json" };
import { type HarnessName, isHarnessName } from "./harness";

/** A harness `keeper agent` dispatches to — derived from the harness registry so
 *  the name set lives in exactly one place (`src/agent/harness.ts`). */
export type AgentKind = HarnessName;

/** The composable post-launch verbs that read a detached run's transcript. */
export type SubcommandKind = "wait-for-stop" | "show-last-message";

/** Result of the leading-token classification. Discriminated on `kind`. */
export type Dispatch =
  | { kind: "run"; agent: AgentKind; rest: string[] }
  | { kind: "run-preset"; presetName: string; rest: string[] }
  | { kind: "presets-resolve"; presetName: string }
  | { kind: "presets-list"; json: boolean }
  | { kind: "profiles-check"; json: boolean }
  | { kind: "subcommand"; verb: SubcommandKind; rest: string[] }
  // The blocking run-and-capture verbs. `run-capture` composes launch→wait→show
  // in one process; `wait-capture` runs wait→show on an already-launched handle.
  // Both emit the uniform run-capture envelope. Named distinctly from the `run`
  // kind (the agent-launch) — the leading token is `run` / `wait`.
  | { kind: "run-capture"; rest: string[] }
  | { kind: "wait-capture"; rest: string[] }
  // The panel fan-out sub-verb (`start|wait|status|prune`). Routes into
  // `runPanel`; `rest` carries the operation + its flags, which `runPanel` owns
  // (self-emits + owns its code).
  | { kind: "panel"; rest: string[] }
  | { kind: "help" }
  | { kind: "help-wrapper" }
  | { kind: "version" }
  | { kind: "usage"; unknown?: string };

/** The wrapper-owned help flag, consumed before passthrough and launch. */
export const KEEPER_AGENT_HELP_FLAG = "--x-help";

/** True when argv contains the wrapper-owned `--x-help` flag. */
export function hasKeeperAgentHelpFlag(argv: string[]): boolean {
  return argv.includes(KEEPER_AGENT_HELP_FLAG);
}

/** Top-level help/usage text. */
export const USAGE = `keeper agent — launch agent CLIs with keeper agent routing and startup defaults.

Usage:
  keeper agent claude [args...]        Launch Claude Code.
  keeper agent codex [args...]         Launch Codex CLI.
  keeper agent pi [args...]            Launch pi.
  keeper agent hermes [args...]        Launch Hermes (Nous Research).
  keeper agent --x-preset <name> [args...]
                                    Launch the preset's harness (harnessless).
  keeper agent presets resolve <name>  Emit the resolved preset/panel JSON.
  keeper agent presets list [--json]   List configured presets + panels.
  keeper agent profiles check [--json] Report shadow/stray dirs + a ~/.claude whose
                                    tier metadata is missing (read-only).
  keeper agent wait-for-stop <handle> [--stop-timeout <dur>]
                                    Block until a detached run's next stop.
  keeper agent show-last-message <h>   Print a detached run's final message.
  keeper agent run <cli> <prompt> [--read-only] [--stop-timeout <dur>]
                                  [--system-file <path> | --system <text>]
                                  [--preset <name>] [--session <name>]
                                  [--output <path>]
                                    Launch, wait, and capture in one process;
                                    emit the uniform run-capture JSON envelope.
                                    --read-only prepends a directive (prompting-only).
                                    --system-file/--system prepend a caller-side
                                    System: block (uniform across harnesses).
                                    --preset applies a launch-config preset (its
                                    harness must == <cli>); --session names the
                                    tmux grouping; --output atomically writes the
                                    envelope to a file on every outcome.
  keeper agent wait <handle> [--stop-timeout <dur>]
                                    Wait + capture on an existing handle; emit
                                    the same uniform envelope.
  keeper agent panel start <prompt-file> --slug <slug> [--panel <name>] [--dir <d>] [--timeout <s>]
  keeper agent panel wait   (--slug <slug> | --dir <d>) [--chunk <s>]
  keeper agent panel status (--slug <slug> | --dir <d>)
  keeper agent panel prune
                                    Fan a question to a panel of detached
                                    read-only run legs (members from a configured
                                    --panel <name>), then wait for them token-free.
                                    --slug is REQUIRED on start — each leg launches
                                    as panel::<slug>::<preset>. start is idempotent
                                    by slug (reconciles on re-issue); wait/status
                                    address a run by --slug or --dir. status prints
                                    a non-blocking per-leg snapshot; prune GCs
                                    abandoned run dirs. Exit 0 all-terminal / 124
                                    chunk-elapsed / 2 absent-slug-or-bad-config.
  keeper agent --help                  Show this help.
  keeper agent --version               Show the version.

keeper agent transport flags such as --x-tmux are consumed by the wrapper;
all other args after the agent subcommand pass through to that launcher unchanged.
A detached launch (--x-tmux --x-tmux-detached) prints a JSON
handle; pass its "id" (or a transcript path) to wait-for-stop / show-last-message.
`;

/** Version string, sourced from package.json. */
export const VERSION = `keeper agent ${(pkg as { version: string }).version}\n`;

/**
 * Wrapper-owned overlay help. Documents only the `--x-*` surface the
 * wrapper consumes — common flags, the tmux transport flags, and the
 * agent-specific wrapper flag. Native agent flags are NOT listed here; reach a
 * launcher's own help with `keeper agent <agent> --help`.
 */
export const KEEPER_AGENT_HELP = `keeper agent — launch agent CLIs with keeper agent routing and startup defaults.

Usage:
  keeper agent claude [args...]   Launch Claude Code.
  keeper agent codex [args...]    Launch Codex CLI.
  keeper agent pi [args...]       Launch pi.
  keeper agent hermes [args...]   Launch Hermes (Nous Research).

The flags below are consumed by the wrapper; every other arg after the agent
subcommand passes through to that launcher unchanged. For a launcher's own
options, run \`keeper agent <agent> --help\`.

Wrapper flags:
  --x-help                  Show this wrapper help and exit.
  --x-verbose               Print one line per startup section.
  --x-very-verbose          Add per-phase timing and the composed
                                    agent command. Implies --x-verbose.
  --x-no-confirm            Skip the cwd-confirmation prompt.
  --x-profile <name>        Select a profile ('default' = native
                                    account; 'auto' picks via the ledger).
  --x-preset <name>         Apply a named launch-config preset from
                                    presets.yaml (harness/model/effort BELOW any
                                    explicit --model/--effort or effort env).
                                    With no agent token the harness comes from
                                    the preset; with one, a disagreeing harness
                                    is rejected. A fresh launch with no --x-preset
                                    resolves the harness <harness>_default pointer
                                    instead; one that resolves neither (and is
                                    not both --model + --effort/--thinking) is
                                    fail-loud (exit 2). Run
                                    \`keeper agent presets list\` for the names.

Preset resolution:
  keeper agent presets resolve <name>  Emit the resolved JSON for a single preset
                                    ({name,harness,model,effort|thinking,role})
                                    or a panel (an ordered array of
                                    {name,harness} members).
  keeper agent presets list [--json]   List the configured catalog presets
                                    (name + harness/model/effort) and panels.

Profile diagnostics:
  keeper agent profiles check [--json] List shadow/stray/auth-bearing
                                    ~/.claude-profiles + ~/.pi-profiles dirs,
                                    plus a ~/.claude that is authed but whose
                                    tier metadata is missing (renders ?x in
                                    usage) — read-only, NEVER moves or deletes.
                                    Each finding carries a stable id +
                                    remediation. Exit 0 clean / 9 findings /
                                    1 tool error.

tmux transport flags (any one implies tmux mode):
  --x-tmux                  Open the invocation in a new tmux window.
  --x-tmux-detached         Create the window without moving focus.
  --x-tmux-session <name>   Target/create the named tmux session.
  --x-tmux-window-name <n>  Name the created tmux window.
  --x-tmux-socket-name <n>  tmux server socket name (-L).
  --x-tmux-socket-path <p>  tmux server socket path (-S).
  --x-tmux-env KEY=VALUE    Inject env into the pane via tmux -e
                                    (repeatable; LD_*/DYLD_* keys rejected).
  --no-artifacts                    Suppress the launch.sh/run.json run-dir
                                    trail; JSON result carries runDir:null.

Post-launch transcript subcommands (composable with a detached launch):
  keeper agent wait-for-stop <handle> [--stop-timeout <dur>]
                                        Block until the run's next stop event.
                                        --stop-timeout overrides the 600s
                                        stop-wait ceiling (duration, unit
                                        required: e.g. 500ms, 30s, 10m).
  keeper agent show-last-message <handle>  Print the run's final assistant message.
                                        <handle> is the launch JSON's id (or a
                                        transcript path with --agent <kind>).

Blocking run-and-capture verbs (one uniform schema-versioned JSON envelope):
  keeper agent run <cli> <prompt> [--read-only] [--stop-timeout <dur>]
                                  [--system-file <path> | --system <text>]
                                  [--preset <name>] [--session <name>]
                                  [--output <path>]
                                        Launch <cli> detached, wait for its stop,
                                        and capture the final message — all in one
                                        process. --read-only prepends a read-only
                                        directive to the prompt — prompting-only,
                                        keeper enforces nothing (no tool strip, no
                                        changed-files audit). --system-file/--system compose a
                                        caller-side System:-prepend into the prompt
                                        (mutually exclusive; missing file → bad_args),
                                        UNIFORM across claude/codex/pi — user-turn
                                        text, NOT a privileged system prompt. codex/pi
                                        launch with CLAUDE* env stripped by default
                                        (partner isolation). --preset applies a named
                                        launch-config preset (its resolved harness
                                        must == <cli>, else bad_args); --session
                                        names the tmux session grouping (rides as
                                        --x-tmux-session, NOT the transcript id);
                                        --output atomically writes the SAME envelope
                                        to <path> (temp+rename) on every outcome, in
                                        addition to stdout.
                                        Emits the uniform envelope
                                        {schema_version, agent, handle,
                                        transcript_path, resume_target, message,
                                        message_found, elapsed_seconds, outcome};
                                        outcome ∈ completed|no_message (exit 0) /
                                        timed_out|no_transcript|transcript_ambiguous
                                        (4) / launch_failed (1) / bad_args (2).
                                        codex's resume_target is discovered from its
                                        rollout file post-stop; claude/pi's from the
                                        session id pinned at launch. transcript_
                                        ambiguous means a concurrent same-cwd codex
                                        session collided and the leg refused to guess
                                        a foreign transcript.
  keeper agent wait <handle> [--stop-timeout <dur>]
                                        Wait + capture on an already-launched
                                        handle (a run id or a transcript path with
                                        --agent <kind>); same uniform envelope.

Panel fan-out (start | wait | status | prune):
  keeper agent panel start <prompt-file> --slug <slug> [--panel <name>] [--dir <d>] [--timeout <s>]
  keeper agent panel wait   (--slug <slug> | --dir <d>) [--chunk <s>]
  keeper agent panel status (--slug <slug> | --dir <d>)
  keeper agent panel prune
                                        Fan a question to a panel of models as
                                        detached read-only \`keeper agent run\`
                                        legs, then wait for them token-free.
                                        Members come from a configured --panel
                                        <name> (a panel.yaml panel or a single
                                        catalog preset). --slug is REQUIRED on start
                                        — each leg launches as panel::<slug>::<preset>
                                        and the run lives at the durable slug-keyed
                                        ~/.local/state/keeper/panels/<slug>/. start
                                        is idempotent by slug: re-issuing the same
                                        line RECONCILES (reuse terminal legs, leave
                                        running, relaunch no-result), never a blind
                                        re-fan-out. wait/status address a run by
                                        --slug (or --dir; --dir wins). wait blocks
                                        ONE --chunk window + prints the N-of-N
                                        verdict; status prints a non-blocking per-leg
                                        snapshot (completed|running|failed|absent);
                                        prune GCs abandoned run dirs (lock-free, no
                                        live pid, past TTL). Exit 0 = all legs
                                        terminal (key off the verdict's 'ok' flag,
                                        NOT the code), 124 = chunk elapsed (re-issue
                                        it), 2 = an absent/empty --slug, a
                                        missing/corrupt manifest, or bad config.

tmux-mode exit codes (a structured JSON error is emitted on every non-zero exit):
  0  success                        2  bad args
  1  internal/parse failure         3  prerequisite missing (tmux/session not found)
                                    4  transient/retryable (timeout, lock contention)

Agent-specific wrapper flags:
  --x-codex-session-name <name>
                                    Index this synthetic name for the Codex
                                    session once its live id is known.

Top-level flags:
  --help, -h                        Show short usage.
  --version, -v                     Show the version.
`;

/**
 * Classify the leading argv token. `claude`/`codex`/`pi` → run with the remaining
 * args (even when empty, so a bare `keeper agent claude`, `keeper agent codex`, or `keeper agent pi`
 * still launches interactively); a leading `--x-preset <name>` (no head
 * agent token) → the harnessless run-preset form whose harness comes from the
 * preset (the whole argv stays in `rest` so parseArgs strips the flag);
 * `presets resolve <name>` → emit the resolved preset/panel JSON;
 * `wait-for-stop`/`show-last-message` → the
 * post-launch transcript verbs with the remaining args (the handle); `run`/`wait`
 * → the blocking run-and-capture verbs (launch→wait→show in one process, and
 * wait→show on an existing handle) emitting the uniform envelope; `--x-help`
 * → wrapper help; `-h`/`--help` → short usage; `-v`/`--version` → version; an empty
 * argv or any other leading token → usage (carrying the unknown subcommand name when
 * present). Strips exactly one token so a repeated agent name preserves the second.
 * When the wrapper-help flag follows an agent token it lands in `rest`; main()
 * detects it there before passthrough and launch.
 */
export function splitSubcommand(argv: string[]): Dispatch {
  const head = argv[0];
  if (head === undefined) {
    return { kind: "usage" };
  }
  if (isHarnessName(head)) {
    return { kind: "run", agent: head, rest: argv.slice(1) };
  }
  if (head === "presets") {
    if (argv[1] === "resolve") {
      const presetName = argv[2];
      if (presetName === undefined || presetName.trim() === "") {
        return { kind: "usage", unknown: "presets resolve" };
      }
      return { kind: "presets-resolve", presetName: presetName.trim() };
    }
    if (argv[1] === "list") {
      return { kind: "presets-list", json: argv.slice(2).includes("--json") };
    }
    return { kind: "usage", unknown: `presets ${argv[1] ?? ""}`.trim() };
  }
  if (head === "profiles") {
    if (argv[1] === "check") {
      return { kind: "profiles-check", json: argv.slice(2).includes("--json") };
    }
    return { kind: "usage", unknown: `profiles ${argv[1] ?? ""}`.trim() };
  }
  if (head === "--x-preset" || head.startsWith("--x-preset=")) {
    // Harnessless launch: harness comes from the named preset. Keep the WHOLE
    // argv in `rest` so parseArgs strips the flag and main() resolves it.
    const presetName =
      head === "--x-preset"
        ? (argv[1] ?? "").trim()
        : head.slice("--x-preset=".length).trim();
    if (presetName === "") {
      return { kind: "usage", unknown: "--x-preset" };
    }
    return { kind: "run-preset", presetName, rest: argv };
  }
  if (head === "wait-for-stop" || head === "show-last-message") {
    return { kind: "subcommand", verb: head, rest: argv.slice(1) };
  }
  if (head === "run") {
    return { kind: "run-capture", rest: argv.slice(1) };
  }
  if (head === "wait") {
    return { kind: "wait-capture", rest: argv.slice(1) };
  }
  if (head === "panel") {
    return { kind: "panel", rest: argv.slice(1) };
  }
  if (head === KEEPER_AGENT_HELP_FLAG) {
    return { kind: "help-wrapper" };
  }
  if (head === "-h" || head === "--help") {
    return { kind: "help" };
  }
  if (head === "-v" || head === "--version") {
    return { kind: "version" };
  }
  return { kind: "usage", unknown: head };
}
