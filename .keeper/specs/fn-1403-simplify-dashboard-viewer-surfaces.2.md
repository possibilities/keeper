## Description

**Size:** M
**Files:** cli/board.ts, cli/summary.ts, cli/frames.ts, cli/descriptor.ts, cli/keeper.ts, src/summary-view.ts, src/readiness-client.ts, src/needs-human.ts, test/board.test.ts, test/summary.test.ts, test/frames-cli.test.ts, test/readiness-client.test.ts, test/keeper-cli.test.ts, test/completions.test.ts, test/help-purity.test.ts

### Approach

Move the stable semantic boundary behind Board's header into a pure Summary presentation module. Board keeps epics, tasks, armed/failure pills, pinned epics, and needs-human detail but emits no semantic header. Summary emits one deterministic YAML document rooted at `summary`, containing independently scoped Account-focus state, Board task/epic counts, needs-human count, and Autopilot intent/health; optional fields are omitted, complete collection ordering is explicit, and focus deadlines are UTC values with explicit effective states rather than locale- or relative-time prose.

Consolidate presentation inputs through the readiness client so Board and Summary do not multiply duplicate subscriptions or drift in needs-human/account/autopilot semantics. Summary waits for every required stream before first paint in live, snapshot, and Frames modes. Register a real top-level `keeper summary`, add it to `keeper frames --view` without changing the default Board view or envelope schema, and keep Usage excluded.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/board.ts:333 — canonical Board summary counts and header view model.
- cli/board.ts:632 — current width/time-zone-dependent header formatter.
- cli/board.ts:1393 — Board body and semantic-header construction boundary.
- cli/board.ts:1447 — four-stream first-paint contract and shell integration.
- src/readiness-client.ts:2154 — composite readiness subscription entry point.
- src/needs-human.ts:137 — canonical needs-human classification and accounting.
- cli/frames.ts:27 — canonical Frames view allowlist/default and lazy dispatch.
- cli/descriptor.ts:657 — top-level command descriptor registry.
- cli/keeper.ts:35 — canonical subcommand/lazy-handler registration.

**Optional** (reference as needed):
- cli/status.ts:427 — richer unified status projection that can supply semantics without duplicating classification.
- docs/adr/0100-independent-scoped-account-focus.md — independent focus desired/effective/delivery distinctions.
- docs/adr/0012-agent-frame-stream-wire-contract.md — additive view compatibility boundary.

### Risks

Board's extra subscriptions also drive body pills and pinned rows, so deleting header wiring must not delete body evidence. Summary must preserve independent Fable and Non-Fable failure domains and avoid time-driven frame churn. Adding a Frames view is additive only; envelope schema, bounds, default view, and Usage exclusion cannot drift.

### Test notes

Move header semantic fixtures into Summary tests, retain Board-body fixtures without the prelude, and add YAML structural plus byte-exact tests for off/active/fallback/expired/unavailable focus states, malformed-scope isolation, empty counts, paused/playing modes, UTC deadlines, hostile scalars, first-paint latching, CLI registration, completions, and Frames dispatch.

### Detailed phases

1. Extract canonical Summary model/projectors and deterministic serializer.
2. Enrich/consolidate readiness presentation inputs and needs-human reuse.
3. Remove Board's semantic header without changing body semantics.
4. Add Summary live/snapshot/Frames runner and CLI registration.
5. Move and expand Board, Summary, readiness, command, and Frames tests.

### Alternatives

Aliasing `keeper dash` is rejected because Dash is an interactive job-card application. Copying Board's existing header code is rejected because duplicate subscriptions and semantic drift would follow.

### Non-functional targets

Summary first paint is coherent, serialization is independent of terminal width/locale, repeated equivalent inputs are byte-stable, and adding the second live consumer does not multiply avoidable daemon subscriptions.

### Rollout

Board and Summary activate together through one command-registration change. Existing Board frame consumers see an intentional body change while the Frames envelope contract remains stable.

## Acceptance

- [ ] `keeper board` renders the existing plan body without Account focus, count, or Autopilot header rows and retains armed/failure/pinned/needs-human behavior.
- [ ] `keeper summary` exists as a top-level live/snapshot viewer and renders a deterministic `summary` YAML model with structured UTC focus lifetimes and explicit desired/effective state.
- [ ] Summary never publishes seeded partials; live, snapshot, and Frames first paint waits for a coherent required-stream composite and timeout fails without an authoritative partial document.
- [ ] Equivalent Summary inputs produce byte-identical output across widths, locales, time zones, current sidecars, and Frames rendering.
- [ ] `keeper frames --view summary` works additively while Board remains the default, Usage remains rejected, and envelope/bounds/trailer semantics do not change.
- [ ] Board, Summary, readiness-client, Frames CLI, dispatcher, completion, and help-purity tests pass.

## Done summary

## Evidence
