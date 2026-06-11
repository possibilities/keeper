## Description

**Size:** M
**Files:** babysitters/helptailing/watch.ts, test/helptailing-watch.test.ts, test/babysitter-build.test.ts

### Approach

Clone the `performance` sitter's skeleton (seen-state module, tick flow,
`--json`/`--tick`/`--window-secs` CLI, `if (import.meta.main)` guard,
`const SLUG = "helptailing"`) and replace the detector layer with trend math.
Keep every detector a pure exported `(input) => Finding[]` function; the thin
`scan()` does the bounded DB read over injected `ScanDeps` (`nowSecs` injected;
epoch boundary `2026-06-11T00:00:00Z` is a hardcoded constant, NOT derived from
now). Open with `openDb(dbPath, { readonly: true, prepareStmts: false })`.

Detection: Bash PreToolUse rows ONLY (PostToolUse carries the same command —
counting both double-counts 2x). SQL gate `data LIKE '%--agent-help%'` with the
`CASE WHEN json_valid(data) THEN json_extract(data,'$.tool_input.command') END`
guard (bare json_extract THROWS on malformed/NULL data), then application-layer
validation: `--agent-help` must appear as a flag token, and the pipe target
(tail/head/grep/none) is extracted via a minimal quote-aware character walk
(in_single/in_double/escaped state) — recorded as evidence, NEVER a filter
(live data pipes to head/grep more than tail).

Baselines — two distinct things, one word: (a) the FROZEN historical count
(pre-2026-06-11), computed ONCE when the sidecar file under
`babysitterStateDir("helptailing")` is absent, persisted forever. This
all-history scan MUST `LEFT JOIN event_blobs b ON b.event_id = e.id` and read
`COALESCE(e.data, b.data)` — without the join the count reads ~8 instead of
~118 and fabricates a fake drop. Self-check: if the seeded baseline lands
suspiciously near the known no-join undercount, write the sidecar with a loud
`suspect: true` flag rather than silently poisoning every future RR. On scan
failure the tick exits 0 unbaselined and retries next interval. (b) the
performance-style cold-start seen-state seeding — keep as-is from the clone.
The epoch-1 count is RECOMPUTED each tick (scan `ts >= boundary`, same COALESCE
join), never accumulated — idempotent under launchd double-fires.

Findings (the `Finding` contract `{key, fingerprint, severity, category,
title, detail, evidence}` from performance): (1) `trend-digest` — one per ISO
week, key `trend-digest:weekly:helptailing:<YYYY-Wnn>`, severity info; carries
RR = (epoch_hits/epoch_sessions)/(baseline_hits/baseline_sessions), weekly
bucket table, raw numerators + denominators. Per-period keys make each digest
its own finding with a terminal verdict — deliberately sidesteps the ledger's
resurface rule, which assumes a "fixed" state a trend never has. (2)
`rate-spike` — emitted when the epoch window clears a >=5 raw-occurrence floor
AND the Garwood-exact rate-ratio CI lower bound exceeds 1.5 (inline
Wilson-Hilferty inverse chi-square, ~20 lines, no stats dep); fingerprint
folds the RR band so a persisting spike re-emits only on band change. Below
the floor, the digest carries `insufficient_data: true` as an annotation —
these gates are evidence annotations, not page preconditions, because:

NO NOTIFICATION PATH. Do not clone `spawnAgentLive`, botctl/notifyctl calls,
or any paging. The scanner writes followup files DIRECTLY to
`<stateDir>/followups/` in the FINDINGS-LEDGER format the performance AGENT
doc specifies: filename `helptailing-<unix-ts>-<sha1_8(key)>.md`, YAML
frontmatter (key/fingerprint/category/severity — frontmatter is canonical),
injection-safe fenced `## Evidence` echoing the key, `latest.md` via
tmp+rename. Followup paths are fixed-prefix + sanitized key, never
interpolated from event data. seen-state dedup prevents rewriting the same
finding every hourly tick; heartbeat still written each tick. No watchdog.

### Investigation targets

**Required** (read before coding):
- babysitters/performance/watch.ts:1456-1559 — scan() + the mandatory readonly/prepareStmts:false open
- babysitters/performance/watch.ts:185-211 — Finding contract + stable fingerprint helper
- babysitters/performance/watch.ts:1925-2071 — seen-state module to clone (cooldown/TTL constants, heartbeat)
- babysitters/performance/watch.ts:2415-2485 — tick() state machine (mirror minus spawn/page)
- babysitters/performance/watch.ts:1130-1135 — sidecar-baseline file precedent (backstop-baseline.json)
- babysitters/agents/performance.md:203-338 — the followup-file format (this scanner now writes it itself)
- babysitters/lib/state.ts:14 — babysitterStateDir(slug); never re-derive the path
- src/db.ts:358-406, 824-829 — events schema + event_blobs sidecar (FK column is event_id)
- test/keeper-watch.test.ts:137-186 — insertEvent/ev()/quietDeps test pattern + freshDbFile()
- test/babysitter-build.test.ts:50-53 — SITTER_ENTRYPOINTS import-pin

**Optional** (reference as needed):
- babysitters/FINDINGS-LEDGER.md — key extraction priority (frontmatter canonical), resurface rule the per-period keys sidestep
- src/db.ts:835-841 — the json_valid CASE guard to mirror

### Risks

- The all-history baseline scan over a 2.6 GB DB inside a launchd tick — keep
  it a one-shot gated on sidecar absence; if it proves slow, it still only
  runs once per install. Exit-0-and-retry on failure, never block.
- Trend math is the genuinely new code; everything else is a clone. Keep the
  RR/CI/bucketing functions pure and unit-test them against hand-computed
  fixtures (including zero-count epoch → "no occurrences", not RR=0).

### Test notes

Pure-detector tests with no live DB (describe per detector); `freshDbFile()`
for the scan-path tests; flag-token and quote-aware-walk false-positive cases
(`grep -E 'foo|tail'`, quoted `'--agent-help | tail'`, heredoc); the
event_blobs COALESCE join proven by a test that relocates a row's data to
event_blobs and asserts the count still sees it; PreToolUse-only proven by
inserting matching Pre+Post pairs and asserting count 1. Add
`babysitters/helptailing/watch.ts` to SITTER_ENTRYPOINTS in
test/babysitter-build.test.ts. `bun run test:full` before landing
(db/process paths). Poll-don't-sleep via retryUntil for anything async.

## Acceptance

- [ ] `bun babysitters/helptailing/watch.ts --json` emits valid findings JSON against the live DB; `--tick` seeds the baseline sidecar on first run and writes followups + heartbeat
- [ ] Baseline computed with the event_blobs COALESCE join; suspect-undercount self-check present and tested
- [ ] PreToolUse-only counting, json_valid guard, flag-token match, quote-aware pipe-target extraction — each pinned by a test
- [ ] Epoch count recomputed per tick (test: two consecutive ticks don't double-count)
- [ ] trend-digest (per-ISO-week key) + rate-spike (floor + Garwood CI gate, RR-band fingerprint) findings conform to the Finding contract; followup files carry canonical YAML frontmatter and parse per FINDINGS-LEDGER's three-shape rule
- [ ] Zero notification/spawn code paths; no write to any KEEPER_* path; DB opened readonly
- [ ] SITTER_ENTRYPOINTS updated; fast tier green; `bun run test:full` green

## Done summary

## Evidence
