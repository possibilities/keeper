/**
 * Child entrypoint for the cross-process flock contention test: redirect the
 * state dir + config home via env (set by the parent), do exactly one
 * `pickProfile()` against the shared ledger, print the result. The parent
 * spawns N of these concurrently and asserts the flock serialized every
 * read-modify-write (no lost updates).
 */

import { pickProfile, setStateDir } from "../../src/usage-picker";

const stateDir = process.env.AGENTUSAGE_TEST_STATE_DIR;
if (!stateDir) {
  process.stderr.write("AGENTUSAGE_TEST_STATE_DIR unset\n");
  process.exit(2);
}
setStateDir(stateDir);
process.stdout.write(`${pickProfile()}\n`);
