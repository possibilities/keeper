// `keeper prompt find-snippets <query>` — ranked snippet discovery. Port of
// promptctl run_find_snippets.py, with the bm25s ranker replaced by a trivial
// dependency-free term scorer over the ~90-doc corpus.
//
// The Python verb ranked via `bm25s` backed by an on-disk `.promptctl/bm25/`
// index refreshed under a FileLock. That disk-cache + lock + the bm25s dep are
// all DROPPED: the corpus is small enough that a per-call linear scan with a
// simple term-frequency-over-document-frequency score is fast and stable. Parity
// here is RELAXED (advisory): result ORDER may differ from bm25s, but the
// filter / excerpt / tiebreak contract is preserved exactly:
//
//   - filters (--domain exact, --scope/--phase list-contains, --bundle id-set)
//     applied POST-rank so the scoring stays well-defined;
//   - zero-score hits dropped;
//   - tiebreak: rank_score DESC, then snippet name ASC;
//   - excerpt: single-line window of radius 80 around the earliest literal token
//     hit, ellipsed when truncated, leading 2*radius fallback on no hit.
//
// Output rows: {name, summary, domain, token_estimate, rank_score, excerpt}.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { OutputFormat } from "../../plan/src/format.ts";
import { parseBundle, zodErrorMessage } from "./bundle_schema.ts";
import {
  loadSnippetIndex,
  parse,
  RefError,
  type SnippetEntry,
} from "./refs.ts";

const LIMIT_DEFAULT = 5;
const LIMIT_HARD_CAP = 50;
const EXCERPT_RADIUS = 80;

/** Leading `{#- ... -#}` frontmatter comment block. Mirrors the snippet
 * frontmatter regex shared across the verbs. */
const FRONTMATTER_RE = /^\{#-?\s*\n([\s\S]*?)\n-?#\}\n?/;

/** Raised on bad inputs (empty query, --limit 0, unknown --bundle ref). */
export class FindSnippetsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindSnippetsError";
  }
}

/** A single ranked result row. */
export interface FindResult {
  name: string;
  summary: string;
  domain: string;
  token_estimate: number;
  rank_score: number;
  excerpt: string;
}

/** Filter inputs + the resolved limit. */
export interface FindOptions {
  domain?: string | null;
  scope?: string | null;
  phase?: string | null;
  bundle?: string | null;
  limit?: number;
}

function validateQuery(query: string | undefined): string {
  if (query === undefined || !query.trim()) {
    throw new FindSnippetsError(
      "query is required (use list-snippets to enumerate without ranking)",
    );
  }
  return query.trim();
}

function validateLimit(limit: number): number {
  if (limit === 0) {
    throw new FindSnippetsError(
      "--limit 0 is not supported (use list-snippets, or pick a positive cap)",
    );
  }
  if (limit < 0) {
    throw new FindSnippetsError(`--limit must be positive, got ${limit}`);
  }
  return Math.min(limit, LIMIT_HARD_CAP);
}

/** True when `entry` survives the post-rank filters. Mirrors
 * _entry_passes_filters. */
function entryPassesFilters(
  entry: SnippetEntry,
  domain: string | null,
  scope: string | null,
  phase: string | null,
  bundleIds: Set<string> | null,
): boolean {
  if (domain !== null && entry.domain !== domain) {
    return false;
  }
  if (scope !== null && !listContains(entry.scope, scope)) {
    return false;
  }
  if (phase !== null && !listContains(entry.phase, phase)) {
    return false;
  }
  if (bundleIds !== null) {
    const bare = String(entry.name ?? "");
    const qualified = `${entry.domain ?? ""}/${bare}`;
    if (!bundleIds.has(bare) && !bundleIds.has(qualified)) {
      return false;
    }
  }
  return true;
}

/** List-contains, coercing a scalar field into a singleton list (Python's
 * `have if isinstance(have, list) else [have]`). */
function listContains(field: unknown, value: string): boolean {
  if (field === undefined || field === null) {
    return false;
  }
  const have = Array.isArray(field) ? field : [field];
  return have.includes(value);
}

/** Resolve `--bundle <ref>` to the set of snippet ids it contains, or null when
 * absent. Mirrors _bundle_snippet_ids. */
function bundleSnippetIds(
  bundleRef: string | null,
  projectRoot: string,
): Set<string> | null {
  if (!bundleRef) {
    return null;
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(bundleRef, projectRoot);
  } catch (exc) {
    if (exc instanceof RefError) {
      throw new FindSnippetsError(`--bundle '${bundleRef}': ${exc.message}`);
    }
    throw exc;
  }
  if (parsed.kind !== "bundle" && parsed.kind !== "sketch") {
    throw new FindSnippetsError(
      `--bundle '${bundleRef}' must resolve to a bundle/sketch ref, ` +
        `got kind='${parsed.kind}'`,
    );
  }
  if (!existsSync(parsed.path)) {
    throw new FindSnippetsError(`--bundle '${bundleRef}': file not found`);
  }
  let data: unknown;
  try {
    data = yaml.load(readFileSync(parsed.path, "utf-8")) ?? {};
  } catch (exc) {
    throw new FindSnippetsError(
      `--bundle '${bundleRef}': YAML parse error: ${exc}`,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new FindSnippetsError(
      `--bundle '${bundleRef}': YAML is not a mapping`,
    );
  }
  try {
    const bundle = parseBundle(data);
    return new Set(bundle.snippet_ids);
  } catch (exc) {
    if (exc instanceof z.ZodError) {
      throw new FindSnippetsError(
        `--bundle '${bundleRef}': schema error: ${zodErrorMessage(exc)}`,
      );
    }
    throw exc;
  }
}

/** Split a string into lowercased alphanumeric/underscore tokens of length > 1.
 * Mirrors the Python `re.findall(r"[A-Za-z0-9_]+", ...)` + `len(t) > 1` gate. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) {
    const tok = m[0].toLowerCase();
    if (tok.length > 1) {
      out.push(tok);
    }
  }
  return out;
}

/** Read a snippet body for scoring/excerpt; falls back to the entry summary on
 * a missing/unparseable file. Mirrors _body_for_excerpt. */
function bodyForEntry(projectRoot: string, entry: SnippetEntry): string {
  const templatesDir = join(projectRoot, "claude", "arthack", "template");
  const path = join(templatesDir, String(entry.path ?? ""));
  if (!existsSync(path)) {
    return String(entry.summary ?? "");
  }
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return String(entry.summary ?? "");
  }
  const match = FRONTMATTER_RE.exec(text);
  return match === null ? text : text.slice(match[0].length);
}

