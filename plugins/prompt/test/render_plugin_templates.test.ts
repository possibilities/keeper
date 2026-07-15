import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CLAUDE_WORKER_MANIFEST,
  verifyClaudeWorkerCohort,
} from "../src/claude_worker_compiler.ts";
import { compilePromptArtifacts } from "../src/prompt_compiler.ts";
import { renderTemplate } from "../src/render_engine.ts";
import { runRenderPluginTemplates } from "../src/render_plugin_templates.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const KEEPER_ROOT = join(HERE, "..", "..", "..");
const PLAN_PLUGIN = join(KEEPER_ROOT, "plugins", "plan");
const WORKER_TEMPLATE = join(
  PLAN_PLUGIN,
  "template",
  "agents",
  "worker.md.tmpl",
);

const STATIC_AGENTS = [
  "close-planner",
  "docs-gap-scout",
  "epic-scout",
  "gap-analyst",
  "model-selector",
  "panel-judge",
  "panel-runner",
  "practice-scout",
  "quality-auditor",
  "repo-scout",
  "selection-auditor",
];

const AGENT_PINS = [
  "agent_pins:",
  ...STATIC_AGENTS.map((agent) => `  ${agent}: {model: opus, effort: high}`),
];

function matrix(lines: string[]): string {
  return [...lines, ...AGENT_PINS, ""].join("\n");
}

const MULTI_PROVIDER_MATRIX = matrix([
  "efforts: [medium, high]",
  "subagent_templates: [template/agents/worker.md.tmpl]",
  "subagent_models: [opus, gpt-5.5]",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - {id: opus, efforts: [medium, high]}",
  "      - {id: sonnet, efforts: [xhigh]}",
  "  - name: codex",
  "    models: [gpt-5.5]",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: xhigh",
]);

const RAGGED_MATRIX = matrix([
  "efforts: [medium, high]",
  "subagent_templates: [template/agents/worker.md.tmpl]",
  "subagent_models: [opus, gpt-5.5]",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - id: opus",
  "        efforts: [high]",
  "      - {id: sonnet, efforts: [xhigh]}",
  "  - name: codex",
  "    models:",
  "      - id: gpt-5.5",
  "        efforts: [medium]",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: xhigh",
]);

const SINGLE_NATIVE_MATRIX = matrix([
  "efforts: [high]",
  "subagent_templates: [template/agents/worker.md.tmpl]",
  "subagent_models: [opus]",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - {id: opus, efforts: [high]}",
  "      - {id: sonnet, efforts: [xhigh]}",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: xhigh",
]);

function copyPlanPluginSkeleton(work: string): void {
  for (const entry of [".claude-plugin", "template", "prompt-artifacts.yaml"]) {
    cpSync(join(PLAN_PLUGIN, entry), join(work, entry), { recursive: true });
  }
}

function withConfig<T>(matrixYaml: string | undefined, run: () => T): T {
  const configDir = mkdtempSync(join(tmpdir(), "prompt-render-matrix-"));
  const savedConfigDir = process.env.KEEPER_CONFIG_DIR;
  if (matrixYaml !== undefined) {
    writeFileSync(join(configDir, "matrix.yaml"), matrixYaml);
  }
  process.env.KEEPER_CONFIG_DIR = configDir;
  try {
    return run();
  } finally {
    if (savedConfigDir === undefined) {
      delete process.env.KEEPER_CONFIG_DIR;
    } else {
      process.env.KEEPER_CONFIG_DIR = savedConfigDir;
    }
    rmSync(configDir, { recursive: true, force: true });
  }
}

function renderPlan(matrixYaml: string | undefined): {
  work: string;
  rc: number;
} {
  const work = mkdtempSync(join(tmpdir(), "prompt-render-plan-"));
  copyPlanPluginSkeleton(work);
  if (matrixYaml !== undefined) {
    writeFileSync(join(work, "matrix.yaml"), matrixYaml);
  }
  const rc = withConfig(matrixYaml, () =>
    runRenderPluginTemplates({ projectRoot: work }),
  );
  return { work, rc };
}

function workerCells(work: string): string[] {
  const workers = join(work, "workers");
  if (!existsSync(workers)) return [];
  return readdirSync(workers)
    .filter((name) => statSync(join(workers, name)).isDirectory())
    .sort();
}

function readWorker(work: string, cell: string): string {
  return readFileSync(
    join(work, "workers", cell, "agents", "worker.md"),
    "utf-8",
  );
}

