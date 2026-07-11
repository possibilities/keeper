/**
 * Builds producer worker. keeperd's FIRST outbound-HTTP producer — and the only
 * worker that polls a network endpoint instead of watching the filesystem. On a
 * fixed ~15s cadence it polls the local buildbot master's REST API, derives one
 * latest-build snapshot per registered (non-ghost) builder, and posts typed
 * `{kind:"build-snapshot"|"build-deleted", ...}` messages to the parent. Main
 * (and only main) turns those into synthetic `BuildSnapshot` / `BuildDeleted`
 * `events` rows, which the reducer folds into the `builds` projection. The worker
 * never writes the DB — it opens a READ-ONLY connection (for the restart-seed)
 * and only posts messages, keeping main the sole writer.
 *
 * Its polling driver follows the standard worker contract:
 * - `isMainThread`-guarded body — a plain `import` from a test is inert; the pure
 *   {@link BuildsScanner} core + the response-parsers are exported and drivable
 *   with no Worker or network.
 * - Own read-only `openDb(path, { readonly: true })` SOLELY to seed the
 *   change-gate from the `builds` projection on boot (a restart must NOT re-emit
 *   every builder).
 * - Typed message protocol: `{ kind: ... }` worker→main, `{ type: "shutdown" }`
 *   main→worker.
 *
 * **Poll loop shape (load-bearing, net-new — no existing worker has it).**
 * `setTimeout`-after-completion with an in-flight skip flag, NEVER `setInterval`:
 * a hung cycle skips its slot, it never queues an overlapping request. Each fetch
 * gets a MANUAL `AbortController` deadline (`AbortSignal.timeout()` mis-fires on
 * Bun/macOS, oven-sh/bun#7512) with `clearTimeout` in a `finally`, combined with
 * the worker's shutdown signal via `AbortSignal.any` so shutdown aborts an
 * in-flight request; the shutdown handler also clears the pending timer. Fixed
 * cadence, no backoff, no circuit breaker — failures degrade silently, we keep
 * polling indefinitely, and the TUI renders age.
 *
 * **Transient-error containment (the keystone safety property).** EVERY transient
 * failure — fetch rejection, non-2xx, non-JSON 200 body, a partial cycle — is
 * caught INSIDE the loop and degrades to a silent no-op. None may reach the
 * worker's top-level error path: main wires `onerror`/`close` to `fatalExit`, and
 * buildbot being down must NOT crash-loop the daemon. The change-gate is
 * PRESERVED across a fetch failure (a reset would emit spurious events on
 * recovery), and per-builder fetches are isolated (one failed builder skips
 * itself and preserves its gate; the others proceed).
 *
 * **Disappearance is enumeration-gated.** A builder present in the seeded/seen
 * set but ABSENT from a SUCCESSFUL `/api/v2/builders` enumeration is tombstoned
 * (`build-deleted`). Deletion is NEVER inferred from a failed cycle — a transient
 * outage must not retract every row.
 */

import type { Database } from "bun:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db";
import type { BuildSnapshotPayload } from "./reducer";
import type { ShutdownMessage } from "./wake-worker";

/** Default poll cadence — fixed, no backoff. Overridable via workerData (tests). */
const DEFAULT_POLL_MS = 15_000;
/** Per-fetch abort deadline. Manual AbortController; AbortSignal.timeout is buggy on Bun/macOS. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only
 * JSON-serializable values cross the boundary — the Database handle cannot.
 */
export interface BuildsWorkerData {
  dbPath: string;
  /**
   * The buildbot master base URL (e.g. `http://localhost:8010`). The parent
   * resolves this from {@link import("./db").resolveBuildbotUrl}; the worker is
   * never spawned when it is absent, so this is always a non-empty string here.
   */
  buildbotUrl: string;
  /** Poll cadence override (ms) for tests; production omits it → {@link DEFAULT_POLL_MS}. */
  pollMs?: number;
}

/**
 * Snapshot message for one builder's latest build. The builder NAME (the
 * projection pk) rides in `project`; the rest mirrors {@link BuildSnapshotPayload}
 * plus `state_string` (captured for display, EXCLUDED from the change-gate so a
 * running→finished transition emits exactly two events, start + finish).
 */
