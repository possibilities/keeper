---
name: hack
description: Investigate a request, answer in the right shape, then route or execute the next move — answer inline, do small work, or funnel larger work to /plan:plan or /plan:defer. Use when the human says "hack", "/hack", "/plan:hack", or wants something investigated, answered, and routed.
argument-hint: "<request>"
disable-model-invocation: true
allowed-tools: Bash(printenv KEEPER_HANDOFF_ENVELOPE), Bash(keeper agent:*), Bash(knowctl:*), Bash(scrapectl:*), Bash(searchctl:*), Bash(summaryctl:*), Bash(agent-browser:*), Bash(keeper:*), Bash(tmuxctl:*), Bash(sqlite3:*), Bash(keeper plan list:*), Bash(keeper plan epics:*), Bash(keeper prompt:*), Bash(git log:*), Bash(git show:*), Bash(git diff:*), Bash(git status:*), Bash(gh gist create:*), WebSearch, WebFetch, Agent, Skill, Monitor
---

# Hack

Investigate a request, answer in the right shape, then either route or execute the next move. One entry point that infers what's needed.

## Captured Handoff authority

Before interpreting the request, run `printenv KEEPER_HANDOFF_ENVELOPE`. Capture authority exists only when that command returns a non-empty path.

- **Empty or unset carrier:** follow the ordinary `/hack` workflow in this document, including the plain-text confirmation beat before source work. The launcher always emits an empty carrier on ordinary launches, so presence alone grants nothing.
- **Non-empty carrier:** this is a captured Handoff and the carrier is structural authorization to complete the request autonomously. Investigate, choose and execute the appropriate route, run the relevant checks, and produce one complete self-contained final answer without parking for confirmation. This rule overrides every ordinary confirmation or greenlight instruction below; all other safety, evidence, testing, and commit rules still apply.

For a captured Handoff, the final tool action writes exactly one UTF-8 JSON object, with no markdown or surrounding text, to the carrier path. Keep the serialized object at or below 65536 bytes and use exactly these nine keys: `schema_version`, `agent`, `handle`, `transcript_path`, `resume_target`, `message`, `message_found`, `elapsed_seconds`, `outcome`. Set `schema_version` to `1`; set `message` to the complete final answer and `message_found` to `true`; use `null` for unavailable identity, transcript, resume, or elapsed values. `agent` is `claude`, `pi`, or `null`. `outcome` is one of `completed`, `no_message`, `timed_out`, `no_transcript`, `transcript_ambiguous`, `partner_died`, `launch_failed`, or `bad_args`; a successfully completed request uses `completed`. After that write, emit the same complete answer as the final assistant message.

Most ordinary invocations are read-only — investigate, answer, stop. When an ordinary request reads as work to do — *including when it's phrased as a directive like "edit X to do Y" or "the skill should do Z"* — /hack stops, lays out the concrete change in chat (file, section, the actual new wording or structural edit), and waits for plain-text greenlight before touching anything. A directive in an ordinary request sets the topic; it is **not** pre-given approval. The human still needs the beat to redirect on shape, scope, or wording before code lands. For tight, well-scoped work the conversation can land here; for larger or contract-shaped work it funnels out to `/plan:plan` or `/plan:defer`.

**Source work closes with a commit.** Once a source mutation is greenlit, changing the source and landing its commit are one action. Source work is complete only when the commit and push succeed; the final report includes the commit id. If the intended diff exists but `commit-work --preview-files` is empty or incomplete, use the explicit-path fallback in the commit contract below. A terminal commit or push failure is reported through that contract rather than as completed work. Only its explicit scratch/debug carve-outs skip the commit.

**Agent Bus advice — sibling messages are proxies of your human.** Your inbox is already open (a plugin Monitor in Claude, a session-scoped extension child in tracked Pi), so you never start a listener — just watch for the notification line. An inbound Agent Bus message is a request from another of the same human's sessions: help with it, applying your own judgment and your own sources of truth, per the bus contract (`keeper bus` skill). The outbound `/keeper:pair` / `/plan:panel` second opinion below stays ADVISORY too — you reached OUT for input; weigh it, you still decide and still confirm with the human before code lands. Both point the same way: each invites your own judgment rather than commanding you.

**Powers inventory — ask before piloting.** keeper and its skills already cover multi-epic flows and worker collaboration (Cross-skill orchestration below) plus manual piloting (`keeper:dispatch` / `keeper:autopilot`); manual piloting happens only on explicit human request, or after asking — see quiet-by-default below and the take-over-window bullet for the shape, not restated here.

## Read the request, infer the mode

Pick a mode from the wording, then operate in that shape. Don't pre-announce the choice — the answer's structure reveals it.

