// Dispatcher contract for `keeper prompt`: top-level `--help` exits 0 with a
// Commands section, an unknown verb exits 2 (click no-such-command), and every
// keep-verb the epic acceptance pins is registered. The runners themselves land
// in the verb-port tasks; here the stub returns the not-implemented envelope +
// exit 1, which is the wiring proof — the verb is reachable and owns its exit.
//
// `main()` writes to process.stdout/stderr and the no-such-command / usage paths
// call process.exit, so these drive main() with those globals captured (exit →
// a tagged throw so the never-return branches stop).

import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";

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
  "render-plugin-templates",
  "find-snippets",
  "build-snippets",
  "save-snippet",
  "save-bundle",
  "validate-bundles",
  "list-bundles",
  "show-bundle",
];

// Verbs whose runner has landed (no longer the not-implemented stub). Their
// registration proof is that the dispatcher routes them to their runner instead
// of the no-such-command (exit 2) path.
const PORTED_VERBS = new Set(["render", "check-generated"]);
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
