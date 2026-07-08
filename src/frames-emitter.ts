/**
 * `src/frames-emitter.ts` — the single module owning the `keeper frames`
 * NDJSON wire contract (docs/adr/0012). One rendered TUI frame becomes one
 * self-delimiting single-line JSON envelope; a consuming agent reads bounded
 * chunks and resumes from a cursor with an honest coverage verdict.
 *
 * This module is deliberately shell-agnostic. Two structurally different
 * callers drive it — the shared `createViewShell` harness and the usage
 * viewer's open-coded dual-stream main — so the wire format can never drift
 * between them. Once-gating (emit the baseline exactly once, reconnect
 * handling) is the CALLER's job; the emitter keeps its per-emit state minimal:
 * a contiguous `seq`, a data-frame budget, a coverage flag, and an in-process
 * sidecar ring over its OWN files.
 *
 * Everything impure is injected ({@link FramesIo} for filesystem + clock,
 * {@link DiffFn} for the unified diff) following the `SnapshotIo` precedent, so
 * the whole multi-frame path is covered in the pure test tier with no
 * subprocess. `JSON.stringify` with no spacer is the sole serializer: it is the
 * transport-layer injection guard, since frame text embeds attacker-influenced
 * slugs, failure reasons, and session titles, and a single-line record cannot
 * be broken by newlines or quotes in that text.
 *
 * The schema version here is SEPARATE from the frozen snapshot `keeper-meta:`
 * contract ({@link "./snapshot".SNAPSHOT_SCHEMA_VERSION}); the two never share a
 * constant.
 */

import { unlinkSync, writeFileSync } from "node:fs";

/** Current frames-envelope schema version. Bump on any field-shape change. */
export const FRAMES_SCHEMA_VERSION = 2;

/** Inline-diff byte budget before it is truncated to a marker. */
export const DEFAULT_MAX_DIFF_BYTES = 16_384;

/** Inline-diff line budget before it is truncated to a marker. */
export const DEFAULT_MAX_DIFF_LINES = 400;

/** Sidecar triples retained by the in-process ring (older ones are pruned). */
export const DEFAULT_SIDECAR_RING = 32;

/** Record type discriminator on the wire. */
export type FramesRecordType = "baseline" | "frame" | "trailer";

/**
 * Coverage verdict — the trailer's honest claim about completeness.
 * `continuous` is provable ONLY within one uninterrupted run (no reconnect,
 * contiguous `seq`); anything else is `gap_possible`.
 */
export type FrameCoverage = "continuous" | "gap_possible";

/**
 * Why the run terminated — one per termination cause the harness can drive.
 * `max_frames` / `duration` are the bounded-chunk exits; `interrupt` is SIGINT;
 * `eof` is the upstream stream ending.
 */
export type TrailerReason = "max_frames" | "duration" | "interrupt" | "eof";

/**
 * The data-record envelope, shared by `baseline` and `frame`.
 * One single-line JSON object per record. `cursor` is the daemon's opaque,
 * non-unique fold checkpoint (wall-clock staleness repaints legally share a
 * `rev`) — never a per-record id and never a wall-clock timestamp. Full frame
 * text / state JSON / full diff live in the sidecar files the pointers name;
 * the inline `diff` is a size-bounded convenience.
 */
export interface FrameRecord {
  schema_version: number;
  type: Exclude<FramesRecordType, "trailer">;
  /** Per-process contiguous counter across ALL record types. */
  seq: number;
  ts: string;
  view: string;
  cursor: string | null;
  /** `null` for baseline; a unified diff or truncation marker for a frame. */
  diff: string | null;
  /** `true` when `diff` is a marker and the full diff is at `diff_path`. */
  diff_truncated: boolean;
  frame_path: string | null;
  state_path: string | null;
  diff_path: string | null;
  /**
   * Tri-state catch-up status observed at emit time: `null` means no boot
   * header was observed this run, `false` means steady state, `true` means
   * the freshest header reported catch-up. Threaded through {@link
   * FrameInput.catchingUp} / defaults to `null`.
   */
  catching_up: boolean | null;
}

/**
 * The terminal trailer record. Always flushed — on `--max-frames`, `--for`
 * timeout, and SIGINT alike — so a consumer can always resume. Shares the
 * base fields with {@link FrameRecord} and adds the resume/coverage payload.
 */
