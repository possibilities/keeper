// `keeper prompt render-plugin-templates` — the build-time generator that stamps
// every Claude-plugin tree (`<plugin>/template/{commands,skills,agents}/*.md.tmpl`)
// into the per-shape output dirs (`commands/`, `skills/`, `agents/`) plus a
// visible `.managed-file-dont-edit` sidecar beside each generated file. Port of
// promptctl run_render_plugin_templates.py — byte-for-byte on the rendered tree
// and every sidecar (the generated-guard's sha256 contract depends on it).
//
// The behaviors (numbered in the body):
//
//   1. Load + validate the REQUIRED host worker matrix
//      (`~/.config/keeper/matrix.yaml`, v2) BEFORE any render. An absent /
//      unparseable / schema-invalid / valid-but-empty matrix aborts with a typed
//      four-state error and writes no partial tree.
//   2. Run build-snippets (in-process; only when the arthack snippet corpus is
//      present under the project root).
//   3. Three template-kinds -> output shapes: template/commands -> commands/<stem>.md,
//      template/skills -> skills/<stem>/SKILL.md (variant = directory name),
//      template/agents -> agents/<stem>.md.
//   4. Variant fan-out: a `variants:` frontmatter list renders once per variant
//      with `current_variant` bound. The non-variant branch does NOT bind
//      `current_variant` — strictVariables raises on a stray reference, the
//      asymmetry that keeps a variant template from rendering as non-variant.
//   5. Agent templates listed in the matrix's `subagent_templates` inventory
//      are skipped by the ordinary static-agent renderer. After ordinary
//      rendering, the Claude compiler publishes the complete `plan:work`
//      worker cohort exactly once for the discovered plan plugin; it is the sole
//      owner/writer of `workers/`.
//   6. Frontmatter stripping: `variants:` everywhere, `manifest_description:` on
//      static agents. The skill non-variant branch deliberately does NOT strip
//      `variants:` (faithful asymmetry — do not "fix" it).
//   7. Orphan cleanup runs on COMMANDS ONLY (variant-aware), collect-then-delete,
//      with a containment escape guard; empty commands/ dirs are rmdir'd.
//   8. Exit code: 1 iff any ordinary render or delegated compilation failed,
//      else 0 — never aborts early once past the matrix load.
//
// Sidecar serialization is frozen: `json.dumps(sort_keys=True, indent=2,
// ensure_ascii=False) + "\n"` with `_warning`/`source_template`/`sha256`. The
// em-dash in `_warning` stays literal (ensure_ascii=False). Worker artifacts
// use the compiler's own managed manifest and sidecar contract.
//
// The sidecar `_warning` and any regenerate cite say `keeper prompt`.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import yaml from "js-yaml";
import {
  HostMatrixConfigError,
  type HostMatrixV2,
  hostMatrixPath,
  loadHostMatrixV2,
} from "../../plan/src/host_matrix.ts";
import {
  loadPromptArtifactCatalog,
  type PromptArtifactDefaultPin,
} from "./artifact_catalog.ts";
import { runBuildSnippets } from "./build_snippets.ts";
import { resolveClaudeCompilerRoots } from "./claude_worker_compiler.ts";
import { compilePromptArtifacts } from "./prompt_compiler.ts";
import { renderTemplate, sourceRelpath } from "./render_engine.ts";

const VARIANTS_STRIP_RE = /^variants:.*\n/gm;
const MANIFEST_DESCRIPTION_STRIP_RE = /^manifest_description:.*\n/gm;

const TMPL_SUFFIX = ".md.tmpl";

/** Visible (not a dotfile) sidecar suffix so directory listings surface the
 * marker before anyone reaches for the file. */
const SIDECAR_SUFFIX = ".managed-file-dont-edit";

/** The sidecar `_warning` instruction. The literal `<project-root>` placeholder
 * (NOT the live root) is part of the frozen byte-shape. The verb says
 * `keeper prompt` — the single sanctioned diff vs the Python oracle. */
const SIDECAR_WARNING =
  "GENERATED — edit the source template and re-render: " +
  "keeper prompt render-plugin-templates --project-root <project-root>";

/** Parse the leading `---`-delimited YAML frontmatter block. Returns the mapping
 * (or {} when missing/empty/non-mapping). Mirrors _parse_frontmatter:
 * `text.split('---', 2)` guarded by `startswith('---')`. */