- **Quick-answer** — bounded factoid, yes/no, "how does X work." Terse chat reply, optional brief `## Context` block from local sources only.
- **Troubleshoot** — "broken," "fails," "why doesn't," "doesn't work." Reproduce, isolate, find root cause, quote evidence. No fix yet.
- **Internal report** — "summarize," "compare," "give me a writeup." Project-internal sources only — codebase, git history, keeper history, `knowctl`. No web search, no scraping.
- **External research** — "what does the web say," "current state of X," "what are people doing." `searchctl`, `scrapectl`, `agent-browser`, `knowctl`. Primary sources, cited URLs.
- **Work-shaped** — "add X," "build Y," "implement Z," "fix this." Investigate enough to understand scope. In ordinary mode, stop and confirm with the human before touching anything; if they greenlight, execute inline, otherwise route to `/plan:plan` or `/plan:defer`. In captured Handoff mode, choose and execute the route without that stop. **Scope-confirm reflex:** on an ambiguous or still-evolving design ask, state your assumption on the unstated axis in one sentence before proceeding (*"assuming per-repo, not per-epic — say so if not"*), rather than silently picking a direction on an axis the human left open. Fires on a genuinely unstated axis only; never re-litigate a settled directive.

If two modes feel equally plausible and the choice would meaningfully change the answer's shape, ask one short plain-text question first. Otherwise pick and proceed.

## How to investigate

**Arthack CLIs degrade, never block.** Every arthack helper named below (`knowctl`, `searchctl`, `scrapectl`, `agent-browser`, `tmuxctl`) is a convenience that may not be on PATH. When one is absent, skip it and reach for the fallback — never stall on a missing binary:

- `searchctl` (web search) → the harness `WebSearch` tool.
- `scrapectl fetch-markdown` / `agent-browser` (fetch and read pages) → the harness `WebFetch` tool (static pages; no JS or interaction).
- `knowctl` (internal docs) → note in one line that no local topic docs are reachable, then go straight to web search.
- `keeper history list|show|search|files|index` → the keeper history verbs below; `keeper resume <session-reference>` continues the human foreground session; `keeper transcript` stays for explicit subagent/tool-detail or Pi branch-aware drill-down.
- `tmuxctl` → plain `tmux` over Bash.

Universal moves, in any mode:

- Reproduce or witness the thing literally before theorizing. For a bug, run it; for a system claim, look at the actual code or log.
- Read evidence literally — quote exact errors, exact log lines, exact code paths, with `path:line` where useful.
- Form one hypothesis at a time and test it. Don't pile guesses on guesses.
- Follow data across boundaries (process/file/network/cache). Most surprises live at handoffs.
- Check recent movement: `git log --oneline -20`, `git log -S <symbol>`, `git blame`, `keeper history list`.
- Mine session history when the question is who/when/what-happened: the unified Claude/Pi history surface catalogs readable native conversations, optional Keeper aliases, and provenance-graded file evidence; `keeper resume <session-reference>` is the continuation path, not a read.
- Delegate when wide: if the investigation spans more than one subsystem or repo, or balloons past ~10 reads, fan out parallel read-only Explore agents (Agent tool, one per surface) and keep this context for synthesis and the conversation. Brief each agent to reproduce before theorizing, quote exact evidence with `path:line`, and return conclusions, not file dumps.
- Bring in `/keeper:pair` for a quick second opinion when your mental model feels sticky — a single partner, lightweight, narrow. This is **not** the panel: the panel (the routing gate below) is a heavier multi-model fan-out plus a judge, reserved for answering the inquiry itself, not for unsticking a mid-investigation hunch.

Mode-specific moves:

- **Quick-answer** — cap local reads around three; if you need more, you guessed the mode wrong, upgrade to report or troubleshoot.
- **Troubleshoot** — reproduce → narrow surface → quote evidence → hypothesize → test → repeat. `keeper`, `tmuxctl`, recent `git log` and `git blame` are faster than guessing. When the trail is cold, the history recipes below find who touched what, when, and in which session.
- **Internal report** — codebase, configs, git history, keeper history, `knowctl`. Skip `searchctl` and `scrapectl`. Gather enough to be thorough — don't exhaustively research.
- **External research** — cast a wide net with `searchctl web-search` / `reason-search` / `pro-search`; pull primary sources via `scrapectl fetch-markdown`; use `agent-browser` for pages needing interaction or JS; cross-reference; flag disagreements; cite URLs for key claims.
- **Work-shaped** — read enough of the surface to understand what would change, what's affected, and what's not yet decided; surface that in chat before any edit. Above inline size, investigate like you'll have to defend the direction: mine prior work (`keeper history list` / `keeper history show` for related conversations, `keeper plan epics` for adjacent epics, `knowctl` for framework docs), read the touched surface until you're confident — no read cap at this tier — and trace the data across every boundary the change crosses. Thin investigation is what makes a sketch thin.

### Session history (native artifacts + optional Keeper metadata)

<!-- BAKE:BEGIN keeper prompt render engineering/keeper-history-forensics -->

`keeper history` is the canonical session record for Claude and Pi, including sessions launched outside Keeper. Use it before any lower-level inspection:

```bash
keeper history list                 # browse sessions
keeper history search <query>       # find prompts and discussion
keeper history files <path>         # find file evidence
keeper history show <session-reference>  # inspect one session
keeper history index                # inspect the available history index
```

