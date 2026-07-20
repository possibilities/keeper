# 96. Session rename follows each harness's native path

## Status

Accepted. Supersedes ADR 0093.

## Context

Claude and Pi expose materially different rename boundaries. Pi provides an extension command and an in-process, OAuth-aware completion API. Claude Code already provides a native `/rename` command that derives a title without a plugin command turn or a second CLI process and writes the same native title records Keeper consumes.

Shadowing Claude's command with a Keeper skill requires a `UserPromptSubmit` hook, a separately routed metadata process, and a second model turn that only acknowledges the hook result. Claude discards `sessionTitle` when that turn is blocked or halted, so the extra turn cannot be removed while retaining the hook as the native commit point.

## Decision

Session rename follows each harness's native path:

- Claude uses Claude Code's built-in `/rename`. Keeper registers no Claude rename skill, prompt hook, metadata-inference flag, or title-generating child process.
- Pi retains Keeper's native extension command, bounded transcript inference, safe human-authored `@path` expansion, canonical explicit slugs, fixed cheap model, fail-open behavior, and `setSessionName()` commit point.
- Claude's native `custom-title` records and Pi's `session_info_changed` title bridge remain the producers. Both feed Keeper's `TranscriptTitle` events, title Projection, Session catalog, and Tmux renamer asynchronously; rename never writes Keeper's database or Tmux directly.
- Harnesses need not share inference, argument-validation, or failure-message behavior. Their common contract is native title mutation followed by Keeper's existing propagation and exact-title lookup.
- Canonical slug validation applies to Keeper's Pi command and inferred Keeper titles, not to Claude Code's native explicit-name syntax.

## Alternatives considered

- **Keep Keeper's custom Claude command.** Rejected because a second Claude process dominates latency and the command still requires an active-model acknowledgment turn.
- **Block or halt the Claude command turn after returning `sessionTitle`.** Rejected because Claude processes the blocking outcome before applying the title.
- **Retain a slow smart-rename command beside native `/rename`.** Rejected because the duplicate command and metadata launcher do not justify their maintenance and Account-routing surface.
- **Generate Claude titles with a deterministic local keyword extractor.** Rejected because native Claude inference is already faster than the custom process while preserving better semantic naming.
- **Write Claude transcript, Keeper Projection, or Tmux title state directly.** Rejected because those paths create competing writers and bypass native title authority.

## Consequences

- Claude rename latency and behavior follow Claude Code, including its accepted explicit-name syntax and native inference context.
- Pi keeps the transcript-aware behavior that is fast through its in-process host API.
- Keeper removes the Claude rename hook, skill, hidden launcher mode, process controls, and their dedicated tests.
- Native Claude and Pi title changes continue to propagate through the same Keeper title history and Tmux surfaces.
