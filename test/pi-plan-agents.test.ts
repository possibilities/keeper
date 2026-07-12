import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  installPiPlanAgents,
  renderPiPlanAgent,
} from "../src/agent/pi-plan-agents";

const SOURCE_DIR = join(import.meta.dir, "..", "plugins", "plan", "agents");

// Every static plan agent is now a gitignored GENERATED artifact (rendered from
// template/agents/*.md.tmpl with model/effort injected from the host matrix
// agent_pins), so a clean checkout carries none until render-plugin-templates
// runs (install.sh / promote.sh render first). The Pi renderer consumes those
// rendered files, so these cases gate on their presence rather than failing hard.
const AGENTS_RENDERED = existsSync(join(SOURCE_DIR, "repo-scout.md"));

function bodyOf(markdown: string): string {
  const close = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || close < 0)
    throw new Error("bad fixture");
  return markdown.slice(close + "\n---\n".length);
}

describe.skipIf(!AGENTS_RENDERED)("Pi plan agent renderer", () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("copies prompt bodies byte-for-byte and translates harness metadata", () => {
    const sourcePath = join(SOURCE_DIR, "repo-scout.md");
    const rendered = renderPiPlanAgent(sourcePath);
    expect(rendered.filename).toBe("plan:repo-scout.md");
    expect(bodyOf(rendered.content)).toBe(
      bodyOf(readFileSync(sourcePath, "utf8")),
    );
    const header = rendered.content.slice(
      0,
      rendered.content.indexOf("\n---\n", 4),
    );
    expect(header).toContain("thinking: high");
    expect(header).toContain("max_turns: 60");
    expect(header).toContain('disallowed_tools: "edit, write, Task, Agent"');
    expect(header).not.toContain("model:");
    expect(header).not.toContain("color:");
  });

  test("keeps nested Task available only where the source agent permits it", () => {
    const runner = renderPiPlanAgent(
      join(SOURCE_DIR, "panel-runner.md"),
    ).content;
    const judge = renderPiPlanAgent(join(SOURCE_DIR, "panel-judge.md")).content;
    const runnerHeader = runner.slice(0, runner.indexOf("\n---\n", 4));
    const judgeHeader = judge.slice(0, judge.indexOf("\n---\n", 4));
    expect(runnerHeader).not.toContain("Task, Agent");
    // pi-subagents must LOAD in the runner's child session (extensions: is the
    // sole loading authority — an allowlist omitting it leaves only factory
    // side effects, and the judge spawn dies with "No active session"). It
    // cannot be allowlisted by name (its `./src/index.ts` entry canonicalizes
    // to "src"), so the wildcard keeps all defaults loaded while the ext:
    // allowlist keeps their tools hidden.
    expect(runnerHeader).toContain(
      `extensions: ${JSON.stringify(
        `*, ${join(
          import.meta.dir,
          "..",
          "plugins",
          "keeper",
          "pi-extension",
          "keeper-events.ts",
        )}`,
      )}`,
    );
    expect(runnerHeader).toContain('tools: "all, ext:keeper-events/Task"');
    expect(judgeHeader).toContain("Task, Agent");
    expect(judgeHeader).not.toContain("extensions:");
  });

  test("installs every source idempotently and detects drift in check mode", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "pi-plan-agents-"));
    temps.push(targetDir);
    const first = installPiPlanAgents({ sourceDir: SOURCE_DIR, targetDir });
    // The describe is guarded on a rendered agents/ tree, so the full static-agent
    // roster is present — installing it checks each one (guards accidental
    // add/remove of a template).
    const STATIC_PLAN_AGENTS = 11;
    expect(first.checked).toHaveLength(STATIC_PLAN_AGENTS);
    expect(first.changed.length).toBeGreaterThan(0);

    const second = installPiPlanAgents({ sourceDir: SOURCE_DIR, targetDir });
    expect(second.changed).toEqual([]);
    expect(() =>
      installPiPlanAgents({ sourceDir: SOURCE_DIR, targetDir, check: true }),
    ).not.toThrow();

    const repoScout = join(targetDir, "plan:repo-scout.md");
    writeFileSync(
      repoScout,
      `${readFileSync(repoScout, "utf8")}manual drift\n`,
    );
    expect(() =>
      installPiPlanAgents({ sourceDir: SOURCE_DIR, targetDir, check: true }),
    ).toThrow("plan:repo-scout.md");
  });

  test("refuses to overwrite an unmanaged namespaced definition", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "pi-plan-unmanaged-"));
    temps.push(targetDir);
    writeFileSync(join(targetDir, "plan:repo-scout.md"), "human file\n");
    expect(() =>
      installPiPlanAgents({ sourceDir: SOURCE_DIR, targetDir }),
    ).toThrow("unmanaged agent");
  });

  test("the installer refreshes the canonical Pi agent registry", () => {
    const installScript = readFileSync(
      join(import.meta.dir, "..", "scripts", "install.sh"),
      "utf8",
    );
    expect(installScript).toContain('PI_CODING_AGENT_DIR="');
    expect(installScript).toContain("bun scripts/install-pi-plan-agents.ts");
  });

  test("all rendered names preserve the plan namespace", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "pi-plan-names-"));
    temps.push(targetDir);
    const result = installPiPlanAgents({ sourceDir: SOURCE_DIR, targetDir });
    for (const name of result.checked) {
      expect(name).toBe(`plan:${basename(name).slice("plan:".length)}`);
      expect(existsSync(join(targetDir, name))).toBe(true);
    }
  });
});
