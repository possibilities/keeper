## Description

**Size:** M
**Files:** plugins/keeper/skills/handoff/SKILL.md, plugins/keeper/skills/autopilot/SKILL.md, plugins/keeper/skills/await/SKILL.md, plugins/keeper/skills/watch/SKILL.md, plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/orient.md.tmpl, README.md, docs/install.md, docs/adr/0097-sidecar-backed-dynamic-usage-viewer.md, docs/adr/0100-independent-scoped-account-focus.md

### Approach

Enforce the accepted human/machine boundary in every advice surface. Agent orientation and inspection use `keeper status --json`, `keeper query ... --json`, and `keeper autopilot show`; rendered-change supervision uses one bounded `keeper frames` chunk. Remove guidance that calls Board, Jobs, Git, Autopilot, Usage, snapshots, sidecars, or `--watch` as agent interfaces, including euphemisms such as a “TUI snapshot dance.” Keep explicit Autopilot control verbs because those are machine operations, not viewer inspection.

Reframe Watch hyper mode as consuming the machine Frames protocol rather than knowing about or launching TUIs. Update human-facing README/install material for Board versus Summary, deterministic YAML surfaces, scrolling-only interaction, six named windows, and the destructive setup refresh. Cross-link accepted ADR clauses to ADR 0104 without erasing their rationale.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/skills/handoff/SKILL.md:191 — agent inspection currently recommends live Board.
- plugins/keeper/skills/autopilot/SKILL.md:93 — status/show guidance plus a dispatch-log snapshot recommendation.
- plugins/keeper/skills/await/SKILL.md:112 — monitor pre-check currently uses a Jobs snapshot.
- plugins/keeper/skills/watch/SKILL.md:377 — Frames consumer described in TUI terms.
- plugins/prompt/corpus/claude/arthack/template/_partials/snippets/engineering/orient.md.tmpl:12 — canonical one-shot status advice and TUI comparison wording.
- README.md:12 — front-door status/Board command summary.
- docs/install.md:131 — Account-focus and Usage/Board operator documentation.
- docs/install.md:196 — setup/viewer invocation guidance.
- docs/adr/0097-sidecar-backed-dynamic-usage-viewer.md:33 — human history clause superseded by ADR 0104.
- docs/adr/0100-independent-scoped-account-focus.md:43 — Board-owned focus presentation clause superseded by Summary.

**Optional** (reference as needed):
- docs/adr/0104-latest-frame-human-viewers.md — authoritative boundary and vocabulary.
- cli/frames.ts:76 — bounded Frames grammar and agent help.
- cli/status.ts:1 — machine one-read orientation surface.

### Risks

Blanket removal of `keeper autopilot` would break legitimate control guidance; distinguish viewer inspection from explicit control/show verbs. Watch still needs view names to select Frames streams but should not imply TTY invocation or sidecar scraping. Human docs may name viewers while agent-audience snippets must not.

### Test notes

Render affected prompt/skill surfaces through their canonical checks, search agent-audience sources for prohibited snapshot/viewer advice, and keep exact bounded Frames examples. Run prompt oracle/catalog consistency, skill frontmatter/size checks, source/docs lint, and README/install link checks through named gates.

### Detailed phases

1. Replace handoff, autopilot, and await inspection recipes with query/show/Frames equivalents.
2. Reframe Watch around bounded machine frame streams and remove TUI vocabulary.
3. Tighten the shared orient snippet and regenerate only owned prompt derivatives if required.
4. Consolidate README/install dashboard documentation and ADR cross-links.
5. Run targeted searches and named prompt/keeper validation gates.

### Alternatives

Keeping snapshot advice with a warning not to use `--watch` is rejected because agents would still depend on a human surface. Removing all viewer mentions from human installation docs is also rejected; the boundary is audience-specific, not secrecy.

### Non-functional targets

Agent recipes are bounded, parseable, noninteractive, and use one authoritative interface per need. Documentation stays forward-facing and prunes obsolete pane/key/history prose rather than appending parallel explanations.

### Rollout

Advice changes land after command behavior so no rendered prompt advertises an unavailable machine path. No generated artifact is rewritten unless its canonical source check requires it.

## Acceptance

- [ ] Agent-facing skills and prompt snippets never direct agents to invoke Board, Jobs, Git, Autopilot viewer mode, Usage, viewer snapshots, viewer sidecars, or `--watch` for inspection.
- [ ] Agent one-shot inspection recipes use status/query/autopilot-show envelopes, and rendered-change recipes use bounded `keeper frames` invocations with no internal follow loop.
- [ ] Legitimate Autopilot mutation/show commands remain documented and are not confused with its human viewer mode.
- [ ] README and install docs accurately describe Board versus Summary, scrolling-only latest-frame behavior, six named windows, preserved Dash, and Frames as the machine surface without duplicating stale setup prose.
- [ ] ADR 0097 and ADR 0100 point to ADR 0104 for their superseded presentation clauses while preserving the original decisions.
- [ ] Prompt, skill, docs, and repository lint/check gates pass, and a targeted search finds no prohibited agent-viewer advice.

## Done summary

## Evidence
