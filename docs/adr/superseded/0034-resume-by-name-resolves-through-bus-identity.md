# 34. Resume-by-name resolves through bus identity to a native target

## Status

Superseded by [ADR 0062](../0062-unified-session-history-and-resume.md). The detached partner-resume mechanics retained by ADR 0062 remain applicable.

## Context

Pairing (`keeper agent run`, the engine behind `keeper:pair` and panel legs) was
fresh-launch-only: the capture path had no resume analog, and the only resume
surfaces were the harness-native passthrough flags and the daemon-side restore
path — both taking a native id verbatim, neither delivering a new prompt, and
neither addressable by a session's name. Meanwhile the `jobs` projection already
carried everything needed to resolve a name: the current title, an append-only
`name_history`, the `harness`, and the `resume_target`, and the Agent Bus already
resolved current-or-former names over exactly those columns (`resolveTarget` in
`src/bus-identity.ts`, epic fn-875).

Live probes settled two per-harness facts the design hinges on:

- `claude --resume <parent>` forks a **new child session file**; composing
  `--resume <parent> --session-id <child> --fork-session` lets keeper pin the
  child id, so strict transcript discovery keeps working and the envelope's
  post-resume `resume_target` is the pinned child.
- `codex resume <uuid>` **appends to the same rollout file** (same filename,
  same session id). Discovery for a resumed codex session must resolve by the
  known uuid — the fresh-launch created-at floor would reject the pre-existing
  file — and the stop-scan must anchor at a resume-start watermark, because the
  file already contains the prior session's terminal stop marker.

## Decision

Resume-by-name is a **lookup that resolves to a resume target, never a resume
key itself** (per the glossary: a display title is never a resume key). One
resolver — the bus's `resolveTarget`, called with an empty live-channel set —
maps a name-or-id to a jobs row; a thin resume-policy layer in `src/agent/`
adds what pairing needs on top:

- **Refuse-live, no escape hatch.** A target whose newest match is currently
  live (pid + start-time recycle identity) is never resumed; the error points at
  the Agent Bus, the live-messaging surface. Resuming a running session would
  create competing writers on one conversation.
- **Newest-non-live wins, loudly.** Multiple non-live matches collapse to the
  newest by `updated_at` and the pick is echoed (id + harness); an exact tie
  errors listing the candidates. Former names match exactly; substring matching
  stays current-title-only, inheriting the bus resolver's deliberate asymmetry.
- **A resumed launch mints a fresh jobs row carrying the matched row's name.**
  The newest row for a name therefore always holds the latest lineage's resume
  target, so repeated resume-by-name chains through children instead of
  silently re-forking the original conversation.
- **Resume launches in the matched job's recorded cwd.** claude and codex scope
  session storage per-cwd; launching elsewhere breaks native resolution and
  leaks one project's conversation into another.
- **Capture rides the settled-stop gating of ADR 0021 unchanged**, with one
  resume-specific input: the stop-scan anchors at the resume-start watermark so
  a pre-resume terminal marker is never captured as the answer.

The daemon-side restore path keeps its prompt-less native-id contract; the
per-harness passthrough flags stay verbatim. Panel legs stay fresh-only: the
panel's slug-keyed reconcile treats terminal legs as reusable results ("resume
is not retry"), which is incompatible with per-leg resume identity.
