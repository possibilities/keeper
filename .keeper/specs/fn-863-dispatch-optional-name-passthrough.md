## Overview

Followup to the shipped `keeper dispatch` CLI (fn-858). Make the FREE-FORM
`--name` OPTIONAL and a pure pass-through to the spawned `claude` agent. Today
free form hard-requires `--name`; this drops that requirement and decouples the
flag from keeper-side labeling. When given, `--name <value>` is forwarded
verbatim to `claude` and nothing else; when omitted, no `--name` is passed at
all (true fire-and-forget). Plan form (`<verb>::<id>`) is unaffected.

## Quick commands

```bash
keeper dispatch --prompt 'poke at the flaky test'                 # no --name: launches with no claude --name
keeper dispatch --prompt 'poke at the flaky test' --name scratch  # --name forwarded to claude verbatim
keeper dispatch --prompt 'x' --name scratch --dry-run             # argv shows --name scratch; no keeper label coupling
```

## Acceptance

- [ ] Free-form dispatch works with NO `--name` (the required-name argFault is gone); no `claude --name` is emitted in that case.
- [ ] When `--name` is provided it is forwarded verbatim as `claude --name <value>` and is NOT used for keeper-side labeling/correlation/tab-renaming.
- [ ] `bun run test:full` passes.
