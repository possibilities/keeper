/**
 * Statusline telemetry producer worker. Watches the keeper-managed statusLine
 * leaf dir (`~/.local/state/keeper/statusline/`, one `<token>.json` per session,
 * written by `keeper statusline`). It reads each leaf on change,
 * builds a typed `{kind:"session-telemetry", ...}` message keyed on the RAW
 * `session_id` from the leaf CONTENT, and posts it to the parent. The parent
 * (and only the parent) turns each message into a synthetic `SessionTelemetry`
 * `events` row, which the reducer folds latest-wins onto the six v100 `jobs`
 * telemetry columns. The worker never writes keeper.db — it opens a READ-ONLY
 * connection (restart-seed + GC census) and only posts messages, keeping main
 * the sole writer.
 *
 * Uses the external producer → coalesce → mint → fold pattern with the behaviors
 * telemetry needs:
 *   - **No liveness heartbeat.** A statusLine snapshot is display data, not a
 *     freshness beacon; a stable session's leaf should never re-emit just to
 *     re-stamp a fold. Pure content-gate suppression only.
 *   - **No delete-tombstone / retraction.** A leaf delete must NOT null the jobs
 *     telemetry columns — an ENDED row keeps its last-known model / effort /
 *     context%. {@link StatuslineScanner.onDelete} only drops the internal gate
 *     entry (so a re-created leaf re-emits); it emits nothing.
 * And with a behavior telemetry ADDS: a bounded leaf **GC** in the boot sweep
 * ({@link gcSweep}) so keeper-owned leaves — one per session, never deleted by
 * the sink — do not grow unbounded.
 *
 * **Correlation key (load-bearing).** The fold's ONLY match key is
 * `session_id`, and the reducer invariant `job_id === session_id` means the
 * statusLine payload's `session_id` IS the hook-sourced `jobs.job_id`. The leaf
 * FILENAME is a sanitized/lossy token, so the message id MUST come from the RAW
 * `session_id` stored INSIDE the leaf — never derived from the filename, or the
 * fold matches zero rows.
 *
 * **Change-gate exclusion (churn discipline).** The sink already coalesces its
 * leaf writes to a {model, effort, 5%-context-bucket} signature, so an unchanged
 * render never rewrites the leaf. The worker's {@link statuslineGateKey} is a
 * second layer: it EXCLUDES `input_tokens` (a monotonically-advancing raw token
 * count) so a leaf rewrite that only moved tokens can never mint a synthetic
 * event. {@link seedFromDb} reconstructs the SAME key from the jobs telemetry
 * columns so a daemon restart's boot scan does not re-emit a session already
 * folded.
 *
 * Worker discipline: `isMainThread`-guarded body (a plain import
 * is inert; the pure {@link StatuslineScanner} is exported and drivable with no
 * Worker/watcher), own read-only `openDb`, typed `{kind}`/`{type}` messages, the
 * `disableNativeWatcher` seam (skip the `@parcel/watcher` dlopen for the
 * in-process test tier), `RescanScheduler` drop-recovery, and a shutdown handler
 * that `unsubscribe()`s the owned subscription.
 */

import type { Database } from "bun:sqlite";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription } from "@parcel/watcher";
import { openDb } from "./db";
import { isDropError, RescanScheduler } from "./rescan";
import type { SessionTelemetryMessage } from "./types";
import type { ShutdownMessage } from "./wake-worker";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only path
 * strings cross the boundary — the Database handle and the subscription cannot.
 */
export interface StatuslineWorkerData {
  dbPath: string;
  /**
   * The statusLine leaf directory to watch (flat — one `<token>.json` per
   * session, written by `keeper statusline`). The parent resolves this from
   * {@link import("./db").resolveStatuslineRoot}. A missing directory is
   * tolerated (subscribe + scan both no-op until the dir appears — no keeper-agent
   * claude session may have rendered yet).
   */
  root: string;
  /**
   * Watcher seam. When `true`, the worker NEVER `import()`s `@parcel/watcher` —
   * it skips the live subscribe + boot scan + GC and stays alive only for the
   * shutdown handshake. The in-process daemon harness sets this so the parallel
   * slow-test tier never dlopens the NAPI addon in a worker thread.
   */
  disableNativeWatcher?: boolean;
}

