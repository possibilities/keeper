// Bun flock peer for the cross-process contention tests in src-store-write.test.ts.
// Uses the SAME src/flock.ts the production store uses, so a second bun process
// contends against the test's lock through the real flock(2) syscall path.
//
// Modes (argv[2]):
//   hold   <lockPath> <heldMarker> <releaseMarker>
//     Take LOCK_EX, touch heldMarker, poll for releaseMarker, then unlock.
//   try-nb <lockPath>
//     Non-blocking acquire; exit 42 on the expected FlockWouldBlock, 0 if it
//     wrongly acquired, 1 on any other error.
//   acquire <lockPath>
//     Non-blocking acquire then release; exit 0 on success.

import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";

import {
  FlockWouldBlock,
  flock,
  flockOrThrow,
  LOCK_EX,
  LOCK_NB,
  LOCK_UN,
} from "../../src/flock.ts";

const mode = process.argv[2];
const lockPath = process.argv[3] as string;

if (mode === "hold") {
  const heldMarker = process.argv[4] as string;
  const releaseMarker = process.argv[5] as string;
  // Poll cadence + a max-hold deadline + parent-death detection so a hold peer can
  // never leak a spinning core forever when its parent test dies (the fn-934
  // starvation fixture leak). A busy-spin here pegged a core at 95% with no exit.
  const POLL_MS = 5;
  const MAX_HOLD_MS = 30_000;
  const parentPid = process.ppid;
  const fd = openSync(lockPath, "w");
  flockOrThrow(fd, LOCK_EX);
  writeFileSync(heldMarker, "");
  const deadline = Date.now() + MAX_HOLD_MS;
  while (!existsSync(releaseMarker)) {
    // Self-exit if the parent test died (reparented to pid 1 / init) or the
    // max-hold deadline elapsed — never outlive the test that spawned us.
    if (process.ppid !== parentPid || Date.now() >= deadline) {
      break;
    }
    Bun.sleepSync(POLL_MS);
  }
  flock(fd, LOCK_UN);
  closeSync(fd);
  process.exit(0);
} else if (mode === "try-nb") {
  const fd = openSync(lockPath, "w");
  try {
    flockOrThrow(fd, LOCK_EX | LOCK_NB);
    process.exit(0); // wrongly acquired
  } catch (e) {
    process.exit(e instanceof FlockWouldBlock ? 42 : 1);
  } finally {
    closeSync(fd);
  }
} else if (mode === "acquire") {
  const fd = openSync(lockPath, "w");
  flockOrThrow(fd, LOCK_EX | LOCK_NB);
  flock(fd, LOCK_UN);
  closeSync(fd);
  process.exit(0);
} else {
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}
