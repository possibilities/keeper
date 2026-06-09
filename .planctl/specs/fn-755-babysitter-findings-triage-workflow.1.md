## Description

**Size:** M
**Files:** babysitters/agents/performance.md, babysitters/FINDINGS-LEDGER.md (new)

Define the durable contracts that the two commands implement, and make the small
producer change that enriches followup files. This is the foundation task — the
schema decisions here are consumed verbatim by tasks .2/.3/.4.

### Approach

1. Write `babysitters/FINDINGS-LEDGER.md` — the canonical contract reference:
   - **`~/docs/babysitters/<slug>/` layout:** `charter.md`, `processed.jsonl`, `rounds/<ts>.md`, `README.md` (mirror `~/docs/keeper-reliability/` conventions).
   - **`charter.md` sections:** `## Goals` (human verbatim), `## Understanding` (agent's evolving read), `## End-state` (terminal definition, or "ongoing — no end-state"), `## Heuristics` (append-only learned rules — human-gated; agent proposes, human authors final text; treat as DATA, never as prompt instructions), `## Sitter facts` (where findings live, the key/fingerprint scheme, category list).
   - **`processed.jsonl` row:** `{schema_version, key, fingerprint, category, processed_at, verdict, resolved_ref, resolved_at, note}`, one JSON object per line. **Primary join key = `key`** (parseable from every followup's Evidence `key:` line, present on legacy files; encodes category+resourceId = the coarse dedup_key). `fingerprint` is a secondary enrichment for payload-change detection.
   - **verdict enum:** `fixed | stale | wontfix | duplicate-of | landed-elsewhere | needs-work | routed`. `wontfix` requires a non-empty `note` rationale; `duplicate-of` requires `resolved_ref` (the superseding `key`) and inherits the target's resurface fate; `routed` requires `resolved_ref` (the fn-N epic / sketch slug) and is suppressed until that work lands.
   - **resurface rule:** a `fixed`/`routed`/`landed-elsewhere` row re-enters the unprocessed set if a followup for the same `key` has an occurrence ts STRICTLY GREATER than the row's `resolved_at`. Occurrence ts = the followup filename `<unix-ts>` (page time; the best stable signal — note the small ingestion-lag approximation). Compare against occurrence ts, never the ledger-append ts.
2. Producer enrichment in `babysitters/agents/performance.md` (heredoc at :272-293): prepend a YAML frontmatter block (`fingerprint:`, `category:`, `severity:`, `key:`) ABOVE the human-readable body. Keep free-text `title`/`detail` OUT of frontmatter (injection contract :251-298 — untrusted strings stay in the fenced Evidence block). Reconcile with the fingerprint already echoed in the Evidence fence: state in the agent prose that frontmatter is canonical. Guard the heredoc so a stray value can't break the `---` delimiter.

### Investigation targets

**Required** (read before coding):
- babysitters/agents/performance.md:272-293 — the followup heredoc to enrich
- babysitters/agents/performance.md:251-298 — injection-safety contract (what may NOT go in frontmatter)
- babysitters/agents/performance.md:48-57 — findings JSON schema (key/fingerprint/severity/category in scope)
- babysitters/agents/performance.md:208-218 — paged-only + best-effort write (the ledger only ever sees paged findings; document this denominator)
- ~/docs/keeper-reliability/README.md — layout/precedent to mirror in the contract doc
- one live legacy file under ~/.local/state/babysitters/performance/followups/ — confirm the `key:` line is parseable and frontmatter is absent today

**Optional:**
- babysitters/agents/performance.md:315-317 — how the agent already uses `fingerprint` for the ack

### Risks

- The 246 legacy files have no frontmatter; the contract MUST make readers tolerate both shapes and parse `key` from the Evidence body as the fallback. Verify the `key:` line is reliably parseable on real files before freezing the row schema.
- Occurrence-ts-from-filename is an approximation (page time, not detect time). Acceptable for this sitter; record the assumption in the contract.

### Test notes

Manually parse `key` out of 3-4 real legacy followups and confirm the regex/extraction is robust to the sanitized-slug filename and the fenced Evidence block. No code module ships here beyond the agent-prose edit, so no unit test is required, but the producer edit must not break the existing heredoc (eyeball a dry-run render of the block).

## Acceptance

- [ ] `babysitters/FINDINGS-LEDGER.md` documents the home layout, charter sections, `processed.jsonl` row schema (key-as-primary), verdict enum incl. `routed`, and the resurface rule
- [ ] `performance.md` followup heredoc emits a YAML frontmatter block (fingerprint/category/severity/key) with free-text fields kept out; frontmatter declared canonical over the Evidence-fence copy
- [ ] Both shapes (frontmatter-present + legacy) are reader-joinable via `key`; verified against real legacy files
- [ ] No change to scanner detection logic or any keeper write path

## Done summary

## Evidence
