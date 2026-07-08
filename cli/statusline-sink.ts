#!/usr/bin/env bun
/**
 * `keeper statusline-sink` — capture a Claude Code statusLine payload into a
 * per-session leaf file so the `statusline-worker` file-watch producer can fold
 * the session's CURRENT model / reasoning effort / context-window usage onto its
 * `jobs` row (schema v100 / fn-1024). The full statusline entrypoint is
 * `keeper statusline`, which calls these capture helpers before rendering the
 * visible line.
 *
 * CAPTURED CONTRACT (the early-proof-point this task exists to confirm):
 *  - The fold's ONLY match key is `session_id`. The reducer invariant
 *    `job_id === session_id` (src/reducer.ts) means the statusLine payload's
 *    top-level `session_id` is exactly the hook-sourced `jobs.job_id`; a match is
 *    guaranteed, so the projection is never a silent no-op. The RAW `session_id`
 *    is stored INSIDE the leaf (the filename is sanitized/lossy) so the worker
 *    reads back the un-mangled id.
 *  - `model.id` (e.g. `claude-opus-4-8`) + `model.display_name` (e.g. `Opus`)
 *    are present on every render.
 *  - `effort.level` (`low`/`medium`/`high`/`xhigh`/`max`) MAY be absent — degrade
 *    to NULL, never fail.
 *  - `context_window.{used_percentage,total_input_tokens,context_window_size}` —
 *    `used_percentage` is taken DIRECTLY (never recomputed; `total_input_tokens`
 *    can be cumulative across versions and the window size is per-request). Before
 *    the first API call `context_window.current_usage` is null and the percentage
 *    fields may be absent — every context field degrades to NULL independently.
 *
 * Discipline (mirrors the events-writer hook): dependency-light (`node:*` only,
 * NEVER `bun:sqlite`/`src/db.ts`), never touches the DB or the socket, and NEVER
 * throws past `main` — a sink crash must never break the human's statusline. It
 * drains stdin to EOF before exiting. Writes are COALESCED: only a change in
 * {model, effort, context-bucket} rewrites the leaf, so the event log the worker
 * mints from does not churn per render. The write is atomic (tmp-in-same-dir +
 * `rename`) with a DETERMINISTIC temp name so render-frequency invocations never
 * accumulate orphan temp files.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Context-fill hysteresis bucket width (%). A render whose `used_percentage`
 *  stays inside the same 5% band does not rewrite the leaf — the churn guard. */
export const CONTEXT_BUCKET_PCT = 5;

/**
 * The per-session leaf shape. Field names track the v100 `jobs` telemetry columns
 * the worker folds onto (`current_model_id` ← `model_id`, …) so task .3's fold is
 * a straight copy. `updated_at` is epoch-ms, informational (never part of the
 * coalescing signature, so it never forces a rewrite).
 */
export interface StatuslineLeaf {
  session_id: string;
  model_id: string | null;
  model_display: string | null;
  effort: string | null;
  context_used_percentage: number | null;
  context_input_tokens: number | null;
  context_window_size: number | null;
  updated_at: number;
}

/** The sink's outcome — `wrote` distinguishes a coalesced no-op from a real
 *  write; `path` is null only when the payload was unusable (no leaf targeted). */
export interface SinkResult {
  wrote: boolean;
  path: string | null;
}

/**
 * Resolve the leaf directory. `KEEPER_STATUSLINE_DIR` wins (hermetic tests point
 * it at a tmpdir; the worker reads the same override); else
 * `~/.local/state/keeper/statusline/`, a sibling of the other keeper state dirs.
 */
export function resolveStatuslineDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.KEEPER_STATUSLINE_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".local", "state", "keeper", "statusline");
}

/** Sanitize a session id to a safe single-path-segment filename token. The raw
 *  id is stored inside the leaf, so this being lossy is harmless. */
