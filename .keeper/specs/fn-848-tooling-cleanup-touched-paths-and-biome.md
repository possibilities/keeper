## Overview

Two small, independent tooling fixes surfaced while draining the board. (1) The
planctl touched-paths reader THROWS on a record whose path isn't under the data dir
("Touched-paths record contains a non-data-dir path") — a single stale legacy
`.planctl/` record (from a session that ran ops before the .keeper rename) wedges the
whole op (it broke `keeper plan epic rm` this session). It should SKIP the stale
record, not throw. (2) Pre-existing biome format debt in two test files trips
`keeper commit-work`. Both are forward-facing cleanups.

## Acceptance

- [ ] the touched-paths reader skips (logs + continues) a non-data-dir / unreadable record instead of throwing; a stale legacy path no longer wedges a planctl op
- [ ] `test/resume-descriptor.test.ts` + `test/subagent-invocations.test.ts` pass biome format; `keeper commit-work` no longer trips on them
- [ ] `bun run test:full` green
