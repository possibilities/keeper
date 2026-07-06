## Overview

The Bun/TS usage scraper (tmux-driven TUI scrape + parsers + CLI entry) becomes
first-class keeper source under `src/usage-scrape/`, ending the external
`~/code/agentusage` project dependency. The runner always spawns the internal
entry via the daemon's own bun binary; the four `usage_scraper_*` config keys
and the external `~/.config/agentusage/config.yaml` profile catalog are both
retired in favor of one keeper-config `usage_models` registry that declares
which models exist to scrape and their display aliases. A `keeper usage scrape`
subverb exposes the same entry for humans.

## Quick commands

- `bun test` — fast suite green, including the migrated parser/scrape suites and the conformance corpus gate (>=14 cases)
- `bun src/usage-scrape/scrape-cli.ts` with no args — exits non-zero with usage text (entry runs standalone)
- `keeper usage scrape --target claude --profile default` — prints the schema-1 JSON contract on a machine with a claude TUI

## Acceptance

- [ ] `src/usage-scrape/` carries the six scraper modules as first-class keeper code — keeper conventions, forward-facing comments, no reference to the external project directory anywhere in keeper source
- [ ] The scrape subprocess seam spawns the internal entry unconditionally; the `usage_scraper_uv_path` / `usage_scraper_project_dir` / `usage_scraper_runtime` / `usage_scraper_bun_path` keys are gone and lingering copies in deployed configs are ignored harmlessly
- [ ] One `usage_models` keeper-config map declares the scraped model set (claude profiles + codex) and per-model aliases; no keeper code reads `~/.config/agentusage/config.yaml`; `account_aliases` is retired the same tolerant way
- [ ] `keeper usage scrape` dispatches the scrape CLI in-process; bare `keeper usage` and its `--help` are unchanged; the leaf is declared in the CLI descriptor tree
- [ ] Full fast suite + slow tier green; conformance corpus migrated and gating; README / CONTEXT.md / ADR updated

## Early proof point

Task that proves the approach: ordinal 1 (module + test custody move). If the
merged modules fail keeper's biome/tsc/comment gates in a way adaptation can't
absorb, stop and rescope the adaptation depth before building on the subtree.

## References

- Pinned invariants (wire + on-disk contract, do NOT rename): `SCRAPE_CONTRACT_SCHEMA_VERSION = 1` JSON contract; `~/.local/state/agentusage/` state root + envelope shape (`agentusage_root` config key stays); `tmux -L agentusage-scrape` socket; `agentusage-scrape-` tmpdir prefix + worker path filter; `agentusage-scrape.tmux.conf` name.
- `fn-1142` (overlap dep): rewrites `cli/keeper.ts` usage/help from `cli/descriptor.ts` and sweeps `cli/usage.ts`; the new `scrape` leaf must register in the descriptor native tree to pass its conformance test. This epic is sequenced behind it.
- Source being absorbed: `~/code/agentusage/src/*.ts`, `tests/conformance-derive.ts`, `tests/fixtures/corpus/`. The repo is archived only AFTER the post-land cutover verifies.
- Post-land operator runbook (NOT task acceptance — runs in the planning session once the epic lands): restart keeperd on merged main; verify fresh `<id>.json` envelopes for every declared model + picker rotation via `keeper usage`; rewrite `~/.config/keeper/config.yaml` (drop the four `usage_scraper_*` keys + `account_aliases`, add `usage_models` incl. `codex`); delete `~/.config/agentusage/config.yaml`; `mv ~/code/agentusage ~/archive/agentusage`.

## Docs gaps

- **README.md**: third-party runtime-dep claim (gains `@js-temporal/polyfill`), producer-roster label for the scraper, and the "optional roots and runtimes" config pointer — all revise-in-place.
- **CONTEXT.md**: glossary entries for the usage-model registry and for `agentusage` as a frozen on-disk namespace.

## Best practices

- **Exact-pin `@js-temporal/polyfill` (0.5.1):** Temporal `toJSON`/`toString` formatting changed across the spec's history; a silent version bump can alter serialized reset-time strings and break envelope compatibility.
- **Explicit child cwd + PATH at the spawn site:** launchd strips PATH and the daemon cwd may be `/`; anchor both explicitly, never rely on inherited state.
- **Open content model for config:** deleted keys are read-and-ignored, never errors — deployed configs must keep parsing across the cutover.
