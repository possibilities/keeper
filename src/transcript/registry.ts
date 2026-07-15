/**
 * The harness-token → `TranscriptReader` map, and the single membership root
 * for `keeper transcript`: the CLI's help text and its unsupported-harness
 * error both derive from `transcriptHarnessNames()`, so a sibling task adds a
 * harness solely by registering a reader here — the CLI and its error/help
 * wording never need editing again.
 */

import { claudeTranscriptReader } from "./claude";
import { piTranscriptReader } from "./pi";
import type { TranscriptReader } from "./reader";

const READERS: Readonly<Record<string, TranscriptReader>> = {
  claude: claudeTranscriptReader,
  pi: piTranscriptReader,
};

/** The registered harness tokens, in registration order. */
export function transcriptHarnessNames(): string[] {
  return Object.keys(READERS);
}

export function transcriptReader(
  harness: string,
): TranscriptReader | undefined {
  return READERS[harness];
}
