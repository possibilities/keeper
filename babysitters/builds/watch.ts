#!/usr/bin/env bun
/**
 * `babysitters/builds/watch.ts` — the read-only `builds` babysitter scanner
 * (epic fn-790 task .1). Watches buildbot CI for failing builds/steps across
 * every registered builder and silently collects ONE self-contained followup
 * per failure onset under `~/.local/state/babysitters/builds/followups/`.
 *
 * Modeled on the `performance` sitter (`babysitters/performance/watch.ts`) with
 * ONE structural difference: NO FINDINGS NOTIFICATIONS. There is no botctl page
 * on the findings path — the human works the collected corpus offline via
 * `/babysit-triage builds`. The sibling watchdog's dead-man staleness page is
 * the ONLY notification this sitter's machinery ever sends.
 *
 * This is its OWN binary, NOT a `keeper` subcommand.
 *
 * ## Surface — buildbot's `state.sqlite`, read strictly read-only
 *
 * Unlike the performance sitter (which reads keeper.db), this scanner opens
 * buildbot's `~/.local/state/buildbot/master/state.sqlite` via the read-only
 * SQLite `file:<path>?immutable=1` URI — a DIFFERENT database, so keeper's
 * `openDb`/resolvers are deliberately NOT used here. `immutable=1` (not a plain
 * `{ readonly: true }` open) is REQUIRED: buildbot runs WAL mode, and a plain
 * read-only open fails on macOS because it cannot touch the `-shm` coordination
 * file — `immutable` skips all locking and reads the main DB file directly (see
 * {@link openBuildbotDb}). The schema is pinned to buildbot 4.3.0
 * (`builds`/`builders`/`steps`). DEGRADE-DON'T-WEDGE: a missing DB,
 * `SQLITE_BUSY`, or a schema skew (buildbot upgraded) yields empty findings,
 * still stamps the heartbeat, and exits 0 — the watchdog's staleness page is the
 * safety net for a silent break.
 *
 * ## Detection — FAILURE / EXCEPTION builds, failed steps
 *
 * Per builder, walk completed builds past a per-builder high-water cursor
 * (stored in seen-state). A build with `complete_at` set and `results` in
 * {2 FAILURE, 4 EXCEPTION} yields findings from its failed steps (`steps.results`
 * a non-zero int — mirroring `~/code/arthack/system/buildbot/notify.py`
 * `_failed_steps`). Incomplete builds (`complete_at IS NULL`) and the
 * non-failure result codes (WARNINGS / SKIPPED / RETRY / CANCELLED) are skipped
 * — incomplete is the #1 false-positive class.
 *
 * ## Occurrence semantics — green CLEARS, red onset writes
 *
 * Unlike performance's cooldown/TTL model, this sitter is onset-triggered: a
 * seen (builder, step) entry SUPPRESSES re-followups while the step stays red;
 * observing that step GREEN clears its entry, so the next red onset writes a
 * fresh followup whose filename ts drives the ledger resurface rule. Cold start
 * writes followups for the currently-red steps — no silent baseline (with no
 * pages there is no storm, and pre-existing reds are exactly the backlog triage
 * wants).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../../src/db";
import { babysitterStateDir } from "../lib/state";

/** This sitter's concern slug — namespaces its state dir + plugin agent. */
const SLUG = "builds";

const HELP = `babysitter builds — watch [options]

Read-only buildbot CI scanner. Opens buildbot's state.sqlite read-only, detects
FAILURE/EXCEPTION builds' failed steps deterministically, and emits a Finding[].
Never writes any DB and NEVER pages on the findings path — the human works the
collected followup corpus via /babysit-triage builds. NOT a 'keeper' subcommand.

Options:
  --json   Emit { success: true, findings: [...] } instead of a table
  --tick   launchd entry: scan, diff vs seen-state, collect a followup per red
           onset. Silent (no page) always — the dead-man watchdog is the only
           notification. Exit 0 even when the buildbot DB is missing/locked.
  --help, -h   Show this help
`;

// ---------------------------------------------------------------------------
// Buildbot result codes (buildbot.process.results) — the page predicate.
// ---------------------------------------------------------------------------

/** Build/step `results`: 0 SUCCESS. Step 0 == passed; non-zero int == failed. */
export const SUCCESS = 0;
/** 2 FAILURE — a genuine red build (the dominant page class). */
export const FAILURE = 2;
/** 4 EXCEPTION — an errored build (infra/step crash). Also pages. */
export const EXCEPTION = 4;

