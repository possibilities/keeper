## Description

**Size:** M
**Files:** plugins/keeper/skills/watch/SKILL.md, scripts/watch-watchdog.ts

### Approach

Rewrite the keeper:watch operating model, replace-not-augment. New model: orient once (keeper status --json) → arm the wake sources — a persistent harness Monitor on keeper watch --json filtered to the needs-human delta types, the jam alarm (keeper await needs-human, threading since:<signature>, plus drained --fail-on-stuck where the intent is "tell me when it wedges"), the bus inbox already armed — plus the watchdog Monitor → hand back token-free → on any wake, the delta names what to triage; act per the five-rung ladder; re-arm what fired, threading the met envelope's signature into the next since: → hand back; until the human stops the Monitors or the session ends (session-end mortality stated plainly). KEEP intact: the five-rung triage ladder, all guardrails, the attacker-influenced-input rule, rung-5 pilot mode, the sibling-skill delegation model, and the glossary noun discipline ("supervise the board", never bare "watch" as a noun — the glossary binds that noun to the Agent Bus channel). REMOVE: the one-sweep-per-invocation framing and every /loop composition reference — the skill must state that the Monitors ARE the standing watch and layering /loop on top double-arms. Frontmatter: allowed-tools gains Monitor; argument-hint rewritten away from the polling model. The watchdog is a checked-in bun script (scripts/watch-watchdog.ts, matching the scripts/ conventions) the skill's arming sequence launches as a persistent Monitor, passing the EXACT command strings of the sibling monitors it verifies (keeper await monitor-running matches byte-for-byte — generation from the same literals at arm time is the defense against drift). Its loop: verify each sibling via monitor-running, confirm bus presence via keeper bus list, run a keeper status --json sanity sweep for any needs-human row the deltas should have surfaced; emit a line ONLY on anomaly, debounced at two consecutive misses; its own death surfaces as the harness Monitor exit notification — the distinct liveness channel that keeps anomaly-silence from masking watchdog death.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/skills/watch/SKILL.md — the whole current file: the polling framing to replace (:28-37), the ladder to keep (:93-197), the Monitor-liveness section the watchdog subsumes (:206-215), the guardrails to keep (:217-234)
- src/await-conditions.ts:951-957 — monitor-running's exact-match selector semantics (the "SWAP POINT — never substring" comment)
- The final delta type names and await grammar from tasks 3 and 4 (the skill documents their real vocabulary, not the plan's placeholders)
- scripts/drain-dead-letters.ts and scripts/unstick-autopilot.ts — the scripts/ shebang, arg, and output conventions
- CONTEXT.md — the Agent Bus "watch" noun binding and the new needs-human family entries the prose must respect

**Optional** (reference as needed):
- test/lint-skill-ids.test.ts and test/lint-retired-name.test.ts — the gates the rewrite must pass (frontmatter name stays "watch"; no retired vocabulary)

### Risks

- Prose that teaches re-arming without threading the signature anchor recreates the busy-loop the design exists to prevent — the re-arm recipe must be literal, with the exact command shape.
- A watchdog checking command strings that drift one byte from the armed monitors reads every sibling as dead — the skill must generate both from the same literals.

### Test notes

Skill lints (lint-skill-ids, lint-retired-name) green. Watchdog script: run it against a live daemon with a deliberately wrong sibling command string and confirm exactly one debounced anomaly line; run it healthy and confirm silence. Frontmatter parses and allowed-tools includes Monitor.

## Acceptance

- [ ] The skill's operating model is arm-once, event-driven, hand-back: no internal model loop, no /loop composition, Monitors as the standing watch, and a literal re-arm recipe that threads the signature anchor
- [ ] The five-rung triage ladder, guardrails, attacker-influenced-input rule, and pilot mode survive the rewrite intact
- [ ] A checked-in watchdog script verifies sibling watcher liveness and full-state sanity, emits only on debounced anomaly, and the skill wires it into the arming sequence with exact command strings
- [ ] Frontmatter allows the Monitor tool, the skill lint gates pass, and the glossary noun discipline holds throughout

## Done summary
Rewrote keeper:watch to arm-once/event-driven/hand-back over persistent Monitors (needs-human delta tail, umbrella jam alarm with signature re-arm, bus inbox, watchdog); removed the one-sweep/​/loop framing while keeping the five-rung ladder, guardrails, attacker-input rule, and pilot mode intact. Added scripts/watch-watchdog.ts verifying sibling liveness (shared exact-match monitorRunningState), bus presence, and status sanity with debounced anomaly-only emit.
## Evidence
