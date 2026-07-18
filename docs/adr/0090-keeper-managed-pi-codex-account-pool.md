# 90. Keeper-managed Pi Codex account pool at the provider boundary

## Status

Accepted. Relates to ADR 0079's Claude-specific launch routing and ADR 0039's Pi Task facade and child-agent integration.

## Context

Keeper-launched Pi sessions use Codex subscription credentials for both root inference and pi-subagents children. One ambient credential gives concurrent sessions no capacity-aware placement, and a depleted account can end work even when another authorized account has capacity.

Pi stores one credential per Provider id. Its custom-provider stream contract can wrap the built-in Codex transport, and pi-subagents children inherit the parent's model runtime even when their own extension loading is disabled. A provider wrapper can therefore cover root and child requests without replacing the `Agent` tool or respawning a child. Once model-generated content escapes, however, replaying the request can duplicate text, reasoning, tool calls, or side effects.

Keeper's daemon may observe sanitized capacity but must not own OAuth credentials. Standalone Pi also remains outside Keeper's account policy.

## Decision

Keeper owns a self-contained Pi companion package inside this repository, separate from the tracked node-only Pi extension. `keeper agent pi` loads the companion; a Pi process launched without Keeper does not.

The companion owns the Codex credential and request boundary:

- each authorized account is one opaque, non-PII Provider alias backed by Pi's credential store;
- credential enrollment, resolution, refresh, usage fetching, cooldowns, and Codex stream wrapping remain inside the companion;
- root and child Harness sessions select independently by Pi session id, retain a healthy Codex session route, and never persist conversation-to-account affinity;
- the wrapper delegates to Pi's built-in Codex transport and preserves abort, timeout, headers, callbacks, transport, session, and event-order semantics; and
- provider or SDK retries beneath the wrapper do not multiply the companion's account attempts.

Keeperd invokes a bounded observer command exposed by the companion and publishes a separate, versioned Codex capacity observation. The command emits only validated quota windows, opaque aliases, freshness, and bounded status classes. OAuth material, token-derived identity, provider headers, raw errors, and account PII never cross this boundary. Publication remains DB-free, transient, private, and atomic; routing pressure is likewise an expiring file-backed coordination surface rather than a Projection, RPC mutation, lease, or claim.

Selection excludes invalid, exhausted, or cooling aliases, then combines worst-window headroom with routing pressure and deterministic least-recently-used tie-breaking. A Codex session route remains sticky while healthy. Missing or unusable pool state fails open with a visible sanitized warning to Pi's native `openai-codex` credential; non-Codex models remain unaffected.

One logical provider call permits at most the initial alias plus one different alias under one total deadline. Only a classified quota, rate, authentication, or pre-stream transport failure may move to the second alias. The wrapper withholds provider-neutral start events while deciding. Text, thinking, tool-call, and unknown stream events are Substantive output; once any is exposed, the original attempt and terminal outcome pass through without automatic account replay. User abort never changes accounts.

The production gate requires a live two-account OAuth run proving independent refresh, distinct session routes, a genuine pre-output account failure, root and pi-subagents child coverage, concurrent pressure, and secret-free artifacts. Single-account and synthetic proofs do not arm pooling by themselves.

The local pi-subagents checkout used by Keeper stays on a dedicated integration lineage. Any upstream issue or pull request starts from the fetched upstream branch in a separate branch and worktree with only its reviewable patch; switching the live integration checkout to a proposal branch is not a development workflow.

## Alternatives considered

- **Install an existing marketplace balancer unchanged.** Rejected because the inspected releases either target removed Pi authentication APIs, lack cross-process coordination, or resume through a synthetic user turn rather than the provider boundary.
- **Wrap or replace the `Agent` tool.** Rejected because tool interception misses scheduler, RPC, nested, resume, and frontmatter paths while duplicating pi-subagents lifecycle behavior.
- **Let keeperd read or refresh OAuth credentials.** Rejected because capacity publication does not justify moving secrets into the daemon or its sidecars.
- **Respawn a failed subagent.** Rejected because a terminal child record cannot prove that no model output or tool side effect occurred.
- **Retry after partial output.** Rejected because separate model attempts are nondeterministic and can duplicate visible content or executable tool calls.
- **Create a standalone companion repository immediately.** Rejected because the package exists solely on Keeper's managed Pi launch path; repository-local ownership keeps installation and compatibility pins atomic while preserving a later extraction path.
- **Fail closed when the pool is unavailable.** Rejected because Pi's native credential is a useful degraded path and the selected policy prefers continued work with a visible warning.

## Consequences

- Keeper gains capacity-aware Codex placement and safe pre-output account failover across root and child Pi sessions without widening reducer or RPC writes.
- Credential storage remains Pi-owned, while Keeper owns only sanitized transient observations and coordination pressure.
- The companion becomes a compatibility boundary against Pi's provider and extension-loader APIs; supported Pi upgrades require explicit wrapper and root/child integration tests.
- Pool degradation may concentrate work on the native credential, but it cannot silently claim balanced operation because the fallback is visible.
- Real multi-account evidence, abort/error classification, stream-event ordering, transport isolation, and secret scanning are release obligations rather than best-effort checks.
