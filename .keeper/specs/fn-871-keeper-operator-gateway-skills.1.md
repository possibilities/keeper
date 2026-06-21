## Description

**Size:** M
**Files:** plugins/keeper/skills/dispatch/SKILL.md (new)

### Approach

Author a new gateway skill mirroring `plugins/keeper/skills/await/SKILL.md`
section-for-section: YAML frontmatter (`name: dispatch`; a `>-` folded
`description` opening with an imperative + a "Use when..." trigger + near-miss
exclusions; `allowed-tools: Bash`; `disable-model-invocation: true` as the last
frontmatter line; an `argument-hint`) -> `# dispatch` -> intro -> `## When this
fires` -> `## Parse the request` (intent->command TABLE) -> `## Step` procedures
-> `## Examples` -> `## What NOT to do` -> `## Guardrails`.

`keeper:dispatch` is a ONE-SHOT Bash call (optionally `--dry-run` first), NOT a
Monitor (dispatch has no snapshot/keeper-meta mode). Map intents: plan form
("fire a worker on fn-N.M", "spawn a closer for fn-N") -> `keeper dispatch
work::fn-N.M` / `close::fn-N`; free form ("run this one-off prompt in a worker")
-> `--prompt` / `--prompt-file`. The two forms are mutually exclusive. Teach a
pre-check (`keeper plan show <id>` or a board read) before a plan-form launch to
avoid a doomed dispatch. Document `--dry-run` (previews session/cwd/key/argv),
the session/cwd/model/effort flags, and the exit taxonomy: exit 1 =
resolution/launch failure (distinguish unknown-id text from daemon-unreachable
text); exit 2 = arg fault, including the 96KB/NUL prompt cap -> route large
prompts to `--prompt-file`.

### Investigation targets

**Required** (read before writing):
- plugins/keeper/skills/await/SKILL.md — exact structural template (frontmatter, Parse-the-request table, Steps, Examples, What NOT to do)
- cli/dispatch.ts:94 — HELP block (canonical flag list)
- cli/dispatch.ts:344 — plan-form vs free-form mutual exclusion
- cli/dispatch.ts:216 — checkRaceGuard; :230 the unpaused refusal text
- cli/dispatch.ts:458 — `--dry-run` output shape; :478 success line; :126/:131 exit taxonomy

**Optional**:
- cli/dispatch.ts:152 — resolvePlanCwd error text (unknown-id vs no-task vs empty-cwd vs daemon-unreachable)
- cli/dispatch.ts:16 — free-form `--name` caveat (pass-through, not a keeper label)

### Risks

- Over-trigger vs `/plan:work` and vs `keeper:autopilot` — the description's near-miss exclusions must scope OUT routine plan execution and autopilot-retry. "approve fn-X" is NOT a dispatch (it is `autopilot retry approve::`).
- The race-guard refusal (autopilot unpaused) is the most likely failure. Per the committed decision the skill SURFACES the refusal and ASKS (pause via `keeper:autopilot` then retry, or `--force`) — it NEVER auto-pauses. `--force` is human-gated, never a skill default.
- Free-form `--name` is a pure claude pass-through, NOT a keeper label; warn against a `verb::id`-shaped `--name` (it still binds via the SessionStart scrape).

### Test notes

No automated gate (plugins/** excluded from `bun test`; not linted). Validate by
running `keeper dispatch --dry-run work::<a real board id>` and confirming the
skill's documented output shape matches. Confirm the frontmatter parses by
mirroring await's exactly.

## Acceptance

- [ ] plugins/keeper/skills/dispatch/SKILL.md exists, slash-only (`disable-model-invocation: true`), mirrors await's section structure
- [ ] intent->command table covers plan form (`work::`/`close::`) and free form (`--prompt`/`--prompt-file`), documented as mutually exclusive
- [ ] documents the pre-check, `--dry-run`, the exit taxonomy (1 vs 2; unknown-id vs daemon-unreachable), and the 96KB/NUL cap -> `--prompt-file`
- [ ] race-guard refusal branch = surface-and-ask, never auto-pause; `--force` human-gated
- [ ] description carries near-miss exclusions (vs `/plan:work`, vs `keeper:autopilot`); free-form `--name` caveat documented
- [ ] no Monitor wrapping (one-shot Bash); no plugin manifest or hooks.json edits

## Done summary

## Evidence