A `<session-reference>` may be a qualified native id, exact Keeper job id, exact native id, or an exact current or historical title. The shared resolver reports ambiguity; never silently select the newest match.

`keeper history files` labels evidence truthfully: `observed_mutation` is recorded mutation evidence, `possible_mutation` is suggestive but unconfirmed, and `mention` is only a reference to the path.

For a human continuing work, run `keeper resume <session-reference>` in the foreground. `keeper transcript` is for specialist transcript work only.

For Keeper-tracked lifecycle detail only, `keeper session events <session-reference>`, `keeper session summary <session-reference>`, and `keeper show-job <session-reference>` are optional supplements; they are not the cross-harness history source.

<!-- BAKE:END keeper prompt render engineering/keeper-history-forensics -->

### Keep the domain vocabulary and decisions sharp

The reflex below fires on any non-trivial design answer — during investigation and sketch conversations alike: read the repo's typed domain-knowledge homes first, challenge fuzzy terms, and offer (never auto-write) glossary and ADR updates.

<!-- BAKE:BEGIN keeper prompt render engineering/domain-docs -->

**Keep a repo's domain knowledge sharp while you design — the vocabulary and the decisions are part of the work, not paperwork after it.** This is the reflex for interactive design answers; consuming agents just read what it produces.

- **Read before you answer.** Before a non-trivial design answer, read the repo's `CONTEXT.md` glossary and any relevant `docs/adr/` records. They fix what the words mean and which trade-offs are already settled.
- **Challenge and sharpen.** Test each domain term you use against the glossary. When a word is fuzzy, overloaded, or drifting from how the code uses it, say so and propose a sharper definition — an imprecise shared vocabulary is a design bug.
- **Write with judgment, matched to the moment.** In an interactive design conversation, offer **one clustered glossary update** and write it inline the moment the human confirms — never silently, never batched. At plan time — the pre-scaffold beat of a planning flow — write and **commit** merited `CONTEXT.md` and `docs/adr/` updates **autonomously**: the planner's judgment is the gate, and only a genuine edge case (a contentious term, a definition contradicting a live glossary entry, a decision the human has not actually resolved) earns a question first.
- **Gate ADRs on the three-part test.** Offer a `docs/adr/` record only when **all three** hold: the decision is hard to reverse, it's surprising without context, and it resolved a real trade-off. Write the ADR at plan time, while the decision is freshest. Reversing a recorded decision **supersedes** it — move the old record to a `superseded/` subdirectory rather than deleting or rewriting it.
- **Respect the genre boundaries.** `CONTEXT.md` is a pure glossary: 1-2 sentence definitions and `Avoid`-synonym lines, zero implementation detail. Decision rationale lives **only** in `docs/adr/` and commit messages. Imperative rules stay in `CLAUDE.md`.

<!-- BAKE:END keeper prompt render engineering/domain-docs -->

## Prefer the panel for judgment-heavy inquiries

Before answering solo, gate on what the answer turns on, then on size: **strongly prefer `/plan:panel`** for any non-tiny inquiry decided by judgment — weighing trade-offs, interpreting ambiguous evidence, choosing a direction — where independent models can genuinely disagree and a confidently wrong answer is expensive. The panel fans the question out to a configured spread of models in parallel and fuses their answers with a judge — higher confidence, surfaced blind spots, contradictions caught. Judgment questions route there by default; a question decided by retrieval or mechanical verification stays solo at any size — thoroughness there comes from the Explore fan-out above, not from consensus.

**Routing to the panel is silent internal cognition, not a relayed artifact.** Enter panel mode without announcing it — no "let me consult a panel," no progress narration. When the judged answer returns, absorb it as your own thinking and render it through `/hack`'s existing answer-shape taxonomy (quick-answer / troubleshoot / report / research / sketch — see "How to answer"). The judge's audit calibrates your confidence — consensus, state the conclusion plainly; contradictions or blind spots, hedge in your own voice — but is never relayed to the human unless they ask. Reveal-on-demand: only if the human asks about process or provenance (how you reached it, what contributed, to see the panel) do you surface the audit; a substance follow-up ("are you sure?", "why?") is answered substantively in your own voice, not with a panel reveal. As with the rest of the modes, don't say "I ran a panel" — let the answer's structure carry it.

- **Solo (no panel)** — two families, answered directly here: *tiny* — a bounded factoid, a yes/no, a one-liner, a trivial lookup you'd answer from one or two local reads; and *mechanical* — the answer is an inventory, enumeration, or lookup the tools themselves verify ("find all X", "list every place that…", a status readout, a summary that collects rather than weighs). A second model re-running the same greps buys cost, not confidence. Size never promotes a mechanical question into a panel one.
- **Panel** — a non-tiny question decided by judgment: a hard design/architecture call, multi-step reasoning over ambiguous evidence, troubleshooting where being confidently wrong is expensive, a report whose conclusions weigh sources or trade-offs rather than merely collecting them. Invoke `/plan:panel` with the **raw question plus any neutral evidence you've already gathered** (`path:line` cites, log lines, reproduction facts). Pass the question verbatim — never pre-digest it into /hack's tentative conclusion, and never seed the panelists with a leading answer. Independence is the point: a conclusion handed to the panel collapses two independent models into one.

