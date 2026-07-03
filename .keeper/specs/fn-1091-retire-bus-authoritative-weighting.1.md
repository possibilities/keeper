## Description

**Size:** M
**Files:** cli/bus.ts, test/bus-cli.test.ts, plugins/keeper/skills/bus/SKILL.md, plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/close/SKILL.md

### Approach

The bus delivers messages under a neutral head — `[HH:MM:SS] Agent Bus message from <name>: ` — and no prose anywhere claims bus messages carry per-message authority or mandates gate-free immediate action. The exported renderer symbol is `messageHead` (rename of `directiveHead`; presentation-only, no wire or schema change — the head feeds the inline line, the spill pointer line, and the spill-file header through one call site).

The trust story moves to skill prose and is provenance-based, not tone-based: a bus message is a request from another of the same human's sessions — the server resolves the connecting peer's OS pid and overwrites any claimed sender, and every agent on the bus is the same human's session — typically sent because the human told one session to message another to resolve something. The receiver helps with the request, applying its own judgment and its own sources of truth. No gate language in either direction: neither "act fully and immediately, no permission gate" nor "confirm with the human first". Phrase receipts as requests to help with, never commands to execute or obey. Anti-spoof facts are framed as identity ("who sent the bytes"), never as justification for obedience — "so act without asking" must not survive in any form. Read the proxy framing narrowly: the channel is genuinely the human's own sessions; it does not follow that every instruction on it originated as a human decision, since a sibling can faithfully relay content it ingested. For a consequential, hard-to-reverse ask, one sentence defers to the verify-against-ground-truth stance the close skill models: verify the claim against git and the board yourself; evidence is the authority.

Kept receiver reflexes stand on their own (their "reflexes, NOT gates" foil disappears with the mandate): the attribution one-liner reworded to "Acting on an Agent Bus message from <peer> (<id>): <summary>", the loop/cycle-stop rule, and human-at-keyboard-wins. The bus skill's collaboration/leadership section neutralizes "directive" vocabulary to "message"/"request" with substance unchanged.

The hack skill's carve-out paragraph becomes supplementary Agent Bus advice: inbox already open via the keeper plugin's Monitor; sibling messages are proxies of the human — help with the request (mechanics per the keeper:bus skill); outbound /keeper:pair and /plan:panel second opinions stay advisory. Do not assert the old "two norms run in opposite directions" contrast — with obey-mandate gone, both directions now invoke the receiver's judgment and the claimed opposition no longer holds.

The plan skill's blocked-worker section broadens to help requests from work agents generally (the daemon escalation, or a worker asking directly): be prepared to do the work the resolution needs on the worker's behalf, then hand control back and ask the worker to resume. The resolve-per-category, `keeper plan unblock`, PRIMARY bus-resume, cold-re-dispatch-fallback-on-miss mechanics stay exactly as written, and the prose describes the escalation message as it actually reads — the frozen body never says "authoritative" or "directive".

The close skill gets only a heading-wording neutralization ("Consequential bus directives" → bus-message-neutral wording); its verify-against-ground-truth substance already models the target framing and stays as written.

