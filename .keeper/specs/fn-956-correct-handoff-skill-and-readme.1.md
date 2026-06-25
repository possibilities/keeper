## Description

Two user-facing handoff docs overclaim behavior the code does not deliver
(originating findings F1 + F2, bundled here as one doc-accuracy commit
because both touch the same handoff user-facing prose and share reviewer
audience):

- F1 (kept): plugins/keeper/skills/handoff/SKILL.md:87, :95, :107 instruct
  the driving agent that `keeper handoff` "prints ... the resolved target
  session" and to "surface ... the target session it dispatched into."
  Evidence: cli/handoff.ts:209-232 resolves the session CLI-side and passes
  it into the RPC frame (target_session) but never prints it; the success
  path in cli/control-rpc.ts:199-201 writes only JSON.stringify of the
  RPC result, which is {ok, handoff_id} (RequestHandoffResult carries no
  session field). Resolution: EITHER drop the session claim from the skill
  (SKILL.md:87/:95/:107) OR have cli/handoff.ts print the resolved
  target_session alongside handoff_id on success. Pick one and make skill
  text and CLI output consistent.
- F2 (merged-into-F1): README.md:3348 says the dispatcher "picks the oldest
  `requested` handoffs row." Evidence: src/handoff-worker.ts:330
  selectActionableHandoffs does ORDER BY handoff_id ASC, and handoff_id is
  crypto.randomUUID() (cli/handoff.ts:218), so order is UUID-lexicographic,
  not temporal; there is no created_at/ts column to sort on. Reword to
  something like "an actionable `requested`/stale-`dispatching` row" rather
  than "oldest."

## Acceptance

- [ ] SKILL.md and the handoff CLI output agree on whether the target session is reported.
- [ ] README.md:3348 no longer uses "oldest" for handoff dispatch order.

## Done summary
Aligned handoff skill + README with actual CLI behavior: SKILL.md no longer claims the CLI prints the resolved target session (it emits only {ok, handoff_id}), and the README describes dispatch order as handoff_id-lexicographic over a random UUID rather than 'oldest'.
## Evidence
