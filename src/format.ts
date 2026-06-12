// Emitter spine — the byte-parity port of planctl/_util.py's json_dumps /
// yaml_dump / format_output and planctl/output.py's emit_error.
//
// Two JSON serializers that must never cross: the primary payload is
// pretty-printed (2-space indent + one explicit trailing newline), the trailer
// is compact (no spaces). The YAML path matches PyYAML block style via js-yaml.

import yaml from "js-yaml";

export type OutputFormat = "json" | "yaml" | "human";

/** Pretty JSON: 2-space indent, one trailing newline, unicode preserved. */
export function jsonDumps(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Compact JSON: no spaces — the trailer-line serializer (Python separators=(",",":")). */
export function compactJson(data: unknown): string {
  return JSON.stringify(data);
}

/**
 * YAML matching PyYAML's _LiteralDumper: block style, literal block scalars for
 * multiline strings, no key sorting, unicode preserved. js-yaml's noArrayIndent
 * reproduces PyYAML's dash-at-parent-indent; lineWidth -1 disables folding.
 */
export function yamlDump(data: unknown): string {
  return yaml.dump(data, {
    noArrayIndent: true,
    lineWidth: -1,
    sortKeys: false,
  });
}

/**
 * Sole stdout emission path for verb payloads. JSON by default; a non-explicit
 * format auto-upgrades to human on a TTY. human falls back to JSON when no
 * renderer is supplied. Mirrors format_output's exactly-one-trailing-newline
 * normalization and EPIPE swallow.
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
      writeStdout(`${yamlDump(data).replace(/\n+$/, "")}\n`);
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
