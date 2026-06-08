/**
 * In-process daemon harness for the slow-test tier (fn-747).
 *
 * The slow tier (`integration`, `daemon`, `plan-worker`) could not be
 * `--parallel`-ized: every file booted the FULL keeperd — either as a real
 * subprocess (`integration.test.ts` Bun.spawn) or by spawning watcher Worker
 * threads that each `dlopen` the `@parcel/watcher` NAPI addon. Under
 * `--parallel`, concurrent worker dlopens SIGTRAP on teardown (daemon exits
 * 133) and bun:sqlite's native binding races on concurrent open. The fn-747
 * keystone (`startDaemon` + the watcher seam) lets a test boot a REAL daemon
 * IN THIS PROCESS with `disableNativeWatcher: true` — so the fold pipeline runs
 * (synthetic-event INSERT → wake-worker drain → projection → UDS query) WITHOUT
 * any worker-thread addon dlopen, the SIGTRAP source.
 *
 * This harness wires that up:
 *  1. Sandbox ALL SIX `KEEPER_*` state paths under a per-test tmpdir (the
 *     CLAUDE.md "Test isolation" invariant — never strand one at its production
 *     `~/.local/state/keeper/` default) PLUS `KEEPER_SOCK` (a unique UDS per
 *     test so parallel daemons don't collide on the default socket inode). The
 *     in-process daemon's path resolvers read `process.env` directly, so we MUST
 *     set these on the live `process.env`, not just build an object the way
 *     `sandboxEnv` does for a subprocess spawn.
 *  2. `startDaemon({ disableNativeWatcher: true })`. The boot body is fully
 *     SYNCHRONOUS up to returning the handle: every path resolver runs and every
 *     worker spawns (capturing the env snapshot the worker thread inherits)
 *     before the call returns. So we restore `process.env` IMMEDIATELY after the
 *     synchronous boot — two parallel `startDaemon` calls can't interleave a
 *     single-threaded sync block, which is what makes the shared-`process.env`
 *     mutation parallel-safe.
 *  3. `waitForDaemon(sockPath)` — the bound UDS is a happens-after-migrate
 *     signal (the existing slow-tier readiness gate, reused verbatim).
 *  4. Run the body, then `stop()` (the no-`process.exit` teardown) + a
 *     belt-and-suspenders socket/lock unlink so a wedged-teardown inode can't
 *     leak into the next test's bind.
 */

import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonHandle, startDaemon } from "../../src/daemon";
import { waitForDaemon } from "./wait-for-daemon";

/** The context a {@link withInProcessDaemon} body receives. */
export interface InProcessDaemonContext {
  /** The live daemon handle — `sockPath` to query, `stop()` if the body needs it. */
  handle: DaemonHandle;
  /** The per-test tmpdir holding every sandboxed state path. */
  tmpDir: string;
  /** The sandboxed `keeper.db` path (set as `KEEPER_DB`). */
  dbPath: string;
  /** The UDS path the server worker bound (set as `KEEPER_SOCK`). */
  sockPath: string;
}

/** Options for {@link withInProcessDaemon}. */
export interface WithInProcessDaemonOptions {
  /**
   * Extra env applied alongside the six sandbox paths during the SAME
   * synchronous boot window and restored EXACTLY afterward. The plan/usage/
   * transcript workers resolve their hermetic roots from `KEEPER_CONFIG` at boot,
   * so a test that needs the daemon to watch a tmp plan tree passes
   * `{ env: { KEEPER_CONFIG: configPath } }` here. Applied/snapshotted/restored
   * exactly like the sandbox keys, so it stays parallel-safe (the restore lands
   * before any `await` — a sibling parallel test never observes it).
   */
  env?: Record<string, string>;
}

/** The six sandboxed `KEEPER_*` state-path keys, plus the per-test socket. */
const STATE_KEYS = [
  "KEEPER_DB",
  "KEEPER_DEAD_LETTER_DIR",
  "KEEPER_EVENTS_LOG",
  "KEEPER_DROP_LOG",
  "KEEPER_RESTORE_FILE",
  "KEEPER_BACKSTOP_LOG",
  "KEEPER_SOCK",
] as const;

