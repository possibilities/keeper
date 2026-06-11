#!/usr/bin/env bun
// PreToolUse(Bash) commit hard-deny dispatcher.
//
// Denies main-context `keeper commit-work` / `git commit` while the session's
// claimed task is in_progress (task 3 fills in the deny logic). Stub: read
// stdin once, exit 0 silently. Fail open on every path.

import { isBypassed, readStdin } from "./lib.ts";

async function main(): Promise<void> {
  if (isBypassed()) return;
  await readStdin();
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the tool call proceed.
});
