// Keystone test: the LiquidJS render engine reproduces the Python promptctl
// Jinja2 environment byte-for-byte on the 3 live plan-plugin templates.
//
// The byte-parity half renders each template with the engine, applies the SAME
// frontmatter strip + print()-newline the render-plugin-templates run module
// applies, and asserts byte-equality against the task-1 oracle goldens
// (render-plugin-templates.json). This pins the keystone risk — the shell-filter
// output (live knowctl/date), the `current_model`/`current_effort` matrix binding,
// and the Jinja keep_trailing_newline whitespace shape all land identically. The mechanics half
// asserts the StrictUndefined raise and the failing-shell fallback directly so a
// regression there names itself rather than surfacing as a byte diff.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderTemplate, rewriteShellCalls } from "../src/render_engine.ts";
import type { PluginTemplatesFixture } from "./oracle/fixture-types.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const KEEPER_ROOT = join(HERE, "..", "..", "..");
const PLAN_TEMPLATES = join(KEEPER_ROOT, "plugins", "plan", "template");

const pluginTemplates = JSON.parse(
  readFileSync(
    join(HERE, "oracle", "fixtures", "render-plugin-templates.json"),
    "utf-8",
  ),
) as PluginTemplatesFixture;

const VARIANTS_STRIP = /^variants:.*\n/m;
const RENDER_TO_STRIP = /^render_to:.*\n/m;
const MANIFEST_DESCRIPTION_STRIP = /^manifest_description:.*\n/m;

/** Apply the render-plugin-templates run-module transform to a raw render: the
 * `print()` trailing newline, then the frontmatter strips, so the engine output
 * lines up with the captured rendered-file golden. */
function asRenderedFile(text: string): string {
  return `${text}\n`
    .replace(VARIANTS_STRIP, "")
    .replace(RENDER_TO_STRIP, "")
    .replace(MANIFEST_DESCRIPTION_STRIP, "");
}

/** The golden rendered bytes for a fixture-relative output path. */
function golden(relative: string): string {
  const entry = pluginTemplates.files.find(
    (f) => f.relative === relative && !f.is_sidecar,
  );
  if (entry === undefined) {
    throw new Error(`no fixture golden for ${relative}`);
  }
  return Buffer.from(entry.content_b64, "base64").toString("utf-8");
}

describe("render engine — byte-identical vs the promptctl oracle goldens", () => {
  const cases: Array<{
    template: string;
    vars: Record<string, string> | null;
    golden: string;
  }> = [
    {
      template: join(PLAN_TEMPLATES, "agents", "practice-scout.md.tmpl"),
      vars: { agent_model: "opus", agent_effort: "medium" },
      golden: "agents/practice-scout.md",
    },
    {
      template: join(PLAN_TEMPLATES, "agents", "worker.md.tmpl"),
      vars: {
        current_model: "opus",
        current_effort: "medium",
        current_driver: "native",
      },
      golden: "workers/opus-medium/agents/worker.md",
    },
    {
      template: join(PLAN_TEMPLATES, "agents", "worker.md.tmpl"),
      vars: {
        current_model: "opus",
        current_effort: "high",
        current_driver: "native",
      },
      golden: "workers/opus-high/agents/worker.md",
    },
    {
      template: join(PLAN_TEMPLATES, "agents", "worker.md.tmpl"),
      vars: {
        current_model: "opus",
        current_effort: "xhigh",
        current_driver: "native",
      },
      golden: "workers/opus-xhigh/agents/worker.md",
    },
    {
      template: join(PLAN_TEMPLATES, "agents", "worker.md.tmpl"),
      vars: {
        current_model: "opus",
        current_effort: "max",
        current_driver: "native",
      },
      golden: "workers/opus-max/agents/worker.md",
    },
    {
      template: join(PLAN_TEMPLATES, "skills", "work.md.tmpl"),
      vars: null,
      golden: "skills/work/SKILL.md",
    },
  ];

  for (const c of cases) {
    test(`${c.golden} renders byte-identical`, () => {
      const { text } = renderTemplate(c.template, c.vars);
      expect(asRenderedFile(text)).toBe(golden(c.golden));
    });
  }
});

describe("render engine — shell filter + current_variant semantics", () => {
  test("{{ shell(...) }} runs the command and substitutes its stdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-shell-"));
    const tp = join(dir, "x.md.tmpl");
    writeFileSync(tp, 'year: {{ shell("printf 2026") }}\n');
    const { text, hadErrors } = renderTemplate(tp, null);
    expect(text).toBe("year: 2026\n");
    expect(hadErrors).toBe(false);
  });

  test("a failing shell command yields the !`cmd` fallback and hadErrors", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-shellfail-"));
    const tp = join(dir, "x.md.tmpl");
    writeFileSync(tp, 'out: {{ shell("exit 7") }}\n');
    const { text, hadErrors } = renderTemplate(tp, null);
    expect(text).toBe("out: !`exit 7`\n");
    expect(hadErrors).toBe(true);
  });

  test("bound current_variant substitutes; the trailing newline is preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-var-"));
    const tp = join(dir, "x.md.tmpl");
    writeFileSync(tp, 'effort: "{{ current_variant }}"\n');
    const { text } = renderTemplate(tp, { current_variant: "high" });
    expect(text).toBe('effort: "high"\n');
  });

  test("an UNBOUND current_variant raises (StrictUndefined parity)", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-strict-"));
    const tp = join(dir, "x.md.tmpl");
    writeFileSync(tp, 'effort: "{{ current_variant }}"\n');
    expect(() => renderTemplate(tp, null)).toThrow(/current_variant/);
  });
});

describe("render engine — shell-call rewrite is quote-aware", () => {
  test("two shell calls on one line with parens inside the command body", () => {
    const src = `{{ shell("echo (a)") }} | {{ shell('echo (b)') }}\n`;
    expect(rewriteShellCalls(src)).toBe(
      `{{ "echo (a)" | shell }} | {{ 'echo (b)' | shell }}\n`,
    );
  });

  test("leaves a non-shell output tag untouched", () => {
    expect(rewriteShellCalls("{{ current_variant }}")).toBe(
      "{{ current_variant }}",
    );
  });

  test("preserves a backslash-bearing command literal verbatim", () => {
    const src = `{{ shell("sed 's/\\\\*/x/'") }}`;
    expect(rewriteShellCalls(src)).toBe(`{{ "sed 's/\\\\*/x/'" | shell }}`);
  });
});
