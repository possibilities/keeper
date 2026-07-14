/**
 * The per-harness contract `cli/transcript.ts` drives. Root discovery lives
 * INSIDE each reader — the CLI passes raw `homeDir`/`env`/`configDirs`, never
 * a resolved root list, so no claude-shaped roots/bucket concept crosses the
 * interface. `src/transcript/registry.ts` is the harness-token → reader map;
 * a harness joins the CLI grammar solely by registering here.
 */

import type {
  TranscriptEntry,
  TranscriptListItem,
  TranscriptMetadata,
  TranscriptSession,
  TranscriptSource,
  TranscriptUnknownRecord,
} from "./model";

/** Inputs the CLI passes verbatim; a reader resolves its OWN root set from
 *  these. `configDirs`, when present, is claude's `--config-dir` repeatable
 *  flag — documented claude-only; a reader that has no notion of it ignores it. */
export interface TranscriptRootInputs {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  configDirs?: readonly string[];
}

export interface TranscriptListQuery {
  root: TranscriptRootInputs;
  /** Null scans every project; a path scans only that harness's project scope. */
  project: string | null;
  sinceMs: number | null;
  untilMs: number | null;
  offset: number;
  limit: number;
  /** Internal catalog scan: retain locator/project/time metadata without
   * normalizing prompt or tool bodies for every historical artifact. */
  metadataOnly?: boolean;
}

export type TranscriptListOutcome =
  | {
      kind: "ok";
      items: TranscriptListItem[];
      total: number;
      offset: number;
      nextOffset: number | null;
    }
  /** No readable root at all (e.g. no claude config dir) — an unconditional,
   *  format-independent CLI failure, matching the pre-existing behavior. */
  | { kind: "no_roots"; message: string }
  /** An unexpected read failure once roots resolved — format-aware in the CLI. */
  | { kind: "error"; message: string; recovery: string };

/** Opaque locator `find()` hands back and `load()` consumes; the CLI never
 *  inspects its shape, only round-trips it. */
export interface TranscriptSessionHandle {
  sessionId: string;
  path: string;
}

/** Bounded line-at-a-time normalizer used by the disposable History index. */
export interface TranscriptLineNormalizer {
  readonly source: TranscriptSource;
  feedLine(line: string): {
    entries: TranscriptEntry[];
    unknownRecords: TranscriptUnknownRecord[];
  };
  finish(): TranscriptMetadata;
}

export interface TranscriptFindQuery {
  root: TranscriptRootInputs;
  sessionId: string;
  project: string | null;
}

export type TranscriptFindOutcome =
  | { kind: "found"; handle: TranscriptSessionHandle }
  | { kind: "not_found" }
  /** `owners` are the directories the duplicate session lives under; `hint`
   *  is the flag (`--project` or `--config-dir`) that disambiguates it. */
  | { kind: "ambiguous"; owners: string[]; hint: string }
  | { kind: "no_roots"; message: string };

export interface TranscriptReader {
  readonly harness: string;
  readonly supportsSubagents: boolean;
  list(query: TranscriptListQuery): TranscriptListOutcome;
  find(query: TranscriptFindQuery): TranscriptFindOutcome;
  load(
    handle: TranscriptSessionHandle,
    subagent: string,
  ): TranscriptSession | { error: string };
}
