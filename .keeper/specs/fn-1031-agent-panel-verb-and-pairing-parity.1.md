## Description

**Size:** M
**Files:** src/agent/dispatch.ts, src/agent/main.ts, cli/agent.ts, src/pair/panel.ts,
test/agent-panel-cli.test.ts (new), test/pair-panel.test.ts

### Approach

Expose the panel machinery under `keeper agent panel start|wait`, routing into the SAME
`runPanel` the pair verb calls — additive, pair untouched.

- **dispatch.ts**: add a `panel` arm to `Dispatch`/`splitSubcommand` (`head === "panel"` →
  `{kind:"panel", rest: argv.slice(1)}`), carrying the `start|wait` sub-verb + remaining args.
  Add the `keeper agent panel start|wait` synopsis to `USAGE` + `KEEPER_AGENT_HELP` (members
  from `--panel <name>` or an ad-hoc `--preset`/`--cli`; exit semantics 0 all-terminal / 124
  chunk-elapsed / 2 bad-config).
- **main.ts / cli/agent.ts**: handle the `panel` kind by calling `runPanel(rest)` from
  `src/pair/panel.ts` (the same entry `cli/pair.ts` uses for its `panel` branch). Preserve
  `runPanel`'s own stdout/exit-code ownership (it self-emits manifest/verdict + owns its code),
  mirroring how `cli/pair.ts` returns it directly.
- **panel.ts**: no engine change in this task — only ensure `runPanel`'s arg parsing is
  reachable from the agent entry (it already parses `start`/`wait` + `--panel`/`--dir`/`--chunk`/
  `--timeout`). If `runPanel` currently reads a pair-specific argv shape, adapt the ENTRY only.

### Investigation targets

**Required** (read before coding):
- src/agent/dispatch.ts: `Dispatch` union, `SubcommandKind`, `splitSubcommand` (the arm to
  add), `USAGE` + `KEEPER_AGENT_HELP` (where to document).
- src/agent/main.ts + cli/agent.ts: how the existing `run-capture`/`wait-capture` kinds are
  dispatched to their handlers (mirror for `panel`).
- src/pair/panel.ts: `runPanel` entry + its `start`/`wait` arg parsing, manifest/verdict JSON,
  exit codes (0/124/2); confirm legs already launch `keeper agent run`.
- cli/pair.ts: the `panel start|wait` branch that calls `runPanel` (the reference wiring).

**Optional** (reference as needed):
- test/pair-panel.test.ts: the panel start/wait tests (add an `agent panel` variant asserting
  identical manifest/verdict + exit codes).

### Risks

- **Pair byte-stable** — do not touch the pair `panel` branch or `runPanel`'s engine; only add
  the agent entry. Golden + pair-cli + pair-panel tests stay green.
- **runPanel owns its exit code + stdout** — return it directly from the agent dispatch (no
  generic trailer), exactly like `cli/pair.ts`.
- **Dep-graph** — `cli/agent.ts` reaching `src/pair/panel.ts` must stay db-free; confirm the
  depgraph hygiene test stays green (panel.ts imports pair-command types only, no db).

### Test notes

New `test/agent-panel-cli.test.ts`: `agent panel start`/`wait` produce the same manifest/verdict
JSON + exit semantics as `pair panel`. Keep pair-panel + golden green. Pure tier — the panel
machinery's detachment is already faked/seamed in the existing panel tests; reuse that harness.

## Acceptance

- [ ] `keeper agent panel start|wait` routes into `runPanel` and matches `keeper pair panel`
  (manifest/verdict JSON + exit codes 0/124/2).
- [ ] `dispatch.ts` USAGE/HELP + `cli/agent.ts` header document the `panel` sub-verb.
- [ ] Pair panel path + `runPanel` engine UNCHANGED; golden + pair-cli + pair-panel green.
- [ ] Dep-graph hygiene green; `bun test` + `bun run typecheck` green.

## Done summary
Routed keeper agent panel start|wait into the existing runPanel (same engine keeper pair panel drives) — additive parity, pair byte-stable. Documented the panel sub-verb in USAGE + wrapper help; new agent-panel-cli test asserts byte-identical verdict/exit vs pair panel.
## Evidence
