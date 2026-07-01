/**
 * Fixture tests for the retired-name guard (scripts/lint-retired-name.sh).
 *
 * The guard covers three retired names: "planctl" (PROGRESSIVE — enforces only the
 * frozen-literal surface in scripts/frozen-allowlist.txt: anchors via Check A,
 * count-pins via Check B), "agentwrap" (ZERO-TOLERANCE — Check C fails on any
 * occurrence repo-wide outside a defined exclusion set), and "keeper pair"
 * (ZERO-TOLERANCE — Check D fails on any space-separated occurrence repo-wide
 * outside the same exclusion set; the colon-separated `keeper:pair` SKILL name
 * never matches). A count-pin's token defaults to "planctl" but a 4th `|<token>`
 * field overrides it (the agentwrap relocation files are pinned that way).
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

test("agentwrap zero-tolerance: a planted agentwrap token fails repo-wide", () => {
  // Check C greps the whole tree: a stray "agentwrap" in any non-excluded file
  // fails, even with an otherwise-empty allowlist (the retired name can never
  // return).
  put("scripts/frozen-allowlist.txt", "");
  put("src/agent/foo.ts", "const dir = oldAgentwrapDir();\n");

  const { code, stderr } = runGuard();
  expect(code).toBe(1);
  expect(stderr).toContain("AGENTWRAP zero-tolerance");
  expect(stderr).toContain("src/agent/foo.ts");
});

test("agentwrap zero-tolerance: agentwrap only in excluded files passes", () => {
  // The allowlist itself and the retirement docs legitimately name the retired
  // token; the exclusion set keeps Check C from flagging them.
  put(
    "scripts/frozen-allowlist.txt",
    "# agentwrap is named in this allowlist\n",
  );
  put("docs/plan-name-retirement.md", "The agentwrap name is fully retired.\n");

  expect(runGuard().code).toBe(0);
});

test("keeper pair zero-tolerance: a planted keeper pair verb fails repo-wide", () => {
  // Check D greps the whole tree: a stray space-separated "keeper pair" in any
  // non-excluded file fails, even with an otherwise-empty allowlist (the retired
  // verb can never return).
  put("scripts/frozen-allowlist.txt", "");
  put(
    "plugins/keeper/skills/pair/SKILL.md",
    "Run `keeper pair send …` first.\n",
  );

  const { code, stderr } = runGuard();
  expect(code).toBe(1);
  expect(stderr).toContain("KEEPER-PAIR zero-tolerance");
  expect(stderr).toContain("plugins/keeper/skills/pair/SKILL.md");
});

test("keeper pair zero-tolerance: the colon-separated keeper:pair SKILL name passes", () => {
  // The live `keeper:pair` capability (skill name) is colon-separated and must
  // NOT trip the space-separated retired-verb pattern.
  put("scripts/frozen-allowlist.txt", "");
  put(
    "plugins/plan/skills/hack/SKILL.md",
    "See the /keeper:pair skill; drive `keeper agent panel`.\n",
  );

  expect(runGuard().code).toBe(0);
});

test("a count-pin with an explicit token pins a non-planctl name", () => {
  // The state-dir relocation files are Check-C-excluded by basename but pinned
  // via a `count|...|<n>|agentwrap` record, so a NEW agentwrap token there still
  // FAILs (count drift).
  put(
    "scripts/frozen-allowlist.txt",
    "count|src/agent/cwd-ordinal.ts|2|agentwrap\n",
  );
  put(
    "src/agent/cwd-ordinal.ts",
    'const old = "agentwrap";\nconst dir = "agentwrap";\n',
  );
  expect(runGuard().code).toBe(0);

  // A third agentwrap line drifts the pin → fail (and the file stays Check-C
  // excluded, so the failure is the count check, not the grep-clean).
  put(
    "src/agent/cwd-ordinal.ts",
    'const old = "agentwrap";\nconst dir = "agentwrap";\n// agentwrap planted\n',
  );
  const { code, stderr } = runGuard();
  expect(code).toBe(1);
  expect(stderr).toContain("cwd-ordinal.ts drifted");
  expect(stderr).toContain('"agentwrap"');
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

test("the real repo tree passes the guard (planctl frozen surface intact + agentwrap + keeper pair at zero)", () => {
  // Proves all three postures against live source: the planctl anchors/count-pins
  // hold, Check C finds zero "agentwrap" outside the exclusion set (the only
  // residue is the count-pinned state-dir relocation), AND Check D finds zero
  // space-separated "keeper pair" outside the exclusion set.
  const res = Bun.spawnSync(["bash", GUARD], {
    cwd: join(import.meta.dir, ".."),
  });
  expect(res.exitCode).toBe(0);
});
