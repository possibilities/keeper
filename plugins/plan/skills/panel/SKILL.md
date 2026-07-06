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

Panel turns one question into a panel: the question goes to several models **at the same time**, each
answering independently — with web search and bash, blind to the others — and the `plan:panel-judge`
subagent reads every answer, extracts the structure of the panel's reasoning (what they agree on, where
they conflict, what only one saw, what they all missed), and writes a final answer grounded in that
analysis.

The whole mechanism is **independence, then synthesis**. The diversity that makes a panel beat a single
model is harvested, not manufactured: running the same question independently yields different reasoning
paths, tool calls, and sources. So there are no assigned "lenses" or personas — every panelist gets the
human's task verbatim and answers it straight. Read `references/panel.md` for the independence rules.

**Architecture.** You are a thin shim. The entire fan-out — resolving the panel, launching the panelists,
waiting for them token-free, and spawning the judge — runs inside the `plan:panel-runner` subagent, which
you spawn with one `Task()` call. The runner owns the blocking fan-out, so a panel can be convened from
anywhere — the main session, another skill, or a worker — and panelist transcripts never enter your
context. You hand the runner the question and render what it returns; you never read a panelist's answer
yourself.

## Spawn the runner

Pass the human's task **verbatim** — never summarize, reframe, or pre-read referenced content into it; that
corrupts the independence the panel runs on. If the human named a specific panel, name it; otherwise the
runner defaults to the `default` panel. Also **auto-derive a short run slug** — a few kebab words drawn from
the task (`[a-z0-9-]`, e.g. `oauth-token-refresh`); pick a sensible default, don't stall or ask. Inject it
as a `Slug:` line so the runner forwards it (each panelist leg launches as `panel::<slug>::<preset>`, keeping
the run identifiable in tmux + forensics). **Capture that slug verbatim** — you replay it byte-for-byte if the
runner's return is malformed and you re-drive (see *Validate the runner's return*), so the same slug
reconciles the existing run instead of fanning out a second one.

```
Task(
    subagent_type="plan:panel-runner",
    description="convene panel",
    prompt="""<the human's task, VERBATIM — do not summarize, reframe, or pre-digest it>

Slug: <a short kebab run id you derive from the task, e.g. oauth-token-refresh>
Panel: <the panel name the human named, or omit this line for the default panel>"""
)
```

No `model=` kwarg — the agent file owns the model and effort. The runner resolves the panel composition,
fans the panelists out, waits for every leg, spawns the judge, and returns the judge's fused answer. Pass
neutral evidence only — the verbatim task, and a panel name if the human gave one — never your own read of
the problem.

## Validate the runner's return

The runner's final message has **exactly two valid shapes**, each identified by its **first line** — match on
the first line's shape, never a substring, so a fused answer that merely *mentions* a sentinel string is not a
failure:

- **`PANEL_ANSWER`** on the first line — success. Strip that marker line and absorb the fused answer that
  follows (see *Absorb, then answer*).
- **`PANEL_RUN_FAILED`** on the first line — failure. It carries a `reason:` line and the per-leg status; the
  runner emits it when any leg fails, times out, or never produces its output, or when the panel resolves to
  zero members. Tell the human that **the panel failed** and why; do **not** present the failure text as an
  answer. No judge ran, so there is no panel answer to render.

Anything else is a **malformed return** — status narration, "waiting" prose, a promise of future work, or an
empty or error-shaped Task return. Never absorb a malformed return as an answer, and never let one end your
turn in a waiting state.

On the first malformed return, **re-drive once**: re-spawn `plan:panel-runner` with the **byte-identical** Task
prompt from the first spawn — the same task text and the **same `Slug:` line** you captured above, never a
freshly derived slug. `keeper agent panel start` reconciles idempotently by slug and reuses terminal legs, so
the re-drive is cheap and cannot double-fan-out. If the **second** return is also malformed, surface it to the
human as a **panel failure**, quoting the runner's raw return verbatim — **no further retries**, and never a
turn left in a waiting state.

## Absorb, then answer

On success — a first-line `PANEL_ANSWER` — **strip that marker line**; everything from the next line down is
the judge's fused answer. Treat it as your own conclusion — data you received, now your thinking — and answer
the human in whatever shape the question needs: a plain answer, a
report, a sketch, a ready-to-plan proposal, an open question. Never wrap it in a "here's what the panel
did" container, never dump the judge's audit, never add a composition note, and don't name the panel by
default. For a directly invoked `/plan:panel`, answer the question in its natural shape as your own answer.

**Reveal on demand.** If the human asks how you reached the answer / what contributed / to see the panel,
*then* surface the composition and point them at the panelist runs — each lands in the `panels` tmux
session, one `tmux attach -t panels` away (or `claudectl show-session` when it's on PATH). A done claude
panel leg auto-closes its window ~30s after it finishes (gated by `autoclose_enabled`, default on); codex
and pi legs stay open (`tmux attach -t panels`) until you close them by hand. A
substance follow-up ("are you sure?", "why?") is not that trigger — answer it substantively in your own
voice, not with a panel reveal.

**Hedge as yourself.** When the fused answer's contradictions or blind spots tell you the answer is
genuinely uncertain, express that low confidence in your own voice — you are unsure, not "the panel
disagreed."

Never paste panelist transcripts.

## Cost & latency note

A panel costs roughly N× a single answer in tokens and runs as slow as its slowest panelist. That's the
deliberate trade: you spend more to stop being confidently wrong where that's expensive. For a quick or
low-stakes question, a single direct answer is the right call.