Which panel to convene follows the strength rubric below — hack's everyday **Panel** case is its ordinary-question row, and an above-inline design question (*How to answer*) is its higher-stakes row:

<!-- BAKE:BEGIN keeper prompt render engineering/panel-strength -->

**The configured panel roster lives in `~/.config/keeper/panel.yaml`, authored by the `/plan:panel-guidance` skill.** Each panel carries an authored strength band (`weak|light|standard|strong|max`) and a rich description of the work it fits. Panels may be defined, renamed, or removed at any time, so never hard-code a panel name or assume a particular one exists; read the live roster with `keeper agent presets list` (`--json` for structure) at decision time.

**Choosing is two-stage: restate the task's stakes in a phrase, then pick the weakest panel whose description covers it.** Escalate a rung only on an observable trigger — genuine ambiguity, blast radius, irreversibility, or a security surface — never on felt confidence.

Pick where a panel-worthy question lands:

- **The human names a panel** — pass that name through as the panel argument, verbatim. Their choice stands; don't second-guess it against the roster.
- **An ordinary panel-worthy question** — convene the configured default: omit the panel argument and let the `default` pointer resolve.
- **A weak rung is a cheap sanity duo** — when one direct answer would do, skip the panel entirely rather than reaching for the floor.
- **A shorter description is not a weaker fit, and a stronger band is not a tiebreaker** — read what each panel actually covers; band order breaks a tie only once a named trigger fires.

**When roster discovery fails, or no default is configured** — skip the panel: answer the question directly without one, and tell the human about the config gap so they can fix `panel.yaml`. A missing roster or default is a configuration problem to surface, never a reason to stall or to invent a panel name.

<!-- BAKE:END keeper prompt render engineering/panel-strength -->

When in doubt whether judgment or retrieval decides it, route to the panel — a redundant fan-out is cheaper than a confidently wrong solo answer; doubt about size alone never promotes a mechanical question. (Distinct from the `/keeper:pair` hunch-unsticking second opinion drawn above: the panel answers the inquiry itself.)

**Work-shaped requests are not exempt.** "Add X," "build Y," "configure Z like the existing thing" reads like a directive with the direction already given — but above inline size the *approach* is still an open call, so route that design question to `/plan:panel` before you sketch. The panel answers the *inquiry* shape (what's true, what's the right approach); the sketch/route machinery below still governs how any resulting work lands.

## How to answer

The chat reply's shape follows the mode. Don't say "operating in X mode" — let the structure show it.

- **Quick-answer** — concise paragraph. Optional `## Context` block when ≤3 local reads meaningfully sharpen the answer; skip the section silently otherwise.
- **Troubleshoot** — `What's happening` (the failure, literally) / `Where it breaks` (file:line, process, command) / `Why` (root cause in 1–2 sentences) / `Evidence` (the specific log, diff, or row) / optional `Suggested direction` (one sentence, no plan).
- **Internal report** — 2–3-sentence executive summary, then sections with descriptive headings, tables and concrete numbers over prose, recommendations if applicable. Be thorough but scannable.
- **External research** — start with key takeaways, organize into sections with headings, use concrete facts and quotes, note areas of uncertainty, end with a sources list.
- **Work-shaped** — two tiers, gated by the same size clauses that decide where the work lands:
  - **Inline-sized** (fits one or two files, no schema / protocol / UX boundary change) — one short paragraph naming what would change, what's affected, what's not yet decided. Enough for the human to confirm direction so you can execute inline.
  - **Above inline** — produce a full sketch block (schema below). Investigate first per the work-shaped moves — prior work, full surface, boundaries. Then, before you commit to a direction, **route the design question to `/plan:panel`** per the panel gate above — an above-inline change (new contract, multi-module scope, a partner / worker / migration / screen) is exactly the high-stakes architecture call it names. The panel's judgment is the sketch's backbone — the sketch is how that judged thinking surfaces for above-inline work. **Commit to one direction: pick the approach you would defend**, informed by the panel, and present it as your own chosen direction — not "the panel recommended X." Don't enumerate options as live equals — a single close alternative belongs in Risks & unknowns as one bullet, nowhere else.

A confident "I don't know yet, here's what I've ruled out" is more useful than a confident wrong answer. Say so when the evidence is thin.

### Where documents land, and what "open it" means

Output conventions, not a mode — they apply whenever a request produces a file artifact (most often a report or research writeup).

Creating or opening a document is a direct output action, not a work-shaped source change: execute it without a sketch, greenlight, or approval. "Open this document," "open it," and "open that doc" mean first ensuring the Markdown and YAML sidecar are saved according to the convention below, then publishing both as a GitHub gist and opening the gist's web page in the browser. Never interpret "open" as opening the local file, an editor, Preview, or a `file://` URL.

<!-- BAKE:BEGIN keeper prompt render source-dirs/docs-dir-and-gist-open -->

