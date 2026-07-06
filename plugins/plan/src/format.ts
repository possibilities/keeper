// Emitter spine — the byte-parity port of planctl/_util.py's json_dumps /
// format_output and planctl/output.py's emit_error.
//
// Two JSON serializers that must never cross: the primary payload is
// pretty-printed (2-space indent + one explicit trailing newline), the trailer
// is compact (no spaces).

import { yamlDump } from "../../prompt/src/yaml_dump.ts";

export type OutputFormat = "json" | "yaml" | "human";

/** Pretty JSON: 2-space indent, one trailing newline, unicode preserved. */
export function jsonDumps(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Compact JSON: no spaces — the trailer-line serializer (Python separators=(",",":")). */
export function compactJson(data: unknown): string {
  return JSON.stringify(data);
}

/** Python json.dumps() DEFAULT serialization: ", " / ": " separators,
 * ensure_ascii=True (\uXXXX for every code unit >= 0x7f), dict order preserved.
 * Used for validate --epic's second invocation line, which Python prints with
 * json.dumps(obj) (no separators override) — distinct from the compact trailer. */
export function pyDefaultJson(data: unknown): string {
  return pyEnsureAscii(
    JSON.stringify(data, null, 0).replace(
      /("(?:[^"\\]|\\.)*")|,|:/g,
      (m, str) => (str !== undefined ? str : m === "," ? ", " : ": "),
    ),
  );
}

/** \uXXXX-escape every code unit >= 0x7f, reproducing Python ensure_ascii=True. */
function pyEnsureAscii(serialized: string): string {
  let out = "";
  for (let i = 0; i < serialized.length; i += 1) {
    const code = serialized.charCodeAt(i);
    out +=
      code >= 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : serialized[i];
  }
  return out;
}

/** Serialize `data` to block-style YAML through the shared PyYAML-parity
 * serializer, normalized to exactly one trailing newline. */
export function yamlDumps(data: unknown): string {
  return `${yamlDump(data).replace(/\n+$/, "")}\n`;
}

/**
 * Sole stdout emission path for verb payloads. JSON by default; a non-explicit
 * format auto-upgrades to human on a TTY. `yaml` renders through the shared
 * serializer; `human` falls back to JSON when no renderer is supplied. Mirrors
 * format_output's exactly-one-trailing-newline normalization and EPIPE swallow.
 */
export function formatOutput(
  data: unknown,
  format: OutputFormat | null,
  textRenderer?: (data: unknown) => string,
): void {
  let fmt: OutputFormat = format ?? "json";
  if (format === null && process.stdout.isTTY) {
    fmt = "human";
  }

  try {
    if (fmt === "yaml") {
      writeStdout(yamlDumps(data));
    } else if (fmt === "human" && textRenderer) {
      const rendered = textRenderer(data);
      writeStdout(`${rendered.replace(/\n+$/, "")}\n`);
    } else {
      writeStdout(jsonDumps(data));
    }
  } catch (err) {
    if (isEpipe(err)) {
      return;
    }
    throw err;
  }
}

/** Emit {success:false, error:msg} via format_output and exit `code`. */
export function emitError(
  msg: string,
  format: OutputFormat | null,
  code = 1,
): never {
  formatOutput({ success: false, error: msg }, format);
  process.exit(code);
}

function isEpipe(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "EPIPE"
  );
}

function writeStdout(text: string): void {
  process.stdout.write(text);
}