/**
 * Cap a leaf file's size before `JSON.parse`. Leaves live under keeper's own
 * state dir and are a few hundred bytes; a pathological/oversize file is
 * skip-and-logged so a bad file never balloons memory. 1 MiB is far above any
 * real leaf.
 */
const MAX_LEAF_FILE_BYTES = 1024 * 1024;

/**
 * Age past which a leaf whose session is ABSENT from `jobs` (its row pruned, or
 * never seeded) is GC-eligible. Three days is comfortably beyond any plausible
 * live session, so a fresh not-yet-seeded leaf (a snapshot that raced its own
 * SessionStart hook) is never reclaimed while its session is still coming up.
 */
export const LEAF_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Terminal `jobs.state` values — mirrors the reducer's `ENDED` / `KILLED`. */
const TERMINAL_STATES = new Set(["ended", "killed"]);

/**
 * In-callback filename predicate — accepts a bare `<token>.json` leaf (the sink
 * sanitizes the session id to `[A-Za-z0-9._-]` before writing `<token>.json`).
 * Rejects the sink's deterministic `.` + `<token>.tmp` mid-rename artifact (no
 * `.json` suffix) and anything else. Pure. Exported for unit reach.
 */
export function isStatuslineFilename(name: string): boolean {
  return /^[A-Za-z0-9._-]+\.json$/.test(name);
}

/** Raw leaf shape — only the fields the sink writes that we project. */
interface RawLeaf {
  session_id?: unknown;
  model_id?: unknown;
  model_display?: unknown;
  effort?: unknown;
  context_used_percentage?: unknown;
  context_input_tokens?: unknown;
  context_window_size?: unknown;
}

