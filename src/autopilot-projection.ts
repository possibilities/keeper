/**
 * Pure `autopilot_state` singleton-row coercion helpers. Daemon-side modules
 * (`src/daemon.ts`, `src/readiness-client.ts`) import these directly so they
 * never reach into `cli/`; `cli/autopilot.ts` imports the same functions for
 * its viewer banner and `autopilot show` envelope, and re-exports them so
 * existing cli-side importers (`cli/board.ts`, tests) keep resolving
 * `../cli/autopilot`.
 */

import {
  parseNonFableFocusPolicy,
  validateNonFableFocusPolicy,
} from "./account-focus";
import { DEFAULT_MAX_CONCURRENT_PER_ROOT } from "./db";
import { parseFableFocusPolicy, validateFableFocusPolicy } from "./fable-focus";
import type { FableFocusPolicy, NonFableFocusPolicy } from "./types";

/**
 * Coerce a singleton `autopilot_state` wire row's `paused` column (INTEGER:
 * `1` paused, `0` playing) to the banner boolean. An empty row set (singleton
 * not yet folded) returns `null` so the caller leaves the seed untouched; a
 * non-0/1 value falls back to `true` (the safer side, matching the daemon's
 * boot default). Pure — exported for tests.
 */
export function projectAutopilotPaused(
  rows: Record<string, unknown>[],
): boolean | null {
  if (rows.length === 0) {
    return null;
  }
  const raw = rows[0]?.paused;
  if (typeof raw !== "number") {
    return true;
  }
  return raw !== 0;
}

/**
 * Coerce a singleton `autopilot_state` wire row's `max_concurrent_jobs` column
 * (NULLABLE INTEGER: a positive cap, or NULL = unlimited) to the banner cap.
 * Sourced ENTIRELY over the socket — the viewer NEVER reads config.yaml. The
 * whole absent → unlimited path (empty row set, NULL, missing column, or any
 * non-positive / non-integer value) returns `null` (rendered `∞`); only a
 * positive integer returns a numeric cap. Pure — exported for tests.
 */
export function projectMaxConcurrentJobs(
  rows: Record<string, unknown>[],
): number | null {
  if (rows.length === 0) {
    return null;
  }
  const raw = rows[0]?.max_concurrent_jobs;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return null;
  }
  return raw;
}

/**
 * Coerce a singleton `autopilot_state` wire row's `max_concurrent_per_root`
 * column (NULLABLE INTEGER) to the banner's per-root count. Unlike the global
 * cap there is NO unlimited sentinel: NULL / empty rows / a non-positive or
 * non-integer value ALL resolve to `DEFAULT_MAX_CONCURRENT_PER_ROOT` (= 1)
 * inside the projection, so this always returns a concrete `number`. Pure —
 * exported for tests.
 */
export function projectMaxConcurrentPerRoot(
  rows: Record<string, unknown>[],
): number {
  if (rows.length === 0) {
    return DEFAULT_MAX_CONCURRENT_PER_ROOT;
  }
  const raw = rows[0]?.max_concurrent_per_root;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return DEFAULT_MAX_CONCURRENT_PER_ROOT;
  }
  return raw;
}

/**
 * Coerce a singleton `autopilot_state` wire row's `worktree_mode` column
 * (NULLABLE INTEGER: `1` ON, NULL/0 OFF) to the banner boolean. An empty row set
 * (singleton not yet folded) returns `null` so the caller leaves the seed
 * untouched; only a stored `1` is ON, every other value (NULL, 0, absent column,
 * non-1) is OFF — the byte-identical default. Pure — exported for tests.
 */
export function projectWorktreeMode(
  rows: Record<string, unknown>[],
): boolean | null {
  if (rows.length === 0) {
    return null;
  }
  return rows[0]?.worktree_mode === 1;
}

/**
 * Coerce a singleton `autopilot_state` wire row's `worktree_multi_repo` column
 * (NULLABLE INTEGER: `1` ON, NULL/0 OFF — the durable multi-repo rollout flag) to
 * a boolean. Mirrors {@link projectWorktreeMode}: an empty row set returns `null`
 * so a caller can leave its seed untouched; only a stored `1` is ON, every other
 * value (NULL, 0, absent column, non-1) is OFF. Pure — exported for tests.
 */
export function projectWorktreeMultiRepo(
  rows: Record<string, unknown>[],
): boolean | null {
  if (rows.length === 0) {
    return null;
  }
  return rows[0]?.worktree_multi_repo === 1;
}

/** Parse the raw SQLite cell or decoded query value without activating malformed state. */
export function projectFableFocus(
  rows: Record<string, unknown>[],
): { valid: true; policy: FableFocusPolicy | null } | { valid: false } {
  if (rows.length === 0 || rows[0]?.fable_focus == null) {
    return { valid: true, policy: null };
  }
  const raw = rows[0]?.fable_focus;
  const policy =
    typeof raw === "string"
      ? parseFableFocusPolicy(raw)
      : validateFableFocusPolicy(raw);
  return policy === null ? { valid: false } : { valid: true, policy };
}

/** Invalid Non-Fable state must not contaminate the Fable projection. */
export function projectNonFableFocus(
  rows: Record<string, unknown>[],
): { valid: true; policy: NonFableFocusPolicy | null } | { valid: false } {
  if (rows.length === 0 || rows[0]?.non_fable_focus == null) {
    return { valid: true, policy: null };
  }
  const raw = rows[0]?.non_fable_focus;
  const policy =
    typeof raw === "string"
      ? parseNonFableFocusPolicy(raw)
      : validateNonFableFocusPolicy(raw);
  return policy === null ? { valid: false } : { valid: true, policy };
}

/**
 * Coerce a singleton `autopilot_state` wire row's `worker_provider` column
 * (NULLABLE TEXT: `"claude"` | `"gpt"` | NULL — the durable work-dispatch
 * provider pin, docs/adr/0047) to its enum value. An empty row set, an absent
 * column, or any value outside the two recognized members ALL resolve to
 * `null` (unconstrained, the byte-identical default); only an exact
 * `"claude"`/`"gpt"` string passes through. Pure — exported for tests.
 */
export function projectWorkerProvider(
  rows: Record<string, unknown>[],
): "claude" | "gpt" | null {
  if (rows.length === 0) {
    return null;
  }
  const raw = rows[0]?.worker_provider;
  return raw === "claude" || raw === "gpt" ? raw : null;
}
