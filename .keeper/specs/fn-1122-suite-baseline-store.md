## Overview

Workers need a sanctioned answer to "is this test failure pre-existing at my
base commit, or did I cause it?" — the improvisation that used to answer it
(`git stash` + rerun) is banned. keeper computes the fast-gate suite result
once per (repo, sha, toolchain fingerprint) in a daemon-owned scratch
worktree and serves it to every asker: a CLI-written request spool, a
supervised baseline worker that is sole writer of per-key result leafs, and
a `keeper baseline` read verb with file-polling `--wait`. Architecture is
recorded in docs/adr/0005-suite-baseline-store.md; the glossary term is
Baseline (never "cache").

## Quick commands

- `keeper baseline $(git rev-parse HEAD) --wait` — end-to-end smoke: enqueue, compute, read the envelope
- `keeper baseline $(git rev-parse HEAD)` — read-only hit/miss/computing report
- `bun test test/baseline-store.test.ts test/baseline-worker.test.ts` — pure-seam suites
- `ls "$(keeper plan state-path 2>/dev/null || echo ~/.local/state/keeper)"/baseline` — spool + leaf surfaces on disk

## Acceptance

- [ ] A worker (or human) can ask for the fast-gate result at an arbitrary commit sha and receive a durable envelope that distinguishes green, suite-red (with failing-test identities and flaky-suspect marks), infra-error, and timeout — with miss/computing visible on the read path
- [ ] One computation serves N concurrent askers of the same key; distinct keys queue behind a bounded runner; scratch worktrees are reaped on every outcome including failure, and boot prunes orphans
- [ ] No new socket or RPC surface: the CLI is sole writer of the request spool, the baseline worker sole writer of result leafs, and the mutating-RPC allowlist is unchanged
- [ ] Worker guidance routes failure triage through `keeper baseline` before a worker classifies an out-of-scope failure, with the env-fidelity caveat stated

## Early proof point

Task that proves the approach: ordinal 3 (the supervised runner computing a
real key end-to-end). If the in-daemon runner proves too heavy or unreliable,
fall back to the runner as a keeper-dispatched one-shot subprocess owned by
the same spool/leaf contract — the store, helper, and CLI tasks survive
unchanged.

## References

- docs/adr/0005-suite-baseline-store.md — the ratified design: compute-once keying, file-based spool/leaf flow, sole writers, trust acceptance
- CONTEXT.md — Baseline glossary term; "cache"/"snapshot" are banned synonyms in adjacent terms
- src/maintenance-worker.ts + src/builds-worker.ts — producer-side worker archetypes (sidecar-writes, poll-loop error containment)
- src/daemon.ts restart-ledger helpers — the fail-open parse + atomic write + hard cap template for daemon-produced state files
- src/worktree-plan.ts worktreePathFor/repoDirHash — the out-of-repo worktree path scheme the scratch prefix must not collide with
- Prior art: Turborepo/Nx input-hash keying (toolchain in the key), Buildkite/Mill flake handling (raw runs, retry-to-confirm, verdicts derived)

## Docs gaps

- **README.md**: add `keeper baseline` to the one-binary verb list (tracked in task 5)
- **CLAUDE.md**: one sole-writer guardrail line for the spool/leaf surfaces (tracked in task 5; size gate — prune elsewhere if needed)
- **plugins/plan/CLAUDE.md**: optional one-line sanctioned-alternative pointer next to the stash-deny mention

## Best practices

- **Toolchain in the key:** a bare sha serves stale results across Bun upgrades — key on (repo, sha, toolchain fingerprint) [Turborepo/Nx]
- **Raw runs, derived verdicts:** store every run including retries; classify flaky from fail-then-pass at the same sha [Buildkite/Mill]
- **Per-worktree real node_modules:** `bun install --frozen-lockfile` per scratch worktree, sharing via Bun's global hardlink store; never symlink node_modules across worktrees
- **Lifecycle scripts stay blocked:** Bun's default trustedDependencies posture is the RCE guard for arbitrary-sha installs; never `--trust`/`--all`
- **Process-group kill then reap:** spawn the suite detached in its own group, kill(-pgid) on deadline, and consume the exit — or leak zombies
- **Infra-error is never clean:** a checkout/install/timeout failure must be a distinct verdict a reader cannot mistake for "no pre-existing failures"
- **Disk is the DoS surface:** bound leaf retention and reap scratch worktrees on every path, including crashes
