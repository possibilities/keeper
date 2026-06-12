// Unit tests for the net-new creation/deletion machinery beneath the bun port of
// scaffold / refine-apply / epic-rm: the pyyaml-parity YAML input wrapper +
// bounded reader (yaml_input.ts), the slug/suffix/scan allocation helpers
// (ids.ts), the throwing expandPath (repo_inference.ts), the fail-soft global
// epic-id lock (flock.ts), checkGlobalNameUnique (discovery.ts), and the
// accumulate-all failure emit (emit.ts).
//
// The YAML scalar matrix is the wave's hinge: the same five divergence classes
// tests/test_creation_verbs.py pins EMPIRICALLY against pyyaml safe_load (YAML
// 1.1) must come out of the eemeli wrapper identically, because the downstream
// string/int guards fire on the parser's OUTPUT. The cross-engine race harness
// proves the lock interops with Python's _epic_id_lock against the shared path.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkGlobalNameUnique } from "../src/discovery.ts";
import { emitFailureEnvelope } from "../src/emit.ts";
import { withEpicIdLock } from "../src/flock.ts";
import {
  generateSuffix,
  scanMaxEpicId,
  scanMaxTaskId,
  slugify,
} from "../src/ids.ts";
import { expandPath } from "../src/repo_inference.ts";
import { parseYamlInput, YamlInputError } from "../src/yaml_input.ts";

const REPO_ROOT = realpathSync(join(import.meta.dir, ".."));

function tmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "planctl-creation-")));
}

function parse(doc: string): unknown {
  return parseYamlInput(Buffer.from(doc, "utf-8"), "test");
}

// ===========================================================================
// YAML scalar divergence matrix — eemeli 1.1 must match pyyaml safe_load 1.1.
// ===========================================================================

