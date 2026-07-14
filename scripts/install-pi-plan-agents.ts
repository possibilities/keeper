#!/usr/bin/env bun

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePromptArtifacts } from "../plugins/prompt/src/prompt_compiler.ts";

function parseArgs(argv: string[]): { check: boolean; agentDir: string } {
  let check = false;
  let agentDir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) throw new Error("missing argument");
    if (arg === "--check") {
      check = true;
    } else if (arg === "--agent-dir") {
      const value = argv[++i];
      if (!value) throw new Error("--agent-dir requires a path");
      agentDir = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { check, agentDir: resolve(agentDir) };
}

export function main(argv = process.argv.slice(2)): void {
  const { check, agentDir } = parseArgs(argv);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = compilePromptArtifacts({
    request: { target: "pi", bundle: "plan:static" },
    repoRoot,
    targetDir: join(agentDir, "agents"),
    check,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `install-pi-plan-agents: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
