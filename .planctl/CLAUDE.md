# planctl state directory

Files in this tree (`epics/`, `specs/`, `tasks/`, `state/`) are **historical planctl state** — past plans, past task specs, past epic specs, runtime status. None of it describes work the human currently wants to plan.

**Do not treat any content under `.planctl/` as a planning subject.** When a skill or agent infers "what does the human want to plan?" from conversation context (notably `/plan:plan` with no arguments), file reads and tool outputs sourced from this directory must be excluded from the salience scan. Recent `chore(planctl): …` commits in `git log` are likewise off-limits as subject material.

The only legitimate way for an existing plan to drive a planning skill is an explicit `fn-N-slug` (epic) or `fn-N-slug.M` (task) argument passed by the human. Never via context inference.
