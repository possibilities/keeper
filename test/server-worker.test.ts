import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  decodeConnChunk,
  dispatchLine,
  freeConn,
  newConnState,
  type Writable,
} from "../src/server-worker";

const encoder = new TextEncoder();

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
