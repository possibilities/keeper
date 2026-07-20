#!/usr/bin/env bun
/**
 * `keeper builds` — watch the keeperd `builds` collection as frames.
 *
 * The dashboard surface for the buildbot poller (epic fn-781): one row per
 * registered buildbot builder, showing the latest build's status, number,
 * state string, and age. Data rides keeper's full event-sourced pipeline —
 * the daemon-side builds-worker polls the buildbot REST API and folds
 * synthetic `BuildSnapshot` / `BuildDeleted` events into the `builds`
 * projection (one row per builder, keyed by builder NAME). This is the
 * read-only TUI for that surface, mirroring the sibling `cli/git.ts`.
 *
 * Built on the `cli/git.ts` template: parseArgs, snapshot-vs-live mode
 * resolution, `createViewShell` wiring, and a `subscribeCollection` call.
 * The exported pure `renderRowLines` / `renderRow` survive into
 * `test/builds.test.ts` as the asserted row layout.
 *
 * Status is mapped from buildbot result codes (0 SUCCESS, 1 WARNINGS,
 * 2 FAILURE, 3 SKIPPED, 4 EXCEPTION, 5 RETRY, 6 CANCELLED). A NULL
 * `results` with `complete=0` is a RUNNING build — a documented state, not
 * an error. A NULL `build_number` is a registered-but-never-built builder,
 * rendered as the distinct neutral `never built` state (the all-null
 * placeholder the daemon-side worker mints for a `{"builds":[]}` enumeration)
 * — checked before RUNNING so it never collapses into it. Age is derived
 * client-side from `updated_at` (cosmetic render concern, never folded).
 *
 * Each row also carries a `[build]`/`[deploy]`/`[install]` job-type tag
 * (epic fn-891). The tag is derived purely at render time from the builder
 * NAME suffix (`-deploy` → deploy, `-install`/`-doctor` → install, else
 * build) — the arthack-side builder-name convention is the only contract;
 * the `builds` projection has no `tags` field and is never touched here.
 *
 * Connection lifecycle is owned by `subscribeCollection` in
 * `src/readiness-client.ts` (same reconnect / coalesce / dispose contract
 * as the sibling views). This module's job is rendering rows; the helper
 * handles everything below.
 */

import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  createFramesEmitter,
  defaultDiffFn,
  defaultFramesIo,
} from "../src/frames-emitter";
import { subscribeCollection } from "../src/readiness-client";
import { resolveSnapshotMode, SnapshotCliMisuseError } from "../src/snapshot";
import { createViewShell } from "../src/view-shell";
import { buildParseOptions, VIEWER_FLAGS } from "./descriptor";
import { parseDuration } from "./duration";

const COLLECTION = "builds";

const HELP = `keeper builds — live buildbot status frames over the keeper subscribe server

Usage: keeper builds [--sock <path>] [--snapshot | --watch] [--timeout <dur>]

  --sock <path>   Socket path override ($KEEPER_SOCK / default otherwise)
  --snapshot      Force one-shot snapshot mode (print one frame + a
                  machine-parseable keeper-meta: line, then exit) even
                  on a TTY
  --watch         Force the live subscribe stream even when piped
  --timeout <dur> Snapshot wait before the timeout escape (default ~2s;
                  unit required, e.g. 500ms, 2s)
  --help          Show this help

By default, stdout that is NOT a TTY (piped into an agent) auto-detects
snapshot mode; a TTY gets the live TUI. \`CI\` / \`TERM=dumb\` force snapshot.

Rows show one registered buildbot builder: project name, a job-type tag
(\`[build]\` / \`[deploy]\` / \`[install]\`, derived from the builder-name
suffix), a status glyph + label (SUCCESS / WARNINGS / FAILURE / SKIPPED /
EXCEPTION / RETRY / CANCELLED / RUNNING / never built), the latest build
number, the build state string, and an age. RUNNING (\`results\` NULL, build
in flight) is a normal state, not an error; "never built" (no build number) is
a registered builder that has not yet produced a build — also normal, neither
broken nor in progress. An empty table means NO registered builders at all —
is \`buildbot_url\` configured?
`;

/**
 * One status code → glyph + label mapping. Buildbot result codes plus the
 * synthetic RUNNING state (results NULL while the build is in flight).
 * Glyphs are ASCII-safe so a dumb terminal / piped snapshot renders cleanly.
 */
interface Status {
  readonly glyph: string;
  readonly label: string;
}

const RUNNING: Status = { glyph: "~", label: "RUNNING" };
const UNKNOWN: Status = { glyph: "?", label: "UNKNOWN" };
// A registered builder that has never produced a build (no `build_number`).
// A distinct NEUTRAL state — not `unknown` (read as "CI broke") nor `running`
// (read as "in progress"). Glyph `.` is ASCII-safe and distinct from `~`
// (running), `?` (unknown), and `-` (skipped).
const NEVER_BUILT: Status = { glyph: ".", label: "never built" };

