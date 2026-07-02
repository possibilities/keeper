# skill-authoring — the method that keeps the agent-prose layer lean

keeper's skills, agent prompts, and worker briefs are read by models under load,
often unattended. This note codifies the levers that make that prose predictable,
skimmable, and self-pruning — so the layer stays a tool the model can execute, not
a wall it has to wade through. Apply it when you author or edit any `SKILL.md`,
agent `.md`, or `.tmpl` under `plugins/`.

## Predictability first

A skill earns trust by being predictable: the same trigger produces the same move,
every time. Prefer one clear path a model can follow deterministically over a menu
of options it has to choose between. When a real branch exists, make the branch
condition mechanical (a state check, a parsed field, an exit code) — never a vibe.
Ambiguity in the prompt becomes variance in the behavior.

## Leading words

Front-load the load-bearing word. A model skims the first few words of a line and
acts; bury the imperative behind throat-clearing and it gets missed. Start the
line with the verb or the condition that decides what happens — `On a
{success:false} envelope, …`, `Never disable a test to …`, `Two-full-suite cap
per invocation` — not `It's worth noting that in some cases you might want to …`.
Leading words are how a dense line stays skimmable.

## Progressive disclosure — licensed by branching

Detail is earned by a branch, not sprinkled everywhere. Put the always-true rule
inline; push the rule that fires only on a specific branch into that branch. A
reader on the happy path should not pay for the failure-recovery prose until they
are actually recovering. If a paragraph applies to only one of three outcomes, it
belongs under that outcome, not at the top.

## One trigger per branch

Each branch owns exactly one trigger, stated once, unambiguously. When a skill's
`description` lists when-to-use, each clause maps to one distinct situation — no
two clauses that a model could read as the same case, no situation that matches
two clauses. Overlapping triggers are how a skill fires on the wrong request or
fails to fire on the right one. If two branches share a trigger, they are one
branch or the trigger is wrong.

## Checkable + exhaustive completion criteria

State what "done" means at the top of the prompt, bound to observables a machine
could check, and make the list exhaustive — nothing outside it is required, and
every item inside it is. A worker's bar is `session_files clean, plan done
stamped, suite green`, not "the task is complete." Criteria bound to prose are
criteria the model grades itself against; criteria bound to observables are ones a
gate can enforce. If you cannot state a completion criterion as something
observable, the task is underspecified — sharpen it before shipping the prompt.

## The no-op test — sentence-level pruning

For every sentence, ask: **if I deleted this, would the model behave any
differently?** If no, delete it. Prose that restates the obvious, hedges without
changing the action, or narrates what the next line already says is a no-op — it
costs context and skim-budget and buys nothing. This is the primary defense
against re-bloat: the layer grows one justified line at a time and every edit is a
chance to run the no-op test on the lines it touches. Density is fine; noise is
not.

## Density is earned for unattended work

These prompts run without a human to re-steer mid-task, so a dense, complete line
that closes a failure mode is worth more than a short line that leaves it open. The
no-op test is not a word-count target — a line survives if deleting it would
change behavior or reopen a hole, however dense it is. Earn density by making every
clause load-bearing; do not confuse terseness with quality or verbosity with rigor.

## The ticket-vs-fog test — for what becomes a task at all

Before speculative work becomes a task, ask: *"can I state the question this task
answers precisely, right now?"* If yes, it is a ticket — plan it. If it is still
"we'll figure out X once Y lands," it is **fog**: leave it out, or park it as a
one-line open question, never mint a fake task whose acceptance cannot be stated
yet. The same discipline that keeps prose lean keeps the board honest — a plan of
statable tickets, not speculative placeholders. (This test also lives in
`plugins/plan/skills/plan/SKILL.md` Phase 3c, where decomposition runs.)

## Forward-facing only

Skills, agent prompts, and docs describe the system as it is now — never by
reference to what was removed, renamed, or previously true. State the present-tense
fact; if a constraint matters, phrase it as a forward rule (`there is no --no-push
flag`), not a tombstone. This mirrors the repo-wide doc discipline and is part of
what keeps the layer from accreting dead history.
