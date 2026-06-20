#!/usr/bin/env bun
/**
 * Thin `./scripts` entry point for `keeper show-job` (epic fn-840). The CLI main
 * reads `Bun.argv.slice(3)` under its own `import.meta.main` (dispatcher form);
 * this shim passes `slice(2)` so the verb's argv lines up when invoked directly
 * as `bun scripts/show-job.ts ...`.
 */
import { main } from "../cli/show-job";

main(Bun.argv.slice(2));