export interface BuildSnapshotMessage extends BuildSnapshotPayload {
  kind: "build-snapshot";
  /** Builder name — the projection pk; rides in the synthetic event's session_id. */
  project: string;
}

/**
 * Tombstone message for a builder that disappeared from a SUCCESSFUL enumeration
 * (removed from config or gone ghost). Main turns it into a synthetic
 * `BuildDeleted` event; the reducer DELETEs the `builds` row.
 */
export interface BuildDeletedMessage {
  kind: "build-deleted";
  /** Builder name — the projection pk; rides in the synthetic event's session_id. */
  project: string;
}

/** Either snapshot or tombstone message the worker posts to the parent. */
export type BuildsMessage = BuildSnapshotMessage | BuildDeletedMessage;

/** One registered builder from `/api/v2/builders` enumeration. */
export interface BuilderRef {
  name: string;
  builderid: number | null;
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Coerce to an integer, else null. */
function asInteger(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/** Coerce to a finite number, else null. */
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Serialize a snapshot message into the change-gate key — the byte-stable string
 * the worker compares to suppress re-emits for unchanged content.
 *
 * **Gate identity = exactly `(build_number, complete, results, started_at,
 * complete_at)`.** `state_string` and `builder_id` are EXCLUDED: `state_string`
 * advances on intermediate progress lines (a running build re-emits otherwise),
 * and the NAME (not the numeric id) is the stable key. Excluding `state_string`
 * is what makes one build emit exactly two events (start, finish). The key omits
 * `project` because the gate is already keyed by name (the map key), so two
 * builders never collide.
 *
 * Pure. Exported for unit reach (the state_string-exclusion tripwire test).
 */
export function buildsGateKey(msg: BuildSnapshotMessage): string {
  return JSON.stringify({
    build_number: msg.build_number,
    complete: msg.complete,
    results: msg.results,
    started_at: msg.started_at,
    complete_at: msg.complete_at,
  });
}

/**
 * Parse a `/api/v2/builders` response body into the list of registered,
 * non-ghost builders. Buildbot wraps the array in `{"builders": [...]}`. A ghost
 * builder (empty/absent `masterids`) is a dead config leftover — filtered here so
 * it never produces a projection row. A builder with no usable name is dropped.
 * Pure; returns `[]` on any shape mismatch (the caller treats `[]` as "enumerated
 * zero builders", distinct from a failed enumeration).
 */
export function parseBuilders(body: unknown): BuilderRef[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const arr = (body as { builders?: unknown }).builders;
  if (!Array.isArray(arr)) {
    return [];
  }
  const out: BuilderRef[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const e = entry as {
      name?: unknown;
      builderid?: unknown;
      masterids?: unknown;
    };
    const name =
      typeof e.name === "string" && e.name.length > 0 ? e.name : null;
    if (name === null) {
      continue;
    }
    // Ghost filter: a builder with no masters is a dead config leftover.
    if (!Array.isArray(e.masterids) || e.masterids.length === 0) {
      continue;
    }
    out.push({ name, builderid: asInteger(e.builderid) });
  }
  return out;
}

/** Sentinel `state_string` carried by a never-built builder's placeholder. */
export const NEVER_BUILT_STATE = "never built";

/**
 * Parse a `/api/v2/builders/<id>/builds?order=-number&limit=1` response into a
 * snapshot message for `project`, or null when there is no build to report.
 *
 * Two distinct outcomes for the absence of a build:
 * - A registered-but-never-built builder returns HTTP 200 + `{"builds": []}`.
 *   That parsed-empty-array is the ONLY null-producing shape promoted to an
 *   all-null-build-fields placeholder snapshot (carrying `builder_id` + the
 *   constant {@link NEVER_BUILT_STATE} sentinel), so the builder renders as a
 *   distinct `never built` row instead of staying invisible.
 * - Every other shape that carries no usable build — a non-object body, a
 *   missing or non-array `builds`, an array of non-objects — still returns
 *   null (the caller skips that builder, preserving its gate). A transient
 *   per-builder FETCH failure is handled upstream in `runPollCycle` (a null
 *   body never reaches here), so the placeholder is never minted from a
 *   failure: the two `null` sources stay un-conflated.
 *
 * Pure; the placeholder payload is fully deterministic (no wall-clock / env),
 * so the resulting BuildSnapshot event re-folds byte-identically.
 */
export function parseLatestBuild(
  project: string,
  builderid: number | null,
  body: unknown,
): BuildSnapshotMessage | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const arr = (body as { builds?: unknown }).builds;
  if (!Array.isArray(arr)) {
    return null; // missing / non-array `builds` — emit nothing.
  }
  if (arr.length === 0) {
    // Registered-but-never-built: a true empty enumeration (HTTP 200 +
    // `{"builds":[]}`). Mint an all-null placeholder so the builder renders as
    // a distinct `never built` row. `state_string` and `builder_id` are
    // EXCLUDED from the gate key, so this emits exactly once; when the builder
    // later runs, `build_number` moves and the real snapshot supersedes it.
    return {
      kind: "build-snapshot",
      project,
      builder_id: builderid,
      build_number: null,
      complete: null,
      results: null,
      state_string: NEVER_BUILT_STATE,
      started_at: null,
      complete_at: null,
    };
  }
  const b = arr[0];
  if (!b || typeof b !== "object") {
    return null;
  }
  const build = b as {
    number?: unknown;
    complete?: unknown;
    results?: unknown;
    state_string?: unknown;
    started_at?: unknown;
    complete_at?: unknown;
  };
  // complete: buildbot sends a JSON boolean; 1/0 tolerated. Anything else → null.
  const completeRaw = build.complete;
  const complete: 1 | 0 | null =
    completeRaw === true || completeRaw === 1
      ? 1
      : completeRaw === false || completeRaw === 0
        ? 0
        : null;
  return {
    kind: "build-snapshot",
    project,
    builder_id: builderid,
    build_number: asInteger(build.number),
    complete,
    // results is null while a build runs (complete:false); a number when finished.
    results: asInteger(build.results),
    state_string:
      typeof build.state_string === "string" ? build.state_string : null,
    started_at: asNumber(build.started_at),
    complete_at: asNumber(build.complete_at),
  };
}

/**
 * Pure, exported change-gate + disappearance tracker — the deterministic core,
 * drivable in tests with no Worker or network. The gate is keyed by entity name
 * and seeded from the projection so a restart does not re-emit unchanged rows.
 */
export class BuildsScanner {
  /** builder name → last-emitted gate key (the change-gate). */
  private readonly lastEmitted = new Map<string, string>();
  /**
   * Every builder name the worker has ever seeded or observed in a SUCCESSFUL
   * enumeration — the set {@link reconcileEnumeration} diffs a fresh successful
   * enumeration against to find disappearances.
   */
  private readonly seen = new Set<string>();

