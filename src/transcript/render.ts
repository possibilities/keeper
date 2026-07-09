import type {
  RenderedTranscriptEntry,
  TranscriptEntry,
  TranscriptFilter,
  TranscriptPage,
  TranscriptPageOptions,
  TranscriptToolDetail,
} from "./model";

const COMPACT_TOOL_CHARS = 1_600;
const TOOL_INPUT_KEYS = [
  "command",
  "description",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "skill",
  "args",
  "prompt",
  "subagent_type",
  "name",
  "offset",
  "limit",
] as const;

interface ClippedText {
  text: string;
  truncated: boolean;
}

export function clipTranscriptText(
  text: string,
  maxChars: number,
): ClippedText {
  const clean = text.replaceAll("\r\n", "\n").replaceAll("\0", "");
  if (clean.length <= maxChars) {
    return { text: clean, truncated: false };
  }
  if (maxChars <= 40) {
    return { text: clean.slice(0, Math.max(0, maxChars)), truncated: true };
  }
  const marker = `\n... [truncated; original chars=${clean.length}] ...\n`;
  const available = Math.max(1, maxChars - marker.length);
  const head = Math.ceil(available * 0.7);
  const tail = available - head;
  return {
    text: `${clean.slice(0, head)}${marker}${tail > 0 ? clean.slice(-tail) : ""}`,
    truncated: true,
  };
}

function safeJson(value: unknown, pretty: boolean): string {
  try {
    const encoded = JSON.stringify(value, null, pretty ? 2 : undefined);
    return encoded ?? String(value);
  } catch {
    return String(value);
  }
}

function resultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (Array.isArray(result)) {
    const parts: string[] = [];
    for (const item of result) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (item !== null && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === "string") {
          parts.push(obj.text);
          continue;
        }
        if (typeof obj.content === "string") {
          parts.push(obj.content);
          continue;
        }
      }
      parts.push(safeJson(item, false));
    }
    return parts.join("\n");
  }
  return result === null || result === undefined ? "" : safeJson(result, true);
}

function compactToolInput(input: unknown): string {
  if (input === null || input === undefined) {
    return "";
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return safeJson(input, false);
  }
  const obj = input as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const key of TOOL_INPUT_KEYS) {
    if (obj[key] !== undefined) {
      selected[key] = obj[key];
    }
  }
  const omitted = Object.keys(obj).filter((key) => selected[key] === undefined);
  if (omitted.length > 0) {
    selected._omitted = omitted;
  }
  return safeJson(selected, true);
}

function toolBody(
  entry: TranscriptEntry,
  detail: TranscriptToolDetail,
): string {
  const tool = entry.tool;
  if (tool === null) {
    return "";
  }
  if (entry.kind === "tool_call") {
    return detail === "full"
      ? safeJson(tool.input, true)
      : compactToolInput(tool.input);
  }
  const text = resultText(tool.result);
  if (detail === "full") {
    return text;
  }
  if (text.length === 0) {
    return "[no textual output]";
  }
  return text;
}

function rawEntryText(entry: TranscriptEntry): string {
  if (entry.text !== null) {
    return entry.text;
  }
  if (entry.tool === null) {
    return "";
  }
  return [
    entry.tool.name ?? "",
    entry.tool.useId ?? "",
    safeJson(entry.tool.input, false),
    resultText(entry.tool.result),
  ].join("\n");
}

export function filterTranscriptEntries(
  entries: readonly TranscriptEntry[],
  filter: TranscriptFilter,
): TranscriptEntry[] {
  const needle = filter.grep?.toLocaleLowerCase() ?? null;
  return entries.filter((entry) => {
    if (!filter.includeMeta && entry.meta) {
      return false;
    }
    if (!filter.includeThinking && entry.kind === "thinking") {
      return false;
    }
    if (filter.tools === "none" && entry.role === "tool") {
      return false;
    }
    if (filter.roles !== null && !filter.roles.has(entry.role)) {
      return false;
    }
    if (
      filter.sinceMs !== null &&
      (entry.timestampMs === null || entry.timestampMs < filter.sinceMs)
    ) {
      return false;
    }
    if (
      filter.untilMs !== null &&
      (entry.timestampMs === null || entry.timestampMs > filter.untilMs)
    ) {
      return false;
    }
    if (
      needle !== null &&
      !rawEntryText(entry).toLocaleLowerCase().includes(needle)
    ) {
      return false;
    }
    return true;
  });
}

