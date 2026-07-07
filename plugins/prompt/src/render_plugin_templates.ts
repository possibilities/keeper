// `keeper prompt render-plugin-templates` — the build-time generator that stamps
// every Claude-plugin tree (`<plugin>/template/{commands,skills,agents}/*.md.tmpl`)
// into the per-shape output dirs (`commands/`, `skills/`, `agents/`) plus a
// visible `.managed-file-dont-edit` sidecar beside each generated file. Port of
// promptctl run_render_plugin_templates.py — byte-for-byte on the rendered tree
// and every sidecar (the generated-guard's sha256 contract depends on it).
//
// The seven preserved behaviors (numbered in the body):
//
//   1. Run build-snippets first (in-process; only when the arthack snippet corpus
//      is present under the project root).
//   2. Three template-kinds -> output shapes: template/commands -> commands/<stem>.md,
//      template/skills -> skills/<stem>/SKILL.md (variant = directory name),
//      template/agents -> agents/<stem>.md.
//   3. Variant fan-out: a `variants:` frontmatter list renders once per variant
//      with `current_variant` bound. The non-variant branch does NOT bind
//      `current_variant` — strictVariables raises on a stray reference, the
//      asymmetry that keeps a variant template from rendering as non-variant.
//   4. Cross-boundary `render_to:` (agents only) is resolved POST-render from the
//      rendered frontmatter; the output stem follows the rendered `name:` field.
//   5. Frontmatter stripping: `variants:` everywhere, `render_to:` on agents. The
//      skill non-variant branch deliberately does NOT strip `variants:` (faithful
//      asymmetry — do not "fix" it).
//   6. Orphan cleanup runs on COMMANDS ONLY (variant-aware), collect-then-delete,
//      with a containment escape guard; empty commands/ dirs are rmdir'd.
//   7. Exit code: 1 iff any render failed, else 0 — never aborts early.
//
// Sidecar serialization is frozen: `json.dumps(sort_keys=True, indent=2,
// ensure_ascii=False) + "\n"` with `_warning`/`source_template`/`sha256`. The
// em-dash in `_warning` stays literal (ensure_ascii=False). `render_to:` agents
// additionally emit a per-tier `plugin.json` manifest (insertion-order JSON, no
// key sort) plus its own sidecar; a `render_to:` template missing
// `manifest_description:` raises — build-forward, no fallback.
//
// The ONE deliberate diff vs the Python oracle: the sidecar `_warning` and any
// regenerate cite say `keeper prompt`, not `promptctl`.

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
  type EffectiveMatrix,
  effectiveMatrixFromDisk,
} from "../../plan/src/subagents_config.ts";
import { runBuildSnippets } from "./build_snippets.ts";
import { renderTemplate, sourceRelpath } from "./render_engine.ts";

const VARIANTS_STRIP_RE = /^variants:.*\n/gm;
const RENDER_TO_STRIP_RE = /^render_to:.*\n/gm;
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

/** The plugin's EFFECTIVE {model × effort} matrix, or null when the plugin ships
 * no `subagents.yaml`. The plugin's committed config is the claude-native base;
 * a host `~/.config/keeper/matrix.yaml`, when present, overrides the model axis
 * (adding wrapped capability cells) and the wrapper driver. Read once per
 * renderAgents pass; a listed agent template fans out over the sorted cartesian
 * product instead of the 1-D `variants:` path. A malformed config throws
 * (fail-loud build). */
