## Description

Two matt-plugin inventories in the arthack repo undersell the plugin's
shipped surface (auditor findings F1 and F2, verified against the files):

- **F1** — `claude/CLAUDE.md:36`: the `matt` bullet ends
  `Shipped: /matt:teach, /matt:grill-me, /matt:prototype.`, omitting
  `/matt:improve-codebase-architecture` (source task .2) and `/matt:init`
  (source task .3). Extend the Shipped list to all five skills.
- **F2** — `claude/matt/README.md:28-33`: the `## Skills` section lists
  teach, grill-me, prototype, and improve-codebase-architecture but not
  `init` (source task .3). Add an `init` bullet matching the style of the
  existing four.

Files to touch: `claude/CLAUDE.md`, `claude/matt/README.md`. Both edits are
the same root cause (an early enumeration not kept in sync as later tasks
added skills) and land as one commit. Leave the README `## Sync log` alone —
it tracks forks only and correctly omits the original `init` skill.

## Acceptance

- [ ] `claude/CLAUDE.md` matt `Shipped:` line names all five: teach, grill-me, prototype, improve-codebase-architecture, init.
- [ ] `claude/matt/README.md` `## Skills` section has a bullet for `init` alongside the other four.
- [ ] No change to the README `## Sync log`.

## Done summary

## Evidence
