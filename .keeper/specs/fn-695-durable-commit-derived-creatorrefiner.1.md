## Description

**Size:** S
**Files:** planctl/commit.py, planctl/invocation.py, planctl/run_validate.py (target repo /Users/mike/code/planctl), planctl test suite

### Approach

Thread the resolved `PLANCTL_SESSION_ID` into planctl's `chore(planctl)` commit
trailers. Today `_build_message_with_trailers` (commit.py:226) writes
`Planctl-Op` / `Planctl-Target` / `Planctl-Prev-Op` but no session id;
`build_planctl_invocation` (invocation.py:42) resolves `PLANCTL_SESSION_ID` but
drops it from the envelope (~:119). Carry `session_id` on the invocation envelope
(and the readonly variant ~:164 if any committing verb uses it), then stamp
`Session-Id: <uuid>` in `_build_message_with_trailers` (optionally a `Job-Id:`
mirror to the SAME uuid). Honor `job_id === session_id`: stamp the SAME uuid the
keeper hook uses (the harness-exported `PLANCTL_SESSION_ID`), never a freshly
minted one. Fail-open: when `PLANCTL_SESSION_ID` is absent (manual CLI /
non-interactive), OMIT the trailer (commit still lands; keeper falls back to the
scrape path) — never abort the commit. Cover `run_validate.py:134`'s
hand-built `auto_commit_from_invocation` payload too.

### Investigation targets

**Required:**
- /Users/mike/code/planctl/planctl/commit.py:226 `_build_message_with_trailers` — stamp site
- /Users/mike/code/planctl/planctl/commit.py:252 `auto_commit_from_invocation` — payload carries no session_id today
- /Users/mike/code/planctl/planctl/invocation.py:42 `build_planctl_invocation` (resolves PLANCTL_SESSION_ID, drops it ~:119) + :164 readonly variant
- /Users/mike/code/planctl/planctl/run_validate.py:134 `auto_commit_from_invocation` call (hand-built payload must also carry the session id)

**Optional:**
- keeper src/git-worker.ts `coalesceCommitterSessionId` — the consumer's take-last, Session-Id-preferred-over-Job-Id contract this must satisfy

### Risks

- `PLANCTL_SESSION_ID` may not equal the Claude session id under autopilot / non-interactive dispatch — verify the harness exports it identically there; if it can ever differ, prefer omitting over stamping a wrong id.
- A jobctl `Job-Id` stamp must never disagree with planctl's `Session-Id` on the same commit (keeper warns + prefers Session-Id) — confirm `chore(planctl)` commits don't also get a jobctl `Job-Id`.

### Test notes

planctl's own suite: a scaffold/refine commit carries `Session-Id: <PLANCTL_SESSION_ID>`; the trailer is omitted (commit still succeeds) when the env var is unset; the stamped uuid equals the input, not a fresh one.

## Acceptance

- [ ] `chore(planctl)` scaffold/create/refine commits carry `Session-Id: <uuid>` equal to `PLANCTL_SESSION_ID`
- [ ] trailer omitted and commit still succeeds when `PLANCTL_SESSION_ID` is absent
- [ ] existing `Planctl-Op` / `Planctl-Target` trailers unchanged; `Session-Id` rides alongside
- [ ] planctl test suite green

## Done summary
Thread PLANCTL_SESSION_ID onto the planctl_invocation envelope and stamp Session-Id: <uuid> in _build_message_with_trailers; trailer omitted (commit still lands) when the env var is absent. Existing Planctl-Op/Target/Prev-Op trailers unchanged.
## Evidence
