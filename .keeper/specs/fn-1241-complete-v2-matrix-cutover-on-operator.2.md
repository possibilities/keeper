## Description

Two accuracy corrections against the shipped v2-only reality.

Finding F2: the cross-provider dedup shadow is computed and stored
(`src/agent/matrix.ts:911`, `plugins/plan/src/host_matrix.ts:374`) but no
production path reads `.shadowed` (only tests do). Yet `CONTEXT.md:37`
("every other entry shadowed and logged") and `docs/install.md:78`
("shadowed entries are logged visibly") claim it is surfaced. Either emit the
shadow list from a reading surface (e.g. a `providers check` finding or a
stderr line at load) or soften the claim in `CONTEXT.md` and
`docs/install.md` until a consumer exists — pick one and make the docs match
the code.

Finding F3: the `workerAgentFor` doc-comment at `plugins/plan/src/models.ts:165`
still asserts the reconcile verdict path uses the embedded-only sibling
`embeddedWorkerAgentFor`, which was deleted with `subagents_config.ts`; the
path now composes cells via the producer-injected matrix axes. The comment at
`:152` also still describes an "embedded snapshot when absent" that no longer
exists (the matrix is required). Rewrite both to describe the injected-axes
architecture.

Files: CONTEXT.md, docs/install.md, plugins/plan/src/models.ts (and
src/agent/matrix.ts / plugins/plan/src/host_matrix.ts if surfacing the shadow
rather than softening the wording).

## Acceptance

- [ ] CONTEXT.md and install.md shadow claims match actual behavior (surfaced or reworded)
- [ ] models.ts comments name no deleted symbol and describe the injected-matrix architecture

## Done summary
Reworded CONTEXT.md/install.md shadow claims to match actual behavior (computed, not surfaced) and rewrote models.ts's workerAgentFor comment to name the effectiveMatrix() seam instead of the deleted embeddedWorkerAgentFor sibling; trimmed CONTEXT.md's spacer lines back under the glossary line cap.
## Evidence