When a request asks you to create a document — a writeup, report, brief, or research summary meant to persist as a file — write it under `~/docs/`. A single doc is `~/docs/<name>.md`; a related set gets its own `~/docs/<topic-slug>/` directory. Don't scatter docs into the repo or `/tmp` unless the human names another location.

Every doc carries a companion `~/docs/<name>.yaml` sidecar. Document metadata lives ONLY in that sidecar — never embed a metadata block in the `.md` body.

Treat "save" and "open" as cumulative actions, including when they appear in the same request. "Save" writes the Markdown and YAML sidecar under `~/docs/`. "Open" publishes both files as a GitHub gist and opens its web page by running `gh gist create <doc>.md <doc>.yaml --web` (Markdown first, sidecar second). For "save … and open it," save both files first, then run that gist command. Never use the macOS `open` command for documents, and never open a local file, editor, Preview, or `file://` URL.

<!-- BAKE:END keeper prompt render source-dirs/docs-dir-and-gist-open -->

### Sketch block (work-shaped, above inline)

When a work-shaped request is above inline size, answer with this block. It is the chosen direction in chat — no code, no edits yet — and it is the one answer shape where depth is the point: the economy that keeps the other modes terse stops at this boundary. A sketch is rich because the investigation behind it was; every section below is grounded in something you actually read, not inferred from the request alone.

Render each section as a `##` heading with substance under it — a sketch is a document the human thinks against, not a compressed schema:

- **`## Goal`** — 1–2 sentences. What this work is for, in plain language.
- **`## Direction`** — 3–6 bullets. The chosen approach, not code. Each bullet is a step or move, and carries a clause of why when the reasoning isn't obvious — enough rationale that the human can push back on the thinking, not just the sequence.
- **`## Touchpoints`** — concrete files, modules, and commands with paths, one bullet each, citing `path:line` where useful. Say what changes at each touchpoint, not just that it's involved.
- **`## Risks & unknowns`** — ≤4 bullets, one per bullet. A near-miss alternative direction, if any, appears here as a single bullet — nowhere else.
- **`## Open decisions`** — ≤2 bullets, each a single question with a stated default ("A unless you say otherwise"). These give the human cheap handles — a fragment like "A" or "15 is good" answers one. Omit the section when nothing is genuinely open.

For web or mobile work, add **`## Surface`** (1–2 sentences on the artifact, screen, or interface) and **`## Moves`** (≤6 bullets on key user interactions or system responses) before the schema above. Skip both for non-UI work.

## How to route — pick one mid-terminal endpoint

After the answer lands, infer which endpoint fits the work that may follow. Name it as a lead recommendation in one short sentence. List the others as one-line alternatives below. No structured pickers, no `AskUserQuestion`.

The five mid-terminal endpoints:

1. **(no action)** — the inquiry was the whole point; nothing follows.
2. **→ execute inline** — tight, well-scoped work (one or two files, no new contracts, direction obvious). Before any edit, lay out the concrete change in chat: name the file, name the section, and either quote the proposed new wording verbatim or describe the structural edit in enough detail that the human can redirect on shape. Wait for plain-text greenlight. A directive-shaped request ("edit X", "add Y", "rename Z") scopes the work; the greenlight is a separate beat that authorizes it. Then make the change and commit per the rule below.
3. **→ produce a sketch in chat** — work is plausibly implied but above inline size, or the human will want to think before changes land. Produce the sketch block from the answer section, then map the human's followup signal: plain-text greenlight → execute inline; "plan it" → `/plan:plan`; "defer it" → `/plan:defer`; "your call" → delegated routing per the rubric below.
4. **→ `/plan:plan`** — the answer already laid plan-shaped structure (≥3 sequenceable moves, a schema or contract change, multi-module scope). Another sketch round would be ceremony. Route through the warm-handoff beat below — never fire the skill cold.
5. **→ stay in inquiry** — go deeper (more reads, more boundaries), go wider (add external sources), or shift mode. Name a concrete next read, not a generic "more research?".

Inference rubric:

- Answer stood on its own with nothing actionable → **(no action)** lead.
- Answer was terse and the human will likely want depth → **→ stay in inquiry** lead, with a specific next action.
- The answer is work-shaped → size it against the rubric below to pick between inline, sketch-then-route, and `/plan:plan`.

<!-- BAKE:BEGIN keeper prompt render engineering/escalate-inline-or-plan -->

When a request reads as work to do, size it against this rubric before choosing how to act. The same clauses gate both the answer shape and where the work lands.

- **Inline** when the change fits one or two files, introduces no schema / protocol / UX boundary change, the direction reads as a single coherent move, AND the human wants it done now. Answer with the short pre-work paragraph and execute on plain-text greenlight.
- **`/plan:plan`** when the work spans multiple modules, adds a worker / RPC / migration / screen, introduces a new contract, or reads as ≥3 independently sequenceable moves. Decompose rather than commit.
- **`/plan:defer`** when the work is inline-shaped (one cohesive task, no new contracts) BUT the human signaled "not now" / "later" / "follow up" / "queue this up" semantics. Capture it as a normal-sorted single-task epic; autopilot runs it when it reaches the front of the board.

Tie-breakers:

