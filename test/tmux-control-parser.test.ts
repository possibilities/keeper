/**
 * Fast-tier unit tests for the PURE tmux control-mode stream parser
 * (`src/tmux-control-parser.ts`). NO REAL TMUX — golden byte-string fixtures
 * captured from real `tmux -C` transcripts stand in. Covers: split replies,
 * notifications interleaved mid-block (the misframing guard), unknown verbs,
 * `%exit` with/without reason, the command-number frame match, and the
 * presentation helpers.
 */

import { describe, expect, test } from "bun:test";
import {
  type ControlEvent,
  decodeOctalEscapes,
  parseControlStream,
  splitExtendedOutput,
} from "../src/tmux-control-parser";

describe("parseControlStream — framing", () => {
  test("a single command reply is framed by command number", () => {
    const transcript = [
      "%begin 1700000000 7 1",
      "/dev/ttys001\t0\t12\t34\tmain",
      "%end 1700000000 7 1",
    ].join("\n");
    const events = parseControlStream(transcript);
    expect(events).toEqual([
      {
        kind: "reply",
        cmdNum: 7,
        lines: ["/dev/ttys001\t0\t12\t34\tmain"],
        isError: false,
      },
    ]);
  });

  test("%error trailer marks the reply as an error, still framed by cmdNum", () => {
    const transcript = [
      "%begin 1700000000 9 1",
      "no current client",
      "%error 1700000000 9 1",
    ].join("\n");
    const events = parseControlStream(transcript);
    expect(events).toEqual([
      {
        kind: "reply",
        cmdNum: 9,
        lines: ["no current client"],
        isError: true,
      },
    ]);
  });

  test("a trailer for a DIFFERENT command number stays body (misframing guard)", () => {
    // Inside block 7, a stray `%end … 8` is body, not a close.
    const transcript = [
      "%begin 1700000000 7 1",
      "line-a",
      "%end 1700000000 8 1",
      "line-b",
      "%end 1700000000 7 1",
    ].join("\n");
    const events = parseControlStream(transcript);
    expect(events).toEqual([
      {
        kind: "reply",
        cmdNum: 7,
        lines: ["line-a", "%end 1700000000 8 1", "line-b"],
        isError: false,
      },
    ]);
  });

  test("a %-prefixed line INSIDE a block is body, never a notification", () => {
    const transcript = [
      "%begin 1700000000 3 1",
      "%output %1 some pane bytes",
      "%end 1700000000 3 1",
    ].join("\n");
    const events = parseControlStream(transcript);
    expect(events).toEqual([
      {
        kind: "reply",
        cmdNum: 3,
        lines: ["%output %1 some pane bytes"],
        isError: false,
      },
    ]);
  });

  test("two replies on different command numbers each frame independently", () => {
    const transcript = [
      "%begin 1 1 1",
      "first",
      "%end 1 1 1",
      "%begin 2 2 1",
      "second",
      "%end 2 2 1",
    ].join("\n");
    const events = parseControlStream(transcript);
    const replies = events.filter((e) => e.kind === "reply");
    expect(replies.map((r) => r.cmdNum)).toEqual([1, 2]);
    expect(replies[0]?.lines).toEqual(["first"]);
    expect(replies[1]?.lines).toEqual(["second"]);
  });
});

