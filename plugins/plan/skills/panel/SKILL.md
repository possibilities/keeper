---
name: panel
description: >-
  Fan a hard question out to a panel of models answering in parallel and independently, then fuse their
  answers into one with consensus and blind spots surfaced. Use for any non-tiny inquiry where being
  confidently wrong is expensive, or whenever the human wants a multi-model / panel / ensemble answer or a
  cross-checked, higher-confidence answer — even if they don't say "panel". Skip it for tiny or low-stakes
  questions where one direct answer will do.
argument-hint: "[hard question]"
---

# Panel

Panel turns one question into a panel. The question goes to two models **at the same time**, each
answering independently — with web search and bash, and with no knowledge of the other. Then the
`plan:panel-judge` subagent reads both answers, extracts the structure of the panel's reasoning (what
they agree on, where they conflict, what only one saw, what they both missed), and writes a final answer
grounded in that analysis.

The whole mechanism is **independence, then synthesis**. The diversity that makes a panel beat a single
model is harvested, not manufactured: running the same question independently yields different reasoning
paths, tool calls, and sources. So there are no assigned "lenses" or personas — every panelist gets the
human's task verbatim and answers it straight. Read `references/panel.md` for the independence rules.

**Architecture (read before you start).** You — the orchestrator — run in the MAIN session because the
Monitor tool that drives `keeper pair` works only here, never in a subagent (verified). So you do the fan-out in
your own context, then hand the judging to the `plan:panel-judge` subagent. You **never read panelist
answer content into your context**: you collect only the answer-file PATHS from the completed events and
pass those paths to the judge. That keeps you lean — the full transcripts live in files the judge reads in
its own context.

## Step 0 — Confirm the panel

The panel is **opus4.8-gpt5.5**: Opus 4.8 (`--cli claude`) + GPT-5.5 (`--cli codex`). Both run
read-only, both in parallel.

## Step 1 — Build the panelist prompt

Create the panel's scratch dir, then write ONE prompt file with the human's task **verbatim** plus the
short independence instruction — the same file goes to both panelists (no lenses, no per-panelist
framing):

```bash
mkdir -p /tmp/panel-${CLAUDE_CODE_SESSION_ID}
cat > /tmp/panel-${CLAUDE_CODE_SESSION_ID}/prompt.md <<'PROMPT'
<the human's task, VERBATIM — do not summarize, reframe, or pre-digest it>

---
You are one of several independent experts answering this question. You will NOT see the other experts'
answers, and they will not see yours. Research it cold with web search and bash, then return a complete,
self-contained answer to the question above. Do not hedge about being on a panel — just answer.
PROMPT
```

Pass the task verbatim. Never add a lens, a stance, or your own read of the problem — that corrupts the
independence the panel runs on.

## Step 2 — Fan out, in parallel and blind

Launch **both panelists in a single turn** (two Monitor calls in one message) so they run concurrently.
Each writes to its own `--output` file. keeper-pair partners have full filesystem access — the prompt
gives directions and the verbatim task, never pre-read content.

```
Monitor(
    command='keeper pair send /tmp/panel-${CLAUDE_CODE_SESSION_ID}/prompt.md --cli claude --read-only --session panels --output /tmp/panel-${CLAUDE_CODE_SESSION_ID}/opus.yaml',
    description="panel opus",
    timeout_ms=3600000,
    persistent=false,
)
Monitor(
    command='keeper pair send /tmp/panel-${CLAUDE_CODE_SESSION_ID}/prompt.md --cli codex --read-only --session panels --output /tmp/panel-${CLAUDE_CODE_SESSION_ID}/codex.yaml',
    description="panel codex",
    timeout_ms=1860000,
    persistent=false,
)
```

- Neither panelist gets an assigned role or persona — both answer the human's task straight. The
  cross-family difference (Opus 4.8 vs GPT-5.5) is the diversity the panel harvests.
- `--read-only` on both: claude strips its edit tools; codex carries read-only via its prompt directive.
- `--session panels` on both: panelists land in a dedicated `panels` tmux session. A claude panelist
  registers as a tracked job; its stopped window is autoclosed by keeperd's daemon reaper past an idle
  grace, so attach promptly (`tmux attach -t panels`) to inspect a panelist's full session. To keep the
  windows open for inspection, add `panels` to the `disable_autoclose` config key (default empty).
  Concurrent legs share the session safely — `keeper agent` recovers from the create race.
- `keeper pair` emits a strict two-line contract on stdout: one `[keeper-pair] started …` line, then one
  terminal line. When `started` arrives, do nothing until the terminal line for that run. On
  `[keeper-pair] completed …`, note the exact `--output` path you passed — **do not read its content into
  your context**. On `[keeper-pair] failed …`, surface the `error=…` field; that panelist produced no
  usable answer.

The `--output` file is a YAML whose `message` is the panelist's own final answer; `completed` fires only
after its atomic temp-then-rename, so the moment you see it the file is whole. That file IS the answer-file
path you hand to the judge — the judge reads it in its own context, not you.

## Step 3 — Spawn the judge subagent

Once both runs have completed, spawn `plan:panel-judge` via the Agent tool with the original question
verbatim and the answer-file PATHS — never the content. Give the judge:

- The **original question**, verbatim (the same text the panelists got).
- **Answer-file paths**, one per panelist, each labeled by source — e.g.
  `opus → /tmp/panel-<sid>/opus.yaml`, `gpt-5.5 → /tmp/panel-<sid>/codex.yaml`.

The judge reads every answer file in full in its own context, classifies
the deliverable (artifact → merge & verify; research → five-section synthesis), and returns the final
answer plus the audit. You do not read the panelist files; the judge is the only place the answers meet.

## Step 4 — Absorb, then answer

Treat the judge's final answer as your own conclusion — data you received, now your thinking — and answer
the human in whatever shape the question needs: a plain answer, a report, a sketch, a ready-to-plan
proposal, an open question. Never wrap it in a "here's what the panel did" container, never dump the
five-section audit, never add a composition note, and don't name the panel by default. For a directly
invoked `/plan:panel`, answer the question in its natural shape as your own answer.

**Reveal on demand.** If the human asks how you reached the answer / what contributed / to see the panel,
*then* surface the audit and composition and point to each panelist's `transcript_path` (from its
`--output` YAML) / `claudectl show-session` for the full runs. A substance follow-up ("are you sure?",
"why?") is not that trigger — answer it
substantively in your own voice, not with a panel reveal.

**Hedge as yourself.** When the judge's contradictions or blind spots tell you the answer is genuinely
uncertain, express that low confidence in your own voice — you are unsure, not "the panel disagreed."

Never paste panelist transcripts. The judge's audit is retained for the reveal path; the full panelist
runs are one `transcript_path` read (from the `--output` YAML) / `claudectl show-session` call away if the
human wants to dig in.

## Cost & latency note

A panel costs roughly N× a single answer in tokens and runs as slow as its slowest panelist. That's the
deliberate trade: you spend more to stop being confidently wrong where that's expensive. For a quick or
low-stakes question, a single direct answer is the right call.
