#!/usr/bin/env bun
// SubagentStop worker guard dispatcher.
//
// First-chance corrective round for a worker stopping in a non-done,
// non-BLOCKED state (task 4 fills in the block logic). Stub: read stdin once,
// exit 0 silently. Fail open on every path.

import { isBypassed, readStdin } from "./lib.ts";

async function main(): Promise<void> {
  if (isBypassed()) return;
  await readStdin();
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the subagent stop proceed.
});