  constructor(private readonly onMessage: (msg: BuildsMessage) => void) {}

  /**
   * Seed the change-gate + seen-set for one builder from the persisted
   * projection so an unchanged build on restart does not re-emit. The seed value
   * MUST match the gate key {@link buildsGateKey} produces for the live message —
   * {@link seedFromDb} reconstructs it from projection columns.
   */
  seed(project: string, gateKey: string): void {
    this.lastEmitted.set(project, gateKey);
    this.seen.add(project);
  }

  /**
   * Apply one builder's latest-build snapshot. Records the builder as seen,
   * change-gates, and emits a `build-snapshot` ONLY when the gate key differs.
   * `state_string` is carried in the message but EXCLUDED from the gate key, so a
   * running build whose only change is its progress line is suppressed.
   */
  applySnapshot(msg: BuildSnapshotMessage): void {
    this.seen.add(msg.project);
    const gateKey = buildsGateKey(msg);
    if (this.lastEmitted.get(msg.project) === gateKey) {
      return; // change-gate: unchanged build, suppress.
    }
    this.lastEmitted.set(msg.project, gateKey);
    this.onMessage(msg);
  }

  /**
   * After a SUCCESSFUL enumeration, retract any previously-seen builder whose
   * name is absent from the fresh enumeration — a config removal or a builder
   * gone ghost. Emits a `build-deleted` per disappearance and drops its gate +
   * seen entry. MUST be called ONLY with the names from a successful
   * `/api/v2/builders` cycle; a failed cycle must never reach here (deletion is
   * never inferred from a failure).
   */
  reconcileEnumeration(presentNames: Iterable<string>): void {
    const present = new Set(presentNames);
    for (const name of [...this.seen]) {
      if (present.has(name)) {
        continue;
      }
      this.onMessage({ kind: "build-deleted", project: name });
      this.lastEmitted.delete(name);
      this.seen.delete(name);
    }
  }
}

/**
 * Seed the scanner's change-gate from the keeper DB: for each persisted `builds`
 * row, reconstruct the gate key the scanner would compute and seed it. A daemon
 * restart against an unchanged buildbot does not re-emit a synthetic event per
 * builder.
 *
 * **Field set MUST match {@link buildsGateKey}** — the gate compares keys, so any
 * drift here re-emits every builder on every boot. `state_string` / `builder_id`
 * are read but never enter the key (mirrors the live gate). Read-only — uses the
 * worker's own read-only connection. Exported for the worker `main` and unit reach.
 */
export function seedFromDb(db: Database, scanner: BuildsScanner): void {
  const rows = db
    .query(
      `SELECT project, builder_id, build_number, complete, results,
              state_string, started_at, complete_at
         FROM builds`,
    )
    .all() as {
    project: string;
    builder_id: number | null;
    build_number: number | null;
    complete: number | null;
    results: number | null;
    state_string: string | null;
    started_at: number | null;
    complete_at: number | null;
  }[];
  for (const r of rows) {
    const complete: 1 | 0 | null =
      r.complete === 1 ? 1 : r.complete === 0 ? 0 : null;
    const msg: BuildSnapshotMessage = {
      kind: "build-snapshot",
      project: r.project,
      builder_id: r.builder_id,
      build_number: r.build_number,
      complete,
      results: r.results,
      state_string: r.state_string,
      started_at: r.started_at,
      complete_at: r.complete_at,
    };
    scanner.seed(r.project, buildsGateKey(msg));
  }
}

/**
 * Fetch + JSON-parse one buildbot REST endpoint under a manual abort deadline,
 * combined with the worker's shutdown signal. Returns the parsed body, or null
 * on ANY failure (fetch rejection, non-2xx, non-JSON body, abort). NEVER throws —
 * a transient error must degrade to a silent no-op inside the poll loop, never
 * reaching the worker's top-level error path. Exported for unit reach.
 */
export async function fetchJson(
  url: string,
  shutdownSignal: AbortSignal,
): Promise<unknown | null> {
  const controller = new AbortController();
  // Manual deadline — AbortSignal.timeout() mis-fires on Bun/macOS (bun#7512).
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.any([controller.signal, shutdownSignal]),
    });
    if (!res.ok) {
      return null; // non-2xx — silent no-op, gate preserved.
    }
    return (await res.json()) as unknown;
  } catch {
    // Fetch rejection, abort, or non-JSON body — silent no-op.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run ONE poll cycle against the buildbot master. Enumerates builders (ghost
 * filter), fetches each builder's latest build, applies snapshots through the
 * change-gate, and reconciles disappearances — but ONLY when the top-level
 * enumeration SUCCEEDED. A failed enumeration returns early WITHOUT touching the
 * gate or emitting any tombstone (deletion is never inferred from a failure). A
 * single failed per-builder fetch skips that builder and preserves its gate; the
 * others proceed. Exported for unit reach (drivable with a stubbed `fetchJson`).
 */
