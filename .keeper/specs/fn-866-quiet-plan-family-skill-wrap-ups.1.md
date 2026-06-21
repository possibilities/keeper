## Description

**Size:** M
**Files:** plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/defer/SKILL.md, plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/close/SKILL.md, plugins/plan/template/skills/work.md.tmpl, plugins/plan/skills/work/SKILL.md (regenerated), plugins/plan/skills/work/SKILL.md.managed-file-dont-edit (regenerated), plugins/plan/CLAUDE.md

### Approach

Forward-facing prose edits making the plan-family wrap-ups silent by default. Six concerns: (1) never offer `/plan:work`; (2) hack awaits silence-by-default; (3) new hack "close-signal"; (4) `/plan:next` only in defer context; (5) drop the plan Phase 8 trailing menu; (6) strip manual-followup framing from work/close. Edit `hack/defer/plan/close` SKILL.md directly. For `work`, edit the TEMPLATE `work.md.tmpl` and re-render — never the rendered file. Then sync `plugins/plan/CLAUDE.md`. Verify with the plan-plugin test suite.

No tombstones (forward-facing-advice rule). Do NOT remove the mechanism-description `/plan:work` mentions at `plan/SKILL.md:372` and `work.md.tmpl:130,167`. For `/plan:next`, remove ONLY the plan-decision-time parenthetical at `plan/SKILL.md:327`; KEEP `plan/SKILL.md:338`, `hack/SKILL.md:153`, `defer/SKILL.md:191`.

THE EDITS:

A) hack/SKILL.md — replace the await section (currently ~lines 179-189, header "### After an epic lands, arm an await when a follow-up earns it") with:

```
### After an epic lands, the session goes quiet by default

Scaffolding an epic — via `/plan:plan` or `/plan:defer` — normally ends the visible session. Keeper's autopilot dispatches and completes all plan work on its own; **the agent is left in the dark about execution by design.** Once the epic lands, the wrap-up is the plan skill's own one-line report and nothing more — no description of how the work runs, and **never an offer to run `/plan:work`** (or any "run it when ready" prompt). The agent plans; it does not start, drive, or close the work.

The one optional move is arming an await — and it stays silent unless the conversation earns it. `keeper:await` blocks on board state (epic or task complete, or unblocked) then runs a follow-up action.

- **Positive call** — the human used wait-then-act phrasing anywhere in the conversation ("circle back", "wait for followup", "check back after the epic lands", "ping me when it's done") → that's the directive: arm `keeper:await` with the condition (`complete fn-N-slug[.M]`) and the follow-up action spelled out. No confirmation beat — just a one-or-two-sentence note on what it watches and what fires.
- **Ambiguous** — a follow-up was genuinely discussed (a phase-2 plan gated on this epic, a verification pass you raised) but the human never asked to wait → collaborate: ask one short plain-text question whether to arm it. Don't self-arm a follow-up the human didn't request.
- **Neither** → silent. No "nothing worth awaiting" narration, no generic "want me to wait?", no raising the await topic at all — an idle await is noise, and so is talking about not arming one. This is the common case; deferred epics bias hard this way.

Daisy-chain: plan the first epic, await its completion while autopilot runs the work, then plan the next phase from what landed — one session driving several plan rounds without the human re-priming context. Each round re-runs the same check before arming the next; when in doubt, stay silent and hand back.
```

B) hack/SKILL.md — insert a NEW subsection immediately after (A):

```
### Always check the session is done — speak only to close it

At the end of any flow that did real work or landed an epic — and any other point where the human might reasonably wonder whether you're finished — silently answer one question: *is there anything left in this conversation to accomplish or revisit, now or when the epic completes?* This runs every time; it is an internal check, not a prompt. (After a self-evidently-complete trivial answer, the answer is its own close-signal — stay silent.)

- **Something is left** — an armed await, an unanswered sub-thread, a side-ask the human raised and you haven't closed, a follow-up the conversation implies → stay quiet about closing. The await note above, or the work itself, already carries the "more is coming" signal; don't pile "still some things to do" narration on top.
- **Nothing is left** — the inquiry is fully answered, any epic is scaffolded, no await is armed or pending, nothing the human raised is dangling → say so in one short sentence so the human never has to ask: *"That's everything from this thread — clear to close the session whenever you like."* Nothing more.

Never ask "anything else?" or "should I close?" — answering that for the human is the whole point. An armed await means something IS pending, so it and the close-signal never fire together.
```

C) defer/SKILL.md:
- :14 — replace trailing sentence "Running the task is a separate `/plan:work <task_id>` call by the human." with "Running the work is autopilot's job, not this skill's." (keep the earlier "not `/plan:work`" family distinction in the same line)
- :176 — replace with: > *deferred `<epic_id>` (queue_jump=false): <epic title> — sorts in normal epic_number order; autopilot runs it when it reaches the front of the board.*
- :178 — replace with: No menu, no follow-up prompts, no epic close. Autopilot runs the task — never offer `/plan:work`.
- :186 — replace with: - **Not a job-launcher.** This skill does not spawn a worker, run an audit, or close the epic — autopilot runs the task. Never offer `/plan:work`.
- :191 — /plan:next mention STAYS, no change.

D) plan/SKILL.md:
- :600 — drop the trailing read-only menu: "Omit the `ran {}` side if zero ran; omit `skipped {}` if none were skipped. No menu, no follow-up prompts."
- :327 — drop ONLY the `/plan:next` parenthetical: "...I can skip the epic entirely and just commit, defer it as a single-task epic at normal sort order for later, or write the full epic + task now if you'd rather have the planctl trail." (keep the rest of the sentence and the rest of the Phase 4 block intact, including :338)

