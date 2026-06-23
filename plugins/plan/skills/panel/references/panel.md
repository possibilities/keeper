# The panel

The panel's power comes from **independent answers, synthesized** — not from a clever prompt or assigned
personas. You dispatch the same question to several models at once, each works the problem cold with no
knowledge of the others, and the judge fuses their answers. Independent agreement is high-confidence;
independent disagreement is exactly the signal worth surfacing.

## No lenses, no personas

Do not assign panelists "roles" or "stances" (skeptic, optimizer, first-principles, etc.). That biases
*how* each one reasons artificially and corrupts the very independence that makes the panel work. Pass
every panelist the human's task **verbatim** and let each answer it straight.

The diversity is already there for free. Running the same prompt independently produces different
reasoning paths, different tool calls, and different source selections — even when it's the *same model
answering twice*. You don't manufacture diversity; you harvest it from independence.

## Independence is the rule

Panelists must never see each other's work. Don't show one panelist another's answer, and don't let the
orchestrator pre-digest or summarize the task before handing it over. The judge is the only place the
answers meet. Cross-pollination before the judge defeats the entire mechanism.

## The panel: opus4.8-gpt5.5

Two panelists answer **in parallel**, then the `plan:panel-judge` subagent fuses them:

- **Opus 4.8** via `keeper pair send --cli claude --read-only`. `--read-only` strips its edit tools
  and prepends an explore-only directive — it reads, greps, and runs bash to research, then reports.
- **GPT-5.5** via `keeper pair send --cli codex --read-only`. The non-Claude panelist is the
  cross-family diversity the panel is built to harvest. Codex's read-only posture is carried by the prompt
  directive plus a changed-files backstop.

Neither panelist gets an assigned role or persona — both answer the human's task straight, and the
diversity comes from running two different frontier models cold (see "No lenses, no personas" above).

The judge is kept separate from the panelists — it runs in the `plan:panel-judge` subagent, reading
both answer files fresh in its own context rather than defending an answer it wrote itself.

## Prompt each panelist gets

Each panelist receives the human's task **verbatim**, plus a short instruction: *research with web search
and bash, then return a complete, self-contained answer; you are one of several independent experts and
will not see the others' work.* Nothing more — no lens, no framing that nudges the conclusion. keeper-pair
partners have full filesystem access, so the prompt gives directions and the verbatim task, not pre-read
content.