/**
 * Build `results` codes that constitute a "red onset" worth collecting. Mirrors
 * notify.py's `results not in (FAILURE, EXCEPTION)` suppression — WARNINGS(1),
 * SKIPPED(3), RETRY(5), and CANCELLED(6) are deliberately NOT here (a cancelled
 * build is a master-shutdown artifact, not a real failure).
 */
const RED_BUILD_RESULTS = new Set<number>([FAILURE, EXCEPTION]);

// ---------------------------------------------------------------------------
// The Finding contract
// ---------------------------------------------------------------------------

/** Severity ordering drives the table sort. CI reds page warning by default. */
export type Severity = "info" | "warning" | "critical";

/**
 * The finding category, derived from the failed step's name class. A
 * `build-exception` covers a `results=4 EXCEPTION` build with NO failed step
 * (the build errored before/around steps), so an errored build always yields at
 * least one finding.
 */
export type Category =
  | "test-failure"
  | "lint-failure"
  | "typecheck-failure"
  | "build-exception";

/**
 * One detected condition: a failed (builder, step) pair (or a step-less
 * `build-exception`). `key` is the human-stable per-condition id; `fingerprint`
 * hashes ONLY (category, resourceId, version) so the same (builder, step) pair
 * fingerprints identically across builds — never a build number, which is a
 * cursor, not identity.
 */
export interface Finding {
  key: string;
  fingerprint: string;
  severity: Severity;
  category: Category;
  title: string;
  /** Human-readable one-liner; free-text, NEVER folded into the fingerprint. */
  detail: string;
  /** Structured evidence for the agent; free-form, NEVER in the fingerprint. */
  evidence: Record<string, unknown>;
}

/**
 * Fingerprint VERSION — bump when the detection semantics change in a way that
 * should re-fire a previously-seen condition. Folded into every fingerprint so a
 * semantics change invalidates the seen-state cleanly.
 */
export const FINGERPRINT_VERSION = 1;

/**
 * Stable fingerprint = hash of (category, resourceId, version). Accepts ONLY a
 * category + a stable resource id (no build numbers, timestamps, or free-text)
 * so the same (builder, step) pair fingerprints identically across builds.
 * `Bun.hash` is a fast non-crypto hash — fine for a dedup key (mirrors the
 * performance sitter's precedent).
 */
export function fingerprint(category: Category, resourceId: string): string {
  return String(Bun.hash(`${FINGERPRINT_VERSION} ${category} ${resourceId}`));
}

/**
 * Sanitize a step name (or any token) for safe embedding in the `:`-delimited
 * key and in followup filenames. `test:full` and `test.e2e` would otherwise
 * corrupt the `:`-delimited key — collapse `:` and `.` (and any other
 * non-`[A-Za-z0-9_-]`) to `_`, fold runs, strip edge `_`/`-`. Pure.
 */
export function sanitizeToken(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+/, "")
    .replace(/[_-]+$/, "");
}

/**
 * Classify a failed step's name into a finding category. The step-name classes
 * mirror the registered builders' suites: test/test:full/test:e2e/pytest/
 * test-all → `test-failure`; lint/ruff/zig-fmt → `lint-failure`;
 * typecheck/ty → `typecheck-failure`. An unrecognized failed step defaults to
 * `test-failure` (the broad-collector stance: a red step is in scope). Pure.
 */
export function categorizeStep(stepName: string): Category {
  const n = stepName.toLowerCase();
  if (n.includes("typecheck") || n === "ty") return "typecheck-failure";
  if (n.includes("lint") || n.includes("ruff") || n.includes("fmt")) {
    return "lint-failure";
  }
  // test / test:full / test:e2e / test-all / pytest / zig build … → test class.
  return "test-failure";
}

// ---------------------------------------------------------------------------
// Row shapes (the narrow projections the scan reads from buildbot's DB)
// ---------------------------------------------------------------------------

/** A `builders` row, projected to the columns the detector reads. */
export interface BuilderRow {
  id: number;
  name: string;
}

/** A `builds` row, projected to the columns the detector reads. */
export interface BuildRow {
  id: number;
  number: number;
  builderid: number;
  /** Unix secs the build completed; NULL while still running (skip those). */
  complete_at: number | null;
  /** Build result code; NULL while incomplete. */
  results: number | null;
}

/** A `steps` row, projected to the columns the detector reads. */
export interface StepRow {
  buildid: number;
  name: string;
  /** Step result; 0 SUCCESS, non-zero int == failed, NULL == not-run (skip). */
  results: number | null;
}

/**
 * The per-builder scan input: the builder's name + its completed builds past
 * the cursor (newest-first) + a buildid→failed-step-names map. Assembled by
 * `scan` from the read-only DB and fed to the pure {@link detectBuilderFindings}.
 */
