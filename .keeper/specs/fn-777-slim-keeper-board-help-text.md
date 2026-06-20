## Overview

Keeper's agent-called help surfaces print walls of text: `keeper board --help` (179 lines / 11k chars), `keeper jobs --help` (86 / 4.5k), `keeper await --help` (81 / 4.7k). Event-log evidence shows agents defensively truncating these (`--help | head -40`) and re-calling at larger sizes. Slim each default `--help` to a scannable screen; deep reference moves behind `--agent-help` or README (delete where README already duplicates). `keeper commit-work --help` (16 lines) is the house style target.

## Quick commands

- `for v in board jobs await; do keeper $v --help | wc -l; done` — before/after measure

## Acceptance

- [ ] `keeper board --help`, `keeper jobs --help`, `keeper await --help` each fit one screen (~40 lines max) and stay accurate
- [ ] Deep reference content remains reachable (agent-help or README) — nothing silently lost; README duplication deleted, not relocated
- [ ] Done summaries report lines/chars deleted (scoreboard)