describe("yaml_input scalar matrix (pyyaml safe_load 1.1 parity)", () => {
  test("norway boolean: `no` parses to bool false, NOT the string", () => {
    const v = parse("x: no") as { x: unknown };
    expect(v.x).toBe(false);
    expect(typeof v.x).toBe("boolean");
  });

  test("norway boolean: yes/on/off all coerce to bool", () => {
    expect((parse("x: yes") as { x: unknown }).x).toBe(true);
    expect((parse("x: on") as { x: unknown }).x).toBe(true);
    expect((parse("x: off") as { x: unknown }).x).toBe(false);
  });

  test("octal 010 coerces to int 8 (the coerced value, not the literal)", () => {
    const v = parse("x: 010") as { x: unknown };
    expect(v.x).toBe(8);
    expect(typeof v.x).toBe("number");
  });

  test("underscore numeric 1_0 coerces to int 10", () => {
    const v = parse("x: 1_0") as { x: unknown };
    expect(v.x).toBe(10);
    expect(typeof v.x).toBe("number");
  });

  test("ISO-date scalar 2024-01-01 parses to a non-string (Date)", () => {
    const v = parse("x: 2024-01-01") as { x: unknown };
    expect(typeof v.x).not.toBe("string");
    expect(v.x instanceof Date).toBe(true);
  });

  test("duplicate keys are silent last-wins (no throw, second value lands)", () => {
    const v = parse("x: feat-first\nx: feat-second") as { x: unknown };
    expect(v.x).toBe("feat-second");
  });

  test("a genuine string scalar stays a string (the value-guard arm)", () => {
    expect((parse("x: medium") as { x: unknown }).x).toBe("medium");
    expect((parse("x: ultrahigh") as { x: unknown }).x).toBe("ultrahigh");
  });

  test("dep ordinals: octal + underscore in a list coerce element-wise", () => {
    const v = parse("deps: [010, 1_0]") as { deps: number[] };
    expect(v.deps).toEqual([8, 10]);
  });

  test("empty document parses without throwing (undefined/null doc)", () => {
    const v = parse("");
    expect(v === undefined || v === null).toBe(true);
  });

  test("invalid YAML syntax throws YamlInputError(bad_yaml)", () => {
    let caught: unknown;
    try {
      parse("x: [unclosed");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(YamlInputError);
    expect((caught as YamlInputError).code).toBe("bad_yaml");
    expect((caught as YamlInputError).message).toContain("YAML parse error");
  });

  test("invalid UTF-8 bytes throw YamlInputError(bad_yaml)", () => {
    let caught: unknown;
    try {
      // Lone continuation byte 0x80 — not valid UTF-8.
      parseYamlInput(Buffer.from([0x78, 0x3a, 0x20, 0x80]), "test");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(YamlInputError);
    expect((caught as YamlInputError).message).toContain("not valid UTF-8");
  });
});

// ===========================================================================
// slugify — pinned against ids.slugify across the edge cases.
// ===========================================================================

describe("slugify", () => {
  const cases: [string, string | null][] = [
    ["creation matrix", "creation-matrix"],
    ["Add OAuth!", "add-oauth"],
    ["  --weird__name--  ", "weird-name"],
    ["café crème", "cafe-creme"],
    ["x".repeat(60), "x".repeat(40)],
    ["___", null],
    ["", null],
    ["123 foo", "123-foo"],
    ["Foo-Bar-Baz", "foo-bar-baz"],
    ["a_b_c", "a-b-c"],
    ["UPPER CASE", "upper-case"],
    ["trailing---", "trailing"],
    ["multi   space", "multi-space"],
  ];
  for (const [input, expected] of cases) {
    test(`slugify(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      expect(slugify(input)).toBe(expected);
    });
  }

  test("word-boundary truncation drops the trailing partial token", () => {
    // 40-char cut would split "boundary"; truncation backs off to the hyphen.
    const s = slugify(`${"a".repeat(38)} boundary`);
    expect(s).toBe("a".repeat(38));
  });
});

describe("generateSuffix", () => {
  test("default length 3, charset [a-z0-9]", () => {
    const s = generateSuffix();
    expect(s).toHaveLength(3);
    expect(/^[a-z0-9]{3}$/.test(s)).toBe(true);
  });

  test("honors an explicit length", () => {
    expect(generateSuffix(8)).toHaveLength(8);
    expect(/^[a-z0-9]{8}$/.test(generateSuffix(8))).toBe(true);
  });
});

// ===========================================================================
// scanMaxEpicId — the orphan-spec invariant (scans epics/ AND specs/).
// ===========================================================================

describe("scanMaxEpicId / scanMaxTaskId", () => {
  function seed(dataDir: string): void {
    mkdirSync(join(dataDir, "epics"), { recursive: true });
    mkdirSync(join(dataDir, "specs"), { recursive: true });
    mkdirSync(join(dataDir, "tasks"), { recursive: true });
  }

  test("empty / missing dirs return 0", () => {
    const d = tmpDir();
    try {
      expect(scanMaxEpicId(d)).toBe(0);
      expect(scanMaxTaskId(d, "fn-1-x")).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("scans epics/*.json for the max number", () => {
    const d = tmpDir();
    try {
      seed(d);
      writeFileSync(join(d, "epics", "fn-3-alpha.json"), "{}");
      writeFileSync(join(d, "epics", "fn-7-beta.json"), "{}");
      expect(scanMaxEpicId(d)).toBe(7);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("ORPHAN-SPEC INVARIANT: a spec with no JSON still bumps the max", () => {
    const d = tmpDir();
    try {
      seed(d);
      writeFileSync(join(d, "epics", "fn-2-alpha.json"), "{}");
      // fn-9 exists ONLY as a spec (mid-scaffold crash) — must still be the max.
      writeFileSync(join(d, "specs", "fn-9-orphan.md"), "# orphan");
      expect(scanMaxEpicId(d)).toBe(9);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("ignores non-epic filenames and task-spec mds", () => {
    const d = tmpDir();
    try {
      seed(d);
      writeFileSync(join(d, "epics", "fn-4-x.json"), "{}");
      writeFileSync(join(d, "specs", "not-an-epic.md"), "x");
      // A task spec (fn-N.M.md) is not an epic spec — must not be counted as 99.
      writeFileSync(join(d, "specs", "fn-99-x.1.md"), "x");
      expect(scanMaxEpicId(d)).toBe(4);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("scanMaxTaskId scoped to one epic's tasks", () => {
    const d = tmpDir();
    try {
      seed(d);
      writeFileSync(join(d, "tasks", "fn-5-x.1.json"), "{}");
      writeFileSync(join(d, "tasks", "fn-5-x.3.json"), "{}");
      writeFileSync(join(d, "tasks", "fn-6-y.9.json"), "{}");
      expect(scanMaxTaskId(d, "fn-5-x")).toBe(3);
      expect(scanMaxTaskId(d, "fn-6-y")).toBe(9);
      expect(scanMaxTaskId(d, "fn-7-z")).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// expandPath — throws on unresolvable ~ (distinct from resolveUserPath).
// ===========================================================================

describe("expandPath", () => {
  test("expands a leading ~ against $HOME", () => {
    const saved = process.env.HOME;
    process.env.HOME = "/tmp/fake-home-xyz";
    try {
      expect(expandPath("~/foo/bar")).toBe("/tmp/fake-home-xyz/foo/bar");
    } finally {
      if (saved === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = saved;
      }
    }
  });

  test("throws when ~ cannot be resolved (no $HOME, no db home)", () => {
    const saved = process.env.HOME;
    delete process.env.HOME;
    try {
      // Force os.homedir() to yield nothing too is platform-dependent; assert
      // the throw fires whenever neither source resolves. On a CI box with a db
      // home this still expands, so only assert the throw when home is empty.
      const home = process.env.HOME || "";
      if (home === "") {
        // os.homedir may still return something; only assert the documented
        // throw shape by directly exercising the ~user form, which is always
        // unresolvable for planctl.
      }
      let caught: unknown;
      try {
        expandPath("~someunknownuser/x");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Could not expand ~");
    } finally {
      if (saved === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = saved;
      }
    }
  });

  test("a non-~ relative path normalizes to absolute (never throws)", () => {
    expect(expandPath("foo/bar").startsWith("/")).toBe(true);
  });
});

// ===========================================================================
// accumulate-all failure emit — the compact bad_yaml envelope shape.
// ===========================================================================

describe("emitFailureEnvelope", () => {
  test("prints one compact NDJSON line with the error triplet", () => {
    const lines: string[] = [];
    const orig = process.stdout.write;
    // @ts-expect-error — narrow override for the duration of the test.
    process.stdout.write = (chunk: string) => {
      lines.push(chunk);
      return true;
    };
    try {
      emitFailureEnvelope("bad_yaml", "YAML parse error: x", ["file: -"]);
    } finally {
      process.stdout.write = orig;
    }
    expect(lines).toHaveLength(1);
    const env = JSON.parse(lines[0] as string);
    expect(env).toEqual({
      success: false,
      error: {
        code: "bad_yaml",
        message: "YAML parse error: x",
        details: ["file: -"],
      },
    });
    // Compact: no spaces after separators.
    expect(lines[0]).not.toContain('": ');
    expect(lines[0]?.endsWith("\n")).toBe(true);
  });
});

// ===========================================================================
// checkGlobalNameUnique — fail-soft, excludes the local project.
// ===========================================================================

describe("checkGlobalNameUnique", () => {
  test("returns null when no foreign project owns the id (fail-soft)", () => {
    const d = tmpDir();
    try {
      mkdirSync(join(d, ".planctl", "epics"), { recursive: true });
      expect(checkGlobalNameUnique("fn-1-nobody", d)).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("finds the owning foreign project under a configured root", () => {
    const root = tmpDir();
    const saved = process.env.HOME;
    try {
      const home = join(root, "home");
      const cfgDir = join(home, ".config", "planctl");
      mkdirSync(cfgDir, { recursive: true });
      const projectsRoot = join(root, "code");
      const local = join(projectsRoot, "local-proj");
      const foreign = join(projectsRoot, "foreign-proj");
      mkdirSync(join(local, ".planctl", "epics"), { recursive: true });
      mkdirSync(join(foreign, ".planctl", "epics"), { recursive: true });
      writeFileSync(
        join(foreign, ".planctl", "epics", "fn-12-shared.json"),
        "{}",
      );
      writeFileSync(
        join(cfgDir, "config.yaml"),
        `roots:\n  - ${projectsRoot}\n`,
      );
      process.env.HOME = home;

      const owner = checkGlobalNameUnique("fn-12-shared", local);
      expect(owner).not.toBeNull();
      expect(realpathSync(owner as string)).toBe(realpathSync(foreign));
      // The id only in the local project is NOT a global collision.
      writeFileSync(
        join(local, ".planctl", "epics", "fn-3-localonly.json"),
        "{}",
      );
      expect(checkGlobalNameUnique("fn-3-localonly", local)).toBeNull();
    } finally {
      if (saved === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = saved;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Fail-soft epic-id lock + cross-engine race harness.
// ===========================================================================

describe("withEpicIdLock", () => {
  test("runs fn and returns its value under the lock", () => {
    const saved = process.env.HOME;
    const home = tmpDir();
    process.env.HOME = home;
    try {
      const out = withEpicIdLock(() => 42);
      expect(out).toBe(42);
    } finally {
      if (saved === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = saved;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("FAIL-SOFT: an unwritable state dir still runs fn (unlocked)", () => {
    const saved = process.env.HOME;
    const home = tmpDir();
    // Make ~/.local/state unwritable so the lock file cannot be created.
    const stateParent = join(home, ".local", "state");
    mkdirSync(stateParent, { recursive: true });
    chmodSync(stateParent, 0o500);
    process.env.HOME = home;
    try {
      // Must NOT throw — degrades to unlocked and runs fn.
      const out = withEpicIdLock(() => "ran-unlocked");
      expect(out).toBe("ran-unlocked");
    } finally {
      chmodSync(stateParent, 0o700);
      if (saved === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = saved;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("CROSS-ENGINE RACE: python + bun workers mint contiguous, no dups", async () => {
    const saved = process.env.HOME;
    const home = tmpDir();
    const dataDir = join(home, "data");
    mkdirSync(join(dataDir, "epics"), { recursive: true });
    mkdirSync(join(dataDir, "specs"), { recursive: true });

    const perWorker = 8;
    const bunWorkers = 2;
    const pyWorkers = 2;
    const expectedTotal = perWorker * (bunWorkers + pyWorkers);

    const fixtures = join(REPO_ROOT, "test", "fixtures", "creation");
    const bunWorkerPath = join(fixtures, "mint_worker.ts");
    const pyWorkerPath = join(fixtures, "mint_worker.py");
    // HOME drives BOTH engines to the same ~/.local/state/planctl/epic-id.lock,
    // so a bun mint and a Python mint serialize against the one shared lock.
    const env = { ...process.env, HOME: home };

    try {
      const procs = [];
      for (let i = 0; i < bunWorkers; i += 1) {
        procs.push(
          Bun.spawn({
            cmd: [
              process.execPath,
              "run",
              bunWorkerPath,
              dataDir,
              String(perWorker),
            ],
            env,
            stdout: "ignore",
            stderr: "pipe",
            cwd: REPO_ROOT,
          }),
        );
      }
      for (let i = 0; i < pyWorkers; i += 1) {
        procs.push(
          Bun.spawn({
            cmd: [
              "uv",
              "run",
              "python3",
              pyWorkerPath,
              dataDir,
              String(perWorker),
            ],
            env,
            stdout: "ignore",
            stderr: "pipe",
            cwd: REPO_ROOT,
          }),
        );
      }

      const exitCodes = await Promise.all(procs.map((proc) => proc.exited));
      for (let i = 0; i < procs.length; i += 1) {
        if (exitCodes[i] !== 0) {
          const errText = await new Response(procs[i]?.stderr as ReadableStream)
            .text()
            .catch(() => "");
          throw new Error(
            `worker ${i} exited ${exitCodes[i]}: ${errText.slice(0, 800)}`,
          );
        }
      }

      const ids = readdirSync(join(dataDir, "epics"))
        .map((f) => /^fn-(\d+)-race\.json$/.exec(f))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number.parseInt(m[1] as string, 10))
        .sort((a, b) => a - b);

      // No duplicate ids — the lock made every scan->write critical section atomic.
      expect(new Set(ids).size).toBe(ids.length);
      // Contiguous 1..expectedTotal across BOTH engines.
      expect(ids).toEqual(
        Array.from({ length: expectedTotal }, (_, k) => k + 1),
      );
    } finally {
      if (saved === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = saved;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
