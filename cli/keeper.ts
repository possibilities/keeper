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
  "git",
  "usage",
  "autopilot",
  "await",
] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export const USAGE = `keeper — unified CLI for the keeper TUIs

Usage:
  keeper <subcommand> [options]

Subcommands:
  board       Combined epics + jobs board
  git         Live git status frames
  usage       Live usage frames
  autopilot   Dispatch log viewer
  await       Block until a planctl board condition holds

Flags:
  --help, -h     Show this help
  --version, -V  Show keeper version

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
    git: async (argv) => (await import("./git")).main(argv),
    usage: async (argv) => (await import("./usage")).main(argv),
    autopilot: async (argv) => (await import("./autopilot")).main(argv),
    await: async (argv) => (await import("./await")).main(argv),
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
