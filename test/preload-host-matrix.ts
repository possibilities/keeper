// Test-suite preload — pins KEEPER_CONFIG_DIR to a scratch directory seeded
// with the committed Claude-only host matrix, so root tests never read the live
// ~/.config/keeper. Individual tests may still replace the variable with their
// own fixture and restore this process-wide default afterward.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedClaudeOnlyMatrix } from "./helpers/sandbox-env";

const configDir = mkdtempSync(join(tmpdir(), "keeper-root-host-matrix-"));
seedClaudeOnlyMatrix(configDir);
process.env.KEEPER_CONFIG_DIR = configDir;
process.once("exit", () => rmSync(configDir, { recursive: true, force: true }));
