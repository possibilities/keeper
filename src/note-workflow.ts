import { parseTriple } from "./agent/triple";

/** A frecency-ranked project row accepted from `keeper projects ranked`. */
export interface NoteProjectChoice {
  name: string;
  path: string;
  rootName: string | null;
}

/** One launch posture accepted from `keeper agent presets list --json`. */
export interface NoteLaunchChoice {
  triple: string;
  harness: string;
  capability: string;
  nativeId: string;
  effort: string;
}

/** The accumulated send-wizard state shown in every picker header. */
export interface NoteSendSelection {
  project: NoteProjectChoice | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
  triple: string | null;
}

/** One fzf row. The opaque value is never rendered or shell-interpolated. */
export interface PickerChoice<T> {
  value: T;
  label: string;
  /** Optional sanitized field consumed only by a caller-owned fzf preview. */
  preview?: string;
}

export type PickerResult<T> =
  | { kind: "selected"; value: T }
  | { kind: "back" }
  | { kind: "toggle" }
  | { kind: "cancel" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** Parse a command's JSON output, accepting either one pretty root or a final JSON line. */
export function parseJsonObjectFromOutput(
  stdout: string,
): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Fall through to the final-line compatibility path.
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? "";
    if (line === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Keep scanning older lines; startup diagnostics may follow a JSON line.
    }
  }
  return null;
}

/** Parse the common-envelope project discovery output without re-sorting it. */
export function parseRankedProjects(stdout: string): NoteProjectChoice[] {
  const root = parseJsonObjectFromOutput(stdout);
  if (root === null || root.ok !== true || !isRecord(root.data)) return [];
  const rows = root.data.projects;
  if (!Array.isArray(rows)) return [];
  const projects: NoteProjectChoice[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const name = stringField(raw, "name");
    const path = stringField(raw, "path");
    if (name === null || path === null) continue;
    projects.push({
      name,
      path,
      rootName: stringField(raw, "root_name"),
    });
  }
  return projects;
}

/** Parse the current harness-grouped launch cube and retain each exact triple verbatim. */
export function parseLaunchChoices(stdout: string): NoteLaunchChoice[] {
  const root = parseJsonObjectFromOutput(stdout);
  if (root === null || root.kind !== "presets-list") return [];
  if (!Array.isArray(root.harnesses)) return [];
  const choices: NoteLaunchChoice[] = [];
  for (const rawGroup of root.harnesses) {
    if (!isRecord(rawGroup)) continue;
    const harness = stringField(rawGroup, "harness");
    if (harness === null || !Array.isArray(rawGroup.triples)) continue;
    for (const raw of rawGroup.triples) {
      if (!isRecord(raw)) continue;
      const triple = stringField(raw, "triple");
      const capability = stringField(raw, "capability");
      const nativeId =
        stringField(raw, "native_id") ?? stringField(raw, "launch_id");
      const effort = stringField(raw, "effort");
      if (
        triple === null ||
        capability === null ||
        nativeId === null ||
        effort === null
      ) {
        continue;
      }
      const parsed = parseTriple(triple);
      if (
        !parsed.ok ||
        parsed.triple.harness !== harness ||
        parsed.triple.model !== nativeId ||
        parsed.triple.effort !== effort
      ) {
        continue;
      }
      choices.push({ triple, harness, capability, nativeId, effort });
    }
  }
  return choices;
}

/** Stable unique values in first-seen order. */
export function uniqueOrdered(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Render user-authored text without terminal control bytes. Newlines and tabs
 * remain useful in a preview; carriage returns normalize to newlines so they
 * cannot repaint an existing line.
 */
export function sanitizeTerminalPreview(value: string): string {
  let safe = "";
  for (const character of value.replace(/\r\n?/g, "\n")) {
    const code = character.charCodeAt(0);
    const unsafe =
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f);
    safe += unsafe ? "�" : character;
  }
  return safe;
}

/** Keep picker fields one-line and tab-safe; full bodies stay in the preview path. */
export function sanitizePickerLabel(value: string): string {
  return sanitizeTerminalPreview(value)
    .replace(/[\t\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First non-empty body line, compacted for the note list. */
export function noteSummary(body: string, maxLength = 96): string {
  const line = body
    .split(/\r?\n/)
    .map((part) => sanitizePickerLabel(part))
    .find((part) => part.length > 0);
  const summary = line ?? "(empty note)";
  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, Math.max(1, maxLength - 1))}…`;
}

/** Build tab-delimited fzf input using numeric indexes as opaque row identities. */
export function encodePickerChoices<T>(
  choices: readonly PickerChoice<T>[],
  options: { back?: boolean } = {},
): { input: string; values: Map<string, T> } {
  const rows: string[] = [];
  const values = new Map<string, T>();
  choices.forEach((choice, index) => {
    const key = String(index);
    values.set(key, choice.value);
    const preview =
      choice.preview === undefined
        ? ""
        : `\t${sanitizePickerLabel(choice.preview)}`;
    rows.push(`${key}\t${sanitizePickerLabel(choice.label)}${preview}`);
  });
  if (options.back === true) rows.push("__back__\t← Back");
  return { input: rows.length === 0 ? "" : `${rows.join("\n")}\n`, values };
}

/** Decode `fzf --expect=ctrl-b,ctrl-t` output into navigation or a selected value. */
export function decodePickerOutput<T>(
  exitCode: number,
  stdout: string,
  values: ReadonlyMap<string, T>,
): PickerResult<T> {
  if (exitCode === 1 || exitCode === 130) return { kind: "cancel" };
  if (exitCode !== 0) return { kind: "cancel" };
  const lines = stdout.replace(/\r/g, "").split("\n");
  const expected = lines[0] ?? "";
  if (expected === "ctrl-b") return { kind: "back" };
  if (expected === "ctrl-t") return { kind: "toggle" };
  const row = lines[1] ?? lines[0] ?? "";
  const key = row.split("\t", 1)[0] ?? "";
  if (key === "__back__") return { kind: "back" };
  const value = values.get(key);
  return value === undefined ? { kind: "cancel" } : { kind: "selected", value };
}

/** Human-readable breadcrumb carried in every send-wizard picker header. */
export function formatWizardHeader(
  selection: NoteSendSelection,
  choosing: "project" | "harness" | "model" | "effort" | "confirm",
): string {
  const safe = (value: string | null): string =>
    value === null ? "—" : sanitizePickerLabel(value);
  const project =
    selection.project === null
      ? "—"
      : `${safe(selection.project.name)} (${safe(selection.project.path)})`;
  return [
    "Send note to a fresh agent",
    `Project: ${project}`,
    `Harness: ${safe(selection.harness)}`,
    `Model: ${safe(selection.model)}`,
    `Effort: ${safe(selection.effort)}`,
    `Choosing: ${choosing}`,
    "Ctrl-B: back · Esc: cancel",
  ].join("\n");
}

/** POSIX-like command-word parser for `$VISUAL` / `$EDITOR` without `eval`. */
export function parseCommandWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let started = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (quote !== "single" && char === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote === null && char === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (quote === "single" && char === "'") {
      quote = null;
      continue;
    }
    if (quote === null && char === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (quote === "double" && char === '"') {
      quote = null;
      continue;
    }
    if (quote === null && /\s/.test(char)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (escaped) current += "\\";
  if (quote !== null) {
    throw new Error("editor command has an unterminated quote");
  }
  if (started) words.push(current);
  if (words.length === 0) throw new Error("editor command is empty");
  return words;
}

/** Single-quote one shell token for fzf's preview-command string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
