/**
 * Tests for the keeper docs sidecar-writer hook (fn-884).
 *
 * Two layers, mirroring branch-guard.test.ts:
 *  - **Layer 1 (in-process unit):** the pure, exported helpers — the
 *    strip-signature detector + sidecar parse/merge/serialize (shared with the
 *    fn-884 `.4` migration), the bounded gist-URL match, and the `gh gist
 *    create` file-arg extractor.
 *  - **Layer 2 (subprocess):** drive the REAL hook through `Bun.spawn` with a
 *    `KEEPER_DOCS_DIR`-sandboxed docs tree; assert the sidecar is written, the
 *    `.md` is byte-unchanged, the gist URL upserts into the sidecar only, and
 *    the exit code is 0 on garbage stdin / non-docs paths / a missing docs dir.
 *
 * Kept fast-tier (like branch-guard): the subprocess spawns are cheap and the
 * file is NOT in the `test` script's path-ignore list.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSidecarFields,
  decideDocsCommit,
  extractGistFileArgs,
  isDocsMarkdown,
  isoWithOffset,
} from "../plugins/keeper/plugin/hooks/sidecar-writer.ts";
import {
  extractGistUrl,
  mergeSidecarFields,
  parseSidecarText,
  serializeSidecar,
  stripDocSignature,
} from "../src/sidecar.ts";
import { sandboxEnv } from "./helpers/sandbox-env.ts";

// ---------------------------------------------------------------------------
// Layer 1 — pure helpers
// ---------------------------------------------------------------------------

describe("extractGistUrl (bounded)", () => {
  test("captures a bare URL", () => {
    expect(
      extractGistUrl("Created gist https://gist.github.com/u/abc123"),
    ).toBe("https://gist.github.com/u/abc123");
  });

  test("stops at the JSON tail — no greedy swallow", () => {
    // The hook reads the PARSED tool_response.stdout (a real newline), and
    // `[^\s"'<>]+` stops at the newline — the URL is captured bare.
    const stdout = "https://gist.github.com/u/abc123\n";
    expect(extractGistUrl(stdout)).toBe("https://gist.github.com/u/abc123");
    // The bound also stops at a JSON/HTML `"` delimiter (the old greedy
    // `\S+` regex swallowed the `","stderr":...` tail and corrupted docs).
    const blob = 'url=https://gist.github.com/u/abc123","stderr":""}';
    expect(extractGistUrl(blob)).toBe("https://gist.github.com/u/abc123");
  });

  test("null when absent", () => {
    expect(extractGistUrl("nothing here")).toBeNull();
  });
});

describe("extractGistFileArgs", () => {
  test("extracts .md + .yaml, drops flags", () => {
    expect(extractGistFileArgs("gh gist create a.md a.yaml --web")).toEqual([
      "a.md",
      "a.yaml",
    ]);
  });

  test("skips value-bearing flags", () => {
    expect(
      extractGistFileArgs("gh gist create -d 'my desc' a.md --web"),
    ).toEqual(["a.md"]);
  });

  test("handles env prefix and quoted paths", () => {
    expect(
      extractGistFileArgs("FOO=1 gh gist create '/Users/x/docs/a b.md' --web"),
    ).toEqual(["/Users/x/docs/a b.md"]);
  });

  test("empty for a non-gist-create command", () => {
    expect(extractGistFileArgs("gh gist list")).toEqual([]);
    expect(extractGistFileArgs("echo hi")).toEqual([]);
  });
});

describe("isDocsMarkdown", () => {
  test("true for a .md under the docs dir", () => {
    expect(isDocsMarkdown("/d/docs/x.md", "/d/docs")).toBe(true);
    expect(isDocsMarkdown("/d/docs/x.md", "/d/docs/")).toBe(true);
  });
  test("false for non-.md, outside dir, or the dir itself", () => {
    expect(isDocsMarkdown("/d/docs/x.yaml", "/d/docs")).toBe(false);
    expect(isDocsMarkdown("/other/x.md", "/d/docs")).toBe(false);
    expect(isDocsMarkdown("/d/docs-other/x.md", "/d/docs")).toBe(false);
  });
});

describe("sidecar parse/serialize round-trip", () => {
  test("flat scalars round-trip, special chars single-quoted", () => {
    const text =
      "path: /d/docs/a.md\ntype: doc\nresume: 'cd /x && claude --resume z'\n";
    const parsed = parseSidecarText(text);
    expect(parsed.fields.get("path")).toBe("/d/docs/a.md");
    expect(parsed.fields.get("type")).toBe("doc");
    expect(parsed.fields.get("resume")).toBe("cd /x && claude --resume z");
    const out = serializeSidecar(parsed);
    expect(out).toContain("resume: 'cd /x && claude --resume z'");
    // re-parse is stable
    expect(parseSidecarText(out).fields.get("resume")).toBe(
      "cd /x && claude --resume z",
    );
  });

  test("single-quote escaping (' -> '')", () => {
    const parsed = parseSidecarText('note: "x"\n');
    const fields = new Map([["note", "it's a 'thing'"]]);
    const merged = mergeSidecarFields(parsed, fields);
    const out = serializeSidecar(merged);
    expect(out).toContain("note: 'it''s a ''thing'''");
    expect(parseSidecarText(out).fields.get("note")).toBe("it's a 'thing'");
  });

  test("preserves a nested-structure tail verbatim across merge", () => {
    const text =
      "path: /d/a.md\ntype: doc\nreviewers:\n  - cli: codex\n    role: reviewer\n";
    const parsed = parseSidecarText(text);
    expect(parsed.tail).toContain("reviewers:");
    const merged = mergeSidecarFields(
      parsed,
      new Map([["git-branch", "main"]]),
    );
    const out = serializeSidecar(merged);
    expect(out).toContain("git-branch: main");
    expect(out).toContain("reviewers:");
    expect(out).toContain("  - cli: codex");
  });
});

describe("mergeSidecarFields preserves created", () => {
  test("existing created wins; other fields overwrite", () => {
    const existing = parseSidecarText(
      "path: /d/a.md\ntype: doc\ncreated: '2026-01-01T00:00:00+0000'\ncwd: /old\n",
    );
    const merged = mergeSidecarFields(
      existing,
      new Map([
        ["created", "2026-12-31T23:59:59+0000"],
        ["cwd", "/new"],
        ["git-branch", "main"],
      ]),
    );
    expect(merged.fields.get("created")).toBe("2026-01-01T00:00:00+0000");
    expect(merged.fields.get("cwd")).toBe("/new");
    expect(merged.fields.get("git-branch")).toBe("main");
  });

  test("created is set when absent", () => {
    const empty = parseSidecarText("");
    const merged = mergeSidecarFields(
      empty,
      new Map([["created", "2026-06-22T10:00:00+0000"]]),
    );
    expect(merged.fields.get("created")).toBe("2026-06-22T10:00:00+0000");
  });
});

describe("buildSidecarFields", () => {
  test("emits path/type/created + session/cwd/resume; git omitted on failure", () => {
    const fields = buildSidecarFields(
      "/d/docs/a.md",
      { session_id: "sess-1", cwd: "/repo" },
      new Date("2026-06-22T10:00:00Z"),
      () => null, // git probe always fails
    );
    expect(fields.get("path")).toBe("/d/docs/a.md");
    expect(fields.get("type")).toBe("doc");
    expect(fields.get("created")).toBeTruthy();
    expect(fields.get("session-id")).toBe("sess-1");
    expect(fields.get("cwd")).toBe("/repo");
    expect(fields.get("resume")).toBe("cd /repo && claude --resume sess-1");
    expect(fields.has("git-branch")).toBe(false);
    expect(fields.has("git-commit")).toBe(false);
  });

  test("git fields included when probe succeeds", () => {
    const fields = buildSidecarFields(
      "/d/docs/a.md",
      { session_id: "s", cwd: "/repo" },
      new Date(),
      (_cwd, args) => (args.includes("--abbrev-ref") ? "main" : "abc1234"),
    );
    expect(fields.get("git-branch")).toBe("main");
    expect(fields.get("git-commit")).toBe("abc1234");
  });

  test("no resume when session or cwd is missing", () => {
    const fields = buildSidecarFields(
      "/d/docs/a.md",
      { session_id: "s" },
      new Date(),
      () => null,
    );
    expect(fields.has("resume")).toBe(false);
    expect(fields.has("cwd")).toBe(false);
  });
});

describe("isoWithOffset", () => {
  test("emits an offset-suffixed ISO stamp", () => {
    expect(isoWithOffset(new Date("2026-06-22T10:00:00Z"))).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/,
    );
  });
});

describe("stripDocSignature", () => {
  const STAMP =
    "\n---\n\n## Metadata\n\n```yaml\ncwd: /repo\nsession-id: abc-123\npath: /d/docs/a.md\n```\n\n```sh\ncd /repo && claude --resume abc-123\n```\n";

  test("strips the machine stamp, leaving the body shorter and clean", () => {
    const body = "# Title\n\nSome content.\n\n## Sources\n\n- x\n";
    const stamped = body + STAMP;
    const stripped = stripDocSignature(stamped);
    expect(stripped.length).toBeLessThan(stamped.length);
    expect(stripped).not.toContain("## Metadata");
    expect(stripped).not.toContain("session-id:");
    expect(stripped).toContain("# Title");
    expect(stripped).toContain("## Sources");
    expect(stripped.endsWith("\n")).toBe(true);
  });

  test("idempotent — a never-stamped body is unchanged", () => {
    const body = "# Title\n\nContent only.\n";
    expect(stripDocSignature(body)).toBe(body);
  });

  test("idempotent — running twice equals running once", () => {
    const body = `# Title\n\nContent.\n${STAMP}`;
    const once = stripDocSignature(body);
    expect(stripDocSignature(once)).toBe(once);
  });

  test("preserves an author '## Metadata' heading, strips only the trailing stamp", () => {
    const body =
      "# Title\n\n## Metadata\n\nThis is the author's own metadata section, prose only.\n\nMore.\n";
    const stamped = body + STAMP;
    const stripped = stripDocSignature(stamped);
    // author heading + its prose survive
    expect(stripped).toContain("author's own metadata section");
    // the machine stamp (session-id / resume sh fence) is gone
    expect(stripped).not.toContain("session-id:");
    expect(stripped).not.toContain("claude --resume");
  });

  test("leaves a '## Metadata' heading alone when it is NOT a machine stamp", () => {
    const body =
      "# Title\n\n## Metadata\n\n```yaml\nkey: value\n```\n\nNo session id here.\n";
    expect(stripDocSignature(body)).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — subprocess
// ---------------------------------------------------------------------------

const HOOK = join(
  import.meta.dir,
  "..",
  "plugins",
  "keeper",
  "plugin",
  "hooks",
  "sidecar-writer.ts",
);

let tmpDir: string;
let docsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sidecar-test-"));
  docsDir = join(tmpDir, "docs");
  mkdirSync(docsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run(
  payload: unknown,
  extraDocsDir?: string,
): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: sandboxEnv({
      tmpDir,
      dbPath: join(tmpDir, "keeper.db"),
      clearAmbientIds: false,
      extra: { KEEPER_DOCS_DIR: extraDocsDir ?? docsDir },
    }),
  });
  proc.stdin.write(
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { stdout, code };
}

function writePayload(filePath: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-xyz",
    cwd: "/Users/x/repo",
    tool_input: { file_path: filePath },
    ...extra,
  };
}

describe("sidecar-writer hook (subprocess)", () => {
  test("Write to a docs .md creates a sidecar and leaves the .md byte-unchanged", async () => {
    const md = join(docsDir, "a.md");
    const original = "# A\n\nBody content.\n";
    writeFileSync(md, original);

    const { code } = await run(writePayload(md));
    expect(code).toBe(0);

    const sidecar = join(docsDir, "a.yaml");
    expect(existsSync(sidecar)).toBe(true);
    const yaml = readFileSync(sidecar, "utf8");
    expect(yaml).toContain(`path: ${md}`);
    expect(yaml).toContain("type: doc");
    expect(yaml).toContain("session-id: sess-xyz");
    expect(yaml).toContain("cwd: /Users/x/repo");
    expect(yaml).toContain("resume:");

    // The .md must be byte-for-byte unchanged.
    expect(readFileSync(md, "utf8")).toBe(original);
  });

  test("merge preserves existing created", async () => {
    const md = join(docsDir, "b.md");
    writeFileSync(md, "# B\n");
    const sidecar = join(docsDir, "b.yaml");
    writeFileSync(
      sidecar,
      `path: ${md}\ntype: doc\ncreated: '2020-01-01T00:00:00+0000'\n`,
    );

    const { code } = await run(writePayload(md));
    expect(code).toBe(0);
    expect(readFileSync(sidecar, "utf8")).toContain(
      "created: '2020-01-01T00:00:00+0000'",
    );
  });

  test("gh gist create upserts gist-url into the sidecar only, bounded", async () => {
    const md = join(docsDir, "c.md");
    const mdOriginal = "# C\n\nContent.\n";
    writeFileSync(md, mdOriginal);
    const sidecar = join(docsDir, "c.yaml");
    writeFileSync(sidecar, `path: ${md}\ntype: doc\n`);

    const { code } = await run({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      session_id: "s",
      cwd: docsDir,
      tool_input: { command: `gh gist create ${md} ${sidecar} --web` },
      tool_response: {
        stdout: "https://gist.github.com/mike/deadbeef\n",
        stderr: "",
      },
    });
    expect(code).toBe(0);

    const yaml = readFileSync(sidecar, "utf8");
    // The URL scalar is single-quoted (it contains `:` / `/`); re-parse to
    // assert the stored value is the bare URL with no JSON tail.
    expect(parseSidecarText(yaml).fields.get("gist-url")).toBe(
      "https://gist.github.com/mike/deadbeef",
    );
    // no JSON-tail swallow
    expect(yaml).not.toContain('","stderr"');
    // the .md untouched
    expect(readFileSync(md, "utf8")).toBe(mdOriginal);
  });

  test("exit 0 on garbage stdin", async () => {
    const { code } = await run("not json at all {{{");
    expect(code).toBe(0);
  });

  test("exit 0 + no sidecar on a non-docs path", async () => {
    const outside = join(tmpDir, "elsewhere.md");
    writeFileSync(outside, "# X\n");
    const { code } = await run(writePayload(outside));
    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, "elsewhere.yaml"))).toBe(false);
  });

  test("exit 0 with a missing docs dir", async () => {
    const missing = join(tmpDir, "no-such-docs");
    const md = join(missing, "z.md");
    const { code } = await run(writePayload(md), missing);
    expect(code).toBe(0);
    expect(existsSync(join(missing, "z.yaml"))).toBe(false);
  });

  test("no-op (exit 0, no sidecar) when the .md does not exist on disk", async () => {
    const md = join(docsDir, "ghost.md");
    const { code } = await run(writePayload(md));
    expect(code).toBe(0);
    expect(existsSync(join(docsDir, "ghost.yaml"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 2b — the fn-885 docs auto-commit ROUTING decision (`decideDocsCommit`),
// tested IN-PROCESS with zero real git (fn-904 `.3`). The decision is what the
// hook would commit (paths + subject verb) before it shells git; the actual
// commit machinery (`commitDocsPaths`) is exercised against a faked git runner
// in test/doc-commit.test.ts. `exists` is injected so no filesystem read either.
// ---------------------------------------------------------------------------

const DOCS = "/d/docs";
/** An `exists` stub that says yes for the given set of paths only. */
function existsFor(...present: string[]) {
  const set = new Set(present);
  return (p: string) => set.has(p);
}