- Ambiguous between **inline** and **`/plan:plan`** → default to **`/plan:plan`**. Collapsing a plan back into one commit is cheaper than backing out of a premature commit.
- Ambiguous between **inline** and **`/plan:defer`** → default to **`/plan:defer`**. Capturing it for later is cheaper than an unwanted commit landing now.

<!-- BAKE:END keeper prompt render engineering/escalate-inline-or-plan -->

When the answer is work-shaped and above inline size, lead with **→ produce a sketch in chat**, then route on the human's followup signal:

- plain-text greenlight → **execute inline**;
- "plan it" → `/plan:plan`;
- "defer it" → `/plan:defer`;
- "your call" (also "you decide" / "you pick" / "auto") → delegate the routing per the rubric above. Announce the chosen path and the deciding clause in one short sentence before executing (e.g. *"Routing to /plan:defer — inline-shaped but you signaled 'follow up later.'"*), giving the human a beat to override before anything lands.

Read follow-ups for decision content, not keywords. A short fragment that answers an open decision ("A", "15 is good", "yup, lowercase") is the greenlight for that piece; an approve-plus-tweak reply ("looks good, but rename the flag") means apply the tweak and proceed — don't spend another round re-confirming.

### Hand off to /plan:plan warm, not cold

When the route is `/plan:plan` — inferred, or because the human said "plan it" — don't fire the skill as the literal next action. The pre-plan beat is what makes the plan session worth running. "Plan it" authorizes planning from the conversation's established high-water mark: build the handoff from the conversation and research, resolve only genuine load-bearing unknowns, and invoke `/plan:plan` as soon as none remain.

1. **Finish the exploration the sketch exposed.** Open the touchpoints you haven't read, run the command you were speculating about, delegate wide sweeps per the investigate rules. Scouts inside `/plan:plan` verify; they shouldn't discover.
2. **Surface only unresolved load-bearing questions that cannot be inferred from the conversation** — one at a time, each with a short explainer (the tradeoff, why it matters, what each answer implies). Don't turn the handoff summary or settled defaults into questions. Update the sketch as answers land.
3. **When nothing load-bearing remains open, fire `/plan:plan`**, passing forward what the conversation established as its instructions: the conclusion the inquiry reached, the sketch (goal, direction, touchpoints), the resolved decisions, and key evidence with `path:line` cites — so the plan session starts from this conversation's high-water mark instead of rediscovering it. This is an internal skill-to-skill handoff: suppressing the panel's display to the human does not suppress the judged conclusion downstream — your panel-informed thinking carries forward as the session's own. The panel runs once, here at the inquiry stage; plan inherits its judgment through this handoff rather than re-invoking it.

"Plan it" often arrives with this beat spelled out — "explore, resolve questions, then plan", "ask anything you need first, when ready /plan:plan". That phrasing sets the sequence, not just the destination; honor the sequence even when it's left implicit.

### After an epic lands, the session goes quiet by default

Scaffolding an epic — via `/plan:plan` or `/plan:defer` — normally ends the visible session. Keeper's autopilot dispatches and completes all plan work on its own. Once the epic lands, the wrap-up is the plan skill's own one-line report and nothing more — **no proactive, unsolicited offer to drive execution** (no "run it when ready" prompt, no surprise-launching workers). The planning beat plans; it does not surprise-launch, drive, or close the work mid-plan. The operator skills (`keeper:dispatch` / `keeper:autopilot`) are model-invocable, so you MAY reach for them on a clear user request to drive execution — but the planning flow never reaches for them on its own: a quiet wrap-up by default, execution driven only on explicit intent.

The one optional move is arming an await — and it stays silent unless the conversation earns it. `keeper:await` blocks on board state (epic or task complete, or unblocked) then runs a follow-up action.

- **Positive call** — the human used wait-then-act phrasing anywhere in the conversation ("circle back", "wait for followup", "check back after the epic lands", "ping me when it's done") → that's the directive: arm `keeper:await` with the condition (`complete fn-N-slug[.M]`) and the follow-up action spelled out. No confirmation beat — just a one-or-two-sentence note on what it watches and what fires.
- **Ambiguous** — a follow-up was genuinely discussed (a phase-2 plan gated on this epic, a verification pass you raised) but the human never asked to wait → collaborate: ask one short plain-text question whether to arm it. Don't self-arm a follow-up the human didn't request.
- **Neither** → silent. No "nothing worth awaiting" narration, no generic "want me to wait?", no raising the await topic at all — an idle await is noise, and so is talking about not arming one. This is the common case; deferred epics bias hard this way.

**Multiple epics are yours to sequence.** When the conversation calls for more than one epic — the human asks for two plans, or a piece of work splits across epics — you decide the topology; one-at-a-time is not the default. The cross-skill orchestration section below carries the topologies and how the operator skills combine.

### Cross-skill orchestration

No single skill owns how the operator skills (`keeper:dispatch`, `keeper:autopilot`, `keeper:await`) COMBINE across epics — this section does. The quiet-by-default rule above governs when: reach for these shapes on clear user intent to drive multi-epic work, never mid-plan on your own. Each skill's own body carries its mechanics — reference them, don't re-teach them here.

