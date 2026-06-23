// gist verb — the byte-parity port of planctl/run_gist.py.
//
// Renders an epic's TOC + epic spec + every task spec into a temp dir and shells
// `gh gist create --desc <desc> [--public] <files...>`, taking the last stdout
// line as the gist URL and (unless --no-open) opening it in a browser. Read-only
// locally (no .planctl/ commit) — it rides the dispatcher's readonly trailer.
// gh's exit code is the contract: a non-zero exit surfaces the plain emit_error
// envelope. GH_TOKEN/GITHUB_TOKEN ride ambient env untouched.

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitReadonlyData } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { isEpicId, parseId } from "../ids.ts";
import { resolveProject } from "../project.ts";
import { loadJson, loadJsonSafe } from "../store.ts";

export interface GistArgs {
  epicId: string;
  public: boolean;
  noOpen: boolean;
  description: string | null;
  format: OutputFormat | null;
}

export function runGist(args: GistArgs): void {
  const { epicId, public: isPublic, noOpen, description, format } = args;

  if (!isEpicId(epicId)) {
    emitError(`Invalid epic ID: ${epicId}`, format);
  }

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  const epicJsonPath = join(dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicJsonPath)) {
    emitError(`Epic not found: ${epicId}`, format);
  }

  const epicSpecPath = join(dataDir, "specs", `${epicId}.md`);
  if (!existsSync(epicSpecPath)) {
    emitError(`Epic spec missing: ${epicSpecPath}`, format);
  }

  const epicDef = loadJson(epicJsonPath);
  const epicSpec = readFileSync(epicSpecPath, "utf-8");

  const tasksDir = join(dataDir, "tasks");
  const specsDir = join(dataDir, "specs");
  const tasks: Record<string, unknown>[] = [];
  if (existsSync(tasksDir)) {
    const prefix = `${epicId}.`;
    for (const name of readdirSync(tasksDir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) {
        continue;
      }
      // Match `<epic_id>.*.json`: a single ordinal segment, no deeper dots.
      const middle = name.slice(prefix.length, -".json".length);
      if (middle.length === 0 || middle.includes(".")) {
        continue;
      }
      const td = loadJsonSafe(join(tasksDir, name));
      if (td) {
        tasks.push(td);
      }
    }
  }

  const taskNum = (task: Record<string, unknown>): number => {
    const [, n] = parseId((task.id as string | undefined) ?? "");
    return n ?? 10 ** 9;
  };
  tasks.sort((a, b) => taskNum(a) - taskNum(b));

  const epicFilename = `01-epic-${epicId}.md`;
  const taskEntries: {
    fname: string;
    task: Record<string, unknown>;
    spec: string;
  }[] = [];
  let idx = 2;
  for (const task of tasks) {
    const tid = (task.id as string | undefined) ?? "";
    const safeTid = tid.replace(/\./g, "-");
    const fname = `${String(idx).padStart(2, "0")}-${safeTid}.md`;
    const taskSpecPath = join(specsDir, `${tid}.md`);
    if (!existsSync(taskSpecPath)) {
      emitError(`Task spec missing: ${taskSpecPath}`, format);
    }
    taskEntries.push({
      fname,
      task,
      spec: readFileSync(taskSpecPath, "utf-8"),
    });
    idx += 1;
  }

  const toc = buildToc(epicDef, epicFilename, taskEntries);
  const fileCount = 2 + taskEntries.length;

  const tmp = mkdtempSync(join(tmpdir(), "planctl-gist-"));
  let gistUrl: string;
  try {
    const tocPath = join(tmp, "00-TOC.md");
    const epicPath = join(tmp, epicFilename);
    writeFileSync(tocPath, toc);
    writeFileSync(epicPath, epicSpec);

    const filePaths = [tocPath, epicPath];
    for (const entry of taskEntries) {
      const p = join(tmp, entry.fname);
      writeFileSync(p, entry.spec);
      filePaths.push(p);
    }

    const desc =
      description ??
      `${epicId} — ${(epicDef.title as string | undefined) ?? ""}`;
    const cmd = ["gist", "create", "--desc", desc];
    if (isPublic) {
      cmd.push("--public");
    }
    cmd.push(...filePaths);

    // Pass the live env explicitly (not the default-snapshot inheritance) so an
    // in-process caller that reassigned process.env — the bun:test harness
    // prepending a fake-`gh` shim dir onto PATH — reaches `gh` resolution; the
    // default-env spawn would otherwise see only the frozen startup snapshot.
    const proc = Bun.spawnSync(["gh", ...cmd], { env: process.env });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString();
      const stdout = proc.stdout.toString();
      const err = (stderr || stdout).trim() || "gh gist create failed";
      emitError(`gh gist create failed: ${err}`, format);
    }

    const stdoutLines = proc.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((ln) => ln.trim().length > 0);
    if (stdoutLines.length === 0) {
      emitError("gh gist create returned no URL", format);
    }
    gistUrl = stdoutLines[stdoutLines.length - 1] as string;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (!noOpen) {
    openInBrowser(gistUrl);
  }

  emitReadonlyData(
    {
      gist_url: gistUrl,
      epic_id: epicId,
      file_count: fileCount,
      public: isPublic,
    },
    format,
  );
}

