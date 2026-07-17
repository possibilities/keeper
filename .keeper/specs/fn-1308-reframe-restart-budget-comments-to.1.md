## Description

Finding F1 (kept). Evidence: `cli/restart.ts:15-24` as of commit
381292a4 introduced two constant comments that violate CLAUDE.md rule #0:

- Above `DEFAULT_RESTART_TIMEOUT_MS = 150_000`: "...can run the full 30s
  this used to allow..." — past-tense provenance.
- Above `KICKSTART_TIMEOUT_MS = 15_000`: "...a 1s subprocess budget
  TERM-kills it mid-work on every invocation..." — present-tense narration
  of a 1s kickstart budget that no longer exists on this path (now 15s),
  which misleads the next reader.

Files: `cli/restart.ts`. Reframe both comments to state current behavior
only, preserving the why-this-number rationale (why the 150s deadline and
the 15s kickstart budget are sized as they are). The 30s→150s and 1s→15s
history belongs to the commit message, not the code.

## Acceptance

- [ ] Neither comment references a retired value ("used to allow", "1s
      subprocess budget") as history or as if live; both read forward-facing.
- [ ] The margin rationale (post-boot catch-up can run tens of seconds; a
      real kill-and-respawn needs a multi-second budget while still bounding
      a wedged launchctl) is retained.
- [ ] `bun scripts/lint-claude-md.ts` green; existing restart CLI tests pass.

## Done summary

## Evidence
