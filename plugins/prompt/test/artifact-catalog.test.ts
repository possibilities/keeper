import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

import {
  loadPromptArtifactCatalog,
  PromptArtifactCatalogError,
  parsePromptArtifactCatalog,
} from "../src/artifact_catalog.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function planRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "prompt-catalog-"));
  temps.push(root);
  mkdirSync(join(root, "template", "agents"), { recursive: true });
  for (const stem of ["one", "two", "worker"]) {
    writeFileSync(
      join(root, "template", "agents", `${stem}.md.tmpl`),
      "body\n",
    );
  }
  return root;
}

function validDoc(): Record<string, unknown> {
  return {
    schema_version: 1,
    roles: [
      {
        role: "plan:one",
        source: "template/agents/one.md.tmpl",
        binding: "static",
        unserved: "equivalent",
      },
      {
        role: "plan:two",
        source: "template/agents/two.md.tmpl",
        binding: "static",
        unserved: "equivalent",
      },
      {
        role: "work:worker",
        source: "template/agents/worker.md.tmpl",
        binding: "cell-bound",
        unserved: "wrapped",
      },
    ],
    bundles: [
      { bundle: "plan:plan", roles: ["plan:one", "plan:two"] },
      { bundle: "plan:work", roles: ["work:worker", "plan:one"] },
    ],
  };
}

describe("strict prompt artifact catalog", () => {
  test("the committed catalog names every role and keeps workflows multi-role", () => {
    const root = resolve(import.meta.dir, "../../plan");
    const catalog = loadPromptArtifactCatalog(
      join(root, "prompt-artifacts.yaml"),
      root,
    );
    expect(catalog.roles).toHaveLength(12);
    expect(catalog.roleByName.get("work:worker")).toMatchObject({
      binding: "cell-bound",
      unserved: "wrapped",
    });
    for (const bundle of ["plan:plan", "plan:close", "plan:work"]) {
      expect(catalog.bundleByName.get(bundle)?.roles.length).toBeGreaterThan(1);
    }
  });

  test("rejects unknown keys and duplicate logical roles", () => {
    const root = planRoot();
    expect(() =>
      parsePromptArtifactCatalog({ ...validDoc(), typo: true }, root),
    ).toThrow("unknown key 'typo'");
    const duplicate = validDoc();
    (duplicate.roles as unknown[]).push({
      role: "plan:one",
      source: "template/agents/one.md.tmpl",
      binding: "static",
      unserved: "equivalent",
    });
    expect(() => parsePromptArtifactCatalog(duplicate, root)).toThrow(
      "duplicate role 'plan:one'",
    );
  });

  test("rejects an agent template omitted from the role inventory", () => {
    const root = planRoot();
    writeFileSync(
      join(root, "template", "agents", "uncataloged.md.tmpl"),
      "body\n",
    );
    expect(() => parsePromptArtifactCatalog(validDoc(), root)).toThrow(
      "has no catalog role",
    );
  });

  test("rejects lexical and symlink path escapes", () => {
    const root = planRoot();
    const escaped = validDoc();
    const escapedRole = (escaped.roles as Record<string, unknown>[])[0];
    if (escapedRole === undefined) throw new Error("missing fixture role");
    escapedRole.source = "../one.md.tmpl";
    expect(() => parsePromptArtifactCatalog(escaped, root)).toThrow(
      "no escape",
    );

    const outside = join(root, "outside.md.tmpl");
    writeFileSync(outside, "outside\n");
    const linked = join(root, "template", "agents", "escape.md.tmpl");
    symlinkSync(outside, linked);
    const symlinked = validDoc();
    const symlinkedRole = (symlinked.roles as Record<string, unknown>[])[0];
    if (symlinkedRole === undefined) throw new Error("missing fixture role");
    symlinkedRole.source = "template/agents/escape.md.tmpl";
    expect(() => parsePromptArtifactCatalog(symlinked, root)).toThrow(
      "outside the canonical agent template directory",
    );

    const trulyOutside = join(
      tmpdir(),
      `prompt-outside-${process.pid}.md.tmpl`,
    );
    writeFileSync(trulyOutside, "outside\n");
    rmSync(linked);
    symlinkSync(trulyOutside, linked);
    try {
      expect(() => parsePromptArtifactCatalog(symlinked, root)).toThrow(
        "outside the canonical agent template directory",
      );
    } finally {
      rmSync(trulyOutside, { force: true });
    }
  });

  test("rejects bundle references to missing roles and invalid adaptations", () => {
    const root = planRoot();
    const missing = validDoc();
    const missingBundle = (missing.bundles as { roles: string[] }[])[0];
    if (missingBundle === undefined) throw new Error("missing fixture bundle");
    missingBundle.roles.push("plan:ghost");
    expect(() => parsePromptArtifactCatalog(missing, root)).toThrow(
      "missing role 'plan:ghost'",
    );

    const invalid = validDoc();
    const invalidRole = (invalid.roles as Record<string, unknown>[])[0];
    if (invalidRole === undefined) throw new Error("missing fixture role");
    invalidRole.unserved = "wrapped";
    expect(() => parsePromptArtifactCatalog(invalid, root)).toThrow(
      "invalid binding/unserved combination",
    );
  });

  test("errors are typed and a malformed YAML document fails loud", () => {
    const root = planRoot();
    let caught: unknown;
    try {
      parsePromptArtifactCatalog({ schema_version: 1, roles: [] }, root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PromptArtifactCatalogError);
    expect(() =>
      parsePromptArtifactCatalog(parse("- not-a-map\n"), root),
    ).toThrow("must be a mapping");
  });
});
