import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONF = readFileSync(
  join(import.meta.dir, "..", "tmux", "keeper-notes.conf"),
  "utf8",
);

const BINDINGS = CONF.split("\n").filter((line) => line.startsWith("bind-key"));

describe("keeper-notes.conf content", () => {
  test("binds exactly the prefix-table Note capture and browse keys", () => {
    expect(BINDINGS).toHaveLength(2);
    expect(BINDINGS[0]).toContain("-N 'Capture a Keeper note' N display-popup");
    expect(BINDINGS[1]).toContain("-N 'Browse Keeper notes' B display-popup");
  });

  test("both popups keep geometry and the caller pane cwd", () => {
    for (const line of BINDINGS) {
      expect(line).toContain("display-popup -E -w 90% -h 90%");
      expect(line).toContain("-d '#{pane_current_path}'");
    }
  });

  test("capture skips recovery while browse opens the Note list", () => {
    expect(BINDINGS[0]).toContain("keeper note new --fresh");
    expect(BINDINGS[1]).toContain("keeper note browse");
  });

  test("a failed command waits for acknowledgement before the popup closes", () => {
    for (const line of BINDINGS) {
      expect(line).toContain("code=$?");
      expect(line).toContain("IFS= read -r _");
      expect(line).toContain('exit "$code"');
    }
  });
});