function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) {
    return {};
  }
  const parts = splitN(text, "---", 2);
  if (parts.length < 3) {
    return {};
  }
  let loaded: unknown;
  try {
    loaded = yaml.load(parts[1] as string) ?? {};
  } catch {
    return {};
  }
  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) {
    return {};
  }
  return loaded as Record<string, unknown>;
}

/** Python `str.split(sep, maxsplit)`: at most `maxsplit` splits, remainder kept
 * whole in the final element. */
function splitN(text: string, sepStr: string, maxsplit: number): string[] {
  const out: string[] = [];
  let rest = text;
  for (let i = 0; i < maxsplit; i += 1) {
    const idx = rest.indexOf(sepStr);
    if (idx === -1) {
      break;
    }
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sepStr.length);
  }
  out.push(rest);
  return out;
}

/** Read `variants:` from a template source pre-render. Mirrors _source_variants. */
function sourceVariants(templatePath: string): string[] {
  const text = readFileSync(templatePath, "utf-8");
  const fm = parseFrontmatter(text);
  const variants = fm.variants;
  if (!Array.isArray(variants)) {
    return [];
  }
  return variants.map((v) => String(v));
}

/** The sidecar companion path for a rendered output. */
function sidecarPath(out: string): string {
  return out + SIDECAR_SUFFIX;
}

/** Build the sidecar JSON for a rendered output. Frozen serialization:
 * sort_keys=True, indent=2, ensure_ascii=False, trailing newline. Mirrors
 * _sidecar_content. */
function sidecarContent(renderedBytes: Buffer, sourceRel: string): string {
  const payload = {
    _warning: SIDECAR_WARNING,
    source_template: sourceRel,
    sha256: createHash("sha256").update(renderedBytes).digest("hex"),
  };
  return `${sortedJson(payload)}\n`;
}

/** `json.dumps(sort_keys=True, indent=2, ensure_ascii=False)`: recursive key
 * sort, 2-space indent, raw UTF-8 (non-ASCII NOT escaped — the em-dash stays
 * literal). JSON.stringify already emits raw UTF-8 + indent=2, so only the
 * recursive key sort is owed. */
function sortedJson(data: unknown): string {
  return JSON.stringify(sortKeysDeep(data), null, 2);
}

/** Recursively sort object keys (arrays keep order). Lexicographic by code unit,
 * matching Python json.dumps(sort_keys=True). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Write `content` to `out` atomically iff bytes differ. Returns true when a
 * write happened, false when the existing file already matched (idempotent).
 * Mirrors _atomic_write_if_changed (same-dir tmp + os.replace). */
function atomicWriteIfChanged(out: string, content: string): boolean {
  const contentBytes = Buffer.from(content, "utf-8");
  if (existsSync(out) && readFileSync(out).equals(contentBytes)) {
    return false;
  }
  mkdirSync(dirname(out), { recursive: true });
  const tmp = join(dirname(out), `.${baseName(out)}.tmp.${process.pid}`);
  writeFileSync(tmp, contentBytes);
  if (!readFileSync(tmp).equals(contentBytes)) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw new Error(`tmp write mismatch for ${out}`);
  }
  renameSync(tmp, out);
  return true;
}

/** Write `content` to `out` AND its sidecar. Returns the primary's write-status.
 * Primary first so a crash between writes can never strand a stale sidecar.
 * Mirrors _write_with_sidecar. */
function writeWithSidecar(
  out: string,
  content: string,
  sourceRel: string,
): boolean {
  const contentBytes = Buffer.from(content, "utf-8");
  const sidecar = sidecarContent(contentBytes, sourceRel);
  const primaryChanged = atomicWriteIfChanged(out, content);
  atomicWriteIfChanged(sidecarPath(out), sidecar);
  return primaryChanged;
}

/** Return plugin roots: claude/*\/, apps/*\/, plugins/*\/, plus one-level-deeper
 * trees, union with the root-level .claude-plugin/plugin.json marker. Deduped by
 * resolved path; sorted globs everywhere for byte stability. Scanning `plugins/*`
 * lets a keeper repo-root `--project-root` discover the plan plugin (and any
 * future sibling under `plugins/`), so renders resolve from keeper's own root.
 * Mirrors _discover_plugin_dirs. */
