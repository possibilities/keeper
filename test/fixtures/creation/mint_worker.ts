// Bun race-harness worker: mint K epic ids under the shared global epic-id lock,
// interleaving with concurrent Python + bun peers. Argv: <dataDir> <count>.
// HOME is set by the harness so this resolves the SAME ~/.local/state lock path
// Python's _epic_id_lock uses — the cross-engine interop the test proves.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { withEpicIdLock } from "../../../src/flock.ts";
import { scanMaxEpicId } from "../../../src/ids.ts";

const dataDir = process.argv[2] as string;
const count = Number.parseInt(process.argv[3] as string, 10);

for (let i = 0; i < count; i += 1) {
  withEpicIdLock(() => {
    const next = scanMaxEpicId(dataDir) + 1;
    // Write both an epics/ JSON and a specs/ md so scanMaxEpicId's orphan-spec
    // dual scan is exercised under contention.
    writeFileSync(join(dataDir, "epics", `fn-${next}-race.json`), "{}\n");
    writeFileSync(join(dataDir, "specs", `fn-${next}-race.md`), "# race\n");
  });
}
