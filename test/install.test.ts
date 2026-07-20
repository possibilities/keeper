import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const INSTALL = readFileSync(join(ROOT, "scripts", "install.sh"), "utf8");
const MANIFEST = JSON.parse(
  readFileSync(
    join(ROOT, "integrations", "pi-codex-pool", "package.json"),
    "utf8",
  ),
) as Record<string, unknown>;
const SOURCE = readFileSync(
  join(ROOT, "integrations", "pi-codex-pool", "src", "index.ts"),
  "utf8",
);

describe("Pi Codex companion installation contract", () => {
  test("pins the private manifest and compat-root source markers", () => {
    expect(MANIFEST).toMatchObject({
      name: "@earendil-works/keeper-pi-codex-pool",
      version: "0.1.0",
      private: true,
      pi: { extensions: ["./src/index.ts"] },
      peerDependencies: {
        "@earendil-works/pi-ai": "*",
        "@earendil-works/pi-coding-agent": "*",
      },
    });
    expect(SOURCE).toContain("openAICodexResponsesApi");
    expect(SOURCE).toContain("KEEPER_PI_CODEX_POOL_MODE");
    expect(SOURCE).toContain("KEEPER_PI_CODEX_POOL_INITIAL_ALIAS");
    expect(SOURCE).toContain("KEEPER_JOB_ID");
  });

  test("verifies the source in place without globally registering the companion", () => {
    expect(INSTALL).toContain(
      'PI_CODEX_POOL_ROOT="$' +
        '{repo_root}/integrations/pi-codex-pool" bun -e',
    );
    expect(INSTALL).toContain(
      'manifest.name === "@earendil-works/keeper-pi-codex-pool"',
    );
    expect(INSTALL).toContain('source.includes("KEEPER_PI_CODEX_POOL_MODE")');
    expect(INSTALL).toContain(
      'source.includes("KEEPER_PI_CODEX_POOL_INITIAL_ALIAS")',
    );
    expect(INSTALL).not.toContain("next.push(process.env.PI_CODEX_POOL_ROOT)");
  });

  test("provisions the observer executable onto PATH via the same bun-link mechanism as the keeper CLI", () => {
    expect(INSTALL).toContain(
      '( cd "$' + '{repo_root}/integrations/pi-codex-pool" && bun link )',
    );
    expect(INSTALL).toContain(
      '[ -L "$' + '{HOME}/.bun/bin/keeper-pi-codex-observe" ]',
    );
    expect(INSTALL).toContain(
      'if [ -n "$' + '{KEEPER_PI_CODEX_OBSERVER_BIN:-}" ]; then',
    );
  });

  test("keeps the loaded pi-subagents tree on its integration lineage and verifies child runtime inheritance", () => {
    expect(INSTALL).toContain('pi_subagents_branch="master"');
    expect(INSTALL).toContain('current_branch="$(git branch --show-current)"');
    expect(INSTALL).not.toContain("git checkout");
    expect(INSTALL).not.toContain("git switch");
    expect(INSTALL).toContain('grep -q "modelRegistry: ctx.modelRegistry"');
    expect(INSTALL).toContain('grep -q "modelRuntime: parentModelRuntime"');
    expect(INSTALL).toContain(
      "contracts verified in the live integration tree",
    );
  });
});
