/**
 * Fast-tier unit tests for `cli/bus.ts` — the `keeper bus` command surface
 * (epic fn-875 task .3). Exercises the PURE decision functions without a socket:
 * argv routing, publish-envelope construction, the spill-vs-inline render
 * decision, the message head, spill naming, the prune predicate,
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
  armLifetimeStdin,
  AGENT_HELP as BUS_AGENT_HELP,
  buildPublishFrame,
  CHAT_NAMESPACE,
  emitJsonMessage,
  emitMessage,
  handleWatchFrame,
  hms,
  type InboundMessage,
  isStaleSpill,
  messageHead,
  NOTIFY_LINE_BUDGET,
  parseBusArgv,
  pruneInbox,
  registerFrame,
  renderDecision,
  renderMessageNotification,
  SPILL_MAX_AGE_MS,
  senderLabel,
  sendResultIsSuccess,
  sendSuccessMessage,
  sendTransportIsAmbiguous,
  spillFileName,
  spillPointerLine,
  wakeResultLine,
} from "../cli/bus";
import {
  BUS_ARTIFACT_REF_TAG,
  BUS_ARTIFACT_REF_VERSION,
  publishBusArtifact,
} from "../src/bus-artifact";
import type { WakeResult } from "../src/bus-wake";

describe("parseBusArgv routing", () => {
  test("list", () => {
    expect(parseBusArgv(["list"])).toEqual({ kind: "list" });
  });

  test("watch", () => {
    expect(parseBusArgv(["watch"])).toEqual({ kind: "watch" });
  });

  test("watch accepts only its machine transport flags", () => {
    expect(parseBusArgv(["watch", "--json", "--lifetime-stdin"])).toEqual({
      kind: "watch",
      json: true,
      lifetimeStdin: true,
    });
    expect(parseBusArgv(["watch", "--bogus"]).kind).toBe("usage");
    expect(parseBusArgv(["watch", "--json", "--json"]).kind).toBe("usage");
  });

  test("resolve is gone → unknown verb usage", () => {
    const r = parseBusArgv(["resolve", "bob"]);
    expect(r.kind).toBe("usage");
    if (r.kind === "usage") expect(r.error).toContain("unknown bus verb");
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

  test("chat with an unknown sub-verb → usage", () => {
    const r = parseBusArgv(["chat", "yell", "hi"]);
    expect(r.kind).toBe("usage");
    if (r.kind === "usage") expect(r.error).toContain("send");
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

  test("--agent-help routes to the operator runbook (pure, no send)", () => {
    expect(parseBusArgv(["--agent-help"]).kind).toBe("agent-help");
    // Content assertion (catches an empty stub): names its primary verb form.
    expect(BUS_AGENT_HELP).toContain("operator runbook");
    expect(BUS_AGENT_HELP).toContain("keeper bus chat send");
  });

  test("wake <planner@epic>", () => {
    expect(parseBusArgv(["wake", "planner@fn-1"])).toEqual({
      kind: "wake",
      target: "planner@fn-1",
    });
  });

  test("wake without a target → usage", () => {
    const r = parseBusArgv(["wake"]);
    expect(r.kind).toBe("usage");
    if (r.kind === "usage") expect(r.error).toContain("planner@");
  });
});

describe("wakeResultLine (outcome → message + exit code)", () => {
  function res(overrides: Partial<WakeResult>): WakeResult {
    return {
      outcome: "launched",
      sessionId: "s1",
      detail: "ok",
      ...overrides,
    };
  }

  test("only unknown_creator is exit 1; every other outcome is exit 0", () => {
    expect(
      wakeResultLine("planner@fn-1", res({ outcome: "launched" })).exitCode,
    ).toBe(0);
    expect(
      wakeResultLine("planner@fn-1", res({ outcome: "already_live" })).exitCode,
    ).toBe(0);
    expect(
      wakeResultLine("planner@fn-1", res({ outcome: "in_flight" })).exitCode,
    ).toBe(0);
    expect(
      wakeResultLine("planner@fn-1", res({ outcome: "cooldown" })).exitCode,
    ).toBe(0);
    expect(
      wakeResultLine("planner@fn-1", res({ outcome: "launch_failed" }))
        .exitCode,
    ).toBe(0);
    expect(
      wakeResultLine(
        "planner@fn-1",
        res({ outcome: "unknown_creator", sessionId: null }),
      ).exitCode,
    ).toBe(1);
  });

  test("the line carries the outcome + target + detail", () => {
    const { line } = wakeResultLine(
      "planner@fn-1",
      res({ outcome: "launched", detail: "resumed s1" }),
    );
    expect(line).toContain("launched");
    expect(line).toContain("planner@fn-1");
    expect(line).toContain("resumed s1");
  });
});

describe("registerFrame", () => {
  test("carries the keeper job id as the pre-fold identity floor", () => {
    expect(
      registerFrame(false, { KEEPER_JOB_ID: " pi-session-1 " }),
    ).toMatchObject({
      op: "register",
      send_only: false,
      session_id: "pi-session-1",
    });
    expect(registerFrame(false, {})).not.toHaveProperty("session_id");
  });
});

describe("buildPublishFrame", () => {
  test("send carries the validated artifact reference in payload.text", () => {
    const artifact = {
      path: "/trusted/bus-artifacts/00000000000000000000000000000001",
      ref: {
        id: "00000000000000000000000000000001",
        len: 5,
        sha256:
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
    };
    const f = buildPublishFrame("send", artifact, "bob");
    expect(f).toEqual({
      op: "publish",
      event: "send",
      namespace: CHAT_NAMESPACE,
      to: "bob",
      payload: {
        media_type: "text/markdown",
        text: '{"t":"bus-artifact-ref","v":1,"id":"00000000000000000000000000000001","len":5,"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}',
        t: "bus-artifact-ref",
        v: 1,
        id: "00000000000000000000000000000001",
        len: 5,
        sha256:
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
    });
    expect(JSON.stringify(f)).not.toContain("hello");
    expect(JSON.parse(f.payload.text)).toEqual({
      t: "bus-artifact-ref",
      v: 1,
      id: artifact.ref.id,
      len: artifact.ref.len,
      sha256: artifact.ref.sha256,
    });
    expect((f as unknown as Record<string, unknown>).from).toBeUndefined();
  });
});

describe("message head marker", () => {
  test("messageHead carries the stable marker + sender + stamp", () => {
    const head = messageHead("alice", "13:05:09");
    expect(head).toContain("Agent Bus message from alice");
    expect(head).toContain("[13:05:09]");
  });

  test("messageHead omits the stamp bracket when empty", () => {
    expect(messageHead("alice", "")).toBe("Agent Bus message from alice: ");
  });

  test("a short message renders inline WITH the message head", () => {
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
      expect(d.line).toContain("Agent Bus message from alice");
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
      expect(line).toContain("Agent Bus message from alice");
      expect(line).toContain("/some/path.md");
      expect(line).toContain(`+${big.length} chars`);
    }
  });

  test("a body exactly at the budget stays inline", () => {
    const head = messageHead("a", "");
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
      expect(out).toContain("Agent Bus message from alice");
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

  test("new references render one read-only notification with no body preview", () => {
    const base = mkdtempSync(join(tmpdir(), "bus-artifact-render-"));
    const root = join(base, "bus-artifacts");
    try {
      const body = "TOP SECRET body that must never be previewed";
      const artifact = publishBusArtifact(root, body);
      const msg: InboundMessage = {
        namespace: "chat",
        event: "message",
        from: { name: "alice", channel_id: "ch-1" },
        ts: 0,
        payload: {
          media_type: "text/markdown",
          text: `read ${artifact.path}`,
          t: BUS_ARTIFACT_REF_TAG,
          v: BUS_ARTIFACT_REF_VERSION,
          ...artifact.ref,
        },
      };
      const expected = `Agent Bus message from alice — read ${artifact.path}`;
      expect(renderMessageNotification(msg, join(base, "inbox"), root)).toBe(
        expected,
      );
      const out = captureStdout(() =>
        emitJsonMessage(msg, join(base, "inbox"), root),
      );
      expect(out.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(out)).toEqual({
        type: "agent_bus_message",
        line: expected,
      });
      expect(out).not.toContain(body);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a resolved over-budget reference preserves its artifact id", () => {
    const base = mkdtempSync(join(tmpdir(), "bus-artifact-render-"));
    const root = join(
      base,
      ...Array.from({ length: 16 }, () => "deep-root-segment"),
    );
    const id = "0123456789abcdef0123456789abcdef";
    const sender = "s".repeat(128);
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, id), "");
      const msg: InboundMessage = {
        namespace: "chat",
        event: "message",
        from: { name: sender, channel_id: "ch-1" },
        ts: 0,
        payload: {
          text: "read artifact",
          t: BUS_ARTIFACT_REF_TAG,
          v: BUS_ARTIFACT_REF_VERSION,
          id,
          len: 0,
          sha256:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      };
      const expected = `Agent Bus message from ${sender} — read artifact ${id} (path omitted)`;
      const fullPathLine = `Agent Bus message from ${sender} — read ${join(root, id)}`;
      const line = renderMessageNotification(msg, join(base, "inbox"), root);
      expect(fullPathLine.length).toBeGreaterThan(NOTIFY_LINE_BUDGET);
      expect(line).toBe(expected);
      expect(line.length).toBeLessThanOrEqual(NOTIFY_LINE_BUDGET);
      expect(line).toContain(id);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("bad references fail loud without body fallback or untrusted path disclosure", () => {
    const base = mkdtempSync(join(tmpdir(), "bus-artifact-render-"));
    try {
      const attackerPath = "/etc/passwd";
      const msg: InboundMessage = {
        namespace: "chat",
        event: "message",
        from: { name: "alice", channel_id: "ch-1" },
        ts: 0,
        payload: {
          text: `read ${attackerPath}`,
          t: BUS_ARTIFACT_REF_TAG,
          v: BUS_ARTIFACT_REF_VERSION,
          id: "../../etc/passwd",
          len: 10,
          sha256: "0".repeat(64),
        },
      };
      const line = renderMessageNotification(
        msg,
        join(base, "inbox"),
        join(base, "bus-artifacts"),
      );
      expect(line).toBe(
        "Agent Bus message from alice — message artifact unavailable",
      );
      expect(line).not.toContain(attackerPath);
      expect(line).not.toContain(msg.payload.text);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a missing or corrupt artifact emits only metadata failure", () => {
    const base = mkdtempSync(join(tmpdir(), "bus-artifact-render-"));
    const root = join(base, "bus-artifacts");
    try {
      const artifact = publishBusArtifact(root, "hidden body");
      const msg: InboundMessage = {
        namespace: "chat",
        event: "message",
        from: { name: "alice", channel_id: "ch-1" },
        ts: 0,
        payload: {
          text: `read ${artifact.path}`,
          t: BUS_ARTIFACT_REF_TAG,
          v: BUS_ARTIFACT_REF_VERSION,
          ...artifact.ref,
        },
      };
      const expected =
        "Agent Bus message from alice — message artifact unavailable";
      rmSync(artifact.path);
      expect(renderMessageNotification(msg, join(base, "inbox"), root)).toBe(
        expected,
      );
      writeFileSync(artifact.path, "corrupt");
      const corruptLine = renderMessageNotification(
        msg,
        join(base, "inbox"),
        root,
      );
      expect(corruptLine).toBe(expected);
      expect(corruptLine).not.toContain("hidden body");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("json mode keeps a multiline legacy body in one physical record", () => {
    const dir = mkdtempSync(join(tmpdir(), "bus-emit-"));
    try {
      const msg: InboundMessage = {
        namespace: "chat",
        event: "message",
        from: { name: "alice", channel_id: "ch-1" },
        ts: 0,
        payload: { text: "line one\nline two" },
      };
      const out = captureStdout(() => emitJsonMessage(msg, dir));
      expect(out.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(out)).toEqual({
        type: "agent_bus_message",
        line: "Agent Bus message from alice: line one\nline two",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spill failure remains bounded and says the full body is unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "bus-emit-"));
    try {
      const blocker = join(dir, "file");
      writeFileSync(blocker, "not a directory");
      const msg: InboundMessage = {
        namespace: "chat",
        event: "message",
        from: { name: "alice", channel_id: "ch-1" },
        ts: 0,
        payload: { text: "x".repeat(NOTIFY_LINE_BUDGET * 4) },
      };
      const out = captureStdout(() => emitMessage(msg, blocker));
      expect(out).toContain("full message unavailable");
      expect(out.trimEnd().length).toBeLessThanOrEqual(NOTIFY_LINE_BUDGET);
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

describe("watch stdin lifetime", () => {
  test("EOF exits once and arms the input stream", () => {
    const listeners = new Map<string, () => void>();
    let resumed = false;
    const exits: number[] = [];
    armLifetimeStdin(
      {
        once(event, listener) {
          listeners.set(event, listener);
        },
        resume() {
          resumed = true;
        },
      },
      (code) => exits.push(code),
    );
    expect(resumed).toBe(true);
    listeners.get("end")?.();
    listeners.get("close")?.();
    expect(exits).toEqual([0]);
  });
});

describe("watch frame handling (no heartbeat)", () => {
  /** A fake socket capturing every frame the client writes. */
  function fakeWriter(): { writes: string[]; write: (d: string) => number } {
    const writes: string[] = [];
    return {
      writes,
      write(d: string): number {
        writes.push(d);
        return d.length;
      },
    };
  }

  test("register-ack subscribes and sends NO heartbeat traffic", () => {
    const w = fakeWriter();
    handleWatchFrame(w, { type: "ack", op: "register" }, "/tmp/ignored");
    // Only a subscribe — the connection stays open with no periodic heartbeat.
    expect(w.writes).toEqual([`${JSON.stringify({ op: "subscribe" })}\n`]);
  });

  test("a bus-namespace lifecycle frame is skipped (no subscribe, no emit)", () => {
    const w = fakeWriter();
    handleWatchFrame(
      w,
      {
        event: "join",
        namespace: "bus",
        from: { name: "x", channel_id: "c" },
        payload: {},
        ts: 0,
      },
      "/tmp/ignored",
    );
    expect(w.writes).toEqual([]);
  });
});

describe("send result disposition (exit-0 successes vs exit-1 misses)", () => {
  test("transport ambiguity begins only after publish and excludes server rejection", () => {
    expect(sendTransportIsAmbiguous(false, false)).toBe(false);
    expect(sendTransportIsAmbiguous(true, true)).toBe(false);
    expect(sendTransportIsAmbiguous(true, false)).toBe(true);
  });

  test("delivered and queued_for_wake are the exit-0 successes", () => {
    expect(sendResultIsSuccess("delivered")).toBe(true);
    expect(sendResultIsSuccess("queued_for_wake")).toBe(true);
  });

  test("every non-delivery outcome is a loud miss", () => {
    for (const r of [
      "not_connected",
      "unknown_target",
      "ambiguous_target",
      "delivery_failed",
    ] as const) {
      expect(sendResultIsSuccess(r)).toBe(false);
    }
  });

  test("sendSuccessMessage distinguishes a live delivery from a wake-queue", () => {
    expect(sendSuccessMessage("delivered", "bob")).toBe("delivered to bob");
    expect(sendSuccessMessage("queued_for_wake", "planner@fn-1")).toBe(
      "queued_for_wake for planner@fn-1",
    );
  });
});
