## Description

**Size:** M
**Files:** scripts/lint-claude-md.ts, test/lint-claude-md.test.ts, src/commit-work/lint-matrix.ts, package.json

### Approach

Create `scripts/lint-claude-md.ts` modeled on `scripts/lint-no-real-git.ts`:
a header docblock; a PURE exported `scanText(text): Finding[]` returning
size findings and content findings; a `main(): number` that reads the
literal `CLAUDE.md` path, prints a `[lint-claude-md] ...:` header + one line
per finding + a remediation paragraph that NAMES `README ## Architecture` as
the destination, returns 1 on any FAIL and 0 when clean; and
`if (import.meta.main) process.exit(main())`. Drop the allowlist machinery
(one fixed file, zero-tolerance). Two gate classes:
- **SIZE** — FAIL if `lines > 120` OR `bytes > 16384` (`bytes =
  Buffer.byteLength(text,"utf8")`, `lines = text.split("\n").length`); WARN
  to stderr (exit stays 0 for warn-only) if `lines > 100`.
- **CONTENT** — FAIL on, per line: `/\bfn-\d+/`, lowercase version numbers
  `/\bv\d{2,}\b/` (matches `v74`, NOT the all-caps `SCHEMA_VERSION`), ISO
  dates `/\b20\d{2}-\d{2}-\d{2}\b/`, and past-tense provenance
  `/\b(formerly|used to|no longer|previously|retired|replaced|removed in)\b/i`.
  Keep the banned vocabulary IN the script, never quoted in CLAUDE.md prose.

Then add a matrix arm to `runScopedLint` in `src/commit-work/lint-matrix.ts`:
gated on `stagedFiles.includes("CLAUDE.md")` AND
`existsSync(join(cwd,"scripts/lint-claude-md.ts"))` so it is a strict no-op
in non-keeper repos; run `["bun", scriptPath]` via the existing `runTool`,
recording `{linter:"claude-md", files:["CLAUDE.md"], stderr}` on non-zero —
slot it as the next `order` index, mirroring the `cli-boundaries` arm shape
(lint-matrix.ts:258-272). The existing `LintFailure` → `lint_failed`
envelope carries it through unchanged. Add a `package.json` `lint:claude-md`
script alias for manual/CI runs.

### Investigation targets

**Required** (read before coding):
- scripts/lint-no-real-git.ts — the template: `scanText` export, `main`, `import.meta.main` idiom, the `[name] N ...:` error shape
- src/commit-work/lint-matrix.ts:183-420 — `runScopedLint`: the `tasks[]` + `order` index, `RecordedFailure`, and the `cli-boundaries` arm at :258-272 (the `existsSync`-gated script shell-out to mirror)
- test/lint-retired-name.test.ts — the lint-test precedent (fast tier, mkdtemp fixture)
- package.json:13-15 — the `assert-comment-only` / `lint:retired-name` / `test:hygiene` script-alias shape

**Optional** (reference as needed):
- src/commit-work/lint-matrix.ts:1-37 — docblock convention for a new arm
- test/* for any existing commit-work / lint-matrix coverage to extend

### Risks

- The version regex must NOT nuke the kept `SCHEMA_VERSION` /
  `SUPPORTED_SCHEMA_VERSIONS` symbols in CLAUDE.md `## Migrations` —
  `\bv\d{2,}\b` does not match an all-caps symbol; pin it with a fixture
  asserting a Migrations-style line PASSES.
- The matrix arm must stay a no-op in non-keeper repos (commit-work is a
  general tool) — the `existsSync` gate is load-bearing.
- Scan the literal path `CLAUDE.md`, never a glob — the `AGENTS.md` symlink
  would double-hit.
- A future rule that must quote a date/version in an example would trip the
  line scanner; acceptable for now (zero-tolerance) — document "don't quote
  the banned tokens" rather than build code-fence skipping.

### Test notes

`test/lint-claude-md.test.ts` drives the pure `scanText` with fixtures (no
subprocess, fast tier, no real git): a clean stripped sample PASSES; samples
containing `fn-123` / `v74` / a `2026-06-23` date / "no longer" / 130 lines /
a >16KB body each FAIL; a `SCHEMA_VERSION` line and a "would otherwise" line
PASS (no false positive). Optionally exercise the matrix arm's
staged/not-staged gating via a direct `runScopedLint` call.

## Acceptance

- [ ] `scripts/lint-claude-md.ts` exists, exports a pure `scanText`, exits 1 on any size/content fail and 0 when clean, and names `README ## Architecture` in its remediation text
- [ ] FAIL when CLAUDE.md is >120 lines OR >16384 bytes; non-failing WARN above 100 lines
- [ ] CONTENT fail on `fn-\d+`, lowercase `v\d{2,}`, ISO dates, and past-tense provenance words; NO false positive on `SCHEMA_VERSION` / `SUPPORTED_SCHEMA_VERSIONS` / "would otherwise"
- [ ] `src/commit-work/lint-matrix.ts` runs the lint as a `claude-md` arm ONLY when CLAUDE.md is staged AND `scripts/lint-claude-md.ts` exists at cwd, surfacing via the existing `lint_failed` envelope
- [ ] the arm is a verified no-op when CLAUDE.md is not staged and in a repo lacking the script
- [ ] `test/lint-claude-md.test.ts` covers pass + each fail class + the `SCHEMA_VERSION`/"would otherwise" non-false-positive, in the fast tier with no real git
- [ ] `package.json` carries a `lint:claude-md` alias; `bun run test:full` (and the new tests) green

## Done summary

## Evidence
