#!/usr/bin/env bun
/** `keeper daemon` — daemon lifecycle command group. */

import { main as restartMain } from "./restart";

export const HELP = `keeper daemon — daemon lifecycle operations

Usage:
  keeper daemon --help
  keeper daemon restart [--timeout <duration>] [--sock <path>]

Verbs:
  restart  Restart keeperd and wait for a caught-up serve

Flags:
  --help, -h  Show this help
`;

export async function main(argv: string[]): Promise<void> {
  const head = argv[0];
  if (head === "--help" || head === "-h" || head === undefined) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (head === "restart") {
    await restartMain(argv);
    return;
  }
  process.stderr.write(`keeper daemon: unknown verb '${head}'\n\n${HELP}`);
  process.exit(2);
}
