#!/usr/bin/env bun
/**
 * `keeper plan <verb>` — full-passthrough exec shim to the compiled planctl
 * binary. The human-facing alias for `planctl <verb>`; the hot path (autopilot,
 * skills, the ~132 caller files) keeps calling `planctl` directly. This shim
 * exists so `keeper plan status` reads identically to `planctl status` once the
 * two plugins are co-hosted in one repo.
 *
 * Contract — byte-identical to a direct `planctl <verb>` invocation:
 *   - argv passes through verbatim (the dispatcher already stripped the `plan`
 *     token via `argv.slice(1)`, so we forward exactly what planctl should see);
 *   - stdin/stdout/stderr are inherited (streaming + TTY + piped stdin intact —
 *     never `pipe`, which buffers and breaks the `planctl_invocation` trailer);
 *   - the child's exit code propagates unchanged; signal death maps to
 *     `128 + signal` (POSIX convention) rather than a masked 1;
 *   - a missing binary fails loud with exit 127, never a silent 0.
 *
 * No `shell:true` (argv is passed as a vector, no word-splitting). `process.exit`
 * is always the terminal statement so Bun never prints an extra "exited with
 * code N" banner (Bun #5455).
 */

import { constants, homedir } from "node:os";
import { join } from "node:path";

/** Resolve the compiled planctl binary, or `null` if it can't be found. */
export function resolveBinary(): string | null {
  const onPath = Bun.which("planctl");
  if (onPath != null) return onPath;
  const local = join(homedir(), ".local", "bin", "planctl");
  return Bun.file(local).size > 0 ? local : null;
}

/**
 * Map a `Bun.spawnSync` result to the process exit code we should propagate.
 * `exitCode` is `null` on signal death, in which case `signalCode` is the
 * signal name (e.g. "SIGINT") — translate it to `128 + n` so a SIGINT through
 * the shim surfaces as 130, not a masked 1.
 */
export function exitCodeFor(result: {
  exitCode: number | null;
  signalCode?: string | null;
}): number {
  if (result.exitCode != null) return result.exitCode;
  if (result.signalCode != null) {
    const n = (constants.signals as Record<string, number>)[result.signalCode];
    if (typeof n === "number") return 128 + n;
  }
  return 1;
}

export function main(argv: string[]): never {
  const bin = resolveBinary();
  if (bin == null) {
    process.stderr.write(
      "keeper plan: planctl binary not found (looked on PATH and ~/.local/bin/planctl)\n",
    );
    process.exit(127);
  }

  const result = Bun.spawnSync({
    cmd: [bin, ...argv],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  process.exit(exitCodeFor(result));
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
