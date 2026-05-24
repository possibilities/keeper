#!/usr/bin/env bun
/**
 * keeper-autopilot — live command list over the keeper subscribe server.
 * Renders a flat ordered list of shell commands for each task and epic in
 * the same traversal order as `scripts/board.ts`'s epic rendering.
 *
 * For each epic, in order:
 *
 *   cd <target_repo> && claude '/plan:work <task_id>'
 *   bun ~/code/keeper/scripts/approve.ts <task_id>
 *   ...                                               (one pair per task)
 *   cd <project_dir> && claude '/plan:close <epic_id>'
 *   bun ~/code/keeper/scripts/approve.ts <epic_id>
 *
 * Epics are separated by a blank line. Each frame is led by `---`.
 * A new frame prints only when the rendered output changes.
 *
 * Uses only the `epics` collection (tasks are embedded in each epic row),
 * so first-paint waits only for the first epics `result` to land — no
 * dual-collection readiness gate like `scripts/board.ts`.
 *
 * `task.target_repo` is used as the `cd` path for worker commands; falls
 * back to `epic.project_dir` when `target_repo` is null.
 *
 * Connection / poll / sidecar / SIGINT semantics mirror `scripts/board.ts`:
 * capped-backoff connect+retry, post-disconnect reconnect, one `...`-fenced
 * lifecycle note per transition, THREE sidecar files (state JSON + frame text
 * + per-frame unified diff against the previous emit) overwritten each frame.
 * In `--clear` mode each frame's sidecars are indexed so past frames persist,
 * and a session meta file at `/tmp/keeper-autopilot.<pid>.meta.txt`
 * accumulates the full index (tab-separated: frame# state frame diff).
 * SIGINT sends a bare `unsubscribe` (no id) which drops the subscription,
 * then exits.
 *
 * Usage:
 *   bun scripts/autopilot.ts [--sock <path>] [--clear]
 *
 *   --sock <path>    Socket path override (else $KEEPER_SOCK, else the
 *                    ~/.local/state/keeper/keeperd.sock default).
 *   --clear          Clear the terminal before each frame (live-panel mode).
 *   --help           Show this help.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  encodeFrame,
  LineBuffer,
  type QueryFrame,
  type ServerFrame,
} from "../src/protocol";

/**
 * Epics fetches the whole default-scope set (`limit: 0`) — same as
 * `scripts/board.ts` and `scripts/epics.ts`. The default scope is already
 * small (open + not-yet-approved), so unlimited is fine.
 */
const EPICS_PAGE_LIMIT = 0;

/**
 * Poll cadence (ms) — same as the sibling scripts.
 */
const POLL_MS = 500;

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;

const HELP = `keeper-autopilot — live command list over the keeper subscribe server

Usage: bun scripts/autopilot.ts [--sock <path>] [--clear]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --clear          Clear the terminal before each frame (live-panel mode).
                   Each frame's sidecars are written to indexed paths
                   instead of overwriting, and a session meta file at
                   /tmp/keeper-autopilot.<pid>.meta.txt accumulates the full
                   index (tab-separated: frame# state frame diff).
  --help           Show this help

For each open epic, in the same order as scripts/board.ts, renders a flat
command list — two lines per task (work + approve) then two lines for the
virtual close row (close + approve):

  cd <target_repo> && claude '/plan:work <task_id>'
  bun ~/code/keeper/scripts/approve.ts <task_id>
  ...
  cd <project_dir> && claude '/plan:close <epic_id>'
  bun ~/code/keeper/scripts/approve.ts <epic_id>

Epics are separated by a blank line. Each frame is led by '---'. A new
frame prints only when the rendered output changes.

task.target_repo is used as the cd path for worker commands; falls back to
epic.project_dir when target_repo is null.

The client waits for keeperd to come up and reconnects across restarts
instead of exiting; each connection-lifecycle change prints a ...-fenced
note. Every emitted frame is mirrored to three /tmp sidecar files (JSON
state, frame text, unified diff vs. the previous emit). Ctrl-C exits cleanly.
`;

const seg = (v: unknown) => (v == null ? "" : String(v));

/**
 * Per-collection page + coalescing state — mirrors `CollectionState` in
 * `scripts/board.ts`. Only the `epics` collection is used here (tasks are
 * embedded in each epic row), so there is exactly one instance.
 */
interface CollectionState {
  readonly collection: string;
  readonly subId: string;
  readonly pk: string;
  readonly query: QueryFrame;
  order: string[];
  byId: Map<string, Record<string, unknown>>;
  gotResult: boolean;
  queryInFlight: boolean;
  refetchDirty: boolean;
}

function makeState(
  collection: string,
  subId: string,
  pk: string,
  limit: number,
): CollectionState {
  return {
    collection,
    subId,
    pk,
    query: { type: "query", collection, id: subId, limit },
    order: [],
    byId: new Map(),
    gotResult: false,
    queryInFlight: false,
    refetchDirty: false,
  };
}

