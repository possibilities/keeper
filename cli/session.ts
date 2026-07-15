#!/usr/bin/env bun
/**
 * `keeper session <state|files|events|summary>` — the session-scoped read group.
 * Each verb maps to its own leaf main (`cli/{session-state,show-session-files,
 * show-session-events,session-summary}.ts`). The leaves share Session-reference
 * resolution while retaining their established success payloads.
 *
 * The leaf mains are lazy-imported ONLY on the dispatch path, so group `--help`
 * (and the help-purity walk) never boots a leaf or opens keeper.db. Each leaf
 * owns its own `--help`, so a verb's `--help` renders that leaf's help. An
 * unknown verb is an argument fault (exit 2).
 */

interface Subverb {
  readonly summary: string;
  readonly run: (rest: string[]) => void | Promise<void>;
}

/** Registration order is the help/listing order. */
const SUBVERBS: Record<string, Subverb> = {
  state: {
    summary: "Current session git context + on-hook files (JSON)",
    run: async (rest) => (await import("./session-state")).main(rest),
  },
  files: {
    summary: "Session's on-hook dirty files grouped by repo (JSON)",
    run: async (rest) => (await import("./show-session-files")).main(rest),
  },
  events: {
    summary: "Prompt/tool-call spine for one session (JSON)",
    run: async (rest) => (await import("./show-session-events")).main(rest),
  },
  summary: {
    summary: "Bounded one-shot summary of one session (JSON)",
    run: async (rest) => (await import("./session-summary")).main(rest),
  },
};

const VERB_WIDTH = Math.max(...Object.keys(SUBVERBS).map((v) => v.length));
const VERB_LINES = Object.entries(SUBVERBS)
  .map(([name, spec]) => `  ${name.padEnd(VERB_WIDTH)}  ${spec.summary}`)
  .join("\n");

const HELP = `keeper session — session-scoped reads

Usage:
  keeper session <${Object.keys(SUBVERBS).join("|")}> [<session-reference>] [options]

Verbs:
${VERB_LINES}

Run 'keeper session <verb> --help' for a verb's options. Every read emits JSON on
stdout — no daemon connection, no commit, no lock.
`;

export async function main(argv: string[]): Promise<void> {
  const verb = argv[0];
  if (verb === undefined || verb === "--help" || verb === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const spec = SUBVERBS[verb];
  if (spec === undefined) {
    process.stderr.write(`keeper session: unknown verb '${verb}'\n\n`);
    process.stderr.write(HELP);
    process.exit(2);
  }
  await spec.run(argv.slice(1));
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}
