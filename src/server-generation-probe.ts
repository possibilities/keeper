import {
  buildGenerationId,
  buildTmuxServerGenerationArgs,
} from "./exec-backend";

/**
 * `Bun.spawnSync`-shaped subset the tmux probes need; injectable so tests drive
 * the parse / classify without a real tmux server. Mirrors the git-worker's
 * `gitOutput` spawnSync shape: `success` + `exitCode` + a stdout `Buffer`.
 * `stderr` is OPTIONAL — {@link probeServerGeneration} collapses every non-zero
 * exit to a degraded-skip and never reads it, but the whole-server topology probe
 * (`probeTmuxTopology` in `restore-worker.ts`, retained for the boot-seed) needs
 * it to tell SERVER-GONE (`no server running` / `failed to connect`) from a
 * TRANSIENT failure (timeout / SIGKILL / EPIPE).
 */
export type SpawnSyncFn = (cmd: string[]) => {
  success: boolean;
  exitCode: number | null;
  stdout: Buffer;
  stderr?: Buffer;
};

/**
 * Probe the backend's current generation handle via the injected `spawnSync`,
 * minting the id through the sole {@link buildGenerationId} builder so this
 * boundary pulse and every topology emitter share ONE format. Returns the
 * canonical `pid:start_time` STRING; `null` for every degraded case — ENOENT (no
 * tmux binary), a non-zero exit (no running server), or output the builder
 * rejects (garbage / empty / bare-pid). NEVER throws. A `null` means "no
 * generation observed this pulse" and the caller emits nothing — a degraded
 * probe must NOT fire a spurious boundary. Pure relative to the injected
 * `spawnSync`.
 */
export function probeServerGeneration(spawnSync: SpawnSyncFn): string | null {
  let res: ReturnType<SpawnSyncFn>;
  try {
    res = spawnSync(buildTmuxServerGenerationArgs());
  } catch {
    return null;
  }
  if (!res.success || res.exitCode !== 0) {
    return null;
  }
  return buildGenerationId(res.stdout.toString());
}
