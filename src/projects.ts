import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";

import { openDb, resolveDbPath, resolvePlanRoots } from "./db";

export interface ProjectRoot {
  name: string;
  path: string;
}

export interface JobActivityRow {
  cwd: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectActivity {
  lastJobAt: number;
  d1: number;
  d7: number;
  d30: number;
  total: number;
}

export interface RankedProject {
  name: string;
  path: string;
  root_name: string;
  root_path: string;
  score: number;
  last_activity_at: number;
  last_job_at: number;
  git_index_at: number;
  dir_mtime: number;
  jobs_1d: number;
  jobs_7d: number;
  jobs_30d: number;
  jobs_total: number;
}

export interface ProjectDescription {
  name: string;
  path: string;
  description: string;
  workspace_members: string[];
  line: string;
}

/** Resolve keeper's configured project roots through the same root concept the
 * plan worker uses. Missing roots are filtered by {@link resolvePlanRoots}. */
export function loadProjectRoots(
  paths: readonly string[] = resolvePlanRoots(),
): ProjectRoot[] {
  return nameRoots(paths);
}

/** Attach stable display names to root paths. The basename is the normal name
 * (`/Users/mike/code` -> `code`). If two roots share a basename, the colliding
 * entries use their absolute path as the selector so a name never silently
 * points at more than one root. */
export function nameRoots(paths: readonly string[]): ProjectRoot[] {
  const normalized = unique(paths.map(normalizePath));
  const counts = new Map<string, number>();
  for (const p of normalized) {
    const name = basename(p) || p;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return normalized.map((path) => {
    const base = basename(path) || path;
    return { name: (counts.get(base) ?? 0) > 1 ? path : base, path };
  });
}

/** Resolve a root selector. Selectors may be the display name, the absolute path,
 * or a path that resolves to the root path. */
export function resolveRootSelector(
  roots: readonly ProjectRoot[],
  selector: string | null,
): ProjectRoot | null {
  if (selector === null || selector === "") {
    return null;
  }
  const normalizedSelector = normalizePath(selector);
  return (
    roots.find(
      (r) =>
        r.name === selector ||
        r.path === selector ||
        r.path === normalizedSelector,
    ) ?? null
  );
}

export function projectsForRoots(
  roots: readonly ProjectRoot[],
): RankedProject[] {
  const out: RankedProject[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root.path).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(root.path, entry);
      if (!isDir(path)) {
        continue;
      }
      const normalized = normalizePath(path);
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      out.push({
        name: basename(normalized),
        path: normalized,
        root_name: root.name,
        root_path: root.path,
        score: 0,
        last_activity_at: 0,
        last_job_at: 0,
        git_index_at: 0,
        dir_mtime: dirMtime(normalized),
        jobs_1d: 0,
        jobs_7d: 0,
        jobs_30d: 0,
        jobs_total: 0,
      });
    }
  }
  return out;
}

export interface RankProjectsOptions {
  now?: number;
  dbPath?: string;
  jobRows?: readonly JobActivityRow[];
}

/** Rank immediate child directories under keeper roots by keeper-db job frecency,
 * plus cheap git-index and directory-mtime activity hints. */
export function rankProjects(
  roots: readonly ProjectRoot[],
  options: RankProjectsOptions = {},
): RankedProject[] {
  const now = options.now ?? Date.now() / 1000;
  const projects = projectsForRoots(roots);
  const projectByPath = new Map(projects.map((p) => [p.path, p]));
  const activity = activityByProjectPath(
    roots,
    projectByPath,
    options.jobRows ?? readJobRows(options.dbPath ?? resolveDbPath()),
    now,
  );

  for (const project of projects) {
    const a = activity.get(project.path) ?? emptyActivity();
    const gitIndex = gitIndexMtime(project.path);
    const dirTs = project.dir_mtime;
    const lastActivity = Math.max(a.lastJobAt, gitIndex, dirTs);
    project.last_job_at = a.lastJobAt;
    project.git_index_at = gitIndex;
    project.last_activity_at = lastActivity;
    project.jobs_1d = a.d1;
    project.jobs_7d = a.d7;
    project.jobs_30d = a.d30;
    project.jobs_total = a.total;
    project.score = projectScore(
      a.lastJobAt,
      gitIndex,
      dirTs,
      a.d1,
      a.d7,
      a.d30,
      a.total,
      now,
    );
  }

  return projects.sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    return a.path.localeCompare(b.path);
  });
}

