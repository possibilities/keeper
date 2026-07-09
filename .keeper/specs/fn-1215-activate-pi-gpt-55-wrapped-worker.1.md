## Description

**Size:** M
**Files:** src/agent/matrix.ts, plugins/plan/src/host_matrix.ts, plugins/plan/src/models.ts, plugins/plan/test/src-subagents-config.test.ts, test/agent-matrix.test.ts, plugins/plan/test/src-models.test.ts

### Approach

Two coupled contract fixes that make a host-roster model both expressible and usable.

**Slashed alias targets, both islands.** The matrix alias TARGET (the native id a capability model resolves to) gains `/` in its accepted charset; alias KEYS and every axis token stay strictly validated as today. The relaxation lands in the launcher island's alias-target validation and the plan island's provider-model coercion (which validates-then-discards the same value for fail-loud parity) in one change, with the cross-island parity fixture updated so both parsers accept and reject the identical corpus. Verify the providers-resolve JSON carries the slashed model_id through to the launch path with no re-validation (the CLI model flag is pass-through by design).

**Effective axes as the plan island's validation source.** The plan island's configured-axes seam (configuredEfforts/configuredModels and workerAgentFor) switches from the embedded subagents snapshot to the composed effective matrix, with the absent-matrix path falling back to embedded byte-identically. Every membership-validating verb (assign-cells, scaffold, refine-apply, close-finalize) inherits through that one seam — verify none re-reads the embedded snapshot directly. workerAgentFor keeps its throw semantics: it is the corrupt-state backstop behind dispatch's graceful no-route reject, which fires first on any unroutable cell and gates claim. Selection-brief already reads the effective axes; after this change a selector-picked host-roster cell validates and claims instead of rejecting.

Tests stay host-independent: the embedded-default pins must pass unmodified with no host matrix present, and every new case injects a matrix fixture via the config-dir override — never the real host file.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/matrix.ts:241-250 — the alias-target validation throw site; :79 isValidMatrixToken; :426 presetNameFor (keys on the capability token, never the native id — confirm no slash reaches a preset/file name)
- plugins/plan/src/host_matrix.ts:271 coerceProviderModels (validates-then-discards the native id — the parity twin), :78 MATRIX_TOKEN_RE, :337 composeEffective, :368 effectiveMatrix()
- plugins/plan/src/models.ts:139-147 configuredEfforts/configuredModels, :158-172 workerAgentFor — the embedded-only reads to switch
- plugins/plan/src/verbs/assign_cells.ts:24-27 + :295-296 — the "embedded only" comment and validation call to inherit the switch; scaffold.ts:432/:818, refine_apply.ts:323/:343, close_finalize.ts:914-915 — confirm all route through configuredX
- plugins/plan/test/src-subagents-config.test.ts:158 (cross-island parity), :191 (explicit-path loadHostMatrix fixture pattern); the embedded-default pins in the same file that must stay green
- plugins/plan/src/verbs/selection_brief.ts:258-293 — the already-effective candidate generation the validation side must now match

**Optional** (reference as needed):
- src/worker-cell.ts — resolveWorkerCell no-route reject (the graceful front line the throw sits behind)
- src/agent/config.ts:510 augmentCatalogWithMatrix — auto-preset generation to confirm collision behavior unchanged

### Risks

- The effective-axes switch must not make the compiled plan binary's behavior depend on cwd or host state when no matrix exists — the absent-matrix fallback is the byte-identity guard the embedded pins enforce
- A charset relaxation that leaks beyond alias targets (keys, axis values) would let a slashed token become a path-bearing cell/preset name — the strict/relaxed split is the security line

### Test notes

Parity corpus additions: slashed target accepted both islands, slashed KEY rejected both islands, slashed axis token rejected. Effective-axes cases (fixture-injected): host model validates through assign-cells/scaffold membership and workerAgentFor composes its agent name; no-matrix run = embedded pins byte-identical. Fast tier only; no host file reads.

## Acceptance

- [ ] A matrix alias mapping a capability model to a provider-qualified slashed native id loads in both islands, resolves through providers-resolve with the slashed id intact, and a slashed alias key or axis token is rejected by both islands
- [ ] With a fixture matrix serving an extra model, that model passes every plan-verb membership validation and claim-path agent composition; with no matrix present, all embedded-default test pins pass unmodified
- [ ] A cell whose model is outside the effective axes still dispatch-rejects as no-route ahead of any claim-path throw
- [ ] Root and plan fast suites green

## Done summary

## Evidence
