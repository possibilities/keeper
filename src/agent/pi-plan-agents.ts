import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import yaml from "js-yaml";

import {
  compilePromptArtifacts,
  type PromptCompileResult,
  translateClaudeAgentToPi,
} from "../../plugins/prompt/src/prompt_compiler.ts";

export {
  compilePromptArtifacts,
  type PromptCompileOptions,
  type PromptCompileResult,
} from "../../plugins/prompt/src/prompt_compiler.ts";

/** Compatibility options for callers of the former installer. `sourceDir` is
 * used only to locate the plan package; generated `agents/*.md` files are never
 * read. Compilation always starts at `template/agents/*.md.tmpl`. */
export interface PiPlanAgentInstallOptions {
  sourceDir: string;
  targetDir: string;
  check?: boolean;
  matrixPath?: string;
  equivalencePath?: string;
  catalogPath?: string;
}

export interface PiPlanAgentInstallResult {
  changed: string[];
  removed: string[];
  checked: string[];
  compile: PromptCompileResult;
}

/** @deprecated Compile the package catalog with {@link installPiPlanAgents}.
 * Source-compatible one-file translation for a rendered Claude agent path. The
 * body stays byte-exact and the compatibility Pi header omits `model:`. */
export function renderPiPlanAgent(path: string): {
  filename: string;
  content: string;
  body: string;
} {
  const rendered = readFileSync(path, "utf8");
  if (!rendered.startsWith("---\n")) {
    throw new Error(`${path}: missing YAML frontmatter`);
  }
  const close = rendered.indexOf("\n---\n", 4);
  if (close < 0) throw new Error(`${path}: unterminated YAML frontmatter`);
  const frontmatter = yaml.load(rendered.slice(4, close));
  if (
    frontmatter === null ||
    typeof frontmatter !== "object" ||
    Array.isArray(frontmatter)
  ) {
    throw new Error(`${path}: frontmatter must be an object`);
  }
  const rec = frontmatter as Record<string, unknown>;
  const name = basename(path, ".md");
  const translated = translateClaudeAgentToPi({
    role: `plan:${name}`,
    sourcePath: path,
    rendered,
    launchModel: typeof rec.model === "string" ? rec.model : "",
    launchEffort: typeof rec.effort === "string" ? rec.effort : "",
    taskFacadePath: resolve(
      dirname(path),
      "..",
      "..",
      "keeper",
      "pi-extension",
      "task-facade.ts",
    ),
    emitModel: false,
  });
  return {
    filename: `plan:${name}.md`,
    content: translated.content,
    body: translated.body,
  };
}

/** Compatibility facade over the sole prompt compiler implementation. */
export function installPiPlanAgents(
  options: PiPlanAgentInstallOptions,
): PiPlanAgentInstallResult {
  const planRoot = resolve(dirname(options.sourceDir));
  const repoRoot = resolve(planRoot, "../..");
  const result = compilePromptArtifacts({
    request: { target: "pi", bundle: "plan:static" },
    repoRoot,
    planRoot,
    targetDir: options.targetDir,
    matrixPath: options.matrixPath,
    equivalencePath: options.equivalencePath,
    catalogPath: options.catalogPath,
    check: options.check,
  });
  if (options.check && !result.ok) {
    throw new Error(`Pi plan agents are stale: ${result.drifted.join(", ")}`);
  }
  const changed = result.outputs
    .filter((output) => output.changed || output.sidecar_changed)
    .map((output) => output.output);
  if (result.drifted.includes(".keeper-plan-agents.json")) {
    changed.push(".keeper-plan-agents.json");
  }
  return {
    changed,
    removed: [...result.removed],
    checked: result.outputs.map((output) => output.output),
    compile: result,
  };
}