export interface BuilderScan {
  builder: BuilderRow;
  /** Completed builds past the prior cursor, ordered by `number` DESCENDING. */
  builds: BuildRow[];
  /** buildid → the names of that build's failed steps (`steps.results != 0`). */
  failedSteps: Map<number, string[]>;
}

// ---------------------------------------------------------------------------
// Pure detector — one builder's completed-builds → findings + new cursor.
// ---------------------------------------------------------------------------

/**
 * The current observed redness of one builder, distilled from its most-recent
 * completed build: the set of (builder, step) findings currently red, plus the
 * high-water build number to persist as the next cursor. The seen-state fold
 * uses `currentlyRed` to decide which prior entries a now-green step CLEARS.
 */
export interface BuilderState {
  /** Findings for the builder's MOST-RECENT completed red build (current reds). */
  findings: Finding[];
  /** The highest completed build number seen — the next per-builder cursor. */
  cursor: number;
}

/**
 * Detect one builder's current redness from its completed builds (newest-first).
 *
 * Onset semantics: only the MOST-RECENT completed build defines current
 * redness — a builder that failed then went green is GREEN now, and its prior
 * reds must clear. So we read findings from the newest completed build only
 * (when it is FAILURE/EXCEPTION); older builds in the window advance the cursor
 * but never themselves write findings (a fixed-then-rebroken step re-onsets via
 * the green-clear → red-onset cycle on the seen-state, not by replaying history).
 *
 * A `results=4 EXCEPTION` build with NO failed step still yields one
 * `build-exception` finding (the build errored around its steps). Pure: takes
 * the assembled scan, returns findings + the new cursor. No I/O, no clock.
 */
export function detectBuilderFindings(scan: BuilderScan): BuilderState {
  const builderName = scan.builder.name;
  let cursor = 0;
  for (const b of scan.builds) if (b.number > cursor) cursor = b.number;

  // Newest completed build defines current redness (builds are number-DESC).
  const newest = scan.builds.length > 0 ? scan.builds[0] : null;
  if (
    newest === null ||
    newest.results === null ||
    !RED_BUILD_RESULTS.has(newest.results)
  ) {
    return { findings: [], cursor };
  }

  const findings: Finding[] = [];
  const failed = scan.failedSteps.get(newest.id) ?? [];
  for (const stepName of failed) {
    const category = categorizeStep(stepName);
    const safeStep = sanitizeToken(stepName);
    const safeBuilder = sanitizeToken(builderName);
    const resourceId = `${safeStep}:${safeBuilder}`;
    findings.push({
      key: `${category}:${resourceId}`,
      fingerprint: fingerprint(category, resourceId),
      severity: "warning",
      category,
      title: `${builderName} CI: ${stepName} failed`,
      detail: `step '${stepName}' failed on builder '${builderName}' (build #${newest.number})`,
      evidence: {
        builder: builderName,
        step: stepName,
        buildNumber: newest.number,
        buildResults: newest.results,
      },
    });
  }

  // An EXCEPTION build with no failed step still errored — surface it once.
  if (findings.length === 0 && newest.results === EXCEPTION) {
    const safeBuilder = sanitizeToken(builderName);
    const resourceId = safeBuilder;
    findings.push({
      key: `build-exception:${resourceId}`,
      fingerprint: fingerprint("build-exception", resourceId),
      severity: "warning",
      category: "build-exception",
      title: `${builderName} CI: build errored (EXCEPTION)`,
      detail: `build #${newest.number} on builder '${builderName}' errored (EXCEPTION) with no failed step`,
      evidence: {
        builder: builderName,
        buildNumber: newest.number,
        buildResults: newest.results,
      },
    });
  }

  return { findings, cursor };
}

// ---------------------------------------------------------------------------
// Seen-state — persistent dedup substrate + per-builder cursors for `--tick`.
//
// Lives at ~/.local/state/babysitters/builds/seen.json (its OWN dir, NOT a
// KEEPER_* path). Tracks the per-builder high-water cursor (clock-skew immune)
// and the currently-seen-red fingerprints. Written atomically; a corrupt /
// missing / version-skewed file loads as an empty state → a full rescan (the
// onset model self-heals: a rescan re-onsets every currently-red step).
// ---------------------------------------------------------------------------

/** seen.json schema version — bump on a breaking shape change to invalidate. */
export const SEEN_STATE_VERSION = 1;