/** Best-effort browser open via the platform opener (macOS `open`, else
 * `xdg-open`). Never throws — a missing opener is silently ignored, mirroring
 * webbrowser.open's tolerance. Tests always pass --no-open, so this never fires
 * in the suite. */
function openInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawnSync([opener, url], { env: process.env });
  } catch {
    // No opener available — ignore.
  }
}

/** GitHub gist in-page anchor for a filename: lowercase, non-alphanumerics →
 * single hyphens, trimmed, prefixed `file-`. Mirrors _anchor. */
function anchor(filename: string): string {
  const slug = filename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `file-${slug}`;
}

/** Render the TOC markdown. Mirrors _build_toc line-for-line. */
function buildToc(
  epicDef: Record<string, unknown>,
  epicFilename: string,
  taskEntries: { fname: string; task: Record<string, unknown>; spec: string }[],
): string {
  const epicId = (epicDef.id as string | undefined) ?? "";
  const title = (epicDef.title as string | undefined) ?? "";
  const epicDeps = (epicDef.depends_on_epics as string[] | undefined) ?? [];

  const lines: string[] = [`# ${title} — \`${epicId}\``, ""];
  if (epicDeps.length > 0) {
    lines.push(
      `- **Epic deps:** ${epicDeps.map((d) => `\`${d}\``).join(", ")}`,
    );
  }
  lines.push(`- **Tasks:** ${taskEntries.length}`);
  lines.push("");
  lines.push("## Contents");
  lines.push("");
  lines.push(`1. [Epic spec](#${anchor(epicFilename)})`);

  if (taskEntries.length > 0) {
    lines.push("");
    lines.push("## Tasks");
    lines.push("");
    lines.push("| # | ID | Title | Deps | Priority |");
    lines.push("|---|----|-------|------|----------|");
    let i = 1;
    for (const entry of taskEntries) {
      const task = entry.task;
      const tid = (task.id as string | undefined) ?? "";
      const a = anchor(entry.fname);
      const tTitle = (task.title as string | undefined) ?? "";
      const deps = (task.depends_on as string[] | undefined) ?? [];
      const depsStr =
        deps.length > 0 ? deps.map((d) => `\`${d}\``).join(", ") : "—";
      const pri = task.priority;
      const priStr = pri !== null && pri !== undefined ? String(pri) : "—";
      lines.push(
        `| ${i} | [\`${tid}\`](#${a}) | ${tTitle} | ${depsStr} | ${priStr} |`,
      );
      i += 1;
    }
  }

  lines.push("");
  return lines.join("\n");
}
