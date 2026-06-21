/**
 * Full-tier integration test for the Agent Bus worker (epic fn-875 task .2) —
 * the keystone end-to-end proof that the relay runs as a real Bun Worker over a
 * real UDS socket. Boots the worker DIRECTLY (a real `new Worker` with sandboxed
 * `workerData` paths — its own bus.db + bus.sock + a migrated read-only keeper.db
 * under a per-test tmpdir), then connects raw UDS clients and asserts:
 *
 *  - register → subscribe → publish fan-out lands on the directed peer (and the
 *    subscribe ack carries the `last_message_id` replay cursor),
 *  - broadcast reaches all live subscribers except the sender,
 *  - a FORMER name (keeper.db `jobs.name_history`) resolves to the agent's
 *    CURRENT live channel — the dead-name proof,
 *  - the server OVERWRITES the sender-claimed `from` with the peer-resolved
 *    identity (anti-spoof),
 *  - the socket is mode 0600,
 *  - shutdown releases the socket + lock.
 *
 * This file lands in the FULL tier (`bun run test:full`). Mandatory before
 * landing. Uses `retryUntil` (never a fixed sleep).
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as busMain } from "../cli/bus";
import type { BusWorkerData } from "../src/bus-worker";
import { retryUntil } from "./helpers/retry-until";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;
let busDbPath: string;
let sockPath: string;
let worker: Worker | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-bus-int-"));
  dbPath = join(tmpDir, "keeper.db");
  busDbPath = join(tmpDir, "bus.db");
  // Short leaf under the short mkdtemp prefix keeps `sun_path` under macOS's
  // ~104-byte cap.
  sockPath = join(tmpDir, "bus.sock");
  // The bus worker opens keeper.db READ-ONLY; a reader open does NOT migrate, so
  // the migrated schema must live on DISK first. `freshDbFile` writes the
  // pre-migrated template image.
  const seeded: Database = freshDbFile(dbPath).db;
  // Seed a keeper job whose name_history carries a FORMER name — the dead-name
  // resolution proof. `job_id` is what the bob client will register as its
  // session_id, so the resolver maps the former name → this identity → bob's
  // live channel (session_id match). pid/start are distinct from the test pid so
  // peer-pid enrichment MISSES (the clients fall back to their register-frame
  // identity), keeping the two same-process clients distinct.
  seeded
    .query(
      `INSERT INTO jobs (job_id, created_at, updated_at, state, pid, start_time, title, name_history)
       VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?)`,
    )
    .run(
      "sess-bob",
      1,
      10,
      999001,
      "t-bob-job",
      "bob",
      JSON.stringify(["bob-old", "bob"]),
    );
  seeded.close();
});

afterEach(async () => {
  if (worker) {
    worker.postMessage({ type: "shutdown" });
    // Give the worker a beat to release the socket + lock + exit.
    await retryUntil(() => (existsSync(sockPath) ? null : true), 2000, 25);
    try {
      worker.terminate();
    } catch {
      // best-effort
    }
    worker = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Spawn the bus worker as a real Worker with sandboxed paths; wait for bind. */
async function bootBus(): Promise<void> {
  worker = new Worker(new URL("../src/bus-worker.ts", import.meta.url).href, {
    workerData: { dbPath, busDbPath, sockPath } satisfies BusWorkerData,
  } as WorkerOptions & { workerData: unknown });
  const bound = await retryUntil(
    () => (existsSync(sockPath) ? true : null),
    3000,
    25,
  );
  expect(bound).toBe(true);
}

/** A raw UDS bus client: de-frames NDJSON into a polled `frames` sink. */
async function connectClient(): Promise<{
  socket: import("bun").Socket<undefined>;
  frames: Record<string, unknown>[];
  send(frame: object): void;
}> {
  const frames: Record<string, unknown>[] = [];
  let remainder = "";
  const socket = await Bun.connect({
    unix: sockPath,
    socket: {
      data(_s, chunk) {
        remainder += chunk.toString("utf8");
        let nl = remainder.indexOf("\n");
        while (nl !== -1) {
          const line = remainder.slice(0, nl).trim();
          remainder = remainder.slice(nl + 1);
          if (line.length > 0) frames.push(JSON.parse(line));
          nl = remainder.indexOf("\n");
        }
      },
    },
  });
  return {
    socket,
    frames,
    send(frame: object): void {
      socket.write(`${JSON.stringify(frame)}\n`);
    },
  };
}

