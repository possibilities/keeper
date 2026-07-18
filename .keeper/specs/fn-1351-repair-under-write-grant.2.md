## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

When the baseline is red at the default tip with no live blocked consumer (no task rows to elect from), the daemon mints a real maintenance plan task instead of holding an ownerless incident: a producer invokes a bounded plan-CLI subprocess to scaffold a single-task maintenance epic carrying the failing-tests digest and baseline leaf key in its spec, idempotent per (repo, fingerprint) — at most one open maintenance task, re-probed before mint. Autopilot then dispatches it as ordinary work; the worker fixes trunk in its own lane with no grant machinery involved. A failed mint pages once through the existing path. Sole-writer discipline holds: the plan CLI writes the plan, the producer only spawns it.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- The repair sweep's candidate selection — the no-consumer condition this branch keys on
- The baseline result leaf shape and keying — the digest and key the maintenance spec embeds
- keeper plan scaffold --agent-help — the YAML the producer-built subprocess pipes

**Optional** (reference as needed):
- The scaffold duplicate-epic guard — the idempotence backstop for the one-open-task rule

### Risks

- A red baseline that flaps mints repeatedly unless the open-task probe is checked before every mint and the fingerprint stays stable across attempts

### Test notes

In-process with an injected subprocess seam: no-consumer red mints once; existing open maintenance task suppresses re-mint; mint failure pages once. Named gates.

## Acceptance

- [ ] Trunk red with no blocked consumer yields exactly one open maintenance task per (repo, fingerprint), scaffolded through the plan CLI with the digest and baseline key in its spec
- [ ] Re-probes never duplicate an open maintenance task and a failed mint pages exactly once
- [ ] All suites green via named gates

## Done summary

## Evidence
