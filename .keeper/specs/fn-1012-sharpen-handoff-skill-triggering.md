## Overview

The `keeper:handoff` skill's frontmatter `description` (the only surface the
model sees at skill-selection time) under-claims imperative "handoff" usage,
so a "send a handoff in the <repo> project to work on it" request mis-routes
to `plan:defer`. Reword handoff's description to greedily and unambiguously
claim imperative "handoff" (incl. "send a handoff", "handoff to/in the <repo>
project"), advertise the cross-repo `--dir` path, and add a reciprocal
negative clause naming `plan:defer`; add the mirror near-miss to defer's
description. Discriminator is action-type (handoff = dispatch a worker; defer
= scaffold a board epic, no worker), NOT now-vs-later. Preserve the existing
"write a handoff DOCUMENT (.md) → just write the file" carve-out.

## Quick commands

- `python3 -c "import yaml,sys; d=yaml.safe_load(open('plugins/keeper/skills/handoff/SKILL.md').read().split('---')[1])['description']; print(len(d))"` — confirm handoff description ≤1024 chars
- `cd plugins/plan && bun test consistency-skills` — defer skill consistency gate stays green

## Acceptance

- [ ] handoff description claims imperative "handoff" / "send a handoff" / "handoff to/in the <repo> project", names the cross-repo `--dir` path, and carries a reciprocal `plan:defer` negative clause; ≤1024 chars
- [ ] defer description gains a reciprocal near-miss naming `keeper:handoff`; defer's claimed scope unchanged
- [ ] the markdown-document carve-out is preserved
- [ ] `plugins/plan` tests green; all prose forward-facing
