/**
 * `cli/handoff.ts` pure-validator + wire-shape unit tests. The doc-body cap is
 * load-bearing: the brief rides inline in the event log forever (a fold reads it
 * back), so an over-cap body is REJECTED, never truncated. The frame builder's
 * shape is asserted so the RPC wire stays stable.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CONTROL_FRAME_BYTES } from "../cli/control-rpc";
import {
  buildRequestHandoffFrame,
  HANDOFF_DOC_MAX_BYTES,
  spillHandoffDoc,
  validateHandoffDoc,
} from "../cli/handoff";
import { encodeFrame } from "../src/protocol";

test("validateHandoffDoc: accepts an ordinary brief", () => {
  expect(validateHandoffDoc("investigate X; context: ...")).toEqual({
    ok: true,
  });
});

test("validateHandoffDoc: rejects an empty brief", () => {
  const r = validateHandoffDoc("");
  expect(r.ok).toBe(false);
});

test("validateHandoffDoc: rejects a NUL byte", () => {
  const r = validateHandoffDoc("before\0after");
  expect(r.ok).toBe(false);
});

test("validateHandoffDoc: accepts a brief exactly at the cap, rejects one byte over", () => {
  const atCap = "a".repeat(HANDOFF_DOC_MAX_BYTES);
  expect(validateHandoffDoc(atCap)).toEqual({ ok: true });
  const overCap = "a".repeat(HANDOFF_DOC_MAX_BYTES + 1);
  const r = validateHandoffDoc(overCap);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    // Reject message names the byte size + cap, and does NOT truncate.
    expect(r.error).toContain(String(HANDOFF_DOC_MAX_BYTES));
  }
});

test("validateHandoffDoc: counts UTF-8 bytes, not code points (multibyte over the cap)", () => {
  // A 4-byte emoji repeated to just over the cap in BYTES (well under in length).
  const emoji = "😀"; // 4 bytes UTF-8
  const count = Math.ceil(HANDOFF_DOC_MAX_BYTES / 4) + 1;
  const doc = emoji.repeat(count);
  expect(doc.length).toBeLessThan(HANDOFF_DOC_MAX_BYTES); // fewer code points
  expect(Buffer.byteLength(doc, "utf8")).toBeGreaterThan(HANDOFF_DOC_MAX_BYTES);
  expect(validateHandoffDoc(doc).ok).toBe(false);
});

test("buildRequestHandoffFrame: carries desired_slug + doc_path, not the inline doc (small wire frame)", () => {
  const frame = buildRequestHandoffFrame("rpc-1", {
    desired_slug: "investigate-foo",
    doc_path: "/state/handoff/rpc-1.txt",
    title: "t",
    target_session: "work",
    initiator_session: "dash",
    initiator_pane: "%2",
  });
  expect(frame).toEqual({
    type: "rpc",
    id: "rpc-1",
    method: "request_handoff",
    params: {
      desired_slug: "investigate-foo",
      doc_path: "/state/handoff/rpc-1.txt",
      title: "t",
      target_session: "work",
      initiator_session: "dash",
      initiator_pane: "%2",
    },
  });
});

test("buildRequestHandoffFrame: stays small even for a 64KB doc (the doc rides a file, not the wire)", () => {
  // Mirror the boundary that motivated the fix: a 64KB brief inlined into the
  // frame overflowed the ~8 KiB UDS send buffer and hung. With doc_path the
  // encoded frame is well under MAX_CONTROL_FRAME_BYTES regardless of doc size.
  const frame = buildRequestHandoffFrame("rpc-1", {
    desired_slug: "investigate-foo",
    doc_path: "/state/handoff/rpc-1.txt",
    title: null,
    target_session: "work",
    initiator_session: null,
    initiator_pane: null,
  });
  const encoded = encodeFrame(frame);
  expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(
    MAX_CONTROL_FRAME_BYTES,
  );
});

test("spillHandoffDoc: writes the doc to a file under the spill dir and returns its path", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-handoff-spill-"));
  const prev = process.env.KEEPER_HANDOFF_SPILL_DIR;
  process.env.KEEPER_HANDOFF_SPILL_DIR = dir;
  try {
    const big = "x".repeat(40_000); // well over the 8 KiB send-buffer boundary
    const path = spillHandoffDoc("h-99", big);
    expect(path.startsWith(dir)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(big);
  } finally {
    if (prev === undefined) {
      delete process.env.KEEPER_HANDOFF_SPILL_DIR;
    } else {
      process.env.KEEPER_HANDOFF_SPILL_DIR = prev;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
