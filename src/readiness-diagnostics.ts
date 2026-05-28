/**
 * Readiness diagnostics channel — structured side-band output from
 * `computeReadiness` for cases where the input is well-formed but the
 * resolver hits an ambiguity worth surfacing to the human (e.g. a bare
 * `fn-N` epic dep that matches multiple epics across configured projects
 * and the consumer epic's own project doesn't disambiguate).
 *
 * The channel is data, not I/O: `computeReadiness` returns a
 * `ResolutionDiagnostic[]` on its `ReadinessSnapshot`. Side-effecting
 * consumers (`scripts/board.ts`, `scripts/autopilot.ts`) call
 * {@link appendDiagnostic} to append a single JSON line to the shared
 * JSONL log at `~/.local/state/keeper/readiness-diagnostics.jsonl`.
 *
 * The append is a single O_APPEND `write()` of one line. POSIX guarantees
 * atomic concurrent appends when the payload is under PIPE_BUF (4 KiB on
 * Linux/macOS), so multiple processes (board.ts + autopilot.ts) can write
 * concurrently without flock. Lines are a few hundred bytes in practice;
 * the helper does NOT enforce a size cap (a 4-KiB line would be a bug
 * elsewhere, not here).
 *
 * Wire shape is extensible by adding new `kind` discriminator values; the
 * envelope `{ts, kind, ...}` stays stable so a future kind doesn't
 * invalidate consumers that grep the log.
 */

import { appendFileSync } from "node:fs";

/**
 * Diagnostic envelope. The `kind` discriminator carries any payload
 * fields specific to that diagnostic. The shared `ts` is an ISO-8601
 * string stamped by the producer just before `appendDiagnostic`.
 *
 * Today's single member:
 *
 *   - `ambiguous-dep-resolution` — a bare `fn-N` epic dep on
 *     {@link consumer_epic} matched 2+ epics across the input snapshot,
 *     AND none of the matches shares the consumer's `project_dir`. The
 *     resolver yields `dep-on-epic-dangling` rather than guessing.
 *     `matches` carries every matching epic's full id (`fn-N-foo`),
 *     sorted so a re-fold against the same snapshot reproduces the same
 *     line.
 */
export type ResolutionDiagnostic = {
  ts: string;
  kind: "ambiguous-dep-resolution";
  consumer_epic: string;
  upstream: string;
  matches: string[];
};

/**
 * Append one diagnostic line to the JSONL log at `logPath`. Single
 * O_APPEND `write()` so concurrent writers stay atomic under PIPE_BUF.
 * Best-effort: any I/O error is swallowed and a one-line note is sent
 * to stderr — the log is observational, never load-bearing, so a write
 * failure must not wedge the board/autopilot frame emit loop.
 */
export function appendDiagnostic(
  d: ResolutionDiagnostic,
  logPath: string,
): void {
  try {
    appendFileSync(logPath, `${JSON.stringify(d)}\n`);
  } catch (err) {
    process.stderr.write(
      `# warn: readiness-diagnostics append failed: ${(err as Error).message}\n`,
    );
  }
}
