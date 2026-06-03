/**
 * Dispatch + handler tests for `cli/plugin.ts` (the `keeper plugin-path`
 * subcommand). Mirrors the harness style of `test/keeper-cli.test.ts`:
 * injected sinks + a thrower exit shim so the test never spawns a
 * subprocess.
 *
 * The dispatcher routing case (a `plugin-path` token reaches the registered
 * handler) is already covered by the for-loop over `SUBCOMMANDS` in
 * `test/keeper-cli.test.ts`. This file covers the handler's own contract:
 * print the absolute path + LF on argv-empty, exit 1 with HELP on unknown
 * trailing arg, exit 0 with HELP on `--help` / `-h`. Plus a sanity check
 * that the LIVE constant from `src/db.ts` resolves to a real file at the
 * documented committed path.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { HELP, type PluginPathDeps, runPluginPath } from "../cli/plugin";
import { KEEPER_ZELLIJ_PLUGIN_WASM } from "../src/db";

class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

interface Harness {
  stdout: string[];
  stderr: string[];
  deps: PluginPathDeps;
}

function makeHarness(
  pluginPath = "/fixture/path/keeper-zellij-bridge.wasm",
): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: PluginPathDeps = {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    exit: (code) => {
      throw new ExitError(code);
    },
    pluginPath,
  };
  return { stdout, stderr, deps };
}

describe("cli/plugin runPluginPath", () => {
  test("bare invocation prints the absolute path + LF and exits 0", () => {
    const h = makeHarness("/canonical/keeper-zellij-bridge.wasm");
    let caught: unknown;
    try {
      runPluginPath([], h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(0);
    expect(h.stdout.join("")).toBe("/canonical/keeper-zellij-bridge.wasm\n");
    expect(h.stderr).toEqual([]);
  });

  test("--help prints HELP to stdout and exits 0", () => {
    const h = makeHarness();
    let caught: unknown;
    try {
      runPluginPath(["--help"], h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(0);
    expect(h.stdout.join("")).toBe(HELP);
    expect(h.stderr).toEqual([]);
  });

  test("-h is a --help alias", () => {
    const h = makeHarness();
    try {
      runPluginPath(["-h"], h.deps);
    } catch {
      // swallow ExitError
    }
    expect(h.stdout.join("")).toBe(HELP);
  });

  test("unknown trailing arg prints HELP to stderr and exits 1", () => {
    const h = makeHarness();
    let caught: unknown;
    try {
      runPluginPath(["/some/other/path"], h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(1);
    const err = h.stderr.join("");
    expect(err).toContain("unexpected argument '/some/other/path'");
    expect(err).toContain(HELP);
    expect(h.stdout).toEqual([]);
  });
});

describe("KEEPER_ZELLIJ_PLUGIN_WASM constant", () => {
  test("resolves to an absolute path under plugin/zellij-bridge/", () => {
    // Absolute path (Bun's `new URL(..., import.meta.url).pathname` returns
    // an absolute POSIX path on macOS/Linux).
    expect(KEEPER_ZELLIJ_PLUGIN_WASM.startsWith("/")).toBe(true);
    // Path identity contract: the basename is FROZEN. Dotfiles
    // `config.kdl` + `permissions.kdl` byte-match against this. Renaming
    // the file silently breaks the cross-repo contract.
    expect(
      KEEPER_ZELLIJ_PLUGIN_WASM.endsWith(
        "/plugin/zellij-bridge/keeper-zellij-bridge.wasm",
      ),
    ).toBe(true);
  });

  test("points at the committed .wasm artifact (which exists and is non-empty)", () => {
    // The artifact is committed; if a future change unintentionally moves
    // it out from under the constant, this test catches it before the
    // dotfiles contract silently breaks.
    expect(existsSync(KEEPER_ZELLIJ_PLUGIN_WASM)).toBe(true);
    const stat = statSync(KEEPER_ZELLIJ_PLUGIN_WASM);
    expect(stat.isFile()).toBe(true);
    // wasm files always start with `\0asm` magic — and a real keeper bridge
    // is hundreds of KB. A 0-byte file would mean a botched build was
    // committed.
    expect(stat.size).toBeGreaterThan(1024);
  });
});
