/**
 * Fixture tests for the retired-name guard (scripts/lint-retired-name.sh).
 *
 * The guard is the fn-889 safety harness: it enforces ONLY the frozen-literal
 * surface enumerated in scripts/frozen-allowlist.txt (git-history trailers +
 * src/db.ts schema-history), so a code sweep that clobbers a frozen literal
 * fails loud while un-renamed renamable references stay green.
 *
 * These drive the script via a sandboxed fixture tree (the guard honors
 * KEEPER_RETIRED_NAME_REPO_ROOT), so no git repo or real source is mutated.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "..", "scripts", "lint-retired-name.sh");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "retired-name-guard-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a relative file under the fixture root, creating parent dirs. */
function put(relpath: string, body: string): void {
  const abs = join(root, relpath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/** Run the guard against the fixture root; returns {code, stderr}. */
function runGuard(): { code: number; stderr: string } {
  const res = Bun.spawnSync(["bash", GUARD], {
    env: { ...process.env, KEEPER_RETIRED_NAME_REPO_ROOT: root },
  });
  return {
    code: res.exitCode ?? -1,
    stderr: res.stderr.toString(),
  };
}

test("passes on a clean fixture tree with frozen literals intact", () => {
  const allowlist = [
    "anchor|src/emit.ts|Planctl-Op: ",
    "count|src/schema.ts|2",
    "",
  ].join("\n");
  put("scripts/frozen-allowlist.txt", allowlist);
  put("src/emit.ts", "const m = trailer(`Planctl-Op: `, op);\n");
  // Two frozen planctl_* schema literals → count pin of 2.
  put("src/schema.ts", "planctl_op TEXT,\nplanctl_target TEXT,\n");

  const { code } = runGuard();
  expect(code).toBe(0);
});

test("fails on a planted retired-name edit to a count-pinned frozen file", () => {
  put("scripts/frozen-allowlist.txt", "count|src/schema.ts|2\n");
  // Pinned at 2 but the file carries a third planted "planctl" line.
  put(
    "src/schema.ts",
    "planctl_op TEXT,\nplanctl_target TEXT,\n// planctl planted\n",
  );

  const { code, stderr } = runGuard();
  expect(code).toBe(1);
  expect(stderr).toContain("src/schema.ts drifted");
  expect(stderr).toContain("expected 2");
  expect(stderr).toContain("found 3");
});

test("fails when a frozen trailer anchor is clobbered (renamed away)", () => {
  put("scripts/frozen-allowlist.txt", "anchor|src/emit.ts|Planctl-Op: \n");
  // The frozen literal was renamed Planctl-Op -> Plan-Op: anchor no longer present.
  put("src/emit.ts", "const m = trailer(`Plan-Op: `, op);\n");

  const { code, stderr } = runGuard();
  expect(code).toBe(1);
  expect(stderr).toContain("CLOBBERED frozen literal in src/emit.ts");
});

test("fails when a frozen keeper agent survivor anchor is clobbered", () => {
  // The fn-1018 sweep must not rename a frozen AGENTWRAP_* env-var name string;
  // the guard catches a clobber the same way it does a planctl trailer.
  put(
    "scripts/frozen-allowlist.txt",
    'anchor|src/agent/main.ts|"AGENTWRAP_CLAUDE_PROFILE"\n',
  );
  put("src/agent/main.ts", 'return "KEEPER_AGENT_CLAUDE_PROFILE";\n');

  const { code, stderr } = runGuard();
  expect(code).toBe(1);
  expect(stderr).toContain("CLOBBERED frozen literal in src/agent/main.ts");
});

test("anchor payload may itself contain pipe characters (regex alternation)", () => {
  // The FORBIDDEN_TRAILER_RE alternation carries `|`; the guard must split on
  // the first two record `|` only and match the rest as a fixed substring.
  const alt = "Planctl-Op:|Planctl-Target:|Planctl-Prev-Op:|Planctl-[A-Za-z]+:";
  put("scripts/frozen-allowlist.txt", `anchor|cli/cw.ts|${alt}\n`);
  put("cli/cw.ts", `const RE = /^(${alt})/m;\n`);

  const { code } = runGuard();
  expect(code).toBe(0);

  // And it fails when that exact alternation is clobbered.
  put("cli/cw.ts", "const RE = /^(Job-Id:)/m;\n");
  expect(runGuard().code).toBe(1);
});

test("fails when the allowlist is missing", () => {
  // No frozen-allowlist.txt written.
  const { code, stderr } = runGuard();
  expect(code).toBe(1);
  expect(stderr).toContain("frozen allowlist not found");
});

test("the real repo tree passes the guard (frozen surface intact)", () => {
  const res = Bun.spawnSync(["bash", GUARD], {
    cwd: join(import.meta.dir, ".."),
  });
  expect(res.exitCode).toBe(0);
});