/** Hard agent-spawn timeout (default 240s < the 300s launchd interval). */
export const AGENT_TIMEOUT_MS = 240_000;
/** Per-fingerprint spawn-retry cap — halt re-attempts after this many fails. */
export const MAX_SPAWN_RETRIES = 5;
/** The PLAIN claude binary (NOT the arthack-claude.py keeper-hook wrapper). */
export const PLAIN_CLAUDE_PATH = "/Users/mike/.local/bin/claude";

/**
 * One fingerprint's seen entry. Presence means "this (builder, step) was red as
 * of the last tick and a followup was (or was attempted to be) written" — it
 * SUPPRESSES re-collection while the step stays red. `spawn_failures` drives the
 * retry cap so a permanently-failing agent spawn does not retry every tick.
 */
export interface SeenEntry {
  first_seen: number;
  last_seen: number;
  /** Consecutive failed spawn attempts for this fingerprint (retry cap). */
  spawn_failures: number;
}

/**
 * The whole seen-state file: a version tag, per-builder cursors (build number
 * high-water marks), and a fingerprint→entry map of currently-red conditions.
 * No `baselined` flag — this sitter has NO silent baseline (cold start collects
 * currently-red onsets), so a fresh file simply rescans and onsets everything.
 */
export interface SeenState {
  version: number;
  /** builderName → highest completed build number scanned (the cursor). */
  cursors: Record<string, number>;
  fingerprints: Record<string, SeenEntry>;
}

/** An empty seen-state (cold start / corrupt-fallback → full rescan). */
export function emptySeenState(): SeenState {
  return { version: SEEN_STATE_VERSION, cursors: {}, fingerprints: {} };
}

/**
 * Resolve the buildbot `state.sqlite` path. `BUILDBOT_STATE_SQLITE` env wins
 * (tests point it at a seeded sandbox DB); otherwise the production default
 * `~/.local/state/buildbot/master/state.sqlite`. Pure (no I/O).
 */
export function resolveBuildbotDbPath(): string {
  const override = process.env.BUILDBOT_STATE_SQLITE;
  if (override && override.length > 0) return override;
  return join(
    homedir(),
    ".local",
    "state",
    "buildbot",
    "master",
    "state.sqlite",
  );
}

/**
 * Resolve the seen-state file path under `BABYSITTER_STATE_DIR` (default
 * `~/.local/state/babysitters/builds/seen.json`). Its OWN dir — NOT under any
 * KEEPER_* path. Pure (no I/O); mirrors the performance sitter's resolver shape.
 */
export function resolveSeenStatePath(): string {
  return join(babysitterStateDir(SLUG), "seen.json");
}

/**
 * Resolve the liveness-heartbeat file path — a sibling of seen.json. Written as
 * the LAST action on every completed tick path so a hung/crashed tick never
 * touches it; the standalone watchdog reads it and alarms when it goes stale.
 */
export function resolveHeartbeatPath(): string {
  return join(babysitterStateDir(SLUG), "heartbeat.json");
}

/** The followups corpus dir — one self-contained brief per red onset. */
export function resolveFollowupsDir(): string {
  return join(babysitterStateDir(SLUG), "followups");
}

/**
 * Atomically stamp the liveness heartbeat `{ ts }` at the END of a completed
 * tick. Attests "the builds sitter ran a tick to completion." DEGRADE-DON'T-
 * THROW: a write failure is swallowed (the watchdog's staleness alarm catches a
 * real death — a wedged tick is worse than a missed heartbeat).
 */
export function writeHeartbeat(path: string, nowSecs: number): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    atomicWriteFile(path, `${JSON.stringify({ ts: nowSecs })}\n`);
  } catch {
    // Swallow: never wedge a tick on a heartbeat write.
  }
}

/**
 * Load seen-state with corrupt/missing → empty fallback. NEVER throws: a
 * malformed file (bad JSON, wrong version, wrong shape) degrades to an empty
 * state, which triggers a full rescan — safe under the onset model (every
 * currently-red step simply re-onsets a fresh followup).
 */
export function loadSeenState(path: string): SeenState {
  if (!existsSync(path)) return emptySeenState();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return emptySeenState();
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== SEEN_STATE_VERSION) return emptySeenState();
    if (typeof obj.fingerprints !== "object" || obj.fingerprints === null) {
      return emptySeenState();
    }
    if (typeof obj.cursors !== "object" || obj.cursors === null) {
      return emptySeenState();
    }
    return {
      version: SEEN_STATE_VERSION,
      cursors: obj.cursors as Record<string, number>,
      fingerprints: obj.fingerprints as Record<string, SeenEntry>,
    };
  } catch {
    return emptySeenState();
  }
}

