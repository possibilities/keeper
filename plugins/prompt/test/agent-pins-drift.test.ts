// Drift gate for the static-agent / `agent_pins` partition (ADR 0040).
//
// Every plain-render agent template (`plugins/plan/template/agents/*.md.tmpl`,
// excluding the `subagent_templates` fan-out inventory — currently just
// `worker.md.tmpl`) must have EXACTLY one `agent_pins` entry, and every
// `agent_pins` entry must name EXACTLY one such template — a total, disjoint
// partition. A render's frontmatter must equal its pin byte-for-byte. Runs
// host-blind against the committed fixture matrix (the same
// `KEEPER_CONFIG_DIR` sandbox `parity.test.ts` pins), never the live
// `~/.config/keeper/matrix.yaml`.

import { describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentPin,
  type HostMatrixV2,
  loadHostMatrixV2,
} from "../../plan/src/host_matrix.ts";
import { runRenderPluginTemplates } from "../src/render_plugin_templates.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const KEEPER_ROOT = join(HERE, "..", "..", "..");
const LIVE_TEMPLATES_DIR = join(
  KEEPER_ROOT,
  "plugins",
  "plan",
  "template",
  "agents",
);
/** The committed, host-blind fixture matrix `parity.test.ts` also sandboxes —
 *  its `agent_pins` block is the live 11-agent set this gate pins. */
const SANDBOX_CONFIG_DIR = join(HERE, "oracle", "fixtures", "host-matrix");
const TMPL_SUFFIX = ".md.tmpl";

/** `loadHostMatrixV2` resolved under `configDir` as `KEEPER_CONFIG_DIR`, never
 *  touching a live host `~/.config/keeper/matrix.yaml`. */
function matrixUnder(configDir: string): HostMatrixV2 {
  const saved = process.env.KEEPER_CONFIG_DIR;
  process.env.KEEPER_CONFIG_DIR = configDir;
  try {
    return loadHostMatrixV2();
  } finally {
    if (saved === undefined) {
      delete process.env.KEEPER_CONFIG_DIR;
    } else {
      process.env.KEEPER_CONFIG_DIR = saved;
    }
  }
}

/** Plain-render template stems under `templatesDir`: every `*.md.tmpl` file
 *  MINUS the matrix's `subagent_templates` fan-out inventory (worker cells
 *  render through a separate {model × effort} path, never a pin). */
function plainAgentStems(templatesDir: string, matrix: HostMatrixV2): string[] {
  return readdirSync(templatesDir)
    .filter((f) => f.endsWith(TMPL_SUFFIX))
    .map((f) => f.slice(0, -TMPL_SUFFIX.length))
    .filter(
      (stem) =>
        !matrix.subagentTemplates.includes(
          `template/agents/${stem}${TMPL_SUFFIX}`,
        ),
    )
    .sort();
}

/** Copy the live plan template tree into a throwaway dir the caller may
 *  mutate (e.g. drop in an extra template) without touching the checkout. */
function copyTemplatesDir(): string {
  const work = mkdtempSync(join(tmpdir(), "agent-pins-templates-"));
  cpSync(LIVE_TEMPLATES_DIR, work, { recursive: true });
  return work;
}

/** Render the live plan plugin skeleton in-process under `configDir`. Returns
 *  the temp render root + exit code; caller cleans up `work`. */
function renderPlanInProcess(configDir: string): { work: string; rc: number } {
  const work = mkdtempSync(join(tmpdir(), "agent-pins-render-"));
  const livePlanRoot = join(KEEPER_ROOT, "plugins", "plan");
  for (const entry of [".claude-plugin", "template", "prompt-artifacts.yaml"]) {
    cpSync(join(livePlanRoot, entry), join(work, entry), { recursive: true });
  }
  writeFileSync(join(work, ".git"), ""); // synthetic project-root marker
  const saved = process.env.KEEPER_CONFIG_DIR;
  process.env.KEEPER_CONFIG_DIR = configDir;
  try {
    return { work, rc: runRenderPluginTemplates({ projectRoot: work }) };
  } finally {
    if (saved === undefined) {
      delete process.env.KEEPER_CONFIG_DIR;
    } else {
      process.env.KEEPER_CONFIG_DIR = saved;
    }
  }
}

/** Throws, naming `stem`, unless the rendered `agents/<stem>.md` frontmatter's
 *  `model:`/`effort:` lines equal `pin` exactly. */
