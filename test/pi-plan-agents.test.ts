import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  compilePromptArtifacts,
  PI_PROMPT_MANIFEST,
} from "../plugins/prompt/src/prompt_compiler.ts";

const LIVE_ROOT = resolve(import.meta.dir, "..");
const PIN_ROWS = [
  "  close-planner: { model: opus, effort: high }",
  "  docs-gap-scout: { model: opus, effort: medium }",
  "  epic-scout: { model: opus, effort: medium }",
  "  gap-analyst: { model: opus, effort: xhigh }",
  "  model-selector: { model: opus, effort: high }",
  "  panel-judge: { model: opus, effort: max }",
  "  panel-runner: { model: opus, effort: xhigh }",
  "  practice-scout: { model: opus, effort: medium }",
  "  quality-auditor: { model: opus, effort: high }",
  "  repo-scout: { model: opus, effort: high }",
  "  selection-auditor: { model: opus, effort: high }",
];

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  repoRoot: string;
  planRoot: string;
  matrixPath: string;
  equivalencePath: string;
  targetDir: string;
  taskFacadePath: string;
}

function matrix(
  piModels = ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra"],
): string {
  return [
    "efforts: [low, medium, high, xhigh, max]",
    "subagent_templates: [template/agents/worker.md.tmpl]",
    "subagent_models: [opus, sonnet, gpt-5.6-sol, gpt-5.6-terra]",
    "providers:",
    "  - name: claude",
    "    models: [opus, sonnet]",
    "  - name: codex",
    "    models: [gpt-5.6-sol, gpt-5.6-terra]",
    "  - name: pi",
    "    models:",
    ...piModels.map((model) => `      - ${model}`),
    "wrapper_driver: { model: sonnet, effort: high }",
    "agent_pins:",
    ...PIN_ROWS,
    "",
  ].join("\n");
}

function fixture(piModels?: string[]): Fixture {
  const repoRoot = mkdtempSync(join(tmpdir(), "prompt-compiler-"));
  temps.push(repoRoot);
  const planRoot = join(repoRoot, "plugins", "plan");
  mkdirSync(planRoot, { recursive: true });
  cpSync(
    join(LIVE_ROOT, "plugins", "plan", "template"),
    join(planRoot, "template"),
    { recursive: true },
  );
  for (const file of ["prompt-artifacts.yaml", "provider-equivalence.yaml"]) {
    cpSync(join(LIVE_ROOT, "plugins", "plan", file), join(planRoot, file));
  }
  writeFileSync(join(repoRoot, ".git"), "synthetic git marker\n");
  const taskFacadePath = join(
    repoRoot,
    "plugins",
    "keeper",
    "pi-extension",
    "task-facade.ts",
  );
  mkdirSync(dirname(taskFacadePath), { recursive: true });
  writeFileSync(taskFacadePath, "export default () => {};\n");
  const matrixPath = join(repoRoot, "config", "matrix.yaml");
  mkdirSync(dirname(matrixPath), { recursive: true });
  writeFileSync(matrixPath, matrix(piModels));
  return {
    repoRoot,
    planRoot,
    matrixPath,
    equivalencePath: join(planRoot, "provider-equivalence.yaml"),
    targetDir: join(repoRoot, "pi-agent", "agents"),
    taskFacadePath,
  };
}

function renderCanonical(
  sourcePath: string,
  variables: Readonly<Record<string, string>>,
): string {
  const source = readFileSync(sourcePath, "utf8")
    .replaceAll("{{ agent_model }}", variables.agent_model ?? "")
    .replaceAll("{{ agent_effort }}", variables.agent_effort ?? "")
    .replace(/\{\{\s*shell\("(?:\\.|[^"])*"\)\s*\}\}/g, "TEST SHELL OUTPUT");
  return `${source}\n`;
}

function compile(fx: Fixture, check = false) {
  return compilePromptArtifacts({
    request: { target: "pi", bundle: "plan:static" },
    repoRoot: fx.repoRoot,
    planRoot: fx.planRoot,
    matrixPath: fx.matrixPath,
    equivalencePath: fx.equivalencePath,
    targetDir: fx.targetDir,
    taskFacadePath: fx.taskFacadePath,
    renderCanonical,
    check,
  });
}

function headerOf(markdown: string): string {
  const close = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || close < 0)
    throw new Error("bad markdown");
  return markdown.slice(0, close);
}

function bodyOf(markdown: string): string {
  const close = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || close < 0)
    throw new Error("bad markdown");
  return markdown.slice(close + "\n---\n".length);
}