function pluginEffectiveMatrix(pluginDir: string): EffectiveMatrix | null {
  const configPath = join(pluginDir, "subagents.yaml");
  if (!isFile(configPath)) {
    return null;
  }
  return effectiveMatrixFromDisk(configPath);
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

/** Build the per-tier `plugin.json` manifest. Key order matches the hand-written
 * stopgap manifests (`name`, `description`, `version`, `author`); sort_keys is
 * intentionally OFF (insertion order), ensure_ascii=False keeps the em-dash
 * literal. Mirrors _manifest_content. */
function manifestContent(description: string): string {
  const manifest = {
    name: "work",
    description,
    version: "1.0.0",
    author: { name: "ArtHack" },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
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

/** Resolution result for an agent output (post-render frontmatter). */
interface AgentOutput {
  out: string;
  label: string;
  manifestPath: string | null;
  manifestDescription: string | null;
}

/** Resolve the final agent output path using post-render frontmatter. When
 * `render_to:` is declared, the target dir is `<pluginDir>/<render_to>/agents`
 * (render_to names a sub-plugin WITHIN the owning plugin, so it is resolved
 * against the plugin root, never the project root — the two coincide only when a
 * plugin is rendered as its own project root) and the stem follows the rendered
 * `name:` field; a per-tier plugin.json manifest path + its rendered
 * `manifest_description` are returned alongside. Path-traversal guarded. A
 * `render_to:` template missing `manifest_description:` throws. Mirrors
 * _resolve_agent_output. */
function resolveAgentOutput(
  pluginDir: string,
  stem: string,
  defaultOut: string,
  rendered: string,
  sourceRel: string,
): AgentOutput {
  const fm = parseFrontmatter(rendered);
  const renderTo = (fm.render_to as string) || "";
  const renderName = (fm.name as string) || "";
  if (!renderTo) {
    return {
      out: defaultOut,
      label: `agents/${baseName(defaultOut)}`,
      manifestPath: null,
      manifestDescription: null,
    };
  }

  const pluginResolved = resolve(pluginDir);
  const targetDir = resolve(join(pluginDir, renderTo, "agents"));
  if (!isRelativeTo(targetDir, pluginResolved)) {
    throw new ValueErrorLike(
      `render_to escapes plugin root: '${renderTo}' → ${targetDir}`,
    );
  }
  mkdirSync(targetDir, { recursive: true });
  const outStem = renderName || stem;
  const out = join(targetDir, `${outStem}.md`);
  const label = `${renderTo}/agents/${outStem}.md`;

  const manifestDescription = fm.manifest_description;
  if (typeof manifestDescription !== "string" || !manifestDescription.trim()) {
    throw new ValueErrorLike(
      `render_to template '${sourceRel}' is missing required ` +
        "'manifest_description:' frontmatter — refusing to emit a " +
        `.claude-plugin/plugin.json manifest at '${renderTo}' without one`,
    );
  }
  const manifestPath = resolve(
    join(pluginDir, renderTo, ".claude-plugin", "plugin.json"),
  );
  if (!isRelativeTo(manifestPath, pluginResolved)) {
    throw new ValueErrorLike(
      `render_to manifest escapes plugin root: '${renderTo}' → ${manifestPath}`,
    );
  }
  return {
    out,
    label,
    manifestPath,
    manifestDescription: manifestDescription.trim(),
  };
}

/** Render template/agents/ -> agents/<stem>.md (variant-aware, render_to-aware).
 * `render_to:` is resolved POST-render. `variants:` and `render_to:` are both
 * stripped on the agent path. Mirrors _render_agents. */
function renderAgents(pluginDir: string, projectRoot: string): boolean {
  const templatesDir = join(pluginDir, "template", "agents");
  if (!isDir(templatesDir)) {
    return false;
  }
  const agentsDir = join(pluginDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  const matrix = pluginEffectiveMatrix(pluginDir);

  let hadFailures = false;
  for (const tmpl of sortedTemplates(templatesDir)) {
    const stem = baseName(tmpl).slice(0, -TMPL_SUFFIX.length);
    const sourceRel = sourceRelpath(resolve(tmpl), resolve(projectRoot));
    const baseOut = join(agentsDir, `${stem}.md`);
    const variants = sourceVariants(tmpl);
    const tmplRel = relPosix(resolve(pluginDir), resolve(tmpl));
    const matrixCell = matrix?.subagents.includes(tmplRel) ? matrix : null;

    const emit = (rendered: string, defaultOut: string): void => {
      let resolved: AgentOutput;
      try {
        resolved = resolveAgentOutput(
          pluginDir,
          stem,
          defaultOut,
          rendered,
          sourceRel,
        );
      } catch (e) {
        if (e instanceof ValueErrorLike) {
          hadFailures = true;
          process.stderr.write(`✗ ${e.message}\n`);
          return;
        }
        throw e;
      }
      const stripped = stripLines(rendered, [
        VARIANTS_STRIP_RE,
        RENDER_TO_STRIP_RE,
        MANIFEST_DESCRIPTION_STRIP_RE,
      ]);
      if (writeWithSidecar(resolved.out, stripped, sourceRel)) {
        process.stdout.write(`✓ Rendered ${resolved.label}\n`);
      }
      if (
        resolved.manifestPath !== null &&
        resolved.manifestDescription !== null
      ) {
        const manifest = manifestContent(resolved.manifestDescription);
        if (writeWithSidecar(resolved.manifestPath, manifest, sourceRel)) {
          const rel = relPosix(resolve(projectRoot), resolved.manifestPath);
          process.stdout.write(`✓ Rendered ${rel}\n`);
        }
      }
    };

    if (matrixCell !== null) {
      // 2-D {model × effort} fan-out: one generated agent per cell, both axes
      // sorted before the cartesian product for stable output ordering. Each cell
      // also carries its driver (native/wrapped) and the wrapper driver, so the
      // composed template can branch a wrapped cell onto its foreign harness
      // while a native cell stays byte-identical.
      const models = [...matrixCell.models].sort();
      const efforts = [...matrixCell.efforts].sort();
      const wrapperModel = matrixCell.wrapper_driver.model;
      const wrapperEffort = matrixCell.wrapper_driver.effort;
      for (const model of models) {
        for (const effort of efforts) {
          const defaultOut = join(agentsDir, `${stem}-${model}-${effort}.md`);
          const [rendered, failed] = renderOne(tmpl, {
            current_model: model,
            current_effort: effort,
            current_driver: matrixCell.driverFor(model),
            wrapper_model: wrapperModel,
            wrapper_effort: wrapperEffort,
          });
          if (failed) {
            hadFailures = true;
            process.stderr.write(
              `✗ Failed to render agents/${baseName(defaultOut)}\n`,
            );
            continue;
          }
          emit(rendered, defaultOut);
        }
      }
    } else if (variants.length > 0) {
      for (const variant of variants) {
        const defaultOut = variant
          ? join(agentsDir, `${stem}-${variant}.md`)
          : baseOut;
        const [rendered, failed] = renderOne(tmpl, {
          current_variant: variant,
        });
        if (failed) {
          hadFailures = true;
          process.stderr.write(
            `✗ Failed to render agents/${baseName(defaultOut)}\n`,
          );
          continue;
        }
        emit(rendered, defaultOut);
      }
    } else {
      const [rendered, failed] = renderOne(tmpl, null);
      if (failed) {
        hadFailures = true;
        process.stderr.write(
          `✗ Failed to render agents/${baseName(baseOut)}\n`,
        );
        continue;
      }
      emit(rendered, baseOut);
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

  // 1. Rebuild the snippet index so render-time globals see current state — only
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
  let hadFailures = false;

  // 2-5. Three template kinds → three shapes. Loop ordering mirrors bash: all
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
    if (renderAgents(pluginDir, projectRoot)) {
      hadFailures = true;
    }
  }

  // 6. Orphan cleanup LAST so a freshly-rendered file is never mistaken for one.
  for (const pluginDir of pluginDirs) {
    pruneCommandOrphans(pluginDir);
  }

  // 7. Exit code: 1 iff any render failed, else 0.
  return hadFailures ? 1 : 0;
}

/** Local error type mirroring Python's caught `ValueError` so the render_to
 * validation failures stay catchable distinctly from unexpected throws. */
class ValueErrorLike extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueErrorLike";
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