/** Return a single-line excerpt centered on the earliest literal query-token
 * hit. Mirrors _excerpt_around_match (radius 80, ellipses on truncation). */
function excerptAroundMatch(body: string, query: string): string {
  const bodyFlat = body.replace(/\s+/g, " ").trim();
  if (!bodyFlat) {
    return "";
  }
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return bodyFlat.slice(0, 2 * EXCERPT_RADIUS);
  }
  const low = bodyFlat.toLowerCase();
  let best: [number, number] | null = null;
  for (const tok of tokens) {
    const idx = low.indexOf(tok);
    if (idx < 0) {
      continue;
    }
    if (best === null || idx < best[0]) {
      best = [idx, idx + tok.length];
    }
  }
  if (best === null) {
    return bodyFlat.slice(0, 2 * EXCERPT_RADIUS);
  }
  const start = Math.max(0, best[0] - EXCERPT_RADIUS);
  const end = Math.min(bodyFlat.length, best[1] + EXCERPT_RADIUS);
  let excerpt = bodyFlat.slice(start, end);
  if (start > 0) {
    excerpt = `...${excerpt}`;
  }
  if (end < bodyFlat.length) {
    excerpt = `${excerpt}...`;
  }
  return excerpt;
}

/** Score one document against the query terms. A trivial tf·idf-flavored sum:
 * each distinct query term contributes `tf * idf` where tf is its occurrence
 * count in the doc tokens and idf = ln(1 + N/df). Stable and dependency-free;
 * order may differ from bm25s (relaxed parity), but a term that appears more
 * (and is rarer corpus-wide) ranks higher, which is the useful property. */
function scoreDoc(
  queryTerms: string[],
  docTokens: string[],
  idf: Map<string, number>,
): number {
  const tf = new Map<string, number>();
  for (const t of docTokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  let score = 0;
  for (const term of queryTerms) {
    const count = tf.get(term);
    if (count === undefined) {
      continue;
    }
    score += count * (idf.get(term) ?? 0);
  }
  return score;
}

/** Rank snippets against `query`, return the top-K rows with excerpts. Filters
 * apply post-rank; tiebreak is rank DESC then name ASC. Mirrors find_snippets,
 * minus the bm25s ranker (trivial scorer here). */
export function findSnippets(
  rawQuery: string | undefined,
  projectRoot: string,
  opts: FindOptions = {},
): FindResult[] {
  const query = validateQuery(rawQuery);
  const cappedLimit = validateLimit(opts.limit ?? LIMIT_DEFAULT);

  const bundleIds = bundleSnippetIds(opts.bundle ?? null, projectRoot);

  const entries = loadSnippetIndex(projectRoot);
  if (entries.length === 0) {
    return [];
  }

  // Build the document token lists once, then idf over the corpus.
  const bodies = entries.map((e) => bodyForEntry(projectRoot, e));
  const docTokens = bodies.map((b, i) =>
    tokenize(`${entries[i]?.name ?? ""} ${entries[i]?.summary ?? ""} ${b}`),
  );
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const n = entries.length;
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + n / count));
  }

  const queryTerms = [...new Set(tokenize(query))];

  const results: FindResult[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as SnippetEntry;
    if (
      !entryPassesFilters(
        entry,
        opts.domain ?? null,
        opts.scope ?? null,
        opts.phase ?? null,
        bundleIds,
      )
    ) {
      continue;
    }
    const score = scoreDoc(queryTerms, docTokens[i] as string[], idf);
    if (score <= 0) {
      continue;
    }
    results.push({
      name: String(entry.name ?? ""),
      summary: String(entry.summary ?? ""),
      domain: String(entry.domain ?? ""),
      token_estimate: Number(entry["token-estimate"] ?? 0),
      rank_score: round6(score),
      excerpt: excerptAroundMatch(bodies[i] as string, query),
    });
  }

  // Deterministic order: rank DESC, then name ASC for tied scores.
  results.sort((a, b) =>
    b.rank_score !== a.rank_score
      ? b.rank_score - a.rank_score
      : a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0,
  );
  return results.slice(0, cappedLimit);
}

/** Round to 6 decimal places, matching Python `round(score, 6)`. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Runner: emit the ranked rows via the shared formatter. Returns the exit code
 * (1 with `Error: <msg>` on stderr on a FindSnippetsError). */
export function runFindSnippets(
  query: string | undefined,
  projectRoot: string,
  opts: FindOptions,
  format: OutputFormat | null,
  emit: (rows: FindResult[], format: OutputFormat | null) => void,
): number {
  let results: FindResult[];
  try {
    results = findSnippets(query, projectRoot, opts);
  } catch (exc) {
    if (exc instanceof FindSnippetsError) {
      process.stderr.write(`Error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  emit(results, format);
  return 0;
}
