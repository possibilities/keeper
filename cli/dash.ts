#!/usr/bin/env bun
/**
 * `keeper dash` — the unified keeper TUI: a live, read-only, full-screen single
 * column of compact robot job-CARDS (one per job: project · title · status),
 * grouped by tmux session (foreground / background / autopilot / … / detached).
 * Status is dual-encoded as a Nerd Font md-robot face plus a colored left rail,
 * so the board is calm when idle and the few jobs that need attention pop.
 *
 * Unlike the five viewer subcommands, dash is TTY-ONLY — there is NO snapshot
 * mode. The TTY gate fires here, BEFORE any `@opentui/core` import, so a piped
 * invocation exits 1 with a one-line stderr message and never pays the
 * native-loader cost. The renderer construction + data wiring lives in
 * `src/dash/app.ts` (`createDashApp`); this file is just parseArgs +
 * resolveSockPath + the gate.
 *
 * Read-only end to end: no RPC frame is written, no DB is opened.
 *
 *   keeper dash [--sock <path>]
 *   keeper dash --help
 */

import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import { buildParseOptions, DASH_FLAGS } from "./descriptor";

const HELP = `keeper dash — read-only live robot job-card screen

Usage:
  keeper dash [--sock <path>]
  keeper dash --help

Options:
  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --help         Show this help

dash is a live, TTY-ONLY screen — there is NO snapshot mode. A non-TTY stdout
(piped, redirected, CI) exits 1 with 'keeper dash: requires a TTY'. The screen
reconnects forever, showing connection state in-TUI.

Keys:
  j / k / ↓ / ↑   move the card focus cursor (heavy cyan border)
  t               toggle ended/killed cards (default OFF — live jobs only)
  q / Ctrl-C      quit

It is read-only — no dispatch, no control, no DB open.
`;

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    // Derived from the pure-data descriptor (ADR 0008).
    options: buildParseOptions(DASH_FLAGS),
    allowPositionals: false,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = parsed.values.sock ?? resolveSockPath();

  // TTY gate — BEFORE any OpenTUI import. dash has no snapshot fallback, so a
  // non-TTY stdout is a hard error, not a mode switch.
  if (process.stdout.isTTY !== true) {
    process.stderr.write("keeper dash: requires a TTY\n");
    process.exit(1);
  }

  // Only now pull in the OpenTUI-backed app (its native loader is heavy and
  // racy under --isolate; the gate above keeps the piped path off it).
  const { createDashApp } = await import("../src/dash/app");
  await createDashApp(sockPath);
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical entry
// (its dispatcher prunes the subcommand token from argv before calling main).