export async function runPollCycle(
  baseUrl: string,
  scanner: BuildsScanner,
  shutdownSignal: AbortSignal,
  fetcher: (
    url: string,
    signal: AbortSignal,
  ) => Promise<unknown | null> = fetchJson,
): Promise<void> {
  const root = baseUrl.replace(/\/+$/, "");
  const buildersBody = await fetcher(`${root}/api/v2/builders`, shutdownSignal);
  if (buildersBody === null) {
    return; // failed enumeration — preserve gate, emit nothing, infer no deletion.
  }
  const builders = parseBuilders(buildersBody);
  for (const builder of builders) {
    const id = builder.builderid ?? encodeURIComponent(builder.name);
    const buildsBody = await fetcher(
      `${root}/api/v2/builders/${id}/builds?order=-number&limit=1`,
      shutdownSignal,
    );
    if (buildsBody === null) {
      // Per-builder fetch failed — skip this builder, preserve its gate. It was
      // present in the enumeration, so the reconcile below won't tombstone it.
      continue;
    }
    const snapshot = parseLatestBuild(
      builder.name,
      builder.builderid,
      buildsBody,
    );
    if (snapshot === null) {
      // Never-built builder — emit nothing. It's present in the enumeration, so
      // the reconcile below won't tombstone it.
      continue;
    }
    scanner.applySnapshot(snapshot);
  }
  // Enumeration succeeded — every name buildbot returned (regardless of its
  // per-builder fetch outcome) is "present"; retract any previously-seen builder
  // absent from this list.
  scanner.reconcileEnumeration(builders.map((b) => b.name));
}