function renderEntry(
  entry: TranscriptEntry,
  tools: TranscriptToolDetail,
  maxEntryChars: number,
): RenderedTranscriptEntry {
  const raw =
    entry.role === "tool" ? toolBody(entry, tools) : (entry.text ?? "");
  const effectiveMax =
    entry.role === "tool" && tools === "compact"
      ? Math.min(COMPACT_TOOL_CHARS, maxEntryChars)
      : maxEntryChars;
  const clipped = clipTranscriptText(raw, effectiveMax);
  return {
    index: entry.ordinal,
    sourceIndex: entry.sourceOrdinal,
    source: entry.source,
    timestamp: entry.timestamp,
    role: entry.role,
    kind: entry.kind,
    toolName: entry.tool?.name ?? null,
    toolUseId: entry.tool?.useId ?? null,
    isError: entry.tool === null ? null : entry.tool.isError,
    body: clipped.text,
    truncated: clipped.truncated,
  };
}

function renderedCost(entry: RenderedTranscriptEntry): number {
  return entry.body.length + 160;
}

function forceFit(
  entry: RenderedTranscriptEntry,
  maxChars: number,
): RenderedTranscriptEntry {
  const clipped = clipTranscriptText(entry.body, Math.max(1, maxChars - 160));
  return {
    ...entry,
    body: clipped.text,
    truncated: entry.truncated || clipped.truncated,
  };
}

/** Filter and page entries forward by offset or backward by before cursor. */
export function buildTranscriptPage(
  entries: readonly TranscriptEntry[],
  filter: TranscriptFilter,
  options: TranscriptPageOptions,
): TranscriptPage {
  const filtered = filterTranscriptEntries(entries, filter);
  const total = filtered.length;
  const backward = options.offset === null;
  const backwardEnd = Math.min(options.before ?? total, total);
  const requestedOffset = backward
    ? Math.max(0, backwardEnd - options.limit)
    : Math.min(options.offset as number, total);
  const candidates = filtered
    .slice(
      requestedOffset,
      backward ? backwardEnd : requestedOffset + options.limit,
    )
    .map((entry) => renderEntry(entry, filter.tools, options.maxEntryChars));

  const selected: RenderedTranscriptEntry[] = [];
  let used = 0;
  let skippedFromFront = 0;
  let clippedByChars = false;
  if (backward) {
    for (let index = candidates.length - 1; index >= 0; index--) {
      const entry = candidates[index] as RenderedTranscriptEntry;
      const cost = renderedCost(entry);
      if (selected.length > 0 && used + cost > options.maxChars) {
        skippedFromFront = index + 1;
        clippedByChars = true;
        break;
      }
      const fitted =
        selected.length === 0 && cost > options.maxChars
          ? forceFit(entry, options.maxChars)
          : entry;
      if (fitted !== entry) {
        clippedByChars = true;
      }
      selected.push(fitted);
      used += renderedCost(fitted);
    }
    selected.reverse();
  } else {
    for (const entry of candidates) {
      const cost = renderedCost(entry);
      if (selected.length > 0 && used + cost > options.maxChars) {
        clippedByChars = true;
        break;
      }
      const fitted =
        selected.length === 0 && cost > options.maxChars
          ? forceFit(entry, options.maxChars)
          : entry;
      if (fitted !== entry) {
        clippedByChars = true;
      }
      selected.push(fitted);
      used += renderedCost(fitted);
    }
  }

  const offset = requestedOffset + skippedFromFront;
  const endOffset = offset + selected.length;
  return {
    entries: selected,
    total,
    offset,
    endOffset,
    requestedLimit: options.limit,
    olderBefore: offset > 0 ? offset : null,
    newerOffset: endOffset < total ? endOffset : null,
    clippedByChars,
  };
}

function entryLabel(
  entry: RenderedTranscriptEntry,
  showSource: boolean,
): string {
  const fields = [`#${entry.index}`, entry.timestamp ?? "time-unknown"];
  if (showSource || entry.source !== "main") {
    fields.push(entry.source);
  }
  if (entry.kind === "tool_call") {
    fields.push("tool-call", entry.toolName ?? "unknown-tool");
  } else if (entry.kind === "tool_result") {
    fields.push(
      "tool-result",
      entry.toolName ?? "unknown-tool",
      entry.isError ? "error" : "ok",
    );
  } else {
    fields.push(entry.kind === "text" ? entry.role : entry.kind);
  }
  if (entry.toolUseId !== null) {
    fields.push(`id=${entry.toolUseId}`);
  }
  if (entry.truncated) {
    fields.push("truncated");
  }
  return `[${fields.join(" ")}]`;
}

export function renderTranscriptEntriesText(
  entries: readonly RenderedTranscriptEntry[],
  showSource: boolean,
): string {
  if (entries.length === 0) {
    return "(no entries matched)\n";
  }
  return `${entries
    .map((entry) => {
      const label = entryLabel(entry, showSource);
      return entry.body.length > 0 ? `${label}\n${entry.body}` : label;
    })
    .join("\n\n")}\n`;
}
