/**
 * Tests for `cli/control-rpc.ts` — the shared one-shot UDS round-trip helpers
 * lifted out of `cli/autopilot.ts` (fn-858.2).
 *
 * `queryCollection` is the read-then-exit primitive dispatch needs (one `query`
 * frame → decoded rows → connection closes), as distinct from the never-exiting
 * `subscribeCollection` loop. These tests stand up a real `Bun.listen` UDS echo
 * server under a per-test tmpdir so the actual `Bun.connect` transport is
 * exercised end to end.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryCollection } from "../cli/control-rpc";
import {
  encodeFrame,
  LineBuffer,
  type QueryFrame,
  type Row,
  type ServerFrame,
} from "../src/protocol";

let dir: string;
let sockPath: string;
let server: ReturnType<typeof Bun.listen> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keeper-control-rpc-"));
  sockPath = join(dir, "sub.sock");
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Stand up a UDS server that, on each line, parses a `query` frame and replies
 * with one `result` frame produced by `respond(frame)`. Returns once listening.
 */
function listenEcho(respond: (q: QueryFrame) => ServerFrame): void {
  server = Bun.listen({
    unix: sockPath,
    socket: {
      open(s) {
        (s as unknown as { data: LineBuffer }).data = new LineBuffer();
      },
      data(s, chunk) {
        const buf = (s as unknown as { data: LineBuffer }).data;
        for (const line of buf.push(chunk.toString("utf8"))) {
          if (line.trim().length === 0) {
            continue;
          }
          const q = JSON.parse(line) as QueryFrame;
          s.write(encodeFrame(respond(q)));
        }
      },
    },
  });
}

test("queryCollection: one-shot read returns the decoded rows", async () => {
  const rows: Row[] = [
    { epic_id: "fn-1-foo", project_dir: "/repo" },
    { epic_id: "fn-2-bar", project_dir: "/other" },
  ];
  listenEcho((q) => ({
    type: "result",
    id: q.id,
    collection: q.collection,
    rev: 42,
    total: rows.length,
    rows,
  }));

  const got = await queryCollection(sockPath, "epics");
  expect(got).toEqual(rows);
});

test("queryCollection: sends a no-cap query frame echoing the collection + filter", async () => {
  let seen: QueryFrame | null = null;
  listenEcho((q) => {
    seen = q;
    return {
      type: "result",
      id: q.id,
      collection: q.collection,
      rev: 1,
      total: 0,
      rows: [],
    };
  });

  await queryCollection(sockPath, "pending_dispatches", {
    verb: "work",
  });

  expect(seen).not.toBeNull();
  const frame = seen as unknown as QueryFrame;
  expect(frame.type).toBe("query");
  expect(frame.collection).toBe("pending_dispatches");
  // `limit: 0` is the explicit "no row cap" sentinel for a one-shot full read.
  expect(frame.limit).toBe(0);
  expect(frame.filter).toEqual({ verb: "work" });
  // A correlation id is always set so the round-trip matches the reply.
  expect(typeof frame.id).toBe("string");
  expect((frame.id ?? "").length).toBeGreaterThan(0);
});

test("queryCollection: surfaces a daemon error frame", async () => {
  listenEcho((q) => ({
    type: "error",
    id: q.id,
    collection: q.collection,
    rev: 0,
    code: "unknown_collection",
    message: "no such collection",
  }));

  await expect(queryCollection(sockPath, "nope")).rejects.toThrow(
    /unknown_collection/,
  );
});

test("queryCollection: a non-matching frame id is ignored; server close rejects", async () => {
  // Reply with a mismatched id then close — the round-trip must NOT resolve on
  // the foreign frame, and must reject via the close handler (not the row).
  server = Bun.listen({
    unix: sockPath,
    socket: {
      open(s) {
        (s as unknown as { data: LineBuffer }).data = new LineBuffer();
      },
      data(s, chunk) {
        const buf = (s as unknown as { data: LineBuffer }).data;
        for (const line of buf.push(chunk.toString("utf8"))) {
          if (line.trim().length === 0) {
            continue;
          }
          s.write(
            encodeFrame({
              type: "result",
              id: "some-other-id",
              collection: "epics",
              rev: 1,
              total: 0,
              rows: [],
            }),
          );
          s.end();
        }
      },
    },
  });

  await expect(queryCollection(sockPath, "epics")).rejects.toThrow(
    /closed connection before responding/,
  );
});
