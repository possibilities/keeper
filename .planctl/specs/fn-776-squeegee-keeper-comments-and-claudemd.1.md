## Description

**Size:** S
**Files:** scripts/assert-comment-only.ts (new), test/assert-comment-only.test.ts (new), package.json

### Approach

A bun-runnable verifier: for each file path argument, load the committed baseline via `git show HEAD:<path>` and compare against the working tree. Three checks, all must pass: (1) token-sequence equality using ts.createScanner(ScriptTarget.Latest, skipTrivia=true) with JSX language variant by extension — comments/whitespace are trivia, so any difference means code changed; (2) ts.transpileModule output equality with a fixed compilerOptions object; (3) protected-pattern guard — occurrence counts of `biome-ignore`, `@ts-ignore`, `@ts-expect-error`, `c8 ignore`, `sourceMappingURL`, `SPDX` must not decrease. A file with zero changes passes. Non-zero exit prints the file and first differing token pair. Must work on plugin/ files (no tsconfig dependency — operate on raw text). Use the existing `typescript` devDependency; add a `package.json` script entry `assert-comment-only`. Print per-file deleted-line and deleted-char counts on success (scoreboard feed).

### Investigation targets

**Required** (read before coding):
- package.json — script entries, typescript devDependency presence
- test/helpers/ — test style for fast-tier unit tests (this test is fast-tier: no subprocess, no DB)

**Optional** (reference as needed):
- src/commit-work/lint-matrix.ts:183 — why this script exists outside the commit-time matrix

### Risks

Regex-based comment detection is forbidden — strings/regex-literals/templates containing `//` must not be misread; the scanner approach handles this, fixtures must prove it.

### Test notes

Fixtures: comment-removed file passes; single-token code change fails; deleted biome-ignore fails; string containing `https://` unchanged passes; template literal with `/* */` content unchanged passes. `bun test test/assert-comment-only.test.ts` green.

## Acceptance

- [ ] Verifier compares against the HEAD blob, not the index; zero-diff passes
- [ ] Token, transpile, and protected-count checks all implemented; first differing token printed on failure
- [ ] Fixture tests cover strings/regex/template false-positive cases and all three failure modes
- [ ] Works on a plugin/ path; reports deleted lines/chars per file
- [ ] `bun test` green; `keeper commit-work` lands it

## Done summary
Added scripts/assert-comment-only.ts: a bun verifier gating every scrub task via TS-scanner token equality + transpile-output equality + protected-pattern guard against the HEAD blob (raw-text, so plugin/ paths are covered). Fixture tests prove string/regex/template false-positives pass and all three failure modes fail; package.json gains an assert-comment-only script. Net new code (foundation task, no scrub yet): +0 deleted lines, +0 chars.
## Evidence
