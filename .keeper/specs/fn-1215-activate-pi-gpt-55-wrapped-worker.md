## Overview

Codex running gpt-5.3-codex-spark becomes the first active non-claude plan worker through the landed wrapped-cell architecture: the selector routes bounded tasks to spark cells, a claude wrapper delegates implementation to a contract-bound codex leg and re-owns tests/commit, and the out-of-band cell-review loop grades the cohort. The architecture is landed and inert only because no host matrix exists; this epic closes the four real gaps — effective-axes validation, provider-qualified alias-target support, the research-gate backfill, and the e2e back half — so authoring `~/.config/keeper/matrix.yaml` (a post-landing operator step, alongside the live canary) activates the path end-to-end. The spark capability id is a bare matrix token needing no alias; slashed alias-target support stays in scope as the generic provider-qualified form other harnesses require.

## Quick commands

- `keeper agent providers resolve gpt-5.3-codex-spark high` — after the operator authors the host matrix: one JSON line whose candidate carries harness codex and the spark model id
- `cd plugins/plan && bun test` + `bun test` (root) — fast suites incl. the parity, embedded-pin, and consistency gates
- `KEEPER_RUN_SLOW=1 bun test test/wrapped-cell-e2e.slow.test.ts` — the full wrapped loop: render → resolve → providers → detached leg → re-test → soft-reset → one sanitized trailer commit
- `bun plugins/plan/scripts/model-guidance-check.ts --check` — research/guidance gate green with the spark backfill

## Acceptance

- [ ] With a host matrix serving gpt-5.3-codex-spark via codex (fixture-injected in tests), a selector-picked spark cell passes assign-cells/scaffold/refine validation, claims, and routes to a wrapped worker cell; without a host matrix every surface stays byte-identical claude-only
- [ ] A provider-qualified slashed native id parses as an alias target in both matrix islands and flows through providers-resolve unmodified, while alias keys/axis tokens stay strictly validated
- [ ] The model-guidance gate stays green with gpt-5.3-codex-spark researched and hash-anchored, tolerating host-roster research entries while always enforcing reference-hash parity
- [ ] The slow-tier e2e proves the wrapped back half through a codex-shaped stub leg: authoritative re-test authority stays with the wrapper, contract-violating foreign commits are soft-reset, and exactly one wrapper commit lands with sanitized Task/Job-Id trailers
- [ ] Install walkthrough, composition map, glossary, and a committed anti-rot-tested example matrix describe the activation accurately

## Early proof point

Task that proves the approach: `fn-1215-activate-pi-gpt-55-wrapped-worker.1` (the charset + effective-axes keystone; the epic slug predates the harness retarget). If it fails: fall back to adding gpt-5.3-codex-spark directly to the subagents.yaml axis and re-scope tasks 3-4 against that entry path.

## References

- The activating architecture is settled decision history (host provider matrix + wrapped worker cells ADR): model axis subsumes harness; wrapped close-out soft-resets foreign commits; absent matrix = embedded claude-only byte-identical. This epic activates, never re-designs.
- Live probes (planning session): pi rejects a bare capability id and requires the provider-qualified slashed form — the alias-target charset relaxation serves that generic case; codex accepts bare model ids (the host codex preset runs one), so the spark activation itself needs no alias.
- The selection loop already anticipates the model: a gpt-5.3-codex-spark guidance block exists; selection-brief generates candidates from the effective axes and enforces guidance coverage against them.
- Host matrix authoring and the live canary (one real bounded task hand-checked through the wrapped codex path) are post-landing OPERATOR steps — deliberately outside task acceptance.
- Trickle posture is advisory guidance prose only: gpt-5.3-codex-spark routes to genuinely-bounded mechanical work until cell-review config-hash cohorts justify promotion; no selector gate mechanism.

## Docs gaps

- **docs/install.md**: revise the host-provider-matrix walkthrough step 1 to link the committed example matrix; note providers-check fail-loud on absent harness binaries as expected behavior
- **docs/plugin-composition-map.md**: add the missing wrapped-cell mention (wrapped cells ride the same --plugin-dir channel with the wrapper driver; matrix.yaml is the composition input)
- **CONTEXT.md**: disambiguate the matrix alias target (native id) from the Preset entry's rejected "model alias" sense
- **plugins/plan/model-selector.yaml**: research map gains the hash-anchored gpt-5.3-codex-spark entry alongside the refreshed trickle-posture guidance block

## Best practices

- **Fake only the foreign CLI in the sim:** deterministic stub for the codex leg; the detach path, re-test, soft-reset, and commit run real — never fake the wrapper's own authority [subprocess-sim practice]
- **Stratify the trickle by task class, not flat percentage:** bounded mechanical classes first, expand within a class on graded cohort evidence; hard metrics (test-pass, escalation, soft-reset rate) non-degrading before trusting soft lifts against a trailing baseline [LLM canary practice]
- **Treat the foreign envelope and repo context as attacker-influenced:** size-bound one-shot JSON parse, no shell interpolation of its fields; the soft-reset is a security control and the wrapper alone authors the landed commit [agent-delegation practice]
- **Committed example config must not rot:** the example matrix is load-tested via the real parser at a non-discovered path; behavior-changing per-host config fails loud when malformed [config-drift practice]