E) work.md.tmpl (the TEMPLATE — then re-render):
- Replace "**Do NOT close the epic** — `keeper plan epic close` stays the human's call." with "**Do NOT close the epic** — the orchestrator never closes; closing is a separate automated step." and drop "the human resolves and re-runs `/plan:work`," from the same line so it reads "...(Phase 2b's BLOCKED short-circuit catches it); the resume path picks up via the non-`done` verdict." KEEP the BLOCKED/TOOLING_FAILURE mechanism.
- Replace "**Never auto-closes the epic** — `keeper plan epic close` stays the human's call." with "**Never auto-closes the epic** — closing runs through the separate, automated `/plan:close` audit, never this orchestrator."
- Sweep the template for any remaining "stays the human's call" / "the human re-runs"-style attribution framing on the happy path and reword similarly. PRESERVE the never-close invariant, all error-path surfacing ("surface verbatim and stop", AMBIGUOUS_*_ID disambiguation re-run hints, BLOCKED short-circuits), and the internal resume re-run mentions (130/167).
- Then re-render: `promptctl render-plugin-templates` (project root = the plan plugin). The rendered `work/SKILL.md` and its `.managed-file-dont-edit` sidecar sha must update together.

F) close/SKILL.md:
- :178 — replace with: - **No closer-driven worker dispatch** — surviving findings become tasks in the planner's scaffolded follow-up epic, dispatched by autopilot like any other ready work.
- :180 — drop "the human re-runs": "...surface verbatim and stop — `close-finalize` is idempotent, so a re-run is safe."

G) plugins/plan/CLAUDE.md — "Skills and agents" section (~:32-34): revise in place (no new paragraph, forward-facing) so the `/plan:hack` routing description reflects the silence-by-default wrap-up + always-on close-signal, and `/plan:next` is described as defer-context-scoped.

H) README.md await section (~:1138-1197): verify only — trim a sentence ONLY if it makes a skill-behavior claim that now conflates the `keeper await` CLI with the skill. Likely CLI-only; probably no change.

### Investigation targets

**Required** (read before editing):
- plugins/plan/skills/hack/SKILL.md:179-189 — the await section to replace; the close-signal is new, inserted after.
- plugins/plan/template/skills/work.md.tmpl — edit here, NOT work/SKILL.md; find the "human's call" / "human re-runs" lines.
- plugins/plan/skills/work/SKILL.md.managed-file-dont-edit — the sha sidecar (do not hand-edit; it updates on re-render).
- plugins/plan/test/consistency-skills.test.ts — read the CLOSE_SKILL `.toContain` assertion (~:262) before editing close/SKILL.md so the edit doesn't drop a required string.
- plugins/plan/test/consistency-generated-guard.test.ts — the generated/sidecar sha contract.
- plugins/plan/CLAUDE.md:32-34 — the doc to sync; and its `## Doc & comment style` for the forward-facing rule.

**Optional**:
- plugins/plan/skills/plan/SKILL.md:327,338,372,600 — confirm which to edit vs leave.
- plugins/plan/skills/defer/SKILL.md:14,176,178,186,191.

### Risks

- **work/SKILL.md is generated** — editing it directly breaks `consistency-generated-guard.test.ts`. Edit `work.md.tmpl` and re-render; verify the sidecar sha and the guard test.
- **Over-scrubbing** — `plan:372` and `work.md.tmpl:130,167` are mechanism descriptions, not offers; removing them is a defect.
- **Tombstones** — forward-facing-advice rule applies to all touched prose; do not write "we no longer offer X".
- **/plan:next scope** — remove only `plan:327`'s parenthetical; the other three mentions are legitimate defer-context.

### Test notes

- Run `cd /Users/mike/code/keeper/plugins/plan && bun test` (fast tier) — `consistency-skills.test.ts` and `consistency-generated-guard.test.ts` are the gating guards.
- This is plan-plugin prose/template only (no daemon/db/hook/git process paths), so the keeper-root `test:full` gate does not apply; the plan-plugin `bun test` is the relevant gate.

## Acceptance

- [ ] No human-facing wrap-up offers `/plan:work` (defer:14/176/178/186 reworded; hack await section rewritten); `plan:372` and `work.md.tmpl:130,167` mechanism mentions untouched.
- [ ] hack/SKILL.md await section rewritten silence-by-default (arm on positive call, ask when ambiguous, else silent) AND the new "close-signal" subsection added, both verbatim per (A)/(B).
- [ ] `/plan:next` recommended only in defer context: `plan:327` parenthetical removed; `plan:338`, `hack:153`, `defer:191` unchanged.
- [ ] `plan/SKILL.md:600` trailing read-only verb menu removed (ends "No menu, no follow-up prompts.").
- [ ] work template reworded (never-close invariant + error-path surfacing preserved) and `work/SKILL.md` re-rendered via `promptctl render-plugin-templates`; sidecar sha updated; `consistency-generated-guard` passes. close/SKILL.md:178,180 reworded.
- [ ] `plugins/plan/CLAUDE.md` "Skills and agents" synced (forward-facing, in place); README await prose verified (trimmed only if it makes a conflated skill-behavior claim).
- [ ] `cd plugins/plan && bun test` is green.

## Done summary
Made plan-family skill wrap-ups silent by default: no /plan:work offers, hack silence-by-default awaits + always-on close-signal, defer-scoped /plan:next, plan Phase 8 menu dropped, work template human-call framing reworded (never-close invariant preserved, re-rendered). plan-plugin CLAUDE.md synced; README await section verified CLI-only.
## Evidence
