## Description

**Size:** M
**Files:** plugins/keeper/skills/handoff/SKILL.md, README.md, CLAUDE.md, ~/.config/keeper/config.yaml

### Approach

Ship the human-facing wrapper + bring docs to current. New
`plugins/keeper/skills/handoff/SKILL.md` modeled on
`plugins/keeper/skills/dispatch/SKILL.md` (frontmatter: name, description with
trigger phrases "hand this off" / "hand off this work" / "spawn someone to
investigate", allowed-tools: Bash, argument-hint): the skill gathers the
contextful doc + instructions + a title, calls `keeper handoff` ONCE, and reports
the `handoff_id` + target session + how to inspect (`keeper board` /
`keeper handoff show`). It does NOT use keeper bus and does NOT start monitors.
Set `handoff_prompt_prefix: "/hack "` in `~/.config/keeper/config.yaml`
(resolveConfigPath) so handoffs on this machine boot into `/hack`. README updates
(forward-facing): six-surface RPC invariant (was five) + `request_handoff` in the
list; worker roster count (+1 — find BOTH occurrences of "thirteen"); config-key
catalogue gains `handoff_prompt_prefix` after `dispatch_prompt_prefix`; a v-NN
schema-history entry; the board-render narrative gains the handoff relationship
line; clarify `handoff::` is a SEPARATE spawn-name class (NOT a plan_verb — do
NOT widen the {plan,work,close} whitelist). CLAUDE.md / AGENTS.md: MINIMAL edit
(the "five surfaces"→"six" count line + `request_handoff`) — this lands AFTER
fn-943's strip and must fit the ≤120-line / ≤16KB linter gate
(`scripts/lint-claude-md.ts` wired into `keeper commit-work`), so keep the
CLAUDE.md delta to the surface-count line and put all richer prose in README.
Forward-facing advice only (no change history in comments/docs).

### Investigation targets

**Required** (read before coding):
- plugins/keeper/skills/dispatch/SKILL.md — the skill template (frontmatter + body shape)
- README.md — RPC-surface invariant (~:271,285-288,311-312,1132), worker roster ("thirteen" ×2 ~:3292), config catalogue (~:431), spawn-name whitelist (~:17-18,344,2691), board-render narrative (~:809,953,1187)
- CLAUDE.md — "five surfaces" lines (~:311-313, 320-322); MINIMAL edit only
- src/db.ts:183-189 — resolveConfigPath (where ~/.config/keeper/config.yaml lives)

**Optional** (reference as needed):
- plugins/keeper/skills/{await,bus,pair}/SKILL.md — description-style patterns

### Risks

- fn-943 strips CLAUDE.md + installs the line/byte linter into commit-work — this task MUST land after fn-943 (dep wired) and keep the CLAUDE.md delta minimal or commit-work rejects it.
- The {plan,work,close} whitelist is for plan_verb; handoff:: is separate — do NOT widen it in code or docs.
- ~/.config/keeper/config.yaml is machine-local (not in git) — the config edit is an operator action, not a committed change.

### Test notes

- No automated test for the skill markdown; verify `keeper handoff --help` / the skill description renders.
- Confirm `keeper commit-work` passes the CLAUDE.md linter gate after the edit.

## Acceptance

- [ ] plugins/keeper/skills/handoff/SKILL.md created (modeled on dispatch), triggers on "hand this off"
- [ ] handoff_prompt_prefix: "/hack " set in ~/.config/keeper/config.yaml; an unprefixed handoff boots into /hack
- [ ] README updated: six-surface invariant + request_handoff, worker count, config catalogue, schema history, board narrative, handoff:: clarified as a separate spawn class
- [ ] CLAUDE.md minimal surface-count edit, passes the ≤120-line linter gate
- [ ] test:full green; keeper commit-work succeeds

## Done summary
Added keeper:handoff skill (modeled on dispatch) plus set handoff_prompt_prefix in machine-local config; brought README + CLAUDE.md current (six-surface RPC + request_handoff, worker roster, config catalogue, v87/v88 schema history, board narrative, handoff:: spawn class).
## Evidence
