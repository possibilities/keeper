// `keeper prompt list-snippets [--domain <dom>]` — unranked enumeration of the
// snippet corpus. The discovery counterpart to `find-snippets`: where find ranks
// against a query, list plainly enumerates every snippet id (optionally scoped to
// one domain) so an agent can see the full corpus without inventing a query.
//
// Rows read straight from `_index.yaml` (no body scan, no scoring). Sorted by
// domain then name for deterministic output.

import type { OutputFormat } from "../../plan/src/format.ts";
import { loadSnippetIndex } from "./refs.ts";

/** One enumerated snippet row. */
export interface ListSnippetRow {
  name: string;
  domain: string;
  summary: string;
  token_estimate: number;
}

/** Enumerate the corpus snippets, optionally filtered to `domain`. Sorted by
 * domain ASC then name ASC. */
export function listSnippets(
  projectRoot: string,
  domain: string | null = null,
): ListSnippetRow[] {
  const rows: ListSnippetRow[] = [];
  for (const entry of loadSnippetIndex(projectRoot)) {
    if (domain !== null && entry.domain !== domain) {
      continue;
    }
    rows.push({
      name: String(entry.name ?? ""),
      domain: String(entry.domain ?? ""),
      summary: String(entry.summary ?? ""),
      token_estimate: Number(entry["token-estimate"] ?? 0),
    });
  }
  rows.sort((a, b) =>
    a.domain !== b.domain
      ? a.domain < b.domain
        ? -1
        : 1
      : a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0,
  );
  return rows;
}

/** Runner: emit the enumerated rows via the shared formatter. Always exits 0. */
export function runListSnippets(
  projectRoot: string,
  domain: string | null,
  format: OutputFormat | null,
  emit: (rows: ListSnippetRow[], format: OutputFormat | null) => void,
): number {
  emit(listSnippets(projectRoot, domain), format);
  return 0;
}
