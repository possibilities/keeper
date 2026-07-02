## Overview

A codex `agent run` leg captured a concurrent same-cwd codex session's answer as its own: with two rollout files alive (the leg's own, created at launch, and a larger pre-existing session whose mtime kept advancing), transcript discovery matched the wrong file and the run capture returned another conversation's last message with outcome completed / message_found true. Codex cannot pin a session id at launch, so discovery must bind to evidence the leg itself produced rather than a newest-file heuristic.

## Quick commands

- `bun test test/agent-run-capture.test.ts test/agent-codex.test.ts`

## Acceptance

- [ ] A codex leg's capture never attaches to a rollout file that predates the leg's launch or belongs to a concurrent session; ambiguity degrades to a distinct non-completed outcome rather than a confident wrong answer
