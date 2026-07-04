## Description

**Size:** M
**Files:** src/agent/codex-session-index.ts, src/codex-resume-worker.ts (new) or an equivalent producer seam in src/daemon.ts, test/codex-resume.test.ts (new)

### Approach

Promote the existing codex session discovery into a daemon-side producer that
resolves native rollout uuids for live codex jobs whose resume_target is NULL,
then has MAIN mint a ResumeTargetResolved synthetic event (never a direct jobs
write — re-fold must reproduce it). Attribution precedence: exact match on
SessionMeta.originator == job_id (the launcher exports
CODEX_INTERNAL_ORIGINATOR_OVERRIDE=job_id at launch) FIRST; fall back to
cwd + created-at with the existing refuse-to-guess-on-collision behavior —
an unresolvable session leaves resume_target NULL and presence is unaffected.
Read ONLY the rollout head (SessionMeta line) — identity/metadata, never session
content (codex rollouts can contain secrets); tolerate a partially-written meta
line (git fields are collected async by codex). Poll only while candidate jobs
exist and are recent; go quiet otherwise. The originator override has an upstream
removal TODO — keep the fallback path first-class, not vestigial.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/codex-session-index.ts:84-120 — rollout filename parse + cwd attribution + refuse-to-guess (returns null on >1 same-cwd rollout)
- A live ~/.codex/sessions tree — confirm current date-subdir nesting (MEDIUM confidence from source reading)
- The ResumeTargetResolved fold arm from the schema task — event shape to mint

**Optional** (reference as needed):
- src/transcript-worker.ts — external-tree tailing producer conventions
- src/usage-scrape-runner.ts — bounded per-target polling loop shape

### Risks

- Concurrent same-cwd codex sessions with the override env stripped (user-modified launch) fall to the fallback and may stay NULL — accepted, degrade to presence-only
- Upstream may remove the originator override env — the fallback must remain tested

### Test notes

Fixture rollout files: originator exact-match wins over a same-cwd decoy;
collision without originator leaves NULL; partial SessionMeta tolerated;
minted event round-trips to jobs.resume_target through the fold.

## Acceptance

- [ ] A tracked codex launch gets its rollout uuid as resume_target within one poll interval, via an event the re-fold reproduces
- [ ] Two concurrent codex sessions in the same cwd both resolve when launched by keeper (originator match); without the override, collision leaves resume_target unset rather than guessing
- [ ] The producer reads only session metadata, never message content, and idles when no candidate jobs exist

## Done summary
Daemon-side codex resume-target producer: resolves a tracked codex job's rollout uuid (originator exact-match, cwd+created-at refuse-to-guess fallback) from the rollout SessionMeta head and has MAIN mint a ResumeTargetResolved synthetic event; reads only metadata, idles when no candidate exists.
## Evidence
