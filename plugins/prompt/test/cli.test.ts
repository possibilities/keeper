// Dispatcher contract for `keeper prompt`: top-level `--help` exits 0 with a
// Commands section, an unknown verb exits 2 (click no-such-command), and every
// keep-verb the epic acceptance pins is registered. The runners themselves land
// in the verb-port tasks; here the stub returns the not-implemented envelope +
// exit 1, which is the wiring proof — the verb is reachable and owns its exit.
//
// `main()` writes to process.stdout/stderr and the no-such-command / usage paths
// call process.exit, so these drive main() with those globals captured (exit →
// a tagged throw so the never-return branches stop).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { main, positional } from "../src/cli.ts";
import { PROMPT_COMMANDS } from "../src/descriptor.ts";

// These probes drive real verb runners with no args purely to prove dispatch
// wiring. Pin the corpus fallback at an empty tmpdir so a verb that resolves the
// project root (build-snippets, render-plugin-templates, …) finds no corpus and
// no-ops fast, instead of scanning whatever ambient corpus the dev box happens to
// hold. Keeps the contract hermetic and quick.
let corpusHome: string;
const savedCorpusEnv = process.env.KEEPER_PROMPT_CORPUS_ROOT;

beforeAll(() => {
  corpusHome = mkdtempSync(join(tmpdir(), "kp-cli-corpus-"));
  process.env.KEEPER_PROMPT_CORPUS_ROOT = corpusHome;
});

afterAll(() => {
  rmSync(corpusHome, { recursive: true, force: true });
  if (savedCorpusEnv === undefined) {
    delete process.env.KEEPER_PROMPT_CORPUS_ROOT;
  } else {
    process.env.KEEPER_PROMPT_CORPUS_ROOT = savedCorpusEnv;
  }
});

class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

interface Run {
  /** Return value of main(), or undefined when it exited via process.exit. */
  ret: number | undefined;
  /** Captured process.exit code, or undefined when main() returned normally. */
  code: number | undefined;
  stdout: string;
  stderr: string;
}

function run(argv: string[]): Run {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const realExit = process.exit.bind(process);
  let code: number | undefined;
  let ret: number | undefined;
  process.stdout.write = ((s: string | Uint8Array) => {
    out.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    err.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new ExitError(code);
  }) as typeof process.exit;
  try {
    ret = main(argv);
  } catch (e) {
    if (!(e instanceof ExitError)) {
      throw e;
    }
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.exit = realExit;
  }
  return { ret, code, stdout: out.join(""), stderr: err.join("") };
}

const KEEP_VERBS = [
  "render",
  "check-generated",
  "compile",
  "render-plugin-templates",
  "find-snippets",
  "build-snippets",
  "save-snippet",
  "save-bundle",
  "validate-bundles",
  "list-bundles",
  "list-snippets",
  "show-bundle",
];

// Verbs whose runner has landed (no longer the not-implemented stub). Their
// registration proof is that the dispatcher routes them to their runner instead
// of the no-such-command (exit 2) path.
const PORTED_VERBS = new Set([
  "render",
  "check-generated",
  "compile",
  "render-plugin-templates",
  "build-snippets",
  "find-snippets",
  "save-snippet",
  "save-bundle",
  "validate-bundles",
  "list-bundles",
  "list-snippets",
  "show-bundle",
]);
const STUB_VERBS = KEEP_VERBS.filter((v) => !PORTED_VERBS.has(v));