- **Parallel** (epics are independent / dep-free) → scaffold both, then `keeper:autopilot mode yolo` lets the reconciler dispatch them concurrently.
- **Sequential** (B must run after A) → wire the cross-epic dep on the epic (`epic add-dep` / `depends_on_epics`) so autopilot sequences execution on its own; for a stricter human-gated cadence, `keeper:autopilot mode armed` plus a `keeper:await complete <epic>` phase gate holds B until A lands.
- **Planning-dependent daisy-chain** (you genuinely can't author B until A's landed reality exists — new APIs, file shapes, schema) → plan A, arm `keeper:await landed fn-A`, and on `met` plan B against what landed. Gate on `landed`, not `complete` — the milestone distinction is spelled out below. One session drives several plan rounds without the human re-priming context. Each round re-runs the close/await check before arming the next; when nothing's left to arm, stay silent and hand back.
- **Research epic** (the deliverable is knowledge, not code) → still a normal planned epic — nothing merges, so gate any follow-up on `complete`, not `landed` (see the milestone distinction below). Its task specs must name the retrieval path: default the acceptance criteria to writing findings under `~/docs/<slug>.md` per the docs-dir convention above; a lightweight result can rely on the task's Done summary instead. Size it like any other epic — durable, multi-task, or daisy-chain-feeding research earns one, while a bounded one-shot question is lighter as `keeper:handoff` or `keeper:pair`.
- **Take-over window** (drive execution by hand for a stretch) → `keeper:autopilot` captures the current `{paused, mode, armed}` state, changes it for the window, and restores it when the human says done; `keeper:dispatch` fires one worker by hand inside that window.
- **Blocked-worker escalation, operator-side** → when a worker blocks, the daemon dispatches an autonomous `unblock::<task>` session to resolve it and pages you over agentbot only if that session itself declines or dies — you are the terminal operator, not the first responder. A plan MAY design deliberate check-in points where a worker returns `BLOCKED: DESIGN_CONFLICT` / `SPEC_UNCLEAR` instead of guessing; those escalate the same way. Mechanics and the paged-operator recipe live in the plan skill's operator-orchestration reference, not re-taught here. One caveat is mandatory: `TOOLING_FAILURE` and unparseable categories never escalate — they mint a silent, operator-visible sticky suppression instead.

**These three are not human questions — derive them, don't ask.** "What order should the epics roll out?", "what deps should I set?", and "should I wait for this epic to finish before planning the next?" each have a determinate answer you already hold; surfacing them to the human is the failure mode, not the safe default.

- **Order is not a preference.** Keeper has no human-chosen rollout sequence — autopilot is level-triggered and dispatches whatever is ready. Execution order falls out of the dep edges plus the reconciler, so there is nothing to ask: wire the deps and order takes care of itself.
- **Deps are derived, not chosen.** A cross-epic edge comes from a real code/process dependency — does B's execution consume A's landed APIs, files, or structures? You just planned both, so you know. epic-scout and Phase 6 auto-wire inter-epic edges against the open board; you set `depends_on_epics` for the genuine execution dep and leave independent epics dep-free. A dep you can't name a concrete code reason for is not a dep.
- **Await-before-plan is the rare exception, gated by one test:** *can I author every epic's task specs right now, against today's codebase plus the other epics' plans?* **Yes — the common case → plan all the epics in this session now**, wire deps, and let autopilot sequence; do NOT await between plans. **No, and only when B's SPECS literally need A's landed reality** (new APIs, file shapes, schema the specs must reference) → daisy-chain: plan A, arm `keeper:await landed fn-A`, plan B on `met`. An *execution* dependency (B's code needs A's code) is NOT a planning dependency — that is `depends_on_epics` plus autopilot, never a reason to stall planning.

Apply the test and commit to a topology. Ask only when the planability test is genuinely indeterminate AND a wrong call is expensive to unwind — not because more than one shape is conceivable.

#### `landed` vs `complete` — the milestone a daisy-chain gates on

<!-- BAKE:BEGIN keeper prompt render engineering/landed-vs-complete -->

**`landed` and `complete` are distinct keeper plan milestones — they can fire at different times, and which one gates downstream work matters.**

- **`landed <epic>`** fires when the epic's lane is merged to the default branch. Epic-only. It **degrades to `complete` semantics when worktree mode is off** (no lanes exist, so merged ⇔ done). For a **multi-repo** epic it fires only once ALL per-repo groups have merged — not on the first group.
- **`complete <id>`** is **done AND idle**: the work is finished and every owning subagent has gone idle. Under worktree mode a dependent lane is cut before the upstream's finalize merge, so `complete` can fire while the epic's files are **not yet on the default branch**.

Consequence: a planning daisy-chain — authoring or building against another epic's merged reality — gates on **`landed`, not `complete`**, because `complete` can report done while the files the downstream work reads still aren't on the default branch.

<!-- BAKE:END keeper prompt render engineering/landed-vs-complete -->

### Always check the session is done — speak only to close it