export function projectDescriptions(
  projects: readonly RankedProject[],
): ProjectDescription[] {
  return projects.map((project) => {
    const description = readProjectDescription(project.path);
    const workspaceMembers = readWorkspaceMembers(project.path);
    const tail = [
      description,
      workspaceMembers.length > 0
        ? `(members: ${workspaceMembers.join(",")})`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      name: project.name,
      path: project.path,
      description,
      workspace_members: workspaceMembers,
      line: tail ? `${project.name} - ${tail}` : project.name,
    };
  });
}

export function readProjectDescription(path: string): string {
  const pyproject = join(path, "pyproject.toml");
  if (existsSync(pyproject)) {
    try {
      const data = Bun.TOML.parse(readFileSync(pyproject, "utf8")) as Record<
        string,
        unknown
      >;
      const project = data.project;
      if (project && typeof project === "object") {
        const desc = (project as Record<string, unknown>).description;
        if (typeof desc === "string" && desc.trim() !== "") {
          return desc.trim();
        }
      }
    } catch {
      // Try the next manifest.
    }
  }

  const packageJson = join(path, "package.json");
  if (existsSync(packageJson)) {
    try {
      const data = JSON.parse(readFileSync(packageJson, "utf8")) as Record<
        string,
        unknown
      >;
      const desc = data.description;
      if (typeof desc === "string" && desc.trim() !== "") {
        return desc.trim();
      }
    } catch {
      // Try CLAUDE.md.
    }
  }

  const claudeMd = join(path, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    try {
      let text = readFileSync(claudeMd, "utf8");
      if (text.startsWith("---")) {
        const end = text.indexOf("---", 3);
        if (end !== -1) text = text.slice(end + 3);
      }
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#") || line.startsWith("-")) {
          continue;
        }
        if (line.length > 100) {
          return `${line.slice(0, 100).replace(/\s+\S*$/, "")}...`;
        }
        return (
          line
            .split(/[.!?]\s/)[0]
            ?.replace(/[.!?]+$/, "")
            .trim() ?? ""
        );
      }
    } catch {
      return "";
    }
  }

  return "";
}

export function readWorkspaceMembers(path: string): string[] {
  const members = new Set<string>();
  const pyproject = join(path, "pyproject.toml");
  if (existsSync(pyproject)) {
    try {
      const data = Bun.TOML.parse(readFileSync(pyproject, "utf8")) as Record<
        string,
        unknown
      >;
      const tool = data.tool;
      const uv =
        tool && typeof tool === "object"
          ? (tool as Record<string, unknown>).uv
          : null;
      const workspace =
        uv && typeof uv === "object"
          ? (uv as Record<string, unknown>).workspace
          : null;
      const rawMembers =
        workspace && typeof workspace === "object"
          ? (workspace as Record<string, unknown>).members
          : null;
      if (Array.isArray(rawMembers)) {
        addWorkspacePatterns(path, rawMembers, members);
      }
    } catch {
      // pnpm-workspace.yaml may still contribute members.
    }
  }

  const pnpmWorkspace = join(path, "pnpm-workspace.yaml");
  if (existsSync(pnpmWorkspace)) {
    try {
      const data = Bun.YAML.parse(
        readFileSync(pnpmWorkspace, "utf8"),
      ) as Record<string, unknown> | null;
      const packages = data && typeof data === "object" ? data.packages : null;
      if (Array.isArray(packages)) {
        addWorkspacePatterns(path, packages, members);
      }
    } catch {
      // Ignore malformed workspace metadata.
    }
  }

  return [...members].sort();
}

function addWorkspacePatterns(
  root: string,
  patterns: readonly unknown[],
  members: Set<string>,
): void {
  for (const raw of patterns) {
    if (typeof raw !== "string" || raw.trim() === "" || raw.startsWith("!")) {
      continue;
    }
    const pattern = raw.trim();
    if (!/[?*[\]{}]/.test(pattern)) {
      const direct = join(root, pattern);
      if (isDir(direct)) members.add(basename(direct));
      continue;
    }
    try {
      const glob = new Bun.Glob(pattern);
      for (const match of glob.scanSync({ cwd: root, onlyFiles: false })) {
        const full = join(root, match);
        if (isDir(full)) members.add(basename(full));
      }
    } catch {
      // Ignore invalid glob patterns.
    }
  }
}

