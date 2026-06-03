#!/usr/bin/env bun
/**
 * `keeper plugin-path` — print the canonical absolute filesystem path of the
 * committed `keeper-zellij-bridge.wasm` artifact (epic fn-684, task .2).
 *
 * This subcommand is the seam in keeper's cross-repo byte-match contract: the
 * human's dotfiles `~/.config/zellij/config.kdl` (`load_plugins { "file:..." }`
 * block) and `~/.cache/zellij/permissions.kdl` BOTH derive their `file:` URL
 * from `keeper plugin-path` so there is exactly ONE source of truth for the
 * absolute path. Moving the committed artifact requires a coordinated dotfiles
 * update — but reading `keeper plugin-path` continues to print whatever the
 * up-to-date `src/db.ts` constant resolves, so the dotfiles consumer keeps
 * working without a manual byte-match audit.
 *
 * Contract:
 *   - `keeper plugin-path`             → one line: absolute path + `\n`, exit 0.
 *   - `keeper plugin-path --help|-h`   → HELP block to stdout, exit 0.
 *   - `keeper plugin-path <extra>`     → HELP block + error to stderr, exit 1.
 *
 * Dispatched from `cli/keeper.ts`. Like the other `cli/<sub>.ts` modules the
 * `import.meta.main` guard is neutralised — `cli/keeper.ts` is the canonical
 * entry. The function `main(argv)` is exported so the dispatch unit tests in
 * `test/keeper-cli.test.ts` can wire a stub handler (and a separate dispatch
 * test exercises the real handler against captured sinks).
 */

import { KEEPER_ZELLIJ_PLUGIN_WASM } from "../src/db";

export const HELP = `keeper plugin-path — print the canonical absolute path of the committed keeper-zellij-bridge.wasm.

Usage:
  keeper plugin-path

The printed path is the single source of truth referenced by dotfiles'
~/.config/zellij/config.kdl (load_plugins) and ~/.cache/zellij/permissions.kdl
(ReadApplicationState seed). Rebuild with \`bun run build:plugin\` after a
zellij upgrade.

Flags:
  --help, -h     Show this help
`;

export interface PluginPathDeps {
  /** Sink for usage / value output (stdout in prod, captured in tests). */
  stdout: (s: string) => void;
  /** Sink for error output (stderr in prod, captured in tests). */
  stderr: (s: string) => void;
  /** Process exit shim — tests inject a thrower; prod uses `process.exit`. */
  exit: (code: number) => never;
  /** Source of truth for the printed path; tests inject a fixture. */
  pluginPath: string;
}

/**
 * Pure dispatch for `keeper plugin-path`. Side effects are bounded by `deps`,
 * so the unit test can capture stdout/stderr and assert on the exact bytes
 * without spawning a subprocess.
 *
 * Why the `extra-args → exit 1` branch matters: an accidental
 * `keeper plugin-path /some/path` from a shell completion would otherwise
 * print the canonical path and exit 0, which silently masks the user's
 * intent (probably they meant `realpath` or `keeper plugin-path | xargs`).
 * The hard reject + HELP makes the bug visible.
 */
export function runPluginPath(argv: string[], deps: PluginPathDeps): void {
  if (argv.length > 0) {
    const first = argv[0] as string;
    if (first === "--help" || first === "-h") {
      deps.stdout(HELP);
      deps.exit(0);
    }
    deps.stderr(`keeper plugin-path: unexpected argument '${first}'\n\n`);
    deps.stderr(HELP);
    deps.exit(1);
  }
  // Trailing newline so `keeper plugin-path | xargs ...` works cleanly and
  // `$(keeper plugin-path)` strips a single trailing LF as POSIX requires.
  deps.stdout(`${deps.pluginPath}\n`);
  deps.exit(0);
}

export function main(argv: string[]): void {
  runPluginPath(argv, {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
    pluginPath: KEEPER_ZELLIJ_PLUGIN_WASM,
  });
}

// `import.meta.main` guard neutralised — `cli/keeper.ts` is the canonical
// entry. Direct invocation via `bun cli/plugin.ts` would bypass the
// dispatcher; run `bun cli/keeper.ts plugin-path` (or the installed
// `keeper plugin-path` bin shim) instead.