export interface TrailerRecord {
  schema_version: number;
  type: "trailer";
  seq: number;
  ts: string;
  view: string;
  /** The opaque checkpoint a follow-on chunk anchors on. */
  resume_cursor: string | null;
  coverage: FrameCoverage;
  /** Data frames emitted this run (baseline excluded). */
  frames_emitted: number;
  reason: TrailerReason;
  /**
   * Tri-state catch-up status at trailer time — same semantics as {@link
   * FrameRecord.catching_up}. Threaded via {@link
   * FramesEmitter.emitTrailer}'s `catchingUp` input, defaulting to `null`.
   */
  catching_up: boolean | null;
}

export type FramesEnvelope = FrameRecord | TrailerRecord;

/**
 * Injectable filesystem + clock, following the `SnapshotIo` precedent. Prod
 * passes {@link defaultFramesIo}; the pure test tier passes in-memory sinks and
 * a fake clock. `unlink` is best-effort GC (a missing file is fine).
 */
export interface FramesIo {
  writeFile: (path: string, contents: string) => void;
  unlink: (path: string) => void;
  /** ISO timestamp for a record's `ts`. */
  nowIso: () => string;
  /** Monotonic-ish millis for the duration bound (prod: `Date.now`). */
  nowMs: () => number;
}

/**
 * The unified-diff seam. Prod default ({@link defaultDiffFn}) shells `diff -u`
 * exactly like the view-shell sidecar site; tests inject a pure fake, since the
 * repo's no-subprocess test rule leaves no alternative.
 */
export type DiffFn = (prevText: string, nextText: string) => string;

/** One rendered frame handed to the emitter. */
export interface FrameInput {
  cursor: string | null;
  frameText: string;
  stateJson: unknown;
  /**
   * Tri-state catch-up status observed for this frame. `null`/omitted ⇒
   * no boot header observed (today's behavior for every existing caller);
   * threading a live value is a dependent caller's job.
   */
  catchingUp?: boolean | null;
}

export interface FramesEmitterDeps {
  /** The viewer identity stamped on every record (`board`, `usage`, …). */
  view: string;
  /** stdout sink; the emitter appends the record's trailing newline itself. */
  writeStdout: (line: string) => void;
  diffFn: DiffFn;
  io: FramesIo;
  /** Data-frame bound; `null`/omitted ⇒ unbounded. */
  maxFrames?: number | null;
  /** Duration bound in millis; `null`/omitted ⇒ unbounded. */
  durationMs?: number | null;
  maxDiffBytes?: number;
  maxDiffLines?: number;
  /**
   * A prior chunk's last frame text (`keeper frames --prev-frame <path>`). When
   * set, the FIRST `baseline` is rendered as a net diff against this seed rather
   * than a null-diff ground state, so a resumed chunk shows what changed since
   * the previous chunk ended. `null`/omitted ⇒ the baseline is the ground state
   * (`diff: null`), today's behavior.
   */
  prevFrameText?: string | null;
  /** Sidecar triples to retain (floored at 1 so the current frame survives). */
  ringSize?: number;
  /** Sidecar directory (default `/tmp`). */
  sidecarDir?: string;
  /** Emitting pid, stamped into sidecar filenames (default `process.pid`). */
  pid?: number;
}

export interface FramesEmitter {
  /** Emit the ground-state record (type `baseline`, `diff: null`). */
  emitBaseline: (input: FrameInput) => void;
  /** Emit a change frame: diff vs the last frame, bounded, sidecars written. */
  emitFrame: (input: FrameInput) => void;
  /** Emit the terminal trailer with the resume cursor + coverage verdict. */
  emitTrailer: (input: {
    reason: TrailerReason;
    cursor?: string | null;
    /** Tri-state catch-up status at trailer time. `null`/omitted ⇒ `null`. */
    catchingUp?: boolean | null;
  }) => void;
  /** Mark that a reconnect happened → coverage becomes `gap_possible`. */
  noteReconnect: () => void;
  /** The bound that has tripped, if any, so the caller can flush a trailer. */
  shouldStop: () => TrailerReason | null;
  /** Data frames emitted so far (matches the trailer's `frames_emitted`). */
  framesEmitted: () => number;
}

/** Exact UTF-8 byte length (pure — no `node:buffer` import needed). */
export function countUtf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Line count of a text block. A trailing newline does NOT count as an extra
 * empty line, so a `diff -u` output ending in `\n` reports its true line count.
 */
export function countLines(s: string): number {
  if (s === "") {
    return 0;
  }
  const parts = s.split("\n").length;
  return s.endsWith("\n") ? parts - 1 : parts;
}

export interface BoundedDiff {
  /** The inline value: the raw diff, or a truncation marker. */
  diff: string;
  truncated: boolean;
  /** Byte/line counts of the RAW diff, measured before any truncation. */
  bytes: number;
  lines: number;
}

