/** Harness-neutral transcript model consumed by the CLI renderer. */

export const TRANSCRIPT_ROLES = [
  "user",
  "assistant",
  "tool",
  "summary",
  "system",
] as const;

export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];
export type TranscriptSource = "main" | `subagent:${string}`;
export type TranscriptEntryKind =
  | "text"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "summary"
  | "system"
  | "image";

export interface TranscriptTool {
  name: string | null;
  useId: string | null;
  input: unknown;
  result: unknown;
  isError: boolean;
}

export interface TranscriptEntry {
  /** Stable within one source file, including entries hidden by filters. */
  sourceOrdinal: number;
  /** Assigned after one or more source files are assembled for display. */
  ordinal: number;
  source: TranscriptSource;
  timestamp: string | null;
  timestampMs: number | null;
  role: TranscriptRole;
  kind: TranscriptEntryKind;
  text: string | null;
  meta: boolean;
  tool: TranscriptTool | null;
}

export interface TranscriptMetadata {
  sessionId: string;
  harness: string;
  path: string;
  project: string | null;
  title: string | null;
  agentName: string | null;
  model: string | null;
  version: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  malformedLines: number;
}

export interface TranscriptDocument {
  metadata: TranscriptMetadata;
  source: TranscriptSource;
  entries: TranscriptEntry[];
}

export interface SubagentSummary {
  id: string;
  path: string;
  bytes: number;
  startedAt: string | null;
  updatedAt: string | null;
  task: string | null;
}

export interface TranscriptSession {
  main: TranscriptDocument;
  entries: TranscriptEntry[];
  selectedSource: "main" | "all" | `subagent:${string}`;
  subagents: SubagentSummary[];
}

export interface TranscriptListItem {
  sessionId: string;
  path: string;
  project: string | null;
  title: string | null;
  startedAt: string | null;
  updatedAt: string;
  bytes: number;
  subagentCount: number;
  firstPrompt: string | null;
}

export type TranscriptToolDetail = "none" | "compact" | "full";

export interface TranscriptFilter {
  includeMeta: boolean;
  includeThinking: boolean;
  roles: ReadonlySet<TranscriptRole> | null;
  sinceMs: number | null;
  untilMs: number | null;
  grep: string | null;
  tools: TranscriptToolDetail;
}

export interface TranscriptPageOptions {
  /** Null means page backward, using before (or the transcript end). */
  offset: number | null;
  /** Exclusive filtered-entry boundary for backward pagination. */
  before: number | null;
  limit: number;
  maxChars: number;
  maxEntryChars: number;
}

export interface RenderedTranscriptEntry {
  index: number;
  sourceIndex: number;
  source: TranscriptSource;
  timestamp: string | null;
  role: TranscriptRole;
  kind: TranscriptEntryKind;
  toolName: string | null;
  toolUseId: string | null;
  isError: boolean | null;
  body: string;
  truncated: boolean;
}

export interface TranscriptPage {
  entries: RenderedTranscriptEntry[];
  total: number;
  offset: number;
  endOffset: number;
  requestedLimit: number;
  olderBefore: number | null;
  newerOffset: number | null;
  clippedByChars: boolean;
}

/**
 * Harness-neutral Latest turn: the selected branch's most recent non-empty
 * user text, plus subsequent assistant text ONLY once that response reaches
 * a successful terminal stop. `response` stays null for a prompt with no
 * complete answer yet (pending, mid tool-use, or aborted/errored/length-cut).
 * `prompt`/`response` are independently capped; a `*Truncated` flag reports
 * whether the cap actually cut its field.
 */
export interface LatestTurn {
  prompt: string;
  promptTruncated: boolean;
  response: string | null;
  responseTruncated: boolean;
}
