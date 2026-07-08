/**
 * Pure, dep-free failure fingerprinting — the conservative normalization that
 * collapses two shared-base-breakage reports of the SAME defect (differing only
 * in incidental paths, line numbers, pids, shas, and timestamps) onto ONE stable
 * token, so the daemon SHARED_BASE_BROKEN sweep keys at most one `repair::<token>`
 * dispatch per (repo, distinct defect).
 *
 * LEAF-MODULE DISCIPLINE (mirrors `src/derivers.ts` / `src/dispatch-failure-key.ts`):
 * zero imports, no `bun:sqlite`, no `./db`. The fingerprint rides in a
 * `dispatch_failures` row's `reason` (`shared-base-broken:<fingerprint>`) which a
 * fold stores VERBATIM, so the fold never recomputes it; nonetheless this stays a
 * PURE total function — no wall-clock, no fs, no randomness — bounded O(input) per
 * call, so it is safe to call from a producer that feeds the event stream.
 *
 * Bias CONSERVATIVE (over-merge over under-merge): an over-broad mask collapses a
 * second distinct defect onto one repair (the human's brief still carries every
 * affected task's raw reason, so nothing is lost), whereas an under-broad one races
 * duplicate repairs at one shared checkout. The masks below therefore err toward
 * merging — masking numbers/hex/paths/timestamps aggressively.
 */

/** Hard cap on fingerprint input — a pathological multi-megabyte blocked reason is
 *  truncated before normalization so one bad row can never blow the sweep's budget.
 *  Well above a realistic `BLOCKED:` reason's length. */
export const MAX_FINGERPRINT_INPUT = 4096;

/**
 * Normalize failure evidence (a worker's `SHARED_BASE_BROKEN:` blocked reason, or
 * any free-text failure text) to a stable, human-legible masked form — the input
 * to {@link fingerprintFailure}, exported on its own so the masking is unit-testable
 * independently of the digest. Deterministic regex only; the mask ORDER is
 * load-bearing: the most specific structured tokens (hex addresses, ISO timestamps,
 * shas, filesystem paths) are masked BEFORE the generic bare-number sweep, so a
 * number sweep never eats a digit out of a sha/timestamp and splits one token into
 * two. The residual-punctuation and whitespace collapses run LAST so the output is a
 * clean space-separated stream of words and `<placeholder>`-free lowercase markers.
 */
export function normalizeFailureEvidence(evidence: string): string {
  let s = evidence.slice(0, MAX_FINGERPRINT_INPUT).toLowerCase();
  // Hex memory addresses (`0x7ffe...`) — before the sha/number sweeps.
  s = s.replace(/0x[0-9a-f]+/g, " addr ");
  // ISO-8601 timestamps (`2026-07-07t12:00:00.123z`, `... 12:00:00+02:00`).
  s = s.replace(
    /\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/g,
    " ts ",
  );
  // Sha / hex ids (7–40 hex chars) — commit shas, object ids, hashes.
  s = s.replace(/\b[0-9a-f]{7,40}\b/g, " hex ");
  // Filesystem paths — any token carrying a `/`. Masks `/a/b/foo.ts` and
  // `src/foo.ts` alike, dropping the incidental directory + filename that varies
  // lane-to-lane while the failure is the same defect.
  s = s.replace(/[\w.-]*\/[\w./-]+/g, " path ");
  // Bare numbers (line numbers, pids, counts, durations) — word-bounded so an
  // already-masked placeholder is untouched.
  s = s.replace(/\b\d+\b/g, " n ");
  // Collapse every residual punctuation run (backticks, colons, parens, commas)
  // to a single space so quoting/formatting noise never discriminates.
  s = s.replace(/[^a-z0-9_ ]+/g, " ");
  // Collapse whitespace runs and trim — the canonical space-separated form.
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Fingerprint failure evidence to a compact, whitespace-free, deterministic token —
 * the FNV-1a 32-bit base36 digest of {@link normalizeFailureEvidence}. Identical
 * defects (differing only in the incidental tokens the normalizer masks) collapse to
 * the SAME fingerprint; a genuinely different failing command / assertion produces a
 * DIFFERENT one. The digest is `[0-9a-z]+` (matches the `\S+` fingerprint slot the
 * `shared-base-broken:<fingerprint>` reason contract carries) and pure — the same
 * input always yields the same token, on any process, run, or re-fold. FNV-1a here
 * mirrors `repoToken`'s digest: collision resistance need only separate a handful of
 * concurrent defects on one repo, not be cryptographic.
 */
export function fingerprintFailure(evidence: string): string {
  const norm = normalizeFailureEvidence(evidence);
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
