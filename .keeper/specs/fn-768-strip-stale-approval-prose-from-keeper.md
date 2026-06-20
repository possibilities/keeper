## Overview

The fn-756 approval strip removed all the approval code but never updated the
prose docs (git log confirms no fn-756 commit touched README.md / CLAUDE.md),
so they still document a removed RPC/verb surface as if it exists. Doc-only
sweep: keeper README.md (~25 refs), keeper CLAUDE.md (8 refs, incl. the
six-surfaces list that must become five), and one planctl CLAUDE.md grammar
line. Present-tense, no tombstoning.

## Quick commands

- `cd ~/code/keeper && grep -ci approval README.md CLAUDE.md` → 0 (or only historical-migration mentions)

## Acceptance

- [ ] keeper README.md + CLAUDE.md carry no live approval prose; the RPC "six surfaces" list reads FIVE and renumbers cleanly; planctl CLAUDE.md line 62 drops the removed approve/ack/approval verbs+fields.