function activityByProjectPath(
  roots: readonly ProjectRoot[],
  projects: ReadonlyMap<string, RankedProject>,
  rows: readonly JobActivityRow[],
  now: number,
): Map<string, ProjectActivity> {
  const out = new Map<string, ProjectActivity>();
  const dayAgo = now - 86_400;
  const weekAgo = now - 604_800;
  const monthAgo = now - 2_592_000;
  for (const row of rows) {
    if (typeof row.cwd !== "string" || row.cwd === "") {
      continue;
    }
    const projectPath = projectPathForCwd(roots, projects, row.cwd);
    if (projectPath === null) {
      continue;
    }
    const ts = Math.max(
      Number(row.updated_at) || 0,
      Number(row.created_at) || 0,
    );
    const current = out.get(projectPath) ?? emptyActivity();
    current.total += 1;
    current.lastJobAt = Math.max(current.lastJobAt, ts);
    if (ts > dayAgo) current.d1 += 1;
    if (ts > weekAgo) current.d7 += 1;
    if (ts > monthAgo) current.d30 += 1;
    out.set(projectPath, current);
  }
  return out;
}

function projectPathForCwd(
  roots: readonly ProjectRoot[],
  projects: ReadonlyMap<string, RankedProject>,
  cwd: string,
): string | null {
  const normalizedCwd = normalizePath(cwd);
  const sortedRoots = [...roots].sort((a, b) => b.path.length - a.path.length);
  for (const root of sortedRoots) {
    if (!isWithin(normalizedCwd, root.path) || normalizedCwd === root.path) {
      continue;
    }
    const rel = relative(root.path, normalizedCwd);
    if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) {
      continue;
    }
    const first = rel.split(sep)[0];
    if (!first) continue;
    const projectPath = normalizePath(join(root.path, first));
    if (projects.has(projectPath)) {
      return projectPath;
    }
  }
  return null;
}

function readJobRows(dbPath: string): JobActivityRow[] {
  try {
    const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
    try {
      return db
        .query(
          "SELECT cwd, created_at, updated_at FROM jobs WHERE cwd IS NOT NULL",
        )
        .all() as JobActivityRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export function recencyScore(lastActiveTs: number, now: number): number {
  if (lastActiveTs === 0) return 0;
  const hoursAgo = (now - lastActiveTs) / 3600;
  return 100 * 0.5 ** (hoursAgo / 12);
}

export function frequencyScore(
  d1: number,
  d7: number,
  d30: number,
  total: number,
): number {
  const weighted =
    6 * Math.log1p(d1) +
    3 * Math.log1p(d7) +
    Math.log1p(d30) +
    0.3 * Math.log1p(total);
  return Math.min(weighted, 50);
}

export function gitBonus(
  gitIndexTs: number,
  lastJobTs: number,
  now: number,
): number {
  if (gitIndexTs === 0) return 0;
  const hoursAgo = (now - gitIndexTs) / 3600;
  let bonus = 10 * 0.5 ** (hoursAgo / 6);
  if (lastJobTs > 0 && gitIndexTs <= lastJobTs) {
    bonus *= 0.1;
  }
  return bonus;
}

export function projectScore(
  lastJobTs: number,
  gitIndexTs: number,
  dirTs: number,
  d1: number,
  d7: number,
  d30: number,
  total: number,
  now: number,
): number {
  const lastActive = Math.max(lastJobTs, gitIndexTs, dirTs);
  return (
    recencyScore(lastActive, now) +
    frequencyScore(d1, d7, d30, total) +
    gitBonus(gitIndexTs, lastJobTs, now)
  );
}

function emptyActivity(): ProjectActivity {
  return { lastJobAt: 0, d1: 0, d7: 0, d30: 0, total: 0 };
}

function gitIndexMtime(projectPath: string): number {
  try {
    return statSync(join(projectPath, ".git", "index")).mtimeMs / 1000;
  } catch {
    return 0;
  }
}

function dirMtime(projectPath: string): number {
  try {
    return statSync(projectPath).mtimeMs / 1000;
  } catch {
    return 0;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function normalizePath(path: string): string {
  let resolved = path;
  if (path.startsWith("~")) {
    const home = homedir();
    resolved = path === "~" ? home : join(home, path.slice(2));
  }
  try {
    resolved = realpathSync(resolved);
  } catch {
    // Keep a lexical absolute-ish form for missing paths.
  }
  return resolved.replace(new RegExp(`${escapeRegExp(sep)}+$`), "") || sep;
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