function discoverPluginDirs(projectRoot: string): string[] {
  const plugins: string[] = [];
  const seen = new Set<string>();

  const add = (candidate: string): void => {
    if (!isDir(candidate)) {
      return;
    }
    if (!isFile(join(candidate, ".claude-plugin", "plugin.json"))) {
      return;
    }
    const resolved = resolve(candidate);
    if (seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    plugins.push(candidate);
  };

  for (const parentName of ["claude", "apps", "plugins"]) {
    const parent = join(projectRoot, parentName);
    if (!isDir(parent)) {
      continue;
    }
    for (const top of sortedDirs(parent)) {
      if (isFile(join(top, ".claude-plugin", "plugin.json"))) {
        add(top);
        continue;
      }
      for (const inner of sortedDirs(top)) {
        add(inner);
      }
    }
  }

  if (isFile(join(projectRoot, ".claude-plugin", "plugin.json"))) {
    add(projectRoot);
  }

  return plugins;
}

/** In-process render. Returns [renderedText, renderFailed]. The rendered text
 * gets a trailing newline appended to mirror Python's `print(rendered)`; without
 * it every generated file would diverge by one trailing newline. `hadErrors`
 * from the engine is IGNORED for the exit code (bash-faithful). Mirrors
 * _render_one. */
function renderOne(
  templatePath: string,
  extraVars: Record<string, string> | null,
): [string, boolean] {
  try {
    const { text } = renderTemplate(templatePath, extraVars);
    return [`${text}\n`, false];
  } catch (e) {
    process.stderr.write(`Error rendering ${templatePath}: ${errMsg(e)}\n`);
    return ["", true];
  }
}

/** Apply each strip pattern in order. Mirrors _strip_lines. */
function stripLines(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const pat of patterns) {
    out = out.replace(pat, "");
  }
  return out;
}

/** `{filename, ...}` for every command template, variant-aware. Mirrors
 * _expected_command_outputs. */
function expectedCommandOutputs(templatesDir: string): Set<string> {
  const expected = new Set<string>();
  if (!isDir(templatesDir)) {
    return expected;
  }
  for (const tmpl of sortedTemplates(templatesDir)) {
    const stem = baseName(tmpl).slice(0, -TMPL_SUFFIX.length);
    const variants = sourceVariants(tmpl);
    if (variants.length > 0) {
      for (const v of variants) {
        expected.add(v ? `${stem}-${v}.md` : `${stem}.md`);
      }
    } else {
      expected.add(`${stem}.md`);
    }
  }
  return expected;
}

/** Render template/commands/ -> commands/<stem>.md (variant-aware). Returns true
 * on any failure. Mirrors _render_commands. */
function renderCommands(pluginDir: string, projectRoot: string): boolean {
  const templatesDir = join(pluginDir, "template", "commands");
  if (!isDir(templatesDir)) {
    return false;
  }
  const commandsDir = join(pluginDir, "commands");
  mkdirSync(commandsDir, { recursive: true });

  let hadFailures = false;
  for (const tmpl of sortedTemplates(templatesDir)) {
    const stem = baseName(tmpl).slice(0, -TMPL_SUFFIX.length);
    const sourceRel = sourceRelpath(resolve(tmpl), resolve(projectRoot));
    const variants = sourceVariants(tmpl);

    if (variants.length > 0) {
      for (const variant of variants) {
        const outName = variant ? `${stem}-${variant}.md` : `${stem}.md`;
        const out = join(commandsDir, outName);
        const [rendered, failed] = renderOne(tmpl, {
          current_variant: variant,
        });
        if (failed) {
          hadFailures = true;
          process.stderr.write(`✗ Failed to render ${outName}\n`);
          continue;
        }
        const stripped = stripLines(rendered, [VARIANTS_STRIP_RE]);
        if (writeWithSidecar(out, stripped, sourceRel)) {
          process.stdout.write(`✓ Rendered ${outName}\n`);
        }
      }
    } else {
      const outName = `${stem}.md`;
      const out = join(commandsDir, outName);
      // NB: no current_variant on the non-variant branch — strictVariables
      // surfaces stray references.
      const [rendered, failed] = renderOne(tmpl, null);
      if (failed) {
        hadFailures = true;
        process.stderr.write(`✗ Failed to render ${outName}\n`);
        continue;
      }
      const stripped = stripLines(rendered, [VARIANTS_STRIP_RE]);
      if (writeWithSidecar(out, stripped, sourceRel)) {
        process.stdout.write(`✓ Rendered ${outName}\n`);
      }
    }
  }
  return hadFailures;
}

/** Render template/skills/ -> skills/<stem>/SKILL.md (variant-aware). The variant
 * name IS the skill slug (directory name). The non-variant branch does NOT strip
 * `variants:` — faithful asymmetry. Mirrors _render_skills. */
