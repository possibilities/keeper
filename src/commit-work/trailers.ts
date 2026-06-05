/**
 * Commit-trailer parsing for the `keeper find-task-commit` reader — the native
 * port of `cli_common.git_trailers._load_trailers` (the two-git-call parse that
 * jobctl's `_has_real_trailer` wrapped).
 *
 * Two-stage match, identical to the Python:
 *   1. `git log -1 --format=%B <sha>` — fetch the raw commit body.
 *   2. `git interpret-trailers --parse` — strip prose, leaving only real
 *      trailer (`Key: value`) lines at the end of the message. This is what
 *      drops a prose false-match like "fixes the Task: fn-X issue" that the
 *      cheap `-F` grep pre-filter lets through.
 *
 * The `Task:` task-id VALIDATION reuses keeper's own {@link parseTaskTrailers}
 * (src/derivers.ts) rather than re-porting `cli_common.git_trailers`'s logic —
 * the only thing lifted from the Python is the `interpret-trailers` shell-out
 * shape (per the task's acceptance bar). `parseTaskTrailers` already trims,
 * drops empties, and gates each value against the anchored `fn-N-slug.M` task
 * shape, so a garbage `Task:` value never matches.
 */

import { parseTaskTrailers } from "../derivers";
import { gitExec } from "./git-exec";

/**
 * Parse all trailers for `sha` into `{ key: [value, ...] }`, multi-valued keys
 * preserving commit-message order. Returns `{}` when:
 *   - `git log -1 --format=%B <sha>` exits non-zero (sha not in repo),
 *   - `git interpret-trailers --parse` exits non-zero,
 *   - the commit carries no trailers (empty / whitespace-only output).
 *
 * Faithful to the Python `_load_trailers`: partition each output line on the
 * FIRST `": "` (so a value that itself contains `: ` survives intact), trim key
 * and value, skip lines without a `": "` separator or with an empty key.
 */
export async function loadTrailers(
  sha: string,
  cwd: string,
): Promise<Record<string, string[]>> {
  // Step 1: fetch the raw commit body.
  const body = await gitExec(["log", "-1", "--format=%B", sha], { cwd });
  if (body.code !== 0) return {};

  // Step 2: parse trailers from the body via stdin.
  const parsed = await gitExec(["interpret-trailers", "--parse"], {
    cwd,
    stdin: new TextEncoder().encode(body.stdout),
  });
  if (parsed.code !== 0) return {};

  const trailers: Record<string, string[]> = {};
  for (const rawLine of parsed.stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // `git interpret-trailers --parse` emits `Key: value` lines. Partition on
    // the FIRST `": "` so a value containing `: ` is not truncated.
    const sep = line.indexOf(": ");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 2).trim();
    if (key.length === 0) continue;
    const bucket = trailers[key] ?? [];
    bucket.push(value);
    trailers[key] = bucket;
  }
  return trailers;
}

/**
 * Confirm a real `Task: <taskId>` trailer on `sha` — the port of jobctl's
 * `_has_real_trailer`. Returns `true` iff the commit's validated `Task:`
 * trailer values (filtered through keeper's {@link parseTaskTrailers}) contain
 * exactly `taskId`.
 *
 * Reusing `parseTaskTrailers` over the raw `trailers.Task` list keeps the
 * membership check honest with keeper's own anchored task-id grammar: a
 * malformed `Task:` value (epic-only ref, uppercase, garbage) is dropped before
 * the membership test, so it can never spuriously confirm a candidate.
 */
export async function hasRealTaskTrailer(
  sha: string,
  taskId: string,
  cwd: string,
): Promise<boolean> {
  const trailers = await loadTrailers(sha, cwd);
  const rawTaskValues = trailers.Task ?? [];
  if (rawTaskValues.length === 0) return false;
  // `\0`-join so parseTaskTrailers (which splits on `\n` AND `\0`) sees each
  // value as a separate, independently-validated entry.
  const validated = parseTaskTrailers(rawTaskValues.join("\0"));
  return validated.includes(taskId);
}
