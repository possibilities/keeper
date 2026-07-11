import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every duration a panel/pair doc surface teaches must carry an explicit unit:
 * `parseDuration` rejects bare numbers, and a contract-following agent cannot
 * self-heal from that rejection (its contract tells it exit 2 is terminal), so
 * a bare `--chunk 540` in a doc is a deterministic runner failure. This gate
 * pins the doc surfaces to unit forms (`540s`), catching contract/CLI drift at
 * test time instead of in a live panel.
 */
const DOC_SURFACES = [
  "plugins/plan/agents/panel-runner.md",
  "plugins/keeper/skills/pair/SKILL.md",
  "plugins/plan/skills/panel/SKILL.md",
  "plugins/plan/skills/panel/references/panel.md",
];

// A `--chunk`/`--timeout`/`--stop-timeout` value followed by neither a unit
// letter nor another digit is a bare number the CLI rejects.
const BARE_DURATION = /--(chunk|timeout|stop-timeout)[= ](\d+)(?![\dsmh])/g;

test("panel/pair doc surfaces never teach a bare (unit-less) duration flag", () => {
  const repoRoot = join(import.meta.dir, "..");
  const offenders: string[] = [];
  for (const rel of DOC_SURFACES) {
    const text = readFileSync(join(repoRoot, rel), "utf8");
    for (const line of text.split("\n")) {
      BARE_DURATION.lastIndex = 0;
      if (BARE_DURATION.test(line)) {
        offenders.push(`${rel}: ${line.trim()}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
