/**
 * Dep-free leaf for the launch-scoped Codex pool proof window. The Pi
 * extension loads this file inside Pi's runtime, where `bun:ffi` and the
 * rest of keeper's daemon-side module graph do not exist — keep this module
 * import-free (types and pure functions only).
 */

export const CODEX_POOL_WORKFLOW_SCHEMA_VERSION = 1;
export const CODEX_POOL_PROOF_WINDOW_DURATION_MS = 15 * 60 * 1000;
export const CODEX_POOL_PROOF_WINDOW_ENV = "KEEPER_PI_CODEX_POOL_PROOF_WINDOW";

export interface CodexPoolProofWindowState {
  schema_version: 1;
  armed_at_ms: number;
  expires_at_ms: number;
  launcher_pid: number;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

export function armCodexPoolProofWindow(
  nowMs: number,
  launcherPid: number,
): CodexPoolProofWindowState {
  const armedAtMs = Math.floor(nowMs);
  const expiresAtMs = armedAtMs + CODEX_POOL_PROOF_WINDOW_DURATION_MS;
  if (
    !Number.isSafeInteger(armedAtMs) ||
    armedAtMs < 0 ||
    !Number.isSafeInteger(expiresAtMs) ||
    !Number.isSafeInteger(launcherPid) ||
    launcherPid < 1
  ) {
    throw new Error("codex-pool-proof-window-invalid");
  }
  return {
    schema_version: CODEX_POOL_WORKFLOW_SCHEMA_VERSION,
    armed_at_ms: armedAtMs,
    expires_at_ms: expiresAtMs,
    launcher_pid: launcherPid,
  };
}

export function codexPoolProofWindowActive(
  input: unknown,
  nowMs: number,
  parentPid: number,
): boolean {
  let value: unknown = input;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 512) return false;
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return false;
    }
  }
  const state = record(value);
  if (
    state === null ||
    !exactKeys(state, [
      "schema_version",
      "armed_at_ms",
      "expires_at_ms",
      "launcher_pid",
    ]) ||
    state.schema_version !== CODEX_POOL_WORKFLOW_SCHEMA_VERSION ||
    !Number.isSafeInteger(state.armed_at_ms) ||
    !Number.isSafeInteger(state.expires_at_ms) ||
    !Number.isSafeInteger(state.launcher_pid)
  ) {
    return false;
  }
  const armedAtMs = state.armed_at_ms as number;
  const expiresAtMs = state.expires_at_ms as number;
  return (
    armedAtMs >= 0 &&
    expiresAtMs - armedAtMs === CODEX_POOL_PROOF_WINDOW_DURATION_MS &&
    Number.isSafeInteger(nowMs) &&
    nowMs >= armedAtMs &&
    nowMs < expiresAtMs &&
    state.launcher_pid === parentPid
  );
}
