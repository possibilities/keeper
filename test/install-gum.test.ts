import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INSTALL = readFileSync(
  join(import.meta.dir, "..", "scripts", "install.sh"),
  "utf8",
);

describe("scripts/install.sh Gum dependency", () => {
  test("installs Gum when the Homebrew formula is absent", () => {
    expect(INSTALL).toContain("brew list --formula gum");
    expect(INSTALL).toContain("brew install gum");
  });

  test("upgrades an existing Gum formula on every Keeper install", () => {
    expect(INSTALL).toContain("brew upgrade gum");
    expect(INSTALL).toContain('echo "install: $(gum --version)"');
  });

  test("fails loud rather than leaving the shipped Note binding broken", () => {
    expect(INSTALL).toContain(
      "Homebrew is required to install the Gum Note writer",
    );
    expect(INSTALL).toContain(
      "Gum installation completed but 'gum' is not on PATH",
    );
  });
});
