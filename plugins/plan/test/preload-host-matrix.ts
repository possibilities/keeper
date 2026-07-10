// Test-suite preload — pins KEEPER_CONFIG_DIR to a scratch dir seeded with the
// committed claude-only v2 host matrix, so NO plan test reads the live
// ~/.config/keeper (the required host matrix, ADR 0036). os.homedir() ignores
// $HOME on macOS, so an unset var strands at the developer's real config dir; this
// process-wide default closes that leak for every in-process unit test.
//
// A test needing a different roster overrides process.env.KEEPER_CONFIG_DIR (or
// the harness pins its own per-invocation via buildEnv); this only sets the
// default every test inherits absent its own override.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "plan-host-matrix-"));
writeFileSync(
  join(dir, "matrix.yaml"),
  readFileSync(
    join(import.meta.dir, "fixtures", "matrix-claude-only.yaml"),
    "utf-8",
  ),
);
process.env.KEEPER_CONFIG_DIR = dir;