/**
 * Atomically persist seen-state. Creates the parent dir if missing, then writes
 * via the shared `atomicWriteFile` (tmp-in-same-dir + rename). Stable key order
 * so an unchanged re-write is byte-identical.
 */
export function saveSeenState(path: string, state: SeenState): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const cursors: Record<string, number> = {};
  for (const b of Object.keys(state.cursors).sort()) {
    cursors[b] = state.cursors[b];
  }
  const fingerprints: Record<string, SeenEntry> = {};
  for (const fp of Object.keys(state.fingerprints).sort()) {
    fingerprints[fp] = state.fingerprints[fp];
  }
  atomicWriteFile(
    path,
    `${JSON.stringify({ version: SEEN_STATE_VERSION, cursors, fingerprints }, null, 2)}\n`,
  );
}

// ---------------------------------------------------------------------------
// Onset diff — which currently-red findings are a NEW red onset this tick.
// ---------------------------------------------------------------------------

/**
 * Select the findings that need a collect attempt this tick. A finding is
 * selected when EITHER:
 *   - its fingerprint is absent from the prior seen-state — a genuinely NEW red
 *     onset (a step that was green / never observed and is now red), OR
 *   - its prior collect FAILED (`spawn_failures > 0`) and is still under the
 *     retry cap — RE-ATTEMPT (the followup was never actually written).
 *
 * A finding already seen with a SUCCESSFUL prior collect (`spawn_failures === 0`
 * and present last tick) is SUPPRESSED — no re-collection while it stays red. A
 * fingerprint at/over `MAX_SPAWN_RETRIES` failures is suppressed regardless.
 * Pure: no I/O.
 */
export function selectOnsets(present: Finding[], prior: SeenState): Finding[] {
  const out: Finding[] = [];
  for (const f of present) {
    const entry = prior.fingerprints[f.fingerprint];
    if (entry === undefined) {
      out.push(f);
      continue;
    }
    if (entry.spawn_failures >= MAX_SPAWN_RETRIES) continue;
    // A prior collect that failed (never wrote the followup) retries until the
    // cap; a successfully-collected red stays suppressed while it remains red.
    if (entry.spawn_failures > 0) out.push(f);
  }
  return out;
}

/**
 * Fold a completed tick into a fresh seen-state. Green CLEARS: a prior
 * fingerprint NOT present in this tick's reds is dropped (the step went green —
 * or its builder vanished — so a future red is a fresh onset). Every present
 * fingerprint is kept/refreshed; `spawnFailed` fingerprints increment their
 * retry counter. Cursors advance to this tick's per-builder high-water marks.
 *
 * Pure: takes the prior state + this tick's results, returns the new state.
 */
export function foldSeenState(input: {
  prior: SeenState;
  present: Finding[];
  cursors: Map<string, number>;
  spawnFailed: Set<string>;
  nowSecs: number;
}): SeenState {
  const { prior, present, cursors, spawnFailed, nowSecs } = input;
  const fingerprints: Record<string, SeenEntry> = {};
  for (const f of present) {
    const e = prior.fingerprints[f.fingerprint];
    fingerprints[f.fingerprint] = {
      first_seen: e?.first_seen ?? nowSecs,
      last_seen: nowSecs,
      spawn_failures: spawnFailed.has(f.fingerprint)
        ? (e?.spawn_failures ?? 0) + 1
        : 0,
    };
  }

  // Cursors: carry forward all prior cursors, overlay this tick's advances. A
  // builder with no new builds keeps its prior cursor (never regresses).
  const nextCursors: Record<string, number> = { ...prior.cursors };
  for (const [builder, n] of cursors) {
    const prev = nextCursors[builder] ?? 0;
    if (n > prev) nextCursors[builder] = n;
  }

  return {
    version: SEEN_STATE_VERSION,
    cursors: nextCursors,
    fingerprints,
  };
}

// ---------------------------------------------------------------------------
// The DB layer — open buildbot's state.sqlite read-only, assemble per-builder
// scans, run the pure detector. DEGRADE-DON'T-WEDGE on any DB fault.
// ---------------------------------------------------------------------------

/** Production scan result: findings (current reds) + per-builder cursors. */
export interface ScanResult {
  findings: Finding[];
  cursors: Map<string, number>;
}