/**
 * Size-bound a raw unified diff. Bytes and lines are counted on the RAW input
 * BEFORE inlining; over either budget, `diff` becomes a marker naming both
 * counts and `truncated` is set, so the consumer falls back to `diff_path` /
 * `frame_path`.
 */
export function boundDiff(
  raw: string,
  opts: { maxBytes: number; maxLines: number },
): BoundedDiff {
  const bytes = countUtf8Bytes(raw);
  const lines = countLines(raw);
  const truncated = bytes > opts.maxBytes || lines > opts.maxLines;
  return {
    diff: truncated
      ? `# diff truncated: ${bytes} bytes, ${lines} lines — full diff at diff_path`
      : raw,
    truncated,
    bytes,
    lines,
  };
}

let defaultDiffCounter = 0;

/**
 * Prod diff seam: shell `diff -u` over two temp files, mirroring the view-shell
 * sidecar site. Never called by the pure test tier (which injects a fake), so
 * its subprocess never runs under `bun test`.
 */
export function defaultDiffFn(prevText: string, nextText: string): string {
  const base = `/tmp/keeper-frames-diff.${process.pid}.${defaultDiffCounter++}`;
  const a = `${base}.a`;
  const b = `${base}.b`;
  try {
    writeFileSync(a, prevText.endsWith("\n") ? prevText : `${prevText}\n`);
    writeFileSync(b, nextText.endsWith("\n") ? nextText : `${nextText}\n`);
    // `diff -u` exits 1 on difference (expected — we only diff changed frames),
    // so the exit code is ignored and stdout taken verbatim.
    const proc = Bun.spawnSync({ cmd: ["diff", "-u", a, b] });
    return proc.stdout.toString();
  } catch (err) {
    return `# diff failed: ${(err as Error).message}\n`;
  } finally {
    try {
      unlinkSync(a);
    } catch {
      // best-effort temp cleanup
    }
    try {
      unlinkSync(b);
    } catch {
      // best-effort temp cleanup
    }
  }
}

