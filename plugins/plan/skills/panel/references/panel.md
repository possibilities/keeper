# The panel

The panel's power comes from **independent answers, synthesized** — not from a clever prompt or assigned
personas. The `plan:panel-runner` subagent dispatches the same question to several models at once, each
works the problem cold with no knowledge of the others, and the judge fuses their answers. Independent
agreement is high-confidence; independent disagreement is exactly the signal worth surfacing.

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

## Defining the panel

The configured roster maps each named `panels.<name>` entry in `~/.config/keeper/panel.yaml` to an
object with `strength`, `members`, and `description`. `strength` is an authored closed-vocabulary
band and `description` says which work the panel fits; read both live with `keeper agent presets list`
(`--json` for structure) when choosing a panel, never infer fit from member count or a panel name.
`members` is an ordered array of launch triples `<harness>::<model>::<effort>` (ADR 0033) drawn from
the host matrix's enumerable cube — no separate preset catalog names them. Eligibility is
**capability-derived**: a triple is panel-valid when its harness is *capturable* (keeper can read that
harness's final message) AND carries a second reasoning axis (an effort or thinking rung to compare
across panelists) — a capability flag, never a harness-name allowlist. Today that is claude and pi;
hermes is axisless (no second reasoning axis), so it is never panel-eligible. A triple on a
non-panel-eligible harness is rejected when the panel loads.
`keeper agent presets resolve <panel>` returns the selected object's members in declaration order, each
identified by its **triple** (not just its harness), so two panelists on the same harness but different
models or efforts stay distinguishable; duplicate identical triples are legal too — each gets a
1-based ordinal so repeats stay distinct. Every member answers **in parallel** via a detached
`keeper agent run <harness> --preset <triple> --read-only` leg that writes its answer as a uniform JSON
result envelope (`--output`), then the `plan:panel-judge` subagent fuses them:

- **A claude member** (`claude::<model>::<effort>`) runs `keeper agent run claude --preset <triple>
  --read-only`. `--read-only` prepends an explore-only directive to the prompt — it reads, greps, and
  runs bash to research, then reports.
- **A pi member** (`pi::<model>::<effort>`) provides cross-family diversity. Pi's read-only posture is
  carried by the same prompt directive (`agent run` read-only is prompting-only — keeper enforces
  nothing), which is appropriate for explorer panelists.

No member gets an assigned role or persona — every member answers the human's task straight, and the
diversity comes from running the panel's triple spread cold (see "No lenses, no personas" above).

**Config is required.** With no `panel.yaml`, or an unknown panel name, `presets resolve`
exits 2 with a specific message (file path + bad name + sorted available names) — there is no silent
fallback. The one reserved name is `default`: `keeper agent presets resolve default` aliases to whichever
panel the top-level `default:` pointer names (it is never itself a panel name), and stays fail-loud with a
message naming what was typed when no default is configured. Run `keeper agent presets list` to see what is
configured. An example pair — the host matrix (`~/.config/keeper/matrix.yaml`) enumerating the launchable
cube, and the panel file (`~/.config/keeper/panel.yaml`) naming a panel over triples drawn from it, with a
top-level `default:` pointer:

```yaml
# ~/.config/keeper/matrix.yaml — the launchable cube (see docs/install.md's Host provider matrix walkthrough)
providers:
  - name: claude
    models: [sonnet]
  - name: pi
    models: [openai-codex/<model>]

# ~/.config/keeper/panel.yaml — described panel objects plus the default pointer
panels:
  core:
    strength: standard
    members:
      - claude::sonnet::high
      - pi::openai-codex/<model>::<effort>
    description: >-
      An everyday cross-check for a moderate-stakes question with real judgment.
default: core   # the literal `default` resolves here; never name a panel `default`
```

The judge is kept separate from the panelists — it runs in the `plan:panel-judge` subagent, reading
both answer files fresh in its own context rather than defending an answer it wrote itself.

## Prompt each panelist gets

Each panelist receives the human's task **verbatim**, plus a short instruction: *research with web search
and bash, then return a complete, self-contained answer; you are one of several independent experts and
will not see the others' work.* Nothing more — no lens, no framing that nudges the conclusion. Panelists
have full filesystem access, so the prompt gives directions and the verbatim task, not pre-read
content.

## Leg output-shape contract

Every leg is a `keeper agent run` launch, so every leg's prompt also carries `agent run`'s final-message
directive: the leg's final message is the captured deliverable and must be one complete, self-contained
answer, with any background agent the leg launches folded in before the leg ends its turn — never an
answer-then-follow-up delta. This is an OUTPUT-SHAPE rule only, never a reasoning lens — it says nothing
about how a panelist should think about the task, so it does not compromise the independence above. The
directive is a single always-on prompt block `agent run` injects itself; it is the sole injection
mechanism for this contract, so this section documents it and nothing in panel-side prompt composition
re-injects a second copy.