/**
 * Open buildbot's `state.sqlite` for a read-only point-in-time scan via the
 * SQLite `file:<path>?immutable=1` URI (NOT keeper's `openDb` — this is
 * buildbot's DB, not keeper.db).
 *
 * Why `immutable=1` and not a plain `{ readonly: true }` open: buildbot runs its
 * DB in WAL mode, and a plain read-only open on macOS fails ("unable to open
 * database file") because SQLite needs to touch the `-shm` shared-memory file to
 * coordinate WAL reads and cannot create/lock it on a read-only handle. The
 * `immutable=1` flag tells SQLite the file will not change under us, so it skips
 * ALL locking and the `-shm`/`-wal` machinery and reads the main DB file
 * directly — the read-only-safe form that never disturbs buildbot's writer and
 * never needs sidecar write access. The trade-off: when a `-wal` is present,
 * `immutable` reads the main file only and can miss the freshest un-checkpointed
 * frames; buildbot checkpoints regularly, the scan re-runs every 5 min, and the
 * onset model re-onsets any red the moment it lands in the main file, so the
 * bounded staleness is acceptable (the alternative — failing to open — is worse).
 */
function openBuildbotDb(dbPath: string): Database {
  return new Database(`file:${dbPath}?immutable=1`, { readonly: true });
}

/**
 * Scan buildbot's `state.sqlite` read-only and emit the current reds + the
 * per-builder cursors. See {@link openBuildbotDb} for the read-only open form.
 *
 * DEGRADE-DON'T-WEDGE: any fault — missing file, `SQLITE_BUSY`, a schema skew
 * (buildbot upgraded past the pinned 4.3.0 `builds`/`builders`/`steps` shape) —
 * is caught and yields empty findings (the heartbeat is still stamped by the
 * caller and the tick exits 0). The watchdog's staleness page is the safety net
 * for a SILENT break (an empty scan when the DB is fine is indistinguishable
 * from a healthy all-green board — both correctly collect nothing).
 *
 * Per builder we read only the builds NEWER than the prior cursor (O(new
 * builds)), but always include the single newest completed build so the
 * green-clear path sees the current state even when no new build has landed.
 */
