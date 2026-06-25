/**
 * Slow-tier integration test for the tmux control-mode focus worker (epic
 * fn-952). Exercises a REAL `tmux -C` control client against a THROWAWAY `-L`
 * server (never the developer's live tmux), proving the end-to-end chain the
 * worker relies on: attach with the no-output-once `-f` flags → frame
 * `list-clients` / `list-panes -a` replies by command number → derive focus.
 *
 * Named `*.slow.test.ts` (excluded from the fast tier, allowlisted in
 * `scripts/test-real-git-allowlist.txt`); runs only under `bun run test:full`.
 * SKIPS cleanly when no `tmux` binary is present (CI without tmux).
 *
 * Poll with `retryUntil`, never a fixed `Bun.sleep` on the control stream.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { LineBuffer } from "../src/protocol";
import { parseControlStream } from "../src/tmux-control-parser";
import {
  buildAttachArgs,
  deriveFocus,
  LIST_CLIENTS_FORMAT,
  LIST_PANES_FORMAT,
} from "../src/tmux-control-worker";
import { retryUntil } from "./helpers/retry-until";

/** A throwaway tmux server socket name (`-L`) unique per run so a parallel test
 *  or a stale server never collides. */
const SOCKET = `keeper-fn952-${randomBytes(6).toString("hex")}`;
/** The anchor session the control client parks on. */
const ANCHOR = "fn952main";

