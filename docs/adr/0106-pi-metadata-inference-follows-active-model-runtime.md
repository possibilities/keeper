# 106. Pi metadata inference follows the active model runtime

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022. Supersedes ADR 0041 and ADR 0096; ADR 0096 supersedes ADR 0093.

## Context

Session rename has different native boundaries in Claude and Pi. Claude provides a built-in `/rename`; Pi provides an extension command, active-model metadata, an effective provider registry, and native Session title mutation.

A fixed metadata model creates an availability requirement unrelated to the active Pi session. Provider catalogs and account capabilities differ: in particular, Spark is available only on accounts whose fresh provider observation exposes that capability. Resolving a fixed model and then calling a package-global completion function can also bypass extension-installed provider behavior such as Keeper's Codex account routing.

The active Pi model is already selected, authenticated, and meaningful to the current Session. Pi's effective provider owns any extension-installed routing for that model.

## Decision

Session rename follows each harness's native path:

- Claude uses Claude Code's built-in `/rename`. Keeper registers no Claude rename skill, prompt hook, metadata-inference process, or direct title writer.
- Pi retains Keeper's extension command, bounded compaction-aware conversation input, safe human-authored `@path` expansion, canonical explicit slugs, fail-open behavior, and `setSessionName()` commit point.
- Bare Pi `/rename` snapshots the active model at invocation. It does not select, switch, or fall back to another model.
- Pi resolves authentication and the model's effective provider through the command context's model registry, then invokes that provider's simple-stream boundary with the native Session id. Provider extensions, including Keeper's Codex account pool, remain in the request path when they own the active model.
- Metadata inference remains a bounded direct request: no live-agent message, child Harness, model-selection mutation, or separate Session. Only a successful complete response can produce a validated canonical title.
- Explicit canonical slugs bypass transcript reads and inference. Every failure leaves the existing Session title unchanged.
- Claude's native `custom-title` records and Pi's `session_info_changed` title bridge feed Keeper's `TranscriptTitle` events and downstream title surfaces asynchronously; rename never writes Keeper's database or Tmux directly.

## Alternatives considered

- **Use one fixed cheap provider model.** Rejected because model and account capability are not universal, so metadata availability would depend on an unrelated credential.
- **Choose the cheapest currently listed model.** Rejected because catalog presence does not prove credential-specific availability, and the choice would silently diverge from the Session's provider routing.
- **Send a naming prompt through the live Pi agent.** Rejected because it adds conversation state and can affect later model behavior.
- **Launch a child Harness.** Rejected because process startup, resource discovery, tracking, and a second Session are unnecessary for one bounded metadata value.
- **Call a package-global provider API.** Rejected because it can bypass Pi's effective provider and extension-installed routing.

## Consequences

- Bare Pi rename works with any active text-capable model whose effective provider and authentication are available.
- Metadata cost follows the active model, bounded by the command's small input and output limits.
- Switching Pi's selected model after invocation does not retarget an in-flight rename.
- Codex requests use Keeper's account routing only when the active model is Codex; model-scoped capability policy remains authoritative.
- A missing active model, effective provider, authentication result, valid completion, or fresh Session snapshot leaves the title unchanged.
- The isolated Pi extension keeps structural host types and catches provider API drift so a rename failure never becomes a Session failure.
