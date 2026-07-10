# 40. Per-verb dispatch table and host agent pins

## Status

Accepted. Partially supersedes ADR 0033: only its `worker`/`escalation`
catalog-key clause; the triple grammar, named-catalog retirement, and per-harness
defaults stand. Extends 0036's required host matrix as the agent-pin source.

## Context

Launch model/effort tuning was scattered across four surfaces with no single
legible table. `presets.yaml` carried two role-keyed triples — `worker` for the
work and close dispatches, `escalation` for unblock, deconflict, and repair —
layered over four compiled-in floor constants by twin resolvers duplicating
each other byte-for-byte. The `resolve::` dispatch inlined the raw constants,
bypassing even a tuned `worker` key; a handoff pinned nothing, landing on the
harness default by accident. On the subagent side, eleven static plan agents
carried hand-authored `model:`/`effort:` frontmatter — one already
template-rendered but with literal values — so retuning a scout meant editing
scattered prose files nothing cross-checked.

## Decision

`presets.yaml` gains a per-verb `dispatch:` table — `work`, `close`, `resolve`,
`unblock`, `deconflict`, `repair`, and optional `handoff`, each value a launch
triple. The `worker`/`escalation` keys retire; a leftover key fails loud with a
migration hint naming the new block, the same pattern that retired the freeform
`presets:` catalog. One leaf resolver serves every dispatch site from a
compile-time-total per-verb floor map: `work`/`close`/`resolve` floor to the
worker constants, the escalation trio to the escalation constants, and `handoff`
floors to absent — no flags, the harness default. The parsed harness rides
through the resolver so multi-harness dispatch can slot in later; dispatch
launches claude-only today, warn-once on a non-claude triple. `approve` resolves
through the `work` row — it has no live dispatch path of its own. The work and
close verbs become independently settable: the reconcile snapshot carries each
verb's resolved pair, produced outside the fold.

Parse stays whole-file strict: a malformed entry — or a leftover role key —
fails the catalog loudly everywhere an operator reads (dispatch CLI, `presets
list`, `providers check`), and the daemon's fail-open swallow floors every verb
rather than salvaging per verb — a lenient partial-apply mode would contradict
the catalog's strict-reject discipline. Missing and malformed rows resolve to
the same named floor, logged distinctly; the doctor lints every dispatch triple
against the launch cube, and `presets list` prints the resolved table.

The host matrix gains `agent_pins:` — a per-agent `{model, effort}` map for the
static plan subagents. The hand-authored agent files convert to templates; the
renderer injects each pin into its template's frontmatter at render time, with
strict variables making a missing pin a loud render failure, and the rendered
agents become host-derived gitignored output exactly like the worker cells.
Pins are pairs, never triples: subagent frontmatter is consumed in-session by
the harness, so a harness axis would be meaningless. Pin efforts validate
against the matrix effort axis; a host-blind drift gate asserts templates and
pins form a total, disjoint partition and rendered frontmatter equals the pin.

## Alternatives considered

- **Per-verb salvage of a malformed table.** Rejected: a lenient second parse
  mode; partial-apply confuses more than it saves, and the loud surfaces catch
  a typo at edit time.
- **A repo-side pin file.** Rejected: recreates the second config instance the
  required-matrix decision deleted, and the renderer already loads the host
  matrix before any render.
- **Pins as launch triples.** Rejected: frontmatter has no harness axis.
- **A `dispatch:` key for `approve`.** Rejected: no live dispatch path exists
  for it; a config row would imply one.

## Consequences

- Retuning a dispatched skill is one `dispatch:` line, picked up next reconcile
  cycle with no daemon bounce; retuning a subagent is one `agent_pins:` line
  plus a re-render. `resolve::` starts honoring operator config and handoff
  becomes pinnable — both deliberate behavior changes of this decision.
- Operators migrate two host files by hand, prompted by fail-loud hints; a
  `dispatch:`-less catalog is behavior-identical to the old defaults via the
  floors.
- A typo in one dispatch row floors every verb on the live board until fixed —
  the accepted cost of whole-file strictness, mitigated by the loud read
  surfaces.
