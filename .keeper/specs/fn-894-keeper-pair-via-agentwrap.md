## Overview

Build `keeper pair` — a pairing helper inside keeper that lets an orchestrating agent
fan a task out to another model CLI (claude / codex / pi), backed by **agentwrap** as the
spawn transport and driven via the **Monitor tool from the main session**, exactly like
pairctl today. It ports pairctl's pairing ergonomics (role prompts, read-only posture,
output normalization, the Monitor stdout event contract) into keeper, delegating
model/effort/profile selection and the tmux transport to agentwrap. A `/keeper:pair` skill
wraps it; `/plan:panel` becomes the first consumer (swapping `pairctl send-message` for
`keeper pair send` inside its existing Monitor calls); and every keeper-side pairctl
reference is flipped to `/keeper:pair`. End state: pairctl is **deprecated** — nothing in
keeper needs it. Deleting the arthack pairctl package is a separate follow-on (gated on a
cross-repo caller audit + a multi-turn-resume parity decision).

The enabling agentwrap change: `--wait-for-stop` returns a stop *signal* + transcript path,
not the answer text. So agentwrap gains two composable subcommands — `wait-for-stop` (block
until stop) and `show-last-message` (print the partner's final assistant message, extracted
from the per-backend transcript JSONL) — and the single-use `--wait-for-stop` flag is
removed in favor of `launch-detached → wait-for-stop → show-last-message`.

## Quick commands

- `agentwrap claude --agentwrap-tmux --agentwrap-tmux-detached --agentwrap-no-confirm -p "hi"` then `agentwrap wait-for-stop <handle>` then `agentwrap show-last-message <handle>` — the three composed primitives return the partner's final message.
- `keeper pair send /tmp/prompt.md --cli codex --read-only --output /tmp/out.yaml` — emits `[keeper-pair] started`/`completed`, writes the final answer to `--output` as YAML with a `message` field.
- `bun test` (keeper root) + agentwrap's `bun test` — argv-builder + subcommand coverage.

## Acceptance

- [ ] agentwrap `wait-for-stop` + `show-last-message` subcommands work for claude AND codex; `--wait-for-stop` flag removed.
- [ ] `keeper pair send` launches a partner via agentwrap, waits, and writes the partner's final answer to `--output` (YAML, `message` field + transcript/session drill-down).
- [ ] `--read-only` strips edit tools + prepends the read-only directive + flags a `read_only_violation`; codex `--read-only` keeps web search.
- [ ] `keeper pair` emits the two-line `[keeper-pair] started`/terminal Monitor contract even on SIGTERM/timeout, and reaps the tmux window.
- [ ] `/keeper:pair` skill is model-invocable and documents the Monitor-in-main pairing pattern.
- [ ] `/plan:panel` fans out via `keeper pair` (Monitor) with cross-vendor diversity preserved; the judge still reads answer-file paths.
- [ ] Every keeper-side pairctl reference points at `/keeper:pair`, in forward-facing prose.

## Early proof point

Task that proves the approach: `.1` (agentwrap subcommands). The whole design hinges on
cleanly extracting the partner's final message from agentwrap. If `show-last-message` can't
be made reliable per-backend: fall back to keeper pair parsing the transcript itself (Option
A), or — last resort — run agentwrap non-tmux/blocking and capture stdout (Option C, diverges
from the tmux-transport convergence).

## References

- **Depends on `fn-890-harden-agentwrap-tmux-transport`** — consumes its machine-readable
  launch JSON (.2) + `--agentwrap-tmux-env` (.3), both DONE. `.1` of this epic deletes the
  `--wait-for-stop` flag fn-890 introduced; coordinate with fn-890.5 (in-progress transport
  docs) so docs land on the subcommands.
- **Overlaps** `fn-889` (repo-wide planctl-rename codemod writes the panel + /hack files this
  epic edits) and `fn-884.6` (re-bakes /hack) — landing-order matters; whichever lands second
  rebases. Conflict is same-file/different-region (low), but sequence to be safe.
- Behavior to port: `~/code/arthack/apps/pairctl/pairctl/{run_send_message.py,helpers.py}`
  (Monitor two-line contract, SIGTERM handler, atomic output write, `read_only_violation`,
  `READ_ONLY_DIRECTIVE`, final-message handling); role prompts at
  `~/code/arthack/apps/pairctl/config/prompts/*.txt`; read-only posture (codex bypass +
  `--enable web_search_request`) at `~/code/arthack/apps/pairctl/config/{claude,codex}.yaml`.
- agentwrap surfaces: `src/transcript-watch.ts` (per-backend stop detection — extend for
  message text), `src/main.ts:476-693` (launch JSON + the `--wait-for-stop` branch to remove),
  `src/dispatch.ts:107-125` (subcommand dispatch).
- keeper agentwrap-argv pattern: `src/dispatch-command.ts` `buildDispatchLaunchArgv`, `cli/dispatch.ts`.
- Follow-on (NOT this epic): delete the arthack pairctl package after a cross-repo `pairctl`
  caller audit + a `--chat-id` multi-turn-resume parity decision.

## Docs gaps

- **plugins/plan/skills/panel/SKILL.md**: revise Steps 1–4 transport prose (Monitor calls, `[pairctl]`→`[keeper-pair]` notifications, output_file shape, `pairctl show-chat` reveal path) — handled in task .4.
- **plugins/plan/skills/panel/references/panel.md** (+ verify sibling `panel.md`): transport prose; model names (Opus 4.8 / GPT-5.5) stay — task .4.
- **plugins/plan/skills/hack/SKILL.md**: frontmatter allowed-tools `Bash(pairctl:*)` + lines 15/40/101 second-opinion refs → `/keeper:pair` — task .4.
- **CLAUDE.md** + **README.md** skill inventories: add `keeper:pair` — task .4.
- **plugins/plan/agents/panel-judge.md**: output format note (YAML `message` preserved → minimal) — task .4.

## Best practices

- **Read-only is layered, not a flag:** `--disallowed-tools Edit,Write,NotebookEdit` does not stop Bash writes / git; pair the tool-strip with the directive + a git changed-files backstop (detection, as pairctl does). [anthropics/claude-code#10256, #12232]
- **Atomic output:** write `--output` to a temp file then rename, and emit `completed` only after the rename — the Monitor event must never point at a half-written file.
- **Prompt-as-file** for any non-trivial prompt (execve/ps limits, quoting); pass the path, don't inline into argv.
