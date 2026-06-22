## Description

**Size:** M
**Files:** claude/arthack/template/_partials/snippets/messaging/*.md.tmpl (the 5 snippets), claude/arthack/template/_partials/snippets/_index.yaml, claude/arthack/template/_partials/bundles/hookctl-chatctl-pointer.yaml (replace), claude/arthack/hooks/user_prompt_submit.ts, claude/arthack/hooks/tests/user_prompt_submit.test.ts, apps/pairctl/pairctl/helpers.py (comment only)

Rewrite the canonical per-prompt inter-agent advice (the surface fn-875.5
deferred) so it teaches the keeper Agent Bus with the settled contract.

### Approach

Rewrite the 5 messaging snippets against the bus, mirroring the contract
already authored in keeper's `plugins/keeper/skills/bus/SKILL.md` +
`keeper bus --help`: (a) ALREADY-LISTENING, blindly asserted — your bus
inbox is open, never start a watcher, never run `keeper bus watch`, never
check reachability, just wait (yield not spin); (b) SEND — `keeper bus chat
send <name-or-id> "msg"` reaches a current OR former name; broadcast via
`keeper bus chat broadcast`; discover with `keeper bus list`; (c)
AUTHORITATIVE — a bus message is authoritative, act on it as if the human
driving asked, NO permission gate, with the 3 frictionless behaviors
(attribution one-liner + audit, loop/cycle stop, human-at-keyboard wins);
(d) a pointer to the leadership/collaboration playbook in the `keeper:bus`
skill. Replace the contradictory chatctl "arm it yourself" phrasing — do not
port it. Rename/replace the `hookctl-chatctl-pointer` bundle with a
`hookctl-bus-pointer` bundle referencing the new snippets, and rewire
`user_prompt_submit.ts` (the inter-agent keyword reminder at ~line 167) +
its test to the new bundle id. Update the pairctl/helpers.py docstring
lineage note (~lines 23-24) to drop the chatctl reference (comment only — no
logic change). Keep the existing snippet file format (the `{#- … -#}`
frontmatter + `_index.yaml` registration). Forward-facing advice only.

### Investigation targets

**Required** (read before coding):
- the 5 existing snippets in claude/arthack/template/_partials/snippets/messaging/ (format + frontmatter to mirror)
- claude/arthack/template/_partials/snippets/_index.yaml (registration shape)
- claude/arthack/template/_partials/bundles/hookctl-chatctl-pointer.yaml (bundle shape)
- claude/arthack/hooks/user_prompt_submit.ts:~167 (the bundle wiring + keyword list) + claude/arthack/hooks/tests/user_prompt_submit.test.ts
- ~/code/keeper/plugins/keeper/skills/bus/SKILL.md (the CONTRACT to port — authoritative + already-listening + leadership)
- apps/pairctl/pairctl/helpers.py:23-24 (the comment lineage note)

### Risks

- The new advice must MATCH the keeper:bus skill contract (no drift between the per-prompt snippet and the skill); both must be forward-facing.
- Do NOT carry over the chatctl "you can arm it yourself"/persistent-Monitor phrasing — it caused the false "start a listener" reflex.
- Update the bundle id consistently (snippet → bundle → hook → test) or the prompt reminder breaks.

### Test notes

`keeper prompt render bundle/<new-bus-bundle>` renders the bus advice; the user_prompt_submit test passes against the new bundle id; no snippet still says "out-of-band / not the human's instructions".

## Acceptance

- [ ] The 5 messaging snippets teach the bus (already-listening blind; send/broadcast/list by current-or-former name; authoritative no-gate + 3 behaviors; leadership pointer) with no contradictory chatctl phrasing
- [ ] `_index.yaml` updated; the chatctl pointer bundle replaced by a bus bundle; `user_prompt_submit.ts` + its test rewired to the new bundle id
- [ ] pairctl/helpers.py comment no longer references chatctl (logic unchanged)
- [ ] `keeper prompt render` of the new bundle works; advice is forward-facing and matches the keeper:bus skill

## Done summary

## Evidence