describe("parseControlStream — notifications", () => {
  test("a known notification in Idle decodes verb + args", () => {
    const events = parseControlStream("%session-window-changed $1 @4\n");
    expect(events).toEqual([
      {
        kind: "notification",
        verb: "session-window-changed",
        args: ["$1", "@4"],
      },
    ]);
  });

  test("a notification with no args decodes to empty args", () => {
    const events = parseControlStream("%sessions-changed\n");
    expect(events).toEqual([
      { kind: "notification", verb: "sessions-changed", args: [] },
    ]);
  });

  // Captured from a live 3.7b `tmux -C` transcript: `source-file` against a
  // config with an unknown command emits `%config-error` as an UNSOLICITED
  // notification (never inside the command's own `%begin`/`%end` reply block,
  // which closes empty) — distinct from a runtime command failure, which
  // replies `%error` inside its block instead.
  test("a live-captured %config-error decodes as an unsolicited notification", () => {
    const transcript = [
      "%begin 1700000000 4 1",
      "%end 1700000000 4 1",
      "%config-error /home/user/.tmux.conf:1: unknown command: bogus-directive",
    ].join("\n");
    const events = parseControlStream(transcript);
    expect(events).toEqual([
      { kind: "reply", cmdNum: 4, lines: [], isError: false },
      {
        kind: "notification",
        verb: "config-error",
        args: [
          "/home/user/.tmux.conf:1:",
          "unknown",
          "command:",
          "bogus-directive",
        ],
      },
    ]);
  });

  test("an unknown %-verb parses-and-ignores (no throw, no emit)", () => {
    const events = parseControlStream("%totally-made-up arg1 arg2\n");
    expect(events).toEqual([]);
  });

  test("a bare % line is ignored", () => {
    expect(parseControlStream("%\n")).toEqual([]);
  });

  test("a non-%-line in Idle is protocol noise and ignored", () => {
    expect(parseControlStream("garbage not a notification\n")).toEqual([]);
  });

  test("notifications interleaved AROUND a block emit in order", () => {
    const transcript = [
      "%session-changed $1 main",
      "%begin 1 5 1",
      "/dev/ttys001\t0\t1\t1\tmain",
      "%end 1 5 1",
      "%window-pane-changed @4 %9",
    ].join("\n");
    const events = parseControlStream(transcript);
    expect(events.map((e) => e.kind)).toEqual([
      "notification",
      "reply",
      "notification",
    ]);
  });
});

describe("parseControlStream — exit", () => {
  test("%exit with no reason", () => {
    expect(parseControlStream("%exit\n")).toEqual([{ kind: "exit" }]);
  });

  test("%exit with a reason", () => {
    expect(parseControlStream("%exit too far behind\n")).toEqual([
      { kind: "exit", reason: "too far behind" },
    ]);
  });
});

describe("parseControlStream — robustness", () => {
  test("a malformed %begin header (no command number) is dropped, stays Idle", () => {
    // No cmdNum → header dropped; the following plain line stays Idle noise; the
    // later real notification still surfaces.
    const transcript = ["%begin", "noise", "%sessions-changed"].join("\n");
    expect(parseControlStream(transcript)).toEqual([
      { kind: "notification", verb: "sessions-changed", args: [] },
    ]);
  });

  test("a %begin with a non-integer command number is dropped", () => {
    expect(parseControlStream("%begin 1 notanum 1\n")).toEqual([]);
  });

  test("empty input yields no events and never throws", () => {
    expect(parseControlStream("")).toEqual([]);
  });

  test("a huge notification burst parses without spinning", () => {
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push("%sessions-changed");
    }
    const events = parseControlStream(lines.join("\n"));
    expect(events).toHaveLength(5000);
    expect(events.every((e: ControlEvent) => e.kind === "notification")).toBe(
      true,
    );
  });
});

describe("presentation helpers", () => {
  test("decodeOctalEscapes decodes three-digit octal", () => {
    // \015 = CR, \012 = LF.
    expect(decodeOctalEscapes("a\\015\\012b")).toBe("a\r\nb");
  });

  test("decodeOctalEscapes leaves non-octal escapes intact", () => {
    expect(decodeOctalEscapes("plain text")).toBe("plain text");
  });

  test("splitExtendedOutput splits at the FIRST colon", () => {
    expect(splitExtendedOutput("%1 :value:with:colons")).toEqual({
      header: "%1 ",
      value: "value:with:colons",
    });
  });

  test("splitExtendedOutput returns null with no colon", () => {
    expect(splitExtendedOutput("no colon here")).toBeNull();
  });
});
