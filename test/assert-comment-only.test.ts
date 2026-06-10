/**
 * Fixture tests for the comment-only scrub verifier. Pure in-process: drive
 * `checkCommentOnly(head, working, jsx)` directly — no git, no subprocess, no
 * DB — so this is a fast-tier file.
 *
 * The risk these prove out: regex-based comment stripping would misread a `//`
 * or `/* *​/` living inside a string, regex literal, or template. The scanner
 * approach treats those as single tokens, so the false-positive cases below
 * must all pass as comment-only.
 */
import { expect, test } from "bun:test";
import { checkCommentOnly } from "../scripts/assert-comment-only";

test("comment-removed file passes as comment-only", () => {
  const head = [
    "// leading comment",
    "const x: number = 1; // trailing",
    "/* block comment */",
    "export function f() {",
    "  return x; // inner",
    "}",
    "",
  ].join("\n");
  const scrubbed = [
    "const x: number = 1;",
    "export function f() {",
    "  return x;",
    "}",
    "",
  ].join("\n");

  const result = checkCommentOnly(head, scrubbed, false);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.deletedLines).toBeGreaterThan(0);
    expect(result.deletedChars).toBeGreaterThan(0);
  }
});

test("zero-diff file passes", () => {
  const src = "const x = 1;\nexport const y = x + 1;\n";
  const result = checkCommentOnly(src, src, false);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.deletedLines).toBe(0);
    expect(result.deletedChars).toBe(0);
  }
});

test("single-token code change fails and names the differing token", () => {
  const head = "const x = 1;\n";
  const working = "const x = 2;\n";
  const result = checkCommentOnly(head, working, false);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toContain("token mismatch");
    expect(result.reason).toContain('"1"');
    expect(result.reason).toContain('"2"');
  }
});

test("renamed identifier fails (token text differs)", () => {
  const head = "const foo = 1;\nexport { foo };\n";
  const working = "const bar = 1;\nexport { bar };\n";
  const result = checkCommentOnly(head, working, false);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("token mismatch");
});

test("added statement fails on token count mismatch", () => {
  const head = "const x = 1;\n";
  const working = "const x = 1;\nconst y = 2;\n";
  const result = checkCommentOnly(head, working, false);
  expect(result.ok).toBe(false);
});

test("deleted biome-ignore directive fails the protected-pattern guard", () => {
  const head = [
    "  // biome-ignore lint/style/noNonNullAssertion: guarded above",
    "  const a = map.get(k)!;",
    "",
  ].join("\n");
  const working = ["  const a = map.get(k)!;", ""].join("\n");
  const result = checkCommentOnly(head, working, false);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toContain("biome-ignore");
    expect(result.reason).toContain("dropped");
  }
});

test("deleted @ts-expect-error fails the protected-pattern guard", () => {
  const head =
    "// @ts-expect-error narrow later\nconst a: string = 1 as never;\n";
  const working = "const a: string = 1 as never;\n";
  const result = checkCommentOnly(head, working, false);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("@ts-expect-error");
});

test("string containing https:// is not misread as a comment", () => {
  const head = 'const url = "https://example.com/path"; // doc link\n';
  const working = 'const url = "https://example.com/path";\n';
  const result = checkCommentOnly(head, working, false);
  expect(result.ok).toBe(true);
});

test("string containing /* */ survives scrubbing of a real comment", () => {
  const head = 'const s = "a /* not a comment */ b"; // strip\n';
  const working = 'const s = "a /* not a comment */ b";\n';
  const result = checkCommentOnly(head, working, false);
  expect(result.ok).toBe(true);
});

test("template literal with /* */ content and substitution passes", () => {
  // The `${...}` placeholder is assembled by concatenation so this source
  // string isn't itself flagged as an unintended template placeholder.
  const sub = "$" + "{x}";
  const head = `const t = \`/* in template */ ${sub}\`; // tail comment\n`;
  const working = `const t = \`/* in template */ ${sub}\`;\n`;
  const result = checkCommentOnly(head, working, false);
  expect(result.ok).toBe(true);
});

test("regex literal containing // is not misread as a comment", () => {
  const head = [
    'const u = s.replace(/^https:\\/\\//, ""); // normalize',
    "const re = /a\\/\\/b/;",
    "",
  ].join("\n");
  const working = [
    'const u = s.replace(/^https:\\/\\//, "");',
    "const re = /a\\/\\/b/;",
    "",
  ].join("\n");
  const result = checkCommentOnly(head, working, false);
  expect(result.ok).toBe(true);
});

test("changing a string literal's content fails (not comment-only)", () => {
  const head = 'const s = "before";\n';
  const working = 'const s = "after";\n';
  const result = checkCommentOnly(head, working, false);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("token mismatch");
});

test("JSX trailing comment is scrubbable under the JSX variant", () => {
  const head =
    'export const C = () => <div className="x">{/* keep */}hi</div>; // tail\n';
  const working =
    'export const C = () => <div className="x">{/* keep */}hi</div>;\n';
  const result = checkCommentOnly(head, working, true);
  expect(result.ok).toBe(true);
});

test("deleted-line and deleted-char counts report the scrub size", () => {
  const head = "// one\n// two\nconst x = 1;\n";
  const working = "const x = 1;\n";
  const result = checkCommentOnly(head, working, false);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.deletedLines).toBe(2);
    expect(result.deletedChars).toBe(head.length - working.length);
  }
});
