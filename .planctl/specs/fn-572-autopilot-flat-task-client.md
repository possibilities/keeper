## Overview

Add `scripts/autopilot.ts`, the second example client for keeper's
read-only NDJSON-over-UDS subscribe server. It is a wholesale clone of
`scripts/keeper-frames.ts` that hardcodes the `epics` collection and
replaces the render layer: instead of `epic:`/`tasks:` mapping blocks, it
flattens every open epic's embedded tasks into a single one-line-per-task
YAML stream. Each line is self-describing — `- {repo} {epicRef}.{task_number}
{epic title} · {task title}` — so the epic context survives "in the name"
without the nesting. All keeper-frames plumbing (reconnect/backoff, steady
poll + refetch coalescing, the `emitFrameIfChanged` byte-compare contract,
`/tmp` sidecars, SIGINT clean-unsubscribe, the read-only `query`/`unsubscribe`
fence) is preserved verbatim. "Autopilot" is a seed for more later; this is
the minimal first cut.

## Quick commands

- `bun scripts/autopilot.ts` — stream the flat open-epic task list (Ctrl-C to exit)
- `bun scripts/autopilot.ts --help` — show usage
- `cat /tmp/autopilot.$(pgrep -n -f autopilot).frame.yaml` — inspect the last emitted frame

## Acceptance

- [ ] `scripts/autopilot.ts` exists, runs under `bun`, and renders a flat
  one-line-per-task stream across all open epics, line format
  `- {repo} {epicRef}.{task_number} {epic title} · {task title}` (no `[status]`).
- [ ] Epic status is the only scope filter (no `--state`/`--collection`
  machinery); an unfiltered `epics` query lets the server default
  (`status: "open"`) apply.
- [ ] All keeper-frames plumbing is preserved and all `keeper-frames`
  string literals + `/tmp` sidecar paths are retargeted to `autopilot`.
- [ ] README's dual "No consumer ships yet" claim is corrected and an
  `## Example clients` section names both scripts.

## Early proof point

Task that proves the approach: `fn-N.1` — running `bun scripts/autopilot.ts`
against a live keeperd prints a flat task stream in the requested format. If
it fails: the render swap or the empty-filter default-scope assumption is
wrong; fall back to inspecting a `keeper-frames --collection epics` frame to
confirm the row shape.

## References

- `scripts/keeper-frames.ts` — the clone source (full client + `yamlScalar`,
  `epicNumFromId`/`taskNumFromId`, coalescing, reconnect blocks).
- `src/types.ts:104-143` — `Epic` (embeds `tasks: Task[]`) and `Task`
  (`task_number`, `task_id`, `title`, nullable numbers) wire shapes.
- `src/server-worker.ts:275-302` — epics default scope `status: "open"`;
  unfiltered page sorts `epic_number DESC, epic_id ASC`.
- `src/protocol.ts` — `encodeFrame`, `LineBuffer`, `QueryFrame`, `ServerFrame`,
  `FilterValue` reused verbatim.

## Docs gaps

- **README.md (lines ~45 and ~184)**: the dual "No consumer ships yet" claim
  is already false (keeper-frames exists) and becomes more so — correct both
  to name the example scripts and collapse the redundancy.
- **README.md**: no `## Example clients` (or `## Scripts`) section exists —
  add a concise one listing both scripts, their purpose, and `bun scripts/<name>.ts`
  invocation; document the shared subscribe-loop plumbing once.

## Best practices

- **Clone wholesale, don't extract yet:** autopilot is client #2 — rule-of-three
  says copy now, extract a shared module only at #3. The render layer
  (`projectRow`/`projectTask`/`renderEpicItem`/`renderBody`) is the legitimate
  divergence zone; the connection/coalescing logic is the shared knowledge.
- **The new render must be the SOLE input to `emitFrameIfChanged`'s byte-compare** —
  omitting `[status]` from the line means a task status flip alone must not reframe.
- **One YAML block-sequence line per task, routed through `yamlScalar`** — never a
  flow sequence or comma-join (re-introduces quoting traps for `·`/`:`/`#`).

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/autopilot-flat-task-list` — the `/arthack:sketch` handoff bundle for this work (no member snippets).
