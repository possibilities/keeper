## Description

**Size:** M
**Files:** src/commit-work/lint-matrix.ts, src/commit-work/domain-docs-lint.ts, test/domain-docs-lint.test.ts, docs/problem-codes.md

### Approach

A new lint arm in keeper commit-work's matrix, firing when staged files include CONTEXT.md, CONTEXT-MAP.md, or docs/adr paths — in ANY repo (the check travels in the binary; gate only on staged paths, not on repo-local script presence). The scanner is a pure, deterministic module mirroring the lint-claude-md shape (pure scan functions over text, fixture-driven tests). Checks, all hard-blocking: CONTEXT.md size cap (~140 lines), per-definition sentence cap (2), every term carries a non-empty Avoid line, the existing re-narration fingerprints (fn-ids, versions, ISO dates, provenance words), and the implementation-detail fingerprints — file-path-shaped tokens (require ≥2 path segments AND a known extension — deliberately under-capturing), code fences beyond a signature line, call-signature-shaped text. Fingerprints run only on prose: parse the markdown structurally and skip fenced/inline-code and link destinations (AST-scoped, not raw line regex). docs/adr checks: NNNN-slug.md naming, sequential numbering, per-file size cap (~80 lines), with the history fingerprints DISABLED there (ADRs are the sanctioned history home). An inline escape hatch — keeper-lint off/on HTML comment markers — suppresses fingerprint checks (never structural caps) for the bounded region. Every failure: (a) maps to the existing LintFailure shape so the lint_failed envelope carries linter, files, and per-rule stderr; (b) appends one NDJSON record {ts, repo, file, rule, line} to a state-dir pain ledger, env-overridable for test sandboxing (mirror the drop-log pattern). A scanner crash fails closed with a clear message, never an unhandled rejection out of the matrix's Promise.all. Acceptance includes a positive/negative fixture corpus — known-good glossary lines that must pass (including prose mentioning CLI commands) and known-bad lines that must fail — since no prior-art glossary linter exists to copy.

### Investigation targets

*Verify before relying.*

**Required**:
- src/commit-work/lint-matrix.ts:184 (runScopedLint tasks[] registration) and :390-414 (the order:10 claude-md arm — the slot pattern; note it gates on script existence, which this arm must NOT copy)
- src/commit-work/lint-matrix.ts:55 (LintFailure) and cli/commit-work.ts:610-629 (lint_failed envelope + recovery string)
- scripts/lint-claude-md.ts — the pure-scanner + CONTENT_PATTERNS + fixture-test shape to mirror
- test/lint-claude-md.test.ts — the fixture-driven test pattern
- An existing state-dir log for the ledger pattern (KEEPER_DROP_LOG handling in src/)

### Risks

- False positives are the adoption killer: fingerprints must under-capture by design; the fixture corpus is the proof, and the escape hatch is the relief valve.
- ReDoS: bound every fingerprint regex; no unanchored nested quantifiers.
- Do NOT rescan CLAUDE.md/README.md (owned by the existing arm) — CLAUDE.md is intentionally path-dense.

### Test notes

Fixture corpus drives the pure scanner; one integration-shaped test through runScopedLint with injected staged files. Ledger writes go under the sandboxed env path.

## Acceptance

- [ ] A commit staging a CONTEXT.md with an implementation-detail leak, an over-cap file, or a malformed ADR fails with the lint_failed envelope naming the domain-docs linter and per-rule findings, in any repo
- [ ] Known-good fixture lines (including prose naming CLI commands and slash-terms) pass; known-bad fixture lines fail — the corpus ships in the test suite
- [ ] ADR files accept dates and decision history; CONTEXT.md rejects them
- [ ] The escape marker suppresses fingerprint findings for its region but never structural caps
- [ ] Each failure appends one NDJSON pain-ledger record under an env-overridable state path
- [ ] A repo with no CONTEXT.md or docs/adr staged is completely untouched by the arm

## Done summary
Added the domain-docs lint arm to commit-work: a deterministic pure scanner (src/commit-work/domain-docs-lint.ts) gates CONTEXT.md/CONTEXT-MAP.md (structural caps + prose-only impl-detail/re-narration fingerprints, keeper-lint escape hatch, NDJSON pain ledger) and docs/adr (naming/size, history allowed), wired at order 11 in the lint matrix and gated on staged paths so it fires in any repo. Fixture corpus of 23 tests proves good/bad lines.
## Evidence