export function scan(dbPath: string, prior: SeenState): ScanResult {
  if (!existsSync(dbPath)) return { findings: [], cursors: new Map() };
  let db: Database | null = null;
  try {
    db = openBuildbotDb(dbPath);
    const builders = db
      .query("SELECT id, name FROM builders")
      .all() as BuilderRow[];

    const findings: Finding[] = [];
    const cursors = new Map<string, number>();

    for (const builder of builders) {
      const priorCursor = prior.cursors[builder.name] ?? 0;
      // Completed builds past the cursor, plus the single newest completed
      // build (so green-clear sees current state with no new build). Ordered
      // newest-first; bounded so a builder with thousands of builds stays cheap.
      const builds = db
        .query(
          `SELECT id, number, builderid, complete_at, results
             FROM builds
            WHERE builderid = ? AND complete_at IS NOT NULL
              AND (number > ? OR number = (
                    SELECT MAX(number) FROM builds
                     WHERE builderid = ? AND complete_at IS NOT NULL))
            ORDER BY number DESC
            LIMIT 200`,
        )
        .all(builder.id, priorCursor, builder.id) as BuildRow[];

      if (builds.length === 0) {
        // No builds at all (a fresh / removed builder) → scan to nothing, but
        // keep any prior cursor so it never regresses.
        if (priorCursor > 0) cursors.set(builder.name, priorCursor);
        continue;
      }

      // Failed steps only for the newest completed build (the redness source).
      const newest = builds[0];
      const failedRows = db
        .query(
          "SELECT buildid, name, results FROM steps WHERE buildid = ? AND results IS NOT NULL AND results != 0",
        )
        .all(newest.id) as StepRow[];
      const failedSteps = new Map<number, string[]>();
      const names = failedRows.map((r) => r.name);
      if (names.length > 0) failedSteps.set(newest.id, names);

      const state = detectBuilderFindings({ builder, builds, failedSteps });
      for (const f of state.findings) findings.push(f);
      const cursorVal = Math.max(state.cursor, priorCursor);
      if (cursorVal > 0) cursors.set(builder.name, cursorVal);
    }

    return { findings: sortFindings(findings), cursors };
  } catch {
    // Missing table / schema skew / SQLITE_BUSY / corruption → empty findings.
    return { findings: [], cursors: new Map() };
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// Agent spawn — invoke the PLAIN claude binary headless, hard-timeout-killed.
// The agent writes followups; it NEVER pages (no botctl on the findings path).
// ---------------------------------------------------------------------------

/** Repo root — cwd for the spawned agent so its Bash runs against the repo. */
const REPO_ROOT = "/Users/mike/code/keeper";

/** The babysitters plugin dir, loaded via `--plugin-dir` on the agent spawn. */
const BABYSITTERS_PLUGIN_DIR = `${REPO_ROOT}/babysitters`;

/** The scoped plugin-agent id (`<plugin>:<slug>`) the spawn delegates to. */
const TRIAGE_AGENT = `babysitters:${SLUG}`;

/** Outcome of an agent spawn: exit code (null on timeout) + acked keys. */
export interface SpawnResult {
  /** Process exit code; null iff the hard timeout fired and we killed it. */
  exitCode: number | null;
  /** Fingerprints the agent acked as written; null if no ack file written. */
  ackedFingerprints: string[] | null;
}

/** Injected so tests can capture argv without running a real claude. */
export type SpawnAgentFn = (input: {
  /** Frozen findings snapshot file the agent reads. */
  findingsFile: string;
  /** Ack file the agent writes collected fingerprints to. */
  ackFile: string;
  /** Combined stdout/stderr log file under the sitter state dir. */
  logFile: string;
}) => Promise<SpawnResult>;

/**
 * Production agent spawn (`Bun.spawn`). Invokes the PLAIN claude binary (keeps
 * the keeper hook UNLOADED) with `--plugin-dir <babysitters>` so the
 * `babysitters:builds` agent resolves, cwd = repo root, and
 * `--permission-mode bypassPermissions`. A hard `AbortController` timeout kills
 * a hung agent before the launchd interval. The agent's job is to WRITE one
 * followup per finding and ack — it pages nothing on the findings path.
 */
export async function spawnAgentLive(input: {
  findingsFile: string;
  ackFile: string;
  logFile: string;
}): Promise<SpawnResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  timer.unref?.();
  const logSink = Bun.file(input.logFile);
  const prompt =
    `Immediately invoke the Agent tool with agent_type "${TRIAGE_AGENT}" to collect the ` +
    `build-failure findings in ${input.findingsFile}. Write ONE self-contained followup ` +
    `file per finding (no notification — collect only). Write the fingerprints you ` +
    `collected (JSON array of strings) to ${input.ackFile}.`;
  let exitCode: number | null = null;
  try {
    const proc = Bun.spawn(
      [
        PLAIN_CLAUDE_PATH,
        "-p",
        prompt,
        "--plugin-dir",
        BABYSITTERS_PLUGIN_DIR,
        "--permission-mode",
        "bypassPermissions",
      ],
      {
        cwd: REPO_ROOT,
        stdin: "ignore",
        stdout: logSink,
        stderr: logSink,
        signal: controller.signal,
      },
    );
    exitCode = await proc.exited;
  } catch {
    exitCode = null;
  } finally {
    clearTimeout(timer);
  }
  let ackedFingerprints: string[] | null = null;
  if (exitCode === 0 && existsSync(input.ackFile)) {
    try {
      const parsed = JSON.parse(readFileSync(input.ackFile, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        ackedFingerprints = parsed.filter(
          (x): x is string => typeof x === "string",
        );
      }
    } catch {
      ackedFingerprints = null;
    }
  }
  return { exitCode, ackedFingerprints };
}

// ---------------------------------------------------------------------------
// The `--tick` flow — scan, diff vs seen-state, collect a followup per onset.
// ---------------------------------------------------------------------------

/** Deps injected into {@link tick} so the whole flow is testable. */
export interface TickDeps {
  /** Wall-clock seconds (injected so tests pin time). */
  nowSecs: () => number;
  /** Spawn the headless collector agent (defaults to {@link spawnAgentLive}). */
  spawnAgent: SpawnAgentFn;
}

/** Production {@link TickDeps}: real clock + the real claude spawn. */
export function liveTickDeps(): TickDeps {
  return { nowSecs: () => Date.now() / 1000, spawnAgent: spawnAgentLive };
}

/**
 * One launchd tick: scan the buildbot DB, diff current reds vs persistent
 * seen-state, and on each NEW red onset spawn the headless collector agent to
 * write one followup. Commits seen-state per the green-clear / onset model:
 *   - cold start → collects every currently-red onset (NO silent baseline);
 *   - a step still red since last tick → suppressed (no re-collection);
 *   - a step that went green → its seen entry CLEARED;
 *   - missing / locked / schema-skewed buildbot DB → empty scan, heartbeat
 *     stamped, exit 0 (degrade, never wedge).
 *
 * NEVER pages on the findings path — the agent writes followups only. The
 * dead-man watchdog's staleness page is the sole notification. Returns a small
 * result for the CLI + tests. Never throws on a corrupt file or DB fault.
 */
export async function tick(
  dbPath: string,
  deps: TickDeps,
  seenStatePath: string,
  heartbeatPath: string = resolveHeartbeatPath(),
): Promise<{
  spawned: boolean;
  onsetCount: number;
  collectedCount: number;
}> {
  const nowSecs = deps.nowSecs();
  const prior = loadSeenState(seenStatePath);
  const { findings, cursors } = scan(dbPath, prior);

  const onsets = selectOnsets(findings, prior);
  if (onsets.length === 0) {
    // Nothing new — fold (green-clear + cursor advance) and exit silently.
    saveSeenState(
      seenStatePath,
      foldSeenState({
        prior,
        present: findings,
        cursors,
        spawnFailed: new Set(),
        nowSecs,
      }),
    );
    writeHeartbeat(heartbeatPath, nowSecs);
    return { spawned: false, onsetCount: 0, collectedCount: 0 };
  }

  // Freeze the onset findings to a temp JSON snapshot for the collector agent.
  const stateDir = join(seenStatePath, "..");
  mkdirSync(stateDir, { recursive: true });
  const handedFingerprints = new Set(onsets.map((f) => f.fingerprint));
  const uid = `${process.pid}.${crypto.randomUUID()}`;
  const findingsFile = join(stateDir, `findings.${uid}.json`);
  const ackFile = join(stateDir, `ack.${uid}.json`);
  const logFile = join(stateDir, "agent.log");
  atomicWriteFile(
    findingsFile,
    `${JSON.stringify({ success: true, findings: onsets }, null, 2)}\n`,
  );

  let collected = new Set<string>();
  let spawnFailed = new Set<string>();
  try {
    const result = await deps.spawnAgent({ findingsFile, ackFile, logFile });
    if (result.exitCode === 0) {
      // Success: commit the acked fingerprints (fallback: no ack → all handed).
      if (result.ackedFingerprints !== null) {
        collected = new Set(
          result.ackedFingerprints.filter((fp) => handedFingerprints.has(fp)),
        );
      } else {
        collected = new Set(handedFingerprints);
      }
    } else {
      // Timeout / non-zero: count the failure so the retry cap eventually halts
      // a permanently-failing spawn. The fingerprint stays UNSEEN (not folded as
      // collected) so the next tick re-attempts — until the cap.
      spawnFailed = new Set(handedFingerprints);
    }
  } finally {
    rmSync(findingsFile, { force: true });
    rmSync(ackFile, { force: true });
  }

  // Fold: present reds keep/refresh their entry (collected → spawn_failures
  // reset); a handed-but-not-collected onset is recorded with a bumped failure
  // counter so it re-attempts next tick (it IS a present red, so it folds in).
  saveSeenState(
    seenStatePath,
    foldSeenState({
      prior,
      present: findings,
      cursors,
      spawnFailed,
      nowSecs,
    }),
  );

  writeHeartbeat(heartbeatPath, nowSecs);
  return {
    spawned: true,
    onsetCount: onsets.length,
    collectedCount: collected.size,
  };
}

// ---------------------------------------------------------------------------
// Output modes
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Stable sort: severity (critical first), then key. */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings.slice().sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    return a.key.localeCompare(b.key);
  });
}