/** Poll a client's frame sink for the first frame matching `pred`. */
async function waitFrame(
  frames: Record<string, unknown>[],
  pred: (f: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown> | null> {
  return retryUntil(() => frames.find(pred) ?? null, timeoutMs, 25);
}

test("two live agents exchange a directed message end-to-end; the subscribe ack carries the replay cursor", async () => {
  await bootBus();
  const alice = await connectClient();
  const bob = await connectClient();

  alice.send({
    op: "register",
    namespace: "chat",
    name: "alice",
    session_id: "sess-alice",
    start_time: "t-alice",
  });
  bob.send({
    op: "register",
    namespace: "chat",
    name: "bob",
    session_id: "sess-bob",
    start_time: "t-bob",
  });
  const aliceReg = await waitFrame(
    alice.frames,
    (f) => f.type === "ack" && f.op === "register",
  );
  const bobReg = await waitFrame(
    bob.frames,
    (f) => f.type === "ack" && f.op === "register",
  );
  expect(aliceReg).not.toBeNull();
  expect(bobReg).not.toBeNull();

  alice.send({ op: "subscribe", namespaces: ["chat"] });
  bob.send({ op: "subscribe", namespaces: ["chat"] });
  const bobSub = await waitFrame(
    bob.frames,
    (f) => f.type === "ack" && f.op === "subscribe",
  );
  expect(bobSub).not.toBeNull();
  // The subscribe ack carries the monotonic replay cursor.
  expect(typeof bobSub?.last_message_id).toBe("number");

  // Alice → bob (by current name).
  alice.send({
    op: "publish",
    event: "send",
    namespace: "chat",
    to: "bob",
    payload: { media_type: "text/markdown", text: "hello bob" },
  });
  const delivered = await waitFrame(
    bob.frames,
    (f) => f.namespace === "chat" && f.event === "message",
  );
  expect(delivered).not.toBeNull();
  expect((delivered?.payload as { text?: string })?.text).toBe("hello bob");

  alice.socket.end();
  bob.socket.end();
});

test("broadcast reaches all live subscribers except the sender", async () => {
  await bootBus();
  const alice = await connectClient();
  const bob = await connectClient();
  const carol = await connectClient();

  for (const [c, name, sid, st] of [
    [alice, "alice", "sess-alice", "t-alice"],
    [bob, "bob", "sess-bob", "t-bob"],
    [carol, "carol", "sess-carol", "t-carol"],
  ] as const) {
    c.send({
      op: "register",
      namespace: "chat",
      name,
      session_id: sid,
      start_time: st,
    });
    await waitFrame(c.frames, (f) => f.type === "ack" && f.op === "register");
    c.send({ op: "subscribe", namespaces: ["chat"] });
    await waitFrame(c.frames, (f) => f.type === "ack" && f.op === "subscribe");
  }

  alice.send({
    op: "publish",
    event: "broadcast",
    namespace: "chat",
    payload: { media_type: "text/plain", text: "all hands" },
  });
  const bobGot = await waitFrame(bob.frames, (f) => f.event === "message");
  const carolGot = await waitFrame(carol.frames, (f) => f.event === "message");
  expect(bobGot).not.toBeNull();
  expect(carolGot).not.toBeNull();
  // The sender is never echoed its own broadcast.
  await retryUntil(() => true, 200, 50);
  expect(alice.frames.find((f) => f.event === "message")).toBeUndefined();

  alice.socket.end();
  bob.socket.end();
  carol.socket.end();
});

test("dead-name resolution: a FORMER name reaches the agent's CURRENT live channel", async () => {
  await bootBus();
  const alice = await connectClient();
  const bob = await connectClient();

  alice.send({
    op: "register",
    namespace: "chat",
    name: "alice",
    session_id: "sess-alice",
    start_time: "t-alice",
  });
  // bob registers as session_id sess-bob — the SAME job_id the seeded keeper job
  // carries, so its former name "bob-old" (in jobs.name_history) resolves here.
  bob.send({
    op: "register",
    namespace: "chat",
    name: "bob",
    session_id: "sess-bob",
    start_time: "t-bob",
  });
  await waitFrame(alice.frames, (f) => f.type === "ack" && f.op === "register");
  await waitFrame(bob.frames, (f) => f.type === "ack" && f.op === "register");
  alice.send({ op: "subscribe", namespaces: ["chat"] });
  bob.send({ op: "subscribe", namespaces: ["chat"] });
  await waitFrame(bob.frames, (f) => f.type === "ack" && f.op === "subscribe");

  // Address bob by his now-DEAD former name.
  alice.send({
    op: "publish",
    event: "send",
    namespace: "chat",
    to: "bob-old",
    payload: { media_type: "text/plain", text: "still reachable?" },
  });
  const delivered = await waitFrame(bob.frames, (f) => f.event === "message");
  expect(delivered).not.toBeNull();
  expect((delivered?.payload as { text?: string })?.text).toBe(
    "still reachable?",
  );

  alice.socket.end();
  bob.socket.end();
});

test("anti-spoof: the server overwrites the sender-claimed `from`; socket is 0600", async () => {
  await bootBus();
  // Socket mode is 0600 (Linux defense-in-depth; the dir mode is the real gate).
  const mode = statSync(sockPath).mode & 0o777;
  expect(mode).toBe(0o600);

  const alice = await connectClient();
  const bob = await connectClient();
  alice.send({
    op: "register",
    namespace: "chat",
    name: "alice",
    session_id: "sess-alice",
    start_time: "t-alice",
  });
  bob.send({
    op: "register",
    namespace: "chat",
    name: "bob",
    session_id: "sess-bob",
    start_time: "t-bob",
  });
  await waitFrame(alice.frames, (f) => f.type === "ack" && f.op === "register");
  await waitFrame(bob.frames, (f) => f.type === "ack" && f.op === "register");
  alice.send({ op: "subscribe", namespaces: ["chat"] });
  bob.send({ op: "subscribe", namespaces: ["chat"] });
  await waitFrame(bob.frames, (f) => f.type === "ack" && f.op === "subscribe");

  // Alice publishes but the wire payload is opaque to the core; a malicious
  // `from` in the client frame is IGNORED — the server stamps the resolved one.
  alice.send({
    op: "publish",
    event: "send",
    namespace: "chat",
    to: "bob",
    payload: { media_type: "text/plain", text: "x" },
    from: {
      channel_id: "ch-FORGED",
      pid: 1,
      session_id: "evil",
      name: "mallory",
    },
  });
  const delivered = await waitFrame(bob.frames, (f) => f.event === "message");
  expect(delivered).not.toBeNull();
  const from = delivered?.from as { name?: string; channel_id?: string };
  // The forged identity never appears — the server-resolved alice identity does.
  expect(from.name).toBe("alice");
  expect(from.channel_id).not.toBe("ch-FORGED");

  alice.socket.end();
  bob.socket.end();
});

/**
 * Drive `cli/bus.ts main(argv)` against the sandboxed bus socket with
 * process.{exit,stdout,stderr} captured. `main()` calls `process.exit`, so the
 * exit shim throws to unwind the never-return branches; KEEPER_BUS_SOCK points the
 * CLI's client at this test's socket.
 */
class CliExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}
async function runBusCli(
  argv: string[],
): Promise<{ code: number | undefined; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const realExit = process.exit.bind(process);
  const realSock = process.env.KEEPER_BUS_SOCK;
  process.env.KEEPER_BUS_SOCK = sockPath;
  let code: number | undefined;
  process.stdout.write = ((s: string | Uint8Array) => {
    out.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    err.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new CliExit(code);
  }) as typeof process.exit;
  try {
    await busMain(argv);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.exit = realExit;
    if (realSock === undefined) delete process.env.KEEPER_BUS_SOCK;
    else process.env.KEEPER_BUS_SOCK = realSock;
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

test("CLI round-trip: `keeper bus chat send` reaches a live subscriber; `list` shows the bus", async () => {
  await bootBus();
  // A raw subscriber (bob) the CLI sender will reach by name.
  const bob = await connectClient();
  bob.send({
    op: "register",
    namespace: "chat",
    name: "bob",
    session_id: "sess-bob",
    start_time: "t-bob",
  });
  await waitFrame(bob.frames, (f) => f.type === "ack" && f.op === "register");
  bob.send({ op: "subscribe", namespaces: ["chat"] });
  await waitFrame(bob.frames, (f) => f.type === "ack" && f.op === "subscribe");

  // The CLI one-shot send: register → publish → exit 0.
  const sent = await runBusCli(["chat", "send", "bob", "hello from the CLI"]);
  expect(sent.code).toBe(0);

  const delivered = await waitFrame(bob.frames, (f) => f.event === "message");
  expect(delivered).not.toBeNull();
  expect((delivered?.payload as { text?: string })?.text).toBe(
    "hello from the CLI",
  );

  // `keeper bus list` round-trips and emits a JSON array including bob.
  const listed = await runBusCli(["list"]);
  expect(listed.code).toBe(0);
  const channels = JSON.parse(listed.stdout) as Array<{ name?: string }>;
  expect(channels.some((c) => c.name === "bob")).toBe(true);

  bob.socket.end();
});

test("CLI `keeper bus resolve` resolves a FORMER name to the live identity", async () => {
  await bootBus();
  const bob = await connectClient();
  // bob registers as sess-bob — the seeded keeper job carries former name "bob-old".
  bob.send({
    op: "register",
    namespace: "chat",
    name: "bob",
    session_id: "sess-bob",
    start_time: "t-bob",
  });
  await waitFrame(bob.frames, (f) => f.type === "ack" && f.op === "register");
  bob.send({ op: "subscribe", namespaces: ["chat"] });
  await waitFrame(bob.frames, (f) => f.type === "ack" && f.op === "subscribe");

  const resolved = await runBusCli(["resolve", "bob-old"]);
  expect(resolved.code).toBe(0);
  const body = JSON.parse(resolved.stdout) as {
    kind?: string;
    channel_id?: string | null;
  };
  expect(body.kind).toBe("ok");
  expect(body.channel_id).toBeTruthy();

  bob.socket.end();
});

test("shutdown releases the socket + lock", async () => {
  await bootBus();
  expect(existsSync(sockPath)).toBe(true);
  worker?.postMessage({ type: "shutdown" });
  const gone = await retryUntil(
    () =>
      !existsSync(sockPath) && !existsSync(`${sockPath}.lock`) ? true : null,
    3000,
    25,
  );
  expect(gone).toBe(true);
  worker = null; // afterEach already saw it down
});
