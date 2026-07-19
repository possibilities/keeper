# 0094 — Handoff prompt and launch-selection contract

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022.

## Context

A Handoff carries a durable Brief to a fresh session, but its launch path also
inserted launcher-authored prose around that Brief. Ordinary and captured
handoffs received different framing, and the configured prompt prefix could be
absent or name something other than `/hack`. The receiver therefore had two
possible sources of mandate: the caller-authored Brief and generic launcher
instructions. Capture also controlled whether a caller could select a Launch
triple or explicit model and effort, even though launch posture and result
collection are independent concerns.

Removing the launcher prose exposes one load-bearing behavior: captured
handoffs need to act autonomously and publish a terminal envelope, while an
ordinary work-shaped `/hack` request retains its confirmation beat. The launch
already carries `KEEPER_HANDOFF_ENVELOPE` as a non-empty capture destination and
as an empty stale-value overwrite for ordinary sessions.

## Decision

Every fresh Handoff launches with one user prompt formed byte-for-byte at the
launch boundary as `/hack ` followed by the raw stored Brief. The launcher adds
no headings, explanation, capture instructions, or configurable prefix. The
stored Brief remains raw, so inspection never includes `/hack` or launcher
metadata. The caller owns the Brief's mandate, context, constraints, and desired
outcome; the receiving `/hack` workflow interprets that Brief normally.

A non-empty `KEEPER_HANDOFF_ENVELOPE` is the sole structural capture signal. The
`/hack` workflow treats that signal as authorization to complete autonomously
and publish the canonical answer envelope. An empty value follows ordinary
`/hack` behavior, including the confirmation beat for work-shaped requests. The
carrier remains empty-on-ordinary-launch so a reused Tmux environment cannot
inherit capture authority.

Launch selection is orthogonal to capture. A caller may supply either one Launch
triple through the public `--preset` spelling or a complete `--model` and
`--effort` pair on any Handoff; mixed or partial forms fail at both the CLI and
RPC trust boundaries. A Launch triple supplies its harness, model, and effort.
An explicit pair overrides model and effort on the `dispatch.handoff` harness,
which defaults to Claude when the dispatch row is absent. Capture alone decides
whether an envelope path exists.

The `handoff_prompt_prefix` host setting admits only `/hack` as a compatibility
value and does not vary prompt composition. Any other configured value is a
configuration fault with actionable guidance. This keeps existing `/hack`
configurations harmless while making the Handoff prompt invariant.

## Alternatives considered

- **Keep generic framing for capture only.** Rejected because capture would still
  create a second mandate and the same Brief would mean different things solely
  from launcher-authored prose.
- **Put capture metadata in the Brief.** Rejected because the durable Brief is
  caller-authored domain content, while result collection is launch metadata.
- **Require a Launch triple for every explicit selection.** Rejected because the
  model/effort pair remains useful for overriding the configured handoff harness
  without restating it.
- **Remove `handoff_prompt_prefix` without accepting its `/hack` value.** Rejected
  because the installed invariant configuration is already semantically exact
  and need not block startup.

## Consequences

- Ordinary and captured handoffs have one inspectable prompt-composition rule.
- Callers must author self-contained Briefs rather than rely on launcher prose to
  supply intent or workflow posture.
- Capture behavior lives with `/hack` and the envelope carrier, so the canonical
  envelope contract has one prompting owner.
- Pi Launch triples work for ordinary handoffs because their harness survives the
  entire launch path.
- Prompt tests can assert exact bytes before harness-native template expansion;
  harness-specific argument tests remain responsible for transport fidelity.
