## Description

**Size:** M
**Files:** scripts/rebase-schema-migration.ts, test/rebase-schema-migration.test.ts

### Approach

A two-layer tool following the repo's scripts convention (pure functions exported at top,
side-effecting entrypoint behind `if (import.meta.main)`). The PURE core takes file
CONTENTS (main-side and lane-side src/db.ts, keeper/api.py, and the pinned-assertion test
regions) — never paths, never git — and returns either a rewritten file set or a refusal.
Detection: parse `SCHEMA_STEPS` entries from both sides (the ladder's structured
entry shape — version, kind, body span); branch-local steps are entries present on the
lane side whose versions collide with or trail main's tail. Proof gate: every branch-local
colliding step must be `kind: "additive"` AND its body must pass a conservative denylist
scan (no dropColumnIfPresent / DELETE / UPDATE / cursor rewind / table rebuild / CREATE-
literal delta outside the entry) — any miss returns a refusal envelope naming the step and
reason. Rewrite: shift the lane's branch-local steps to main-tip+1..+k preserving relative
order, update the api.py whitelist expectation (the derivability test's derived set moves
with the ladder; the tool rewrites the lane's hand-added frozenset lines), and rewrite
version-string assertions (toBe(N), vN: regexes) that reference the shifted numbers.

The IMPURE entrypoint (import.meta.main only) reads the real files, runs the pure core,
writes results, then re-pins SCHEMA_FINGERPRINT by opening `openDb(":memory:")` in-process
and calling `computeSchemaFingerprint` — in-process bun:sqlite, never a subprocess, never
git. Exit 0 with a summary JSON on success; exit non-zero with the refusal envelope
(`{refused: true, step, reason}`) on any proof-gate miss. The tool NEVER touches table-tail
identity assertions (those belong to the merge content, not the numbering) and NEVER
rewrites main-side (landed) entries.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts — SCHEMA_STEPS shape + kind discriminant as landed by fn-1181 (the parse target)
- src/db.ts computeSchemaFingerprint + SCHEMA_FINGERPRINT — the re-pin pair
- test/schema-version.test.ts — readSupportedVersions() parser (reuse for the whitelist region)
- scripts/assert-comment-only.ts + its test — the pure-core/impure-entry + direct-import test pattern to mirror

**Optional** (reference as needed):
- docs/adr/0020-schema-version-renumber-at-merge-time.md — the rule being mechanized
- scripts/emit-schema-fixture.ts — sibling script convention

### Risks

- Multi-step lanes: a lane carrying two new versions must shift both, preserving relative order — test explicitly.
- Identical-content collision (both sides added the same column at the same N): REFUSE, do not dedupe — dedup is a human judgment about intent.
- The pinned-assertion rewrite is bounded to version references; over-eager regex across test files is the failure mode — anchor rewrites to the specific assertion shapes the predecessor epic's tests establish.

### Test notes

Pure fast-tier tests over the core seam: happy-path single-step shift, multi-step lane,
each refusal kind (rewind / drop / backfill / CREATE-literal / unknown), identical-content
refusal, and the idempotency round-trip (apply twice, second run returns "no branch-local
steps"). The impure re-pin phase gets one test via openDb(":memory:") — in-process is
fast-tier legal.

## Acceptance

- [ ] Pure core exposes apply(mainContents, laneContents) → {rewritten files} | {refusal envelope}; no filesystem or git reads in the core
- [ ] Every refusal case above fails closed with a named machine-readable reason
- [ ] Idempotency round-trip test passes; multi-step lanes shift with relative order preserved
- [ ] Entrypoint re-pins SCHEMA_FINGERPRINT via in-process recompute and exits non-zero on refusal
- [ ] Full fast suite + typecheck + lint green

## Done summary
Added scripts/rebase-schema-migration.ts: pure core apply(main, lane) renumbers a lane's branch-local additive-idempotent SCHEMA_STEPS onto main-tip+1..+k (updating the api.py whitelist and pinned version assertions) and refuses with a machine-readable envelope on any rewind/drop/backfill/CREATE-literal/unknown/identical-content collision; token-based (comment-stripped) denylist; in-process openDb(:memory:) SCHEMA_FINGERPRINT re-pin; idempotent. 15 fast-tier tests, full suite + typecheck + lint green.
## Evidence