/**
 * Boot an in-process daemon under a hermetic per-test sandbox, run `fn`, and
 * tear it down cleanly. The daemon runs with `disableNativeWatcher: true` so NO
 * worker thread dlopens `@parcel/watcher` — the fold pipeline still runs (the
 * wake-worker drain + main's events-log fallback poll + the plan-worker's
 * `data_version`-poll degrade), but the parallel tier stays SIGTRAP-free.
 *
 * The body receives the live {@link DaemonHandle} plus the sandboxed paths. The
 * harness owns teardown: `stop()` then a belt-and-suspenders socket/lock unlink,
 * then the tmpdir is removed — even if `fn` throws.
 */
export async function withInProcessDaemon(
  fn: (ctx: InProcessDaemonContext) => Promise<void> | void,
  opts: WithInProcessDaemonOptions = {},
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "keeper-inproc-daemon-"));
  const dbPath = join(tmpDir, "keeper.db");
  // Unique UDS per test. macOS caps `sun_path` at ~104 bytes; `mkdtemp` under
  // `tmpdir()` keeps the prefix short, and a bare `keeperd.sock` leaf stays well
  // under the cap.
  const sockPath = join(tmpDir, "keeperd.sock");

  // Sandbox the env. Snapshot the prior values so we can restore EXACTLY (an
  // absent key must go back to absent, not to ""). Applied right before the
  // synchronous boot and restored right after — see the module doc on why that
  // window is parallel-safe.
  const sandbox: Record<string, string> = {
    KEEPER_DB: dbPath,
    KEEPER_DEAD_LETTER_DIR: join(tmpDir, "dead-letters"),
    KEEPER_EVENTS_LOG: join(tmpDir, "events-log"),
    KEEPER_DROP_LOG: join(tmpDir, "hook-drops.ndjson"),
    KEEPER_RESTORE_FILE: join(tmpDir, "restore.json"),
    KEEPER_BACKSTOP_LOG: join(tmpDir, "backstop.ndjson"),
    KEEPER_SOCK: sockPath,
    // Caller-supplied boot env (e.g. KEEPER_CONFIG for a hermetic plan root) —
    // applied/snapshotted/restored in the same window as the sandbox keys.
    ...opts.env,
  };
  // Snapshot every key we touch (the fixed six + sock + any caller-supplied
  // env) so the restore is EXACT — an absent key goes back to absent.
  const touchedKeys = [...STATE_KEYS, ...Object.keys(opts.env ?? {})];
  const prior: Record<string, string | undefined> = {};
  for (const k of touchedKeys) prior[k] = process.env[k];

  let handle: DaemonHandle | null = null;
  try {
    // Set → boot (synchronous: resolvers run + workers spawn, each inheriting
    // this env snapshot) → restore. The restore lands before any `await`, so a
    // sibling parallel test never observes this test's env.
    for (const [k, v] of Object.entries(sandbox)) process.env[k] = v;
    try {
      handle = startDaemon({ disableNativeWatcher: true });
    } finally {
      // Restore EXACTLY — delete keys that were absent, restore the rest.
      for (const k of touchedKeys) {
        const v = prior[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    await waitForDaemon(handle.sockPath);
    await fn({ handle, tmpDir, dbPath, sockPath: handle.sockPath });
  } finally {
    if (handle) {
      try {
        await handle.stop();
      } catch {
        // best-effort — teardown noise must not mask a body assertion failure.
      }
      // Belt-and-suspenders: the server worker unlinks its own socket + lock in
      // its shutdown handler, but if a wedged worker missed the deadline the
      // inode would leak into the next bind. Unlink both directly (no-op if the
      // worker already released them).
      for (const p of [sockPath, `${sockPath}.lock`]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          // best-effort
        }
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
