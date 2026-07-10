## Overview

Partner sessions become resumable by session id or any current/former name
(rename-surviving) at both `keeper agent` layers: a harness-agnostic
interactive `resume` verb, and a `--resume` flag on the blocking `agent run`
capture path that keeper:pair drives — so pairing can continue a
conversation instead of always starting cold. One resolver (the bus's
`resolveTarget`) maps names to jobs rows; a resume-policy layer adds
refuse-live, newest-non-live collapse, and per-harness target handling.
Design rationale and probe-settled per-harness facts: docs/adr/0034.

## Quick commands

- `keeper agent resume <name-or-id> "follow-up ask"` — re-attach interactively by name
- `keeper agent run codex "ask" --resume <name> --output /tmp/ans.json && jq .message /tmp/ans.json` — resumed capture end-to-end

## Acceptance

- [ ] `keeper agent resume <x>` re-attaches a dead partner by current name, former name, or id; a live target is refused with a bus pointer
- [ ] `keeper agent run <cli> "<ask>" --resume <x>` resumes, delivers the ask, and captures the resumed session's new final answer in the envelope
- [ ] Fresh-launch behavior (argv, capture, envelope goldens) is byte-unchanged
- [ ] The pair skill documents both resume shapes and name-your-partners guidance

## Early proof point

Task that proves the approach: ordinal 1 (the resume-policy resolver). If it
fails: resolver semantics adjust in isolation — no launch or capture surface
depends on it yet.

## References

- docs/adr/0034-resume-by-name-resolves-through-bus-identity.md — the decision record; probe-settled facts (claude forks a child pinned via `--session-id` + `--fork-session`; codex resume appends to the same rollout)
- src/bus-identity.ts — `resolveTarget`, the shared name resolver (exact incl. name_history → prefix → substring-current-title-only)
- docs/adr/0021 — settled-stop capture gating the resumed capture rides unchanged
- CONTEXT.md — Resume target / Session title / Refuse-live vocabulary (a name is a lookup, never a resume key)

## Docs gaps

- **plugins/keeper/skills/pair/SKILL.md**: fold resume into the fresh-launch framing; frontmatter description + argument-hint must advertise resume (covered by the final task)

## Best practices

- **Process identity, not existence:** the refuse-live gate compares pid + start-time (recycle check), never bare pid liveness [practice-scout, VERIFIED]
- **`--` before the prompt positional:** a prompt starting with `-` must not parse as a flag (option injection; shell escaping alone does not stop it) [POSIX §12]
- **Anchor resumed-transcript scans at the resume watermark:** the pre-existing file already contains the prior session's terminal stop marker; scanning from file start re-captures old turns as the "answer" [probe-verified for codex]
- **Resume is cwd-scoped:** claude/codex store sessions per-cwd; resolve and launch in the matched job's recorded cwd or the native CLI cannot find the session [practice-scout, VERIFIED]
