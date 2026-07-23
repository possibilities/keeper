## Description

**Size:** M
**Files:** cli/usage.ts, cli/accounts.ts, cli/keeper.ts, cli/descriptor.ts, src/usage-observation-view.ts, src/account-router.ts, src/codex-account-router.ts, src/agent/main.ts, src/agent/dispatch.ts, test/usage.test.ts, test/agent-account-routing.test.ts, test/keeper-cli.test.ts

### Approach

Add direct schema-v1 JSON for the display-grade Usage snapshot and a public, side-effect-free `keeper accounts inspect --json` command for routing-authoritative diagnostics. `usage --json` implies one-shot snapshot behavior, rejects `--watch`, preserves each provider's independent status and timestamps, and never requires dereferencing view-shell temporary state.

Build account inspection from the existing reservation-free Claude and Codex inspectors. Keep Claude launch routing, Codex launch seeding, and Pi runtime evidence in separate blocks; expose only allowlisted route/alias, scope, freshness, focus/activation, eligibility, bounded reasons, pressure/cooldowns/reservations, score components, and `would_route`/proven-actual outcomes. An ambient or explicit Session may select one current Pi route, but aggregate output must not dump every Session route. Preserve `keeper agent accounts check --json` through the shared seams.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `cli/usage.ts:1-121` — current snapshot/watch shell and flag behavior.
- `src/usage-observation-view.ts:1-289` — normalized display snapshot and last-good distinctions.
- `src/account-router.ts:964-1135` — reservation-free Claude Routing inspection.
- `src/codex-account-router.ts:636-714` — scoped Codex Routing inspection and pressure/cooldown fields.
- `src/agent/main.ts:3574-3660` — existing compatibility command and separate routing blocks.
- `src/agent/dispatch.ts:90-112` — account command grammar and help.

**Optional** (reference as needed):
- `src/account-observation.ts:22-104` — safe Claude observation schema and display-only last-good data.
- `src/account-routing-config.ts:8-70` — schema/freshness constants and stable route identifiers.
- `src/codex-quota-scope.ts:1-52` — closed quota-scope vocabulary.

### Risks

A merged serializer can accidentally make display-grade meters routing-authoritative or imply that central Codex launch pressure is the live Pi runtime state. Direct JSON must also bypass the viewer's persistent shared temporary artifacts and keep partial provider failures inside per-source status without hiding real command failures.

### Test notes

Compare JSON meter data to the same normalized snapshot used by human rendering. Snapshot routing state before and after inspection to prove no reservation, pressure, credential refresh, or subprocess side effect. Test missing/stale/partial providers, actual-route Session selection, deterministic ordering, unknown additive fields, and secret-like errors.

### Detailed phases

1. Add direct one-shot Usage serialization and define flag/exit interactions.
2. Extract/share safe inspection serializers while preserving current account-check output.
3. Register the top-level accounts group and optional Session selector.
4. Pin partial-data, no-side-effect, compatibility, and sanitation behavior.

### Alternatives

Extending the human view-shell metadata pointer was rejected because it is transient, unversioned at the state level, and presentation-oriented. Collapsing Claude and Codex into one candidate list was rejected because their route scopes and authority differ.

### Non-functional targets

Both reads are daemon-independent where their existing sources permit, complete without observer/provider calls, produce deterministic bounded output, and add no routing pressure. JSON stdout contains no human frame, warning, or `keeper-meta:` line.

### Rollout

Human `keeper usage`, existing scripts using snapshot output, and `keeper agent accounts check --json` remain compatible. The new account command is additive and no existing path is deprecated in this epic.

## Acceptance

- [ ] `keeper usage --json` emits a standard schema-v1 one-shot envelope, rejects `--watch`, and preserves every normalized meter, category/multiplier, source status, observation time, Measurement time, and display-only last-good distinction.
- [ ] Missing, stale, exhausted, or unavailable Claude/Codex sources produce explicit partial-data blocks without being interpreted as zero or whole-command failure.
- [ ] `keeper accounts inspect --json` reports separate Claude launch, Codex launch-seed, and Pi runtime provenance with allowlisted eligibility, focus/activation, pressure/cooldown/reservation, score, actual-route, and reservation-free `would_route` fields.
- [ ] Inspection with no Session does not expose a high-cardinality route map; ambient or explicit Session selection returns only a proven scoped route or explicit unavailable state.
- [ ] Repeated inspections create no reservation, pressure, observer refresh, credential access, subprocess launch, or routing-affinity change.
- [ ] Existing human Usage output and `keeper agent accounts check --json` remain compatible through shared inspection seams.
- [ ] JSON stdout, stderr, and errors omit credential, token, private-path, raw-provider-error, arbitrary-label, and prompt canaries.
- [ ] Targeted Usage, routing, and CLI descriptor tests pass deterministically.

## Done summary
Added keeper usage --json (schema-v1 one-shot envelope, rejects --watch) and a new keeper accounts inspect command reporting separate Claude launch, Codex launch-seed, and scoped Pi runtime routing blocks, reusing the existing inspectRouting/productionCodexSessionInspection seams for compatibility with keeper agent accounts check.
## Evidence
- Commits: 788808bb3655c44c60716a5fedb6584a45969ee6