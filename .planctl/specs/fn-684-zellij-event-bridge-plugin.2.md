## Description

**Size:** S
**Files:** plugin/zellij-bridge/Cargo.toml, plugin/zellij-bridge/Cargo.lock, the committed .wasm artifact, package.json, scripts/, test/plugin-version-skew.test.ts, README.md (install)

### Approach

Wire the first Rust build into a Bun/TS+Python repo without making Rust a runtime dependency. Add `bun run build:plugin` = `rustup target add wasm32-wasip1` (idempotent guard) + `cargo build --release --target wasm32-wasip1` + `wasm-opt -Oz`, emitting the artifact to a STABLE committed path (e.g. `plugin/zellij-bridge/keeper-zellij-bridge.wasm`). This path is the permission-cache URL identity (task 4) and must never move. Commit both `Cargo.lock` (exact `zellij-tile` pin) and the built `.wasm`. Add `test/plugin-version-skew.test.ts`: read the installed `zellij --version`, read the version the committed `.wasm` was built against (embed via `env!`/a sidecar `VERSION` file written by `build:plugin`), and fail loudly with rebuild instructions when they drift — this is the tripwire that makes "committed prebuilt" safe across zellij upgrades.

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/keeper/package.json — scripts section (no Rust precedent today)
- /Users/mike/code/keeper/CLAUDE.md — commit-work lint matrix + schema invariants (so the new test/artifact pass commit-work)

**Optional** (reference as needed):
- /Users/mike/code/keeper/src/daemon.ts — `new URL("./x.ts", import.meta.url)` asset-resolution idiom (analogous resolution for the .wasm path)

### Risks

- Stale committed `.wasm` after a zellij upgrade — the version-skew test is the deliberate tripwire; without it, agents silently run old join logic.
- Build env lacks Rust — acceptable because the committed artifact means runtime/install needs none; document the toolchain only for rebuilds.

### Test notes

`test/plugin-version-skew.test.ts` asserts committed-vs-installed version match. Confirm `bun run build:plugin` is reproducible and emits both the `.wasm` and its `VERSION` sidecar.

## Acceptance

- [ ] `bun run build:plugin` produces the committed `.wasm` (size-optimized) + a version sidecar, reproducibly
- [ ] `Cargo.lock` + the `.wasm` are committed at a stable, documented path
- [ ] The version-skew test fails loudly (with rebuild instructions) when the committed `.wasm` drifts from the installed zellij, and passes when aligned
- [ ] README install section documents the Rust prereq for rebuilds and the `build:plugin` step

## Done summary

## Evidence
