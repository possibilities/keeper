/**
 * `cli/handoff.ts` pure-validator + wire-shape unit tests. The doc-body cap is
 * load-bearing: the brief rides inline in the event log forever (a fold reads it
 * back), so an over-cap body is REJECTED, never truncated. The frame builder's
 * shape is asserted so the RPC wire stays stable.
 */

import { expect, test } from "bun:test";
import {
  buildRequestHandoffFrame,
  HANDOFF_DOC_MAX_BYTES,
  validateHandoffDoc,
} from "../cli/handoff";

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

test("buildRequestHandoffFrame: emits the request_handoff RPC wire shape", () => {
  const frame = buildRequestHandoffFrame("rpc-1", {
    handoff_id: "h-1",
    doc: "brief",
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
      handoff_id: "h-1",
      doc: "brief",
      title: "t",
      target_session: "work",
      initiator_session: "dash",
      initiator_pane: "%2",
    },
  });
});
