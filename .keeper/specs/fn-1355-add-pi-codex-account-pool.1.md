## Description

**Size:** M
**Files:** integrations/pi-codex-pool/package.json, integrations/pi-codex-pool/README.md, integrations/pi-codex-pool/src/index.ts, integrations/pi-codex-pool/src/auth.ts, integrations/pi-codex-pool/src/usage.ts, integrations/pi-codex-pool/src/observer.ts, integrations/pi-codex-pool/src/pool.ts, integrations/pi-codex-pool/src/state.ts, integrations/pi-codex-pool/src/proof.ts, integrations/pi-codex-pool/test/provider-pool.test.ts, integrations/pi-codex-pool/test/observer.test.ts, integrations/pi-codex-pool/test/proof.test.ts

### Approach

Create a self-contained Keeper-owned Pi package outside `plugins/`, with a manifest description written as a one-line verb phrase and Pi core modules declared as peer dependencies. Register opaque account aliases backed by Pi's credential store, expose a bounded sanitized observer command, and wrap Pi's built-in Codex stream so each `sessionId` retains a healthy route and may attempt one different alias only before Substantive output. The wrapper is the sole account-retry owner and preserves the caller's abort signal, deadline, headers, callbacks, transport choice, session id, event ordering, and account-scoped connection identity; failures in configured pool machinery emit a sanitized warning and delegate to native `openai-codex`.

The package may use Pi's compat-root `openAICodexResponsesApi()` delegate while the installed jiti loader captures documented API subpaths incorrectly, but a compatibility test must pin that exact seam and an implementation note must name the upstream issue path without making production depend on its resolution. Credentials remain in Pi's `auth.json`, refreshed under cross-process locking and atomic `0600` persistence; package state stores only opaque aliases, bounded quota/cooldown facts, and expirations.

Define the live-proof data contract now: an allowlisted, versioned collector/verdict schema records only revision/config bindings, opaque alias roles, bounded timestamps/counters, route/failure classes, Substantive-output booleans, restoration state, artifact-scan state, and `proven | incomplete | failed`. It never activates the pool itself. Any missing clause, stale binding, interrupted run, unknown field, scanner error, or sanitation finding classifies non-passing so task 3 can expose a transactional proof-then-activate operator workflow to the dependent live epic.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `/Users/mike/docs/pi-codex-provider-routing-proof.md` — successful same-call root/child and real-transport proof plus the compat-subpath failure.
- `/Users/mike/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md:367` — supported custom stream contract.
- `/Users/mike/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:40` — extension module aliases and compat-root behavior.
- `/Users/mike/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts:50` — `SimpleStreamOptions`, including session identity and request controls.
- `/Users/mike/src/possibilities--pi-subagents/src/agent-runner.ts:630` — child model registry/runtime inheritance.
- `src/restart-observation.ts:157` — pure typed proven/incomplete verdict precedent.
- `scripts/audit-session-activity.ts:47` — bounded allowlisted report precedent.

**Optional** (reference as needed):
- `/Users/mike/docs/pi-codex-multi-account-subagent-balancing-context-2026-07-17.md` — prior package and usage-endpoint research.
- `plugins/keeper/pi-extension/keeper-events.ts:1` — isolation and fail-open precedent; do not import this module.
- `scripts/install.sh:85` — local Pi package installation conventions.
- `src/provider-leg-death-notice.ts:198` — producer-side redaction helpers for unavoidable free text.

### Risks

- Pi upgrades can alter compat exports, provider registration, event shapes, WebSocket reuse, or credential refresh behavior.
- A retry after an exposed thinking or tool-call event can duplicate effects; unknown events must conservatively close the window.
- Per-alias refresh and connection reuse can leak or invalidate credentials if locking or transport keys are not account-scoped.
- Raw provider errors and debug callbacks can contain account identity or tokens; tests must scan every persisted/rendered artifact.
- A permissive proof schema can turn incomplete or stale evidence into activation authority; unknown or missing facts must never default true.

### Test notes

Use fake credentials, injected usage responses, fake upstream streams, and synthetic root/child session ids. Pin event ordering, one-different-alias maximum, abort during selection/backoff/stream, unknown-event cutoff, native fallback, per-alias refresh serialization, transport isolation, and absence of token/account PII in files, logs, errors, session entries, and tool details. Adapt the disposable proof into a committed deterministic fixture; do not call live Codex in correctness tests. Pure proof tests cover every clause, stale revision/config/alias bindings, interrupted/restoration-required runs, unknown fields, scanner failure, and atomic private report persistence.

### Detailed phases

1. Establish manifest, credential aliases, locked storage, usage parser, and sanitized observer envelope.
2. Add deterministic selection, session stickiness, pressure/cooldown feedback, and bounded route state.
3. Proxy the built-in Codex stream with the exact Substantive-output and abort contracts.
4. Define the allowlisted live-proof collector/verdict contract and secret-scanning boundary.
5. Add compatibility, security, proof-classifier, and synthetic root/child tests plus package documentation.

### Alternatives

Import marketplace plugins at runtime — rejected because their compatibility and coordination contracts are insufficient. Copy Pi's Codex protocol — rejected because the exported/lazy built-in transport already owns wire compatibility. Let the live epic invent its own report — rejected because activation authority must be defined and tested before handling real credentials.

### Non-functional targets

No credential value crosses the package's provider/observer boundary. Selection adds no per-token work; refresh, backoff, and all attempts share one bounded deadline; state, reports, and diagnostics are size-bounded and user-private.

### Rollout

Package installation alone is inert outside a Keeper-marked Pi launch. Native fallback remains available until the dependent real-account proof produces a fresh passing report and task 3's activation command accepts it.

## Acceptance

- [ ] A Keeper-marked extension instance registers opaque aliases and a Codex wrapper, while an unmarked/standalone instance leaves Pi's provider registry and request behavior unchanged.
- [ ] Two fake aliases prove independent locked credential resolution, sanitized usage observation, deterministic selection, session stickiness, pressure/cooldown feedback, and account-scoped transport reuse.
- [ ] One logical call makes at most an initial plus one different-alias attempt; only classified pre-output failures retry, while text/thinking/tool-call/unknown events and aborts never replay.
- [ ] Every request option and stream event required by Pi's Codex contract is preserved, and a broken/unavailable pool delegates visibly to native `openai-codex`.
- [ ] The compat-root Codex delegate and distinct root/child session ids are pinned by deterministic tests using the installed Pi and pi-subagents model-runtime contract.
- [ ] A versioned allowlisted proof classifier returns passing only when every fresh revision/config/alias-bound live clause, restoration check, and artifact scan succeeds; missing, interrupted, stale, unknown, or unsanitized evidence cannot activate.
- [ ] Secret scanning proves tokens, token-derived identities, raw auth/provider objects, headers, and account PII never appear in observer output, package state, proof reports, logs, errors, session entries, or tool results.

## Done summary

## Evidence
