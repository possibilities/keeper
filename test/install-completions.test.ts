/**
 * Tests for the completion installer bridge (`scripts/install-completions.ts`).
 * Destination selection and write planning are pure, so every case runs against
 * a per-test temporary home — no real `~`, no linked `keeper` binary, no shell.
 * A fake `generate` supplies fixed script content so the suite never depends on
 * the Clerc generator; one case exercises the real generator end to end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type DestEnv,
  detectBrewPrefix,
  installCompletions,
  planBashDest,
  planCompletionDests,
  planFishDest,
  planZshDest,
  realDirWritable,
  type ShellName,
  writeCompletion,
} from "../scripts/install-completions";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "keeper-install-completions-"));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** An env rooted at the temp home with nothing writable unless told. */
function env(overrides: Partial<DestEnv> = {}): DestEnv {
  return {
    home: tmpHome,
    dirWritable: () => false,
    ...overrides,
  };
}

/** Deterministic per-shell content for idempotency / write-target assertions. */
function fakeGenerate(shell: ShellName): Promise<string> {
  return Promise.resolve(
    `# fake ${shell} completion\nkeeper complete -- "$@"\n`,
  );
}

/** Collect every file path under `dir` (recursively), relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

describe("destination selection", () => {
  test("fish targets the autoloaded user completions dir, no activation note", () => {
    const dest = planFishDest(env());
    expect(dest.path).toBe(
      join(tmpHome, ".config", "fish", "completions", "keeper.fish"),
    );
    expect(dest.activation).toBeNull();
  });

  test("fish honours XDG_CONFIG_HOME", () => {
    const xdg = join(tmpHome, "xdgcfg");
    const dest = planFishDest(env({ xdgConfigHome: xdg }));
    expect(dest.path).toBe(join(xdg, "fish", "completions", "keeper.fish"));
  });

  test("bash targets the XDG bash-completion dir and carries an activation note", () => {
    const dest = planBashDest(env());
    expect(dest.path).toBe(
      join(
        tmpHome,
        ".local",
        "share",
        "bash-completion",
        "completions",
        "keeper",
      ),
    );
    expect(dest.activation).toContain("bash-completion");
  });

  test("bash honours XDG_DATA_HOME", () => {
    const xdg = join(tmpHome, "xdgdata");
    const dest = planBashDest(env({ xdgDataHome: xdg }));
    expect(dest.path).toBe(
      join(xdg, "bash-completion", "completions", "keeper"),
    );
  });

  test("zsh falls back to the user site-functions dir with an fpath note", () => {
    const dest = planZshDest(env());
    expect(dest.path).toBe(
      join(tmpHome, ".local", "share", "zsh", "site-functions", "_keeper"),
    );
    expect(dest.activation).toContain("fpath");
  });

  test("zsh prefers a writable brew site-functions dir with no activation note", () => {
    const brewPrefix = join(tmpHome, "brew");
    const siteFns = join(brewPrefix, "share", "zsh", "site-functions");
    const dest = planZshDest(
      env({ brewPrefix, dirWritable: (d) => d === siteFns }),
    );
    expect(dest.path).toBe(join(siteFns, "_keeper"));
    expect(dest.activation).toBeNull();
  });

  test("zsh ignores a non-writable brew prefix and uses the user dir", () => {
    const brewPrefix = join(tmpHome, "brew");
    const dest = planZshDest(env({ brewPrefix, dirWritable: () => false }));
    expect(dest.path).toBe(
      join(tmpHome, ".local", "share", "zsh", "site-functions", "_keeper"),
    );
    expect(dest.activation).toContain("fpath");
  });

  test("planCompletionDests covers exactly bash, zsh, fish", () => {
    const shells = planCompletionDests(env()).map((d) => d.shell);
    expect(shells.sort()).toEqual(["bash", "fish", "zsh"]);
  });
});

describe("write behavior", () => {
  test("first write creates the file and its parent dir", () => {
    const dest = planFishDest(env());
    const result = writeCompletion(dest, "# content\n");
    expect(result.outcome).toBe("written");
    expect(readFileSync(dest.path, "utf8")).toBe("# content\n");
  });

  test("rewriting identical content is a no-op (idempotent)", () => {
    const dest = planFishDest(env());
    writeCompletion(dest, "# content\n");
    const before = statSync(dest.path).mtimeMs;
    const second = writeCompletion(dest, "# content\n");
    expect(second.outcome).toBe("unchanged");
    expect(readFileSync(dest.path, "utf8")).toBe("# content\n");
    expect(statSync(dest.path).mtimeMs).toBe(before);
  });

  test("changed content overwrites in place, never appends", () => {
    const dest = planFishDest(env());
    writeCompletion(dest, "# old\n");
    const result = writeCompletion(dest, "# new\n");
    expect(result.outcome).toBe("written");
    expect(readFileSync(dest.path, "utf8")).toBe("# new\n");
  });
});

describe("installCompletions", () => {
  test("writes all three shells under the provided home and is idempotent", async () => {
    const first = await installCompletions(env(), fakeGenerate);
    expect(first.map((r) => r.shell).sort()).toEqual(["bash", "fish", "zsh"]);
    expect(first.every((r) => r.outcome === "written")).toBe(true);

    const second = await installCompletions(env(), fakeGenerate);
    expect(second.every((r) => r.outcome === "unchanged")).toBe(true);
  });

  test("writes nothing outside the provided home", async () => {
    await installCompletions(env(), fakeGenerate);
    // Every produced file lives under tmpHome; the planner never escapes it.
    const dests = planCompletionDests(env());
    for (const dest of dests) {
      expect(dest.path.startsWith(tmpHome)).toBe(true);
      expect(existsSync(dest.path)).toBe(true);
    }
    // And the only files created live under the three expected subtrees.
    const created = filesUnder(tmpHome);
    expect(created).toEqual(
      [
        join(".config", "fish", "completions", "keeper.fish"),
        join(".local", "share", "bash-completion", "completions", "keeper"),
        join(".local", "share", "zsh", "site-functions", "_keeper"),
      ].sort(),
    );
  });

  test("edits no shell rc files", async () => {
    // Seed rc files with a sentinel; the installer must leave them byte-identical.
    const rcs = [".zshrc", ".bashrc", ".bash_profile"];
    for (const rc of rcs) writeFileSync(join(tmpHome, rc), "SENTINEL\n");
    mkdirSync(join(tmpHome, ".config", "fish"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".config", "fish", "config.fish"),
      "SENTINEL\n",
    );

    await installCompletions(env(), fakeGenerate);

    for (const rc of rcs) {
      expect(readFileSync(join(tmpHome, rc), "utf8")).toBe("SENTINEL\n");
    }
    expect(
      readFileSync(join(tmpHome, ".config", "fish", "config.fish"), "utf8"),
    ).toBe("SENTINEL\n");
  });

  test("installs the real framework-generated scripts wired to the responder", async () => {
    const results = await installCompletions(env());
    for (const r of results) {
      const body = readFileSync(r.path, "utf8");
      expect(body.length).toBeGreaterThan(0);
      expect(body).toContain("keeper complete --");
    }
  });
});

describe("detectBrewPrefix", () => {
  test("prefers HOMEBREW_PREFIX from the environment", () => {
    expect(detectBrewPrefix({ HOMEBREW_PREFIX: "/custom/brew" })).toBe(
      "/custom/brew",
    );
  });

  test("blank HOMEBREW_PREFIX is ignored, never returned as empty", () => {
    // Falls through to the filesystem probe, which yields a real host brew dir or
    // undefined — never the blank value itself.
    expect(detectBrewPrefix({ HOMEBREW_PREFIX: "  " })).not.toBe("");
    expect(detectBrewPrefix({ HOMEBREW_PREFIX: "  " })).not.toBe("  ");
  });
});

describe("realDirWritable", () => {
  test("true for an existing writable dir, false for a missing one", () => {
    const dir = join(tmpHome, "wr");
    mkdirSync(dir);
    expect(realDirWritable(dir)).toBe(true);
    expect(realDirWritable(join(tmpHome, "nope"))).toBe(false);
  });

  test("false for a file (not a directory)", () => {
    const file = join(tmpHome, "afile");
    writeFileSync(file, "x");
    expect(realDirWritable(file)).toBe(false);
  });
});
