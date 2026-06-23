// Unit tests for the prompt plugin's bundle YAML writer. yamlDump's PyYAML-
// matching block-style options (noArrayIndent, lineWidth -1, sortKeys false) are
// load-bearing: the on-disk bundle YAML is byte-pinned, so a drift in the options
// silently changes every saved bundle. The serializeBundle round-trip asserts the
// canonical write/read shape survives unchanged.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBundleFile,
  serializeBundle,
  writeBundleAtomic,
} from "../src/bundle_io.ts";
import type { Bundle } from "../src/bundle_schema.ts";
import { yamlDump } from "../src/yaml_dump.ts";

describe("yamlDump", () => {
  test("block style, no key sorting, unicode preserved", () => {
    expect(
      yamlDump({
        success: true,
        project: { name: "x", path: "/r", schema_version: 1 },
        epics: { total: 2, open: 2, done: 0 },
      }),
    ).toBe(
      "success: true\n" +
        "project:\n" +
        "  name: x\n" +
        "  path: /r\n" +
        "  schema_version: 1\n" +
        "epics:\n" +
        "  total: 2\n" +
        "  open: 2\n" +
        "  done: 0\n",
    );
  });

  test("dash-at-parent-indent for lists (noArrayIndent / PyYAML parity)", () => {
    expect(
      yamlDump({
        epics: [
          { id: "fn-1-cafe", title: "Café résumé ☕" },
          { id: "fn-zzz-weird", title: "Weird" },
        ],
      }),
    ).toBe(
      "epics:\n" +
        "- id: fn-1-cafe\n" +
        "  title: Café résumé ☕\n" +
        "- id: fn-zzz-weird\n" +
        "  title: Weird\n",
    );
  });

  test("literal block scalar for multiline strings", () => {
    expect(yamlDump({ spec: "## Description\nseed overview\n" })).toBe(
      "spec: |\n  ## Description\n  seed overview\n",
    );
  });
});

describe("serializeBundle", () => {
  const bundle: Bundle = {
    id: "my-bundle",
    snippet_ids: ["engineering/foo", "engineering/bar"],
    summary: "A test bundle ☕",
    tags: ["a", "b"],
    created_at: "2026-06-23T00:00:00.000Z",
  };

  test("canonical field order, block style", () => {
    expect(serializeBundle(bundle)).toBe(
      "id: my-bundle\n" +
        "snippet_ids:\n" +
        "- engineering/foo\n" +
        "- engineering/bar\n" +
        "summary: A test bundle ☕\n" +
        "tags:\n" +
        "- a\n" +
        "- b\n" +
        "created_at: '2026-06-23T00:00:00.000Z'\n",
    );
  });

  test("write/read round-trips byte-for-byte through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-bundle-io-"));
    try {
      const path = join(dir, "my-bundle.yaml");
      writeBundleAtomic(path, bundle);
      const loaded = loadBundleFile(path, "my-bundle");
      expect(loaded).toEqual(bundle);
      expect(serializeBundle(loaded)).toBe(serializeBundle(bundle));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
