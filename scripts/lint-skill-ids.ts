#!/usr/bin/env bun
/**
 * Skill-id guard for the plugin skill trees. Catches the shipped double-prefix
 * defect class — a skill whose directory repeats its plugin namespace, e.g. a
 * `keeper/keeper-await` dir surfacing to the model as `keeper:keeper-await`,
 * which misfired 36 times over five days before correction. Pure fs reads, no
 * daemon, so it runs in the fast tier beside lint-claude-md.
 *
 *   bun scripts/lint-skill-ids.ts
 *
 * Exits 0 when clean, 1 listing each violation. Scans every
 * `plugins/<plugin>/skills/<skill>/` directory (the plugin is the parent under
 * `plugins/`), applying three rules per skill dir:
 *  - NAME-SHAPE: the dir name is lowercase-hyphen (`^[a-z0-9]+(-[a-z0-9]+)*$`).
 *  - DOUBLE-PREFIX: the dir name does not start with `<plugin>-` — the exact
 *    defect class (a dir equal to the plugin name is fine; only the
 *    `<plugin>-<suffix>` shape is banned).
 *  - FRONTMATTER: when SKILL.md carries a frontmatter `name:`, it equals the
 *    dir name (the id the loader derives from the path).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";

/** One skill directory to check: its plugin, dir name, and frontmatter name. */
export type SkillDescriptor = {
  /** Plugin namespace — the parent dir under `plugins/`. */
  plugin: string;
  /** Skill directory basename (the id suffix the loader derives). */
  dirName: string;
  /**
   * Frontmatter `name:` value if SKILL.md declares one, else null. A null is
   * NOT a violation — the FRONTMATTER rule only fires on a present mismatch.
   */
  frontmatterName: string | null;
};

export type Finding = {
  /** Which rule failed. */
  rule: "NAME-SHAPE" | "DOUBLE-PREFIX" | "FRONTMATTER";
  /** `<plugin>/<dirName>` locator for the offending skill. */
  where: string;
  /** Human-readable failure message. */
  message: string;
};

const LOWER_HYPHEN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Scan one skill descriptor for the three id rules. Pure over its input (no
 * fs) so the fixture test drives it directly with synthetic descriptors.
 */
export function scanSkill(desc: SkillDescriptor): Finding[] {
  const findings: Finding[] = [];
  const { plugin, dirName, frontmatterName } = desc;
  const where = `${plugin}/${dirName}`;

  if (!LOWER_HYPHEN.test(dirName)) {
    findings.push({
      rule: "NAME-SHAPE",
      where,
      message: `skill dir '${dirName}' is not lowercase-hyphen (^[a-z0-9]+(-[a-z0-9]+)*$)`,
    });
  }

  if (dirName.startsWith(`${plugin}-`)) {
    findings.push({
      rule: "DOUBLE-PREFIX",
      where,
      message: `skill dir '${dirName}' repeats the plugin namespace — the loader id would be '${plugin}:${dirName}'; drop the '${plugin}-' prefix`,
    });
  }

  if (frontmatterName !== null && frontmatterName !== dirName) {
    findings.push({
      rule: "FRONTMATTER",
      where,
      message: `SKILL.md name '${frontmatterName}' does not match dir '${dirName}'`,
    });
  }

  return findings;
}

/** Scan a list of descriptors, flattening every skill's findings. */
export function scanSkills(descs: SkillDescriptor[]): Finding[] {
  return descs.flatMap(scanSkill);
}

/**
 * Extract the frontmatter `name:` from SKILL.md text, or null when there is no
 * leading `---` frontmatter block or no `name:` key in it. Matches the loader's
 * shape: a `---` fence on line 1, a `name:` line inside, closed by `---`.
 */
export function frontmatterName(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const m = /^name:\s*(\S+)\s*$/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/**
 * Discover every `plugins/<plugin>/skills/<skill>/` directory under
 * `pluginsRoot`, reading each SKILL.md frontmatter name when present. A plugin
 * without a `skills/` dir contributes nothing (a strict no-op, mirroring the
 * lint-claude-md existsSync guard).
 */
export function discoverSkills(pluginsRoot: string): SkillDescriptor[] {
  const descs: SkillDescriptor[] = [];
  if (!existsSync(pluginsRoot)) return descs;

  for (const plugin of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const skillsDir = `${pluginsRoot}/${plugin.name}/skills`;
    if (!existsSync(skillsDir)) continue;

    for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const skillMd = `${skillsDir}/${skill.name}/SKILL.md`;
      const name = existsSync(skillMd)
        ? frontmatterName(readFileSync(skillMd, "utf8"))
        : null;
      descs.push({
        plugin: plugin.name,
        dirName: skill.name,
        frontmatterName: name,
      });
    }
  }
  return descs;
}

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PLUGINS_ROOT = `${REPO_ROOT}/plugins`;

function main(): number {
  const findings = scanSkills(discoverSkills(PLUGINS_ROOT));

  if (findings.length === 0) {
    console.log("[lint-skill-ids] ok — every plugin skill id is clean");
    return 0;
  }

  console.error(`[lint-skill-ids] ${findings.length} violation(s):`);
  for (const f of findings) {
    console.error(`  - ${f.where} [${f.rule}] ${f.message}`);
  }
  console.error(
    "\nA skill dir name is the id suffix the loader derives — it must be\n" +
      "lowercase-hyphen and must NOT repeat its plugin namespace (a\n" +
      "keeper/keeper-await dir surfaces as keeper:keeper-await). Rename the\n" +
      "directory (and its SKILL.md frontmatter name) to the bare suffix.",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
