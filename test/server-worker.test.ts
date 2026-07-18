import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  ASYNC_RPC_REGISTRY,
  BadParamsError,
  decodeConnChunk,
  dispatchLine,
  freeConn,
  newConnState,
  newResultMemo,
  RPC_REGISTRY,
  registerAsyncRpc,
  registerRpc,
  resetRpcRegistryForTests,
  SlugConflictError,
  type Writable,
} from "../src/server-worker";
import { freshMemDb } from "./helpers/template-db";

const encoder = new TextEncoder();

afterEach(() => {
  resetRpcRegistryForTests();
});

function fakeDb(): Database {
  return {
    prepare(sql: string) {
      return {
        get() {
          if (sql.includes("reducer_state")) return { last_event_id: 0 };
          return null;
        },
      };
    },
  } as unknown as Database;
}

describe("server-worker RPC composition", () => {
  test("a plain main-thread import leaves both registries empty", () => {
    expect([...RPC_REGISTRY]).toEqual([]);
    expect([...ASYNC_RPC_REGISTRY]).toEqual([]);
  });

  test("typed handler errors retain their wire problem-code mapping", () => {
    registerRpc("bad", () => {
      throw new BadParamsError("bad input");
    });
    registerRpc("conflict", () => {
      throw new SlugConflictError("slug exists");
    });
    registerRpc("failed", () => {
      throw new Error("handler crashed");
    });

    const db = fakeDb();
    const conn = newConnState();
    const call = (id: string, method: string) =>
      dispatchLine(
        db,
        conn,
        JSON.stringify({ type: "rpc", id, method, params: null }),
      );

    expect(call("1", "bad")).toEqual([
      {
        type: "error",
        id: "1",
        rev: 0,
        code: "bad_params",
        message: "bad input",
      },
    ]);
    expect(call("2", "conflict")).toEqual([
      {
        type: "error",
        id: "2",
        rev: 0,
        code: "slug_conflict",
        message: "slug exists",
      },
    ]);
    expect(call("3", "failed")).toEqual([
      {
        type: "error",
        id: "3",
        rev: 0,
        code: "rpc_failed",
        message: "handler crashed",
      },
    ]);
  });

  test("async typed errors retain their wire problem-code mapping", async () => {
    registerAsyncRpc("bad", async () => {
      throw new BadParamsError("bad input");
    });
    registerAsyncRpc("conflict", async () => {
      throw new SlugConflictError("slug exists");
    });
    registerAsyncRpc("failed", async () => {
      throw new Error("handler crashed");
    });

    const db = fakeDb();
    const conn = newConnState();
    const call = (id: string, method: string) =>
      new Promise<unknown[]>((resolve) => {
        const immediate = dispatchLine(
          db,
          conn,
          JSON.stringify({ type: "rpc", id, method, params: null }),
          undefined,
          { bridge: {} as never, onAsyncResult: resolve },
        );
        expect(immediate).toEqual([]);
      });

    expect(await call("1", "bad")).toEqual([
      {
        type: "error",
        id: "1",
        rev: 0,
        code: "bad_params",
        message: "bad input",
      },
    ]);
    expect(await call("2", "conflict")).toEqual([
      {
        type: "error",
        id: "2",
        rev: 0,
        code: "slug_conflict",
        message: "slug exists",
      },
    ]);
    expect(await call("3", "failed")).toEqual([
      {
        type: "error",
        id: "3",
        rev: 0,
        code: "rpc_failed",
        message: "handler crashed",
      },
    ]);
  });

  test("memoized steady-state results carry the durable identity and current Drain state", () => {
    const { db } = freshMemDb();
    db.run("UPDATE git_projection_state SET seed_required = 0 WHERE id = 1");
    const identity = {
      boot_id: "boot-exact",
      pid: 4242,
      start_time: "linux:123456",
    };
    const frames = dispatchLine(
      db,
      newConnState(),
      JSON.stringify({ type: "query", id: "q", collection: "jobs" }),
      undefined,
      undefined,
      newResultMemo(),
      { ready: true, identity, generation: identity.boot_id },
    );

    expect(frames).toHaveLength(1);
    const line = (frames[0] as { __line: string }).__line;
    const result = JSON.parse(line) as {
      boot: {
        boot_id: string;
        pid: number;
        start_time: string;
        catching_up: boolean;
        rev: number;
        head_event_id: number;
      };
    };
    expect(result.boot).toMatchObject({
      ...identity,
      catching_up: false,
      rev: 0,
      head_event_id: 0,
    });
  });

  test("boot gating rejects all eight mutating RPCs before invoking handlers", () => {
    const methods = [
      "replay_dead_letter",
      "set_autopilot_paused",
      "set_autopilot_mode",
      "set_autopilot_config",
      "set_epic_armed",
      "retry_dispatch",
      "request_handoff",
      "request_await",
    ];
    let calls = 0;
    for (const method of methods) {
      registerRpc(method, () => {
        calls += 1;
        return { ok: true };
      });
    }

    const db = fakeDb();
    for (const method of methods) {
      const frames = dispatchLine(
        db,
        newConnState(),
        JSON.stringify({
          type: "rpc",
          id: method,
          method,
          params: null,
        }),
        undefined,
        undefined,
        newResultMemo(),
        { ready: false },
      );
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        type: "error",
        id: method,
        rev: 0,
        code: "server_booting",
      });
    }

    expect(calls).toBe(0);
  });
});

describe("server-worker inbound UTF-8 decode", () => {
  test("keeps a codepoint split across socket chunks intact", () => {
    const conn = newConnState();
    const line = '{"type":"unsubscribe","id":"left-😇-right"}';
    const bytes = encoder.encode(`${line}\n`);
    const emojiOffset = encoder.encode(
      '{"type":"unsubscribe","id":"left-',
    ).length;
    const split = emojiOffset + 2;

    expect(decodeConnChunk(conn, bytes.slice(0, split))).toEqual([]);
    expect(decodeConnChunk(conn, bytes.slice(split))).toEqual([line]);
  });

  test("malformed bytes become a bad-frame line without dropping the batch", () => {
    const conn = newConnState();
    const chunk = new Uint8Array([
      0xff,
      0x0a,
      ...encoder.encode('{"type":"unsubscribe"}\n'),
    ]);

    const lines = decodeConnChunk(conn, chunk);

    expect(lines).toEqual(["�", '{"type":"unsubscribe"}']);
    const frames = dispatchLine(fakeDb(), conn, lines[0] ?? "");
    expect(frames).toEqual([
      {
        type: "error",
        rev: 0,
        code: "bad_frame",
        message: "line is not valid JSON",
      },
    ]);
  });

  test("teardown discards a partial codepoint and is idempotent", () => {
    const conn = newConnState();
    const sock: Writable = {
      data: conn,
      write() {
        return 0;
      },
    };
    const conns = new Set<Writable>([sock]);
    const snowman = encoder.encode("☃");

    expect(decodeConnChunk(conn, snowman.slice(0, 2))).toEqual([]);

    freeConn(conns, sock);
    freeConn(conns, sock);

    expect(conns.has(sock)).toBe(false);
    expect(conn.buffer.pendingLength()).toBe(0);
    expect(decodeConnChunk(conn, encoder.encode("\n"))).toEqual([""]);
  });
});