/** Coerce a value to a non-empty string, else null. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Coerce a value to a finite number, else null. */
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Coerce a value to an integer, else null. */
function asInteger(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build a `session-telemetry` message from a parsed leaf, or null when the leaf
 * has no usable `session_id` (the fold's only match key). The id is the RAW
 * `session_id` from the leaf CONTENT (never the sanitized filename). Every
 * optional field degrades to null independently.
 *
 * **Slot order is load-bearing** — the change-gate compares `JSON.stringify`
 * output byte-for-byte, and {@link seedFromDb}'s reconstruction must produce
 * identical key order, or every session re-emits on every daemon boot.
 */
export function buildTelemetryMessage(
  raw: RawLeaf,
): SessionTelemetryMessage | null {
  const id = asString(raw.session_id);
  if (id === null) {
    return null;
  }
  return {
    kind: "session-telemetry",
    id,
    model_id: asString(raw.model_id),
    model_display: asString(raw.model_display),
    effort: asString(raw.effort),
    used_percentage: asNumber(raw.context_used_percentage),
    input_tokens: asInteger(raw.context_input_tokens),
    window_size: asInteger(raw.context_window_size),
  };
}

/**
 * Serialize a telemetry message into the change-gate key — the byte-stable
 * string the worker compares to suppress re-emits for unchanged content.
 *
 * **`input_tokens` exclusion (load-bearing).** Every other field is included,
 * but `input_tokens` is omitted because it is a monotonically-advancing raw
 * token count; a leaf rewrite that only moved tokens would otherwise mint a
 * synthetic event. `used_percentage` STAYS in the gate — the sink pre-buckets it
 * to 5%, so the on-disk value only changes at a bucket boundary (a real move we
 * want to reflect), never per render.
 *
 * **Slot order is load-bearing** — {@link seedFromDb}'s reconstruction routes
 * through this SAME helper so a restart's seed key matches the live emit's key
 * byte-for-byte. Pure. Exported for unit reach.
 */
export function statuslineGateKey(msg: SessionTelemetryMessage): string {
  const { input_tokens: _inputTokens, ...gated } = msg;
  return JSON.stringify(gated);
}

/**
 * Pure, exported leaf scanner — the deterministic core, drivable in tests with
 * no Worker or watcher. It omits heartbeat and tombstone emission:
 *
 * - `onChange(path)` filters the basename ({@link isStatuslineFilename}),
 *   `stat`s + bounds + reads + safe-parses the CURRENT leaf, builds the message
 *   keyed on the RAW `session_id`, and emits ONLY when the content differs from
 *   the change-gate. A read-vs-delete race, an oversize file, a malformed parse,
 *   or a missing `session_id` all skip-and-log WITHOUT emitting (keep last good).
 * - `onDelete(path)` drops the path's gate entry so a re-created leaf re-emits.
 *   It NEVER emits a retraction: a leaf delete must not null the jobs telemetry
 *   columns (an ended row keeps its last-known values).
 *
 * The change-gate is keyed by the session id (== the jobs pk) and holds the
 * last-emitted {@link statuslineGateKey}. {@link seedFromDb} primes it from the
 * `jobs` telemetry columns so a restart's boot scan does not re-emit a session
 * already folded.
 */
export class StatuslineScanner {
  /** session id → last-emitted gate key (the content change-gate). */
  private readonly lastEmitted = new Map<string, string>();
  /** path → session id, so a delete drops the right gate entry. */
  private readonly pathToId = new Map<string, string>();

  constructor(
    private readonly onSnapshot: (msg: SessionTelemetryMessage) => void,
    private readonly log: (msg: string) => void = (m) => console.error(m),
  ) {}

  /**
   * Seed the change-gate for one session from the persisted projection so an
   * unchanged leaf on restart does not re-emit. The seed value MUST match the
   * serialization {@link buildTelemetryMessage} produces for the same row —
   * {@link seedFromDb} reconstructs the message from the jobs columns and
   * serializes it the same way.
   */
  seed(id: string, serialized: string): void {
    this.lastEmitted.set(id, serialized);
  }

  /**
   * Process a change for `path`. Filename-filter → reads (bounded) →
   * safe-parses → builds → change-gates → emits. Any failure skips-and-logs
   * without emitting.
   */
  onChange(path: string): void {
    if (!isStatuslineFilename(basename(path))) {
      return; // not a leaf we care about.
    }

    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch (err) {
      // Read-vs-delete race: skip-and-log, keep last good, don't emit.
      this.log(
        `[statusline-worker] stat failed for ${path}: ${stringifyErr(err)}`,
      );
      return;
    }
    if (!st.isFile()) {
      return;
    }
    if (st.size > MAX_LEAF_FILE_BYTES) {
      this.log(
        `[statusline-worker] ${path} exceeds ${MAX_LEAF_FILE_BYTES} bytes (${st.size}); skipping`,
      );
      return;
    }

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      this.log(
        `[statusline-worker] read failed for ${path}: ${stringifyErr(err)}`,
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.log(
        `[statusline-worker] malformed JSON in ${path}: ${stringifyErr(err)}`,
      );
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      this.log(`[statusline-worker] non-object JSON in ${path}; skipping`);
      return;
    }

    const msg = buildTelemetryMessage(parsed as RawLeaf);
    if (msg === null) {
      // No usable session_id — can't key the fold.
      this.log(
        `[statusline-worker] ${path} has no usable session_id; skipping`,
      );
      return;
    }

    this.pathToId.set(path, msg.id);
    const gateKey = statuslineGateKey(msg);
    if (this.lastEmitted.get(msg.id) === gateKey) {
      return; // content unchanged — suppress.
    }
    this.lastEmitted.set(msg.id, gateKey);
    this.onSnapshot(msg);
  }

  /**
   * Process a delete for `path`. Drops the gate entry (so a re-created leaf
   * re-emits) and NOTHING else — deliberately NO tombstone, so an ended row
   * keeps its last-known telemetry. A path never folded emits nothing anyway.
   */
  onDelete(path: string): void {
    const id = this.pathToId.get(path);
    if (id === undefined) {
      return;
    }
    this.pathToId.delete(path);
    this.lastEmitted.delete(id);
  }
}

/**
 * Boot scan: enumerate `<token>.json` leaves at `root` and run each through the
 * scanner. Flat dir — no recursion. Called once after the subscribe resolves so
 * leaves that pre-existed the daemon's boot are picked up without waiting for a
 * watcher event. The change-gate (seeded by {@link seedFromDb}) suppresses
 * re-emits for leaves that already match their folded jobs row. A missing root
 * is treated as empty. Exported for unit reach.
 */
export function scanRoot(root: string, scanner: StatuslineScanner): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return; // missing/unreadable root — nothing to scan.
  }
  for (const name of names) {
    if (!isStatuslineFilename(name)) {
      continue;
    }
    scanner.onChange(join(root, name));
  }
}

