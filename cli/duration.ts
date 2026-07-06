/**
 * The one duration grammar every keeper CLI duration-valued flag speaks.
 *
 * Unit is REQUIRED: `500ms`, `30s`, `5m`, `2h`, and compounds like `1h30m`. A
 * bare number is rejected with a hint that names the fix (`2` → `2s`) so the
 * miss is self-healing. Modeled on Go's `time.ParseDuration` subset — reject a
 * unitless value rather than guessing seconds vs milliseconds.
 *
 * Pure and dependency-free: the shared seam the viewers, `status`, `await`,
 * `baseline`, and the agent surface all parse through, so no two flags can drift
 * to different duration grammars.
 */

/** Milliseconds per accepted unit. `ms` precedes `s` in the grammar so a greedy
 *  match reads `500ms` as milliseconds, never `500m` + a dangling `s`. */
const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/** One-line reminder of the accepted shape, appended to every fault message. */
const EXPECTED = "accepts ms/s/m/h, compounds like 1h30m (e.g. 500ms, 30s, 5m)";

/** A whole string of `<int><unit>` segments, one or more, nothing else. */
const DURATION_RE = /^(?:\d+(?:ms|s|m|h))+$/;
/** Extracts each `<int><unit>` segment for summation. `ms` before `s`. */
const SEGMENT_RE = /(\d+)(ms|s|m|h)/g;

export type DurationParse =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly message: string };

/**
 * Parse a duration string to milliseconds under the shared unit-required
 * grammar. On failure the `message` is a bare fault phrase (no leading flag
 * name) so a caller can prefix it with its own flag: `--timeout ${message}`.
 * The total must be strictly positive — a "no deadline" caller signals that by
 * omitting the flag, never by passing `0`.
 */
export function parseDuration(raw: string): DurationParse {
  const s = raw.trim();
  if (s.length === 0) {
    return { ok: false, message: `needs a value — ${EXPECTED}` };
  }
  if (/^\d+$/.test(s)) {
    // The muscle-memory case (`--timeout 2`): name the fix so it self-heals.
    return { ok: false, message: `needs a unit — e.g. ${s}s (${EXPECTED})` };
  }
  if (!DURATION_RE.test(s)) {
    return {
      ok: false,
      message: `is not a valid duration '${raw}' — ${EXPECTED}`,
    };
  }
  let ms = 0;
  for (const seg of s.matchAll(SEGMENT_RE)) {
    ms +=
      Number.parseInt(seg[1] as string, 10) * (UNIT_MS[seg[2] as string] ?? 0);
  }
  if (!Number.isFinite(ms) || ms <= 0) {
    return { ok: false, message: `must be a positive duration (got '${raw}')` };
  }
  return { ok: true, ms };
}
