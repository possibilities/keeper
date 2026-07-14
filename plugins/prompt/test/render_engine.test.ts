import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderTemplate, rewriteShellCalls } from "../src/render_engine.ts";
import type { PluginTemplatesFixture } from "./oracle/fixture-types.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const KEEPER_ROOT = join(HERE, "..", "..", "..");
const WORKER_TEMPLATE = join(
  KEEPER_ROOT,
  "plugins",
  "plan",
  "template",
  "agents",
  "worker.md.tmpl",
);
const fixtures = JSON.parse(
  readFileSync(
    join(HERE, "oracle", "fixtures", "render-plugin-templates.json"),
    "utf-8",
  ),
) as PluginTemplatesFixture;

function rendered(text: string): string {
  return `${text}\n`
    .replace(/^variants:.*\n/m, "")
    .replace(/^render_to:.*\n/m, "")
    .replace(/^manifest_description:.*\n/m, "");
}

function golden(relative: string): string {
  const entry = fixtures.files.find(
    (file) => file.relative === relative && !file.is_sidecar,
  );
  if (entry === undefined) throw new Error(`missing golden: ${relative}`);
  return Buffer.from(entry.content_b64, "base64").toString("utf-8");
}

describe("render engine", () => {
  test("renders the native worker representative byte-for-byte", () => {
    const { text } = renderTemplate(WORKER_TEMPLATE, {
      current_model: "opus",
      current_effort: "medium",
      current_driver: "native",
    });
    expect(rendered(text)).toBe(golden("workers/opus-medium/agents/worker.md"));
  });

  test("rejects an unbound template variable", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-strict-"));
    const template = join(dir, "x.md.tmpl");
    try {
      writeFileSync(template, 'effort: "{{ current_variant }}"\n');
      expect(() => renderTemplate(template, null)).toThrow(/current_variant/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rewrites quoted shell calls without changing other output tags", () => {
    expect(
      rewriteShellCalls(`{{ shell("echo (a)") }} | {{ current_variant }}\n`),
    ).toBe(`{{ "echo (a)" | shell }} | {{ current_variant }}\n`);
  });
});
