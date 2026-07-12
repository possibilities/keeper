## Overview

`keeper agent run pi --resume <target>` can return the PRIOR turn's answer
as a fresh `completed` capture: pi's resume mints a new session file whose
copied history is re-stamped with resume-time timestamps, so the capture
stack's start-window filter never excludes the old turns and the plain
first-stop scan matches a copied stop within seconds.

## Quick commands

bun test test/agent-run-capture.test.ts test/agent-transcript-background.test.ts

## Acceptance

- [ ] A resumed pi capture waits for the NEW turn's stop and never returns a
      copied prior-turn answer; claude/codex/hermes capture byte-identical.