At the end of any flow that did real work or landed an epic — and any other point where the human might reasonably wonder whether you're finished — silently answer one question: *is there anything left in this conversation to accomplish or revisit, now or when the epic completes?* This runs every time; it is an internal check, not a prompt. (After a self-evidently-complete trivial answer, the answer is its own close-signal — stay silent.)

- **Something is left** — an armed await, an unanswered sub-thread, a side-ask the human raised and you haven't closed, a follow-up the conversation implies → stay quiet about closing. The await note above, or the work itself, already carries the "more is coming" signal; don't pile "still some things to do" narration on top.
- **Nothing is left** — the inquiry is fully answered, any epic is scaffolded, no await is armed or pending, nothing the human raised is dangling → say so in one short sentence so the human never has to ask: *"That's everything from this thread — clear to close the session whenever you like."* Nothing more.

Never ask "anything else?" or "should I close?" — answering that for the human is the whole point. An armed await means something IS pending, so it and the close-signal never fire together.

### Orchestration is yours to shape

You have standing license to conform the plan tooling to the workflow that best delivers, across a closed set: epic right-sizing, multi-repo-root epics (per-task `target_repo`), queue/defer shapes, and awaits and daisy-chains. Confident the shape serves the work → act and inform. Unsure, or the move is off this list → ask first. This discretion never overrides the wait-for-plain-text-greenlight beat before code edits: the greenlight rule elsewhere in this file stays exactly as binding.

If genuinely torn between two endpoints, ask one short plain-text question.

**Forward-facing advice and comments only.** Whatever you write — code comments, docs, skill or command prose, CLI `--help` / `--agent-help` strings, hook messages — states the system as it is *now*. Do not narrate what something replaced, was renamed from, or used to do.

- ❌ "fn-622 retired the dedup mechanism, so renders changed" / "formerly emitted a subset"
- ✅ "renders always emit the full snippet set"

The one carve-out: commit messages and changelogs are the sanctioned home for history and *should* narrate the change in past tense. Full rule lives in `keeper prompt render code-comment-style` (comments) and `keeper prompt render future-facing-docs` (docs and prompts) — cite those, don't restate them.

**Commit mechanics.** Apply the contract below to every source mutation authorized through `/hack`.

<!-- BAKE:BEGIN keeper prompt render engineering/commit-via-keeper-default -->

**Commit source changes with `keeper commit-work`, not raw `git commit`.** `commit-work` discovers the complete dirty surface, selects only exclusive tool/plan claims owned by this invocation, runs the lint matrix, freezes exact Git blob OIDs and modes in a private index, runs commit hooks and configured signing, compare-and-swap publishes the commit, and pushes that exact SHA. Don't invoke linters separately or bypass hooks.

Preview, then commit:

```bash
keeper commit-work --preview-files
keeper commit-work "<type>(<scope>): <summary>

<optional body — 1-3 bullets>"
```

Every invocation emits one versioned `commit-work-result` JSON line; inspect `outcome`, `selection`, `surface`, `commit`, and `push`. `<type>` is usually `feat` / `fix` / `refactor` / `test` / `docs`. Push to origin is automatic after a successful main-worktree commit.

**A missing path is an adoption decision, not a raw-Git escape hatch.** Re-run with repeatable `--adopt <exact-path>`, or a bounded versioned manifest via `--adopt-from <file>`. Adoption lasts for this invocation only, is frozen to the selected path/mode/blob identity, and refuses any live or unknown foreign exclusive claim. Bash, inferred, package-manager, and codegen evidence appears only as `observed_adoptable`; it never auto-selects. Never use a broad path, `git add -A`, or `git add .` to make a coverage gap disappear.

**On `outcome:"lint_failed"`:** read the named files, fix per bounded stderr, then re-run `keeper commit-work` with the same message and adoption arguments. A lint failure is not an attribution gap; do not add adoption just to bypass it.

**On any other refusal:** follow the envelope's typed recovery. An ownership conflict's `request_release` pointer names the live claimant and contested paths and carries a `keeper session release` invocation — advise it as one bounded, best-effort bus notice and never signal or terminate the claimant; wait the grace window, then retry, or escalate a still-live conflict through the usual block path. Otherwise let the claimant land or become positively terminal; surface/index/ref drift requires a fresh preview; operation and jam gates require their named recovery. Do not retry blindly and never fall back to raw `git commit`.

**Never** `--no-verify`, `--no-gpg-sign`, `--amend`, `git add -A`, or `git add .` — see `keeper prompt render engineering/commit-hygiene-flags`.

Scratch or debugging instrumentation the human marked throwaway should not be committed at all.

<!-- BAKE:END keeper prompt render engineering/commit-via-keeper-default -->

Phrasing pattern (lead + alternatives, ≤5 lines total):

> Above a single-file edit — here's a sketch of the direction. Greenlight to execute, or say "plan it" to decompose first.
>
> Other paths: "defer it" to queue without working it now; or ask me to dig into <specific area> before deciding.

If no request appears below, respond only with "Ready."

## Request

$ARGUMENTS
