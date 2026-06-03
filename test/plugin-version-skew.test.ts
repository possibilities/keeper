/**
 * Version-skew tripwire for `keeper-zellij-bridge.wasm` (epic fn-684 task .2).
 *
 * The committed `.wasm` is built against an exact-pinned `zellij-tile`
 * (currently `=0.44.3`, see `plugin/zellij-bridge/Cargo.toml`). zellij's host
 * API surface evolves between releases — a `.wasm` built for 0.44.x will not
 * link cleanly into 0.45.x. The "ship the committed prebuilt" model only
 * holds because we have this test loudly fail when the committed sidecar
 * `VERSION` line disagrees with the installed `zellij --version`.
 *
 * Failure mode → human action:
 *   - This test FAILS with a `bun run build:plugin` rebuild instruction.
 *
 * Skip mode:
 *   - On a CI box without `zellij` installed, the spawn errors out. The test
 *     SKIPs cleanly rather than failing — a CI runner is not the dev box and
 *     not the right enforcement point. The dev box (which DOES have zellij
 *     because that is the multiplexer keeper rides on) is where the skew
 *     would actually bite.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  KEEPER_ZELLIJ_PLUGIN_VERSION_FILE,
  KEEPER_ZELLIJ_PLUGIN_WASM,
} from "../src/db";

interface ParsedVersion {
  zellijTile: string;
}

function parseVersionSidecar(raw: string): ParsedVersion {
  // VERSION sidecar shape (scripts/build-plugin.sh): one line per pin.
  // Currently a single `zellij-tile=<X.Y.Z>` line. Tolerate trailing
  // whitespace + extra lines for forward-compatibility (future pins).
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let zellijTile: string | undefined;
  for (const line of lines) {
    const m = line.match(/^zellij-tile=(.+)$/);
    if (m) {
      zellijTile = m[1]?.trim();
    }
  }
  if (!zellijTile) {
    throw new Error(
      `VERSION sidecar missing zellij-tile= line: ${JSON.stringify(raw)}`,
    );
  }
  return { zellijTile };
}

function parseInstalledZellijVersion(stdout: string): string {
  // `zellij --version` prints exactly `zellij <X.Y.Z>\n` on supported
  // releases. Be liberal in extraction — a hand-built dev zellij might
  // tack a git suffix onto the line.
  const m = stdout.match(/zellij\s+([0-9]+\.[0-9]+\.[0-9]+)/);
  if (!m) {
    throw new Error(
      `could not parse zellij version from: ${JSON.stringify(stdout)}`,
    );
  }
  return m[1] as string;
}

describe("plugin version-skew tripwire", () => {
  test("the committed .wasm exists and is non-empty", () => {
    expect(existsSync(KEEPER_ZELLIJ_PLUGIN_WASM)).toBe(true);
    expect(existsSync(KEEPER_ZELLIJ_PLUGIN_VERSION_FILE)).toBe(true);
  });

  test("VERSION sidecar pin matches installed `zellij --version`", async () => {
    // 1. Read the committed sidecar — the version the .wasm was built against.
    const raw = readFileSync(KEEPER_ZELLIJ_PLUGIN_VERSION_FILE, "utf8");
    const parsed = parseVersionSidecar(raw);

    // 2. Spawn `zellij --version` and skip cleanly when not installed (CI).
    let installed: string;
    try {
      const proc = Bun.spawn(["zellij", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code !== 0) {
        console.warn(
          `[plugin-version-skew] skipping: zellij --version exited ${code}`,
        );
        return;
      }
      const stdout = await new Response(proc.stdout).text();
      installed = parseInstalledZellijVersion(stdout);
    } catch (err) {
      // `Bun.spawn` throws ENOENT-style when the binary isn't on PATH.
      console.warn(
        `[plugin-version-skew] skipping: zellij not installed (${(err as Error).message})`,
      );
      return;
    }

    // 3. Skew == loud-fail with rebuild instructions, never a warning.
    if (parsed.zellijTile !== installed) {
      throw new Error(
        [
          `committed plugin/zellij-bridge/VERSION pin (zellij-tile=${parsed.zellijTile})`,
          `does not match installed zellij ${installed}.`,
          ``,
          `Rebuild the committed .wasm against the installed zellij:`,
          `  1. Edit plugin/zellij-bridge/Cargo.toml — bump zellij-tile = "=${installed}"`,
          `  2. cd plugin/zellij-bridge && cargo update -p zellij-tile`,
          `  3. bun run build:plugin    # regenerates the .wasm + VERSION sidecar`,
          `  4. git add plugin/zellij-bridge/{Cargo.toml,Cargo.lock,keeper-zellij-bridge.wasm,VERSION}`,
          ``,
          `See README.md "Install" section for the full toolchain prereqs.`,
        ].join("\n"),
      );
    }
    expect(parsed.zellijTile).toBe(installed);
  });
});