/** Prod filesystem + clock. Sidecar writes are best-effort like the view-shell. */
export function defaultFramesIo(): FramesIo {
  return {
    writeFile: (path, contents) => {
      try {
        writeFileSync(path, contents);
      } catch {
        // A failed sidecar write is non-fatal; the pointer may dangle, matching
        // the view-shell's log-and-continue posture. The wiring caller may pass
        // a logging IO instead.
      }
    },
    unlink: (path) => {
      try {
        unlinkSync(path);
      } catch {
        // best-effort ring GC — an already-absent file is fine
      }
    },
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

/**
 * Build the frames emitter. Pure of process/IO/clock/subprocess — everything
 * impure is in {@link FramesEmitterDeps}. A plain construction has no side
 * effect until a record is emitted.
 */
export function createFramesEmitter(deps: FramesEmitterDeps): FramesEmitter {
  const view = deps.view;
  const safeView = view.replace(/[^A-Za-z0-9_-]/g, "_");
  const pid = deps.pid ?? process.pid;
  const dir = deps.sidecarDir ?? "/tmp";
  const maxFrames = deps.maxFrames ?? null;
  const durationMs = deps.durationMs ?? null;
  const maxDiffBytes = deps.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const maxDiffLines = deps.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;
  // Floor at 1 so the just-written triple is never pruned in its own emit —
  // that would dangle the pointers on the record we are about to ship.
  const ringSize = Math.max(1, deps.ringSize ?? DEFAULT_SIDECAR_RING);
  const startMs = deps.io.nowMs();

  let seq = 0;
  let dataFrames = 0;
  let sidecarIndex = 0;
  let reconnected = false;
  let lastCursor: string | null = null;
  // Seeded from `--prev-frame` when supplied so the first baseline diffs against
  // the prior chunk's last frame; `null` otherwise (a null-diff ground state).
  let lastFrameText: string | null = deps.prevFrameText ?? null;
  // Each entry is the paths this process wrote for one sidecar-bearing emit.
  // The ring only ever unlinks paths it itself recorded here — it never scans a
  // directory and never touches a path it did not write.
  const ring: string[][] = [];

  function sidecarPath(kind: string, index: number, ext: string): string {
    return `${dir}/keeper-frames-${safeView}.${pid}.${kind}.${index}.${ext}`;
  }

  function pruneRing(): void {
    while (ring.length > ringSize) {
      const oldest = ring.shift();
      if (oldest === undefined) {
        break;
      }
      for (const path of oldest) {
        deps.io.unlink(path);
      }
    }
  }

  function writeStdout(record: FramesEnvelope): void {
    // `JSON.stringify` with no spacer is single-line by construction; the record
    // is the transport-layer injection guard.
    deps.writeStdout(`${JSON.stringify(record)}\n`);
  }

  function emitBaseline(input: FrameInput): void {
    const index = sidecarIndex++;
    const statePath = sidecarPath("state", index, "json");
    const framePath = sidecarPath("frame", index, "txt");
    deps.io.writeFile(
      statePath,
      `${JSON.stringify(input.stateJson, null, 2)}\n`,
    );
    deps.io.writeFile(framePath, `${input.frameText}\n`);

    // With a `--prev-frame` seed, `lastFrameText` is non-null on the FIRST
    // baseline, so the baseline is a NET DIFF against the prior chunk's last
    // frame (with a diff sidecar), rather than the null-diff ground state. A
    // reconnect re-baseline (the sole other seeded case) legitimately shows the
    // net change across the gap. Unseeded first baseline ⇒ `diff: null`.
    const seeded = lastFrameText !== null;
    let diffPath: string | null = null;
    let bounded: BoundedDiff | null = null;
    if (seeded) {
      diffPath = sidecarPath("diff", index, "txt");
      const raw = deps.diffFn(lastFrameText ?? "", input.frameText);
      bounded = boundDiff(raw, {
        maxBytes: maxDiffBytes,
        maxLines: maxDiffLines,
      });
      deps.io.writeFile(diffPath, raw);
      ring.push([statePath, framePath, diffPath]);
    } else {
      ring.push([statePath, framePath]);
    }
    pruneRing();

    lastCursor = input.cursor;
    lastFrameText = input.frameText;
    writeStdout({
      schema_version: FRAMES_SCHEMA_VERSION,
      type: "baseline",
      seq: seq++,
      ts: deps.io.nowIso(),
      view,
      cursor: input.cursor,
      diff: bounded === null ? null : bounded.diff,
      diff_truncated: bounded?.truncated ?? false,
      frame_path: framePath,
      state_path: statePath,
      diff_path: diffPath,
      catching_up: input.catchingUp ?? null,
    });
  }

  function emitFrame(input: FrameInput): void {
    const index = sidecarIndex++;
    const statePath = sidecarPath("state", index, "json");
    const framePath = sidecarPath("frame", index, "txt");
    const diffPath = sidecarPath("diff", index, "txt");

    const raw = deps.diffFn(lastFrameText ?? "", input.frameText);
    const bounded = boundDiff(raw, {
      maxBytes: maxDiffBytes,
      maxLines: maxDiffLines,
    });

    deps.io.writeFile(
      statePath,
      `${JSON.stringify(input.stateJson, null, 2)}\n`,
    );
    deps.io.writeFile(framePath, `${input.frameText}\n`);
    // The FULL diff always lands at diff_path even when the inline value is a
    // marker, so a consumer can always dereference the untruncated diff.
    deps.io.writeFile(diffPath, raw);
    ring.push([statePath, framePath, diffPath]);
    pruneRing();

    dataFrames += 1;
    lastCursor = input.cursor;
    lastFrameText = input.frameText;
    writeStdout({
      schema_version: FRAMES_SCHEMA_VERSION,
      type: "frame",
      seq: seq++,
      ts: deps.io.nowIso(),
      view,
      cursor: input.cursor,
      diff: bounded.diff,
      diff_truncated: bounded.truncated,
      frame_path: framePath,
      state_path: statePath,
      diff_path: diffPath,
      catching_up: input.catchingUp ?? null,
    });
  }

  function emitTrailer(input: {
    reason: TrailerReason;
    cursor?: string | null;
    catchingUp?: boolean | null;
  }): void {
    const resumeCursor = input.cursor !== undefined ? input.cursor : lastCursor;
    writeStdout({
      schema_version: FRAMES_SCHEMA_VERSION,
      type: "trailer",
      seq: seq++,
      ts: deps.io.nowIso(),
      view,
      resume_cursor: resumeCursor,
      // `continuous` only when the run saw no reconnect; the emitter guarantees
      // its own `seq` stays contiguous, so a reconnect is the sole gap source.
      coverage: reconnected ? "gap_possible" : "continuous",
      frames_emitted: dataFrames,
      reason: input.reason,
      catching_up: input.catchingUp ?? null,
    });
  }

  function shouldStop(): TrailerReason | null {
    if (maxFrames !== null && dataFrames >= maxFrames) {
      return "max_frames";
    }
    if (durationMs !== null && deps.io.nowMs() - startMs >= durationMs) {
      return "duration";
    }
    return null;
  }

  return {
    emitBaseline,
    emitFrame,
    emitTrailer,
    noteReconnect: () => {
      reconnected = true;
    },
    shouldStop,
    framesEmitted: () => dataFrames,
  };
}
