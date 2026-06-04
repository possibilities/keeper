## Description

Finding F1 from the fn-1-split-queue-into-defer-and-next audit. Three comment sites reference
the removed skill:

- `planctl/invocation.py:75-80` (docstring): names the removed skill as the source of `queue_jump=True`
  and claims "Mutating verbs that aren't `scaffold` always pass False" — directly contradicted by
  `epic queue-jump`, the non-scaffold mutating verb introduced in fn-1 that passes `queue_jump=True`.
- `planctl/models.py:131` (inline comment): "The signal is server-derived from the /plan:queue
  scaffold event."
- `planctl/cli.py:419` (schema comment): first line reads "/plan:queue sets true at mint" (rest
  of comment already references `queue-jump`/`/plan:next`).

All three violate CLAUDE.md's explicit backward-reference ban. Fix each to describe the
current model: scaffold YAML opt-in path and/or `epic queue-jump` verb (`/plan:next`).

## Acceptance

- [ ] `invocation.py:75-80`: references `epic queue-jump` as the non-scaffold source of `queue_jump=True`; removes the false "always pass False" claim
- [ ] `models.py:131`: references scaffold opt-in and `queue-jump` verb; no removed-skill mention
- [ ] `cli.py:419`: first line updated to present-tense description of scaffold opt-in; no removed-skill mention
- [ ] `grep -r '/plan:queue' planctl/` returns no results in non-historical comment sites

## Done summary

## Evidence
