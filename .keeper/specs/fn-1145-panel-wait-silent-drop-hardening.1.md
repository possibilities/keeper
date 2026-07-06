## Description

**Size:** S
**Files:** plugins/plan/agents/panel-runner.md, plugins/plan/test/consistency-skills.test.ts

### Approach

The runner's Step 3 wait discipline becomes: each `keeper agent panel wait --chunk 540` invocation is its own Bash tool call carrying the explicit tool parameter `timeout: 600000` (the Bash tool's per-call ceiling; its default foreground window is 120000ms and a longer-running call is auto-backgrounded). Exit 124 means issue the next chunk as a new Bash call, counting re-issues against a backstop of 6 held in the runner's own reasoning — shell variables do not survive across Bash calls, so the current single-call `while` loop cannot run more than one chunk and its prose ("you never re-invoke yourself between chunks") is corrected to the per-chunk re-issue model. The auto-background envelope ("Command running in background with ID ..." in place of the command's stdout) is a tripwire: immediately re-issue the blocking wait — the notify-on-completion contract never fires for the runner, and ending the turn while legs are non-terminal is the one forbidden move (echo the house wording of worker.md.tmpl:248, "never end a turn text-only to wait"; the consistency test forbids the exact phrase "never in a subagent"). Tripwire re-issues count against the same backstop, so a wedged run still terminates in PANEL_RUN_FAILED, never an infinite loop. Step 6 gains a positive success marker: the runner returns `PANEL_ANSWER` as its first line followed by the judge's fused answer verbatim from the next line — the marker is what makes the caller's two-shape contract checkable, and callers strip it before absorbing. Correct the claim that a 540s chunk is "safely under Bash's hard 10-min single-call cap": the 10-minute window exists only when the call passes `timeout: 600000`; chunk 540 then leaves ~60s of return-latency headroom. Keep the tool-parameter timeout visibly distinct from the standing ban on shelling `timeout`/`gtimeout` (missing binaries on macOS). Forward-facing prose only; frontmatter unchanged (disallowedTools keeps Monitor, never gains Task). Add consistency-skills.test.ts assertions pinning the new prose: the wait example names the `timeout: 600000` tool parameter, the tripwire section exists, and Step 6 defines the PANEL_ANSWER marker.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/agents/panel-runner.md:124-148 — Step 3 wait loop being reframed to one call per chunk
- plugins/plan/agents/panel-runner.md:126 — the false timeout-safety claim
- plugins/plan/agents/panel-runner.md:31-39 — "Why blocking Bash, not Monitor": the token-free rationale and the model-level-polling ban must be reconciled with sanctioned per-chunk re-issues (the ban on tight polling stays)
- plugins/plan/agents/panel-runner.md:212-217 — Step 6 return, where the PANEL_ANSWER marker lands
- plugins/plan/test/consistency-skills.test.ts:456-510 — existing panel assertions: PANEL_RUN_FAILED literal, frontmatter disallowedTools, forbidden phrase

**Optional** (reference as needed):
- plugins/plan/template/agents/worker.md.tmpl:248 — house wording for the never-idle-wait rule
- plugins/plan/agents/panel-runner.md:104-122 — re-entry idempotency the tripwire cites; the machine-rebooted re-issue path is the tripwire's sibling shape

### Risks

- fn-1142 task .8 rewrites the same wait invocations (`--dir` to `--run-dir`, hard cutover); write examples in whichever spelling is live at land time and keep exit-124 semantics consistent (epic dep wired)
- Over-editing: the independence and judge mechanics are correct as written — scope edits to Step 3, Step 6, and the timeout claims

### Test notes

`bun test plugins/plan/test/consistency-skills.test.ts` green; confirm the three new assertions would fail against the pre-change prose (inspect the assertion strings against the old text).

## Acceptance

- [ ] The runner's documented wait discipline issues one blocking wait invocation per chunk, each carrying the Bash tool's explicit timeout parameter at its ceiling, with all re-issues (chunk-elapsed and tripwire alike) bounded by a stated backstop that terminates in PANEL_RUN_FAILED
- [ ] The auto-background envelope is documented as a tripwire whose response is an immediately re-issued blocking wait, and ending the turn while legs are non-terminal is stated as forbidden
- [ ] No prose claims a chunked wait is safe without the explicit timeout parameter, and the stated numbers match the verified harness defaults (120s default window, 600000ms ceiling)
- [ ] The runner's success return is positively marked (PANEL_ANSWER first line, fused answer verbatim after) and PANEL_RUN_FAILED remains the failure sentinel
- [ ] The consistency test suite passes, including new assertions pinning the timeout parameter, the tripwire, and the marker in the runner prose

## Done summary
Hardened panel-runner wait discipline: per-chunk blocking wait carries the explicit Bash timeout:600000 tool parameter with an auto-background tripwire and a backstop terminating in PANEL_RUN_FAILED, plus a first-line PANEL_ANSWER success marker in Step 6; new consistency-skills assertions pin the timeout parameter, tripwire, and marker.
## Evidence