function renderSkills(pluginDir: string, projectRoot: string): boolean {
  const templatesDir = join(pluginDir, "template", "skills");
  if (!isDir(templatesDir)) {
    return false;
  }
  const skillsDir = join(pluginDir, "skills");
  mkdirSync(skillsDir, { recursive: true });

  let hadFailures = false;
  for (const tmpl of sortedTemplates(templatesDir)) {
    const stem = baseName(tmpl).slice(0, -TMPL_SUFFIX.length);
    const sourceRel = sourceRelpath(resolve(tmpl), resolve(projectRoot));
    const variants = sourceVariants(tmpl);

    if (variants.length > 0) {
      for (const variant of variants) {
        if (!variant) {
          continue; // bash: `[[ -n "$variant" ]] || continue`
        }
        const out = join(skillsDir, variant, "SKILL.md");
        const [rendered, failed] = renderOne(tmpl, {
          current_variant: variant,
        });
        if (failed) {
          hadFailures = true;
          process.stderr.write(`✗ Failed to render ${variant}/SKILL.md\n`);
          continue;
        }
        const stripped = stripLines(rendered, [VARIANTS_STRIP_RE]);
        if (writeWithSidecar(out, stripped, sourceRel)) {
          process.stdout.write(`✓ Rendered ${variant}/SKILL.md\n`);
        }
      }
    } else {
      const out = join(skillsDir, stem, "SKILL.md");
      const [rendered, failed] = renderOne(tmpl, null);
      if (failed) {
        hadFailures = true;
        process.stderr.write(`✗ Failed to render ${stem}/SKILL.md\n`);
        continue;
      }
      // NB: faithful — do NOT strip variants: on the non-variant skill branch.
      if (writeWithSidecar(out, rendered, sourceRel)) {
        process.stdout.write(`✓ Rendered ${stem}/SKILL.md\n`);
      }
    }
  }
  return hadFailures;
}

/** Emit a non-cell agent to `out` (+ sidecar), stripping `variants:` and
 * `manifest_description:`. */
function emitAgent(out: string, rendered: string, sourceRel: string): void {
  const stripped = stripLines(rendered, [
    VARIANTS_STRIP_RE,
    MANIFEST_DESCRIPTION_STRIP_RE,
  ]);
  if (writeWithSidecar(out, stripped, sourceRel)) {
    process.stdout.write(`✓ Rendered agents/${baseName(out)}\n`);
  }
}

/** Render template/agents/ -> agents/<stem>.md (variant-aware). Templates in
 * the matrix's `subagent_templates` inventory are compiler-owned and skipped;
 * `variants:` and `manifest_description:` are stripped on static agents. */
