import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  captureTemplateGraph,
  findUnsnapshottedRenderDependencies,
  renderCapturedTemplate,
  renderTemplate,
  rewriteShellCalls,
} from "../src/render_engine.ts";
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

  test("captures both worker branches and renders exclusively from captured bytes", () => {
    const graph = captureTemplateGraph(
      WORKER_TEMPLATE,
      join(KEEPER_ROOT, "plugins", "plan", "template"),
    );
    expect(graph.files.map((file) => file.path)).toEqual([
      "_partials/worker-implement-native.md",
      "_partials/worker-implement-wrapped.md",
      "agents/worker.md.tmpl",
    ]);
    const native = renderCapturedTemplate(graph, {
      current_model: "opus",
      current_effort: "medium",
      current_driver: "native",
      wrapper_model: "sonnet",
      wrapper_effort: "high",
    });
    expect(rendered(native.text)).toBe(
      golden("workers/opus-medium/agents/worker.md"),
    );
  });

  test("captures transitive literal dependencies and ignores post-capture mutation", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-capture-"));
    const entry = join(dir, "entry.md");
    mkdirSync(join(dir, "parts"));
    try {
      writeFileSync(entry, `{% include "parts/one.md" %}`);
      writeFileSync(
        join(dir, "parts", "one.md"),
        `one:{% render "parts/two.md" %}`,
      );
      writeFileSync(join(dir, "parts", "two.md"), "captured");
      const graph = captureTemplateGraph(entry, dir);
      writeFileSync(join(dir, "parts", "two.md"), "mutated");
      expect(renderCapturedTemplate(graph).text).toBe("one:captured");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects dynamic, missing, cyclic, escaped, disk-backed, and shell dependencies", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-invalid-capture-"));
    const outside = `${dir}-outside.md`;
    const entry = join(dir, "entry.md");
    mkdirSync(dir, { recursive: true });
    try {
      const cases: Array<[string, string, RegExp]> = [
        ["dynamic", `{% include dependency %}`, /dynamic Liquid include/],
        ["missing", `{% include "missing.md" %}`, /dependency is missing/],
        [
          "escape",
          `{% include "../outside.md" %}`,
          /escapes its template root/,
        ],
        ["helper", `{{ file_exists("README.md") }}`, /file_exists/],
        ["shell", `{{ "date" | shell }}`, /shell execution/],
      ];
      for (const [, source, error] of cases) {
        writeFileSync(entry, source);
        expect(() => captureTemplateGraph(entry, dir)).toThrow(error);
      }
      writeFileSync(entry, `{% layout "a.md" %}`);
      writeFileSync(join(dir, "a.md"), `{% include "entry.md" %}`);
      expect(() => captureTemplateGraph(entry, dir)).toThrow(
        /dependency cycle/,
      );

      writeFileSync(outside, "outside");
      rmSync(join(dir, "a.md"), { force: true });
      symlinkSync(outside, join(dir, "a.md"));
      writeFileSync(entry, `{% include "a.md" %}`);
      expect(() => captureTemplateGraph(entry, dir)).toThrow(
        /resolves outside template root/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
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

  test("finds disk dependencies only in executable Liquid syntax", () => {
    const inert = [
      "Prose about include, snippet(), snippets(), all_snippets_in(), and file_exists().",
      `{% assign example = "snippet('quoted')" %}`,
      `{% comment %}{% include "commented.md" %}{{ file_exists("x") }}{% endcomment %}`,
      `{% raw %}{% render "raw.md" %}{{ snippets() }}{% endraw %}`,
    ].join("\n");
    expect(findUnsnapshottedRenderDependencies(inert)).toEqual([]);

    const active = [
      `{% include "partial.md" %}`,
      `{{ snippet("named") }}`,
      `{% if file_exists("README.md") %}yes{% endif %}`,
      `{% liquid`,
      `render "other.md"`,
      `assign paths = all_snippets_in("plan")`,
      `%}`,
    ].join("\n");
    expect(findUnsnapshottedRenderDependencies(active)).toEqual([
      "all_snippets_in",
      "file_exists",
      "include",
      "render",
      "snippet",
    ]);
  });
});
