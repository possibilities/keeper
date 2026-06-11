#!/usr/bin/env bun
// Stop checklist guard dispatcher.
//
// Blocks a work/close session Stop that left a claimed task non-done /
// non-blocked, or a close that never finalized (task 5 fills in the block
// logic). Stub: read stdin once, exit 0 silently. Fail open on every path.

import { isBypassed, readStdin } from "./lib.ts";

async function main(): Promise<void> {
  if (isBypassed()) return;
  await readStdin();
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the session stop proceed.
});
