## Description

**Size:** S
**Files:** plugin/hooks/events-writer.ts, src/db.ts (maybe — canonical column list), test/events-writer.test.ts, CLAUDE.md, README.md

### Approach

Make the hook's `events` INSERT column-adaptive. After `openDb({migrate:false})`,
probe the live columns with `PRAGMA table_info('events')` (mirror
`addColumnIfMissing` at `src/db.ts:1432-1445`), build a Set, intersect it
with the hook's known binding keys, and construct the INSERT
(`INSERT INTO events (<live∩known>) VALUES ($<live∩known>)`) from the
survivors — named `$col` bindings only, never positional, omit keys never
reorder. A column the live DB lacks (daemon not yet migrated) is simply
absent → lands NULL after the daemon migrates, identical to today's value.
This is the keystone: it converts the total-drop skew window into a
lossless-degraded one.

Keep it HOOK-LOCAL: `prepareStmts().insertEvent` (`src/db.ts:4750-4783`) is
shared with the daemon's ~7 synthetic-mint sites (`src/daemon.ts`), which
always run post-migrate; do NOT make the shared statement adaptive unless
you prove the intersection is identity on a migrated DB. Build the adaptive
INSERT in the hook.

Preserve the genuine-failure path: the degrade covers ONLY known-missing
columns. A missing `events` table entirely, a corrupt DB, or real
lock-exhaustion must STILL dead-letter + exit 0 (the existing
`deadLetter()` + `writeDropLog` path at ~:640-694, and the retry loop at
~:703-773). The "no such column → non-retriable → dead-letter"
classification (~:732-734) is intercepted BEFORE it fires — by building the
correct column set up front, that error never arises for a known column;
an UNKNOWN column error (shouldn't happen) still dead-letters. Emit a
stderr line naming any dropped columns for observability.

### Investigation targets

**Required** (read before coding):
- plugin/hooks/events-writer.ts ~:593-630 (bindings, incl. backend_exec keys ~:627-629), ~:696-712 (openDb {migrate:false} + the stale-schema comment to update), ~:703-773 (run/retry/dead-letter), ~:640-694 (deadLetter/writeDropLog)
- src/db.ts ~:4750-4783 `prepareStmts().insertEvent` (the static all-columns INSERT — the shape to make adaptive hook-side; SHARED with daemon, do not break)
- src/db.ts ~:1432-1445 `addColumnIfMissing` (the canonical `PRAGMA table_info` probe to mirror)
- src/db.ts ~:353-389 vs ~:642-646 — the TWO `CREATE_EVENTS` literals; verify which is the authoritative live `events` shape before deriving any column list
- test/events-writer.test.ts ~:53-134 (the harness: `sandboxedBaseEnv()` MANDATORY, `fireViaLauncher`, the pre-migrate beforeEach to swap for an old-schema build), ~:39 (`parseDeadLetterLine` import)

**Optional**:
- src/daemon.ts (the synthetic-mint sites that share insertEvent — confirm hook-local change leaves them untouched)
- ~/docs/keeper-reliability/findings.md (the SEV writeup)

### Risks

- **Shared-seam blast radius:** if the adaptive build accidentally changes `prepareStmts().insertEvent`, it touches all 7 daemon mint sites. Keep it hook-local OR prove identity on a migrated DB.
- **Swallowing genuine failures:** the degrade must NOT turn a corrupt-DB / missing-table / real-BUSY error into a silent success. Intersection covers known-missing columns only; everything else flows to dead-letter unchanged.
- **Wrong CREATE_EVENTS source:** two divergent literals exist; deriving the known-column list from the non-authoritative one would omit real columns. Verify first.
- **Cold-start budget:** one `PRAGMA table_info` is microseconds (page 1), but don't add per-retry re-probes — probe once, build once, reuse across the retry loop.
- **Re-fold determinism:** unaffected (INSERT-side; an omitted column = NULL = the deriver's current value), but confirm the reducer reads a missing/NULL backend_exec as the zero-event value.

### Test notes

Add to test/events-writer.test.ts (via `sandboxedBaseEnv()`):
(a) SKEW-SIM: build an `events` table missing a column the hook knows
(CREATE the old column set, or migrate-then-`ALTER TABLE events DROP COLUMN
backend_exec_type`), `fireViaLauncher`, assert exit 0 AND a row landed
(readback) AND `readdirSync(KEEPER_DEAD_LETTER_DIR)` is empty (no
dead-letter). (b) NEGATIVE: a DB with NO `events` table → still dead-letters
+ exit 0 (the carve-out holds). (c) HAPPY: a fully-migrated DB → full-column
INSERT unchanged (the intersection is identity). Confirm the daemon's
synthetic-mint INSERTs are untouched (run the existing daemon/reducer tests).

## Acceptance

- [ ] Hook INSERT built from `known ∩ live` columns via `PRAGMA table_info`; a known-missing column is omitted and the INSERT succeeds (not dead-lettered)
- [ ] Genuine failures (no events table / corrupt / real BUSY) still dead-letter + exit 0 — carve-out preserved
- [ ] skew-sim test (degrade-and-succeed, no dead-letter) + negative test (broken DB still dead-letters) + happy test (full-column identity) all green
- [ ] Hook-local: `prepareStmts().insertEvent` + daemon mint sites unchanged; no third-party deps; one PRAGMA per invocation; stderr names dropped columns
- [ ] CLAUDE.md (2 bullets) + README hook narrative updated; committed to main staging only touched files

## Done summary

## Evidence