/**
 * Bounded leaf GC — the boot-scan sweep. The sink writes one leaf per session
 * and never deletes it, so without this pass keeper-owned leaves grow unbounded.
 * Deletes a leaf when its session is TERMINAL (`ended`/`killed` — its telemetry
 * is frozen; it will never render again) or ABSENT-and-STALE (no jobs row AND
 * older than {@link LEAF_TTL_MS} — a long-abandoned or pruned session). A leaf
 * for a live non-terminal session is ALWAYS kept, and a fresh absent leaf (one
 * racing its own SessionStart) survives the TTL floor — so GC never races the
 * sink into deleting an active session's leaf.
 *
 * Deleting a leaf does NOT retract the jobs telemetry (via {@link
 * StatuslineScanner.onDelete}, which emits nothing) — an ended row keeps its
 * last-known values. Read-only DB use; the filesystem unlink is best-effort
 * (a concurrent sink write / another sweep losing the file is ignored).
 * Exported for unit reach.
 */
export function gcSweep(
  db: Database,
  root: string,
  now: number,
  scanner: StatuslineScanner,
): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const stateById = new Map<string, string>();
  const rows = db.query("SELECT job_id, state FROM jobs").all() as {
    job_id: string;
    state: string;
  }[];
  for (const row of rows) {
    stateById.set(row.job_id, row.state);
  }
  for (const name of names) {
    if (!isStatuslineFilename(name)) {
      continue;
    }
    const full = join(root, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue; // vanished under us — nothing to GC.
    }
    if (!st.isFile()) {
      continue;
    }
    let sessionId: string | null = null;
    try {
      const parsed = JSON.parse(readFileSync(full, "utf8")) as RawLeaf;
      sessionId = asString(parsed.session_id);
    } catch {
      // Unreadable/torn leaf — treated as absent; the stale floor still guards.
    }
    const state = sessionId !== null ? stateById.get(sessionId) : undefined;
    const terminal = state !== undefined && TERMINAL_STATES.has(state);
    const absent = state === undefined;
    const stale = now - st.mtimeMs > LEAF_TTL_MS;
    if (!(terminal || (absent && stale))) {
      continue;
    }
    try {
      unlinkSync(full);
    } catch {
      continue; // race with the sink or another sweep — leave it.
    }
    scanner.onDelete(full); // drop any gate entry; never a retraction.
  }
}

/**
 * Seed the scanner's change-gate from the keeper DB: for each `jobs` row that
 * carries at least one telemetry column, reconstruct the message the scanner
 * would emit and seed its serialized form. A restart's full re-scan does not
 * re-emit a synthetic event for a session byte-identical to its folded row.
 *
 * **Slot order MUST match {@link buildTelemetryMessage}** field-for-field, since
 * the change-gate compares serialized messages. Rows with all-null telemetry are
 * skipped — they have never folded a snapshot, so the first leaf read SHOULD
 * emit. Read-only. Exported for the worker `main` and unit reach.
 */
export function seedFromDb(db: Database, scanner: StatuslineScanner): void {
  const rows = db
    .query(
      `SELECT job_id, current_model_id, current_model_display, current_effort,
              context_used_percentage, context_input_tokens, context_window_size
         FROM jobs
        WHERE current_model_id IS NOT NULL
           OR current_model_display IS NOT NULL
           OR current_effort IS NOT NULL
           OR context_used_percentage IS NOT NULL
           OR context_input_tokens IS NOT NULL
           OR context_window_size IS NOT NULL`,
    )
    .all() as {
    job_id: string;
    current_model_id: string | null;
    current_model_display: string | null;
    current_effort: string | null;
    context_used_percentage: number | null;
    context_input_tokens: number | null;
    context_window_size: number | null;
  }[];
  for (const r of rows) {
    const msg: SessionTelemetryMessage = {
      kind: "session-telemetry",
      id: r.job_id,
      model_id: r.current_model_id,
      model_display: r.current_model_display,
      effort: r.current_effort,
      used_percentage: r.context_used_percentage,
      input_tokens: r.context_input_tokens,
      window_size: r.context_window_size,
    };
    scanner.seed(r.job_id, statuslineGateKey(msg));
  }
}

/**
 * Worker entrypoint. Opens its own read-only connection, seeds the change-gate,
 * subscribes ONE recursive watch on the statusLine leaf dir (tolerates absence),
 * routes each change into the scanner, posts a message per changed leaf, and
 * runs the boot scan + GC once the subscribe resolves. The subscription is an
 * owned external resource — `unsubscribe()`d in the shutdown handler.
 */
