import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lintSource,
  parseAllowlist,
  type SourceAllowlist,
  scanSourceText,
  stringifyAllowlist,
} from "../scripts/lint-source";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "source-hygiene-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  putAllowlist({ version: 1, commentViolations: {} });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(relpath: string, body: string): void {
  const abs = join(root, relpath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

function putAllowlist(allowlist: SourceAllowlist): void {
  put("scripts/lint-source-allowlist.json", stringifyAllowlist(allowlist));
}

function putPiExtensionPackage(): void {
  put(
    "integrations/pi-fake/package.json",
    `${JSON.stringify(
      {
        type: "module",
        pi: { extensions: ["./src/index.ts"] },
      },
      null,
      2,
    )}\n`,
  );
}

function run(targetRoot = root): { code: number; stderr: string } {
  const findings = lintSource(targetRoot).findings;
  return {
    code: findings.length === 0 ? 0 : 1,
    stderr: findings
      .map((f) => `${f.file}:${f.line}:${f.kind}:${f.message}`)
      .join("\n"),
  };
}

test("comment scanner ignores matching text inside string literals", () => {
  const text = [
    'const task = "fn-123";',
    'const phrase = "formerly string-only";',
    "const ok = 1;",
  ].join("\n");
  expect(scanSourceText("src/string.ts", text)).toEqual([]);
});

test("a hex digest in a comment is not a provenance match", () => {
  const digest = "a".repeat(64);
  const text = `// checksum ${digest}\nconst ok = true;\n`;
  expect(scanSourceText("src/digest.ts", text)).toEqual([]);
});

test("a comment token beyond the frozen count fails", () => {
  put("src/new.ts", "// fn-1234-comment-token\nexport const x = 1;\n");
  const { code, stderr } = run();
  expect(code).toBe(1);
  expect(stderr).toContain("net-new comment re-narration fingerprints");
  expect(stderr).toContain("src/new.ts");
});

test("a frozen file passes at its count and an injected file fails independently", () => {
  putAllowlist({ version: 1, commentViolations: { "src/base.ts": 1 } });
  put("src/base.ts", "// fn-1234-frozen-token\nexport const base = 1;\n");
  expect(run().code).toBe(0);

  put(
    "src/injected.ts",
    "// fn-9999-injected-token\nexport const injected = 1;\n",
  );
  const { code, stderr } = run();
  expect(code).toBe(1);
  expect(stderr).toContain("src/injected.ts");
  expect(stderr).not.toContain("src/base.ts:0");
});

test("a pi extension graph reaching bun:sqlite fails", () => {
  putPiExtensionPackage();
  put(
    "integrations/pi-fake/src/index.ts",
    `import { shared } from "../../../src/shared.ts";
export const entry = shared;
`,
  );
  put(
    "src/shared.ts",
    `import { Database } from "bun:sqlite";
export const shared = 1;
`,
  );
  const { code, stderr } = run();
  expect(code).toBe(1);
  expect(stderr).toContain("BUN_BUILTIN_IMPORT");
  expect(stderr).toContain("bun:sqlite");
  expect(stderr).toContain("src/shared.ts");
});

test("a dynamic bun import string fails conservatively", () => {
  putPiExtensionPackage();
  put(
    "integrations/pi-fake/src/index.ts",
    `import { dynamic } from "../../../src/dynamic.ts";
export const entry = dynamic;
`,
  );
  put("src/dynamic.ts", `export const dynamic = import("bun:sqlite");\n`);
  const { code, stderr } = run();
  expect(code).toBe(1);
  expect(stderr).toContain("BUN_BUILTIN_IMPORT");
  expect(stderr).toContain("bun:sqlite");
  expect(stderr).toContain("src/dynamic.ts");
});

test("a type-only bun import in the graph does not trip", () => {
  putPiExtensionPackage();
  put(
    "integrations/pi-fake/src/index.ts",
    `import { typed } from "../../../src/type-only.ts";
export const entry = typed;
`,
  );
  put(
    "src/type-only.ts",
    `import type { Database } from "bun:sqlite";
export const typed = 1;
`,
  );
  expect(run().code).toBe(0);
});

test("the live tree passes the bun builtin gate", () => {
  expect(lintSource(process.cwd()).findings).toEqual([]);
});

test("raw NUL bytes fail outside the shared separator module", () => {
  put("src/raw.ts", `export const bad = "a${"\0"}b";\n`);
  const { code, stderr } = run();
  expect(code).toBe(1);
  expect(stderr).toContain("RAW_NUL_LITERAL");
  expect(stderr).toContain("src/raw.ts");
});

test("raw NUL bytes are allowed in the shared separator module only", () => {
  put("src/composite-key.ts", `export const SEP = "${"\0"}";\n`);
  expect(run().code).toBe(0);
});

test("a clean file cannot carry an inflated positive allowlist entry", () => {
  putAllowlist({ version: 1, commentViolations: { "src/clean.ts": 1 } });
  put("src/clean.ts", "export const clean = true;\n");
  const { code, stderr } = run();
  expect(code).toBe(1);
  expect(stderr).toContain("allowlist entry is inflated for a clean file");
});

test("allowlist JSON is stable and sorted", () => {
  const text = stringifyAllowlist({
    version: 1,
    commentViolations: { "src/z.ts": 2, "src/a.ts": 1, "src/zero.ts": 0 },
  });
  expect(text).toContain('"src/a.ts"');
  expect(text.indexOf('"src/a.ts"')).toBeLessThan(text.indexOf('"src/z.ts"'));
  expect(text).not.toContain("zero.ts");
  expect(parseAllowlist(text).commentViolations).toEqual({
    "src/a.ts": 1,
    "src/z.ts": 2,
  });
});
