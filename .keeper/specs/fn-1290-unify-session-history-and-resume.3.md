## Description

**Size:** M
**Files:** src/history/search.ts, src/history/file-evidence.ts, src/history/query.ts, test/history-search.test.ts, test/history-file-evidence.test.ts

### Approach

Build bounded query APIs over the catalog and index. Literal full-text is the safe default; explicit advanced mode accepts FTS syntax. Structured filters cover Session reference, harness, project, role, source, branch, and time, with deterministic BM25/time/id ordering and stable entry-level result handles that can open surrounding context.

Add path search outside tokenized FTS. File evidence has three non-interchangeable grades: observed mutation from canonical successful facts, possible mutation from bounded inference, and textual mention from transcript content/tool references. Preserve original and normalized lexical paths plus cwd/source provenance; never use realpath or a shell-string guess to promote confidence.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/derivers.ts:228 — canonical direct-tool mutation derivation and mutation_path
- src/derivers.ts:628 — bounded Bash mutation classifier and targets
- src/commit-work/attribution.ts:180 — durable mutation-event query precedent
- src/compaction.ts:1 — why native transcripts, not retained event bodies, source full text
- src/transcript/model.ts:1 — tool input/result and role provenance

**Optional** (reference as needed):
- cli/search-history.ts:106 — literal LIKE escaping behavior being replaced
- cli/find-file-history.ts:11 — live-only attribution limitation being corrected

### Risks

FTS punctuation, malformed advanced queries, huge snippets, relative paths, cwd drift, symlinks, rename/delete endpoints, partial shell failure, and transcript claims can all produce misleading or expensive results unless bounded and graded.

### Test notes

Pin literal punctuation and quote handling, advanced syntax failures, ranking ties, pagination stability, filters, branch provenance, result context handles, and every evidence-grade transition. Include failing tools and shell commands that mutate before failure.

### Detailed phases

1. Define typed search/filter/result/problem-code contracts and literal-to-FTS quoting.
2. Implement deterministic ranked entry search and surrounding-context locators.
3. Normalize path queries and map canonical mutation events/tool results into observed or possible evidence.
4. Add transcript mentions as an explicit opt-in result class and group/deduplicate by session/path/evidence source.
5. Thread partial-root/index warnings without turning usable results into transport failures.

### Alternatives

A single untyped search endpoint is rejected because FTS relevance and path-evidence confidence require different matching and result semantics.

### Non-functional targets

Cap query length, result count, snippet bytes, highlight work, and per-session dominance; bind all SQL parameters; keep advanced syntax opt-in; never log bodies or queries.

### Rollout

Internal query APIs land before the public CLI. Search remains unavailable rather than silently falling back to incomplete Keeper event bodies when the native-derived index cannot be read.

## Acceptance

- [ ] Literal full-text queries safely handle arbitrary punctuation and quotes; advanced FTS syntax is available only through an explicit mode with typed syntax errors.
- [ ] Search filters and deterministic ranking/pagination return entry-level results containing session, project, role, source, branch, timestamp, snippet, and a stable command-ready context locator.
- [ ] Meta and thinking entries are excluded by default but searchable through explicit filters; binary/image payloads never enter text search.
- [ ] File queries return observed mutation, possible mutation, and optional mention as separate grades with tool/event/outcome/cwd/path provenance.
- [ ] Relative paths, renames, deletes, symlinks, globs, unknown cwd, and uncertain or partially failing shell commands never receive stronger evidence than the source proves.
- [ ] Partial discovery and stale/rebuild states surface structured warnings while hard index failures remain distinct from zero matches.
- [ ] Focused search and evidence tests pass with bounded fixture corpora.

## Done summary

## Evidence
