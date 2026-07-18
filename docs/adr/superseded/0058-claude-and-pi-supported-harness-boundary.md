# 58. Claude and Pi are the supported harness boundary

## Status

Superseded by [ADR 0079](../0079-mandatory-claude-swap-routing.md), which preserves the Claude/Pi harness boundary while replacing the account-routing exception.

## Context

Keeper's harness registry, launch catalog, capture stack, lifecycle producers,
resume and restore paths, and provider matrix admitted Claude, Pi, Codex, and
Hermes. The breadth required dedicated Codex rollout discovery, adoption,
resume repair, trust and state-sharing writes, plus Hermes export capture,
persistent hooks, trust configuration, and shim event translation. Those paths
also made a persisted harness label look equivalent to an executable capability.

The word `codex` names unrelated things: a harness, model and subscription ids
served through Pi, and CodexBar's observation role in Claude account routing.
Removing every lexical match would destroy supported Pi capabilities and account
routing. Keeping retired harness values as a compatibility class would instead
preserve execution-adjacent branches the retirement is meant to eliminate.

Hermes support also installs external state that can outlive the repository
code. Codex harness support writes some Keeper-owned links and indexes beside
ambient Codex CLI credentials, sessions, and trust data whose ownership is not
provable. The Codex adoption control is persisted in schema even when its
producer is absent.

## Decision

Claude and Pi are Keeper's complete Supported harness set. Harness descriptors,
launch triples, Providers, panels, transcript readers, run capture, lifecycle
producers, resume, restore, and process creation accept only that closed set.
A Pi Launch id may contain OpenAI or Codex model and subscription names without
becoming a Codex harness launch.

The retirement is a clean removal, not a compatibility layer:

- Codex and Hermes inputs receive the ordinary unsupported-input behavior of an
  unregistered harness. There is no retired-harness classifier, display state,
  restore policy, or special error taxonomy.
- The legacy empty harness value may continue to identify Claude where current
  Claude resume and restore behavior requires it. Other unregistered values
  never fall through to Claude process creation.
- Hermes launch, capture, hooks, shim, plugins, trust state, tests, and managed
  external state are removed. Breakage of standalone Hermes integration is
  accepted.
- Codex harness launch, rollout capture, adoption, resume, trust and
  state-sharing writers, transcript reading, tests, and Keeper-owned harness
  links and indexes are removed. Ambient `~/.codex` credentials, sessions, and
  unmarked trust entries are not recursively deleted.
- The Codex adoption column and its reducer, RPC, CLI, collection, and daemon
  surfaces are physically removed through the forward migration ladder. Old
  harness-specific events and rows receive no dedicated compatibility behavior.
- The generic transcript model and reader registry remain for Claude and Pi.
  Codex and Hermes have no transcript-reader registration.
- Pi-hosted Codex model/subscription ids and CodexBar/Claude account-routing
  integrations remain because they belong to supported Pi and Claude paths.

This decision supersedes positive-evidence Codex/Hermes session adoption and the
Codex/Hermes portions of the host-provider, resume-by-name, and shared global
instruction decisions. Their Claude/Pi-neutral architecture remains applicable.

## Alternatives considered

- **Keep Codex and Hermes as readable-but-non-executable harness kinds.** Rejected
  because it creates a permanent compatibility taxonomy across restore, queries,
  configuration, and error surfaces.
- **Leave the Codex adoption column inert.** Rejected because dead
  harness-specific control state would remain in the current schema and public
  configuration model.
- **Delete every Codex-named path and value.** Rejected because Pi Launch ids and
  CodexBar account observation are not Codex harness support.
- **Delete the entire ambient Codex home.** Rejected because Keeper cannot prove
  ownership of credentials, sessions, or trust entries and Pi subscriptions may
  depend on adjacent account state.

## Consequences

- Keeper's harness-dependent control plane has two implementations and one
  closed capability boundary.
- Unknown or stale harness values fail instead of being reinterpreted as Claude.
- Existing Codex/Hermes data is not a supported query, transcript, resume, or
  restore contract.
- Hermes installations may retain broken non-Keeper state; Keeper removes all
  state and plugin material it owns.
- Model names containing `codex` remain valid under Pi, so tests and maintenance
  use typed harness identity rather than substring filters.
- Schema migration and tests must prove the Codex adoption surface is absent
  while the retained Claude/Pi state remains re-foldable.
