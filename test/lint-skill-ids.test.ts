/**
 * Fixture tests for the plugin skill-id guard (scripts/lint-skill-ids.ts).
 * Drives the PURE `scanSkill` / `scanSkills` / `frontmatterName` exports with
 * synthetic descriptors plus a synthetic bad tree in a tmpdir — no daemon, no
 * git, fast tier — so each rule is pinned independently:
 *  - a clean descriptor set PASSES;
 *  - a keeper/keeper-await double-prefix dir FAILs (DOUBLE-PREFIX);
 *  - a non-lowercase-hyphen dir FAILs (NAME-SHAPE);
 *  - a frontmatter name that disagrees with the dir FAILs (FRONTMATTER);
 *  - the LIVE plugins/ tree passes (both plugins are clean today).
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverSkills,
  frontmatterName,
  type SkillDescriptor,
  scanSkill,
  scanSkills,
} from "../scripts/lint-skill-ids";

test("a clean descriptor passes with no findings", () => {
  expect(
    scanSkill({ plugin: "keeper", dirName: "await", frontmatterName: "await" }),
  ).toEqual([]);
});

test("a dir that equals the plugin name is NOT a double-prefix", () => {
  // `plan/plan` is legitimate — only the `<plugin>-<suffix>` shape is banned.
  expect(
    scanSkill({ plugin: "plan", dirName: "plan", frontmatterName: "plan" }),
  ).toEqual([]);
});

test("a keeper/keeper-await double-prefix dir FAILs", () => {
  const findings = scanSkill({
    plugin: "keeper",
    dirName: "keeper-await",
    frontmatterName: "keeper-await",
  });
  expect(findings.some((f) => f.rule === "DOUBLE-PREFIX")).toBe(true);
});

test("a non-lowercase-hyphen dir FAILs NAME-SHAPE", () => {
  for (const dirName of ["Await", "my_skill", "trailing-", "-lead"]) {
    const findings = scanSkill({
      plugin: "keeper",
      dirName,
      frontmatterName: null,
    });
    expect(findings.some((f) => f.rule === "NAME-SHAPE")).toBe(true);
  }
});

test("a frontmatter name disagreeing with the dir FAILs FRONTMATTER", () => {
  const findings = scanSkill({
    plugin: "keeper",
    dirName: "await",
    frontmatterName: "awaits",
  });
  expect(findings.some((f) => f.rule === "FRONTMATTER")).toBe(true);
});

test("a null frontmatter name is not a FRONTMATTER violation", () => {
  const findings = scanSkill({
    plugin: "keeper",
    dirName: "await",
    frontmatterName: null,
  });
  expect(findings.some((f) => f.rule === "FRONTMATTER")).toBe(false);
});

test("frontmatterName extracts the name from a frontmatter block, else null", () => {
  expect(frontmatterName("---\nname: await\ndescription: x\n---\nbody")).toBe(
    "await",
  );
  expect(frontmatterName("no frontmatter here")).toBe(null);
  expect(frontmatterName("---\ndescription: x\n---\n")).toBe(null);
});

test("scanSkills flattens findings across a synthetic bad tree", () => {
  const descs: SkillDescriptor[] = [
    { plugin: "keeper", dirName: "await", frontmatterName: "await" },
    {
      plugin: "keeper",
      dirName: "keeper-await",
      frontmatterName: "keeper-await",
    },
    { plugin: "plan", dirName: "Plan", frontmatterName: null },
  ];
  const findings = scanSkills(descs);
  expect(findings.some((f) => f.rule === "DOUBLE-PREFIX")).toBe(true);
  expect(findings.some((f) => f.rule === "NAME-SHAPE")).toBe(true);
  // The clean keeper/await contributes nothing.
  expect(findings.every((f) => f.where !== "keeper/await")).toBe(true);
});

test("discoverSkills over a synthetic bad tmpdir tree finds the defect", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-ids-"));
  const bad = join(root, "keeper", "skills", "keeper-await");
  mkdirSync(bad, { recursive: true });
  writeFileSync(
    join(bad, "SKILL.md"),
    "---\nname: keeper-await\ndescription: x\n---\nbody\n",
  );
  const good = join(root, "plan", "skills", "close");
  mkdirSync(good, { recursive: true });
  writeFileSync(join(good, "SKILL.md"), "---\nname: close\n---\nbody\n");

  const findings = scanSkills(discoverSkills(root));
  expect(findings.some((f) => f.rule === "DOUBLE-PREFIX")).toBe(true);
  expect(findings.some((f) => f.where === "plan/close")).toBe(false);
});

test("the LIVE plugins/ tree passes clean", () => {
  const pluginsRoot = new URL("../plugins", import.meta.url).pathname;
  const findings = scanSkills(discoverSkills(pluginsRoot));
  expect(findings).toEqual([]);
});
