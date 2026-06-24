/**
 * Subcommand dispatch — the pre-pass that runs before any wrapper logic.
 * `agentwrap` is a subcommand dispatcher. `splitSubcommand` strips exactly ONE
 * leading agent token and hands the rest to the launcher flow, so the composed
 * agent argv stays byte-identical to what the bare launcher produced.
 * `agentwrap claude claude` keeps the second `claude` as a prompt arg; the same
 * contract applies to `codex` and `pi`.
 *
 * Informational flags (`-h`/`--help`, `-v`/`--version`) and the bare/unknown
 * invocation are owned here — they print and exit before `parseArgs` and the
 * passthrough scan ever see the argv.
 */

import pkg from "../../package.json" with { type: "json" };

export type AgentKind = "claude" | "codex" | "pi";

/** The composable post-launch verbs that read a detached run's transcript. */
export type SubcommandKind = "wait-for-stop" | "show-last-message";

/** Result of the leading-token classification. Discriminated on `kind`. */
export type Dispatch =
  | { kind: "run"; agent: AgentKind; rest: string[] }
  | { kind: "subcommand"; verb: SubcommandKind; rest: string[] }
  | { kind: "help" }
  | { kind: "help-wrapper" }
  | { kind: "version" }
  | { kind: "usage"; unknown?: string };

/** The wrapper-owned help flag, consumed before passthrough and launch. */
export const AGENTWRAP_HELP_FLAG = "--agentwrap-help";

/** True when argv contains the wrapper-owned `--agentwrap-help` flag. */
export function hasAgentwrapHelpFlag(argv: string[]): boolean {
  return argv.includes(AGENTWRAP_HELP_FLAG);
}

/** Top-level help/usage text. */
export const USAGE = `agentwrap — launch agent CLIs with agentwrap routing and startup defaults.

Usage:
  agentwrap claude [args...]        Launch Claude Code.
  agentwrap codex [args...]         Launch Codex CLI.
  agentwrap pi [args...]            Launch pi.
  agentwrap wait-for-stop <handle> [--stop-timeout-ms <ms>]
                                    Block until a detached run's next stop.
  agentwrap show-last-message <h>   Print a detached run's final message.
  agentwrap --help                  Show this help.
  agentwrap --version               Show the version.

Agentwrap transport flags such as --agentwrap-tmux are consumed by the wrapper;
all other args after the agent subcommand pass through to that launcher unchanged.
A detached launch (--agentwrap-tmux --agentwrap-tmux-detached) prints a JSON
handle; pass its "id" (or a transcript path) to wait-for-stop / show-last-message.
`;

/** Version string, sourced from package.json. */
export const VERSION = `agentwrap ${(pkg as { version: string }).version}\n`;

/**
 * Wrapper-owned overlay help. Documents only the `--agentwrap-*` surface the
 * wrapper consumes — common flags, the tmux transport flags, and the
 * agent-specific wrapper flag. Native agent flags are NOT listed here; reach a
 * launcher's own help with `agentwrap <agent> --help`.
 */
export const AGENTWRAP_HELP = `agentwrap — launch agent CLIs with agentwrap routing and startup defaults.

Usage:
  agentwrap claude [args...]   Launch Claude Code.
  agentwrap codex [args...]    Launch Codex CLI.
  agentwrap pi [args...]       Launch pi.

The flags below are consumed by the wrapper; every other arg after the agent
subcommand passes through to that launcher unchanged. For a launcher's own
options, run \`agentwrap <agent> --help\`.

Wrapper flags:
  --agentwrap-help                  Show this wrapper help and exit.
  --agentwrap-verbose               Print one line per startup section.
  --agentwrap-very-verbose          Add per-phase timing and the composed
                                    agent command. Implies --agentwrap-verbose.
  --agentwrap-no-confirm            Skip the cwd-confirmation prompt.
  --agentwrap-profile <name>        Select a profile ('default' = native
                                    account; 'auto' picks via the ledger).

Experimental flags (opt-in):
  --agentwrap-modal                 (claude only) Host claude in a Bun PTY under
                                    an OpenTUI modal-overlay shell. With the modal
                                    closed it is a raw passthrough; a reserved
                                    hotkey floats a test modal. Requires an
                                    interactive TTY; rejected with -p/--print.

tmux transport flags (any one implies tmux mode):
  --agentwrap-tmux                  Open the invocation in a new tmux window.
  --agentwrap-tmux-detached         Create the window without moving focus.
  --agentwrap-tmux-session <name>   Target/create the named tmux session.
  --agentwrap-tmux-window-name <n>  Name the created tmux window.
  --agentwrap-tmux-socket-name <n>  tmux server socket name (-L).
  --agentwrap-tmux-socket-path <p>  tmux server socket path (-S).
  --agentwrap-tmux-env KEY=VALUE    Inject env into the pane via tmux -e
                                    (repeatable; LD_*/DYLD_* keys rejected).
  --no-artifacts                    Suppress the launch.sh/run.json run-dir
                                    trail; JSON result carries runDir:null.

Post-launch transcript subcommands (composable with a detached launch):
  agentwrap wait-for-stop <handle> [--stop-timeout-ms <ms>]
                                        Block until the run's next stop event.
                                        --stop-timeout-ms overrides the 600s
                                        stop-wait ceiling (positive integer ms).
  agentwrap show-last-message <handle>  Print the run's final assistant message.
                                        <handle> is the launch JSON's id (or a
                                        transcript path with --agent <kind>).

tmux-mode exit codes (a structured JSON error is emitted on every non-zero exit):
  0  success                        2  bad args
  1  internal/parse failure         3  prerequisite missing (tmux/session not found)
                                    4  transient/retryable (timeout, lock contention)

Agent-specific wrapper flags:
  --agentwrap-codex-session-name <name>
                                    Index this synthetic name for the Codex
                                    session once its live id is known.

Top-level flags:
  --help, -h                        Show short usage.
  --version, -v                     Show the version.
`;

/**
 * Classify the leading argv token. `claude`/`codex`/`pi` → run with the remaining
 * args (even when empty, so a bare `agentwrap claude`, `agentwrap codex`, or `agentwrap pi`
 * still launches interactively); `wait-for-stop`/`show-last-message` → the
 * post-launch transcript verbs with the remaining args (the handle); `--agentwrap-help`
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
  if (head === "claude" || head === "codex" || head === "pi") {
    return { kind: "run", agent: head, rest: argv.slice(1) };
  }
  if (head === "wait-for-stop" || head === "show-last-message") {
    return { kind: "subcommand", verb: head, rest: argv.slice(1) };
  }
  if (head === AGENTWRAP_HELP_FLAG) {
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
