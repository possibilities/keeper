import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface RetiredNameResult {
  violations: string[];
}

export interface RetiredNameFiles {
  read(relpath: string): string | null;
  paths(): readonly string[];
}

function normalized(relpath: string): string {
  return relpath.replaceAll("\\", "/");
}

function isExcluded(relpath: string, retired: "agentwrap" | "keeper pair"): boolean {
  const name = relpath.split("/").at(-1) ?? relpath;
  if (relpath.startsWith(".keeper/")) return true;
  if (
    name === "lint-retired-name.sh" ||
    name === "lint-retired-name.ts" ||
    name === "frozen-allowlist.txt" ||
    name === "lint-retired-name.test.ts" ||
    (name.includes("retirement") && name.endsWith(".md"))
  ) {
    return true;
  }
  return (
    retired === "agentwrap" &&
    (name === "cwd-ordinal.ts" || name === "agent-cwd-ordinal.test.ts")
  );
}

function countMatchingLines(text: string, token: string): number {
  const expression = new RegExp(token, "i");
  return text.split("\n").filter((line) => expression.test(line)).length;
}

/** Evaluate frozen records and the two repo-wide retired-name postures. */
export function classifyRetiredNames(files: RetiredNameFiles): RetiredNameResult {
  const violations: string[] = [];
  const allowlist = files.read("scripts/frozen-allowlist.txt");
  if (allowlist === null) {
    return { violations: ["frozen allowlist not found at scripts/frozen-allowlist.txt"] };
  }

  for (const line of allowlist.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const first = line.indexOf("|");
    const second = first < 0 ? -1 : line.indexOf("|", first + 1);
    if (first < 0) {
      violations.push(`UNKNOWN allowlist record kind: ${line} (line: ${line})`);
      continue;
    }
    const kind = line.slice(0, first);
    if (kind === "exempt") continue;
    if (second < 0) {
      violations.push(`UNKNOWN allowlist record kind: ${kind} (line: ${line})`);
      continue;
    }
    const relpath = line.slice(first + 1, second);
    const payload = line.slice(second + 1);
    const text = files.read(relpath);
    if (text === null) {
      const label = kind === "count" ? "count pin" : kind;
      violations.push(`MISSING FILE for ${label}: ${relpath}`);
      continue;
    }
    if (kind === "anchor") {
      if (!text.includes(payload)) {
        violations.push(`CLOBBERED frozen literal in ${relpath}: \`${payload}\` no longer present`);
      }
    } else if (kind === "count") {
      const separator = payload.indexOf("|");
      const expected = separator < 0 ? payload : payload.slice(0, separator);
      const token = separator < 0 ? "planctl" : payload.slice(separator + 1);
      const actual = countMatchingLines(text, token);
      if (String(actual) !== expected) {
        violations.push(`PURE-FROZEN file ${relpath} drifted: expected ${expected} "${token}" lines, found ${actual} (a clobber or a planted retired-name edit)`);
      }
    } else if (kind === "forbid") {
      if (text.toLocaleLowerCase().includes(payload.toLocaleLowerCase())) {
        violations.push(`FORBIDDEN substring in ${relpath}: \`${payload}\` must not appear (retired-name regrowth)`);
      }
    } else {
      violations.push(`UNKNOWN allowlist record kind: ${kind} (line: ${line})`);
    }
  }

  for (const retired of ["agentwrap", "keeper pair"] as const) {
    for (const relpath of files.paths()) {
      if (isExcluded(relpath, retired)) continue;
      const text = files.read(relpath);
      if (text?.toLocaleLowerCase().includes(retired)) {
        violations.push(
          retired === "agentwrap"
            ? `AGENTWRAP zero-tolerance: retired name present in ${relpath}`
            : `KEEPER-PAIR zero-tolerance: retired verb present in ${relpath}`,
        );
      }
    }
  }
  return { violations };
}

export function treeFiles(root: string): RetiredNameFiles {
  const contents = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir) as string[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const path = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(path);
      } else if (st.isFile()) {
        try {
          contents.set(normalized(relative(root, path)), readFileSync(path, "utf8"));
        } catch {
          // Binary and unreadable files cannot contain an actionable source edit.
        }
      }
    }
  };
  walk(root);
  return {
    read: (relpath) => contents.get(normalized(relpath)) ?? null,
    paths: () => [...contents.keys()].sort(),
  };
}

export function lintRetiredNames(root: string): RetiredNameResult {
  return classifyRetiredNames(treeFiles(root));
}

function main(): void {
  const root = process.env.KEEPER_RETIRED_NAME_REPO_ROOT ?? dirname(import.meta.dir);
  if (!existsSync(root)) {
    console.error(`ERROR: retired-name repo root not found at ${root}`);
    process.exitCode = 1;
    return;
  }
  const { violations } = lintRetiredNames(root);
  if (violations.length === 0) return;
  console.error(`ERROR: retired-name guard found ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exitCode = 1;
}

if (import.meta.main) main();
