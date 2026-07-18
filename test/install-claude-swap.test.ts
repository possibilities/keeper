import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INSTALL = readFileSync(
  join(import.meta.dir, "..", "scripts", "install.sh"),
  "utf8",
);
const PLIST = readFileSync(
  join(import.meta.dir, "..", "plist", "arthack.keeperd.plist"),
  "utf8",
);

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`missing source boundary: ${start}`);
  return source.slice(from, to);
}

const RETIRED_CLEANUP = between(
  INSTALL,
  "retire_keeper_codexbar_cli() {",
  "# 3d. claude-swap CLI:",
);

describe("mandatory claude-swap installation", () => {
  test("installs or upgrades the stable tool without blocking non-Claude setup", () => {
    expect(INSTALL).toContain("# 3d. claude-swap CLI:");
    expect(INSTALL).toContain("uv tool install --upgrade claude-swap");
    expect(INSTALL).toContain(
      "claude-swap install failed; leaving any existing installation unchanged (non-fatal)",
    );
  });

  test("pins daemon inventory observation to the managed executable", () => {
    expect(PLIST).toContain("<key>KEEPER_CSWAP_BIN</key>");
    expect(PLIST).toContain("<string>/Users/mike/.local/bin/cswap</string>");
  });

  test("retires only the exact Keeper-owned CLI footprint", () => {
    expect(RETIRED_CLEANUP).toContain(`[ -L "\${link}" ]`);
    expect(RETIRED_CLEANUP).toContain(`target="$(readlink "\${link}"`);
    expect(RETIRED_CLEANUP).toContain(
      `"\${root}/current/CodexBarCLI" | "\${root}/CodexBarCLI")`,
    );
    expect(RETIRED_CLEANUP).toContain(`rm -f "\${link}"`);
    expect(RETIRED_CLEANUP).toContain(
      `[ -d "\${root}" ] && [ ! -L "\${root}" ]`,
    );
    expect(RETIRED_CLEANUP).toContain(
      "grep -qx 'signing_identifier=com.arthack.keeper.codexbar-cli'",
    );
    expect(RETIRED_CLEANUP).toContain(`if [ "\${owned}" -eq 1 ]; then`);
    expect(RETIRED_CLEANUP).toContain(`rm -rf "\${root}"`);
    expect(RETIRED_CLEANUP).toContain("preserving foreign codexbar symlink");
    expect(RETIRED_CLEANUP).toContain(
      "preserving non-symlink codexbar executable",
    );
    expect(RETIRED_CLEANUP).toContain(
      "preserving unproven codexbar data directory",
    );
    expect(RETIRED_CLEANUP).not.toContain("brew");
    expect(RETIRED_CLEANUP).not.toContain("/Applications");
  });
});
