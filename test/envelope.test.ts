/**
 * Unit tests for the shared one-shot CLI envelope helper (`cli/envelope.ts`) —
 * the primitives `keeper status` and `keeper query` build their envelopes from.
 * Pure / socket-free: the sink is a capturing harness, never a real process.
 */

import { describe, expect, test } from "bun:test";
import {
  type EnvelopeSink,
  emitEnvelope,
  errorEnvelope,
  RECOVERY_DAEMON_DOWN,
  successEnvelope,
} from "../cli/envelope";

class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function harness() {
  const out: string[] = [];
  let code: number | null = null;
  const sink: EnvelopeSink = {
    writeStdout: (s: string) => out.push(s),
    exit: (c: number): never => {
      code = c;
      throw new ExitError(c);
    },
  };
  return {
    out,
    get code() {
      return code;
    },
    sink,
  };
}

function emit(sink: EnvelopeSink, env: Parameters<typeof emitEnvelope>[0]) {
  try {
    emitEnvelope(env, sink);
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
  }
}

describe("successEnvelope", () => {
  test("wraps the payload with ok:true, error:null, the injected version", () => {
    const env = successEnvelope(7, { rows: [1, 2] });
    expect(env).toEqual({
      schema_version: 7,
      ok: true,
      error: null,
      data: { rows: [1, 2] },
    });
  });
});

describe("errorEnvelope", () => {
  test("wraps the problem with ok:false, data:null, the injected version", () => {
    const env = errorEnvelope(3, {
      code: "query_failed",
      message: "boom",
      recovery: "retry",
    });
    expect(env).toEqual({
      schema_version: 3,
      ok: false,
      error: { code: "query_failed", message: "boom", recovery: "retry" },
      data: null,
    });
  });
});

describe("emitEnvelope exit model", () => {
  test("ok:true prints pretty JSON on stdout and exits 0", () => {
    const h = harness();
    emit(h.sink, successEnvelope(1, { a: 1 }));
    expect(h.code).toBe(0);
    const printed = h.out.join("");
    expect(printed.endsWith("\n")).toBe(true);
    // pretty-printed (2-space) so a human reader can scan it.
    expect(printed).toContain('\n  "ok": true');
    expect(JSON.parse(printed).data).toEqual({ a: 1 });
  });

  test("ok:false prints the envelope on stdout and exits 1", () => {
    const h = harness();
    emit(
      h.sink,
      errorEnvelope(1, {
        code: "query_failed",
        message: "down",
        recovery: RECOVERY_DAEMON_DOWN,
      }),
    );
    expect(h.code).toBe(1);
    const env = JSON.parse(h.out.join(""));
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("query_failed");
    expect(env.error.recovery).toBe(RECOVERY_DAEMON_DOWN);
    expect(env.data).toBeNull();
  });
});
