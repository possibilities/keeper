// The `keeper prompt` template renderer — the LiquidJS keystone that reproduces
// the Python promptctl Jinja2 environment (helpers.py render_template) byte-for-
// byte on the live plugin templates.
//
// Why LiquidJS and how it maps to the Jinja surface the corpus actually uses:
//
//   * keep_trailing_newline=True  -> LiquidJS preserves trailing newlines by
//     default; no whitespace trimming is enabled, so the rendered bytes carry
//     every source newline through unchanged.
//   * StrictUndefined             -> strictVariables:true throws on any
//     undefined output (the `current_variant`-unbound branch must RAISE, the
//     asymmetry that keeps a variant template from rendering as non-variant).
//   * autoescape off              -> LiquidJS does not HTML-escape `{{ }}` output.
//   * FileSystemLoader([dirs])    -> the `root` option is the include search path
//     (loaderDirs), so `{% include "_partials/x.md.tmpl" %}` resolves like Jinja.
//   * shell() / file_exists() / snippet()/snippets()/all_snippets_in() globals
//     -> file_exists + the three snippet helpers are LiquidJS globals; the lone
//     Jinja FUNCTION-CALL output `{{ shell("cmd") }}` is rewritten to the filter
//     form `{{ "cmd" | shell }}` (the only output-tag transform) so LiquidJS can
//     parse it, then the `shell` filter runs the command.
//
// The shell filter reproduces Python subprocess.run(cmd, shell=True,
// cwd=template_dir): /bin/sh -c, stdout captured, trailing newlines stripped, and
// the `!`cmd`` fallback on a non-zero exit. `had_errors` is surfaced so the
// render-plugin-templates verb can mirror the bash exit-code semantics.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import yaml from "js-yaml";
import { Liquid } from "liquidjs";
import { findGitRoot } from "./project_root.ts";

export interface RenderResult {
  /** The rendered template text (Jinja keep_trailing_newline parity). */
  text: string;
  /** True when a shell call failed or emitted an argument-placeholder collision
   * (`$0`..`$9`); the run modules surface this without affecting the exit code. */
  hadErrors: boolean;
}

/** Snippet index entry as loaded from `_partials/snippets/_index.yaml`. */
interface SnippetEntry {
  name: string;
  path: string;
  domain?: string;
  [field: string]: unknown;
}

const LIST_FIELDS = new Set(["tags", "scope", "phase", "topics", "audience"]);

/** Render the `.md.tmpl` at `templatePath` with the promptctl Jinja environment
 * reproduced in LiquidJS. `extraVars` binds template context (e.g.
 * `current_variant`); an unbound output reference raises (StrictUndefined).
 * Returns the rendered text plus the had-errors signal. Mirrors
 * helpers.py render_template. */
export function renderTemplate(
  templatePath: string,
  extraVars: Record<string, string> | null = null,
): RenderResult {
  return renderTemplateSource(
    templatePath,
    readFileSync(templatePath, "utf-8"),
    extraVars,
  );
}

export interface RenderTemplateSourceOptions {
  /** Optional pure shell replacement. Supplying it guarantees this render does
   * not spawn commands; the caller owns every returned byte. */
  readonly shell?: (command: string) => string;
}

/** Render caller-supplied template bytes. Includes still resolve through the
 * canonical loader roots, but the primary source is never re-read. */