export function sanitizeSessionToken(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Pull a string field, or null (defensive against non-string values). */
function strField(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Pull a finite-number field, or null (NaN/Infinity/absent → null). */
function numField(data: Record<string, unknown>, key: string): number | null {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Pull a nested object field, or null. */
function objField(
  data: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const v = data[key];
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Parse one statusLine stdin payload into a leaf, or null when it is unusable
 * (bad JSON, non-object, or no `session_id` — the fold's only match key). Every
 * optional field degrades to NULL independently; nothing here throws.
 */
export function parseStatuslinePayload(
  raw: string,
  now: number,
): StatuslineLeaf | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const obj = data as Record<string, unknown>;
  const sessionId = strField(obj, "session_id");
  if (sessionId === null) {
    return null;
  }
  const model = objField(obj, "model");
  const effort = objField(obj, "effort");
  const ctx = objField(obj, "context_window");
  return {
    session_id: sessionId,
    model_id: model ? strField(model, "id") : null,
    model_display: model ? strField(model, "display_name") : null,
    effort: effort ? strField(effort, "level") : null,
    context_used_percentage: ctx ? numField(ctx, "used_percentage") : null,
    context_input_tokens: ctx ? numField(ctx, "total_input_tokens") : null,
    context_window_size: ctx ? numField(ctx, "context_window_size") : null,
    updated_at: now,
  };
}

/**
 * The coalescing signature: {model, effort, context-bucket}. Two payloads with an
 * equal signature are the "same" render and must not rewrite the leaf. The
 * context fill is bucketed to {@link CONTEXT_BUCKET_PCT} so sub-band fluctuation
 * never churns the event log the worker mints from. `updated_at` is deliberately
 * excluded.
 */
export function leafSignature(leaf: StatuslineLeaf): string {
  const bucket =
    leaf.context_used_percentage === null
      ? "null"
      : String(Math.floor(leaf.context_used_percentage / CONTEXT_BUCKET_PCT));
  return JSON.stringify([
    leaf.model_id,
    leaf.model_display,
    leaf.effort,
    bucket,
  ]);
}

/** Read + parse the existing leaf at `path`, or null when absent/corrupt. */
function readLeaf(path: string): StatuslineLeaf | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as StatuslineLeaf).session_id !== "string"
    ) {
      return null;
    }
    return parsed as StatuslineLeaf;
  } catch {
    return null;
  }
}

/**
 * Coalesce + atomically write the leaf. Returns `{wrote:false}` when the incoming
 * render's signature matches the on-disk leaf (the no-churn path); otherwise
 * writes `<dir>/<token>.json` via a DETERMINISTIC same-dir temp + `rename`. Never
 * throws — any write failure degrades to `{wrote:false}` so the caller stays
 * exit-0.
 */
export function runSink(raw: string, dir: string, now: number): SinkResult {
  const leaf = parseStatuslinePayload(raw, now);
  if (leaf === null) {
    return { wrote: false, path: null };
  }
  const token = sanitizeSessionToken(leaf.session_id);
  const path = join(dir, `${token}.json`);
  try {
    const existing = readLeaf(path);
    if (existing !== null && leafSignature(existing) === leafSignature(leaf)) {
      return { wrote: false, path };
    }
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${token}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(leaf)}\n`);
    renameSync(tmp, path);
    return { wrote: true, path };
  } catch {
    return { wrote: false, path };
  }
}

/** Read all of stdin to a UTF-8 string. Draining to EOF is load-bearing: exiting
 *  with bytes unread SIGPIPEs the upstream `tee -i` and blanks the display. */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Entry point. Drain stdin fully, then coalesce-write the leaf. EVERY step is
 * wrapped so the process never throws — the caller always exits 0. `argv` is
 * inspected ONLY for a `--help`/`-h` probe (the sink is otherwise machine-
 * invoked with the payload on stdin, no arguments).
 */
export const HELP =
  "keeper statusline-sink — internal statusLine capture helper; not for agent use. " +
  "Machine-invoked with the Claude Code statusLine JSON on stdin; coalesces it " +
  "into a per-session leaf the statusline-worker folds. Takes no arguments.\n";

export async function main(argv: string[]): Promise<void> {
  // A --help/-h probe (the dispatcher forwards it) must print + exit WITHOUT
  // blocking on a stdin drain — no payload is piped in the help case.
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    // stdin read failure — nothing to coalesce, still exit 0.
    return;
  }
  try {
    runSink(raw, resolveStatuslineDir(), Date.now());
  } catch {
    // Belt-and-suspenders: runSink already swallows its own failures.
  }
}

if (import.meta.main) {
  void main(Bun.argv.slice(2)).finally(() => process.exit(0));
}
