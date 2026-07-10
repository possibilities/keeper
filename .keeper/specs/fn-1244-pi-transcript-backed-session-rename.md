## Overview

Keeper-launched Pi sessions gain `/rename`, a metadata-only command that derives a short Session title from the Latest turn. The command consumes a branch-aware `keeper transcript pi turn` contract, invokes one fixed cheap OpenAI Codex model through Pi's OAuth-aware lower-level inference boundary, persists the accepted title through Pi, and lets Keeper's existing title projection and tmux renamer converge asynchronously.

## Quick commands

- `bun test test/transcript-pi.test.ts test/pi-extension.test.ts`
- Start `keeper agent pi`, submit a prompt, run `/rename`, then inspect `/session` and `keeper show-job` for the same title.

## Acceptance

- [ ] `keeper transcript pi turn` exposes the current active branch's Latest turn as an explicit empty, prompt-only, or prompt-and-response JSON contract without confusing failure or truncation with an empty turn.
- [ ] `/rename` is available in every keeper-launched Pi session, performs no inference or mutation without usable user text, and derives a bounded canonical slug through Pi's OAuth-aware direct inference surface without launching a harness or changing the live conversation/model.
- [ ] A successful title persists in Pi, folds into Keeper's existing TranscriptTitle path, and reaches tmux through the existing renamer worker; failures and stale completions leave every title unchanged.
- [ ] The implementation remains fail-open at Pi extension load and invocation boundaries, logs no transcript/auth/model-output secrets, and uses only pure injected test doubles for inference and external effects.

## Early proof point

Task that proves the approach: `.1`. If it fails: refine the fn-1242 Transcript reader seam to carry an explicit selected-leaf path before implementing `/rename`; do not add a second Pi parser in the extension.

## References

- `fn-1242-multi-harness-keeper-transcript` — supplies harness-first routing and the Pi Transcript reader; this epic extends its landed reader rather than racing it.
- `CONTEXT.md` — Harness session, Session title, Latest turn, and Transcript reader definitions.
- `docs/adr/0041-pi-direct-inference-for-metadata-commands.md` — direct OAuth-aware metadata inference boundary.
- Pi extension and session-format documentation — command registration, lower-level model access, tree branches, and session-info persistence.

## Docs gaps

- **README.md**: add one concise `/rename` capability mention only if it remains useful at the front-door level after consolidation.
- **docs/install.md**: document keeper-launched Pi availability, Pi OAuth prerequisite, fixed cheap model requirement, and failure/no-op behavior without creating a parallel setup guide.

## Best practices

- **Active branch is authoritative:** resolve parent links from the selected leaf; physical JSONL order retains abandoned branches.
- **Metadata inference is isolated:** use one bounded direct completion and never set the live model, append messages, or start another process.
- **OAuth remains Pi-owned:** resolve request authentication/configuration through Pi and never log credentials or raw transcript/model data.
- **Commit title once:** reject incomplete, stale, timed-out, or malformed results before Pi or Keeper state changes.
