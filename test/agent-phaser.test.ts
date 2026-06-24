/**
 * Phaser: quiet mode prints nothing and still runs the body; chatty mode prints
 * one line per section (`~ label`). The `  (Nms)` timing line appears only when
 * showTiming is set (--agentwrap-very-verbose) and the phase is slow (>=50ms).
 * The clock and the write sink are injected.
 */

import { describe, expect, test } from "bun:test";
import { makePhaser } from "../src/agent/phaser";

describe("makePhaser", () => {
  test("quiet mode runs the body and prints nothing", () => {
    const out: string[] = [];
    const phase = makePhaser(true, (s) => out.push(s));
    expect(phase("x", () => 42)).toBe(42);
    expect(out).toEqual([]);
  });

  test("chatty prints one line per section, no timing without showTiming", () => {
    const out: string[] = [];
    let t = 0;
    const phase = makePhaser(
      false,
      (s) => out.push(s),
      false,
      () => t,
    );
    phase("slow", () => {
      t = 60; // would be slow, but timing is off
    });
    expect(out).toEqual(["~ slow\n"]);
  });

  test("showTiming fast phase prints only the label", () => {
    const out: string[] = [];
    let t = 0;
    const phase = makePhaser(
      false,
      (s) => out.push(s),
      true,
      () => t,
    );
    phase("fast", () => {
      t = 10; // 10ms < 50ms threshold
    });
    expect(out).toEqual(["~ fast\n"]);
  });

  test("showTiming slow phase appends the elapsed line", () => {
    const out: string[] = [];
    let t = 0;
    const phase = makePhaser(
      false,
      (s) => out.push(s),
      true,
      () => t,
    );
    phase("slow", () => {
      t = 60; // 60ms >= 50ms threshold
    });
    expect(out).toEqual(["~ slow\n", "  (60ms)\n"]);
  });

  test("body return value is forwarded", () => {
    const phase = makePhaser(
      false,
      () => {},
      false,
      () => 0,
    );
    expect(phase("x", () => "result")).toBe("result");
  });
});
