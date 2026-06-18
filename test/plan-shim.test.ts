/**
 * Conformance tests for the `keeper plan` exec shim (`cli/plan.ts`). Proves the
 * shim is byte-compatible with a direct `planctl <verb>` invocation: argv
 * forwarded verbatim (the `plan` token already stripped by the dispatcher),
 * stdin piped through, exit code propagated, and the trailing
 * `planctl_invocation` NDJSON trailer surviving byte-intact.
 *
 * Two spawn strategies, by design:
 *   - Against the REAL compiled planctl (`detect`, a read-only verb) we assert
 *     byte-identical stdout/stderr/exit between `keeper plan detect` and
 *     `planctl detect` — the end-to-end golden conformance.
 *   - Against a STUB `planctl` placed first on PATH we assert argv + stdin
 *     forwarding deterministically, with no real state touched and full control
 *     over exit codes. The shim resolves the binary via `Bun.which("planctl")`,
 *     which honours the spawn env's PATH, so the stub wins.
 *
 * This file is fast-tier-ignored (it spawns the keeper CLI); it runs only under
 * `bun run test:full`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEEPER = join(import.meta.dir, "..", "cli", "keeper.ts");
const BUN = process.execPath;

function spawn(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({
    cmd,
    cwd: opts.cwd ?? process.cwd(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.stdin != null ? { stdin: Buffer.from(opts.stdin) } : {}),
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/** Run the keeper CLI under bun, forwarding the given argv. */
function keeper(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): { code: number; stdout: string; stderr: string } {
  return spawn([BUN, KEEPER, ...argv], opts);
}

/** Cleanup tracker — every tmpdir created here is registered for teardown. */
const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/**
 * Write an executable stub named `planctl` into a fresh tmp dir and return the
 * dir path (to prepend to PATH). The stub body is a bash script.
 */
function stubBin(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "keeper-plan-shim-"));
  tmps.push(dir);
  const p = join(dir, "planctl");
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
  return dir;
}

describe("keeper plan — byte-identical to direct planctl (real binary)", () => {
  test("`keeper plan detect` matches `planctl detect` (stdout/stderr/exit + trailer)", () => {
    const direct = spawn(["planctl", "detect"]);
    const shimmed = keeper(["plan", "detect"]);
    expect(shimmed.code).toBe(direct.code);
    expect(shimmed.stdout).toBe(direct.stdout);
    expect(shimmed.stderr).toBe(direct.stderr);
    // The planctl_invocation NDJSON trailer is the last stdout line — assert it
    // survived byte-intact through the inherited-stdout shim.
    const lastLine = shimmed.stdout.trimEnd().split("\n").at(-1) ?? "";
    expect(lastLine).toContain('"planctl_invocation"');
    const parsed = JSON.parse(lastLine);
    expect(parsed.planctl_invocation.op).toBe("detect");
  });

  test("`keeper plan --format human detect` matches `planctl --format human detect`", () => {
    const direct = spawn(["planctl", "--format", "human", "detect"]);
    const shimmed = keeper(["plan", "--format", "human", "detect"]);
    expect(shimmed.code).toBe(direct.code);
    expect(shimmed.stdout).toBe(direct.stdout);
    expect(shimmed.stderr).toBe(direct.stderr);
  });
});

describe("keeper plan — argv forwarding (stub binary)", () => {
  test("`plan` token is stripped; residual argv forwarded verbatim", () => {
    // Stub echoes its own argv, one per line, so we can assert exactly what
    // planctl received.
    const dir = stubBin('for a in "$@"; do echo "$a"; done');
    const r = keeper(["plan", "claim", "fn-1-x.2", "--format", "json"], {
      env: { PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    });
    expect(r.code).toBe(0);
    // No leading "plan" token — the dispatcher stripped it before the handler.
    expect(r.stdout).toBe("claim\nfn-1-x.2\n--format\njson\n");
  });

  test("empty residual argv forwards nothing", () => {
    const dir = stubBin('echo "argc=$#"');
    const r = keeper(["plan"], {
      env: { PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("argc=0\n");
  });
});

describe("keeper plan — stdin forwarding (stub binary)", () => {
  test("piped stdin is forwarded to the child verbatim", () => {
    const dir = stubBin("cat");
    const payload = '{"some":"piped","json":[1,2,3]}\n';
    const r = keeper(["plan", "ingest"], {
      env: { PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
      stdin: payload,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(payload);
  });
});

describe("keeper plan — exit code propagation (stub binary)", () => {
  test("a non-zero child exit propagates unchanged", () => {
    const dir = stubBin("exit 42");
    const r = keeper(["plan", "boom"], {
      env: { PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    });
    expect(r.code).toBe(42);
  });

  test("a zero child exit propagates as 0", () => {
    const dir = stubBin("exit 0");
    const r = keeper(["plan", "ok"], {
      env: { PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    });
    expect(r.code).toBe(0);
  });
});

describe("keeper plan — missing binary", () => {
  test("no planctl on PATH and no ~/.local/bin/planctl → exit 127", () => {
    // Empty PATH + a HOME with no .local/bin/planctl forces both resolution
    // paths to miss. A bare PATH still needs the bash the stub-less shim itself
    // doesn't invoke — the shim only runs Bun.which + Bun.file, no shell.
    const emptyHome = mkdtempSync(join(tmpdir(), "keeper-plan-nohome-"));
    tmps.push(emptyHome);
    const r = keeper(["plan", "status"], {
      // PATH points only at a dir with no planctl; HOME has no .local/bin.
      env: { PATH: emptyHome, HOME: emptyHome },
    });
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("planctl binary not found");
  });
});
