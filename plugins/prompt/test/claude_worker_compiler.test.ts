import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CLAUDE_WORKER_MANIFEST,
  compileClaudeWorkerArtifacts,
  verifyClaudeWorkerCohort,
} from "../src/claude_worker_compiler.ts";
import { renderTemplate } from "../src/render_engine.ts";

const LIVE_ROOT = resolve(import.meta.dir, "../../..");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.keeper-prompt-claude.lock`, { force: true });
  }
});

interface Fixture {
  repoRoot: string;
  planRoot: string;
  matrixPath: string;
  targetDir: string;
}

function matrix(
  options: { includeHigh?: boolean; template?: string } = {},
): string {
  const opusEfforts = options.includeHigh === false ? "[low]" : "[low, high]";
  return [
    "efforts: [low, medium, high]",
    `subagent_templates: [${options.template ?? "template/agents/worker.md.tmpl"}]`,
    "subagent_models: [opus, gpt-5.6]",
    "providers:",
    "  - name: claude",
    "    models:",
    `      - { id: opus, efforts: ${opusEfforts} }`,
    "      - sonnet",
    "  - name: codex",
    "    models:",
    "      - { id: gpt-5.6, efforts: [medium] }",
    "wrapper_driver: { model: sonnet, effort: high }",
    "",
  ].join("\n");
}

function fixture(): Fixture {
  const repoRoot = mkdtempSync(join(tmpdir(), "claude-worker-compiler-"));
  temps.push(repoRoot);
  const planRoot = join(repoRoot, "plugins", "plan");
  mkdirSync(planRoot, { recursive: true });
  cpSync(
    join(LIVE_ROOT, "plugins", "plan", "template"),
    join(planRoot, "template"),
    { recursive: true },
  );
  cpSync(
    join(LIVE_ROOT, "plugins", "plan", "prompt-artifacts.yaml"),
    join(planRoot, "prompt-artifacts.yaml"),
  );
  mkdirSync(join(repoRoot, ".git"));
  const matrixPath = join(repoRoot, "matrix.yaml");
  writeFileSync(matrixPath, matrix());
  return {
    repoRoot,
    planRoot,
    matrixPath,
    targetDir: join(planRoot, "workers"),
  };
}

function compile(fx: Fixture, check = false) {
  return compileClaudeWorkerArtifacts({
    request: { target: "claude", role: "work:worker" },
    repoRoot: fx.repoRoot,
    planRoot: fx.planRoot,
    matrixPath: fx.matrixPath,
    targetDir: fx.targetDir,
    check,
  });
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function legacyRendered(
  fx: Fixture,
  model: string,
  effort: string,
  driver: "native" | "wrapped",
): string {
  const source = join(fx.planRoot, "template", "agents", "worker.md.tmpl");
  return `${
    renderTemplate(source, {
      current_model: model,
      current_effort: effort,
      current_driver: driver,
      wrapper_model: "sonnet",
      wrapper_effort: "high",
    }).text
  }\n`
    .replace(/^variants:.*\n/gm, "")
    .replace(/^manifest_description:.*\n/gm, "");
}

function verify(fx: Fixture) {
  return verifyClaudeWorkerCohort({
    repoRoot: fx.repoRoot,
    planRoot: fx.planRoot,
    matrixPath: fx.matrixPath,
    targetDir: fx.targetDir,
  });
}

describe("Claude worker cohort compiler", () => {
  test("publishes sorted ragged native and wrapped cells with legacy body parity", () => {
    const fx = fixture();
    const result = compile(fx);
    expect(
      result.outputs.map((row) => `${row.cell.model}/${row.cell.effort}`),
    ).toEqual(["gpt-5.6/medium", "opus/high", "opus/low"]);
    expect(result.outputs[0]).toMatchObject({
      role: "work:worker",
      assigned_cell: { model: "gpt-5.6", effort: "medium" },
      effective_cell: { model: "gpt-5.6", effort: "medium" },
      strategy: "wrapped",
      launch_cell: { provider: "claude", model: "sonnet", effort: "high" },
      max_turns: 160,
      plugin_manifest: {
        metadata: {
          name: "work",
          version: "1.0.0",
          author: { name: "ArtHack" },
        },
      },
    });
    expect(result.outputs[1]).toMatchObject({
      strategy: "native",
      launch_cell: { provider: "claude", model: "opus", effort: "high" },
      max_turns: 300,
    });
    for (const row of result.outputs) {
      const expected = legacyRendered(
        fx,
        row.cell.model,
        row.cell.effort,
        row.strategy,
      );
      expect(readFileSync(join(fx.targetDir, row.output), "utf8")).toBe(
        expected,
      );
    }
    expect(verify(fx).ok).toBe(true);
  });

  test("accepts plan:work scope, ignores static members, and rejects static-only scope", () => {
    const fx = fixture();
    const result = compileClaudeWorkerArtifacts({
      request: { target: "claude", bundle: "plan:work" },
      repoRoot: fx.repoRoot,
      planRoot: fx.planRoot,
      matrixPath: fx.matrixPath,
      targetDir: fx.targetDir,
    });
    expect(result.outputs).toHaveLength(3);
    expect(result.outputs.every((row) => row.role === "work:worker")).toBe(
      true,
    );
    expect(() =>
      compileClaudeWorkerArtifacts({
        request: { target: "claude", bundle: "plan:static" },
        repoRoot: fx.repoRoot,
        planRoot: fx.planRoot,
        matrixPath: fx.matrixPath,
        targetDir: fx.targetDir,
      }),
    ).toThrow("no cell-bound role");
  });

  test("cross-checks the catalog against the matrix template inventory", () => {
    const fx = fixture();
    writeFileSync(
      fx.matrixPath,
      matrix({ template: "template/agents/repo-scout.md.tmpl" }),
    );
    expect(() => compile(fx)).toThrow(/omitted:.*worker.*extras:.*repo-scout/);
    expect(existsSync(fx.targetDir)).toBe(false);
  });

  test("fingerprints both worker partials and returns a verified fast hit", () => {
    const fx = fixture();
    const first = compile(fx);
    expect(compile(fx)).toMatchObject({
      outcome: "hit",
      fingerprint: first.fingerprint,
    });
    const partial = join(
      fx.planRoot,
      "template",
      "_partials",
      "worker-implement-wrapped.md",
    );
    writeFileSync(partial, `${readFileSync(partial, "utf8")}\nPARTIAL DRIFT\n`);
    const second = compile(fx);
    expect(second.outcome).toBe("compiled");
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(
      readFileSync(join(fx.targetDir, second.outputs[0]?.output ?? ""), "utf8"),
    ).toContain("PARTIAL DRIFT");
  });

  test("check mode is write-free and reports expected drift and removals", () => {
    const fx = fixture();
    const empty = compile(fx, true);
    expect(empty).toMatchObject({
      check: true,
      ok: false,
      outcome: "compiled",
    });
    expect(existsSync(fx.targetDir)).toBe(false);
    expect(existsSync(`${fx.targetDir}.keeper-prompt-claude.lock`)).toBe(false);

    compile(fx);
    writeFileSync(fx.matrixPath, matrix({ includeHigh: false }));
    const checked = compile(fx, true);
    expect(checked.ok).toBe(false);
    expect(checked.removed.some((path) => path.startsWith("opus-high/"))).toBe(
      true,
    );
    expect(existsSync(join(fx.targetDir, "opus-high"))).toBe(true);
  });

  test("repairs corruption at the same fingerprint", () => {
    const fx = fixture();
    const first = compile(fx);
    const output = join(fx.targetDir, first.outputs[0]?.output ?? "");
    const pristine = readFileSync(output);
    writeFileSync(output, "corrupt\n");
    const repaired = compile(fx);
    expect(repaired.outcome).toBe("repaired");
    expect(readFileSync(output)).toEqual(pristine);
  });

  test("adopts clean legacy cells and recovers marker-first publication", () => {
    const fx = fixture();
    const first = compile(fx);
    rmSync(join(fx.targetDir, CLAUDE_WORKER_MANIFEST));
    for (const row of first.outputs) {
      for (const primary of [row.output, row.plugin_manifest.output]) {
        const bytes = readFileSync(join(fx.targetDir, primary));
        writeFileSync(
          join(fx.targetDir, `${primary}.managed-file-dont-edit`),
          `${JSON.stringify(
            {
              _warning: "legacy",
              source_template: "plugins/plan/template/agents/worker.md.tmpl",
              sha256: hash(bytes),
            },
            null,
            2,
          )}\n`,
        );
      }
    }
    expect(compile(fx).outcome).toBe("compiled");

    rmSync(join(fx.targetDir, CLAUDE_WORKER_MANIFEST));
    const interruptedPrimary = join(
      fx.targetDir,
      first.outputs[0]?.output ?? "",
    );
    rmSync(interruptedPrimary);
    expect(compile(fx).outcome).toBe("compiled");
    expect(existsSync(interruptedPrimary)).toBe(true);
  });

  test("refuses malformed and tampered legacy ownership before any write", () => {
    const fx = fixture();
    const first = compile(fx);
    rmSync(join(fx.targetDir, CLAUDE_WORKER_MANIFEST));
    const primary = join(fx.targetDir, first.outputs[0]?.output ?? "");
    const sidecar = `${primary}.managed-file-dont-edit`;
    writeFileSync(sidecar, "{bad json");
    const before = readFileSync(primary);
    expect(() => compile(fx)).toThrow(/malformed worker sidecar/);
    expect(readFileSync(primary)).toEqual(before);
    expect(existsSync(join(fx.targetDir, CLAUDE_WORKER_MANIFEST))).toBe(false);
  });

  test("prunes clean manifest-owned cells after matrix contraction", () => {
    const fx = fixture();
    compile(fx);
    writeFileSync(fx.matrixPath, matrix({ includeHigh: false }));
    const contracted = compile(fx);
    expect(contracted.outcome).toBe("compiled");
    expect(
      contracted.removed.some((path) => path.startsWith("opus-high/")),
    ).toBe(true);
    expect(existsSync(join(fx.targetDir, "opus-high"))).toBe(false);
    expect(verify(fx).ok).toBe(true);
  });

  test("rejects unmanaged extras and symlinks without recursive deletion", () => {
    const fx = fixture();
    compile(fx);
    const extra = join(fx.targetDir, "opus-low", "agents", "notes.txt");
    writeFileSync(extra, "human\n");
    expect(() => compile(fx)).toThrow(/unmanaged extra/);
    expect(readFileSync(extra, "utf8")).toBe("human\n");
    rmSync(extra);

    const outside = join(fx.repoRoot, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(fx.targetDir, "escape"), "dir");
    expect(() => compile(fx)).toThrow(/symlinks are forbidden/);
    expect(existsSync(outside)).toBe(true);
  });

  test("verifier reports manifest, fingerprint, inventory, hash, and sidecar failures", () => {
    const fx = fixture();
    expect(verify(fx)).toMatchObject({
      ok: false,
      failure: { kind: "manifest-missing" },
    });
    const first = compile(fx);
    writeFileSync(join(fx.targetDir, "extra"), "x");
    expect(verify(fx)).toMatchObject({
      ok: false,
      failure: { kind: "inventory-mismatch" },
    });
    rmSync(join(fx.targetDir, "extra"));

    const output = join(fx.targetDir, first.outputs[0]?.output ?? "");
    writeFileSync(output, "bad");
    expect(verify(fx)).toMatchObject({
      ok: false,
      failure: { kind: "hash-mismatch" },
    });
    compile(fx);

    const sidecar = join(fx.targetDir, first.outputs[0]?.sidecar ?? "");
    writeFileSync(sidecar, "bad");
    expect(verify(fx)).toMatchObject({
      ok: false,
      failure: { kind: "sidecar-invalid" },
    });
    compile(fx);

    writeFileSync(
      join(fx.planRoot, "template", "_partials", "worker-implement-native.md"),
      "input drift\n",
    );
    expect(verify(fx)).toMatchObject({
      ok: false,
      failure: { kind: "fingerprint-mismatch" },
    });
  });

  test("manifest is canonical, target-scoped, and carries exact cell metadata", () => {
    const fx = fixture();
    const result = compile(fx);
    const manifest = JSON.parse(
      readFileSync(join(fx.targetDir, CLAUDE_WORKER_MANIFEST), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      target: "claude",
      publisher: "keeper-prompt-compiler",
      fingerprint: result.fingerprint,
    });
    expect((manifest.cells as unknown[]).length).toBe(result.outputs.length);
    expect(existsSync(join(fx.repoRoot, "pi-agent"))).toBe(false);
  });
});