function hasNoPartialTree(work: string): boolean {
  return ["commands", "skills", "agents", "workers"].every(
    (shape) => !existsSync(join(work, shape)),
  );
}

function captureStderr(run: () => number): { rc: number; stderr: string } {
  const priorWrite = process.stderr.write;
  const chunks: Buffer[] = [];
  process.stderr.write = ((chunk: unknown): boolean => {
    chunks.push(
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array),
    );
    return true;
  }) as typeof process.stderr.write;
  try {
    return { rc: run(), stderr: Buffer.concat(chunks).toString("utf-8") };
  } finally {
    process.stderr.write = priorWrite;
  }
}

function legacyWorker(
  work: string,
  model: string,
  effort: string,
  driver: "native" | "wrapped",
): { agent: string; plugin: string } {
  const source = join(work, "template", "agents", "worker.md.tmpl");
  const rendered = `${
    renderTemplate(source, {
      current_model: model,
      current_effort: effort,
      current_driver: driver,
      wrapper_model: "sonnet",
      wrapper_effort: "xhigh",
    }).text
  }\n`;
  const description = rendered.match(
    /^manifest_description:\s*"([^"]+)"/m,
  )?.[1];
  if (description === undefined)
    throw new Error("missing rendered description");
  return {
    agent: rendered
      .replace(/^variants:.*\n/gm, "")
      .replace(/^manifest_description:.*\n/gm, ""),
    plugin: `${JSON.stringify(
      {
        name: "work",
        description,
        version: "1.0.0",
        author: { name: "ArtHack" },
      },
      null,
      2,
    )}\n`,
  };
}