function main(): void {
  if (!parentPort) {
    console.error(
      "[statusline-worker] no parentPort — not running as a Worker",
    );
    process.exit(1);
  }

  const data = workerData as StatuslineWorkerData | undefined;
  if (
    !data ||
    typeof data.dbPath !== "string" ||
    typeof data.root !== "string"
  ) {
    console.error("[statusline-worker] missing dbPath/root in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  const port = parentPort;
  const scanner = new StatuslineScanner((msg) => {
    port.postMessage(msg);
  });

  // Restart-seed: don't re-emit a snapshot already folded into the projection.
  try {
    seedFromDb(db, scanner);
  } catch (err) {
    // Non-fatal: worst case a stale snapshot re-emits once (the reducer's
    // latest-wins COALESCE fold makes that an idempotent no-op).
    console.error(
      `[statusline-worker] restart-seed failed: ${stringifyErr(err)}`,
    );
  }

  let subscription: AsyncSubscription | null = null;
  let scheduler: RescanScheduler | null = null;
  let shuttingDown = false;

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; exiting either way
    }
  };

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shuttingDown = true;
      // Clear armed drop-recovery timer FIRST so a pending re-scan can't fire
      // against a closing connection.
      if (scheduler !== null) {
        scheduler.cancel();
        scheduler = null;
      }
      void (async () => {
        if (subscription !== null) {
          try {
            await subscription.unsubscribe();
          } catch {
            // best-effort
          }
          subscription = null;
        }
        closeDb();
        process.exit(0);
      })();
    }
  });

  // Watcher seam: skip the native addon dlopen entirely in the in-process tier.
  // The parentPort listener keeps the event loop alive for the shutdown
  // handshake.
  if (data.disableNativeWatcher) {
    return;
  }

  void import("@parcel/watcher")
    .then((watcher) => {
      // Tolerate a missing root: no keeper-agent claude session may have
      // rendered a statusLine yet. Skip subscribe + scan; the next daemon
      // restart picks it up once the dir appears.
      if (!existsSync(data.root)) {
        console.error(
          `[statusline-worker] root ${data.root} does not exist; not watching (no session has rendered yet)`,
        );
        return;
      }

      // Drop-recovery: a recoverable FSEvents drop schedules a debounced,
      // single-flight re-scan via the change-gated boot-scan primitive — never
      // an unsubscribe+re-subscribe. The warm in-memory gate makes recovery
      // idempotent. The scan re-checks `shuttingDown` so a queued scan can't
      // touch a closing DB.
      const rescan = new RescanScheduler(() => {
        if (shuttingDown) {
          return;
        }
        scanRoot(data.root, scanner);
      });
      scheduler = rescan;

      watcher
        .subscribe(
          data.root,
          (err, events) => {
            if (err) {
              console.error(
                `[statusline-worker] watcher error for ${data.root}: ${stringifyErr(err)}`,
              );
              if (isDropError(err)) {
                rescan.schedule();
              }
              return;
            }
            for (const ev of events) {
              // Route on filename + existence, NOT event.type (the sink writes
              // via atomic rename, so an update may surface as create).
              if (ev.type === "delete") {
                scanner.onDelete(ev.path);
                continue;
              }
              scanner.onChange(ev.path);
            }
          },
          { ignore: [] },
        )
        .then((sub) => {
          if (shuttingDown) {
            void sub.unsubscribe();
            return;
          }
          subscription = sub;
          // Boot scan: pick up leaves that pre-existed this daemon's start (or
          // changed while keeperd was down). The change-gate suppresses
          // unchanged leaves.
          scanRoot(data.root, scanner);
          // Then the bounded leaf GC so terminal / long-abandoned leaves are
          // reclaimed. Runs AFTER the scan so a live session's fresh emit is
          // never pre-empted.
          try {
            gcSweep(db, data.root, Date.now(), scanner);
          } catch (err) {
            console.error(
              `[statusline-worker] boot GC failed: ${stringifyErr(err)}`,
            );
          }
        })
        .catch((err) => {
          console.error(
            `[statusline-worker] failed to subscribe to ${data.root}: ${stringifyErr(err)}`,
          );
        });
    })
    .catch((err) => {
      // The addon itself failed to load — the sole unrecoverable surface.
      console.error(
        `[statusline-worker] failed to load @parcel/watcher: ${stringifyErr(err)}`,
      );
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving the pure StatuslineScanner) is inert.
if (!isMainThread) {
  main();
}
