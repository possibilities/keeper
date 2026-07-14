import { dirname, resolve } from "node:path";

import {
  compilePromptArtifacts,
  type PromptCompileResult,
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
    throw new Error(
      `Pi plan agents are stale: ${result.outputs
        .filter((output) => output.changed)
        .map((output) => output.output)
        .concat(result.removed)
        .join(", ")}`,
    );
  }
  return {
    changed: result.outputs
      .filter((output) => output.changed)
      .map((output) => output.output),
    removed: [...result.removed],
    checked: result.outputs.map((output) => output.output),
    compile: result,
  };
}
