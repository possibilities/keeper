## Description

**Size:** M
**Files:** src/handoff-worker.ts, src/db.ts, src/daemon.ts, plugins/plan/skills/hack/SKILL.md, plugins/keeper/skills/handoff/SKILL.md, docs/agent-surface-contracts.md, docs/install.md, test/handoff-worker.test.ts, test/config.test.ts

### Approach

Compose every fresh Handoff prompt at one boundary as the literal `/hack ` prefix plus the raw stored Brief, with no ordinary framing, capture framing, headings, or trimming. Make `/hack` treat only a non-empty `KEEPER_HANDOFF_ENVELOPE` as captured authority: it completes without the ordinary confirmation stop and publishes the canonical nine-key envelope, while an empty carrier follows normal `/hack` behavior. Keep the carrier's empty overwrite on ordinary launches. Make the configured prefix unable to vary this invariant: `/hack` is a harmless compatibility value and any other configured value surfaces actionable configuration guidance.

Update the Handoff skill so callers write the complete mandate—goal, context, constraints, desired posture, and expected outcome—because the launcher supplies none. Describe Launch triples and model/effort selection independently of capture, preserve fire-and-forget versus captured waiting behavior, and keep the raw Brief distinct from the launch-only `/hack` invocation.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/handoff-worker.ts:354` — both generic framing constants and prompt composition.
- `src/exec-backend.ts:189` — non-empty versus empty capture carrier contract.
- `plugins/plan/skills/hack/SKILL.md:9` — ordinary investigate/confirm workflow and safe static-skill edit surface.
- `plugins/keeper/skills/handoff/SKILL.md:22` — current prefix-owned workflow and captured posture.
- `plugins/keeper/skills/handoff/SKILL.md:84` — current Brief-authoring rules that rely on injected framing.
- `docs/agent-surface-contracts.md:24` — canonical answer envelope and final-message contract.
- `src/db.ts:4620` — host prefix configuration parsing and daemon threading.

**Optional** (reference as needed):
- `plugins/plan/CLAUDE.md:36` — static `/plan:hack` and BAKE-region constraints.
- `scripts/vendor-corpus.ts:174` — byte-verbatim guard for BAKE regions.
- `test/tabs.test.ts:431` — stale capture-carrier overwrite coverage.
- `src/agent/run-capture.ts:380` — canonical envelope constructor and outcome vocabulary.

### Risks

Moving autonomy into a globally used `/hack` skill must key exclusively on a non-empty envelope carrier so foreground and ordinary Handoff sessions do not skip confirmation. Capture failures that happen before the skill can write remain under the existing Handoff lifecycle rather than introducing a new failure-envelope producer. Pi may normalize slash-template arguments after launch; exactness is asserted at `LaunchSpec.prompt` and native argv boundaries, with harness-specific transport tests guarding content fidelity.

### Test notes

Assert exact bytes for ordinary and captured prompts, including multiline Unicode Briefs, leading/trailing whitespace, quotes, dollar signs, backticks, and shell metacharacters. Keep the stored Brief and `handoff show` raw. Add static contract coverage that `/hack` distinguishes non-empty capture carrier from its always-emitted empty form and that caller help contains no generic injected mandate.

## Acceptance

- [ ] Ordinary and captured launches both carry exactly `/hack ` followed by the raw stored Brief at the shared launch boundary, with no other launcher-authored prompt content.
- [ ] A non-empty handoff envelope carrier makes `/hack` complete autonomously and write the canonical terminal envelope; an empty carrier preserves normal inquiry and work-confirmation behavior.
- [ ] Ordinary launches continue to overwrite stale envelope state with an empty carrier, and capture destinations remain out of prompt text and stored Briefs.
- [ ] Handoff caller guidance requires a self-contained mandate and documents Launch triple or paired model/effort selection independently from `--capture`.
- [ ] Prompt-prefix configuration cannot change the `/hack` invariant and gives actionable guidance for unsupported values.
- [ ] Handoff, config, skill-contract, corpus-drift, and focused launch tests pass.

## Done summary
Composed every fresh Handoff prompt as exactly /hack plus the raw stored Brief with no injected framing, keyed /hack's captured autonomy and canonical envelope publication on a non-empty KEEPER_HANDOFF_ENVELOPE carrier alone, made handoff_prompt_prefix a harmless /hack-only compatibility key with actionable guidance for other values, and updated Handoff/hack skill docs plus agent-surface-contracts.md and install.md for caller-owned mandates and capture-independent launch selection.
## Evidence
