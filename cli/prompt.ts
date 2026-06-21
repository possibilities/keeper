#!/usr/bin/env bun
/**
 * `keeper prompt <verb>` — in-process entry point for the prompt-substrate verb
 * dispatcher. `keeper prompt` is the canonical command (the retired standalone
 * `promptctl` CLI is gone); this entry exists so callers — install.sh, the plan
 * generated-guard hooks, skills, scripts — invoke the prompt engine through the
 * single `keeper` binary now that the plugins are co-hosted in one repo.
 *
 * Contract — the dispatcher runs IN-PROCESS (no child spawn), so argv flows
 * through verbatim (the keeper dispatcher already stripped the `prompt` token via
 * `argv.slice(1)`), stdin/stdout/stderr are the inherited process streams
 * (streaming + TTY + piped stdin intact), and the verb owns its exit code.
 *
 * `process.exit` is the terminal statement so Bun never prints an extra "exited
 * with code N" banner (Bun #5455).
 */

import { main as promptMain } from "../plugins/prompt/src/cli.ts";

export function main(argv: string[]): never {
  process.exit(promptMain(argv));
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
