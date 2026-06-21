/**
 * Fast-tier unit tests for `cli/bus.ts` — the `keeper bus` command surface
 * (epic fn-875 task .3). Exercises the PURE decision functions without a socket:
 * argv routing, publish-envelope construction, the spill-vs-inline render
 * decision, the authoritative-directive marker, spill naming, the prune predicate,
 * and the `pruneInbox`/`emitMessage` file behavior under a sandboxed tmpdir.
 *
 * A real round-trip against the bus socket lives in the FULL tier (it shares the
 * .2 integration harness). These tests never connect.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPublishFrame,
  CHAT_NAMESPACE,
  directiveHead,
  emitMessage,
  hms,
  type InboundMessage,
  isStaleSpill,
  NOTIFY_LINE_BUDGET,
  parseBusArgv,
  pruneInbox,
  renderDecision,
  SPILL_MAX_AGE_MS,
  senderLabel,
  spillFileName,
  spillPointerLine,
} from "../cli/bus";

describe("parseBusArgv routing", () => {
  test("list", () => {
    expect(parseBusArgv(["list"])).toEqual({ kind: "list" });
  });

  test("watch", () => {
    expect(parseBusArgv(["watch"])).toEqual({ kind: "watch" });
  });

  test("resolve <target>", () => {
    expect(parseBusArgv(["resolve", "bob"])).toEqual({
      kind: "resolve",
      target: "bob",
    });
  });

  test("resolve without a target → usage", () => {
    const r = parseBusArgv(["resolve"]);
    expect(r.kind).toBe("usage");
    if (r.kind === "usage") expect(r.error).toContain("target");
  });

  test("chat send <target> <msg>", () => {
    expect(parseBusArgv(["chat", "send", "bob", "hi"])).toEqual({
      kind: "send",
      target: "bob",
      message: "hi",
    });
  });

  test("chat send preserves '-' verbatim (stdin sentinel)", () => {
    expect(parseBusArgv(["chat", "send", "bob", "-"])).toEqual({
      kind: "send",
      target: "bob",
      message: "-",
    });
  });

  test("chat send without a message → usage", () => {
    const r = parseBusArgv(["chat", "send", "bob"]);
    expect(r.kind).toBe("usage");
    if (r.kind === "usage") expect(r.error).toContain("message");
  });

  test("chat send without a target → usage", () => {
    const r = parseBusArgv(["chat", "send"]);
    expect(r.kind).toBe("usage");
    if (r.kind === "usage") expect(r.error).toContain("target");
  });

  test("chat broadcast <msg>", () => {
    expect(parseBusArgv(["chat", "broadcast", "all hands"])).toEqual({
      kind: "broadcast",
      message: "all hands",
    });
  });

  test("chat broadcast '-' verbatim", () => {
    expect(parseBusArgv(["chat", "broadcast", "-"])).toEqual({
      kind: "broadcast",
      message: "-",
    });
  });

  test("chat with an unknown sub-verb → usage", () => {
    const r = parseBusArgv(["chat", "yell", "hi"]);
    expect(r.kind).toBe("usage");
    if (r.kind === "usage") expect(r.error).toContain("send|broadcast");
  });

  test("unknown verb → usage naming the verb", () => {
    const r = parseBusArgv(["bogus"]);
    expect(r.kind).toBe("usage");
    if (r.kind === "usage") expect(r.error).toContain("bogus");
  });

  test("no verb → usage", () => {
    const r = parseBusArgv([]);
    expect(r.kind).toBe("usage");
  });

  test("--help anywhere → help", () => {
    expect(parseBusArgv(["--help"]).kind).toBe("help");
    expect(parseBusArgv(["chat", "send", "-h"]).kind).toBe("help");
  });
});

describe("buildPublishFrame", () => {
  test("send carries to + chat namespace + markdown payload, no claimed from", () => {
    const f = buildPublishFrame("send", "hello", "bob");
    expect(f).toEqual({
      op: "publish",
      event: "send",
      namespace: CHAT_NAMESPACE,
      to: "bob",
      payload: { media_type: "text/markdown", text: "hello" },
    });
    // Anti-spoof: the CLI never claims a `from` — the server stamps it.
    expect((f as unknown as Record<string, unknown>).from).toBeUndefined();
  });

  test("broadcast omits to", () => {
    const f = buildPublishFrame("broadcast", "all hands");
    expect(f.to).toBeUndefined();
    expect(f.event).toBe("broadcast");
    expect(f.namespace).toBe(CHAT_NAMESPACE);
  });
});

describe("authoritative-directive marker", () => {
  test("directiveHead carries the stable marker + sender + stamp", () => {
    const head = directiveHead("alice", "13:05:09");
    expect(head).toContain("Agent Bus directive from alice");
    expect(head).toContain("[13:05:09]");
  });

  test("directiveHead omits the stamp bracket when empty", () => {
    expect(directiveHead("alice", "")).toBe("Agent Bus directive from alice: ");
  });

  test("a short message renders inline WITH the directive marker", () => {
    const msg: InboundMessage = {
      namespace: "chat",
      event: "message",
      from: { name: "alice", channel_id: "ch-1" },
      ts: 0,
      payload: { text: "ship it" },
    };
    const d = renderDecision(msg);
    expect(d.kind).toBe("inline");
    if (d.kind === "inline") {
      expect(d.line).toContain("Agent Bus directive from alice");
      expect(d.line).toContain("ship it");
      // NOT framed as untrusted/out-of-band.
      expect(d.line.toLowerCase()).not.toContain("untrusted");
    }
  });

  test("senderLabel falls back to channel_id when name is absent", () => {
    expect(senderLabel({ name: null, channel_id: "ch-xyz" })).toBe("ch-xyz");
    expect(senderLabel({ name: "alice", channel_id: "ch-xyz" })).toBe("alice");
  });
});

describe("hms", () => {
  test("zero/negative ts → empty stamp", () => {
    expect(hms(0)).toBe("");
    expect(hms(-5)).toBe("");
  });

  test("a real ts → HH:MM:SS", () => {
    expect(hms(Date.now())).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("renderDecision spill threshold", () => {
  test("an over-budget body spills with a preview that fits the budget", () => {
    const big = "x".repeat(NOTIFY_LINE_BUDGET * 3);
    const msg: InboundMessage = {
      namespace: "chat",
      event: "message",
      from: { name: "alice", channel_id: "ch-1" },
      ts: 0,
      payload: { text: big },
    };
    const d = renderDecision(msg);
    expect(d.kind).toBe("spill");
    if (d.kind === "spill") {
      const line = spillPointerLine(
        d.head,
        d.preview,
        big.length,
        "/some/path.md",
      );
      expect(line.length).toBeLessThanOrEqual(NOTIFY_LINE_BUDGET);
      expect(line).toContain("Agent Bus directive from alice");
      expect(line).toContain("/some/path.md");
      expect(line).toContain(`+${big.length} chars`);
    }
  });

  test("a body exactly at the budget stays inline", () => {
    const head = directiveHead("a", "");
    const body = "y".repeat(NOTIFY_LINE_BUDGET - head.length);
    const msg: InboundMessage = {
      namespace: "chat",
      event: "message",
      from: { name: "a", channel_id: "ch-1" },
      ts: 0,
      payload: { text: body },
    };
    expect(renderDecision(msg).kind).toBe("inline");
  });
});

describe("spillFileName", () => {
  test("ts + sanitized sender token + .md", () => {
    const name = spillFileName(Date.parse("2026-06-21T13:05:09Z"), "alice");
    expect(name).toMatch(/^\d{8}T\d{6}Z-alice\.md$/);
  });

  test("non-alnum sender chars are sanitized", () => {
    const name = spillFileName(0, "a/b c");
    expect(name).toContain("a_b_c");
    expect(name).toMatch(/^msg-/);
  });
});

describe("isStaleSpill", () => {
  test("older than max age → stale", () => {
    const now = Date.now();
    expect(isStaleSpill(now - SPILL_MAX_AGE_MS - 1000, now)).toBe(true);
  });

  test("within max age → fresh", () => {
    const now = Date.now();
    expect(isStaleSpill(now - 1000, now)).toBe(false);
  });
});

describe("pruneInbox (filesystem, sandboxed)", () => {
  test("removes only stale files, keeps fresh ones, no-op on a missing dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "bus-inbox-"));
    try {
      const stale = join(dir, "stale.md");
      const fresh = join(dir, "fresh.md");
      writeFileSync(stale, "old");
      writeFileSync(fresh, "new");
      const oldMs = (Date.now() - SPILL_MAX_AGE_MS - 60_000) / 1000;
      utimesSync(stale, oldMs, oldMs);

      pruneInbox(dir);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);

      // Missing dir is a clean no-op (does not throw).
      rmSync(dir, { recursive: true, force: true });
      expect(() => pruneInbox(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("emitMessage (filesystem, sandboxed)", () => {
  function captureStdout(fn: () => void): string {
    const out: string[] = [];
    const real = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      out.push(typeof s === "string" ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      fn();
    } finally {
      process.stdout.write = real;
    }
    return out.join("");
  }

  test("a short message prints inline, writes no spill file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bus-emit-"));
    try {
      const msg: InboundMessage = {
        namespace: "chat",
        event: "message",
        from: { name: "alice", channel_id: "ch-1" },
        ts: 0,
        payload: { text: "ship it" },
      };
      const out = captureStdout(() => emitMessage(msg, dir));
      expect(out).toContain("Agent Bus directive from alice");
      expect(out).toContain("ship it");
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an over-budget message spills to a file and prints a pointer", () => {
    const dir = mkdtempSync(join(tmpdir(), "bus-emit-"));
    try {
      const big = "z".repeat(NOTIFY_LINE_BUDGET * 4);
      const msg: InboundMessage = {
        namespace: "chat",
        event: "message",
        from: { name: "alice", channel_id: "ch-1" },
        ts: Date.now(),
        payload: { text: big },
      };
      const out = captureStdout(() => emitMessage(msg, dir));
      expect(out).toContain("⟦full +");
      expect(out.trimEnd().length).toBeLessThanOrEqual(NOTIFY_LINE_BUDGET);
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second over-budget message from the same sender/ts gets a unique file", () => {
    const dir = mkdtempSync(join(tmpdir(), "bus-emit-"));
    try {
      mkdirSync(dir, { recursive: true });
      const big = "q".repeat(NOTIFY_LINE_BUDGET * 4);
      const msg: InboundMessage = {
        namespace: "chat",
        event: "message",
        from: { name: "alice", channel_id: "ch-1" },
        ts: 1_700_000_000_000,
        payload: { text: big },
      };
      captureStdout(() => {
        emitMessage(msg, dir);
        emitMessage(msg, dir);
      });
      expect(readdirSync(dir)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
