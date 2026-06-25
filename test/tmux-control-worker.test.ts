/**
 * Fast-tier unit tests for the PURE seams of the tmux control-mode focus worker
 * (`src/tmux-control-worker.ts`). NO REAL TMUX — every test drives an exported
 * pure function with synthetic inputs:
 *  - `buildAttachArgs` — the `-N -C` attach argv + the `no-output`-once `-f` flags.
 *  - `pickAnchorSession` — keeper-managed-then-any anchor pick, gated on present.
 *  - `hasLiveTmuxJob` — the connect gate.
 *  - `focusDedupKey` — dedup EXCLUDING `client_activity`, re-keyed on generation.
 *  - `isStructuralNotification` — which verbs dirty the focus.
 *  - `decideReconnect` — the exponential-backoff + bounded-cap state machine.
 *  - `deriveFocus` — the golden-string glue over the task-1 parse + pick seams.
 *  - `decideTmuxControlWatchdog` (from daemon) — the mute-escalation verdict.
 *
 * The live `tmux -C` attach is exercised only in
 * `test/tmux-control-worker.slow.test.ts` (allowlisted).
 */

import { describe, expect, test } from "bun:test";
import { decideTmuxControlWatchdog } from "../src/daemon";
import {
  buildAttachArgs,
  type ControlChild,
  decideReconnect,
  deriveFocus,
  focusDedupKey,
  hasLiveTmuxJob,
  isStructuralNotification,
  pickAnchorSession,
  runConnection,
  type TmuxClientFocusSnapshotMessage,
} from "../src/tmux-control-worker";
import type { FocusDerivation } from "../src/tmux-focus-derive";
import type { Job } from "../src/types";
import { retryUntil } from "./helpers/retry-until";

function fakeJob(opts: {
  job_id?: string;
  state?: string;
  backend_exec_type?: string | null;
  backend_exec_session_id?: string | null;
}): Job {
  return {
    job_id: opts.job_id ?? "j1",
    created_at: 1000,
    state: opts.state ?? "working",
    backend_exec_type: opts.backend_exec_type ?? null,
    backend_exec_session_id: opts.backend_exec_session_id ?? null,
    backend_exec_pane_id: null,
  } as unknown as Job;
}

// ---------------------------------------------------------------------------
// buildAttachArgs
// ---------------------------------------------------------------------------

describe("buildAttachArgs", () => {
  test("emits -N (never start a server), -C (control mode), and the no-output-once -f flags", () => {
    expect(buildAttachArgs("main")).toEqual([
      "tmux",
      "-N",
      "-C",
      "attach-session",
      "-f",
      "no-output,ignore-size,no-detach-on-destroy",
      "-t",
      "main",
    ]);
  });

  test("the anchor rides as the -t target verbatim", () => {
    const args = buildAttachArgs("keeper-abc123");
    expect(args[args.length - 1]).toBe("keeper-abc123");
    expect(args[args.length - 2]).toBe("-t");
  });
});

// ---------------------------------------------------------------------------
// hasLiveTmuxJob — the connect gate
// ---------------------------------------------------------------------------

