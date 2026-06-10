## Description

**Size:** M
**Files:** src/db.ts

### Approach

Epic Scrub standard + Verification recipe. Targets (~1,800 of 3,927 comment lines): per-function DDL narratives describing what columns hold; DEFAULT-constant multi-line essays; env-var resolver precedence walkthroughs; schema-version histories ("v29 added sort_path..."); ~123 fn-NNN refs. KEEP (floor item 10): the forward-only migration guard, the runtime downgrade-guard constraint, and the SUPPORTED_SCHEMA_VERSIONS same-commit cross-repo rule — compressed.

### Investigation targets

**Required** (read before coding):
- The epic spec (planctl cat) — Scrub standard, sacred floor, Verification recipe

### Risks

The migration ladder comments include genuinely load-bearing version-guard notes — if uncertain, keep.

### Test notes

Per recipe; db.ts is slow-tier — test:full mandatory.

## Acceptance

- [ ] Verifier passes post-format on src/db.ts; typecheck + biome + test:full green, zero new failures
- [ ] Floor item 10 present; zero fn-NNN refs and schema-version changelogs remain
- [ ] Done summary reports lines and chars deleted

## Done summary
Scrubbed bloat comments from src/db.ts: -3103 lines (-203602 chars), comment-only by verifier (token + transpile equality). Removed schema-version histories, per-column field-semantics essays, DDL narratives, and ~123 fn-NNN/incident refs; compressed kept constraints (floor item 10, sort_path ASCII invariants, v57-v58 offline rebuild contract). typecheck + biome + test:full green, zero new failures.
## Evidence
