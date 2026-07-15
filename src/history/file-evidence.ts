import { isAbsolute, normalize, resolve } from "node:path";
import { extractBashMutation, extractMutationPath } from "../derivers";
import type { TranscriptEntry } from "../transcript/model";
import type {
  CanonicalMutationFact,
  FileEvidence,
  FileEvidenceGrade,
  FileEvidenceProvenance,
  FileEvidenceSource,
  HistoryContextHandle,
} from "./model";

const PATH_MAX_CHARS = 4096;
const TEXT_SCAN_MAX_CHARS = 64 * 1024;
const TREE_SENTINEL = "__TREE__";

const GRADE_STRENGTH: Readonly<Record<FileEvidenceGrade, number>> = {
  mention: 1,
  possible_mutation: 2,
  observed_mutation: 3,
};

const DIRECT_PATH_KEYS = new Set([
  "file_path",
  "filePath",
  "notebook_path",
  "notebookPath",
  "path",
]);

/** Conservative lexical candidates: absolute/relative slash paths and familiar
 * filename-like tokens. Matching text establishes a mention only. */
const PATH_MENTION_RE =
  /(?:^|[\s"'`({[])(\.{0,2}\/[^\s"'`(){}[\],;]+|(?:[A-Za-z0-9_@.+-]+\/)+[A-Za-z0-9_@.+-]+|[A-Za-z0-9_@+-]+\.[A-Za-z0-9]{1,16})(?=$|[\s"'`(){}[\],;:])/g;

export interface DeriveFileEvidenceOptions {
  entries: readonly TranscriptEntry[];
  project: string | null;
  canonicalMutations?: readonly CanonicalMutationFact[];
  /** Supplies an index-compatible context handle without coupling this pure
   * derivation to the History index. */
  contextForEntry?: (entry: TranscriptEntry) => HistoryContextHandle | null;
}

interface MutableEvidence {
  path: string;
  grade: FileEvidenceGrade;
  provenance: FileEvidenceProvenance[];
}

function cleanCandidate(candidate: string): string | null {
  let value = candidate.trim();
  if (value.length > PATH_MAX_CHARS) return null;
  value = value.replace(/[),;:'"`]+$/, "");
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("://") ||
    value === TREE_SENTINEL ||
    value.startsWith("-")
  ) {
    return null;
  }
  return value;
}

/** Lexical normalization only; confidence is carried separately and unchanged. */
export function normalizeEvidencePath(
  candidate: string,
  project: string | null,
): string | null {
  const cleaned = cleanCandidate(candidate);
  if (cleaned === null) return null;
  if (cleaned.startsWith("~")) return normalize(cleaned);
  if (isAbsolute(cleaned)) return normalize(cleaned);
  return project === null ? normalize(cleaned) : resolve(project, cleaned);
}

function mentionCandidates(text: string): string[] {
  const bounded =
    text.length <= TEXT_SCAN_MAX_CHARS
      ? text
      : text.slice(0, TEXT_SCAN_MAX_CHARS);
  const found: string[] = [];
  for (const match of bounded.matchAll(PATH_MENTION_RE)) {
    const value = match[1];
    if (value !== undefined) found.push(value);
  }
  return found;
}