function die(message: string): never {
  process.stderr.write(`keeper-autopilot: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      clear: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = values.sock ?? resolveSockPath();
  const log = (s: string) => process.stdout.write(`${s}\n`);
  const clearMode = values.clear;
  let frameCount = 0;

  const epics = makeState(
    "epics",
    "autopilot-epics",
    "epic_id",
    EPICS_PAGE_LIMIT,
  );
  const states: CollectionState[] = [epics];
  const byCollection = new Map(states.map((s) => [s.collection, s]));

  // Byte-compare the combined body — internal row churn that doesn't surface
  // in the render is invisible by design (same contract as the sibling scripts).
  let lastBody: string | null = null;

  type Sock = Awaited<ReturnType<typeof Bun.connect>>;
  let currentSock: Sock | null = null;
  let attempt = 0;
  let shuttingDown = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // --- command rendering ---

  /**
   * Render the command block for a single epic: two lines per task (work +
   * approve), then two lines for the virtual close row (close + approve).
   *
   * `task.target_repo` is the cd path for worker commands (the task may
   * live in a different repo than its epic). Falls back to `epic.project_dir`
   * when `target_repo` is null or empty — same fallback used by the plan
   * worker when seeding tasks.
   */
  function renderEpicCommands(row: Record<string, unknown>): string {
    const projectDir = seg(row.project_dir);
    const epicId = seg(row[epics.pk]);
    const tasks = Array.isArray(row.tasks) ? row.tasks : [];
    const lines: string[] = [];

    for (const task of tasks) {
      const t = task as Record<string, unknown>;
      const taskId = seg(t.task_id);
      const dir =
        t.target_repo != null && seg(t.target_repo) !== ""
          ? seg(t.target_repo)
          : projectDir;
      const cdPrefix = dir === "" ? "" : `cd ${dir} && `;
      lines.push(
        `${cdPrefix}claude '/plan:work ${taskId}'`,
        `bun ~/code/keeper/scripts/approve.ts ${taskId}`,
      );
    }

    // Virtual close row — always appended, mirrors board.ts.
    const cdPrefix = projectDir === "" ? "" : `cd ${projectDir} && `;
    lines.push(
      `${cdPrefix}claude '/plan:close ${epicId}'`,
      `bun ~/code/keeper/scripts/approve.ts ${epicId}`,
    );

    return lines.join("\n");
  }

  /**
   * Full frame body: one epic command block per epic in server order, joined
   * by a blank line. An empty epics set yields `""` — the frame is just the
   * `---` lead.
   */
  function renderBody(): string {
    if (epics.order.length === 0) {
      return "";
    }
    return epics.order
      .map((id) =>
        renderEpicCommands(epics.byId.get(id) ?? { [epics.pk]: id }),
      )
      .join("\n\n");
  }

  // --- sidecar paths ---

  const stateSidecar = `/tmp/keeper-autopilot.${process.pid}.state.json`;
  const frameSidecar = `/tmp/keeper-autopilot.${process.pid}.frame.txt`;
  const diffSidecar = `/tmp/keeper-autopilot.${process.pid}.diff.txt`;
  // Internal scratch path for the previous frame text — fed to `diff -u`.
  const prevFrameTmp = `/tmp/keeper-autopilot.${process.pid}.prev.frame.txt`;
  // Session-level meta file: one tab-separated line per frame. Only written
  // in `--clear` mode; accumulates across the session.
  const metaSidecar = `/tmp/keeper-autopilot.${process.pid}.meta.txt`;
  // In-memory copy of the last emitted frame text (for the diff).
  let lastFrameText: string | null = null;

  function writeSidecars(frameText: string): void {
    // In --clear mode each frame's sidecars are indexed so past frames persist.
    const sState = clearMode
      ? `/tmp/keeper-autopilot.${process.pid}.state.${frameCount}.json`
      : stateSidecar;
    const sFrame = clearMode
      ? `/tmp/keeper-autopilot.${process.pid}.frame.${frameCount}.txt`
      : frameSidecar;
    const sDiff = clearMode
      ? `/tmp/keeper-autopilot.${process.pid}.diff.${frameCount}.txt`
      : diffSidecar;

    const stateJson = {
      epics: epics.order.map((id) => epics.byId.get(id) ?? { [epics.pk]: id }),
    };
    try {
      writeFileSync(sState, `${JSON.stringify(stateJson, null, 2)}\n`);
      writeFileSync(sFrame, `${frameText}\n`);
    } catch (err) {
      log(`# warn: sidecar write failed: ${(err as Error).message}`);
    }

    // Per-frame unified diff against the previous emit.
    let diffText: string;
    if (lastFrameText == null) {
      diffText = "# first frame — no previous to diff against\n";
    } else {
      try {
        writeFileSync(prevFrameTmp, `${lastFrameText}\n`);
        const proc = Bun.spawnSync({
          cmd: ["diff", "-u", prevFrameTmp, sFrame],
        });
        diffText = proc.stdout.toString();
        if (diffText.length === 0) {
          diffText = "# diff: no textual difference\n";
        }
      } catch (err) {
        diffText = `# diff failed: ${(err as Error).message}\n`;
      }
    }
    try {
      writeFileSync(sDiff, diffText);
    } catch (err) {
      log(`# warn: diff sidecar write failed: ${(err as Error).message}`);
    }
    if (clearMode) {
      try {
        appendFileSync(
          metaSidecar,
          `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
        );
      } catch (err) {
        log(`# warn: meta write failed: ${(err as Error).message}`);
      }
    }
    lastFrameText = frameText;
    log("...");
    log(`state: ${sState}`);
    log(`frame: ${sFrame}`);
    log(`diff: ${sDiff}`);
    if (clearMode) {
      log(`meta: ${metaSidecar}`);
    }
    log("...");
  }

  /**
   * Emit a frame iff (a) the epics collection has landed its first result
   * and (b) the rendered body changed since the last emit. Single-collection
   * variant of board.ts's `emitFrameIfChanged`.
   */
  function emitFrameIfChanged(): void {
    if (!epics.gotResult) {
      return;
    }
    const body = renderBody();
    if (body === lastBody) {
      return;
    }
    lastBody = body;
    frameCount += 1;
    if (clearMode) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
    const frameText = `---\n${body}`;
    log(frameText);
    writeSidecars(frameText);
  }

  /**
   * Re-issue one collection's page query, coalesced. Mirrors
   * `scheduleRefetchFor` in `scripts/board.ts`.
   */
  function scheduleRefetchFor(state: CollectionState): void {
    if (!currentSock) {
      return;
    }
    if (state.queryInFlight) {
      state.refetchDirty = true;
      return;
    }
    state.queryInFlight = true;
    currentSock.write(encodeFrame(state.query));
  }

  /** Steady-poll backstop — all collections, every tick. */
  function pollAll(): void {
    for (const s of states) {
      scheduleRefetchFor(s);
    }
  }

  function emitLifecycle(
    event: string,
    detail: Record<string, unknown> = {},
  ): void {
    log("...");
    log(`event: ${event}`);
    for (const [k, v] of Object.entries(detail)) {
      log(`${k}: ${String(v)}`);
    }
    log("...");
  }

  function handleFrame(frame: ServerFrame): void {
    if (frame.type === "result") {
      const state = byCollection.get(frame.collection);
      if (!state) {
        return;
      }
      state.queryInFlight = false;
      state.order.length = 0;
      state.byId.clear();
      for (const row of frame.rows) {
        const id = String(row[state.pk]);
        state.order.push(id);
        state.byId.set(id, row);
      }
      state.gotResult = true;
      emitFrameIfChanged();
      if (state.refetchDirty) {
        state.refetchDirty = false;
        scheduleRefetchFor(state);
      }
    } else if (frame.type === "patch" || frame.type === "meta") {
      const state = byCollection.get(frame.collection);
      if (state) {
        scheduleRefetchFor(state);
      }
    } else if (frame.type === "error") {
      log(`# error ${frame.code} (rev ${frame.rev}): ${frame.message}`);
      // Terminal only if no result has ever landed; otherwise transient.
      if (!epics.gotResult) {
        shuttingDown = true;
        currentSock?.end();
        process.exit(1);
      }
    }
  }

  function teardownConnection(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    currentSock = null;
    for (const s of states) {
      s.order.length = 0;
      s.byId.clear();
      s.queryInFlight = false;
      s.refetchDirty = false;
    }
    lastBody = null;
  }

  async function connectOnce(): Promise<void> {
    const buffer = new LineBuffer();
    await Bun.connect({
      unix: sockPath,
      socket: {
        open(sock) {
          attempt = 0;
          currentSock = sock;
          emitLifecycle("connected", { sock: sockPath });
          for (const s of states) {
            s.queryInFlight = true;
            sock.write(encodeFrame(s.query));
          }
          pollTimer = setInterval(pollAll, POLL_MS);
        },
        data(_sock, chunk) {
          let lines: string[];
          try {
            lines = buffer.push(chunk.toString("utf8"));
          } catch (err) {
            die(`protocol error: ${(err as Error).message}`);
          }
          for (const line of lines) {
            if (line.trim().length === 0) {
              continue;
            }
            handleFrame(JSON.parse(line) as ServerFrame);
          }
        },
        close() {
          if (shuttingDown) {
            return;
          }
          teardownConnection();
          emitLifecycle("disconnected", {});
          void connectWithRetry();
        },
        error(_sock, err) {
          emitLifecycle("error", { message: err.message });
        },
      },
    });
  }

  async function connectWithRetry(): Promise<void> {
    emitLifecycle("connecting", { sock: sockPath });
    while (!shuttingDown) {
      try {
        await connectOnce();
        return;
      } catch (err) {
        attempt += 1;
        const delay = Math.min(
          INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
          MAX_BACKOFF_MS,
        );
        emitLifecycle("waiting", {
          attempt,
          retry_in_ms: delay,
          reason: (err as Error).message,
        });
        await Bun.sleep(delay);
      }
    }
  }

  process.on("SIGINT", () => {
    shuttingDown = true;
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    try {
      // No `id` → drop every subscription on this connection in one frame.
      currentSock?.write(encodeFrame({ type: "unsubscribe" }));
      currentSock?.end();
    } catch {
      // socket already gone — nothing to release
    }
    process.exit(0);
  });

  await connectWithRetry();
}

await main();