function tmuxAvailable(): boolean {
  try {
    const r = Bun.spawnSync(["tmux", "-V"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return r.success;
  } catch {
    return false;
  }
}

/** Run a one-shot `tmux -L <socket> …` command on the throwaway server. */
function tmux(args: string[]): { success: boolean; stdout: string } {
  const r = Bun.spawnSync(["tmux", "-L", SOCKET, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { success: r.success, stdout: r.stdout?.toString() ?? "" };
}

/** A piped control child with strongly-typed stdin/stdout — `Bun.spawn`'s union
 *  return type loses the `pipe` narrowing, so the helper asserts it. */
interface ControlChild {
  stdin: { write(s: string): void; flush?(): void };
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
}

/** Spawn the persistent `tmux -C` control client on the throwaway `-L` server,
 *  using the worker's exact `buildAttachArgs` argv with `-L <socket>` injected
 *  right after `tmux`. `TMUX=""` ensures the client never inherits the dev's
 *  default-server context. */
function spawnControlClient(): ControlChild {
  const [bin, ...rest] = buildAttachArgs(ANCHOR);
  const proc = Bun.spawn([bin, "-L", SOCKET, ...rest], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, TMUX: "" } as Record<string, string | undefined>,
  });
  return proc as unknown as ControlChild;
}

const HAVE_TMUX = tmuxAvailable();
const maybe = HAVE_TMUX ? describe : describe.skip;

maybe("tmux-control-worker — live `tmux -C` attach", () => {
  let control: ControlChild | null = null;

  beforeAll(() => {
    // A detached server with one session + an extra window so the topology is
    // non-trivial. `-d` keeps it server-side (no real client attached yet).
    tmux(["new-session", "-d", "-s", ANCHOR, "-x", "80", "-y", "24"]);
    tmux(["new-window", "-t", ANCHOR]);
  });

  afterAll(() => {
    try {
      control?.kill();
    } catch {
      // best-effort
    }
    // Tear down the throwaway server entirely.
    tmux(["kill-server"]);
  });

  test("attaches a control client and the framed reads derive the server-wide focus", async () => {
    // Spawn the persistent control client with the worker's exact attach argv,
    // injecting `-L <socket>` so it parks on the THROWAWAY server (never the
    // developer's default). `buildAttachArgs` carries the `-f no-output,…` flags
    // set once, never toggled.
    control = spawnControlClient();

    const child = control;
    const lineBuf = new LineBuffer();
    const decoder = new TextDecoder();
    // FIFO reply queue mirroring the worker: the unsolicited attach handshake
    // block is dropped (empty queue), and the first command is sent only after the
    // reader drains that first chunk — so a reply never mis-matches a resolver.
    const replyQueue: ((lines: string[]) => void)[] = [];
    let resolveFirstChunk: () => void = () => {};
    const firstChunk = new Promise<void>((r) => {
      resolveFirstChunk = r;
    });

    const reader = child.stdout.getReader();
    let stopped = false;
    const readerDone = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          const lines = lineBuf.push(decoder.decode(value, { stream: true }));
          if (lines.length === 0) continue;
          const events = parseControlStream(`${lines.join("\n")}\n`);
          for (const ev of events) {
            if (ev.kind === "reply") {
              const waiter = replyQueue.shift();
              if (waiter) waiter([...ev.lines]);
            }
          }
          resolveFirstChunk();
        }
      } catch {
        // Reader cancelled at teardown — expected.
      }
    })();

    const sendCommand = (text: string): Promise<string[]> =>
      new Promise<string[]>((resolve) => {
        replyQueue.push(resolve);
        child.stdin.write(`${text}\n`);
        child.stdin.flush?.();
      });

    // Bootstrap exactly like the worker: wait for the handshake chunk to drain,
    // then re-assert no-output + send the defensive copy-mode, awaited serially so
    // their reply blocks drain before the focus reads.
    await firstChunk;
    await sendCommand("refresh-client -f no-output");
    await sendCommand("copy-mode -q");

    const clientsBody = (
      await sendCommand(`list-clients -F '${LIST_CLIENTS_FORMAT}'`)
    ).join("\n");
    const panesBody = (
      await sendCommand(`list-panes -a -F '${LIST_PANES_FORMAT}'`)
    ).join("\n");

    // The control client is `client_control_mode=1` and is dropped by the
    // derivation; with no OTHER real client attached, focus derives to `none`.
    // That is the correct headless-server observation (0 real clients).
    const derivation = deriveFocus(clientsBody, panesBody);
    expect(derivation.status).toBe("none");

    // The framed reads MUST have produced parseable rows for the session's panes
    // even though no real client is attached — proving the `-F` format round-trips
    // through the real control stream into the task-1 parser.
    expect(panesBody).toContain(ANCHOR);

    // The control client survives an anchor-session-independent read: the server
    // is still alive and the stream is open.
    const pid = (await sendCommand("display-message -p '#{pid}'"))[0]?.trim();
    expect(pid).toMatch(/^\d+$/);

    stopped = true;
    child.kill();
    // Cancel the pending read (killing the child also EOFs the stream); swallow
    // the expected cancellation so teardown is clean.
    await reader.cancel().catch(() => {});
    await Promise.race([readerDone, Bun.sleep(1000)]);
  });

  test("a `%exit` is observed when the server is killed (reconnect trigger)", async () => {
    // Fresh control client.
    const child = spawnControlClient();
    const lineBuf = new LineBuffer();
    const decoder = new TextDecoder();
    let sawExitOrEof = false;
    const reader = child.stdout.getReader();
    const readerDone = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          sawExitOrEof = true;
          break;
        }
        const lines = lineBuf.push(decoder.decode(value, { stream: true }));
        const events = parseControlStream(`${lines.join("\n")}\n`);
        if (events.some((e) => e.kind === "exit")) {
          sawExitOrEof = true;
          break;
        }
      }
    })();

    // Give the client a moment to attach, then kill the server — the control
    // client must see `%exit` (or EOF) and the reader loop must end. Re-create a
    // server afterwards so afterAll's kill-server has something to tear down.
    await retryUntil(() => {
      // The server is alive while `list-sessions` succeeds.
      return tmux(["list-sessions"]).success ? true : null;
    }, 3000);
    tmux(["kill-server"]);

    const done = await retryUntil(() => (sawExitOrEof ? true : null), 5000);
    expect(done).toBe(true);

    await Promise.race([readerDone, Bun.sleep(1000)]);
    try {
      child.kill();
    } catch {
      // already gone
    }
    // Re-establish the throwaway server so afterAll teardown is a clean no-op.
    tmux(["new-session", "-d", "-s", ANCHOR, "-x", "80", "-y", "24"]);
  });
});
