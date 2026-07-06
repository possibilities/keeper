import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  nameRoots,
  projectDescriptions,
  rankProjects,
  readProjectDescription,
  readWorkspaceMembers,
} from "../src/projects";

function withTmp<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "keeper-projects-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("keeper projects ranking", () => {
  test("ranks immediate child projects from keeper job activity", () => {
    withTmp((tmp) => {
      const code = join(tmp, "code");
      const alpha = join(code, "alpha");
      const beta = join(code, "beta");
      mkdirSync(join(alpha, "src"), { recursive: true });
      mkdirSync(beta, { recursive: true });
      const roots = nameRoots([code]);
      const now = 10_000;

      const ranked = rankProjects(roots, {
        now,
        jobRows: [
          { cwd: alpha, created_at: now - 100, updated_at: now - 100 },
          {
            cwd: join(alpha, "src"),
            created_at: now - 200,
            updated_at: now - 200,
          },
          { cwd: beta, created_at: now - 9_000, updated_at: now - 9_000 },
          { cwd: join(tmp, "elsewhere"), created_at: now, updated_at: now },
        ],
      });

      expect(ranked.map((p) => p.name)).toEqual(["alpha", "beta"]);
      expect(ranked[0]?.jobs_total).toBe(2);
      expect(ranked[0]?.jobs_1d).toBe(2);
      expect(ranked[1]?.jobs_total).toBe(1);
    });
  });

  test("root name collisions use absolute paths as selectors", () => {
    withTmp((tmp) => {
      const a = join(tmp, "a", "code");
      const b = join(tmp, "b", "code");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      expect(nameRoots([a, b]).map((r) => r.name)).toEqual([
        realpathSync(a),
        realpathSync(b),
      ]);
    });
  });
});

describe("keeper projects metadata", () => {
  test("reads pyproject/package/CLAUDE descriptions in order", () => {
    withTmp((tmp) => {
      const p = join(tmp, "p");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "package.json"),
        JSON.stringify({ description: "Package description" }),
      );
      expect(readProjectDescription(p)).toBe("Package description");

      writeFileSync(
        join(p, "pyproject.toml"),
        '[project]\ndescription = "Pyproject description"\n',
      );
      expect(readProjectDescription(p)).toBe("Pyproject description");

      rmSync(join(p, "pyproject.toml"));
      rmSync(join(p, "package.json"));
      writeFileSync(
        join(p, "CLAUDE.md"),
        "# Heading\n\nFirst prose sentence. More.\n",
      );
      expect(readProjectDescription(p)).toBe("First prose sentence");
    });
  });

  test("reads uv and pnpm workspace members", () => {
    withTmp((tmp) => {
      const p = join(tmp, "mono");
      mkdirSync(join(p, "apps", "one"), { recursive: true });
      mkdirSync(join(p, "packages", "two"), { recursive: true });
      writeFileSync(
        join(p, "pyproject.toml"),
        '[tool.uv.workspace]\nmembers = ["apps/*"]\n',
      );
      writeFileSync(
        join(p, "pnpm-workspace.yaml"),
        "packages:\n  - packages/*\n",
      );
      expect(readWorkspaceMembers(p)).toEqual(["one", "two"]);
    });
  });

  test("formats description lines with workspace members", () => {
    withTmp((tmp) => {
      const code = join(tmp, "code");
      const p = join(code, "mono");
      mkdirSync(join(p, "apps", "one"), { recursive: true });
      writeFileSync(
        join(p, "package.json"),
        JSON.stringify({ description: "Does things" }),
      );
      writeFileSync(join(p, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
      const [desc] = projectDescriptions(
        rankProjects(nameRoots([code]), { now: 10_000, jobRows: [] }),
      );
      expect(desc?.line).toBe("mono - Does things (members: one)");
    });
  });
});