describe("decideDocsCommit — commit routing", () => {
  test("Write to a docs .md plans the doc + sidecar as a write commit", () => {
    const md = `${DOCS}/w.md`;
    const plan = decideDocsCommit(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: md },
      },
      DOCS,
      existsFor(md),
    );
    expect(plan).toEqual({ paths: [md, `${DOCS}/w.yaml`], verb: "write" });
  });

  test("Edit to a docs .md plans just the .md as an update commit", () => {
    const md = `${DOCS}/e.md`;
    const plan = decideDocsCommit(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: md },
      },
      DOCS,
      existsFor(md),
    );
    expect(plan).toEqual({ paths: [md], verb: "update" });
  });

  test("MultiEdit routes like Edit (update, .md only)", () => {
    const md = `${DOCS}/m.md`;
    const plan = decideDocsCommit(
      {
        hook_event_name: "PostToolUse",
        tool_name: "MultiEdit",
        tool_input: { file_path: md },
      },
      DOCS,
      existsFor(md),
    );
    expect(plan).toEqual({ paths: [md], verb: "update" });
  });

  test("a Bash rm of a tracked doc plans a delete commit", () => {
    const md = `${DOCS}/d.md`;
    const plan = decideDocsCommit(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        cwd: DOCS,
        tool_input: { command: `rm ${md}` },
        tool_response: { stdout: "", stderr: "" },
      },
      DOCS,
      // a delete target need not exist on disk; rm targets are resolved from argv
      existsFor(),
    );
    expect(plan).toEqual({ paths: [md], verb: "delete" });
  });

  test("a Write OUTSIDE the docs dir plans nothing (null)", () => {
    const outside = "/elsewhere/x.md";
    const plan = decideDocsCommit(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: outside },
      },
      DOCS,
      existsFor(outside),
    );
    expect(plan).toBeNull();
  });

  test("a Write to a docs .md that does not exist on disk plans nothing", () => {
    const md = `${DOCS}/ghost.md`;
    const plan = decideDocsCommit(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: md },
      },
      DOCS,
      existsFor(), // not present
    );
    expect(plan).toBeNull();
  });

  test("a Bash command touching no docs target plans nothing", () => {
    const plan = decideDocsCommit(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        cwd: "/repo",
        tool_input: { command: "rm /repo/other.txt" },
        tool_response: { stdout: "", stderr: "" },
      },
      DOCS,
      existsFor(),
    );
    expect(plan).toBeNull();
  });
});
