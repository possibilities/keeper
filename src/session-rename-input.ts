import {
  closeSync,
  constants as FS_CONSTANTS,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, sep as pathSeparator, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ClaudeNamingSection,
  projectClaudeNamingSections,
} from "./transcript/claude";

export const SESSION_RENAME_MAX_INPUT_BYTES = 16 * 1024;
export const SESSION_RENAME_MAX_REFERENCES = 8;
export const SESSION_RENAME_MAX_FILE_BYTES = 8 * 1024;
export const SESSION_RENAME_MAX_AGGREGATE_FILE_BYTES = 12 * 1024;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const SKILL_BLOCK = /<skill(?:\s[^>]*)?>[\s\S]*?<\/skill>/g;
const COMMAND_WRAPPER_TAGS = [
  "command-name",
  "command-message",
  "local-command-stdout",
] as const;

export interface SessionRenameInputStat {
  dev: number | bigint;
  ino: number | bigint;
  mode: number | bigint;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface SessionRenameInputFileSystem {
  realpath(path: string): string;
  lstat(path: string): SessionRenameInputStat;
  open(path: string, flags: number): number;
  fstat(fd: number): SessionRenameInputStat;
  read(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  close(fd: number): void;
}

const nodeFileSystem: SessionRenameInputFileSystem = {
  realpath: realpathSync,
  lstat: lstatSync,
  open: openSync,
  fstat: fstatSync,
  read: readSync,
  close: closeSync,
};

export interface SessionRenameSection {
  role: "user" | "assistant" | "summary";
  text: string;
}

export interface SessionRenameInputOptions {
  projectDir: string;
  homeDir?: string;
  fileSystem?: SessionRenameInputFileSystem;
  maxBytes?: number;
}

export interface ClaudeSessionRenameInputOptions
  extends SessionRenameInputOptions {
  transcript: string | Uint8Array;
  cutoffBytes: number;
}

interface AllocatedSection {
  label: "User" | "Assistant" | "Conversation summary";
  text: string;
  weight: number;
}

interface OpenedReference {
  label: string;
  content: string;
  contentBytes: number;
  truncated: boolean;
}

function stripNamingScaffolding(text: string): string {
  let result = text.replace(SKILL_BLOCK, "");
  for (const tag of COMMAND_WRAPPER_TAGS) {
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  }
  return result.replace(/<command-args>([\s\S]*?)<\/command-args>/g, "$1");
}

function atFenceStart(text: string, index: number, marker: "`" | "~"): number {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const indent = text.slice(lineStart, index);
  if (indent.length > 3 || /[^ ]/.test(indent)) return 0;
  let length = 0;
  while (text[index + length] === marker) length += 1;
  return length >= 3 ? length : 0;
}

function isReferenceBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return !/[\p{L}\p{N}_@]/u.test(text[index - 1] ?? "");
}

function trimUnquotedReference(value: string): string {
  return value.replace(/[.,;:!?]+$/u, "");
}

function containsUnsafeReferenceCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Find @-prefixed references in ordinary prose without interpreting code. */
export function findSessionRenamePathReferences(text: string): string[] {
  const references: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let index = 0;
  while (index < text.length) {
    if (fence !== null) {
      const length = atFenceStart(text, index, fence.marker);
      if (length >= fence.length) {
        fence = null;
        index += length;
      } else {
        index += 1;
      }
      continue;
    }

    const char = text[index];
    if (char === "`" || char === "~") {
      const fenceLength = atFenceStart(text, index, char);
      if (fenceLength > 0) {
        fence = { marker: char, length: fenceLength };
        index += fenceLength;
        continue;
      }
      if (char === "`") {
        let run = 1;
        while (text[index + run] === "`") run += 1;
        const delimiter = "`".repeat(run);
        const close = text.indexOf(delimiter, index + run);
        if (close < 0) break;
        index = close + run;
        continue;
      }
    }

    if (char !== "@" || !isReferenceBoundary(text, index)) {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    let value = "";
    const quote = text[cursor];
    if (quote === '"' || quote === "'") {
      cursor += 1;
      const end = text.indexOf(quote, cursor);
      if (end < 0 || text.slice(cursor, end).includes("\n")) {
        index += 1;
        continue;
      }
      value = text.slice(cursor, end);
      cursor = end + 1;
    } else {
      const start = cursor;
      while (cursor < text.length) {
        const current = text[cursor] ?? "";
        if (/\s/u.test(current) || "<>[]{}()\"'`,;!?".includes(current)) break;
        cursor += 1;
      }
      value = trimUnquotedReference(text.slice(start, cursor));
    }
    if (value.length > 0 && !containsUnsafeReferenceCharacter(value)) {
      references.push(value);
    }
    index = Math.max(cursor, index + 1);
  }
  return references;
}

function sameIdentity(
  left: SessionRenameInputStat,
  right: SessionRenameInputStat,
): boolean {
  return (
    BigInt(left.dev) === BigInt(right.dev) &&
    BigInt(left.ino) === BigInt(right.ino) &&
    BigInt(left.mode) === BigInt(right.mode) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function containedRelative(root: string, target: string): string | null {
  const rel = relative(root, target);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${pathSeparator}`) ||
    isAbsolute(rel)
  ) {
    return rel === "" ? "" : null;
  }
  return rel;
}

function normalizedReferencePath(
  value: string,
  homeDir: string,
): string | null {
  let normalized = value.replace(UNICODE_SPACES, " ");
  try {
    if (normalized === "~") return homeDir;
    if (normalized.startsWith("~/")) {
      return resolve(homeDir, normalized.slice(2));
    }
    if (normalized.startsWith("file://")) {
      normalized = fileURLToPath(normalized);
    }
    return normalized;
  } catch {
    return null;
  }
}

function displayLabel(relativePath: string): string {
  return relativePath.split(pathSeparator).join("/");
}

function unavailableMarker(label: string | null): string {
  return label === null
    ? "[Referenced file unavailable]"
    : `[Referenced file unavailable: ${JSON.stringify(label)}]`;
}

function openedMarker(reference: OpenedReference): string {
  const suffix = reference.truncated ? "\n[Referenced file truncated]" : "";
  return `[Referenced file: ${JSON.stringify(reference.label)}]\n${reference.content}${suffix}\n[End referenced file]`;
}

function readReference(
  fs: SessionRenameInputFileSystem,
  path: string,
  label: string,
  maxBytes: number,
): OpenedReference | null {
  let before: SessionRenameInputStat;
  try {
    before = fs.lstat(path);
    if (before.isSymbolicLink() || !before.isFile()) return null;
    const canonical = fs.realpath(path);
    if (canonical !== path) return null;
  } catch {
    return null;
  }

  let fd: number | null = null;
  try {
    const noFollow =
      typeof FS_CONSTANTS.O_NOFOLLOW === "number" ? FS_CONSTANTS.O_NOFOLLOW : 0;
    fd = fs.open(
      path,
      FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NONBLOCK | noFollow,
    );
    const opened = fs.fstat(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) return null;

    const wanted = Math.min(maxBytes, before.size);
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < wanted) {
      const chunk = new Uint8Array(Math.min(4096, wanted - total));
      const count = fs.read(fd, chunk, 0, chunk.byteLength, null);
      if (count <= 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    const after = fs.fstat(fd);
    if (total !== wanted || !sameIdentity(opened, after)) return null;

    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    if (bytes.includes(0)) return null;
    const truncated = before.size > maxBytes;
    let content: string;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      content = decoder.decode(bytes, truncated ? { stream: true } : undefined);
    } catch {
      return null;
    }
    return {
      label,
      content,
      contentBytes: bytes.byteLength,
      truncated,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.close(fd);
      } catch {
        // A close failure does not change the bounded snapshot already read.
      }
    }
  }
}

function expandHumanReferences(
  sections: readonly SessionRenameSection[],
  options: SessionRenameInputOptions,
): SessionRenameSection[] {
  const occurrences = sections.map((section) =>
    section.role === "user"
      ? findSessionRenamePathReferences(section.text)
      : [],
  );
  if (!occurrences.some((references) => references.length > 0)) {
    return sections.map((section) => ({ ...section }));
  }

  const fs = options.fileSystem ?? nodeFileSystem;
  const homeDir = options.homeDir ?? homedir();
  let projectAvailable = true;
  let canonicalProject: string;
  try {
    canonicalProject = fs.realpath(resolve(options.projectDir));
  } catch {
    projectAvailable = false;
    canonicalProject = resolve(options.projectDir);
  }
  const lexicalProject = resolve(options.projectDir);
  const seen = new Set<string>();
  let referenceCount = 0;
  let aggregateBytes = 0;

  return sections.map((section, sectionIndex) => {
    const additions: string[] = [];
    for (const raw of occurrences[sectionIndex] ?? []) {
      if (referenceCount >= SESSION_RENAME_MAX_REFERENCES) break;
      const normalized = normalizedReferencePath(raw, homeDir);
      let candidate: string | null = null;
      let label: string | null = null;
      if (normalized !== null) {
        if (isAbsolute(normalized)) {
          const rel = containedRelative(lexicalProject, resolve(normalized));
          if (rel !== null) candidate = resolve(canonicalProject, rel);
        } else {
          candidate = resolve(canonicalProject, normalized);
        }
        if (candidate !== null) {
          const rel = containedRelative(canonicalProject, candidate);
          if (rel === null) candidate = null;
          else label = displayLabel(rel);
        }
      }
      const key = candidate === null ? `invalid:${raw}` : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      referenceCount += 1;

      if (
        candidate === null ||
        !projectAvailable ||
        aggregateBytes >= SESSION_RENAME_MAX_AGGREGATE_FILE_BYTES
      ) {
        additions.push(unavailableMarker(label));
        continue;
      }
      let canonicalTarget: string;
      try {
        canonicalTarget = fs.realpath(candidate);
      } catch {
        additions.push(unavailableMarker(label));
        continue;
      }
      if (
        canonicalTarget !== candidate ||
        containedRelative(canonicalProject, canonicalTarget) === null
      ) {
        additions.push(unavailableMarker(label));
        continue;
      }
      const remaining =
        SESSION_RENAME_MAX_AGGREGATE_FILE_BYTES - aggregateBytes;
      const opened = readReference(
        fs,
        candidate,
        label ?? "",
        Math.min(SESSION_RENAME_MAX_FILE_BYTES, remaining),
      );
      if (opened === null) {
        additions.push(unavailableMarker(label));
        continue;
      }
      aggregateBytes += opened.contentBytes;
      additions.push(openedMarker(opened));
    }
    return additions.length === 0
      ? { ...section }
      : { ...section, text: `${section.text}\n\n${additions.join("\n\n")}` };
  });
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, midpoint), "utf8") <= maxBytes) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  let result = text.slice(0, low);
  if (/^[\uD800-\uDBFF]$/.test(result.at(-1) ?? ""))
    result = result.slice(0, -1);
  return result;
}

function allocateBytes(
  sections: readonly AllocatedSection[],
  budget: number,
): number[] {
  const allocations = sections.map(() => 0);
  let remaining = budget;
  let active = sections.map((_, index) => index);
  while (active.length > 0 && remaining > 0) {
    const totalWeight = active.reduce(
      (sum, index) => sum + (sections[index]?.weight ?? 0),
      0,
    );
    const unit = Math.floor(remaining / totalWeight);
    const completed = active.filter((index) => {
      const section = sections[index];
      return (
        section !== undefined &&
        Buffer.byteLength(section.text, "utf8") <= unit * section.weight
      );
    });
    if (completed.length === 0) {
      let assigned = 0;
      for (const index of active) {
        const section = sections[index];
        if (section === undefined) continue;
        const share = Math.floor((remaining * section.weight) / totalWeight);
        allocations[index] = share;
        assigned += share;
      }
      for (const index of [...active].reverse()) {
        if (assigned >= remaining) break;
        allocations[index] = (allocations[index] ?? 0) + 1;
        assigned += 1;
      }
      break;
    }
    const completedSet = new Set(completed);
    for (const index of completed) {
      const section = sections[index];
      if (section === undefined) continue;
      const bytes = Buffer.byteLength(section.text, "utf8");
      allocations[index] = bytes;
      remaining -= bytes;
    }
    active = active.filter((index) => !completedSet.has(index));
  }
  return allocations;
}

/** Build a bounded naming projection from already branch-selected sections. */
export function buildSessionRenameInputFromSections(
  inputSections: readonly SessionRenameSection[],
  options: SessionRenameInputOptions,
): string | null {
  const requestedBytes = options.maxBytes ?? SESSION_RENAME_MAX_INPUT_BYTES;
  const maxBytes = Number.isNaN(requestedBytes)
    ? 0
    : Math.max(
        0,
        Math.min(SESSION_RENAME_MAX_INPUT_BYTES, Math.floor(requestedBytes)),
      );
  if (maxBytes === 0) return null;
  const sanitized = inputSections.flatMap((section): SessionRenameSection[] => {
    const text = stripNamingScaffolding(section.text).trim();
    return text.length === 0 ? [] : [{ ...section, text }];
  });
  const expanded = expandHumanReferences(sanitized, options);
  const sections: AllocatedSection[] = expanded.map((section) => ({
    label:
      section.role === "user"
        ? "User"
        : section.role === "assistant"
          ? "Assistant"
          : "Conversation summary",
    text: section.text,
    weight: section.role === "user" ? 2 : 1,
  }));
  if (sections.length === 0) return null;

  const separator = "\n\n";
  const overhead = sections.reduce(
    (bytes, section, index) =>
      bytes +
      Buffer.byteLength(`${section.label}: `, "utf8") +
      (index === 0 ? 0 : Buffer.byteLength(separator, "utf8")),
    0,
  );
  if (overhead >= maxBytes) {
    return truncateUtf8(
      sections
        .map((section) => `${section.label}: ${section.text}`)
        .join(separator),
      maxBytes,
    );
  }
  const allocations = allocateBytes(sections, maxBytes - overhead);
  return sections
    .map(
      (section, index) =>
        `${section.label}: ${truncateUtf8(section.text, allocations[index] ?? 0)}`,
    )
    .join(separator);
}

/** Build a naming projection from the active Claude branch at `cutoffBytes`. */
export function buildSessionRenameInput(
  options: ClaudeSessionRenameInputOptions,
): string | null {
  const sections: ClaudeNamingSection[] = projectClaudeNamingSections(
    options.transcript,
    options.cutoffBytes,
  );
  return buildSessionRenameInputFromSections(sections, options);
}
