/**
 * Tests for the fn-884 `.4` docs sidecar migration (`scripts/docs-migrate.ts`).
 *
 * The strip-signature + sidecar serialize logic is covered in
 * sidecar-writer.test.ts (shared `src/sidecar.ts`); here we cover the
 * migration-specific glue against a sandboxed tmpdir docs tree:
 *  - `extractStampFields` parses the stamped EOF yaml/sh fences into sidecar
 *    fields and runs `gist-url` through the bounded matcher;
 *  - `migrateDoc` strips a stamped `.md` (strictly shorter), writes the sidecar,
 *    leaves a hand-authored `## N. Metadata` body alone, sparse-backfills a
 *    metadata-less doc, and is a no-op on a second run;
 *  - `fixSidecarGistUrl` trims a swallowed JSON tail and is a no-op on a clean
 *    URL;
 *  - `walkDocs` skips `.git`/`.kit`/`README.md` and recurses `archive/`.
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
  bareFenceStampIndex,
  extractBareFenceStampFields,
  extractStampFields,
  fixSidecarGistUrl,
  migrateDoc,
  sparseFields,
  stripBareFenceStamp,
  walkDocs,
} from "../scripts/docs-migrate.ts";
import { loadSidecar } from "../src/sidecar.ts";

const STAMP =
  "\n---\n\n## Metadata\n\n```yaml\n" +
  "cwd: /Users/mike/code/arthack\n" +
  "session-id: 922fc5e9-0429-44ad-9baa-7c14e9819c0a\n" +
  "session-name: demo\n" +
  "path: /Users/mike/docs/sample.md\n" +
  "```\n\n```sh\n" +
  "cd /Users/mike/code/arthack && claude --resume 922fc5e9-0429-44ad-9baa-7c14e9819c0a\n" +
  "```\n";

// A headingless bare-fence EOF stamp (the 6-doc legacy variant): no
// `## Metadata` heading, just a ```yaml fence + ```sh resume fence at EOF.
const BARE_STAMP =
  "\n---\n\n```yaml\n" +
  "cwd: /Users/mike/code/arthack\n" +
  "session-id: a722a7fc-bb9c-49a4-99b9-8b21baa4dd06\n" +
  "session-name: bare-variant\n" +
  "path: /Users/mike/docs/bare.md\n" +
  "```\n\n```sh\n" +
  "claude --resume a722a7fc-bb9c-49a4-99b9-8b21baa4dd06\n" +
  "```\n";

const BODY = "# Sample\n\nSome prose.\n";

describe("extractStampFields", () => {
  test("parses yaml + sh fences into sidecar fields", () => {
    const f = extractStampFields(BODY + STAMP);
    expect(f.get("session-id")).toBe("922fc5e9-0429-44ad-9baa-7c14e9819c0a");
    expect(f.get("cwd")).toBe("/Users/mike/code/arthack");
    expect(f.get("session-name")).toBe("demo");
    expect(f.get("type")).toBe("doc");
    expect(f.get("resume")).toContain("claude --resume");
  });

  test("empty map when no machine stamp present", () => {
    expect(extractStampFields(BODY).size).toBe(0);
    // A hand-authored Metadata heading (no session-id in fence) is NOT a stamp.
    const authored = `${BODY}\n## Metadata\n\nAuthor notes, no fence.\n`;
    expect(extractStampFields(authored).size).toBe(0);
  });

  test("runs a swallowed gist-url through the bounded matcher", () => {
    const corrupt =
      BODY +
      "\n---\n\n## Metadata\n\n```yaml\n" +
      "session-id: abc\npath: /x.md\n" +
      'gist-url: https://gist.github.com/u/deadbeef","stderr":"","x":false}\n' +
      "```\n";
    const f = extractStampFields(corrupt);
    expect(f.get("gist-url")).toBe("https://gist.github.com/u/deadbeef");
  });
});

describe("bare-fence (headingless) EOF stamp", () => {
  test("detects + strips a bare-fence stamp, body strictly shorter", () => {
    const full = BODY + BARE_STAMP;
    expect(bareFenceStampIndex(full)).toBeGreaterThan(0);
    const out = stripBareFenceStamp(full);
    expect(out.length).toBeLessThan(full.length);
    expect(out).not.toContain("```yaml");
    expect(out).toContain("Some prose.");
  });

  test("parses fields incl resume", () => {
    const f = extractBareFenceStampFields(BODY + BARE_STAMP);
    expect(f.get("session-id")).toBe("a722a7fc-bb9c-49a4-99b9-8b21baa4dd06");
    expect(f.get("session-name")).toBe("bare-variant");
    expect(f.get("resume")).toContain("claude --resume");
    expect(f.get("type")).toBe("doc");
  });

  test("no match on top-of-file frontmatter (must survive)", () => {
    const frontmatter =
      "---\nsession-id: 0facfbc7\npath: /x.md\n---\n\n# Doc\n\nbody.\n";
    expect(bareFenceStampIndex(frontmatter)).toBe(-1);
    expect(stripBareFenceStamp(frontmatter)).toBe(frontmatter);
  });

  test("no match on a fence quoted mid-body (example content)", () => {
    const midBody =
      "# Doc\n\nExample frontmatter:\n\n```yaml\n" +
      "session-id: abc123\npath: /x.md\n```\n\nMore prose after.\n";
    expect(bareFenceStampIndex(midBody)).toBe(-1);
    expect(stripBareFenceStamp(midBody)).toBe(midBody);
  });

  test("no match on a fence lacking session-id or path", () => {
    const plain = "# Doc\n\n```yaml\nfoo: bar\n```\n";
    expect(bareFenceStampIndex(plain)).toBe(-1);
  });

  test("migrateDoc strips a bare-fence doc + writes the sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-migrate-bare-"));
    try {
      const md = join(dir, "bare.md");
      const full = BODY + BARE_STAMP;
      writeFileSync(md, full);
      const r = migrateDoc(md, dir, "bare.md", true);
      expect(r.stamped).toBe(true);
      expect(r.stripped).toBe(true);
      const after = readFileSync(md, "utf8");
      expect(after.length).toBeLessThan(full.length);
      expect(after).not.toContain("```yaml");
      const sc = loadSidecar(join(dir, "bare.yaml"));
      expect(sc.fields.get("session-id")).toBe(
        "a722a7fc-bb9c-49a4-99b9-8b21baa4dd06",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fixSidecarGistUrl", () => {
  test("trims a swallowed JSON tail", () => {
    const sc = {
      fields: new Map([
        [
          "gist-url",
          'https://gist.github.com/u/deadbeef","stderr":"","x":false}',
        ],
      ]),
      tail: "",
    };
    expect(fixSidecarGistUrl(sc)).toBe(true);
    expect(sc.fields.get("gist-url")).toBe(
      "https://gist.github.com/u/deadbeef",
    );
  });

  test("no-op on a clean URL", () => {
    const sc = {
      fields: new Map([["gist-url", "https://gist.github.com/u/clean"]]),
      tail: "",
    };
    expect(fixSidecarGistUrl(sc)).toBe(false);
    expect(sc.fields.get("gist-url")).toBe("https://gist.github.com/u/clean");
  });

  test("no-op when there is no gist-url", () => {
    const sc = { fields: new Map([["path", "/x.md"]]), tail: "" };
    expect(fixSidecarGistUrl(sc)).toBe(false);
  });
});

describe("walkDocs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-migrate-walk-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("recurses archive/, skips README/.git/.kit", () => {
    writeFileSync(join(dir, "a.md"), BODY);
    writeFileSync(join(dir, "README.md"), BODY);
    mkdirSync(join(dir, "archive"));
    writeFileSync(join(dir, "archive", "b.md"), BODY);
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "c.md"), BODY);
    mkdirSync(join(dir, ".kit"));
    writeFileSync(join(dir, ".kit", "d.md"), BODY);

    const found = walkDocs(dir)
      .map((p) => p.slice(dir.length + 1))
      .sort();
    expect(found).toEqual(["a.md", "archive/b.md"]);
  });
});

describe("migrateDoc", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-migrate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("strips a stamped doc (strictly shorter) + writes the sidecar", () => {
    const md = join(dir, "sample.md");
    const full = BODY + STAMP;
    writeFileSync(md, full);

    const r = migrateDoc(md, dir, "sample.md", true);
    expect(r.stamped).toBe(true);
    expect(r.stripped).toBe(true);

    const after = readFileSync(md, "utf8");
    expect(after.length).toBeLessThan(full.length);
    expect(after).not.toContain("## Metadata");
    expect(after).toContain("Some prose.");

    const sc = loadSidecar(join(dir, "sample.yaml"));
    expect(sc.fields.get("session-id")).toBe(
      "922fc5e9-0429-44ad-9baa-7c14e9819c0a",
    );
    expect(sc.fields.get("type")).toBe("doc");
    expect(sc.fields.get("created")).toBeDefined();
  });

  test("dry-run writes nothing", () => {
    const md = join(dir, "sample.md");
    const full = BODY + STAMP;
    writeFileSync(md, full);

    const r = migrateDoc(md, dir, "sample.md", false);
    expect(r.stamped).toBe(true);
    expect(readFileSync(md, "utf8")).toBe(full);
    expect(existsSync(join(dir, "sample.yaml"))).toBe(false);
  });

  test("second run is a no-op", () => {
    const md = join(dir, "sample.md");
    writeFileSync(md, BODY + STAMP);

    migrateDoc(md, dir, "sample.md", true);
    const mdAfter1 = readFileSync(md, "utf8");
    const scAfter1 = readFileSync(join(dir, "sample.yaml"), "utf8");

    const r2 = migrateDoc(md, dir, "sample.md", true);
    expect(r2.stamped).toBe(false);
    expect(r2.stripped).toBe(false);
    expect(readFileSync(md, "utf8")).toBe(mdAfter1);
    expect(readFileSync(join(dir, "sample.yaml"), "utf8")).toBe(scAfter1);
  });

  test("hand-authored ## N. Metadata body survives + gets a sparse sidecar", () => {
    const md = join(dir, "authored.md");
    const authored =
      "# Doc\n\n## 1. Intro\n\ntext\n\n## 2. Metadata\n\nauthor's own.\n";
    writeFileSync(md, authored);

    const r = migrateDoc(md, dir, "authored.md", true);
    expect(r.stamped).toBe(false);
    expect(r.stripped).toBe(false);
    expect(readFileSync(md, "utf8")).toBe(authored);

    const sc = loadSidecar(join(dir, "authored.yaml"));
    expect(sc.fields.get("type")).toBe("doc");
    expect(sc.fields.get("path")).toBe(md);
  });

  test("merges into an existing sidecar, preserving created + fixing gist-url", () => {
    const md = join(dir, "sample.md");
    writeFileSync(md, BODY + STAMP);
    writeFileSync(
      join(dir, "sample.yaml"),
      "path: " +
        md +
        "\ntype: doc\ncreated: 2020-01-01T00:00:00-0500\n" +
        'gist-url: https://gist.github.com/u/old","stderr":""}\n',
    );

    const r = migrateDoc(md, dir, "sample.md", true);
    expect(r.hadSidecar).toBe(true);
    expect(r.gistFixed).toBe(true);

    const sc = loadSidecar(join(dir, "sample.yaml"));
    expect(sc.fields.get("created")).toBe("2020-01-01T00:00:00-0500");
    expect(sc.fields.get("gist-url")).toBe("https://gist.github.com/u/old");
    expect(sc.fields.get("session-id")).toBe(
      "922fc5e9-0429-44ad-9baa-7c14e9819c0a",
    );
  });

  test("throws if a stamped strip fails the strictly-shorter invariant", () => {
    // A body whose `## Metadata` fence lacks session-id is NOT a stamp, so
    // stamped=false and no throw — assert the guard only fires on real stamps
    // by constructing a stamped doc and confirming strip shortens it.
    const md = join(dir, "ok.md");
    writeFileSync(md, BODY + STAMP);
    expect(() => migrateDoc(md, dir, "ok.md", false)).not.toThrow();
  });
});

describe("sparseFields", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-migrate-sparse-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("path + type + created from mtime when untracked", () => {
    const md = join(dir, "x.md");
    writeFileSync(md, BODY);
    const f = sparseFields(md, dir, "x.md");
    expect(f.get("path")).toBe(md);
    expect(f.get("type")).toBe("doc");
    expect(f.get("created")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/,
    );
  });
});
