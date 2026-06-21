// `keeper prompt render <ref>` — pure concatenation, no Jinja, no shell. Port of
// promptctl run_render.py.
//
// The canonical runtime entry point for the snippet substrate. It dispatches by
// namespace prefix (delegated to refs.ts parse) and emits the resolved content
// to stdout. No template engine is loaded: snippet bodies are emitted verbatim
// after frontmatter is stripped — directives like `{% if %}` or `{{ x }}` flow
// through as literal characters.
//
// Dispatch semantics:
//   bundle/<name> | sketch/<name>  load the YAML, resolve each snippet_ids entry
//     to its body, concat in declared order with a single blank line between
//     bodies and a trailing newline at the end; missing ids skip with a one-line
//     stderr warning (deletion-drift policy) and rendering continues.
//   bare snippet id  emit the single snippet body, frontmatter stripped.
//   unknown prefix / traversal  error (propagated from refs.parse).
//
// Corpus resolution: a bare invocation from any cwd resolves the project root via
// project_root.ts (walk to `.git`, fall back to `~/code/arthack`) so the arthack
// corpus is found from keeper / home. Output is raw stdout — no JSON envelope and
// (the one deliberate drop vs the oracle) NO stderr token footer.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { resolveProjectRoot } from "./project_root.ts";
import {
  loadSnippetIndex,
  type ParsedRef,
  parse,
  RefError,
  type SnippetEntry,
} from "./refs.ts";

/** Separator inserted between snippet bodies inside a bundle render. A single
 * blank line: the previous body's trailing newline + one extra newline char.
 * Downstream consumers rely on this format. */
const BODY_SEPARATOR = "\n";

/** Raised when a render cannot complete (bad YAML, missing bundle file, etc). */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

/** Leading `{#- ... -#}` frontmatter comment block; DOTALL on the meta group.
 * Mirrors run_build_snippets.py _FRONTMATTER_RE. */
const FRONTMATTER_RE = /^\{#-?\s*\n([\s\S]*?)\n-?#\}\n?/;

/** Strip the leading frontmatter block, returning the raw body. Mirrors
 * run_build_snippets.py _parse_snippet (body half). */
function readSnippetBody(snippetPath: string): string {
  const text = readFileSync(snippetPath, "utf-8");
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) {
    throw new RenderError(
      `Snippet ${snippetPath} has no leading {# ... #} frontmatter block`,
    );
  }
  return text.slice(match[0].length);
}

/** Render a bare snippet ref: body verbatim, trailing newline ensured. */
function renderSingleSnippet(snippetPath: string): string {
  let body = readSnippetBody(snippetPath);
  if (!body.endsWith("\n")) {
    body = `${body}\n`;
  }
  return body;
}

/** A loaded + lightly-validated bundle YAML (the fields render consumes). */
interface BundleDoc {
  id: string;
  snippet_ids: string[];
}

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BUNDLE_KEYS = new Set([
  "id",
  "snippet_ids",
  "summary",
  "tags",
  "created_at",
]);

/** Load + validate a bundle/sketch YAML, mirroring the Pydantic Bundle schema
 * (extra='forbid', kebab id, unique non-empty snippet_ids). Mirrors
 * run_render.py _load_bundle + bundle_schema.py. */