function assertFrontmatterMatchesPin(
  renderRoot: string,
  stem: string,
  pin: AgentPin,
): void {
  const body = readFileSync(join(renderRoot, "agents", `${stem}.md`), "utf-8");
  const model = /^model:\s*(\S+)\s*$/m.exec(body)?.[1];
  const effort = /^effort:\s*"([^"]+)"\s*$/m.exec(body)?.[1];
  if (model !== pin.model || effort !== pin.effort) {
    throw new Error(
      `${stem}: rendered frontmatter {model: ${model}, effort: ${effort}} ` +
        `diverges from its agent_pins entry {model: ${pin.model}, effort: ${pin.effort}}`,
    );
  }
}

describe("agent_pins ↔ plain-render template partition (drift gate)", () => {
  test("the committed set is a total, disjoint partition (every template ↔ exactly one pin)", () => {
    const matrix = matrixUnder(SANDBOX_CONFIG_DIR);
    const stems = plainAgentStems(LIVE_TEMPLATES_DIR, matrix);
    const pinKeys = [...matrix.agentPins.keys()].sort();
    expect(stems.length).toBeGreaterThan(0);
    expect(stems).toEqual(pinKeys);
  });

  test("an 11th template with no pin violates the partition", () => {
    const work = copyTemplatesDir();
    try {
      writeFileSync(
        join(work, `orphan-template${TMPL_SUFFIX}`),
        '---\nname: orphan-template\nmodel: {{ agent_model }}\neffort: "{{ agent_effort }}"\n---\nbody\n',
      );
      const matrix = matrixUnder(SANDBOX_CONFIG_DIR);
      const stems = plainAgentStems(work, matrix);
      const pinKeys = [...matrix.agentPins.keys()].sort();
      expect(stems).not.toEqual(pinKeys);
      expect(stems).toContain("orphan-template");
      expect(pinKeys).not.toContain("orphan-template");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a 12th pin with no template violates the partition", () => {
    const extraPinMatrix = [
      "efforts: [low, medium, high, xhigh, max]",
      "subagent_templates: [template/agents/worker.md.tmpl]",
      "subagent_models: [opus, sonnet]",
      "providers:",
      "  - name: claude",
      "    models: [opus, sonnet]",
      "wrapper_driver:",
      "  model: sonnet",
      "  effort: high",
      "agent_pins:",
      "  close-planner: {model: opus, effort: high}",
      "  docs-gap-scout: {model: opus, effort: medium}",
      "  epic-scout: {model: opus, effort: medium}",
      "  gap-analyst: {model: opus, effort: xhigh}",
      "  model-selector: {model: opus, effort: high}",
      "  panel-judge: {model: opus, effort: xhigh}",
      "  panel-runner: {model: opus, effort: xhigh}",
      "  practice-scout: {model: opus, effort: medium}",
      "  quality-auditor: {model: opus, effort: high}",
      "  repo-scout: {model: opus, effort: high}",
      "  selection-auditor: {model: opus, effort: high}",
      "  orphan-pin: {model: opus, effort: high}",
      "",
    ].join("\n");
    const cfg = mkdtempSync(join(tmpdir(), "agent-pins-extra-pin-"));
    try {
      writeFileSync(join(cfg, "matrix.yaml"), extraPinMatrix);
      const matrix = matrixUnder(cfg);
      const stems = plainAgentStems(LIVE_TEMPLATES_DIR, matrix);
      const pinKeys = [...matrix.agentPins.keys()].sort();
      expect(stems).not.toEqual(pinKeys);
      expect(pinKeys).toContain("orphan-pin");
      expect(stems).not.toContain("orphan-pin");
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  test("rendered frontmatter equals the pin for every plain-render agent (temp-dir render + compare)", () => {
    const { work, rc } = renderPlanInProcess(SANDBOX_CONFIG_DIR);
    try {
      expect(rc).toBe(0);
      const matrix = matrixUnder(SANDBOX_CONFIG_DIR);
      for (const [stem, pin] of matrix.agentPins) {
        assertFrontmatterMatchesPin(work, stem, pin);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a hand-edited rendered frontmatter diverging from its pin fails the compare", () => {
    const { work, rc } = renderPlanInProcess(SANDBOX_CONFIG_DIR);
    try {
      expect(rc).toBe(0);
      const matrix = matrixUnder(SANDBOX_CONFIG_DIR);
      const pin = matrix.agentPins.get("close-planner");
      if (pin === undefined) {
        throw new Error("fixture matrix missing close-planner pin");
      }
      const target = join(work, "agents", "close-planner.md");
      const original = readFileSync(target, "utf-8");
      writeFileSync(target, original.replace("model: opus", "model: sonnet"));
      expect(() =>
        assertFrontmatterMatchesPin(work, "close-planner", pin),
      ).toThrow(/close-planner/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
