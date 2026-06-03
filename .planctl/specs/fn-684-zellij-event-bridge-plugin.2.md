## Description

**Size:** S
**Files:** plugin/zellij-bridge/Cargo.toml, plugin/zellij-bridge/Cargo.lock, the committed .wasm artifact, package.json, scripts/, cli/keeper.ts + cli/plugin.ts (new `plugin-path` subcommand), src/db.ts (canonical path constant), test/plugin-version-skew.test.ts, README.md (install)

### Approach

Wire the first Rust build into a Bun/TS+Python repo without making Rust a runtime dependency. Add `bun run build:plugin` = `rustup target add wasm32-wasip1` (idempotent guard) + `cargo build --release --target wasm32-wasip1` + `wasm-opt -Oz`, emitting the artifact to a STABLE committed path `plugin/zellij-bridge/keeper-zellij-bridge.wasm` plus a sidecar `VERSION` file. `wasm-opt` ships in `binaryen` — guard the script (or loudly document the prereq; `binaryen` is NOT installed on the dev box by default). This path is the permission-cache URL identity (referenced by dotfiles in task 4) and must never move. Commit both `Cargo.lock` (exact `zellij-tile` pin) and the built `.wasm`.

**Expose the canonical path as a single source of truth.** Add a constant (e.g. `KEEPER_ZELLIJ_PLUGIN_WASM`, resolved via `new URL("../plugin/zellij-bridge/keeper-zellij-bridge.wasm", import.meta.url)`) AND a `keeper plugin-path` subcommand — register it in `cli/keeper.ts` (`SUBCOMMANDS` + `USAGE` + the dispatch handlers map) backed by a tiny `cli/plugin.ts` main that prints the absolute path to stdout and exits 0. Dotfiles references `keeper plugin-path` instead of hardcoding the abs path in `config.kdl` / `permissions.kdl`, so the cross-repo byte-match contract (committed file, config.kdl URL, permissions.kdl URL) has one keeper-owned source.

Add `test/plugin-version-skew.test.ts`: read the installed `zellij --version`, read the version the committed `.wasm` was built against (the `VERSION` sidecar / an `env!`-embedded string), and fail loudly with rebuild instructions when they drift — the tripwire that makes "committed prebuilt" safe across zellij upgrades.

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/keeper/package.json — scripts + bin sections (no Rust precedent today)
- /Users/mike/code/keeper/cli/keeper.ts — SUBCOMMANDS / USAGE / dispatch handlers map (where `plugin-path` registers)
- /Users/mike/code/keeper/src/db.ts:356 — resolveDeadLetterDir pattern (sibling spot for a canonical-path constant)
- /Users/mike/code/keeper/CLAUDE.md — commit-work lint matrix + schema invariants (so the new test/artifact pass commit-work)

**Optional** (reference as needed):
- /Users/mike/code/keeper/src/daemon.ts — `new URL("./x.ts", import.meta.url)` asset-resolution idiom (analogous resolution for the .wasm path)
- /Users/mike/code/keeper/test/keeper-cli.test.ts — dispatch-routing test pattern for the new `plugin-path` handler

### Risks

- Stale committed `.wasm` after a zellij upgrade — the version-skew test is the deliberate tripwire; without it, agents silently run old join logic.
- Build env lacks Rust / binaryen — acceptable because the committed artifact means runtime/install needs neither; document the toolchain only for rebuilds.

### Test notes

`test/plugin-version-skew.test.ts` asserts committed-vs-installed version match. Confirm `bun run build:plugin` is reproducible and emits both the `.wasm` and its `VERSION` sidecar. Add a `cli/keeper.ts` dispatch test asserting `keeper plugin-path` prints the absolute committed path (mirror `test/keeper-cli.test.ts`).

## Acceptance

- [ ] `bun run build:plugin` produces the committed `.wasm` (size-optimized) + a version sidecar, reproducibly; the `binaryen`/`wasm-opt` prereq is guarded or documented
- [ ] `Cargo.lock` + the `.wasm` are committed at a stable, documented path
- [ ] `keeper plugin-path` prints the canonical absolute `.wasm` path — the single source of truth for the dotfiles byte-match contract
- [ ] The version-skew test fails loudly (with rebuild instructions) when the committed `.wasm` drifts from the installed zellij, and passes when aligned
- [ ] README install section documents the Rust + `binaryen` prereq for rebuilds and the `build:plugin` step

## Done summary
Wired the first Rust build into keeper as 'bun run build:plugin' (rustup target add + cargo --release + wasm-opt -Oz, with binaryen-missing fallback) producing the committed plugin/zellij-bridge/keeper-zellij-bridge.wasm + Cargo.lock-derived VERSION sidecar, exposed the canonical path as the KEEPER_ZELLIJ_PLUGIN_WASM constant + 'keeper plugin-path' subcommand so dotfiles consume one source of truth for the cross-repo byte-match contract, and added the version-skew tripwire test that fails loudly with rebuild instructions on drift (skips when zellij is absent).
## Evidence
