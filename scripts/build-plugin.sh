#!/usr/bin/env bash
#
# scripts/build-plugin.sh — build the committed `keeper-zellij-bridge.wasm`.
#
# Wired into `package.json` as `bun run build:plugin`. Produces TWO files at
# the stable, committed path the dotfiles cross-repo byte-match contract
# references via `keeper plugin-path`:
#
#   plugin/zellij-bridge/keeper-zellij-bridge.wasm   (size-optimised wasm)
#   plugin/zellij-bridge/VERSION                     (sidecar — see below)
#
# The path is a CONTRACT. The dotfiles `config.kdl` `load_plugins { "file:..." }`
# URL and `~/.cache/zellij/permissions.kdl` URL must byte-match it; they pull
# the value from `keeper plugin-path` so there is exactly one source of truth.
# Never rename / move it without coordinating with dotfiles.
#
# Prereqs (for REBUILDS only — installs/runtime need neither; the .wasm is
# committed):
#   - Rust toolchain with the `wasm32-wasip1` target (script auto-adds it).
#   - binaryen's `wasm-opt` for the `-Oz` pass. NOT installed by default on
#     the dev box (`brew install binaryen`). When `wasm-opt` is missing the
#     script warns and ships the unoptimised cargo output verbatim — that is
#     CORRECT behavior for fresh dev boxes: the artifact is still functional,
#     just larger. CI / release builds should install binaryen.
#
# The VERSION sidecar carries one line:
#
#   zellij-tile=<X.Y.Z>
#
# read from the committed `Cargo.lock` (deterministic). `test/plugin-version-
# skew.test.ts` reads the sidecar and the host's `zellij --version` and fails
# loudly when they disagree — the tripwire that keeps the "committed prebuilt"
# story honest across zellij upgrades.

set -euo pipefail

# Resolve repo root from this script's location so `bun run build:plugin`
# works regardless of cwd.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
PLUGIN_DIR="$REPO_ROOT/plugin/zellij-bridge"
OUT_WASM="$PLUGIN_DIR/keeper-zellij-bridge.wasm"
OUT_VERSION="$PLUGIN_DIR/VERSION"

cd "$PLUGIN_DIR"

# 1. Idempotent target add — `rustup` exits 0 even when the target is
#    already installed, so this is cheap on every run.
if ! command -v rustup >/dev/null 2>&1; then
  echo "[build:plugin] error: rustup not on PATH — install the Rust toolchain (https://rustup.rs)" >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "[build:plugin] error: cargo not on PATH — install the Rust toolchain (https://rustup.rs)" >&2
  exit 1
fi
echo "[build:plugin] ensuring wasm32-wasip1 target …"
rustup target add wasm32-wasip1 >/dev/null

# 2. Release build against the host preview1 target.
echo "[build:plugin] cargo build --release --target wasm32-wasip1 …"
cargo build --release --target wasm32-wasip1

# Binary crate (see Cargo.toml `[[bin]]`): cargo names the artifact after the
# bin target (`keeper-zellij-bridge`, hyphens preserved), NOT the underscore
# lib-crate form. A binary is required so the wasm exports `_start`.
CARGO_OUT="$PLUGIN_DIR/target/wasm32-wasip1/release/keeper-zellij-bridge.wasm"
if [ ! -f "$CARGO_OUT" ]; then
  echo "[build:plugin] error: expected cargo output not found at $CARGO_OUT" >&2
  exit 1
fi

# 3. Size-optimise with wasm-opt when binaryen is available. If not, copy the
#    raw cargo output and emit a loud-but-non-fatal warning — the committed
#    artifact is still functional, just larger. The acceptance criterion is
#    "guarded OR documented"; this is the guard.
if command -v wasm-opt >/dev/null 2>&1; then
  echo "[build:plugin] wasm-opt -Oz $CARGO_OUT -> $OUT_WASM"
  # Modern rustc emits bulk-memory opcodes (`memory.copy`/`memory.fill`)
  # against the wasm32-wasip1 target — wasm-opt rejects them by default
  # since v110+. The features are universally supported by every modern
  # wasm runtime (including the wasmtime build vendored into zellij),
  # so allow-list them so `wasm-opt` validates and round-trips the file.
  wasm-opt -Oz \
    --enable-bulk-memory \
    --enable-sign-ext \
    "$CARGO_OUT" -o "$OUT_WASM"
else
  echo "[build:plugin] WARNING: wasm-opt not on PATH — shipping unoptimised cargo output." >&2
  echo "[build:plugin] WARNING: install binaryen for size-optimised builds: brew install binaryen" >&2
  cp -f "$CARGO_OUT" "$OUT_WASM"
fi

# 4. Emit the VERSION sidecar from the committed Cargo.lock so the test
#    tripwire reads a value the build itself produced (not an env probe).
#    The lock pins `zellij-tile` exactly (= "=0.44.3"); we grep its version
#    line from the lockfile to keep the script dependency-free.
ZELLIJ_TILE_VERSION=$(awk '
  /^\[\[package\]\]/ { in_pkg = 1; name = ""; version = ""; next }
  in_pkg && /^name = "zellij-tile"$/ { name = "zellij-tile"; next }
  in_pkg && /^version = / {
    version = $0
    sub(/^version = "/, "", version)
    sub(/"$/, "", version)
    if (name == "zellij-tile") { print version; exit }
  }
  /^$/ { in_pkg = 0 }
' "$PLUGIN_DIR/Cargo.lock")

if [ -z "$ZELLIJ_TILE_VERSION" ]; then
  echo "[build:plugin] error: could not extract zellij-tile version from Cargo.lock" >&2
  exit 1
fi

printf 'zellij-tile=%s\n' "$ZELLIJ_TILE_VERSION" > "$OUT_VERSION"
echo "[build:plugin] wrote $OUT_VERSION (zellij-tile=$ZELLIJ_TILE_VERSION)"

# 5. Report the final artifact for the human / CI log.
WASM_SIZE=$(wc -c < "$OUT_WASM" | tr -d ' ')
echo "[build:plugin] done: $OUT_WASM (${WASM_SIZE} bytes)"
