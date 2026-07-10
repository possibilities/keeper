# 41. Pi metadata commands use direct inference

## Status

Accepted.

## Context

A Pi slash command can ask a model to derive metadata such as a Session title. Three invocation boundaries are available: send a message through the live agent, launch a child harness, or call Pi's lower-level model surface directly.

The live-agent path changes conversation state and can change the selected model. A child harness creates another process, loads resources, negotiates a session boundary, and can enter Keeper's tracked-work surface. Neither side effect belongs to a metadata operation whose only input is a bounded transcript excerpt and whose only output is a short value.

Keeper's Pi event extension is deliberately fail-open and dependency-light because a load failure can interfere with the human's session. Pi supplies model metadata, OAuth-aware request resolution, and lower-level completion APIs at runtime, but those host APIs evolve independently of Keeper's normal module graph.

## Decision

Pi metadata commands invoke inference directly through Pi's runtime model boundary:

- resolve the fixed model through the command context's model registry;
- resolve request authentication and provider configuration through Pi so OAuth refresh and account selection retain Pi's semantics;
- issue one bounded lower-level completion without changing the live model, appending a message, creating a Harness session, or launching another process;
- accept only a successful complete response, then validate and normalize the derived metadata before mutating Pi state.

The host-model dependency is invocation-local. Extension startup and the NDJSON events writer remain free of static Pi-package imports; a command loads the host-supplied inference surface only when invoked, catches import and API-shape failures, and exposes pure injected seams for Keeper's in-process tests. A model API failure disables that command invocation, never the Pi session.

The command uses one fixed cheap `openai-codex/*` model and does not fall back to a more expensive model. Authentication, transcript text, and raw model output never enter logs.

## Alternatives considered

- **Send a naming prompt through the live Pi agent.** Rejected: it pollutes the transcript and context, affects usage accounting, and can alter subsequent conversation behavior.
- **Temporarily switch the live model.** Rejected: model selection is durable session state rather than command-local inference configuration.
- **Launch Pi or Keeper as a child harness.** Rejected: process startup, resource discovery, and session tracking are unnecessary for one bounded completion.
- **Call a provider API directly.** Rejected: raw provider calls bypass Pi's OAuth-aware request and refresh boundary.
- **Statically import Pi model packages from the events writer.** Rejected: an import-resolution failure would widen an optional metadata feature into a session-start failure.

## Consequences

- Metadata inference does not appear as a conversation turn and cannot change the active model.
- OAuth subscription behavior, refresh locking, and provider request configuration remain owned by Pi.
- Command code carries a narrow runtime dependency on Pi's lower-level inference API and must fail open across API drift.
- Tests inject model lookup, authentication, and completion results; they never call a real model or start a harness.
- A missing cheap model, failed OAuth refresh, timeout, cancellation, or malformed completion leaves existing metadata unchanged.
