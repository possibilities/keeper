## Description

Two verified text-accuracy fixes on the pair-resume surface (findings F1 and F2).

F1 (doc-vs-code drift) — `plugins/keeper/skills/pair/SKILL.md` around lines
284-285 claims `--resume` "Rejects `--preset`/`--model`/`--effort`/`--session`"
and that `--name` should be passed "on every launch (fresh or resumed)". But
`runResumeCaptureSubcommand` in `src/agent/main.ts` (reject check at ~1456-1466
covers only model/effort/preset; launch uses `posture: {}` at ~1557) neither
rejects nor threads `--session`/`--name` — they are silently dropped. The code
behavior is deliberate (the resumed session keeps its own config/name), so fix
the DOC: drop `--session` from the `--resume` "Rejects" list and qualify the
`--name` guidance so it does not tell the human/agent to pass `--name` on a
resume (a resumed partner keeps its original name).

F2 (rule #0 fn-id in comments) — `src/agent/resume-policy.ts` (line ~2) and
`test/agent-resume-policy.test.ts` (line ~2) open their doc-comments with
"(epic fn-1232, ADR 0034)". CLAUDE.md rule #0 bans fn-ids in code comments.
Drop "epic fn-1232, " from both openers, keeping the sanctioned "ADR 0034"
pointer.

Files: plugins/keeper/skills/pair/SKILL.md, src/agent/resume-policy.ts,
test/agent-resume-policy.test.ts.

No runtime behavior changes; documentation and comments only.

## Acceptance

- [ ] SKILL.md no longer lists `--session` as rejected by `--resume` and no longer instructs passing `--name` on a resumed launch
- [ ] Neither resume-policy.ts nor agent-resume-policy.test.ts contains a bare `fn-1232` fn-id in comments; the ADR 0034 pointer remains
- [ ] `bun test` stays green

## Done summary
Fixed SKILL.md --resume doc drift (no longer claims --session is rejected or that --name should be passed on a resumed launch) and dropped the bare fn-1232 fn-id from resume-policy.ts and its test doc-comments, keeping the ADR 0034 pointer.
## Evidence
