/**
 * Pure-tier coverage for `cli/frames.ts` (fn-1161) — the `keeper frames`
 * subcommand shell. Everything impure is injected via `FramesCliDeps`: a fake
 * dispatch table, stdout/stderr sinks, a throwing exit, and a fake `--prev-frame`
 * reader. No daemon boot, no viewer import.
 *
 * Proven here: the frames flag grammar (view allowlist + default, the
 * --follow ⨯ bound conflict, bad duration / count / prev-frame → exit 2), the
 * dispatch table reaching all five views with the right config, the
 * bounded-by-default duration + the --follow null-bounds path, help / agent-help
 * rendering, the descriptor's presence in the machine help index, and the
 * shell-owned exit-code mapping (trailer-emitted → 0, never-reachable → 1) via
 * `createViewShell`'s frames run.
 */

import { expect, test } from "bun:test";
import {
  FRAMES_VIEWS,
  type FramesCliDeps,
  type FramesEntry,
  type FramesEntryConfig,
  type FramesView,
  runFramesCli,
} from "../cli/frames";
import { buildHelpIndex } from "../cli/keeper";
import { createFramesEmitter } from "../src/frames-emitter";
import {
  createViewShell,
  type FramesRunIo,
  type ViewerExitProc,
} from "../src/view-shell";

// ---------------------------------------------------------------------------
// Harness — a fake dispatch table + injected IO
// ---------------------------------------------------------------------------

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`__EXIT_${code}__`);
  }
}

interface Harness {
  deps: FramesCliDeps;
  stdout: string[];
  stderr: string[];
  /** Every view entry that ran, with the config it received. */
  calls: Array<{ view: FramesView; config: FramesEntryConfig }>;
  /** path → contents the fake `--prev-frame` reader serves; a miss throws. */
  files: Map<string, string>;
}

function makeHarness(): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ view: FramesView; config: FramesEntryConfig }> = [];
  const files = new Map<string, string>();

  const mkEntry =
    (view: FramesView): FramesEntry =>
    async (config) => {
      calls.push({ view, config });
    };
  const entries = Object.fromEntries(
    FRAMES_VIEWS.map((v) => [v, mkEntry(v)]),
  ) as Record<FramesView, FramesEntry>;

  const deps: FramesCliDeps = {
    entries,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    exit: (code) => {
      throw new ExitError(code);
    },
    readFile: (path) => {
      const v = files.get(path);
      if (v === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return v;
    },
  };
  return { deps, stdout, stderr, calls, files };
}