describe("keeper prompt dispatcher contract", () => {
  test("--help prints the Commands section to stdout and returns 0", () => {
    const r = run(["--help"]);
    expect(r.ret).toBe(0);
    expect(r.code).toBeUndefined();
    expect(r.stdout).toContain("Usage: keeper prompt");
    expect(r.stdout).toContain("Commands:");
    for (const verb of KEEP_VERBS) {
      expect(r.stdout).toContain(verb);
    }
    expect(r.stderr).toBe("");
  });

  test("bare invocation (no command) prints help, returns 0", () => {
    const r = run([]);
    expect(r.ret).toBe(0);
    expect(r.stdout).toContain("Commands:");
  });

  test("--agent-help prints the operator runbook to stdout and returns 0", () => {
    const r = run(["--agent-help"]);
    expect(r.ret).toBe(0);
    expect(r.code).toBeUndefined();
    // Content assertion (catches an empty stub): names its primary verb form.
    expect(r.stdout).toContain("operator runbook");
    expect(r.stdout).toContain("keeper prompt render");
    // Pure: no verb body ran, so no corpus read faults reach stderr.
    expect(r.stderr).toBe("");
  });

  test("an unknown verb errors on stderr and exits 2", () => {
    const r = run(["bogus-verb"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No such command 'bogus-verb'.");
    expect(r.stdout).toBe("");
  });

  test("an unknown top-level option exits 2", () => {
    const r = run(["--nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No such option: --nope");
  });

  test("an invalid --format value exits 2", () => {
    const r = run(["--format", "xml", "render", "foo"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid value for '--format'");
  });

  test.each([
    {
      name: "unknown flag",
      argv: ["compile", "--bundle", "plan:static", "--target", "pi", "--nope"],
      message: "No such option for compile: --nope",
    },
    {
      name: "positional",
      argv: ["compile", "plan:static", "--target", "pi"],
      message: "does not accept positional argument",
    },
    {
      name: "terminal agent-dir",
      argv: [
        "compile",
        "--bundle",
        "plan:static",
        "--target",
        "pi",
        "--agent-dir",
      ],
      message: "--agent-dir requires a non-empty value",
    },
    {
      name: "empty agent-dir",
      argv: [
        "compile",
        "--bundle",
        "plan:static",
        "--target",
        "pi",
        "--agent-dir=",
      ],
      message: "--agent-dir requires a non-empty value",
    },
    {
      name: "empty scope",
      argv: ["compile", "--bundle=", "--target", "pi"],
      message: "--bundle requires a non-empty value",
    },
    {
      name: "conflicting scopes",
      argv: [
        "compile",
        "--bundle",
        "plan:static",
        "--role",
        "plan:repo-scout",
        "--target",
        "pi",
      ],
      message: "exactly one of --bundle or --role",
    },
    {
      name: "missing scope",
      argv: ["compile", "--target", "pi"],
      message: "exactly one of --bundle or --role",
    },
    {
      name: "missing target",
      argv: ["compile", "--bundle", "plan:static"],
      message: "requires --target",
    },
    {
      name: "unsupported target",
      argv: ["compile", "--bundle", "plan:static", "--target", "codex"],
      message: "does not support target 'codex'",
    },
    {
      name: "Claude with Pi-only agent-dir",
      argv: [
        "compile",
        "--role",
        "work:worker",
        "--target",
        "claude",
        "--agent-dir",
        "/tmp/pi",
      ],
      message: "--agent-dir is Pi-only",
    },
  ])("compile rejects $name", ({ argv, message }) => {
    const r = run([...argv]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(message);
  });

  test("compile accepts exactly its advertised flags and publishes through the real CLI", () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const root = mkdtempSync(join(tmpdir(), "kp-cli-compile-"));
    const config = join(root, "config");
    const agentDir = join(root, "pi-agent");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, "matrix.yaml"),
      readFileSync(join(repoRoot, "docs", "examples", "matrix.example.yaml")),
    );
    const saved = process.env.KEEPER_CONFIG_DIR;
    process.env.KEEPER_CONFIG_DIR = config;
    try {
      const r = run([
        "compile",
        "--bundle",
        "plan:static",
        "--target",
        "pi",
        "--project-root",
        repoRoot,
        "--agent-dir",
        agentDir,
      ]);
      expect(r.ret).toBe(0);
      expect(r.code).toBeUndefined();
      expect(r.stderr).toBe("");
      const parsed = JSON.parse(r.stdout) as {
        outputs: Array<Record<string, unknown>>;
      };
      expect(parsed).toMatchObject({
        target: "pi",
        ok: true,
        request: { kind: "bundle", name: "plan:static" },
      });
      expect(
        parsed.outputs.find((row) => row.role === "plan:repo-scout"),
      ).toMatchObject({
        thinking: "high",
        max_turns: 60,
      });
      expect(
        statSync(join(agentDir, "agents", ".keeper-plan-agents.json")).isFile(),
      ).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.KEEPER_CONFIG_DIR;
      else process.env.KEEPER_CONFIG_DIR = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check-generated honors a validated compiler regenerate command", () => {
    const root = mkdtempSync(join(tmpdir(), "kp-check-generated-command-"));
    const primary = join(root, "workers", "cell", "agents", "worker.md");
    mkdirSync(dirname(primary), { recursive: true });
    mkdirSync(join(root, ".git"));
    writeFileSync(primary, "worker\n");
    writeFileSync(
      `${primary}.managed-file-dont-edit`,
      JSON.stringify({
        source_template: "plugins/plan/template/agents/worker.md.tmpl",
        sha256: "0".repeat(64),
        regenerate_cmd:
          "keeper prompt compile --role work:worker --target claude",
      }),
    );
    try {
      const checked = run(["check-generated", primary, "--on", "read"]);
      expect(JSON.parse(checked.stdout)).toMatchObject({
        marked: true,
        regenerate_cmd:
          "keeper prompt compile --role work:worker --target claude",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("compile accepts Claude with a plan-plugin project root", () => {
    const liveRoot = resolve(import.meta.dir, "../../..");
    const root = mkdtempSync(join(tmpdir(), "kp-cli-claude-"));
    const planRoot = join(root, "plugins", "plan");
    const config = join(root, "config");
    mkdirSync(planRoot, { recursive: true });
    mkdirSync(config, { recursive: true });
    mkdirSync(join(root, ".git"));
    cpSync(
      join(liveRoot, "plugins", "plan", "template"),
      join(planRoot, "template"),
      { recursive: true },
    );
    cpSync(
      join(liveRoot, "plugins", "plan", "prompt-artifacts.yaml"),
      join(planRoot, "prompt-artifacts.yaml"),
    );
    writeFileSync(
      join(config, "matrix.yaml"),
      readFileSync(join(liveRoot, "docs", "examples", "matrix.example.yaml")),
    );
    const saved = process.env.KEEPER_CONFIG_DIR;
    process.env.KEEPER_CONFIG_DIR = config;
    try {
      const r = run([
        "compile",
        "--bundle",
        "plan:work",
        "--target",
        "claude",
        "--project-root",
        planRoot,
      ]);
      expect(r.ret).toBe(0);
      expect(r.code).toBeUndefined();
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout)).toMatchObject({
        target: "claude",
        ok: true,
        request: { kind: "bundle", name: "plan:work" },
      });
      expect(
        statSync(
          join(planRoot, "workers", ".keeper-prompt-claude.json"),
        ).isFile(),
      ).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.KEEPER_CONFIG_DIR;
      else process.env.KEEPER_CONFIG_DIR = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const verb of STUB_VERBS) {
    test(`'${verb}' is registered (reachable stub returns the not-implemented envelope)`, () => {
      const r = run([verb]);
      // The stub returns exit 1 with a not-implemented envelope — wiring proof
      // that the verb dispatches and is not an unknown command (which exits 2).
      expect(r.ret).toBe(1);
      expect(r.code).toBeUndefined();
      expect(r.stdout).toContain(`not implemented: ${verb}`);
    });
  }

  for (const verb of PORTED_VERBS) {
    test(`'${verb}' is registered (dispatches to its runner, not no-such-command)`, () => {
      const r = run([verb]);
      // A ported verb owns its exit code via its runner. The registration proof
      // is the negative: it never falls through to the no-such-command path
      // (exit 2 with "No such command"), so the dispatcher routes it.
      expect(r.stderr).not.toContain("No such command");
    });
  }
});

// Regression lock for the option-before-positional bug: a value-bearing option
// placed before the bare positional must not swallow the positional slot. The
// pre-fix `positional()` returned the first non-dash token, so `--limit 3 layout`
// resolved the query as `3`. These drive cli.ts (positional() + main()), not the
// library runners.
describe("positional() option-before-positional ordering", () => {
  test("--limit 3 layout resolves 'layout', not the option value '3'", () => {
    const query = positional(["--limit", "3", "layout"], ["--limit"]);
    expect(query).toBe("layout");
  });

  test("a value-bearing option after the positional still resolves it", () => {
    expect(positional(["layout", "--limit", "3"], ["--limit"])).toBe("layout");
  });

  test("save-bundle value-bearing options before the ref don't swallow it", () => {
    const ref = positional(
      ["--summary", "x", "--tags", "a,b", "bundle/foo"],
      ["--snippets", "--summary", "--tags"],
    );
    expect(ref).toBe("bundle/foo");
  });

  test("boolean flags before the positional are skipped without eating a token", () => {
    expect(positional(["--force", "bundle/foo"], ["--summary"])).toBe(
      "bundle/foo",
    );
  });

  test("--name=value form does not consume the following positional", () => {
    expect(positional(["--limit=3", "layout"], ["--limit"])).toBe("layout");
  });

  // End-to-end through main(): save-bundle reaches its ref via positional(). A
  // two-slash ref is rejected by refs.parse with the ref name in the message, so
  // the error text proves which token became the ref. Pre-fix, `--summary x`
  // would leak `x` as the ref; post-fix the bare `nope/sub/ref` is the ref.
  test("save-bundle --summary x <ref> resolves the bare ref end-to-end", () => {
    const r = run(["save-bundle", "--summary", "x", "nope/sub/ref"]);
    expect(r.stderr).toContain("nope/sub/ref");
    expect(r.stderr).not.toContain("Error: unknown ref prefix in 'x'");
  });
});

// Snapshot every regular file under `root` as a relative-path -> UTF-8-content
// map, so a byte-for-byte "the corpus tree did not change" assertion is a plain
// object equality against a pre-computed snapshot (independent of the code under
// test — the expected map is the tree observed BEFORE the help call).
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full, rel);
      } else {
        out[rel] = readFileSync(full, "utf-8");
      }
    }
  };
  walk(root, "");
  return out;
}

// Help purity: `keeper prompt <verb> --help` (the defect was build-snippets
// EXECUTING the write on `--help`) must render verb-specific leaf help, exit 0,
// and touch nothing on disk. Every descriptor verb is walked under a sandboxed
// corpus so a stray write would surface as a tree diff.
describe("keeper prompt leaf help is pure", () => {
  for (const spec of PROMPT_COMMANDS) {
    for (const helpFlag of ["--help", "-h"] as const) {
      test(`'${spec.name} ${helpFlag}' prints leaf help, exits 0, writes nothing`, () => {
        const before = snapshotTree(corpusHome);
        const r = run([spec.name, helpFlag]);
        expect(r.ret).toBe(0);
        expect(r.code).toBeUndefined();
        expect(r.stdout).toContain(`Usage: keeper prompt ${spec.name}`);
        expect(r.stdout).toContain("Options:");
        expect(r.stderr).toBe("");
        expect(snapshotTree(corpusHome)).toEqual(before);
      });
    }
  }

  // The regression case: build-snippets' write path targets
  // <corpus>/claude/arthack/template/_partials/snippets/_index.yaml. Seed a
  // sentinel there — the pre-fix `--help` overwrote it; the fixed CLI must leave
  // the hand-authored bytes untouched.
  test("build-snippets --help leaves a seeded _index.yaml byte-identical", () => {
    const snippetsDir = join(
      corpusHome,
      "claude",
      "arthack",
      "template",
      "_partials",
      "snippets",
    );
    const indexPath = join(snippetsDir, "_index.yaml");
    const sentinel = "# hand-authored sentinel — help must not overwrite\n";
    mkdirSync(snippetsDir, { recursive: true });
    writeFileSync(indexPath, sentinel);
    try {
      const r = run(["build-snippets", "--help"]);
      expect(r.ret).toBe(0);
      expect(r.stdout).toContain("Usage: keeper prompt build-snippets");
      expect(readFileSync(indexPath, "utf-8")).toBe(sentinel);
    } finally {
      rmSync(join(corpusHome, "claude"), { recursive: true, force: true });
    }
  });
});
