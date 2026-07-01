## Description

**Size:** L
**Files:** cli/pair.ts (delete), cli/keeper.ts, src/pair-command.ts (delete pair-only or the
whole file), src/pair/panel.ts (rename/move optional), plugins/keeper/skills/pair/SKILL.md,
plugins/plan/agents/panel-runner.md, plugins/plan/skills/panel/references/panel.md,
plugins/plan/skills/hack/SKILL.md, README.md, scripts/lint-retired-name.sh,
scripts/frozen-allowlist.txt, test/lint-retired-name.test.ts, test/pair-cli.test.ts (delete)

### Approach

Delete the pair CLI, repoint consumers to `keeper agent`, and pin the retired name at zero.

- **Delete** `cli/pair.ts` + the `pair` verb entry/help/dispatch in `cli/keeper.ts`; delete the
  pair-only leftovers in `src/pair-command.ts` (`assemblePrompt`, `buildPairOutput`/
  `pairOutputYaml`/`PairOutputOpts`, `stopTimeoutMsFromSeconds`, `DEFAULT_PAIR_SESSION`) —
  remove the file entirely if nothing remains. Delete `test/pair-cli.test.ts`.
- **Rewrite `plugins/keeper/skills/pair/SKILL.md`**: transport → `keeper agent`. The
  Monitor-in-main pattern is REPLACED by the panel-runner shape — write the prompt to a file,
  `keeper agent panel start <file> --preset <p>|--cli <x> [--role/--read-only]` (returns a
  manifest with `.dir`), then a re-issued blocking `keeper agent panel wait --dir <d> --chunk
  540` loop (exit 0 = terminal / 124 = re-issue / 2 = error), backstop-bounded; read each
  member's `--output` JSON envelope (`message`/`transcript_path`/…). For the quick single-shot,
  `keeper agent run <cli> <prompt> --output <f>` (blocking, ≤10 min; background+poll if longer).
  Drop ALL Monitor + `[keeper-pair]` event-contract language. Keep the capability framing.
- **Repoint** `panel-runner.md` + `panel/references/panel.md` (`keeper pair panel|send` →
  `keeper agent panel`); `hack/SKILL.md` `Bash(keeper pair:*)` → `Bash(keeper agent:*)` (the
  `/keeper:pair` skill-name cross-refs stay); README every `keeper pair …` → `keeper agent …`.
- **Retired-name guard**: add `keeper pair` (and the `pair send`/`pair panel` forms) to
  `scripts/lint-retired-name.sh` + `test/lint-retired-name.test.ts`, with a scoped allowlist for
  `.keeper/` board history + the guard's own files (mirror the existing retired-name entry).

### Investigation targets

**Required** (read before coding):
- cli/keeper.ts: the `pair` verb entry (verb set, help line, dispatch import) to remove.
- cli/pair.ts + src/pair-command.ts: confirm every remaining symbol is pair-only + dead after
  the P1 role port + task .1 relocation (nothing under src/agent still imports them).
- plugins/keeper/skills/pair/SKILL.md: the Monitor-in-main + `From a subagent` + output-fields
  sections to rewrite.
- plugins/plan/agents/panel-runner.md, plugins/plan/skills/panel/references/panel.md,
  plugins/plan/skills/hack/SKILL.md, README.md: the `keeper pair` references.
- scripts/lint-retired-name.sh + scripts/frozen-allowlist.txt + test/lint-retired-name.test.ts:
  the existing retired-name guard shape to extend.

**Optional** (reference as needed):
- plugins/keeper/monitors.json + hooks: confirm NO pair reference (no change expected).
- AGENTS.md/CLAUDE.md: the codex-trust sole-writer wording (verify still true; no pair CLI ref).

### Risks

- **Order** — depends on task .1 (cluster relocated) so deleting `cli/pair.ts`/`pair-command.ts`
  leaves no dangling import; `tsc --noEmit` is the backstop after deletion.
- **Guard scope** — the retired-name guard must allowlist `.keeper/` board history (immutable
  epic ids/specs may contain `pair`) + this guard's own files, else it self-trips. Mirror the
  existing scoped allowlist exactly.
- **Skill correctness** — the rewritten `keeper:pair` SKILL must faithfully mirror
  panel-runner's start + chunked-wait loop (exit 0/124/2, backstop bound) and read the JSON
  envelope — a wrong wait loop or a stale YAML read breaks pairing for every caller.
- **Forward-facing docs** — no "formerly keeper pair" tombstones except the sanctioned guard
  allowlist.
- **panel.ts location** — moving `src/pair/panel.ts` → `src/agent/panel.ts` is OPTIONAL tidiness;
  if done, repoint its importers + tests, else leave it (it already emits agent-run legs).

### Test notes

Delete `test/pair-cli.test.ts`. The new retired-name test asserts zero `keeper pair` outside the
scoped allowlist (planted-token fail case + real-tree-clean, mirroring the existing test). Keep
pair-panel (now `agent panel`) + golden + agent-launch-config green. `bun test` + `typecheck` +
`bun run lint` + the guard all green.

## Acceptance

- [ ] `cli/pair.ts` + the `pair` verb removed; pair-only `pair-command.ts` symbols deleted (file
  removed if empty); `test/pair-cli.test.ts` deleted; `tsc --noEmit` clean (no dangling imports).
- [ ] `keeper:pair` SKILL drives `keeper agent panel start|wait` (Monitor-free, panel-runner
  shape) + `agent run`, reading the JSON envelope; Monitor + `[keeper-pair]` contract language
  gone; capability framing kept.
- [ ] panel-runner.md / panel.md / hack / README reference `keeper agent`, never `keeper pair`.
- [ ] Retired-name guard pins `keeper pair` at zero with a scoped allowlist; the guard test is
  green and trips on a planted token.
- [ ] `bun test` + `bun run typecheck` + `bun run lint` + the retired-name guard all green.

## Done summary

## Evidence
