## Description

**Size:** S
**Files:** docs/examples/matrix.example.yaml, docs/install.md, docs/plugin-composition-map.md, CONTEXT.md, test/agent-matrix.test.ts

### Approach

The host matrix is uncommittable, so the repo carries a canonical example: a committed matrix.example.yaml holding the real activation shape — claude provider with the native models, a codex provider serving gpt-5.3-codex-spark as a bare capability token, cost-ascending roster order, the wrapper driver — plus one commented provider-qualified slashed-alias entry documenting the form other harnesses require. It lives where no loader discovers it and is wired into an anti-rot test that parses it with the real launcher-island loader from a fixture config dir (host-independent). The install walkthrough's standing-up step links the example instead of describing the shape prose-only, and gains one line setting expectation that providers-check fails loud on a host missing a rostered harness binary. The composition map gains its missing wrapped-cell mention: wrapped cells ride the same additive --plugin-dir channel with the wrapper running the fixed driver, and the host matrix is the composition input that makes them render. The glossary disambiguates the matrix alias target — the provider-qualified native id a capability model resolves to — from the preset entry's rejected "model alias" synonym, using the established entry shape. Forward-facing prose throughout.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- docs/install.md:43-61 — the host-provider-matrix section to revise in place (numbered steps, providers check|resolve references)
- test/wrapped-cell-e2e.slow.test.ts:85-102 — the canonical in-tree matrix shape to mirror in the example
- docs/plugin-composition-map.md — the per-channel table the wrapped-cell mention joins
- CONTEXT.md:34-39 (Worker cell/Provider/Pecking order/Wrapped cell/Wrapper driver entries) and :116 (the Preset entry whose Avoid list collides) — the entry shape and the collision to resolve
- src/agent/matrix.ts loadMatrix — the loader the anti-rot test drives against the example file

**Optional** (reference as needed):
- plugins/plan/src/host_matrix.ts — if the anti-rot test should assert plan-island parity on the example too

### Risks

- The example must never sit at a discovered config path or it silently activates a foreign provider in repo tooling — the anti-rot test loads it by explicit path only

### Test notes

Anti-rot: copy the example into a fixture config dir, loadMatrix, assert the codex/spark route resolves; keep it fast-tier (pure parse, no subprocess).

## Acceptance

- [ ] A committed example matrix expressing the codex/gpt-5.3-codex-spark activation parses with the real loader in a fast-tier test and lives outside every discovered config path
- [ ] The install walkthrough links the example and states the fail-loud providers-check expectation; the composition map describes wrapped cells and the matrix as their composition input; the glossary distinguishes the alias target sense without colliding with the preset entry
- [ ] Docs lint gates stay green

## Done summary
Committed docs/examples/matrix.example.yaml (real codex/gpt-5.3-codex-spark activation shape, loaded by explicit path in a new anti-rot test in test/agent-matrix.test.ts); docs/install.md links it and notes providers-check fail-loud; docs/plugin-composition-map.md documents wrapped cells riding the additive --plugin-dir channel with matrix.yaml as composition input; CONTEXT.md adds an Alias target entry disambiguated from Preset.
## Evidence
