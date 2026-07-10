import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { parse } from "yaml";

const MANIFEST_NAME = ".keeper-plan-agents.json";
const SIDECAR_SUFFIX = ".managed-file-dont-edit";

interface SourceAgent {
  path: string;
  filename: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

interface ManagedManifest {
  schema_version: 1;
  files: Record<string, string>;
}

export interface PiPlanAgentInstallOptions {
  sourceDir: string;
  targetDir: string;
  check?: boolean;
}

export interface PiPlanAgentInstallResult {
  changed: string[];
  removed: string[];
  checked: string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function splitAgentSource(path: string): SourceAgent {
  const source = readFileSync(path, "utf8");
  if (!source.startsWith("---\n")) {
    throw new Error(`${path}: missing YAML frontmatter`);
  }
  const close = source.indexOf("\n---\n", 4);
  if (close < 0) {
    throw new Error(`${path}: unterminated YAML frontmatter`);
  }
  const parsed = parse(source.slice(4, close));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: frontmatter must be an object`);
  }
  return {
    path,
    filename: basename(path),
    frontmatter: parsed as Record<string, unknown>,
    // Includes the blank line after the closing delimiter byte-for-byte.
    body: source.slice(close + "\n---\n".length),
  };
}

function csv(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim());
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const PI_TOOL_NAMES: Readonly<Record<string, string[]>> = {
  Bash: ["bash"],
  Edit: ["edit"],
  Glob: ["find"],
  Monitor: ["Monitor"],
  Read: ["read"],
  Task: ["Task", "Agent"],
  Write: ["write"],
};

function translatedDeniedTools(value: unknown): string[] {
  const translated: string[] = [];
  for (const tool of csv(value)) {
    for (const mapped of PI_TOOL_NAMES[tool] ?? [tool]) {
      if (!translated.includes(mapped)) translated.push(mapped);
    }
  }
  return translated;
}

function thinkingLevel(value: unknown, path: string): string {
  const effort = typeof value === "string" ? value.trim() : "";
  if (["low", "medium", "high", "xhigh"].includes(effort)) return effort;
  if (effort === "max") return "xhigh";
  throw new Error(`${path}: unsupported effort ${JSON.stringify(value)}`);
}

function maxTurnsForThinking(thinking: string): number {
  switch (thinking) {
    case "low":
      return 25;
    case "medium":
      return 40;
    case "high":
      return 60;
    case "xhigh":
      return 75;
    default:
      throw new Error(`unsupported Pi thinking level ${thinking}`);
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** Render one Claude-plugin agent as a Pi custom-agent definition. The prompt
 * body is copied byte-for-byte; only harness metadata is translated. */
export function renderPiPlanAgent(path: string): {
  filename: string;
  content: string;
  body: string;
} {
  const source = splitAgentSource(path);
  const description = source.frontmatter.description;
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`${path}: description is required`);
  }
  const thinking = thinkingLevel(source.frontmatter.effort, path);
  const denied = translatedDeniedTools(source.frontmatter.disallowedTools);
  const outputName = `plan:${basename(source.filename, ".md")}.md`;
  const lines = [
    "---",
    `description: ${yamlString(description)}`,
    `thinking: ${thinking}`,
    `max_turns: ${maxTurnsForThinking(thinking)}`,
    "prompt_mode: replace",
  ];
  if (denied.length > 0) {
    lines.push(`disallowed_tools: ${yamlString(denied.join(", "))}`);
  }
  lines.push("---", "");
  return {
    filename: outputName,
    content: `${lines.join("\n")}${source.body}`,
    body: source.body,
  };
}

function readManifest(path: string): ManagedManifest {
  if (!existsSync(path)) return { schema_version: 1, files: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path}: invalid managed manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schema_version?: unknown }).schema_version !== 1 ||
    typeof (parsed as { files?: unknown }).files !== "object" ||
    (parsed as { files?: unknown }).files === null
  ) {
    throw new Error(`${path}: unsupported managed manifest`);
  }
  return parsed as ManagedManifest;
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temp, content, { mode: 0o644 });
  chmodSync(temp, 0o644);
  renameSync(temp, path);
}

function sidecar(sourceDir: string, sourcePath: string): string {
  return [
    "Generated by Keeper for Pi. Do not edit this file directly.",
    `Source: ${relative(sourceDir, sourcePath)}`,
    "Regenerate with: bun scripts/install-pi-plan-agents.ts",
    "",
  ].join("\n");
}

/** Install or check Keeper-owned `plan:*` Pi agent definitions. Existing files
 * outside the managed manifest are never overwritten. */
export function installPiPlanAgents(
  options: PiPlanAgentInstallOptions,
): PiPlanAgentInstallResult {
  const { sourceDir, targetDir, check = false } = options;
  const sources = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(sourceDir, name));
  if (sources.length === 0) {
    throw new Error(`${sourceDir}: no plan agents found`);
  }

  const manifestPath = join(targetDir, MANIFEST_NAME);
  const previous = readManifest(manifestPath);
  const rendered = sources.map((sourcePath) => ({
    sourcePath,
    ...renderPiPlanAgent(sourcePath),
  }));
  const next: ManagedManifest = { schema_version: 1, files: {} };
  const changed: string[] = [];
  const removed: string[] = [];
  const checked: string[] = [];

  if (!check) mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  for (const item of rendered) {
    const targetPath = join(targetDir, item.filename);
    const sidecarPath = `${targetPath}${SIDECAR_SUFFIX}`;
    const hash = sha256(item.content);
    next.files[item.filename] = hash;
    checked.push(item.filename);

    const existed = existsSync(targetPath);
    const owned = Object.hasOwn(previous.files, item.filename);
    if (existed && !owned && !existsSync(sidecarPath)) {
      throw new Error(
        `${targetPath}: refusing to overwrite an unmanaged agent`,
      );
    }
    const contentMatches =
      existed && readFileSync(targetPath, "utf8") === item.content;
    const marker = sidecar(sourceDir, item.sourcePath);
    const sidecarMatches =
      existsSync(sidecarPath) && readFileSync(sidecarPath, "utf8") === marker;
    if (!contentMatches || !sidecarMatches) {
      changed.push(item.filename);
      if (!check) {
        atomicWrite(targetPath, item.content);
        atomicWrite(sidecarPath, marker);
      }
    }
  }

  for (const stale of Object.keys(previous.files).sort()) {
    if (Object.hasOwn(next.files, stale)) continue;
    removed.push(stale);
    if (!check) {
      rmSync(join(targetDir, stale), { force: true });
      rmSync(join(targetDir, `${stale}${SIDECAR_SUFFIX}`), { force: true });
    }
  }

  const manifestBody = `${JSON.stringify(next, null, 2)}\n`;
  const manifestMatches =
    existsSync(manifestPath) &&
    readFileSync(manifestPath, "utf8") === manifestBody;
  if (!manifestMatches) changed.push(MANIFEST_NAME);

  if (check && (changed.length > 0 || removed.length > 0)) {
    throw new Error(
      `Pi plan agents are stale: ${[...changed, ...removed].join(", ")}`,
    );
  }
  if (!check && !manifestMatches) atomicWrite(manifestPath, manifestBody);

  return { changed, removed, checked };
}