export function renderTemplateSource(
  templatePath: string,
  source: string,
  extraVars: Record<string, string> | null = null,
  options: RenderTemplateSourceOptions = {},
): RenderResult {
  const cwd = dirname(templatePath);
  const projectRoot = findGitRoot(cwd);
  let hadErrors = false;

  const shell = (cmd: string): string => {
    if (options.shell !== undefined) return options.shell(cmd);
    const result = spawnSync("/bin/sh", ["-c", cmd], {
      cwd,
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      hadErrors = true;
      process.stderr.write(`Warning: Command failed: ${cmd}\n`);
      const stderr = (result.stderr ?? "").trim();
      if (stderr) {
        process.stderr.write(`  stderr: ${stderr}\n`);
      }
      return `!\`${cmd}\``;
    }
    const output = (result.stdout ?? "").replace(/\n+$/, "");
    // Argument-placeholder collision check ($0..$9) — bash-faithful warning.
    for (const match of output.matchAll(/\$\d/g)) {
      hadErrors = true;
      process.stderr.write(
        `Warning: Shell output contains '${match[0]}' ` +
          `(argument placeholder collision): ${cmd}\n`,
      );
    }
    return output;
  };

  const fileExists = (path: string): boolean => {
    if (projectRoot === null) {
      return false;
    }
    return existsSync(join(projectRoot, path));
  };

  const loaderDirs = resolveLoaderDirs(templatePath, projectRoot);
  const snippetGlobals = buildSnippetHelpers(snippetRoot(loaderDirs));

  const engine = new Liquid({
    root: loaderDirs,
    extname: "",
    strictVariables: true,
    globals: {
      file_exists: fileExists,
      ...snippetGlobals,
    },
  });
  engine.registerFilter("shell", (cmd: unknown) => shell(String(cmd)));

  const text = engine.parseAndRenderSync(rewriteShellCalls(source), {
    ...(extraVars ?? {}),
  }) as string;

  return { text, hadErrors };
}

/** Rewrite every Jinja FUNCTION-CALL output `{{ shell(<quoted>) }}` to the
 * LiquidJS filter form `{{ <quoted> | shell }}`. The argument is always a single
 * quoted string literal; the scan is quote-aware (respects the quote char and
 * backslash escapes) so a `)` inside the command body never closes the call
 * early. Leading/trailing whitespace inside the tag is preserved so the rewritten
 * bytes match what a hand-authored filter tag would produce. */
export function rewriteShellCalls(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{{", i);
    if (open === -1) {
      out += source.slice(i);
      break;
    }
    const close = source.indexOf("}}", open);
    if (close === -1) {
      out += source.slice(i);
      break;
    }
    const inner = source.slice(open + 2, close);
    const head = /^(\s*)shell\((['"])/.exec(inner);
    if (head === null) {
      out += source.slice(i, close + 2);
      i = close + 2;
      continue;
    }
    const lead = head[1] as string;
    const quote = head[2] as string;
    let j = (head[0] as string).length;
    let literal = quote;
    while (j < inner.length) {
      const ch = inner[j] as string;
      literal += ch;
      if (ch === "\\") {
        literal += inner[j + 1] ?? "";
        j += 2;
        continue;
      }
      if (ch === quote) {
        j += 1;
        break;
      }
      j += 1;
    }
    const tail = /^\)(\s*)$/.exec(inner.slice(j));
    if (tail === null) {
      out += source.slice(i, close + 2);
      i = close + 2;
      continue;
    }
    out += `${source.slice(i, open)}{{${lead}${literal} | shell${tail[1]}}}`;
    i = close + 2;
  }
  return out;
}

/** The include search path. The base is the nearest ancestor of the template
 * that holds a `_partials/` child (the `template/` root) — falling back to the
 * template's own dir. A shared `claude/arthack/template` under the project root is
 * appended as a fallback loader so plugins beyond arthack can include the
 * canonical partials. Mirrors helpers.py loader_dir / loader_dirs. */
function resolveLoaderDirs(
  templatePath: string,
  projectRoot: string | null,
): string[] {
  let loaderDir = dirname(templatePath);
  let walker = dirname(templatePath);
  for (;;) {
    if (existsSync(join(walker, "_partials"))) {
      loaderDir = walker;
      break;
    }
    const parent = dirname(walker);
    if (parent === walker) {
      break;
    }
    walker = parent;
  }

  const dirs = [loaderDir];
  if (projectRoot !== null) {
    const shared = join(projectRoot, "claude", "arthack", "template");
    if (existsSync(shared) && shared !== loaderDir) {
      dirs.push(shared);
    }
  }
  return dirs;
}

/** The first loader dir carrying `_partials/snippets/_index.yaml`, else the
 * first dir. The snippet helpers index that root. */
function snippetRoot(loaderDirs: string[]): string {
  for (const d of loaderDirs) {
    if (existsSync(join(d, "_partials", "snippets", "_index.yaml"))) {
      return d;
    }
  }
  return loaderDirs[0] as string;
}

/** Load `_partials/snippets/_index.yaml` under `loaderDir` (empty when absent). */
function loadSnippetIndex(loaderDir: string): SnippetEntry[] {
  const indexPath = join(loaderDir, "_partials", "snippets", "_index.yaml");
  if (!existsSync(indexPath)) {
    return [];
  }
  const data = yaml.load(readFileSync(indexPath, "utf-8")) as {
    snippets?: SnippetEntry[];
  } | null;
  return data?.snippets ?? [];
}

/** Build the `snippet` / `snippets` / `all_snippets_in` LiquidJS globals. Paths
 * returned are relative to `loaderDir` so they feed `{% include path %}`
 * directly. Mirrors helpers.py _build_snippet_helpers. */
function buildSnippetHelpers(loaderDir: string): {
  snippet: (name: string) => string;
  snippets: (filters?: Record<string, unknown>) => string[];
  all_snippets_in: (domain: string) => string[];
} {
  const entries = loadSnippetIndex(loaderDir);
  const byName = new Map<string, SnippetEntry>();
  for (const e of entries) {
    byName.set(e.name, e);
    byName.set(`${e.domain ?? ""}/${e.name}`, e);
  }

  const snippet = (name: string): string => {
    const entry = byName.get(name);
    if (entry === undefined) {
      throw new Error(`Unknown snippet: '${name}'`);
    }
    return entry.path;
  };

  const snippets = (filters: Record<string, unknown> = {}): string[] => {
    const out: string[] = [];
    for (const entry of entries) {
      if (
        Object.entries(filters).every(([k, v]) => entryMatches(entry, k, v))
      ) {
        out.push(entry.path);
      }
    }
    return out.sort();
  };

  const all_snippets_in = (domain: string): string[] => snippets({ domain });

  return { snippet, snippets, all_snippets_in };
}

/** Whether `entry[field]` matches `want` (scalar or list-contains for the
 * list-valued fields). Mirrors helpers.py entry_matches. */
function entryMatches(
  entry: SnippetEntry,
  field: string,
  want: unknown,
): boolean {
  const have = entry[field];
  if (have === undefined || have === null) {
    return false;
  }
  const wants = Array.isArray(want) ? want : [want];
  if (LIST_FIELDS.has(field) && Array.isArray(have)) {
    return wants.some((w) => have.includes(w));
  }
  return wants.includes(have);
}

/** The repo-relative source path used in the sidecar `source_template` field. */
export function sourceRelpath(
  templatePath: string,
  projectRoot: string,
): string {
  return relative(projectRoot, templatePath);
}
