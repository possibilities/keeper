## Overview

fn-891 added build/deploy/install job types to buildbot, but the new jobs
are invisible on `keeper builds` for two reasons: the running master never
reloaded, and a registered-but-never-built builder emits no row by design.
This epic closes the visibility gap — a never-built builder renders as a
distinct `never built` row — then activates the fn-891 jobs (reconfig +
force-build the cheap installs) and verifies all three types show on the one
surface. Feature-first, then activate.

## Quick commands

- `keeper builds` — after activation, every build/deploy/install/dotfiles builder has a row (never-built ones show `never built`)
- `~/.local/share/uv/tools/buildbot/bin/buildbot checkconfig ~/.local/state/buildbot/master && buildbot reconfig ~/.local/state/buildbot/master` — register the fn-891 builders in the live master
- `curl -s "http://greybird.taile9945f.ts.net:8010/api/v2/builders" | grep -o '"name":"[^"]*"'` — confirm the new builders registered
- `bun run test:full` — mandatory (touches worker/db/render paths)

## Acceptance

- [ ] a registered-but-never-built buildbot builder renders as a distinct `never built` row in `keeper builds` (not invisible, not collapsed into RUNNING)
- [ ] the placeholder is emitted only for a true empty-build enumeration; a transient fetch failure never mints one and re-fold stays byte-identical
- [ ] after reconfig + cheap-install force-builds, all build/deploy/install/dotfiles jobs are visible with their fn-891.5 type tags, and the master is not self-bounced

## Early proof point

Task that proves the approach: `.1`. The worker emitting an all-null
placeholder for `{"builds":[]}` (and NOT for a fetch failure) + the viewer
rendering it distinctly is the whole feature. If it fails: the two `null`
sources got conflated (fetch-failure leaking a phantom row) or the
`resolveStatus` branch order is wrong (pending collapsing into RUNNING) —
both are pinned by the tests.

## References

- fn-891 (parent epic — the buildbot job types + the fn-891.5 viewer type-tag render this builds on)
- Buildbot 4.3 REST: a never-built builder returns HTTP 200 + `{"builds":[]}`; a 404 means removed; `masterids:[]` means deactivated (already ghost-filtered) — three distinct signals, do not conflate
- The `builds` projection is deterministic-replayed (re-fold byte-identical is a hard invariant); the placeholder is a normal BuildSnapshot event minted from a poll (event.ts only, no wall-clock)
- Worker seam: src/builds-worker.ts parseLatestBuild (193-238), buildsGateKey (135-143), seedFromDb (319-352), reconcileEnumeration (295-305)

## Docs gaps

- **cli/builds.ts** HELP (44-65) + file JSDoc (3-32) + resolveStatus JSDoc (92-95): the status enumeration and the "empty table means no builds yet" prose go stale — revise + consolidate to include the `never built` state (forward-facing; integrate, don't append)
- **.keeper/specs/fn-781-...md** and **.keeper/specs/fn-891-...5.md**: one-line done-summary append noting the extended state model (low priority)

## Best practices

- **`never built` is a distinct neutral state, not `unknown` or `running`:** operators read `unknown` as "CI broke" and `running` as "in progress" — a never-run job is neither. [CI dashboard UX]
- **Emit the placeholder from the producer (worker), never the fold:** the fold must stay a pure function of the event stream — no liveness/wall-clock probe — or re-fold byte-identity breaks. [event-sourcing]
- **Only HTTP 200 + `{"builds":[]}` triggers the placeholder:** a 404 (removed) or a fetch failure (transient) must not — conflating them flaps pending↔real or emits phantom rows. [buildbot 4.3 REST]
- **Durable gate across restart:** the placeholder row reseeds its gate key via seedFromDb so a daemon boot doesn't re-emit it. [keeper worker contract]

## Non-goals

- A "misconfigured" state (builder has masterids but no workers/configured_on) distinct from `never built` — out of scope; such a builder renders as `never built`, which is acceptable.
