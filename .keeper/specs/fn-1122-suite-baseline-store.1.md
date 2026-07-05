## Description

**Size:** S
**Files:** src/baseline-store.ts, test/baseline-store.test.ts

### Approach

The dependency-free contract module every other task consumes. Defines the
key — (repo identity via the existing repo-dir hash, commit sha, toolchain
fingerprint = Bun version + platform) — and the on-disk layout under the
keeper state dir: a request-spool directory (one size-bounded JSON file
per request; the CLI is its sole writer) and per-key result leafs (the
baseline worker is their sole writer). Defines the result envelope as a
discriminated union — green, suite-red (failing-test identities, per-run
records including retries, flaky-suspect marks), infra-error (kind:
checkout | install | spawn), timeout — plus the read-side states miss and
computing. Ships pure helpers in the restart-ledger shape: fail-open
parse, atomic write, bounded retention eviction (leaf count cap), and the
pure verdict logic (classify a suite run + one same-sha retry of failures
into the envelope; an infra failure is never derivable as green). Prose
and identifiers say "baseline" / "leaf" / "spool" — never "cache",
"snapshot", or "sidecar" (glossary collisions).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:2088-2165 — restart-ledger helpers: the fail-open parse + atomic write + hard-cap template to mirror
- src/keeper-state-dir.ts:20 — keeperStateDir(); all paths resolve through it
- src/worktree-plan.ts:211 — repoDirHash; reuse for the repo component of keys and paths
- CONTEXT.md — Baseline term and the Avoid lists that constrain naming

**Optional** (reference as needed):
- src/dead-letter.ts — dep-free helper style the hook-adjacent modules keep; this module stays similarly dependency-light
- test/helpers (sandboxEnv, freshMemDb) — the sandbox idioms the test file uses

### Risks

- The envelope union is the epic's contract: getting infra-vs-suite separation or flaky marks wrong propagates into the worker, CLI, and prose tasks. Encode the union so "could not run" cannot type-check as a green result.
- Attacker-influenced content (test names, failure text) lands in leafs — one JSON document per leaf, size-bounded fields, no shell interpolation anywhere.

### Test notes

Pure unit tests only: key/fingerprint composition, path scheme stability,
parse fail-open on truncated/garbage leafs, atomic-write round-trip,
retention eviction order, verdict classification (green / red / flaky
retry / each infra kind / timeout). Sandbox state-dir env via
sandboxEnv(...); no subprocess, no git.

## Acceptance

- [ ] A key composes from repo identity, commit sha, and a toolchain fingerprint, and two runs differing only in Bun version resolve to different keys
- [ ] The result envelope distinguishes green, suite-red with failing-test identities and flaky-suspect marks, infra-error by kind, and timeout; miss and computing are expressible on the read side
- [ ] Leaf parse is fail-open (garbage yields a typed miss, never a throw), writes are atomic, and retention evicts beyond a hard cap
- [ ] Verdict logic marks a fail-then-pass-at-same-sha test as flaky-suspect and can never classify an infra failure as green
- [ ] The suite is green via the sanctioned fast gate

## Done summary

## Evidence