describe("runRenderPluginTemplates delegated worker publication", () => {
  test("publishes byte-equivalent native and wrapped cells plus compiler ownership metadata", () => {
    const { work, rc } = renderPlan(MULTI_PROVIDER_MATRIX);
    try {
      expect(rc).toBe(0);
      expect(workerCells(work)).toEqual([
        "gpt-5.5-high",
        "gpt-5.5-medium",
        "opus-high",
        "opus-medium",
      ]);

      const expectedFrontmatter = [
        ["gpt-5.5-high", "model: sonnet", 'effort: "xhigh"', "maxTurns: 160"],
        ["gpt-5.5-medium", "model: sonnet", 'effort: "xhigh"', "maxTurns: 160"],
        ["opus-high", "model: opus", 'effort: "high"', "maxTurns: 300"],
        ["opus-medium", "model: opus", 'effort: "medium"', "maxTurns: 300"],
      ] as const;
      for (const [cell, model, effort, maxTurns] of expectedFrontmatter) {
        const body = readWorker(work, cell);
        expect(body).toContain(model);
        expect(body).toContain(effort);
        expect(body).toContain(maxTurns);
        const assignedEffort = cell.endsWith("-medium") ? "medium" : "high";
        const assignedModel = cell.slice(0, -(assignedEffort.length + 1));
        const legacy = legacyWorker(
          work,
          assignedModel,
          assignedEffort,
          cell.startsWith("opus-") ? "native" : "wrapped",
        );
        expect(body).toBe(legacy.agent);
        expect(
          readFileSync(
            join(work, "workers", cell, ".claude-plugin", "plugin.json"),
            "utf8",
          ),
        ).toBe(legacy.plugin);
        const sidecar = JSON.parse(
          readFileSync(
            join(
              work,
              "workers",
              cell,
              "agents",
              "worker.md.managed-file-dont-edit",
            ),
            "utf8",
          ),
        ) as Record<string, unknown>;
        expect(sidecar).toMatchObject({
          publisher: "keeper-prompt-compiler",
          target: "claude",
          role: "work:worker",
        });
      }
      expect(existsSync(join(work, "workers", CLAUDE_WORKER_MANIFEST))).toBe(
        true,
      );
      expect(
        verifyClaudeWorkerCohort({
          repoRoot: work,
          planRoot: work,
          matrixPath: join(work, "matrix.yaml"),
        }).ok,
      ).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("uses each capability's own effort list instead of a rectangular product", () => {
    const { work, rc } = renderPlan(RAGGED_MATRIX);
    try {
      expect(rc).toBe(0);
      expect(workerCells(work)).toEqual(["gpt-5.5-medium", "opus-high"]);
      expect(existsSync(join(work, "workers", "gpt-5.5-high"))).toBe(false);
      expect(existsSync(join(work, "workers", "opus-medium"))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("rejects absent and schema-invalid matrices before writing any output tree", () => {
    const invalidMatrix = [
      "efforts: [high]",
      "subagent_templates: [template/agents/worker.md.tmpl]",
      "subagent_models: [opus]",
      "providers: {}",
      "wrapper_driver:",
      "  model: sonnet",
      "  effort: high",
      "",
    ].join("\n");

    for (const config of [undefined, invalidMatrix]) {
      const { work, rc } = renderPlan(config);
      try {
        expect(rc).toBe(1);
        expect(hasNoPartialTree(work)).toBe(true);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
  });

  test("makes compiler failure loud without discarding independent static outputs", () => {
    const work = mkdtempSync(join(tmpdir(), "prompt-render-no-manifest-"));
    try {
      copyPlanPluginSkeleton(work);
      const template = join(work, "template", "agents", "worker.md.tmpl");
      writeFileSync(
        template,
        readFileSync(template, "utf-8").replace(
          /^manifest_description:.*\n/m,
          "",
        ),
      );
      const { rc, stderr } = withConfig(SINGLE_NATIVE_MATRIX, () =>
        captureStderr(() => runRenderPluginTemplates({ projectRoot: work })),
      );
      expect(rc).toBe(1);
      expect(stderr).toContain("Failed to compile Claude worker cohort");
      expect(stderr).toContain("manifest_description");
      expect(existsSync(join(work, "agents", "close-planner.md"))).toBe(true);
      expect(
        existsSync(
          join(work, "workers", "opus-high", ".claude-plugin", "plugin.json"),
        ),
      ).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("reports matrix/catalog mismatch after retaining unrelated ordinary renders", () => {
    const mismatch = SINGLE_NATIVE_MATRIX.replace(
      "template/agents/worker.md.tmpl",
      "template/agents/quality-auditor.md.tmpl",
    );
    const work = mkdtempSync(join(tmpdir(), "prompt-render-catalog-mismatch-"));
    try {
      copyPlanPluginSkeleton(work);
      const { rc, stderr } = withConfig(mismatch, () =>
        captureStderr(() => runRenderPluginTemplates({ projectRoot: work })),
      );
      expect(rc).toBe(1);
      expect(stderr).toContain(
        "cell-bound catalog and matrix subagent_templates disagree",
      );
      expect(existsSync(join(work, "agents", "close-planner.md"))).toBe(true);
      expect(existsSync(join(work, "workers"))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("names an unpinned static agent while retaining pinned agents and cell fan-out", () => {
    const missingGapAnalystPin = matrix([
      "efforts: [high]",
      "subagent_templates: [template/agents/worker.md.tmpl]",
      "subagent_models: [opus]",
      "providers:",
      "  - name: claude",
      "    models:",
      "      - {id: opus, efforts: [high]}",
      "      - {id: sonnet, efforts: [xhigh]}",
      "wrapper_driver:",
      "  model: sonnet",
      "  effort: xhigh",
    ]).replace("  gap-analyst: {model: opus, effort: high}\n", "");
    const work = mkdtempSync(join(tmpdir(), "prompt-render-no-pin-"));
    try {
      copyPlanPluginSkeleton(work);
      const { rc, stderr } = withConfig(missingGapAnalystPin, () =>
        captureStderr(() => runRenderPluginTemplates({ projectRoot: work })),
      );
      expect(rc).toBe(1);
      expect(stderr).toContain("gap-analyst");
      expect(stderr).toContain("agent_pins");
      expect(existsSync(join(work, "agents", "gap-analyst.md"))).toBe(false);
      expect(existsSync(join(work, "agents", "close-planner.md"))).toBe(true);
      expect(
        existsSync(join(work, "workers", "opus-high", "agents", "worker.md")),
      ).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("renders the wrapped delegate contract and keeps the native implement phase", () => {
    const { work, rc } = renderPlan(MULTI_PROVIDER_MATRIX);
    try {
      expect(rc).toBe(0);
      const wrapped = readWorker(work, "gpt-5.5-medium");
      for (const required of [
        "keeper agent providers resolve",
        "Failure map",
        "no_route",
        "max_attempts",
        "BLOCKED: EXTERNAL_BLOCKED",
        "attacker-influenced",
        "re-run the authoritative test pass",
        "git reset --soft",
        "forbidden-trailer gate",
        "Task: $TASK_ID",
        "Job-Id:",
        "keeper commit-work",
        '--output "$KEEPER_WRAPPED_ENVELOPE"',
      ]) {
        expect(wrapped).toContain(required);
      }
      expect(wrapped).toContain(
        "## Phase 2 — Delegate implementation to the provider",
      );

      const native = readWorker(work, "opus-medium");
      expect(native).not.toContain(
        "## Phase 2 — Delegate implementation to the provider",
      );
      expect(native).toContain("## Phase 2 — Implement");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("alternates plan and Keeper roots with one canonical multi-plugin publication", () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-render-multi-root-"));
    const planRoot = join(root, "plugins", "plan");
    const otherRoot = join(root, "plugins", "other");
    try {
      mkdirSync(planRoot, { recursive: true });
      mkdirSync(otherRoot, { recursive: true });
      copyPlanPluginSkeleton(planRoot);
      copyPlanPluginSkeleton(otherRoot);
      const otherManifest = join(otherRoot, ".claude-plugin", "plugin.json");
      writeFileSync(
        otherManifest,
        readFileSync(otherManifest, "utf8").replace(
          '"name": "plan"',
          '"name": "other"',
        ),
      );
      const publication = withConfig(SINGLE_NATIVE_MATRIX, () => {
        const planRc = runRenderPluginTemplates({ projectRoot: planRoot });
        const manifestPath = join(planRoot, "workers", CLAUDE_WORKER_MANIFEST);
        const sidecarPath = join(
          planRoot,
          "workers",
          "opus-high",
          "agents",
          "worker.md.managed-file-dont-edit",
        );
        const afterPlanRoot = {
          manifest: readFileSync(manifestPath, "utf8"),
          sidecar: readFileSync(sidecarPath, "utf8"),
        };
        const keeperRc = runRenderPluginTemplates({ projectRoot: root });
        const afterKeeperRoot = {
          manifest: readFileSync(manifestPath, "utf8"),
          sidecar: readFileSync(sidecarPath, "utf8"),
        };
        const planAgainRc = runRenderPluginTemplates({ projectRoot: planRoot });
        const checked = compilePromptArtifacts({
          request: { target: "claude", bundle: "plan:work" },
          repoRoot: root,
          check: true,
        });
        return {
          planRc,
          keeperRc,
          planAgainRc,
          afterPlanRoot,
          afterKeeperRoot,
          afterPlanAgain: {
            manifest: readFileSync(manifestPath, "utf8"),
            sidecar: readFileSync(sidecarPath, "utf8"),
          },
          checked,
        };
      });
      expect(publication.planRc).toBe(0);
      expect(publication.keeperRc).toBe(0);
      expect(publication.planAgainRc).toBe(0);
      expect(publication.afterKeeperRoot).toEqual(publication.afterPlanRoot);
      expect(publication.afterPlanAgain).toEqual(publication.afterPlanRoot);
      expect(publication.checked).toMatchObject({
        outcome: "hit",
        check: true,
        ok: true,
      });
      expect(JSON.parse(publication.afterPlanRoot.manifest)).toHaveProperty(
        "fingerprint",
      );
      expect(existsSync(join(otherRoot, "workers"))).toBe(false);
      expect(existsSync(join(otherRoot, "agents", "close-planner.md"))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("contains no renderer-owned worker-cell writer", () => {
    const source = readFileSync(
      join(
        KEEPER_ROOT,
        "plugins",
        "prompt",
        "src",
        "render_plugin_templates.ts",
      ),
      "utf8",
    );
    expect(source).not.toContain("function emitCell");
    expect(source).not.toContain("workerCellDir");
    expect(source.match(/compilePromptArtifacts\(/g)).toHaveLength(1);
    expect(source).toContain('bundle: "plan:work"');
  });

  test("fails direct worker rendering when driver or wrapped-driver bindings are absent", () => {
    expect(() =>
      renderTemplate(WORKER_TEMPLATE, {
        current_model: "opus",
        current_effort: "high",
        wrapper_model: "sonnet",
        wrapper_effort: "xhigh",
      }),
    ).toThrow(/current_driver/);
    expect(() =>
      renderTemplate(WORKER_TEMPLATE, {
        current_model: "gpt-5.5",
        current_effort: "high",
        current_driver: "wrapped",
        wrapper_effort: "xhigh",
      }),
    ).toThrow(/wrapper_model/);
  });
});
