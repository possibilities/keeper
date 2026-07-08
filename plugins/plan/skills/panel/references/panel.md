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

The panel's members come from a named `panels.<name>` array in `~/.config/keeper/panel.yaml`, each
member a named preset in the catalog `~/.config/keeper/presets.yaml` — a `{harness, model, effort}`
triple. Eligibility is **capability-derived**: a preset is panel-valid when its harness is *capturable*
(keeper can read that harness's final message) — a capability flag, never a harness-name allowlist.
Today that is every harness keeper drives — claude, codex, pi, and hermes — so any of the four is a
valid panelist; a preset on a non-capturable harness is rejected when the panel resolves. Run
`keeper agent presets list` to see the configured presets + panels.
`keeper agent presets resolve <panel>` returns the members in declaration order, each identified by its
**preset name** (not its harness), so two panelists on the same harness but different models stay
distinguishable. Every member answers **in parallel** via a detached
`keeper agent run <harness> --preset <member> --read-only` leg that writes its answer as a uniform JSON
result envelope (`--output`), then the `plan:panel-judge` subagent fuses them:

- **A claude member** (`harness: claude`) runs `keeper agent run claude --preset <member> --read-only`.
  `--read-only` prepends an explore-only directive to the prompt — it reads, greps, and runs bash to
  research, then reports.
- **A codex member** (`harness: codex`) is the cross-family diversity the panel is built to harvest.
  Codex's read-only posture is carried by the same prompt directive (agent run's read-only is
  prompting-only — keeper enforces nothing) — panelists are explorers, so a best-effort directive is
  acceptable. A codex member runs as an interactive TUI with its cwd directory-trust pre-seeded
  (fail-open), so its window never hangs on codex's trust prompt.

No member gets an assigned role or persona — every member answers the human's task straight, and the
diversity comes from running the panel's preset spread cold (see "No lenses, no personas" above).

**Config is required.** With no catalog, no `panel.yaml`, or an unknown panel name, `presets resolve`
exits 2 with a specific message (file path + bad name + sorted available names) — there is no silent
fallback. The one reserved name is `default`: `keeper agent presets resolve default` aliases to whichever
panel the top-level `default:` pointer names (it is never itself a panel name), and stays fail-loud with a
message naming what was typed when no default is configured. Run `keeper agent presets list` to see what is
configured. An example pair — the catalog (`~/.config/keeper/presets.yaml`) mapping each preset name to a
`{harness, model, effort}` triple, and the panel file (`~/.config/keeper/panel.yaml`) naming one or more
panels over those presets with a top-level `default:` pointer at one of them:

```yaml
# ~/.config/keeper/presets.yaml — preset name -> {harness, model, effort}
presets:
  fast-claude: {harness: claude, model: <model>, effort: <effort>}
  cross-codex: {harness: codex,  model: <model>, effort: <effort>}

# ~/.config/keeper/panel.yaml — panels over those presets, plus the default pointer
panels:
  core: [fast-claude, cross-codex]
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
