## Description

**Size:** M
**Files:** src/agent/args.ts, src/agent/main.ts, src/agent/dispatch.ts, test/helpers/agent-main-harness.ts, test/agent-args.test.ts, test/agent-account-routing.test.ts, test/agent-pi.test.ts, test/agent-profile-bootstrap.test.ts, test/agent-dispatch.test.ts, test/agent-tmux-launch.test.ts, README.md, docs/install.md

### Approach

Replace the inert `--x-profile` handling with a strict Harness-tagged, one-based Account selector that supports split and joined forms, rejects non-canonical labels, uses the final repeated profile occurrence, and rejects any invocation containing both selector families. Static syntax, Harness-prefix, and conflict checks run before tmux delegation; dynamic routing checks may run inside the delegated launcher, but no Claude or Pi Harness child starts when the explicit request cannot be honored.

For Claude, convert `claude-N` to current inventory ordinal `N - 1` and call the existing exact explicit-account resolver so freshness, model/Fable eligibility, reservation, route attribution, and no-substitution semantics stay centralized. Preserve the complete existing `--x-account cN|N` parser and launch behavior.

For Pi, resolve `codex-N` only for a Codex startup workload, index the full configured alias order used by the statusline, then use the existing model-scoped eligibility and pressure path constrained to that exact alias. Reject inactive routing, unavailable evidence, out-of-range aliases, and aliases unauthorized or ineligible for the derived quota scope; export the selected alias only as the initial one-shot seed while retaining the complete activated alias policy for runtime failover and child selection.

Keep all errors bounded and PII-free, avoid new profile directories or persisted affinity, and consolidate wrapper help plus operator docs around the new statusline vocabulary instead of appending competing explanations.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/agent/args.ts:43-50,90-166` — current zero-based Claude selector and inert `--x-profile` split/joined state machines.
- `src/agent/main.ts:4260-4376` — tmux delegation currently precedes normal launcher parsing; static validation must not reserve twice or consume inner-launch flags.
- `src/agent/main.ts:4546-4621` — exact Claude route resolution, exit behavior, route metadata, and managed launch wrapping.
- `src/account-router.ts:158-193,635-708` — reusable current-inventory ordinal resolution, eligibility, exact reservation, and no-substitution path.
- `src/agent/main.ts:743-838` — Pi launch-context construction, model-derived scope, activation policy, and initial route selection.
- `src/agent/main.ts:4739-4888` — effective Pi startup model, companion readiness, policy serialization, and initial-alias environment boundary.
- `src/codex-account-router.ts:373-405,496-557,638-708` — reusable scoped eligibility, exact singleton-constrained selection, pressure reservation, and inspection semantics.
- `test/helpers/agent-main-harness.ts:136-139,194-197,389-410,483-500` — dependency-injected route/context recorders for no-process launcher tests.

**Optional** (reference as needed):
- `cli/statusline.ts:248-260,372-375` — canonical one-based Claude display-label conversion.
- `plugins/keeper/pi-extension/status-footer.ts:95-120` — canonical Pi configured-alias label conversion.
- `integrations/pi-codex-pool/src/state.ts:846-869,895-958` — one-shot seed consumption and independent subsequent selection.
- `integrations/pi-codex-pool/src/pool.ts:555-924` — bounded attempts, Substantive-output replay cutoff, and native-fallback behavior that must remain unchanged.
- `src/agent/dispatch.ts:207-251` — wrapper help and current `--x-account` wording.
- `docs/install.md:94-125,311-340` — operator-facing Claude and Pi routing contracts to consolidate.

### Risks

- Parsing both outside and inside tmux can accidentally double-reserve or strip a selector before the inner launcher; static validation must remain mutation-free.
- `codex-N` uses the full configured alias order, not the filtered eligible-candidate order, so an ineligible earlier alias never renumbers later labels.
- Constraining the full Pi alias policy to the requested account would create a prohibited hard pin and disable safe failover.
- A positional label can map to another underlying account after inventory/config ordering changes; no code or docs may present it as stable identity.

### Test notes

Add pure parser cases for split/joined forms, strict grammar, missing values without native-arg consumption, repeated-profile last-wins behavior, wrong Harness prefixes, unsafe ordinals, and mixed-family conflicts. At the launcher boundary, assert exact Claude ordinal calls, exact Pi configured-alias seed and full policy, model-scope rejection, inactive/ineligible failure, exit 2, zero Harness spawns, and unchanged profile-farm negatives. Retain the existing companion provider-pool gate as proof that one-shot seeds, child independence, pre-output failover, and post-output no-replay remain green.

## Acceptance

- [ ] Both `--x-profile <label>` and `--x-profile=<label>` consume only canonical `claude-[1-9]\\d*` for Claude or `codex-[1-9]\\d*` for Pi, reject leading zero and unsafe integer forms, and do not consume a following native flag as a missing split value.
- [ ] Repeated `--x-profile` occurrences use the final value; any occurrence of both `--x-profile` and `--x-account` exits 2 regardless of order, while all existing `--x-account cN|N` compatibility tests remain green.
- [ ] `claude-N` calls the existing exact resolver with zero-based ordinal `N - 1`; unavailable or ineligible requests never call automatic routing and never spawn Claude.
- [ ] `codex-N` indexes the full configured Pi alias array, reserves that exact alias through existing model-scoped eligibility and pressure logic, and fails before spawning Pi when the workload is non-Codex, routing is inactive/uninspectable, the ordinal is absent, or the alias is not authorized and eligible for the startup scope.
- [ ] A successful Pi launch exports the requested initial alias and its matching scope while retaining the complete activated alias policy and binding; existing bounded retry, fallback, child-selection, and proven-route tests remain green.
- [ ] Invalid-selector diagnostics are bounded, actionable, and contain no opaque aliases, credential paths, account PII, or raw provider payloads.
- [ ] `--x-profile` creates no profile directory and does not set `PI_CODING_AGENT_DIR` or derive account identity from a profile path.
- [ ] Wrapper help, `README.md`, and `docs/install.md` document one-based statusline labels, current-order semantics, retained zero-based `--x-account`, selector-family conflict, exact Claude selection, and Pi seed-versus-runtime behavior.
- [ ] Focused launcher tests and the named Pi Codex pool gate pass.

## Done summary

## Evidence