function directToolPaths(value: unknown): string[] {
  const found: string[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < 512) {
    const item = stack.pop();
    if (item === undefined) break;
    visited++;
    if (item.depth > 8 || item.value === null) continue;
    if (Array.isArray(item.value)) {
      for (const child of item.value) {
        stack.push({ value: child, depth: item.depth + 1 });
      }
      continue;
    }
    if (typeof item.value !== "object") continue;
    for (const [key, child] of Object.entries(
      item.value as Record<string, unknown>,
    )) {
      if (DIRECT_PATH_KEYS.has(key) && typeof child === "string") {
        found.push(child);
      } else {
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return found;
}

function allStrings(value: unknown): string[] {
  const found: string[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < 512) {
    const item = stack.pop();
    if (item === undefined) break;
    visited++;
    if (item.depth > 8 || item.value === null) continue;
    if (typeof item.value === "string") {
      found.push(item.value);
      continue;
    }
    if (Array.isArray(item.value)) {
      for (const child of item.value) {
        stack.push({ value: child, depth: item.depth + 1 });
      }
      continue;
    }
    if (typeof item.value === "object") {
      for (const child of Object.values(
        item.value as Record<string, unknown>,
      )) {
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return found;
}

function provenanceKey(provenance: FileEvidenceProvenance): string {
  const context = provenance.context;
  return `${provenance.source}\0${context?.sourceKey ?? ""}\0${context?.sourceOrdinal ?? -1}`;
}

/** Derive one strongest honest grade per normalized path. A shell command can
 * never enter the observed arm; only canonical facts or a settled successful
 * canonical mutation tool can. */
export function deriveFileEvidence(
  options: DeriveFileEvidenceOptions,
): FileEvidence[] {
  const evidence = new Map<string, MutableEvidence>();
  const add = (
    candidate: string,
    grade: FileEvidenceGrade,
    source: FileEvidenceSource,
    context: HistoryContextHandle | null,
  ): void => {
    const path = normalizeEvidencePath(candidate, options.project);
    if (path === null) return;
    const provenance = { source, context } satisfies FileEvidenceProvenance;
    const existing = evidence.get(path);
    if (
      existing === undefined ||
      GRADE_STRENGTH[grade] > GRADE_STRENGTH[existing.grade]
    ) {
      evidence.set(path, { path, grade, provenance: [provenance] });
      return;
    }
    if (existing.grade !== grade) return;
    const key = provenanceKey(provenance);
    if (!existing.provenance.some((item) => provenanceKey(item) === key)) {
      existing.provenance.push(provenance);
    }
  };

  for (const fact of options.canonicalMutations ?? []) {
    add(
      fact.path,
      "observed_mutation",
      "canonical_mutation",
      fact.context ?? null,
    );
  }

  const successfulUseIds = new Set<string>();
  for (const entry of options.entries) {
    if (
      entry.kind === "tool_result" &&
      entry.tool?.useId !== null &&
      entry.tool?.useId !== undefined &&
      !entry.tool.isError
    ) {
      successfulUseIds.add(`${entry.source}\0${entry.tool.useId}`);
    }
  }

  for (const entry of options.entries) {
    const context = options.contextForEntry?.(entry) ?? null;
    if (entry.text !== null) {
      for (const candidate of mentionCandidates(entry.text)) {
        add(candidate, "mention", "transcript_text", context);
      }
    }
    const tool = entry.tool;
    if (tool === null) continue;

    for (const candidate of directToolPaths(tool.input)) {
      add(candidate, "mention", "tool_reference", context);
    }
    for (const value of [
      ...allStrings(tool.input),
      ...allStrings(tool.result),
    ]) {
      for (const candidate of mentionCandidates(value)) {
        add(candidate, "mention", "tool_reference", context);
      }
    }

    if (entry.kind !== "tool_call" || tool.name === null) continue;
    const mutationPath = extractMutationPath("PostToolUse", tool.name, {
      tool_input: tool.input,
    });
    if (mutationPath !== null) {
      const successful =
        tool.useId !== null &&
        successfulUseIds.has(`${entry.source}\0${tool.useId}`);
      add(
        mutationPath,
        successful ? "observed_mutation" : "mention",
        successful ? "successful_tool" : "tool_reference",
        context,
      );
    }

    // Pi commonly spells the shell tool `bash`; normalize only the tool token
    // before delegating command semantics to the same pure deriver as hooks.
    if (tool.name.toLowerCase() === "bash") {
      const shell = extractBashMutation(
        "PostToolUse",
        "Bash",
        { tool_input: tool.input },
        options.project,
      );
      for (const target of shell?.targets ?? []) {
        add(target, "possible_mutation", "shell_inference", context);
      }
    }
  }

  return [...evidence.values()]
    .map((item) => ({
      ...item,
      provenance: item.provenance.sort((a, b) =>
        provenanceKey(a).localeCompare(provenanceKey(b)),
      ),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