/**
 * Worker entrypoint. Opens its own read-only connection, seeds the change-gate,
 * and drives the poll loop (setTimeout-after-completion, in-flight skip, abort
 * deadline). Shutdown aborts the in-flight fetch and clears the pending timer.
 */
function main(): void {
  if (!parentPort) {
    console.error("[builds-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as BuildsWorkerData | undefined;
  if (
    !data ||
    typeof data.dbPath !== "string" ||
    typeof data.buildbotUrl !== "string" ||
    data.buildbotUrl.length === 0
  ) {
    console.error("[builds-worker] missing dbPath/buildbotUrl in workerData");
    process.exit(1);
  }

  const pollMs =
    typeof data.pollMs === "number" && data.pollMs > 0
      ? data.pollMs
      : DEFAULT_POLL_MS;

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  const port = parentPort;
  const scanner = new BuildsScanner((msg) => {
    port.postMessage(msg);
  });

  // Restart-seed: don't re-emit a snapshot already folded into the projection.
  try {
    seedFromDb(db, scanner);
  } catch (err) {
    // Non-fatal: worst case a stale snapshot re-emits once (the reducer's
    // idempotent upsert makes that a no-op anyway).
    console.error(`[builds-worker] restart-seed failed: ${stringifyErr(err)}`);
  }

  const shutdownController = new AbortController();
  let shuttingDown = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; exiting either way
    }
  };

  // setTimeout-after-completion (NOT setInterval): schedule the NEXT cycle only
  // once the current one finishes, so a hung cycle skips its slot instead of
  // queueing an overlapping request.
  const scheduleNext = (): void => {
    if (shuttingDown) {
      return;
    }
    timer = setTimeout(() => {
      void tick();
    }, pollMs);
  };

  const tick = async (): Promise<void> => {
    // In-flight skip: a slow cycle that outran its slot must not stack. (With
    // setTimeout-after-completion this is belt-and-suspenders, but it pins the
    // invariant.)
    if (inFlight || shuttingDown) {
      return;
    }
    inFlight = true;
    try {
      await runPollCycle(data.buildbotUrl, scanner, shutdownController.signal);
    } catch (err) {
      // Defense in depth: runPollCycle is internally no-throw, but a bug here
      // must still never reach onerror/fatalExit and crash-loop the daemon.
      console.error(
        `[builds-worker] poll cycle threw (non-fatal): ${stringifyErr(err)}`,
      );
    } finally {
      inFlight = false;
    }
    scheduleNext();
  };

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shuttingDown = true;
      // Clear the pending timer FIRST so no new cycle starts, then abort any
      // in-flight fetch, then release the db and exit clean.
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      shutdownController.abort();
      closeDb();
      process.exit(0);
    }
  });

  // Kick the first cycle immediately (don't wait a full interval for boot data).
  void tick();
}

// Only run inside a real Worker; a plain import on the main thread (tests driving
// the pure BuildsScanner / parsers) is inert.
if (!isMainThread) {
  main();
}