const RESULT_STATUS: Record<number, Status> = {
  0: { glyph: "ok", label: "SUCCESS" },
  1: { glyph: "!", label: "WARNINGS" },
  2: { glyph: "X", label: "FAILURE" },
  3: { glyph: "-", label: "SKIPPED" },
  4: { glyph: "E", label: "EXCEPTION" },
  5: { glyph: "@", label: "RETRY" },
  6: { glyph: "/", label: "CANCELLED" },
};

/**
 * Resolve the display status from a builds row. Branch order is load-bearing:
 *
 * 1. A NULL `build_number` is a registered-but-never-built builder — the
 *    all-null placeholder the worker mints for `{"builds":[]}`. This is
 *    checked FIRST, before the RUNNING test, so a placeholder (whose `results`
 *    is also NULL) renders as the distinct neutral NEVER_BUILT state rather
 *    than collapsing into RUNNING.
 * 2. A NULL `results` with `complete` falsy is RUNNING (in-flight build).
 * 3. Otherwise map the numeric buildbot result code; an out-of-range /
 *    non-numeric code degrades to UNKNOWN rather than throwing at the read
 *    boundary.
 */
export function resolveStatus(row: Record<string, unknown>): Status {
  const results = row.results;
  const complete = row.complete;
  if (row.build_number == null) return NEVER_BUILT;
  if (results == null && !complete) return RUNNING;
  if (typeof results === "number" && results in RESULT_STATUS) {
    return RESULT_STATUS[results] as Status;
  }
  return UNKNOWN;
}

/**
 * One builder-name suffix → job-type tag mapping (epic fn-891). The builder
 * NAME (the `project` PK string) is the sole contract with the arthack-side
 * buildbot config: a `-deploy` suffix is a deploy job, `-install`/`-doctor`
 * is an install-family job (doctor folds into install), everything else is a
 * plain build. ASCII-safe, render-time only — the `builds` projection has no
 * `tags` field and stays a deterministic-replayed, never-touched-here surface.
 */
const JOB_TYPE_SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ["-deploy", "deploy"],
  ["-install", "install"],
  ["-doctor", "install"],
];

/**
 * Resolve the job-type tag from a builder name. Pure, suffix-driven (see
 * `JOB_TYPE_SUFFIXES`); an unsuffixed or empty name is a plain `build`.
 */
export function resolveJobType(project: string): string {
  for (const [suffix, type] of JOB_TYPE_SUFFIXES) {
    if (project.endsWith(suffix)) return type;
  }
  return "build";
}

/**
 * Humanize an age in milliseconds into a compact `Nm`/`Nh`/`Nd` token. A
 * negative or non-finite age (clock skew, missing `updated_at`) renders as
 * `?`. Whole-unit only — this is a glanceable affordance, not a precise
 * duration.
 */
