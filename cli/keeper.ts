#!/usr/bin/env bun
/**
 * `keeper` CLI dispatcher. Routes the first positional argv token to one of
 * the four TUI subcommands; surfaces top-level help and version. Landed in
 * task .1 of the OpenTUI port epic with the renderer cutover and the four
 * subcommand mains relocating from `scripts/*.ts` to `cli/*.ts` over
 * `.2`-`.5`. After `.5` (autopilot) every subcommand resolves to a
 * `cli/<sub>.ts` module exporting its own `main(argv)` — no
 * `scripts/*.ts` shim path remains.
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
  "await",
  "commit-work",
  "session-state",
  "show-session-files",
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
  await               Block until a planctl/git/job condition holds
  commit-work         Stage session-attributed files, lint, commit, push
  session-state       Current session git context + on-hook files (JSON)
  show-session-files  Session's on-hook dirty files grouped by repo (JSON)

Flags:
  --help, -h     Show this help
  --version, -V  Show keeper version

The five viewer subcommands (board/jobs/git/usage/autopilot) auto-detect a
non-TTY stdout (piped, redirected, CI) and emit ONE current frame followed by
a machine-parseable \`keeper-meta:\` JSON line, then exit — instead of streaming
forever. Override per subcommand with \`--snapshot\` (force one-shot on a TTY),
\`--watch\` (force the live stream even when piped — never exits), or
\`--timeout <s>\` (snapshot wait, ~2s default).

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
    await: async (argv) => (await import("./await")).main(argv),
    "commit-work": async (argv) => (await import("./commit-work")).main(argv),
    "session-state": async (argv) =>
      (await import("./session-state")).main(argv),
    "show-session-files": async (argv) =>
      (await import("./show-session-files")).main(argv),
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
