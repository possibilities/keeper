#!/usr/bin/env bun
/**
 * `keeper` CLI dispatcher. Routes the first positional argv token to its
 * subcommand main; surfaces top-level help and version. Every subcommand
 * resolves to a `cli/<sub>.ts` module exporting its own `main(argv)`.
 *
 * Contract (per the spec's gap analysis):
 *   - Bare `keeper` → usage block on stderr, exit 1.
 *   - Unknown subcommand → usage block on stderr, exit 1.
 *   - `keeper --version` → version line on stdout, exit 0.
 *   - `keeper --help` / `keeper -h` → usage block on stdout, exit 0.
 *   - `keeper <sub> --help` → forwards the flag through to the subcommand's
 *     own `HELP` block (each subcommand main parses `--help` itself).
 *
 * Why a dispatch() factory with injectable handlers: the unit test in
 * `test/keeper-cli.test.ts` exercises routing without spawning a renderer.
 * Production code calls `main()` which wires the real subcommand mains.
 */

import packageJson from "../package.json" with { type: "json" };

export const SUBCOMMANDS = [
  "board",
  "jobs",
  "git",
  "usage",
  "autopilot",
  "builds",
  "dash",
  "await",
  "commit-work",
  "setup-tmux",
  "session-state",
  "show-session-files",
  "search-history",
  "find-file-history",
  "show-session-events",
  "show-job",
  "plan",
] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export const USAGE = `keeper — unified CLI for the keeper TUIs

Usage:
  keeper <subcommand> [options]

Subcommands:
  board               Epics board (TTY: live TUI; non-TTY: one snapshot + exit)
  jobs                Jobs list w/ dead-letter banner + 'r' replay (TTY: live; non-TTY: snapshot)
  git                 Git status frames (TTY: live TUI; non-TTY: one snapshot + exit)
  usage               Usage frames (TTY: live TUI; non-TTY: one snapshot + exit)
  autopilot           Dispatch log viewer (TTY: live TUI; non-TTY: one snapshot + exit)
  builds              Buildbot status dashboard (TTY: live TUI; non-TTY: one snapshot + exit)
  dash                Read-only opening screen: header + PLAN + AGENTS (TTY-only)
  await               Block until a planctl/git/job condition holds
  commit-work         Stage session-attributed files, lint, commit, push
  setup-tmux          Provision the tmux control plane (dash + work sessions)
  session-state       Current session git context + on-hook files (JSON)
  show-session-files  Session's on-hook dirty files grouped by repo (JSON)
  search-history      Search UserPromptSubmit history by LIKE term (JSON)
  find-file-history   List file attributions matching a path fragment (JSON)
  show-session-events Prompt/tool-call spine for one session (JSON)
  show-job            One job's full metadata by session-id/title/cwd/pane or auto-detect (JSON)
  plan                Alias for the planctl CLI: \`keeper plan <verb>\` runs planctl in-process

Flags:
  --help, -h     Show this help
  --version, -V  Show keeper version

The six snapshot-capable viewer subcommands (board/jobs/git/usage/autopilot/builds)
auto-detect a non-TTY stdout (piped, redirected, CI) and emit ONE current frame
followed by a machine-parseable \`keeper-meta:\` JSON line, then exit — instead of
streaming forever. Override per subcommand with \`--snapshot\` (force one-shot on a
TTY), \`--watch\` (force the live stream even when piped — never exits), or
\`--timeout <s>\` (snapshot wait, ~2s default). \`dash\` is the exception: it is
TTY-ONLY (no snapshot mode), so a non-TTY stdout exits 1 rather than printing a
frame.

Run \`keeper <subcommand> --help\` for subcommand-specific options.
`;

export type SubcommandHandler = (argv: string[]) => Promise<void> | void;

export interface DispatchDeps {
  /** Map of subcommand name → its `main(argv)` entry point. */
  handlers: Record<Subcommand, SubcommandHandler>;
  /** Sink for usage / version output (stdout in prod, captured in tests). */
  stdout: (s: string) => void;
  /** Sink for error output (stderr in prod, captured in tests). */
  stderr: (s: string) => void;
  /** Process exit shim — tests inject a thrower; prod uses `process.exit`. */
  exit: (code: number) => never;
  /** Source of truth for `--version`. */
  version: string;
}

/**
 * Pure dispatch: examines the first positional token, routes to the named
 * handler with the residual argv, and handles the four top-level cases
 * (bare / unknown / --help / --version). Never returns on the top-level
 * cases (always calls `exit`); returns the handler's promise otherwise so
 * the caller can `await` it.
 */
export async function dispatch(
  argv: string[],
  deps: DispatchDeps,
): Promise<void> {
  // Top-level flags MUST be examined before subcommand routing — otherwise
  // `keeper --help` (a valid invocation) would fall into the "unknown
  // subcommand" branch and exit non-zero.
  if (argv.length === 0) {
    deps.stderr(USAGE);
    deps.exit(1);
  }

  const first = argv[0] as string;

  if (first === "--version" || first === "-V") {
    deps.stdout(`keeper ${deps.version}\n`);
    deps.exit(0);
  }

  if (first === "--help" || first === "-h") {
    deps.stdout(USAGE);
    deps.exit(0);
  }

  if (!isSubcommand(first)) {
    deps.stderr(`keeper: unknown subcommand '${first}'\n\n`);
    deps.stderr(USAGE);
    deps.exit(1);
  }

  const handler = deps.handlers[first];
  await handler(argv.slice(1));
}

export function isSubcommand(s: string): s is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(s);
}

export async function main(): Promise<void> {
  // Lazy-load subcommand modules so a `dispatch()` unit test that injects
  // stub handlers never pays the cost of importing the real (eventually
  // OpenTUI-backed) renderers. Each `cli/<sub>.ts` exports `main(argv)`.
  const handlers: Record<Subcommand, SubcommandHandler> = {
    board: async (argv) => (await import("./board")).main(argv),
    jobs: async (argv) => (await import("./jobs")).main(argv),
    git: async (argv) => (await import("./git")).main(argv),
    usage: async (argv) => (await import("./usage")).main(argv),
    autopilot: async (argv) => (await import("./autopilot")).main(argv),
    builds: async (argv) => (await import("./builds")).main(argv),
    dash: async (argv) => (await import("./dash")).main(argv),
    await: async (argv) => (await import("./await")).main(argv),
    "commit-work": async (argv) => (await import("./commit-work")).main(argv),
    "setup-tmux": async (argv) => (await import("./setup-tmux")).main(argv),
    "session-state": async (argv) =>
      (await import("./session-state")).main(argv),
    "show-session-files": async (argv) =>
      (await import("./show-session-files")).main(argv),
    "search-history": async (argv) =>
      (await import("./search-history")).main(argv),
    "find-file-history": async (argv) =>
      (await import("./find-file-history")).main(argv),
    "show-session-events": async (argv) =>
      (await import("./show-session-events")).main(argv),
    "show-job": async (argv) => (await import("./show-job")).main(argv),
    plan: async (argv) => (await import("./plan")).main(argv),
  };

  await dispatch(Bun.argv.slice(2), {
    handlers,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
    version: packageJson.version,
  });
}

if (import.meta.main) {
  void main();
}
