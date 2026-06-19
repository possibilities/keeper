/**
 * Derive `events.mutation_path` for a test-seeded event row the SAME way the
 * live hook + ingester do (the pure {@link extractMutationPath}), so a seeded
 * mutation row carries the v73 promoted git-attribution column exactly as a
 * production row would. The post-fn-836.3 git-attribution scan reads the COLUMN
 * (not the JSON body), so any test that raw-INSERTs a PostToolUse mutation row
 * and expects an attribution MUST stamp this column at seed time.
 *
 * Defensive parse: a missing / non-string / non-object / unparseable `data`
 * body folds to `null` (never throws), matching the ingester's
 * `recomputeMutationPath` and the forward deriver's null-on-malformed contract.
 */
import { extractMutationPath } from "../../src/derivers";

export function deriveSeedMutationPath(
  hookEvent: string,
  toolName: string | null,
  data: string | null,
): string | null {
  if (typeof data !== "string" || data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return extractMutationPath(
    hookEvent,
    toolName,
    parsed as Record<string, unknown>,
  );
}
