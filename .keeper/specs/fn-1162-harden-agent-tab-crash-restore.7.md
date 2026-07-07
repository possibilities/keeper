## Description

**Size:** S
**Files:** cli/tabs.ts, src/tabs-core.ts, src/daemon.ts, test/tabs.test.ts

### Approach

`keeper tabs repair` is a read-only sweep — no `--apply` flag. It lists rows
whose recorded resume target names no on-disk artifact (the rot left by
pre-fix resume cycles): sweep live and killed non-claude jobs, gate each
target through the disk-existence checks, and report proposed re-pins by
matching harness session stores — pi session files under the job cwd's pi
project dir matched by creation-time proximity to the job's created_at, codex
rollouts by originator. Each proposal carries old → new + a confidence note;
an ambiguous match (more than one plausible candidate) is listed but never
resolved.

The actual re-pin is landed by a daemon-side producer, not by the CLI: extend
the existing codex resume-target back-fill sweep in `src/daemon.ts` (the
`codexResumeSweepTimer` / `resolveCodexResumeCandidates` /
`mintCodexResumeTargetResolved` chain, fn-1103) with a twin pass over rotted
pi jobs, reusing the SAME confidence gate `keeper tabs repair` reports with.
Only an unambiguous (single-plausible-candidate) resolution is applied; main
mints the re-pin through the sanctioned `ResumeTargetResolved` synthetic event
— the same event-sourced seam the codex back-fill already uses — never a
direct `jobs` write and never a new RPC surface (main is the sole event
writer; this is a producer mint, not a socket-triggered mutation, so it needs
no addition to the seven-surface RPC list). An ambiguous candidate stays
reported by `keeper tabs repair` until it resolves unambiguously or a human
corrects it by hand. The standing exemplar this heals: the live arthack-123
pi tab whose job identity and recorded target diverged from its real on-disk
session.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at
authoring time, but the repo moves.*

**Required** (read before coding):
- `src/daemon.ts` — the codex resume-target back-fill producer
  (`findCodexResumeCandidates` / `resolveCodexResumeCandidates` /
  `mintCodexResumeTargetResolved` / the `codexResumeSweepTimer` tick that
  wires them together) — reuse this shape for the pi pass rather than
  inventing a new write path
- cli/tabs.ts:182-278 — TabsCommand parsing + main dispatch (add the
  read-only `repair` verb)
- src/resume-resolve.ts — the artifact-existence gates from the resolver task

**Optional** (reference as needed):
- ~/.pi/agent/sessions/ — store layout: `<project-slug>/<iso-ts>_<uuid>.jsonl`
- src/restore-set.ts:118-144 — the jobs columns available to the sweep
  (harness, resume_target, cwd, created_at)

### Risks

- Time-proximity matching is a heuristic — confidence must be honest and
  ambiguity must refuse, or repair becomes a new poisoning vector.
- The daemon-side pass must re-read `resume_target` immediately before
  minting (mirroring the codex sweep's own re-check) so a concurrent
  resolution is never overwritten.

### Test notes

Fixture a jobs set with a rotted pi row + a pi store containing one
plausible and one implausible file: `keeper tabs repair` reports the
plausible one with a confidence note; two plausible candidates ⇒ listed,
never resolved. Drive the daemon-side producer pass directly (unit-level,
no real daemon boot per the test-isolation rule): a single-candidate
resolution mints `ResumeTargetResolved` and the projection re-reads
repaired; a two-candidate case mints nothing.

## Acceptance

- [ ] `keeper tabs repair` (always dry-run, no `--apply`) lists each rotted
      job with a proposed artifact-backed target and a confidence note.
- [ ] The daemon's resume-target back-fill producer applies only
      unambiguous single-candidate proposals, minting the same
      event-sourced `ResumeTargetResolved` path the codex back-fill uses —
      never a direct `jobs` write, never a new RPC surface.
- [ ] Ambiguous candidates are surfaced by `keeper tabs repair` but never
      auto-applied by the producer.
- [ ] After a producer-applied repair, `keeper tabs dump` emits resume
      lines whose targets all exist on disk.

## Done summary

## Evidence