describe("role-scoped Pi prompt compiler", () => {
  test("publishes exact Pi launch metadata from canonical templates and preserves bodies", () => {
    const fx = fixture();
    mkdirSync(join(fx.planRoot, "agents"));
    writeFileSync(
      join(fx.planRoot, "agents", "repo-scout.md"),
      "---\ndescription: stale\nmodel: stale\neffort: low\n---\nSTALE INTERMEDIATE\n",
    );
    const result = compile(fx);
    expect(result.outcome).toBe("compiled");
    expect(result.ok).toBe(true);
    expect(result.outputs).toHaveLength(11);

    const scout = result.outputs.find(
      (item) => item.role === "plan:repo-scout",
    );
    expect(scout).toMatchObject({
      assigned_cell: { model: "opus", effort: "high" },
      effective_cell: { model: "gpt-5.6-sol", effort: "high" },
      launch_cell: {
        provider: "pi",
        model: "openai-codex/gpt-5.6-sol",
        effort: "high",
      },
    });
    const scoutOutput = readFileSync(
      join(fx.targetDir, "plan:repo-scout.md"),
      "utf8",
    );
    expect(scoutOutput).toContain("model: openai-codex/gpt-5.6-sol\n");
    expect(scoutOutput).toContain("thinking: high\nmax_turns: 60\n");
    expect(scoutOutput).toContain(
      'disallowed_tools: "edit, write, Task, Agent"',
    );
    expect(scoutOutput).not.toContain("STALE INTERMEDIATE");
    const canonical = renderCanonical(
      join(fx.planRoot, "template", "agents", "repo-scout.md.tmpl"),
      { agent_model: "opus", agent_effort: "high" },
    );
    expect(bodyOf(scoutOutput)).toBe(bodyOf(canonical));

    const maxOutput = readFileSync(
      join(fx.targetDir, "plan:panel-judge.md"),
      "utf8",
    );
    expect(maxOutput).toContain("thinking: xhigh\nmax_turns: 75\n");
    const runner = readFileSync(
      join(fx.targetDir, "plan:panel-runner.md"),
      "utf8",
    );
    expect(runner).toContain(
      `extensions: ${JSON.stringify(`pi-subagents, ${fx.taskFacadePath}`)}`,
    );
    expect(runner).toContain('tools: "all, ext:task-facade/Task"');
    expect(headerOf(runner)).not.toContain("Task, Agent");
    const judge = readFileSync(
      join(fx.targetDir, "plan:panel-judge.md"),
      "utf8",
    );
    expect(headerOf(judge)).toContain("Task, Agent");
    expect(headerOf(judge)).not.toContain("extensions:");
  });

  test("accepts role and workflow scopes while one manifest ensures the full static set", () => {
    const fx = fixture();
    const roleResult = compilePromptArtifacts({
      request: { target: "pi", role: "plan:repo-scout" },
      repoRoot: fx.repoRoot,
      planRoot: fx.planRoot,
      matrixPath: fx.matrixPath,
      equivalencePath: fx.equivalencePath,
      targetDir: fx.targetDir,
      taskFacadePath: fx.taskFacadePath,
      renderCanonical,
    });
    expect(roleResult.request).toEqual({
      kind: "role",
      name: "plan:repo-scout",
    });
    expect(roleResult.outputs).toHaveLength(11);

    const workflowResult = compilePromptArtifacts({
      request: { target: "pi", bundle: "plan:work" },
      repoRoot: fx.repoRoot,
      planRoot: fx.planRoot,
      matrixPath: fx.matrixPath,
      equivalencePath: fx.equivalencePath,
      targetDir: fx.targetDir,
      taskFacadePath: fx.taskFacadePath,
      renderCanonical,
    });
    expect(workflowResult.request).toEqual({
      kind: "bundle",
      name: "plan:work",
    });
    expect(workflowResult.outcome).toBe("hit");
    expect(() =>
      compilePromptArtifacts({
        request: { target: "pi", role: "work:worker" },
        repoRoot: fx.repoRoot,
        planRoot: fx.planRoot,
        matrixPath: fx.matrixPath,
        equivalencePath: fx.equivalencePath,
        targetDir: fx.targetDir,
        taskFacadePath: fx.taskFacadePath,
        renderCanonical,
      }),
    ).toThrow("currently publishes static roles only");
  });

  test("is idempotent and verifies expected hashes on the hit path", () => {
    const fx = fixture();
    const first = compile(fx);
    const second = compile(fx);
    expect(second.outcome).toBe("hit");
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.outputs.every((item) => !item.changed)).toBe(true);
    expect(compile(fx, true)).toMatchObject({
      outcome: "hit",
      ok: true,
      check: true,
    });
  });

  test("recovers compiler-owned outputs when a manifest-last publication was interrupted", () => {
    const fx = fixture();
    compile(fx);
    rmSync(join(fx.targetDir, PI_PROMPT_MANIFEST));
    const recovered = compile(fx);
    expect(recovered.outcome).toBe("compiled");
    expect(existsSync(join(fx.targetDir, PI_PROMPT_MANIFEST))).toBe(true);
    expect(compile(fx).outcome).toBe("hit");
  });

  test("source drift changes the fingerprint and recompiles from the template", () => {
    const fx = fixture();
    const first = compile(fx);
    const source = join(
      fx.planRoot,
      "template",
      "agents",
      "repo-scout.md.tmpl",
    );
    writeFileSync(
      source,
      `${readFileSync(source, "utf8")}\nSOURCE DRIFT SENTINEL\n`,
    );
    const second = compile(fx);
    expect(second.outcome).toBe("compiled");
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(
      readFileSync(join(fx.targetDir, "plan:repo-scout.md"), "utf8"),
    ).toContain("SOURCE DRIFT SENTINEL");
  });

  test("mapping drift changes effective and exact launch cells", () => {
    const fx = fixture();
    const first = compile(fx);
    const map = readFileSync(fx.equivalencePath, "utf8");
    const from = [
      "    - source: { model: opus, effort: high }",
      "      target: { model: gpt-5.6-sol, effort: high }",
    ].join("\n");
    const to = [
      "    - source: { model: opus, effort: high }",
      "      target: { model: gpt-5.6-terra, effort: high }",
    ].join("\n");
    expect(map).toContain(from);
    writeFileSync(fx.equivalencePath, map.replace(from, to));
    const second = compile(fx);
    expect(second.outcome).toBe("compiled");
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(
      second.outputs.find((item) => item.role === "plan:repo-scout"),
    ).toMatchObject({
      effective_cell: { model: "gpt-5.6-terra", effort: "high" },
      launch_cell: { model: "openai-codex/gpt-5.6-terra" },
    });
  });

  test("repairs output corruption without treating inputs as a new compile", () => {
    const fx = fixture();
    compile(fx);
    const output = join(fx.targetDir, "plan:repo-scout.md");
    const pristine = readFileSync(output, "utf8");
    writeFileSync(output, `${pristine}CORRUPTION\n`);
    const repaired = compile(fx);
    expect(repaired.outcome).toBe("repaired");
    expect(
      repaired.outputs.find((item) => item.role === "plan:repo-scout")?.changed,
    ).toBe(true);
    expect(readFileSync(output, "utf8")).toBe(pristine);
  });

  test("refuses an unmanaged plan definition", () => {
    const fx = fixture();
    mkdirSync(fx.targetDir, { recursive: true });
    writeFileSync(join(fx.targetDir, "plan:repo-scout.md"), "human-owned\n");
    expect(() => compile(fx)).toThrow(
      "refusing to overwrite an unmanaged plan agent",
    );
  });

  test("fails loud on missing or malformed equivalence maps", () => {
    const fx = fixture();
    expect(() =>
      compilePromptArtifacts({
        request: { target: "pi", role: "plan:repo-scout" },
        repoRoot: fx.repoRoot,
        planRoot: fx.planRoot,
        matrixPath: fx.matrixPath,
        equivalencePath: join(fx.planRoot, "missing.yaml"),
        targetDir: fx.targetDir,
        taskFacadePath: fx.taskFacadePath,
        renderCanonical,
      }),
    ).toThrow();
    writeFileSync(fx.equivalencePath, "schema_version: 1\nunknown: true\n");
    expect(() => compile(fx)).toThrow("unknown key 'unknown'");
  });

  test("fails when Pi has no route for the mapped effective cell", () => {
    const fx = fixture(["openai-codex/gpt-5.6-terra"]);
    expect(() => compile(fx)).toThrow(
      "provider pi has no route for effective capability 'gpt-5.6-sol'",
    );
  });

  test("check mode reports drift, writes nothing, and leaves corruption untouched", () => {
    const fx = fixture();
    const emptyCheck = compile(fx, true);
    expect(emptyCheck).toMatchObject({
      outcome: "compiled",
      ok: false,
      check: true,
    });
    expect(existsSync(fx.targetDir)).toBe(false);

    compile(fx);
    const output = join(fx.targetDir, "plan:repo-scout.md");
    writeFileSync(output, "drift\n");
    const driftCheck = compile(fx, true);
    expect(driftCheck).toMatchObject({
      outcome: "repaired",
      ok: false,
      check: true,
    });
    expect(readFileSync(output, "utf8")).toBe("drift\n");
  });

  test("cleans manifest-owned orphans and keeps manifest publication last", () => {
    const fx = fixture();
    compile(fx);
    const manifestPath = join(fx.targetDir, PI_PROMPT_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Record<string, string>;
      sidecars: Record<string, string>;
    };
    const orphan = "plan:retired.md";
    const orphanSidecar = `${orphan}.managed-file-dont-edit`;
    const body = "retired\n";
    const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    manifest.files[orphan] = hash;
    manifest.sidecars[orphanSidecar] = hash;
    writeFileSync(join(fx.targetDir, orphan), body);
    writeFileSync(join(fx.targetDir, orphanSidecar), body);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = compile(fx);
    expect(result.outcome).toBe("repaired");
    expect(result.removed).toContain(orphan);
    expect(existsSync(join(fx.targetDir, orphan))).toBe(false);
    expect(existsSync(join(fx.targetDir, orphanSidecar))).toBe(false);
    expect(
      JSON.parse(readFileSync(manifestPath, "utf8")).files[orphan],
    ).toBeUndefined();
  });

  test("the install paths retain Pi's nested Task compatibility and invoke the compiler seam", () => {
    const install = readFileSync(
      join(LIVE_ROOT, "scripts", "install.sh"),
      "utf8",
    );
    expect(install).toContain("getActiveScopeContext");
    expect(install).toContain("PROTOCOL_VERSION[[:space:]]*=[[:space:]]*3");
    expect(install).toContain("manager.cancelScope(handle");
    expect(install).toContain("nested Task context + scoped cancellation");

    const script = readFileSync(
      join(LIVE_ROOT, "scripts", "install-pi-plan-agents.ts"),
      "utf8",
    );
    expect(script).toContain("compilePromptArtifacts");
    expect(script).not.toContain('"plugins", "plan", "agents"');
  });
});
