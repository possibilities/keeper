/**
 * Unit tests for the shared one-shot CLI envelope helper (`cli/envelope.ts`) —
 * the primitives `keeper status` and `keeper query` build their envelopes from.
 * Pure / socket-free: the sink is a capturing harness, never a real process.
 */

import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";
import {
  type EnvelopeSink,
  emitEnvelope,
  errorEnvelope,
  RECOVERY_DAEMON_DOWN,
  successEnvelope,
} from "../cli/envelope";
import {
  emitEnvelopeFormatted,
  renderEnvelope,
  resolveFormat,
} from "../cli/format";

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

// ---------------------------------------------------------------------------
// cli/format — the `--format json|yaml|human` grammar the finite-output readers
// resolve against their descriptor `format_modes`, plus the yaml/json renderer.
// ---------------------------------------------------------------------------

describe("resolveFormat", () => {
  test("neither flag defaults to json", () => {
    const r = resolveFormat("status", {});
    expect(r).toEqual({ ok: true, format: "json" });
  });

  test("--json alias resolves json", () => {
    expect(resolveFormat("status", { json: true })).toEqual({
      ok: true,
      format: "json",
    });
  });

  test("--format yaml resolves yaml on a reader that declares it", () => {
    expect(resolveFormat("status", { format: "yaml" })).toEqual({
      ok: true,
      format: "yaml",
    });
  });

  test("--format human is unsupported on a json/yaml reader (exit-2 fault)", () => {
    const r = resolveFormat("status", { format: "human" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("--format");
      // The message names the modes it CAN render — never the rejected one as ok.
      expect(r.message).toContain("json");
      expect(r.message).toContain("yaml");
    }
  });

  test("--format bogus is rejected naming the supported modes", () => {
    const r = resolveFormat("query", { format: "bogus" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("'bogus'");
  });

  test("--json together with --format yaml is a conflict (contradiction)", () => {
    const r = resolveFormat("status", { format: "yaml", json: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("conflicts");
  });

  test("--json together with --format json is NOT a conflict", () => {
    expect(resolveFormat("status", { format: "json", json: true })).toEqual({
      ok: true,
      format: "json",
    });
  });

  test("watch renders json only: yaml is unsupported, --json is accepted", () => {
    expect(resolveFormat("watch", { format: "yaml" }).ok).toBe(false);
    expect(resolveFormat("watch", { json: true })).toEqual({
      ok: true,
      format: "json",
    });
  });
});

describe("renderEnvelope", () => {
  test("json is the pretty 2-space form with one trailing newline (unchanged bytes)", () => {
    const env = successEnvelope(1, { a: 1 });
    expect(renderEnvelope(env, "json")).toBe(
      `${JSON.stringify(env, null, 2)}\n`,
    );
  });

  test("yaml round-trips to the same envelope value a json consumer reads", () => {
    const env = successEnvelope(3, { rows: [{ id: "x" }], note: "Café ☕" });
    const text = renderEnvelope(env, "yaml");
    expect(text.endsWith("\n")).toBe(true);
    expect(yaml.load(text)).toEqual(env);
  });
});

describe("emitEnvelopeFormatted exit model", () => {
  test("ok:true yaml prints on stdout and exits 0", () => {
    const h = harness();
    try {
      emitEnvelopeFormatted(successEnvelope(1, { a: 1 }), h.sink, "yaml");
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }
    expect(h.code).toBe(0);
    expect(yaml.load(h.out.join(""))).toEqual(successEnvelope(1, { a: 1 }));
  });

  test("ok:false still exits 1 under any format", () => {
    const h = harness();
    try {
      emitEnvelopeFormatted(
        errorEnvelope(1, { code: "x", message: "m", recovery: "r" }),
        h.sink,
        "yaml",
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }
    expect(h.code).toBe(1);
  });
});