export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "?";
  const secs = Math.floor(ageMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function seg(v: unknown): string {
  return v == null ? "" : String(v);
}

/**
 * Render one builds row into a single display line:
 *
 *   <glyph> <project>  #<build_number>  <LABEL>  <state_string>  <age>
 *
 * `now` is injected (the caller passes `Date.now()`) so the renderer stays
 * a pure function for unit tests — wall-clock age is a cosmetic render
 * concern, never folded.
 */
export function renderRow(row: Record<string, unknown>, now: number): string {
  const status = resolveStatus(row);
  const project = seg(row.project) || "(unnamed)";
  const jobType = `[${resolveJobType(seg(row.project))}]`;
  const buildNumber =
    typeof row.build_number === "number" ? `#${row.build_number}` : "#?";
  const stateString = seg(row.state_string);

  const updatedAt = typeof row.updated_at === "number" ? row.updated_at : 0;
  // `updated_at` is the event `ts` in SECONDS (the reducer stamps it from
  // `event.ts`); `now` is a ms epoch, so scale before differencing.
  const ageMs = updatedAt > 0 ? now - updatedAt * 1000 : Number.NaN;
  const age = formatAge(ageMs);

  const parts = [
    status.glyph,
    project,
    jobType,
    buildNumber,
    status.label,
    stateString,
    age,
  ].filter((p) => p.length > 0);
  return parts.join("  ");
}

/**
 * Top-level renderer — one line per builds row, suitable for
 * `liveShell.pushFrame`. Rows arrive pre-sorted by `project ASC` from the
 * subscribe query. An empty table renders a single client-side hint line
 * (not new protocol — the empty body is prose). `now` is injected for
 * test determinism.
 */
export function renderRowLines(
  rows: Record<string, unknown>[],
  now: number,
): string[] {
  if (rows.length === 0) {
    return ["no builds yet — is buildbot_url configured?"];
  }
  return rows.map((row) => renderRow(row, now));
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    // Derived from the pure-data descriptor (ADR 0008). parseArgs has no number
    // type — `timeout` is a string, validated manually below.
    options: buildParseOptions(VIEWER_FLAGS),
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  // Resolve the run mode (flag > CI/TERM=dumb > stdout.isTTY !== true).
  // Both `--snapshot` and `--watch` → typed misuse error → exit 2.
  let mode: "snapshot" | "watch";
  try {
    mode = resolveSnapshotMode({
      snapshotFlag: values.snapshot ?? false,
      watchFlag: values.watch ?? false,
      stdoutIsTTY: process.stdout.isTTY,
      env: process.env,
    });
  } catch (err) {
    if (err instanceof SnapshotCliMisuseError) {
      process.stderr.write(`keeper builds: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // Validate `--timeout` (shared duration grammar) only when snapshotting — a
  // bad value is CLI misuse (exit 2). Watch mode ignores it.
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const parsed = parseDuration(values.timeout);
    if (!parsed.ok) {
      process.stderr.write(`keeper builds: --timeout ${parsed.message}\n`);
      process.exit(2);
    }
    timeoutMs = parsed.ms;
  }

  const sockPath = values.sock ?? resolveSockPath();

  await runBuilds({
    mode: mode === "snapshot" ? "snapshot" : "live",
    sockPath,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** Data-frame bound + `--prev-frame` seed for `keeper frames --view builds`. */
export interface BuildsFramesConfig {
  maxFrames?: number | null;
  durationMs?: number | null;
  prevFrameText?: string | null;
}

export interface RunBuildsConfig {
  mode: "live" | "snapshot" | "frames";
  sockPath: string;
  timeoutMs?: number;
  frames?: BuildsFramesConfig;
}

/**
 * Drive the builds viewer in `frames` mode — the entry `keeper frames --view
 * builds` dispatch calls. Mirrors `runBoardFrames` on the frames flag grammar
 * (`maxFrames` / `durationMs` / `prevFrameText`), never `resolveSnapshotMode`.
 */
export async function runBuildsFrames(config: {
  sockPath?: string;
  maxFrames?: number | null;
  durationMs?: number | null;
  prevFrameText?: string | null;
}): Promise<void> {
  await runBuilds({
    mode: "frames",
    sockPath: config.sockPath ?? resolveSockPath(),
    frames: {
      maxFrames: config.maxFrames ?? null,
      durationMs: config.durationMs ?? null,
      prevFrameText: config.prevFrameText ?? null,
    },
  });
}

/**
 * Shared builds-viewer runner. `main` drives it in `live` / `snapshot`;
 * `runBuildsFrames` drives it in `frames`. All three share ONE
 * `subscribeCollection` wiring so the row fold cannot drift between modes.
 */
export async function runBuilds(config: RunBuildsConfig): Promise<void> {
  const { mode, sockPath, timeoutMs } = config;
  const framesEmitter =
    mode === "frames"
      ? createFramesEmitter({
          view: "builds",
          writeStdout: (line) => void process.stdout.write(line),
          diffFn: defaultDiffFn,
          io: defaultFramesIo(),
          maxFrames: config.frames?.maxFrames ?? null,
          durationMs: config.frames?.durationMs ?? null,
          prevFrameText: config.frames?.prevFrameText ?? null,
        })
      : null;

  const view = createViewShell<Record<string, unknown>[]>({
    script: "builds",
    title: "builds",
    renderBody: (rows) => ({
      bodyLines: renderRowLines(rows, Date.now()),
      stateJson: rows,
    }),
    mode,
    streamCount: 1,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(framesEmitter !== null
      ? {
          frames: {
            emitter: framesEmitter,
            durationMs: config.frames?.durationMs ?? null,
          },
        }
      : {}),
    // Paint watchdog (ADR 0088): self-heal a wedge by resubscribing the single
    // builds stream. Inert outside live mode; `handle` is initialized below.
    watchdog: {
      resubscribe: (): void => {
        handle.reconnect();
      },
    },
  });

  const handle = subscribeCollection({
    sockPath,
    idPrefix: "builds",
    collection: COLLECTION,
    limit: 0,
    sort: { column: "project", dir: "asc" },
    onRows: (rows) => view.emit(rows),
    onLifecycle: view.emitLifecycle,
    // Thread the daemon fold cursor into the frames resume-cursor seam
    // (fn-1161), and the freshest header into the readiness gate so the loading
    // indicator advances during catch-up.
    onBootStatus: (boot) => {
      view.noteCursor(String(boot.rev));
      view.noteBootStatus(boot);
    },
    // Gate live rendering on daemon readiness (the latched catch-up transition).
    onCatchingUp: (catchingUp, boot) => view.noteCatchingUp(catchingUp, boot),
  });

  if (mode === "snapshot") {
    view.runSnapshot(() => handle.dispose());
  } else if (mode === "frames") {
    view.runFrames(() => handle.dispose());
  } else {
    view.installSigintHandler(() => handle.dispose());
  }
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical
// entry. Direct invocation via `bun cli/builds.ts` would bypass the
// dispatcher's arg-pruning; run `bun cli/keeper.ts builds <args>` instead.
