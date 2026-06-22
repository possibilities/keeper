#!/usr/bin/env bun
/**
 * `keeper plan <verb>` — in-process entry point for the plan verb dispatcher.
 * `keeper plan` is the canonical command (the former standalone plan CLI is
 * gone); this entry exists so callers — autopilot, skills, scripts — invoke the
 * plan tooling through the single `keeper` binary now that the two plugins are
 * co-hosted in one repo.
 *
 * Contract — the plan verb dispatcher runs IN-PROCESS (no child spawn), so argv
 * flows through verbatim (the dispatcher already stripped the `plan` token via
 * `argv.slice(1)`, so we forward exactly what the dispatcher should see),
 * stdin/stdout/stderr are the
 * inherited process streams (streaming + TTY + piped stdin intact, the
 * `plan_invocation` trailer survives byte-intact), and the verb owns its exit
 * code — self-emitting verbs call `process.exit` themselves; the rest return a
 * code the dispatcher's `main` propagates here.
 *
 * `process.exit` is the terminal statement so Bun never prints an extra "exited
 * with code N" banner (Bun #5455).
 */

import { main as planMain } from "../plugins/plan/src/cli.ts";

export function main(argv: string[]): never {
  process.exit(planMain(argv));
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