function loadBundle(yamlPath: string): BundleDoc {
  if (!existsSync(yamlPath)) {
    throw new RenderError(`bundle file not found: ${yamlPath}`);
  }
  let data: unknown;
  try {
    data = yaml.load(readFileSync(yamlPath, "utf-8")) ?? {};
  } catch (exc) {
    throw new RenderError(`bundle YAML parse error in ${yamlPath}: ${exc}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new RenderError(`bundle YAML in ${yamlPath} is not a mapping`);
  }
  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!BUNDLE_KEYS.has(key)) {
      throw new RenderError(
        `bundle schema error in ${yamlPath}: unexpected key ${quote(key)}`,
      );
    }
  }
  const id = obj.id;
  if (typeof id !== "string" || !KEBAB_RE.test(id)) {
    throw new RenderError(
      `bundle schema error in ${yamlPath}: id must be kebab-case, got ${
        typeof id === "string" ? quote(id) : String(id)
      }`,
    );
  }
  const rawIds = obj.snippet_ids ?? [];
  if (!Array.isArray(rawIds)) {
    throw new RenderError(
      `bundle schema error in ${yamlPath}: snippet_ids must be a list`,
    );
  }
  const seen = new Set<string>();
  const snippetIds: string[] = [];
  for (const sid of rawIds) {
    if (typeof sid !== "string" || !sid) {
      throw new RenderError(
        `bundle schema error in ${yamlPath}: snippet_ids entries must be ` +
          `non-empty strings`,
      );
    }
    if (seen.has(sid)) {
      throw new RenderError(
        `bundle schema error in ${yamlPath}: snippet_ids contains duplicate ` +
          `id ${quote(sid)}`,
      );
    }
    seen.add(sid);
    snippetIds.push(sid);
  }
  return { id, snippet_ids: snippetIds };
}

/** Build {id → entry} for both bare and `<domain>/<name>` snippet ids. */
function snippetIndexMap(projectRoot: string): Map<string, SnippetEntry> {
  const byId = new Map<string, SnippetEntry>();
  for (const entry of loadSnippetIndex(projectRoot)) {
    byId.set(entry.name, entry);
    byId.set(`${entry.domain ?? ""}/${entry.name}`, entry);
  }
  return byId;
}

/** Render a bundle by concatenating its snippet bodies in declared order.
 * Missing ids skip with a one-line stderr warning (deletion-drift policy) so a
 * partially-rotted bundle still renders the survivors. Mirrors
 * run_render.py _render_bundle. */
function renderBundle(
  bundleYamlPath: string,
  projectRoot: string,
  warn: (msg: string) => void,
): string {
  const bundle = loadBundle(bundleYamlPath);
  const byId = snippetIndexMap(projectRoot);
  const templatesDir = join(projectRoot, "claude", "arthack", "template");

  const bodies: string[] = [];
  for (const snippetId of bundle.snippet_ids) {
    const entry = byId.get(snippetId);
    if (entry === undefined) {
      warn(
        `warning: snippet id not found, skipping: ${quote(snippetId)} ` +
          `(bundle: ${bundle.id})`,
      );
      continue;
    }
    const snippetPath = join(templatesDir, entry.path);
    bodies.push(readSnippetBody(snippetPath).replace(/\n+$/, ""));
  }

  if (bodies.length === 0) {
    return "";
  }
  // Single blank line between bodies; trailing newline at end.
  return bodies.map((b) => `${b}\n`).join(BODY_SEPARATOR);
}

/** Render a substrate ref to a string. `warn` is invoked once per skipped
 * phantom snippet id during a bundle render. Mirrors run_render.py render. */
export function render(
  ref: string,
  projectRoot: string,
  warn: (msg: string) => void = defaultWarn,
): string {
  let parsed: ParsedRef;
  try {
    parsed = parse(ref, projectRoot);
  } catch (exc) {
    if (exc instanceof RefError) {
      throw new RenderError(exc.message);
    }
    throw exc;
  }

  if (parsed.kind === "snippet") {
    return renderSingleSnippet(parsed.path);
  }
  return renderBundle(parsed.path, projectRoot, warn);
}

function defaultWarn(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** `keeper prompt render <ref>` runner. Raw stdout, no token footer. Returns the
 * process exit code. Mirrors run_render.py run, minus the stderr token footer. */
export function run(ref: string | undefined, format: unknown): number {
  void format; // render emits raw text regardless of --format (oracle parity).
  if (!ref) {
    process.stderr.write("Error: missing argument 'REF'\n");
    return 2;
  }
  const projectRoot = resolveProjectRoot(null);
  let rendered: string;
  try {
    rendered = render(ref, projectRoot);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`Error: ${msg}\n`);
    return 1;
  }

  // click.echo(rendered, nl=False) then click.echo("") when non-empty + no
  // trailing newline — reproduce that exact stdout shape.
  process.stdout.write(rendered);
  if (rendered && !rendered.endsWith("\n")) {
    process.stdout.write("\n");
  }
  return 0;
}

function quote(s: string): string {
  return `'${s}'`;
}
