# 27. Selection verdicts apply through a trusted verb; the selector never writes

## Status

Accepted.

## Context

The `plan:model-selector` subagent picks `{tier, model}` cells for newly
scaffolded work in three flows: the post-scaffold selection beat of `/plan:plan`
(create and refine), the single-task beat of `/plan:defer`, and the close-time
pre-select of a follow-up epic in `/plan:close`. The selector ingests untrusted
spec prose, so its agent definition strips `Edit`/`Write`/`Bash`/`Task` and it
returns exactly one raw JSON verdict.

The apply step — validating that verdict and landing cells — was triplicated
across the three calling skills with two mechanisms: an `assign-cells` YAML
heredoc for live epics, and a hand-assembled `followup-verdict.json` (written
with the harness Write tool) for close. Hand-transcribing model JSON into
heredocs was the one remaining garble surface, and the design question "should
the selector write its own assignments?" kept resurfacing.

## Decision

The selector stays a pure content-blind classifier; the write stays outside it,
for three structural reasons:

1. **Privilege separation.** An injection-exposed reader never holds a mutating
   surface. The JSON return channel already carries the verdict, so arming the
   selector buys nothing and hands prompt-injected spec prose a write path.
2. **Degrade lives caller-side regardless.** Degrade triggers fire when the
   selector never ran or died (brief failure, Task death, repeated validation
   miss). A selector-owned happy-path write would add a second writer to the
   same surface, not remove one.
3. **The close context has nothing to write.** Follow-up tasks are unminted
   ordinals until `close-finalize` creates them born-selected; no agent-side
   write can be uniform across the three contexts.

One deterministic verb, `keeper plan apply-selection`, is the single trusted
apply seam in all three contexts. It takes the selector's raw verdict on stdin,
validates it against the on-disk selection brief (enum-clamp, exact coverage,
collect-all errors), pins provenance hashes from the brief rather than model
transcription, and lands the write through the shared `assign-cells` core (live
epics) or stages the selection verdict document `close-finalize` consumes
(follow-up pre-select). Retry orchestration stays in the skills — a verb cannot
spawn a subagent — while validate/write/degrade belongs to the verb.

## Consequences

- Calling skills stop hand-parsing and transcribing selector JSON; they pipe
  the selector's return verbatim and relay the verb's failure details to the
  one fresh-selector retry.
- `assign-cells` remains the public batch primitive; both verbs share one
  flock/mutate/sidecar core so the write logic never forks.
- `close-finalize --selection-verdict` is unchanged; the verb becomes the
  trusted author of the file that flag consumes, and finalize keeps its own
  fail-closed re-validation.
- Any future selection context reuses the same seam: brief in, raw verdict in,
  one verb call out.
