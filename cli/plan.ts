#!/usr/bin/env bun
/**
 * `keeper plan <verb>` — in-process alias for the planctl CLI. The human-facing
 * alias for `planctl <verb>`; the hot path (autopilot, skills, the ~132 caller
 * files) keeps calling `planctl` directly. This alias exists so `keeper plan
 * status` reads identically to `planctl status` now that the two plugins are
 * co-hosted in one repo.
 *
 * Contract — byte-identical to a direct `planctl <verb>` invocation: the plan
 * verb dispatcher runs IN-PROCESS (no child spawn), so argv flows through
 * verbatim (the dispatcher already stripped the `plan` token via `argv.slice(1)`,
 * so we forward exactly what planctl should see), stdin/stdout/stderr are the
 * inherited process streams (streaming + TTY + piped stdin intact, the
 * `plan_invocation` trailer survives byte-intact), and the verb owns its exit
 * code — self-emitting verbs call `process.exit` themselves; the rest return a
 * code the dispatcher's `main` propagates here.
 *
 * `process.exit` is the terminal statement so Bun never prints an extra "exited
 * with code N" banner (Bun #5455).
 */

import { main as planctlMain } from "../plugins/plan/src/cli.ts";

export function main(argv: string[]): never {
  process.exit(planctlMain(argv));
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
