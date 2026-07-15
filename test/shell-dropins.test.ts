import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("Keeper tmux shell drop-ins", () => {
  test("tmux stamps the fixed zsh drop-in marker", () => {
    const conf = readFileSync("tmux/keeper-shell.conf", "utf8");
    expect(conf).toContain("set-environment -g KEEPER_ZSH_DROPINS 1");
    expect(conf).not.toContain("DROPDIR");
  });

  test("Claude alias matrix routes directly through Keeper account indices", () => {
    const matrix = readFileSync("shell/zsh/claude-matrix.zsh", "utf8");
    expect(matrix).toContain("keeper agent claude --x-account");
    expect(matrix).toContain("keeper agent claude --model");
    expect(matrix).toContain("--effort");
    expect(matrix).not.toContain("--x-profile");
    expect(matrix).not.toContain("alias claude=");
    expect(matrix).toContain("unfunction _keeper_define_claude_matrix");
  });
});