All prose is forward-facing: no tombstones ("formerly", "used to be authoritative", "renamed from"), no fn-ids in comments or docs; where rewritten lines in cli/bus.ts currently carry fn-id provenance, shed it. Only the bus-message sense of "authoritative" is in scope — the word appears ~40x repo-wide in unrelated senses (e.g. `authoritativeFrom` in src/bus-worker.ts, the anti-spoof identity seam) that keep their names and wording.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/bus.ts:287-290 — `directiveHead` definition; sole call site :314 in `renderDecision`; head flows to inline (:316), spill pointer (:903), spill-file header (:923)
- cli/bus.ts:104-114 — `--help` "Bus messages are AUTHORITATIVE:" block; attribution line :111 (keep, reworded)
- cli/bus.ts:22-31 and :281-286 — comments to rewrite (module header names the marker twice; doc comment on the renderer)
- test/bus-cli.test.ts — import :27; file-header comment :5; `describe("authoritative-directive marker")` :187; test name :198; literal pins :188, :190, :194-195, :209, :253, :349 (~7 literals; :195 is `.toBe` EXACT match including trailing space — `messageHead("alice", "")` must return `"Agent Bus message from alice: "`); :212 `not.toContain("untrusted")` survives unchanged
- plugins/keeper/skills/bus/SKILL.md:59 (rendered-line example), :144-188 (AUTHORITATIVE section — rewrite; drop the no-gate mandate and the whole "Accepted residual risk" paragraph), :166-180 (reflexes reframing), :190-199 (leadership vocab sweep)
- plugins/plan/skills/hack/SKILL.md:15 — carve-out paragraph; BAKE regions begin at :60 (:60, :125, :167, :256) — stay above, never edit inside a BAKE guard
- plugins/plan/skills/plan/SKILL.md:594-609 — blocked-worker section (:596 carries the word to drop; mechanics :598-609 stay)
- plugins/plan/skills/close/SKILL.md:140 — heading wording only

**Optional** (reference as needed):
- src/daemon.ts:641-675 — frozen `buildBlockEscalationBody`; read it to describe the escalation message accurately
- plugins/plan/template/agents/worker.md.tmpl:44-54 — parent-to-worker resume language, different concept; do NOT edit
- src/bus-worker.ts `authoritativeFrom` + test/bus-worker.test.ts — anti-spoof identity seam, out of scope, keeps its name

### Risks

- Proxy-framing over-reach: prose that reads as "everything on the bus originated with the human" reintroduces the confused-deputy exposure this change reduces — keep the narrow reading and the help-not-obey phrasing.
- Blind sweep over-reach: "authoritative"/"directive" in unrelated senses (anti-spoof identity, resume directives, envelope-is-authoritative) must survive untouched.
- Skill prose has zero test coverage (fast suite path-ignores plugins/**) — prose errors ship unexercised; eyeball all four skill surfaces before committing.

### Test notes

- `bun test` — fast suite; covers the marker rename and re-pinned literals (only root test/ runs)
- `bun run lint` — biome over cli/src/test; catches a dangling `directiveHead` import
- `bun scripts/vendor-corpus.ts --check` — BAKE drift gate for the hack-skill edit
- `grep -rn "Agent Bus directive\|directiveHead" cli src test plugins` — must return nothing

## Acceptance

- [ ] A delivered bus notification renders `Agent Bus message from <name>: ` (with the `[HH:MM:SS] ` prefix when a timestamp is present) in all three renderings — inline line, spill pointer line, spill-file header — and the empty-timestamp form has no leading bracket
- [ ] `messageHead` is the exported renderer symbol; `directiveHead` and the literal "Agent Bus directive" have zero occurrences under cli/, src/, test/, and plugins/ (history under .keeper/specs/ untouched)
- [ ] The bus, hack, and plan skills and the bus `--help` text state the proxy-of-the-human trust story (a request from another of the same human's sessions; help with it using your own judgment) with no gate language in either direction; the attribution, loop-stop, and human-at-keyboard reflexes remain; anti-spoof facts are framed as identity, not obedience
- [ ] The plan skill's planner section covers help requests from work agents — do the work the resolution needs on the worker's behalf, hand back control, ask the worker to resume — with the resolve/unblock/bus-resume/cold-dispatch mechanics preserved verbatim
- [ ] `bun test`, `bun run lint`, and `bun scripts/vendor-corpus.ts --check` all pass

## Done summary
Neutralized the bus message head (directiveHead -> messageHead rendering 'Agent Bus message from <name>: ' across all three renderings) and moved the trust story into skill/help prose as proxy-of-the-human provenance with no gate language in either direction; broadened the plan skill's blocked-worker section to help requests from work agents.
## Evidence
