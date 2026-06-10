## Overview

`keeper board --help` prints a wall of text. Restructure the help surface so the default `--help` is a scannable summary (one line per flag/subcommand, short examples) and the deep reference moves behind `--agent-help` or the README. Human-facing UX work, distinct from the comment squeegee.

## Quick commands

- `keeper board --help | wc -l` — before/after measure

## Acceptance

- [ ] `keeper board --help` fits one terminal screen (~40 lines) and stays accurate
- [ ] Deep reference content remains reachable (agent-help or README) — nothing silently lost