/** Run the CLI, returning the exit code if one was thrown (else null). */
async function run(h: Harness, argv: string[]): Promise<number | null> {
  try {
    await runFramesCli(argv, h.deps);
    return null;
  } catch (err) {
    if (err instanceof ExitError) {
      return err.code;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// View resolution + dispatch table (all five views)
// ---------------------------------------------------------------------------

test("default --view is board; a bare invocation dispatches to the board entry", async () => {
  const h = makeHarness();
  await run(h, []);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.view).toBe("board");
});

test("the dispatch table reaches all four views by name", async () => {
  for (const view of FRAMES_VIEWS) {
    const h = makeHarness();
    await run(h, ["--view", view, "--max-frames", "1"]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.view).toBe(view);
  }
});

test("an unknown --view is a usage fault (exit 2), never a silent default", async () => {
  const h = makeHarness();
  const code = await run(h, ["--view", "nope"]);
  expect(code).toBe(2);
  expect(h.calls).toHaveLength(0);
  expect(h.stderr.join("")).toContain("--view must be one of");
});

test("the retired usage frame view is rejected and absent from help", async () => {
  const h = makeHarness();
  const code = await run(h, ["--view", "usage"]);
  expect(code).toBe(2);
  expect(h.calls).toHaveLength(0);
  expect(FRAMES_VIEWS).not.toContain("usage" as FramesView);

  const help = makeHarness();
  await run(help, ["--help"]);
  expect(help.stdout.join("")).not.toContain("builds | usage");
});

// ---------------------------------------------------------------------------
// Flag grammar — conflicts + bad values all exit 2 at parse time
// ---------------------------------------------------------------------------

test("--follow conflicts with --for at parse time (exit 2, no dispatch)", async () => {
  const h = makeHarness();
  const code = await run(h, ["--follow", "--for", "10s"]);
  expect(code).toBe(2);
  expect(h.calls).toHaveLength(0);
  expect(h.stderr.join("")).toContain("mutually exclusive");
});

test("--follow conflicts with --max-frames at parse time (exit 2)", async () => {
  const h = makeHarness();
  const code = await run(h, ["--follow", "--max-frames", "5"]);
  expect(code).toBe(2);
  expect(h.calls).toHaveLength(0);
});

test("a bad --for duration exits 2", async () => {
  const h = makeHarness();
  // Unitless value — the shared duration grammar rejects it.
  const code = await run(h, ["--for", "10"]);
  expect(code).toBe(2);
  expect(h.stderr.join("")).toContain("--for");
});

test("a non-positive-integer --max-frames exits 2", async () => {
  for (const bad of ["0", "-3", "2.5", "abc"]) {
    const h = makeHarness();
    const code = await run(h, ["--max-frames", bad]);
    expect(code).toBe(2);
    expect(h.stderr.join("")).toContain("--max-frames");
  }
});

test("an unknown flag exits 2 rather than crashing", async () => {
  const h = makeHarness();
  const code = await run(h, ["--bogus"]);
  expect(code).toBe(2);
  expect(h.calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Bounds → the config threaded to the entry
// ---------------------------------------------------------------------------

test("--for parses to durationMs; --max-frames to a count", async () => {
  const h = makeHarness();
  await run(h, ["--for", "2s", "--max-frames", "7"]);
  const cfg = h.calls[0]?.config;
  expect(cfg?.durationMs).toBe(2_000);
  expect(cfg?.maxFrames).toBe(7);
});

test("neither bound nor --follow applies the default duration (bounded by default)", async () => {
  const h = makeHarness();
  await run(h, []);
  const cfg = h.calls[0]?.config;
  expect(cfg?.durationMs).toBe(30_000);
  expect(cfg?.maxFrames).toBeNull();
});

test("--max-frames alone still gets the default duration as a wall-clock floor (an idle board terminates)", async () => {
  const h = makeHarness();
  await run(h, ["--max-frames", "20"]);
  const cfg = h.calls[0]?.config;
  expect(cfg?.maxFrames).toBe(20);
  // Without this floor durationMs would stay null and an idle stream that
  // never reaches 20 data frames would hang until SIGINT.
  expect(cfg?.durationMs).toBe(30_000);
});

test("--follow leaves both bounds null (reconnect-forever, no default duration)", async () => {
  const h = makeHarness();
  await run(h, ["--follow"]);
  const cfg = h.calls[0]?.config;
  expect(cfg?.durationMs).toBeNull();
  expect(cfg?.maxFrames).toBeNull();
});

// ---------------------------------------------------------------------------
// --prev-frame + --project-dir threading
// ---------------------------------------------------------------------------

test("--prev-frame reads the file and threads its text to the entry", async () => {
  const h = makeHarness();
  h.files.set("/tmp/prev.txt", "line a\nline b");
  await run(h, ["--prev-frame", "/tmp/prev.txt"]);
  expect(h.calls[0]?.config.prevFrameText).toBe("line a\nline b");
});

test("an unreadable --prev-frame path is a usage fault (exit 2)", async () => {
  const h = makeHarness();
  const code = await run(h, ["--prev-frame", "/tmp/missing.txt"]);
  expect(code).toBe(2);
  expect(h.calls).toHaveLength(0);
  expect(h.stderr.join("")).toContain("--prev-frame");
});

test("--project-dir is threaded to the git entry", async () => {
  const h = makeHarness();
  await run(h, [
    "--view",
    "git",
    "--project-dir",
    "/repo/x",
    "--max-frames",
    "1",
  ]);
  expect(h.calls[0]?.config.projectDir).toBe("/repo/x");
});

// ---------------------------------------------------------------------------
// --help / --agent-help render + exit 0, no dispatch
// ---------------------------------------------------------------------------

test("--help prints usage, exits 0, dispatches nothing", async () => {
  const h = makeHarness();
  const code = await run(h, ["--help"]);
  expect(code).toBe(0);
  expect(h.calls).toHaveLength(0);
  expect(h.stdout.join("")).toContain("keeper frames");
});

test("--agent-help renders the consumption runbook, exits 0", async () => {
  const h = makeHarness();
  const code = await run(h, ["--agent-help"]);
  expect(code).toBe(0);
  const out = h.stdout.join("");
  // The runbook documents the envelope, the trailer, the cursor, and the
  // one-process-per-view rule.
  expect(out).toContain("THE ENVELOPE");
  expect(out).toContain("THE TRAILER");
  expect(out).toContain("resume_cursor");
  expect(out).toContain("ONE PROCESS PER VIEW");
});

// ---------------------------------------------------------------------------
// Descriptor presence in the machine help index
// ---------------------------------------------------------------------------

test("keeper frames appears in the --help --json index with its agent-help + exit codes", () => {
  const index = buildHelpIndex();
  const frames = index.subcommands.find((s) => s.name === "frames");
  expect(frames).toBeDefined();
  expect(frames?.agent_help).toBe(true);
  expect(frames?.requires_daemon).toBe(true);
  expect(frames?.mutates).toBe(false);
  // The frames-specific exit-code meanings are published on the node.
  expect(frames?.exit_codes?.["0"]?.length ?? 0).toBeGreaterThan(0);
  expect(frames?.exit_codes?.["1"]?.length ?? 0).toBeGreaterThan(0);
  // The --view flag and the bound flags are declared.
  const flagNames = (frames?.flags ?? []).map((f) => f.name);
  expect(flagNames).toContain("view");
  expect(flagNames).toContain("for");
  expect(flagNames).toContain("max-frames");
  expect(flagNames).toContain("follow");
});

// ---------------------------------------------------------------------------
// Exit-code mapping (shell-owned): trailer-emitted → 0, never-reachable → 1
// ---------------------------------------------------------------------------

/** Build a frames-mode view-shell wired to a capturing emitter + a throwing
 *  exit, so the terminal exit code of `finishFrames` is observable. */
function makeFramesRun(): {
  view: ReturnType<typeof createViewShell<{ body: string[] }>>;
  proc: ViewerExitProc & { fire: (sig: string) => void };
  exits: number[];
} {
  const exits: number[] = [];
  const handlers = new Map<string, () => void>();
  const proc = {
    on: (event: string, cb: () => void) => {
      handlers.set(event, cb);
    },
    ppid: 4242,
    stdin: {
      on: () => {},
      removeListener: () => {},
      resume: () => {},
      isTTY: false,
    },
    fire: (sig: string) => handlers.get(sig)?.(),
  } as unknown as ViewerExitProc & { fire: (sig: string) => void };

  const runIo: FramesRunIo = {
    exit: ((code: number) => {
      exits.push(code);
      throw new ExitError(code);
    }) as (code: number) => never,
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    proc,
  };
  const emitter = createFramesEmitter({
    view: "board",
    writeStdout: () => {},
    diffFn: () => "@@ d @@\n",
    io: {
      writeFile: () => {},
      unlink: () => {},
      nowIso: () => "2026-07-07T00:00:00.000Z",
      nowMs: () => 0,
    },
  });
  const view = createViewShell<{ body: string[] }>({
    script: "frames-test",
    renderBody: (s) => ({ bodyLines: s.body, stateJson: {} }),
    mode: "frames",
    frames: { emitter, io: runIo },
  });
  return { view, proc, exits };
}

test("exit 0: an interrupt after a rendered baseline is a reachable trailer-emitted run", () => {
  const { view, proc, exits } = makeFramesRun();
  // A rendered frame means the daemon was reached — an idle chunk still emits
  // its baseline before the trailer.
  view.emit({ body: ["a"] });
  view.runFrames(() => {});
  expect(() => proc.fire("SIGINT")).toThrow("__EXIT_0__");
  expect(exits).toEqual([0]);
});

test("exit 1: a run that ended having never rendered a frame never reached the daemon", () => {
  const { view, proc, exits } = makeFramesRun();
  // No `emit` — the daemon was never reachable. The trailer still flushes, but
  // the exit code is 1 (mirrors snapshot's daemon-unreachable precedent).
  view.runFrames(() => {});
  expect(() => proc.fire("SIGINT")).toThrow("__EXIT_1__");
  expect(exits).toEqual([1]);
});