/** Render the findings as a human-readable table on stdout. */
function printTable(findings: Finding[]): void {
  if (findings.length === 0) {
    process.stdout.write("babysitter builds: no findings\n");
    return;
  }
  const lines: string[] = [
    `babysitter builds: ${findings.length} finding(s)`,
    "",
  ];
  for (const f of findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.category}  ${f.key}`);
    lines.push(`    ${f.detail}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

interface ParsedArgs {
  json: boolean;
  tick: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, tick: false, help: false };
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--json") {
      parsed.json = true;
    } else if (a === "--tick") {
      parsed.tick = true;
    } else {
      process.stderr.write(`babysitter builds: unexpected argument '${a}'\n`);
      process.exit(2);
    }
  }
  return parsed;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.tick) {
    // The launchd entry: scan → diff vs seen-state → collect a followup per
    // onset. Always exits 0; pages nothing (the agent writes followups, the
    // watchdog is the only notification). A missing/locked DB degrades silently.
    await tick(
      resolveBuildbotDbPath(),
      liveTickDeps(),
      resolveSeenStatePath(),
      resolveHeartbeatPath(),
    );
    return;
  }
  const { findings } = scan(
    resolveBuildbotDbPath(),
    loadSeenState(resolveSeenStatePath()),
  );
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ success: true, findings })}\n`);
  } else {
    printTable(findings);
  }
}

if (import.meta.main) {
  void main(Bun.argv.slice(2));
}