describe("hasLiveTmuxJob", () => {
  test("true when a working tmux job exists", () => {
    expect(
      hasLiveTmuxJob([
        fakeJob({ state: "working", backend_exec_type: "tmux" }),
      ]),
    ).toBe(true);
  });

  test("true for a stopped tmux job (still live for observation)", () => {
    expect(
      hasLiveTmuxJob([
        fakeJob({ state: "stopped", backend_exec_type: "tmux" }),
      ]),
    ).toBe(true);
  });

  test("false when the only tmux job has ended/killed", () => {
    expect(
      hasLiveTmuxJob([
        fakeJob({ state: "ended", backend_exec_type: "tmux" }),
        fakeJob({ state: "killed", backend_exec_type: "tmux" }),
      ]),
    ).toBe(false);
  });

  test("false for a live non-tmux backend", () => {
    expect(
      hasLiveTmuxJob([
        fakeJob({ state: "working", backend_exec_type: "headless" }),
      ]),
    ).toBe(false);
  });

  test("false on an empty board", () => {
    expect(hasLiveTmuxJob([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pickAnchorSession — keepalive parking spot pick
// ---------------------------------------------------------------------------

describe("pickAnchorSession", () => {
  test("prefers a keeper-managed tmux job's session that is present", () => {
    const jobs = [
      fakeJob({
        backend_exec_type: "tmux",
        backend_exec_session_id: "keeperX",
      }),
    ];
    expect(pickAnchorSession(jobs, new Set(["keeperX", "main"]))).toBe(
      "keeperX",
    );
  });

  test("skips a job session that is no longer present on the server", () => {
    const jobs = [
      fakeJob({ backend_exec_type: "tmux", backend_exec_session_id: "gone" }),
    ];
    // The job session vanished; fall back to a present session (lexical-least).
    expect(pickAnchorSession(jobs, new Set(["main", "alpha"]))).toBe("alpha");
  });

  test("falls back to the lexical-least present session when no job session matches", () => {
    expect(pickAnchorSession([], new Set(["main", "alpha", "zeta"]))).toBe(
      "alpha",
    );
  });

  test("ignores non-tmux / non-live jobs when picking the keeper-managed anchor", () => {
    const jobs = [
      fakeJob({
        state: "ended",
        backend_exec_type: "tmux",
        backend_exec_session_id: "dead",
      }),
      fakeJob({
        state: "working",
        backend_exec_type: "headless",
        backend_exec_session_id: "notmux",
      }),
    ];
    // Neither qualifies → fall back to the present set.
    expect(pickAnchorSession(jobs, new Set(["main"]))).toBe("main");
  });

  test("returns null when no session is available at all", () => {
    expect(pickAnchorSession([], new Set())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// focusDedupKey — excludes client_activity, re-keys on generation
// ---------------------------------------------------------------------------

describe("focusDedupKey", () => {
  const focused = (
    over: Partial<Extract<FocusDerivation, { status: "focused" }>> = {},
  ): FocusDerivation => ({
    status: "focused",
    session_name: "main",
    window_index: 2,
    pane_id: "%7",
    ...over,
  });

  test("identical location under the same generation yields the same key", () => {
    expect(focusDedupKey("gen-1", focused())).toBe(
      focusDedupKey("gen-1", focused()),
    );
  });

  test("a generation change re-keys even at the identical location", () => {
    expect(focusDedupKey("gen-1", focused())).not.toBe(
      focusDedupKey("gen-2", focused()),
    );
  });

  test("a pane change re-keys", () => {
    expect(focusDedupKey("gen-1", focused({ pane_id: "%7" }))).not.toBe(
      focusDedupKey("gen-1", focused({ pane_id: "%8" })),
    );
  });

  test("a window change re-keys", () => {
    expect(focusDedupKey("gen-1", focused({ window_index: 2 }))).not.toBe(
      focusDedupKey("gen-1", focused({ window_index: 3 })),
    );
  });

  test("a session change re-keys", () => {
    expect(focusDedupKey("gen-1", focused({ session_name: "a" }))).not.toBe(
      focusDedupKey("gen-1", focused({ session_name: "b" })),
    );
  });

  test("focused vs none under the same generation differ", () => {
    expect(focusDedupKey("gen-1", focused())).not.toBe(
      focusDedupKey("gen-1", { status: "none" }),
    );
  });

  test("none re-keys on a generation change too", () => {
    expect(focusDedupKey("gen-1", { status: "none" })).not.toBe(
      focusDedupKey("gen-2", { status: "none" }),
    );
  });
});

// ---------------------------------------------------------------------------
// isStructuralNotification
// ---------------------------------------------------------------------------

describe("isStructuralNotification", () => {
  test("focus-relevant verbs are structural", () => {
    for (const verb of [
      "session-window-changed",
      "window-pane-changed",
      "client-session-changed",
      "sessions-changed",
      "window-add",
      "window-close",
      "client-detached",
      "session-changed",
    ]) {
      expect(isStructuralNotification(verb)).toBe(true);
    }
  });

  test("non-structural verbs do not dirty focus", () => {
    for (const verb of [
      "output",
      "layout-change",
      "window-renamed",
      "subscription-changed",
      "unknown-verb",
    ]) {
      expect(isStructuralNotification(verb)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// decideReconnect — exponential backoff + bounded cap
// ---------------------------------------------------------------------------

describe("decideReconnect", () => {
  const cfg = { baseDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 8 };

  test("the first failure retries at the base delay", () => {
    expect(decideReconnect({ attempts: 0, ...cfg })).toEqual({
      action: "retry",
      delayMs: 500,
    });
  });

  test("the delay doubles per consecutive failure", () => {
    expect(decideReconnect({ attempts: 1, ...cfg }).action).toBe("retry");
    expect(
      (decideReconnect({ attempts: 1, ...cfg }) as { delayMs: number }).delayMs,
    ).toBe(1000);
    expect(
      (decideReconnect({ attempts: 3, ...cfg }) as { delayMs: number }).delayMs,
    ).toBe(4000);
  });

  test("the delay clamps to maxDelayMs", () => {
    // 500 · 2^7 = 64000 > 30000 → clamp.
    expect(
      (decideReconnect({ attempts: 7, ...cfg }) as { delayMs: number }).delayMs,
    ).toBe(30_000);
  });

  test("reaching the attempt cap escalates", () => {
    expect(decideReconnect({ attempts: 8, ...cfg })).toEqual({
      action: "escalate",
    });
    expect(decideReconnect({ attempts: 99, ...cfg })).toEqual({
      action: "escalate",
    });
  });

  test("a pathological huge attempt count clamps rather than overflowing", () => {
    // Below the cap but with a 2^attempts that would overflow to Infinity.
    const decision = decideReconnect({
      attempts: 5,
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 10_000,
    });
    expect(decision.action).toBe("retry");
    if (decision.action === "retry") {
      expect(decision.delayMs).toBeLessThanOrEqual(30_000);
    }
  });
});

// ---------------------------------------------------------------------------
// deriveFocus — golden-string glue over the task-1 seams
// ---------------------------------------------------------------------------

describe("deriveFocus", () => {
  test("derives the real client's active window's active pane", () => {
    // list-clients: name\tcontrolMode\tactivity\tcreated\tsession
    const clients = [
      "/dev/ttys001\t0\t120\t10\tmain", // a real client on 'main'
      "/dev/ttys999\t1\t130\t11\tmain", // keeper's own control client — dropped
    ].join("\n");
    // list-panes -a: windowActive\tpaneActive\twindowIndex\tpaneId\tsession
    const panes = [
      "1\t1\t3\t%42\tmain", // active window, active pane
      "1\t0\t3\t%41\tmain", // active window, inactive pane
      "0\t1\t1\t%10\tmain", // inactive window
    ].join("\n");
    expect(deriveFocus(clients, panes)).toEqual({
      status: "focused",
      session_name: "main",
      window_index: 3,
      pane_id: "%42",
    });
  });

  test("zero real clients (only the control client) derives none", () => {
    const clients = "/dev/ttys999\t1\t130\t11\tmain";
    const panes = "1\t1\t3\t%42\tmain";
    expect(deriveFocus(clients, panes)).toEqual({ status: "none" });
  });

  test("a client attached to no session derives none", () => {
    const clients = "/dev/ttys001\t0\t120\t10\t"; // empty session
    const panes = "1\t1\t3\t%42\tmain";
    expect(deriveFocus(clients, panes)).toEqual({ status: "none" });
  });

  test("empty reads derive none (the no-tmux / first-paint case)", () => {
    expect(deriveFocus("", "")).toEqual({ status: "none" });
  });

  test("most-recent activity wins across two real clients", () => {
    const clients = [
      "/dev/ttys001\t0\t100\t10\talpha",
      "/dev/ttys002\t0\t200\t10\tbeta", // higher activity → wins
    ].join("\n");
    const panes = [
      "1\t1\t0\t%1\talpha",
      "1\t1\t5\t%9\tbeta", // beta's active pane
    ].join("\n");
    expect(deriveFocus(clients, panes)).toEqual({
      status: "focused",
      session_name: "beta",
      window_index: 5,
      pane_id: "%9",
    });
  });
});

// ---------------------------------------------------------------------------
// decideTmuxControlWatchdog — mute escalation (lives in daemon.ts)
// ---------------------------------------------------------------------------

describe("decideTmuxControlWatchdog", () => {
  const threshold = 90_000;

  test("never trips before the first pulse (worker may be mid-attach)", () => {
    expect(
      decideTmuxControlWatchdog({
        lastLivenessAtMs: null,
        nowMs: 10_000_000,
        livenessThresholdMs: threshold,
      }),
    ).toBe("ok");
  });

  test("ok while the worker pulses within the threshold", () => {
    const now = 1_000_000;
    expect(
      decideTmuxControlWatchdog({
        lastLivenessAtMs: now - 30_000,
        nowMs: now,
        livenessThresholdMs: threshold,
      }),
    ).toBe("ok");
  });

  test("escalates once the pulse goes silent past the threshold", () => {
    const now = 1_000_000;
    expect(
      decideTmuxControlWatchdog({
        lastLivenessAtMs: now - 120_000,
        nowMs: now,
        livenessThresholdMs: threshold,
      }),
    ).toBe("escalate");
  });

  test("the boundary is inclusive (>= threshold escalates)", () => {
    const now = 1_000_000;
    expect(
      decideTmuxControlWatchdog({
        lastLivenessAtMs: now - threshold,
        nowMs: now,
        livenessThresholdMs: threshold,
      }),
    ).toBe("escalate");
  });
});

// ---------------------------------------------------------------------------
// runConnection — synthetic-child handshake drop + redirty re-read (fast tier)
//
// Drives the intricate dirty/redirty/handshake-drop state machine through the
// `ControlChild` injection seam with a SCRIPTED transcript and NO real `tmux -C`
// fork: a fake stdout `ReadableStream` we push chunks into, plus a stdin stub
// that records the worker's commands and triggers the matching reply chunks.
// This is the fast-tier coverage the seam was built to enable — it pins the
// fn-962 fix: the bootstrap is released only after the unsolicited attach
// handshake block has FULLY settled, even when its `%end` splits into a later
// read, so no reply is mis-correlated to the wrong command's resolver.
// ---------------------------------------------------------------------------

/** A scripted `ControlChild` over a manually-fed stdout stream. `pushStdout`
 *  enqueues a raw chunk (split a `%end` into a later push to simulate a read
 *  boundary); `onWrite` observes each stdin command the worker issues; `eof`
 *  ends the stream so `runConnection` returns. No real process. */
function makeScriptedChild(onWrite: (cmd: string) => void): {
  child: ControlChild;
  pushStdout: (chunk: string) => void;
  eof: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const pending: Uint8Array[] = [];
  const enc = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      // Flush anything pushed before the reader subscribed.
      for (const chunk of pending) c.enqueue(chunk);
      pending.length = 0;
    },
  });
  let exitResolve: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    exitResolve = r;
  });
  const pushStdout = (chunk: string): void => {
    const bytes = enc.encode(chunk);
    if (controller) controller.enqueue(bytes);
    else pending.push(bytes);
  };
  const eof = (): void => {
    try {
      controller?.close();
    } catch {
      // already closed
    }
    exitResolve(0);
  };
  const child: ControlChild = {
    stdout,
    stdin: {
      write(chunk: string) {
        // The worker writes `${text}\n`; hand the trimmed command to the script.
        onWrite(chunk.replace(/\n$/, ""));
      },
    },
    exited,
    kill() {
      eof();
    },
  };
  return { child, pushStdout, eof };
}

/** Frame a scripted reply block for command number `n` with the given body. */
function replyBlock(n: number, body: string[]): string {
  return [`%begin 0 ${n} 1`, ...body, `%end 0 ${n} 1`, ""].join("\n");
}

describe("runConnection — synthetic-child handshake drop + redirty re-read", () => {
  test("a handshake whose %end splits into a later read does not release the bootstrap early and never mis-correlates the first command reply", async () => {
    const posted: TmuxClientFocusSnapshotMessage[] = [];
    const commands: string[] = [];
    let stopping = false;

    // The real client on `main` window 3 pane %42; keeper's own control client
    // (controlMode=1) is dropped by the derivation. A non-trivial pane table so a
    // mis-correlated reply (handshake body leaking into a list-* slot) would visibly
    // derive the WRONG focus instead of this one.
    const clientsBody = [
      "/dev/ttys001\t0\t120\t10\tmain",
      "/dev/ttys999\t1\t130\t11\tmain",
    ];
    const panesBody = [
      "1\t1\t3\t%42\tmain",
      "1\t0\t3\t%41\tmain",
      "0\t1\t1\t%10\tmain",
    ];

    let cmdNum = 100;
    const child = (() => {
      const h = makeScriptedChild((cmd) => {
        commands.push(cmd);
        // Reply to each bootstrap/re-read command in FIFO order. The reply's
        // command number is internally consistent (begin/end match); FIFO order —
        // not the number — is what correlates it to the awaiting resolver.
        cmdNum += 1;
        if (cmd.startsWith("refresh-client")) {
          h.pushStdout(replyBlock(cmdNum, []));
        } else if (cmd.startsWith("copy-mode")) {
          h.pushStdout(replyBlock(cmdNum, []));
        } else if (cmd.startsWith("display-message")) {
          h.pushStdout(replyBlock(cmdNum, ["48271"])); // the server pid
        } else if (cmd.startsWith("list-clients")) {
          h.pushStdout(replyBlock(cmdNum, clientsBody));
        } else if (cmd.startsWith("list-panes")) {
          h.pushStdout(replyBlock(cmdNum, panesBody));
        }
      });
      return h;
    })();

    const conn = runConnection(child.child, {
      isStopping: () => stopping,
      postFocus: (m) => posted.push(m),
      postLiveness: () => {},
    });

    // Emit the unsolicited attach handshake block with its `%end` SPLIT across two
    // reads: the `%begin` + body land first; NO command must be sent yet (the
    // bootstrap must still be blocked on the unsettled handshake).
    child.pushStdout(`%begin 0 0 1\n`);
    child.pushStdout(`%session-changed $1 main\n`); // body inside the open block
    // The handshake is still open — assert the bootstrap has NOT been released.
    await Bun.sleep(20);
    expect(commands.length).toBe(0);

    // The handshake's `%end` arrives in a LATER read — only now does the
    // connection-scoped parser complete the handshake reply, drop it (empty queue),
    // and release the bootstrap to send its first command.
    child.pushStdout(`%end 0 0 1\n`);

    // The framed focus read must derive the CORRECT focus — a mis-correlation
    // (the handshake body matching the refresh-client resolver) would shift every
    // later reply by one and derive a wrong/none focus.
    const got = await retryUntil(
      () => (posted.length > 0 ? posted[posted.length - 1] : null),
      5000,
    );
    expect(got).toEqual({
      kind: "tmux-client-focus-snapshot",
      status: "connected",
      generation_id: "48271",
      session_name: "main",
      window_index: 3,
      pane_id: "%42",
    });

    // The bootstrap + first re-read issued exactly these commands in order — the
    // handshake never consumed a resolver slot.
    expect(commands).toEqual([
      "refresh-client -f no-output",
      "copy-mode -q",
      "display-message -p '#{pid}'",
      "list-clients -F '#{client_name}\t#{client_control_mode}\t#{client_activity}\t#{client_created}\t#{client_session}'",
      "list-panes -a -F '#{window_active}\t#{pane_active}\t#{window_index}\t#{pane_id}\t#{session_name}'",
    ]);

    stopping = true;
    child.eof();
    expect(await conn).toBe(true);
  });

  test("a structural notification arriving mid-re-read re-arms exactly one more re-read", async () => {
    const posted: TmuxClientFocusSnapshotMessage[] = [];
    const commands: string[] = [];
    let stopping = false;

    // Two distinct focus states so the redirty re-read produces a SECOND, different
    // post (window 3 → window 5). The first re-read reads state A; a structural
    // notification lands while it is in flight; the re-arm reads state B.
    const clientsBody = ["/dev/ttys001\t0\t120\t10\tmain"];
    const panesA = ["1\t1\t3\t%42\tmain"];
    const panesB = ["1\t1\t5\t%99\tmain"];

    let readCount = 0;
    let cmdNum = 200;
    const child = (() => {
      const h = makeScriptedChild((cmd) => {
        commands.push(cmd);
        cmdNum += 1;
        if (cmd.startsWith("refresh-client") || cmd.startsWith("copy-mode")) {
          h.pushStdout(replyBlock(cmdNum, []));
        } else if (cmd.startsWith("display-message")) {
          h.pushStdout(replyBlock(cmdNum, ["77"]));
        } else if (cmd.startsWith("list-clients")) {
          h.pushStdout(replyBlock(cmdNum, clientsBody));
        } else if (cmd.startsWith("list-panes")) {
          readCount += 1;
          if (readCount === 1) {
            // While the FIRST re-read's panes reply is being consumed, inject a
            // structural notification — it must re-arm exactly one more re-read.
            h.pushStdout(replyBlock(cmdNum, panesA));
            h.pushStdout(`%window-pane-changed @4 %99\n`);
          } else {
            h.pushStdout(replyBlock(cmdNum, panesB));
          }
        }
      });
      return h;
    })();

    const conn = runConnection(child.child, {
      isStopping: () => stopping,
      postFocus: (m) => posted.push(m),
      postLiveness: () => {},
    });

    // Settle the handshake (begin+end in one read this time) → bootstrap releases.
    child.pushStdout(`%begin 0 0 1\n%session-changed $1 main\n%end 0 0 1\n`);

    // Expect exactly TWO posts: state A then the re-armed state B.
    const second = await retryUntil(
      () => (posted.length >= 2 ? posted[1] : null),
      5000,
    );
    expect(second).toEqual({
      kind: "tmux-client-focus-snapshot",
      status: "connected",
      generation_id: "77",
      session_name: "main",
      window_index: 5,
      pane_id: "%99",
    });
    expect(posted[0]).toEqual({
      kind: "tmux-client-focus-snapshot",
      status: "connected",
      generation_id: "77",
      session_name: "main",
      window_index: 3,
      pane_id: "%42",
    });

    // Exactly two framed reads ran (the redirty re-armed ONCE, not a loop): the
    // generation is read once, then list-clients/list-panes per re-read.
    const paneReads = commands.filter((c) => c.startsWith("list-panes")).length;
    expect(paneReads).toBe(2);
    // No third re-read piles up after the re-arm drains.
    await Bun.sleep(150);
    expect(commands.filter((c) => c.startsWith("list-panes")).length).toBe(2);

    stopping = true;
    child.eof();
    expect(await conn).toBe(true);
  });
});
