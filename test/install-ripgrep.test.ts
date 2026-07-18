import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INSTALL = readFileSync(
  join(import.meta.dir, "..", "scripts", "install.sh"),
  "utf8",
);

describe("ripgrep installation", () => {
  test("installs or upgrades the Homebrew formula without blocking Keeper setup", () => {
    expect(INSTALL).toContain("command -v brew");
    expect(INSTALL).toContain("brew list --formula ripgrep");
    expect(INSTALL).toContain("brew upgrade ripgrep");
    expect(INSTALL).toContain("brew install ripgrep");
    expect(INSTALL).toContain(
      "ripgrep update failed; leaving existing installation unchanged (non-fatal)",
    );
    expect(INSTALL).toContain("ripgrep install failed (non-fatal)");
  });
});
