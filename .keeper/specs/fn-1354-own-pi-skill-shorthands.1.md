## Description

**Size:** M
**Files:** plugins/keeper/pi-extension/keeper-events.ts, plugins/keeper/pi-extension/skill-autocomplete.ts, test/pi-skill-autocomplete.test.ts, test/pi-extension.test.ts, docs/install.md, docs/plugin-composition-map.md

### Approach

Extend Keeper's existing self-contained Pi extension with the return-bearing structural event contracts needed for native `input` transformation and `resources_discover`, without importing Pi as a runtime dependency. Resolve the canonical Hack and Plan skill directories from the extension module, expose exactly those available resources, and transform only a leading complete `/hack` or `/plan` token to its native `/skill:*` form while preserving the established source and streaming behavior.

Consolidate autocomplete into the existing safe provider wrapper: prepend the two short aliases during slash-command discovery, preserve the wrapped provider's delegation semantics, and remove the obsolete `getCommands()` snapshot/shadow-hiding model. Register input transformation, resource discovery, and autocomplete independently behind Keeper's existing job gate and fail-open boundaries so failures cannot suppress Task, Monitor, Agent Bus, event logging, footer, rename, or commit-work behavior. Do not add collision detection or override policy for ambient same-name skills.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/pi-extension/keeper-events.ts:107 — structural event and extension API types must represent return-bearing input/resource handlers without a Pi package import.
- plugins/keeper/pi-extension/keeper-events.ts:1429 — existing job-gated, fail-open extension factory and lifecycle registration choke point.
- plugins/keeper/pi-extension/skill-autocomplete.ts:78 — safe provider delegation currently depends on a pre-discovery extension-command snapshot that the new contract replaces.
- test/pi-extension.test.ts:896 — exact armed/unarmed handler inventory and tool registration contract.
- test/pi-skill-autocomplete.test.ts:26 — current provider-composition tests to rewrite around short aliases.

**Optional** (reference as needed):
- ../arthack/system/pi-extensions/skill-command-aliases.ts:3 — exact native transform and autocomplete behavior being relocated.
- ../arthack/system/pi-extensions/skill-command-aliases.test.ts:65 — aliases, near misses, and null-provider regression cases to preserve.
- src/agent/launch-config.ts:487 — module-relative per-launch extension path resolution convention.
- docs/adr/0091-keeper-owned-pi-shorthands-and-skill-discovery.md:1 — settled ownership, scope, and unsupported-collision decision.

### Risks

Pi invokes `resources_discover` after `session_start`, so autocomplete cannot depend on the dynamic skills already appearing in `getCommands()`. Stale global links can make a test pass for the wrong reason; all Keeper tests must use fakes and explicit resource returns rather than ambient `~/.pi` state. A load-time or handler exception must remain isolated because Pi aborts on an escaping extension factory error.

### Test notes

Extend the existing fake Pi API so tests can invoke and inspect return-bearing handlers in process. Cover exact aliases with and without arguments, whitespace boundaries and near misses, native `/skill:*` pass-through, autocomplete with populated/null providers, exactly two valid module-relative skill resources, repeated session startup, the unarmed zero-registration path, and independent fail-open behavior. Run each explicit `*.test.ts` path separately; do not boot Pi or use bare aggregate `bun test`.

## Acceptance

- [ ] A job-armed extension returns the canonical Hack and Plan skill resources and no sibling Plan-plugin skills, with paths independent of launch cwd and Arthack.
- [ ] `/hack` and `/plan` exact tokens enter Pi's native `/skill:hack` and `/skill:plan` pipeline with suffix text preserved, while `/hacker`, slash paths, and existing native skill commands remain unchanged.
- [ ] Slash-command discovery offers `/hack` and `/plan` through the existing provider-composition contract without registering extension commands or requiring a command snapshot.
- [ ] Missing optional APIs/resources and autocomplete failures degrade independently, and an extension without `KEEPER_JOB_ID` still registers nothing.
- [ ] The focused Pi extension and autocomplete test files pass under Keeper's named test constraints.

## Done summary
Extended keeper's Pi extension with input transform and resources_discover contracts so /hack and /plan expand through Pi's native /skill:* pipeline and Keeper's canonical Hack/Plan skill dirs are discoverable without Arthack; replaced the getCommands shadow-hiding autocomplete model with a prepend-based provider wrapper. Updated docs/install.md and docs/plugin-composition-map.md.
## Evidence
