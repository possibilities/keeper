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

import {
  emitEnvelope,
  errorEnvelope,
  processEnvelopeSink,
  successEnvelope,
} from "./envelope";

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
  terminate: {
    summary: "Identity-rechecked TERM-then-KILL of a non-working session",
    run: terminateMain,
  },
};

const VERB_WIDTH = Math.max(...Object.keys(SUBVERBS).map((v) => v.length));
const VERB_LINES = Object.entries(SUBVERBS)
  .map(([name, spec]) => `  ${name.padEnd(VERB_WIDTH)}  ${spec.summary}`)
  .join("\n");

const TERMINATE_HELP = `keeper session terminate <session-reference>

Resolve one tracked Session, refuse a working Session, then re-check its exact
pid, start time, and harness command before TERM and before bounded KILL.
This signals only the process and never writes keeper.db.
`;

export async function terminateMain(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(TERMINATE_HELP);
    return;
  }
  if (argv.length !== 1 || argv[0] === "") {
    process.stderr.write(
      `${TERMINATE_HELP}\nExpected exactly one Session reference.\n`,
    );
    process.exit(2);
  }
  const { resolveTrackedCliSession, trackedSessionProblem } = await import(
    "./session-reference"
  );
  const resolution = resolveTrackedCliSession(argv[0] as string);
  if (resolution.kind !== "resolved") {
    emitEnvelope(
      errorEnvelope(1, trackedSessionProblem(resolution)),
      processEnvelopeSink,
    );
    return;
  }
  const { terminateSessionProcess } = await import("./agent");
  const result = await terminateSessionProcess({
    jobId: resolution.job.jobId,
    state: resolution.job.state,
    harness: resolution.job.harness,
    pid: resolution.job.pid,
    startTime: resolution.job.startTime,
  });
  if (result.ok) {
    emitEnvelope(
      successEnvelope(1, {
        job_id: resolution.job.jobId,
        pid: resolution.job.pid,
        signal: result.signal,
        exited: result.exited,
        database_written: false,
      }),
      processEnvelopeSink,
    );
    return;
  }
  const problems = {
    working: {
      code: "session_working",
      message: "the resolved Session is working and cannot be terminated",
      recovery:
        "Let the Session finish or stop before retrying; do not terminate active work.",
    },
    identity_unproven: {
      code: "session_identity_unproven",
      message: "the recorded process identity could not be confirmed",
      recovery:
        "Refresh the Session state and retry only when its pid-and-start-time witness is readable.",
    },
    command_unowned: {
      code: "session_command_unowned",
      message:
        "the recorded process does not identify as the Session's harness command",
      recovery:
        "Do not signal the pid; inspect the Session record for stale or recycled process identity.",
    },
    signal_failed: {
      code: "session_signal_failed",
      message: "the identity-confirmed Session process could not be signaled",
      recovery:
        "Check process permissions and current identity, then retry from a fresh Session resolution.",
    },
  } as const;
  emitEnvelope(errorEnvelope(1, problems[result.reason]), processEnvelopeSink);
}

const HELP = `keeper session — session-scoped reads and process control

Usage:
  keeper session <${Object.keys(SUBVERBS).join("|")}> [<session-reference>] [options]

Verbs:
${VERB_LINES}

Run 'keeper session <verb> --help' for a verb's options. Every verb emits JSON
on stdout; reads and terminate use no daemon RPC, commit, or lock.
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