function renderAgents(
  pluginDir: string,
  projectRoot: string,
  matrix: HostMatrixV2,
  defaultPins: ReadonlyMap<string, PromptArtifactDefaultPin>,
): boolean {
  const templatesDir = join(pluginDir, "template", "agents");
  if (!isDir(templatesDir)) {
    return false;
  }
  const agentsDir = join(pluginDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  let hadFailures = false;
  for (const tmpl of sortedTemplates(templatesDir)) {
    const stem = baseName(tmpl).slice(0, -TMPL_SUFFIX.length);
    const sourceRel = sourceRelpath(resolve(tmpl), resolve(projectRoot));
    const baseOut = join(agentsDir, `${stem}.md`);
    const variants = sourceVariants(tmpl);
    const tmplRel = relPosix(resolve(pluginDir), resolve(tmpl));

    if (matrix.subagentTemplates.includes(tmplRel)) {
      continue;
    }

    // A catalog default keeps the host's role-specific pin optional.
    const pin = matrix.agentPins.get(stem) ?? defaultPins.get(stem);
    if (pin === undefined) {
      hadFailures = true;
      process.stderr.write(
        `✗ no agent_pins entry or catalog default_pin for '${stem}' — ` +
          "every static plan agent needs a {model, effort} pin\n",
      );
      continue;
    }
    const pinVars = { agent_model: pin.model, agent_effort: pin.effort };

    if (variants.length > 0) {
      for (const variant of variants) {
        const out = variant
          ? join(agentsDir, `${stem}-${variant}.md`)
          : baseOut;
        const [rendered, failed] = renderOne(tmpl, {
          ...pinVars,
          current_variant: variant,
        });
        if (failed) {
          hadFailures = true;
          process.stderr.write(`✗ Failed to render agents/${baseName(out)}\n`);
          continue;
        }
        emitAgent(out, rendered, sourceRel);
      }
    } else {
      const [rendered, failed] = renderOne(tmpl, pinVars);
      if (failed) {
        hadFailures = true;
        process.stderr.write(
          `✗ Failed to render agents/${baseName(baseOut)}\n`,
        );
        continue;
      }
      emitAgent(baseOut, rendered, sourceRel);
    }
  }
  return hadFailures;
}

/** Drop commands/*.md with no backing command-template (variant-aware).
 * Containment escape guard per deletion; collect-then-delete; empty commands/
 * rmdir'd at the end. Mirrors _prune_command_orphans. */
function pruneCommandOrphans(pluginDir: string): void {
  const commandsDir = join(pluginDir, "commands");
  if (!isDir(commandsDir)) {
    return;
  }
  const templatesDir = join(pluginDir, "template", "commands");
  const expected = expectedCommandOutputs(templatesDir);

  const pluginResolved = resolve(pluginDir);
  const toDelete: string[] = [];
  for (const existing of sortedMd(commandsDir)) {
    if (!isFile(existing)) {
      continue;
    }
    if (expected.has(baseName(existing))) {
      continue;
    }
    if (!isRelativeTo(resolve(existing), pluginResolved)) {
      continue;
    }
    toDelete.push(existing);
  }

  for (const path of toDelete) {
    unlinkSync(path);
    // Drop the sidecar alongside the orphan it pointed at.
    const sidecar = sidecarPath(path);
    if (isFile(sidecar)) {
      unlinkSync(sidecar);
    }
    process.stdout.write(
      `✓ Pruned orphaned command ${baseName(pluginDir)}/commands/${baseName(path)}\n`,
    );
  }

  // bash: `rmdir ... 2>/dev/null || true` — only succeeds when empty.
  try {
    if (readdirSync(commandsDir).length === 0) {
      rmdirSync(commandsDir);
    }
  } catch {
    /* swallow, bash-faithful */
  }
}

/** Args for the render-plugin-templates runner. `projectRoot` is the already-
 * resolved corpus/plugin root (the CLI layer resolves cwd / fallback). */
export interface RenderPluginTemplatesArgs {
  projectRoot: string;
}

/** In-process entry point. Returns 0 / 1 (no process.exit). The CLI layer
 * resolves `projectRoot` before calling. Mirrors run_render_plugin_templates.run
 * (minus the cwd fallback, which lives in the CLI). */
export function runRenderPluginTemplates(
  args: RenderPluginTemplatesArgs,
): number {
  const projectRoot = resolve(args.projectRoot);
  if (!isDir(projectRoot)) {
    process.stderr.write(`Error: project root not found: ${projectRoot}\n`);
    return 1;
  }

  // 1. The host worker matrix is REQUIRED — load + validate it BEFORE any write so
  //    an absent/unparseable/schema-invalid/empty matrix aborts with the typed
  //    four-state error and leaves no partial tree behind.
  const matrixPath = hostMatrixPath();
  let matrix: HostMatrixV2;
  try {
    matrix = loadHostMatrixV2(matrixPath);
  } catch (e) {
    if (e instanceof HostMatrixConfigError) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  // 2. Rebuild the snippet index so render-time globals see current state — only
  //    when the arthack snippet corpus is present under this root.
  const snippetIndexSource = join(
    projectRoot,
    "claude",
    "arthack",
    "template",
    "_partials",
    "snippets",
  );
  if (isDir(snippetIndexSource)) {
    const buildRc = runBuildSnippets({ check: false, projectRoot });
    if (buildRc !== 0) {
      process.stderr.write("✗ Failed to build snippet index\n");
      return 1;
    }
  }

  const pluginDirs = discoverPluginDirs(projectRoot);
  const defaultPinsByPlugin = new Map<
    string,
    ReadonlyMap<string, PromptArtifactDefaultPin>
  >();
  try {
    for (const pluginDir of pluginDirs) {
      const catalogPath = join(pluginDir, "prompt-artifacts.yaml");
      if (!isFile(catalogPath)) {
        defaultPinsByPlugin.set(pluginDir, new Map());
        continue;
      }
      const catalog = loadPromptArtifactCatalog(catalogPath, pluginDir);
      defaultPinsByPlugin.set(
        pluginDir,
        new Map(
          catalog.roles.flatMap((role) =>
            role.defaultPin === undefined
              ? []
              : [
                  [
                    baseName(role.source).slice(0, -TMPL_SUFFIX.length),
                    role.defaultPin,
                  ] as const,
                ],
          ),
        ),
      );
    }
  } catch (e) {
    process.stderr.write(`Error: ${errMsg(e)}\n`);
    return 1;
  }
  let hadFailures = false;

  // 3-6. Three template kinds → three shapes. Loop ordering mirrors bash: all
  // commands across all plugins, then all skills, then all agents.
  for (const pluginDir of pluginDirs) {
    if (renderCommands(pluginDir, projectRoot)) {
      hadFailures = true;
    }
  }
  for (const pluginDir of pluginDirs) {
    if (renderSkills(pluginDir, projectRoot)) {
      hadFailures = true;
    }
  }
  for (const pluginDir of pluginDirs) {
    if (
      renderAgents(
        pluginDir,
        projectRoot,
        matrix,
        defaultPinsByPlugin.get(pluginDir) ?? new Map(),
      )
    ) {
      hadFailures = true;
    }
  }

  // 7. Orphan cleanup LAST so a freshly-rendered file is never mistaken for one.
  for (const pluginDir of pluginDirs) {
    pruneCommandOrphans(pluginDir);
  }

  // Publish the compiler-owned worker cohort once, after all independent static
  // outputs have had their chance to render. A failure is loud but does not undo
  // successful ordinary outputs, matching the renderer's continue-on-error posture.
  const planPlugin = pluginDirs.find(isPlanPlugin);
  if (planPlugin !== undefined) {
    try {
      // Normalize either accepted front-door shape through the compiler's core
      // resolver. In particular, a plugins/plan root must infer the enclosing
      // Keeper root so source identities and fingerprints match Keeper-root and
      // direct compiler publication.
      const compilerRoots = resolveClaudeCompilerRoots({
        planRoot: planPlugin,
      });
      const result = compilePromptArtifacts({
        request: { target: "claude", bundle: "plan:work" },
        repoRoot: compilerRoots.repoRoot,
        planRoot: compilerRoots.planRoot,
        matrixPath,
      });
      const reported = new Set<string>();
      for (const output of result.outputs) {
        for (const item of [
          { path: output.output, changed: output.changed },
          {
            path: output.plugin_manifest.output,
            changed: output.plugin_manifest.changed,
          },
        ]) {
          if (item.changed && !reported.has(item.path)) {
            reported.add(item.path);
            process.stdout.write(`✓ Rendered workers/${item.path}\n`);
          }
        }
      }
    } catch (e) {
      hadFailures = true;
      process.stderr.write(
        `✗ Failed to compile Claude worker cohort for ${planPlugin}: ${errMsg(e)}\n`,
      );
    }
  }

  // 8. Exit code: 1 iff any render or delegated compilation failed, else 0.
  return hadFailures ? 1 : 0;
}

/** Identify the plan plugin among an arbitrary multi-plugin project root. */
function isPlanPlugin(pluginDir: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    return manifest.name === "plan";
  } catch {
    return false;
  }
}

/** True when `candidate` is `root` or lives beneath it. The separator guard stops
 * a sibling sharing the root's prefix from passing. Mirrors Path.is_relative_to. */
function isRelativeTo(candidate: string, root: string): boolean {
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Sorted `*.md.tmpl` absolute paths in `dir`. */
function sortedTemplates(dir: string): string[] {
  return sortedEntries(dir, (n) => n.endsWith(TMPL_SUFFIX));
}

/** Sorted `*.md` absolute paths in `dir`. */
function sortedMd(dir: string): string[] {
  return sortedEntries(dir, (n) => n.endsWith(".md"));
}

/** Sorted absolute file paths in `dir` matching `predicate` (mirrors
 * `sorted(dir.glob(...))` — a flat, non-recursive glob). */
function sortedEntries(
  dir: string,
  predicate: (name: string) => boolean,
): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(predicate)
    .sort()
    .map((n) => join(dir, n))
    .filter((p) => isFile(p));
}

/** Sorted immediate subdirectories of `dir` (mirrors a sorted directory glob). */
function sortedDirs(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .sort()
    .map((n) => join(dir, n))
    .filter((p) => isDir(p));
}

/** Repo-relative POSIX path (forward slashes). */
function relPosix(from: string, to: string): string {
  const rel = relative(from, to);
  return sep === "/" ? rel : rel.split(sep).join("/");
}

function baseName(p: string): string {
  const idx = p.lastIndexOf(sep);
  return idx === -1 ? p : p.slice(idx + 1);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
