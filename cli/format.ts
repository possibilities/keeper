/**
 * `--format json|yaml|human` resolution + rendering for the keeper-native
 * finite-output readers (ADR 0008).
 *
 * The one output-format idiom across keeper: `--format json|yaml|human` with
 * `--json` a documented alias of `--format json`. A reader's SUPPORTED modes are
 * read from its pure-data descriptor `format_modes` (never a second table), so a
 * request for a mode the command cannot render is a usage fault — never a silent
 * JSON fallback. yaml renders through the shared PyYAML-parity serializer so a
 * yq consumer round-trips the same value a jq consumer reads.
 *
 * Exit stance: a conflicting (`--json --format yaml`) or unsupported request is a
 * grammar fault the caller surfaces on stderr with exit 2, never an `ok:false`
 * envelope (that is reserved for a transport failure).
 */

import { yamlDump } from "../plugins/prompt/src/yaml_dump.ts";
import type { FormatMode } from "./descriptor";
import { nativeDescriptor } from "./descriptor";
import type { Envelope, EnvelopeSink } from "./envelope";

/** The resolved effective format for one invocation. */
export interface FormatResolved {
  ok: true;
  format: FormatMode;
}

/** A grammar fault (conflict or unsupported mode) — the caller exits 2. */
export interface FormatRejected {
  ok: false;
  message: string;
}

/** Resolve the effective output format from a command's parsed `--format` value
 *  and its `--json` alias boolean, validated against the command's declared
 *  `format_modes`. Precedence + faults:
 *   - neither flag → the command's default (json).
 *   - `--json` alone → json.
 *   - `--format X` → X, iff X is a declared mode; else a usage fault.
 *   - `--json` together with `--format <non-json>` → a conflict fault (the alias
 *     contradicts the explicit mode).
 *  Reads the supported set from the descriptor so it cannot drift from what the
 *  index advertises. */
export function resolveFormat(
  command: string,
  values: { format?: unknown; json?: unknown },
): FormatResolved | FormatRejected {
  const supported = nativeDescriptor(command)?.format_modes ?? ["json"];
  const rawFormat = typeof values.format === "string" ? values.format : null;
  const jsonAlias = values.json === true;

  if (rawFormat !== null && jsonAlias && rawFormat !== "json") {
    return {
      ok: false,
      message:
        `--json is an alias of --format json and conflicts with ` +
        `--format ${rawFormat}; pass only one`,
    };
  }

  const requested = rawFormat ?? "json";
  if (!supported.includes(requested as FormatMode)) {
    return {
      ok: false,
      message: `Invalid value for '--format': '${requested}' is not one of ${supported
        .map((m) => `'${m}'`)
        .join(", ")}`,
    };
  }
  return { ok: true, format: requested as FormatMode };
}

/** Render one envelope to its wire string in `format`: pretty JSON (2-space
 *  indent + one trailing newline — byte-identical to the json-only emit path) or
 *  block YAML through the shared serializer, normalized to one trailing newline.
 *  A `human` value (never produced for an envelope reader) degrades to JSON. */
export function renderEnvelope<D>(
  env: Envelope<D>,
  format: FormatMode,
): string {
  if (format === "yaml") {
    return `${yamlDump(env).replace(/\n+$/, "")}\n`;
  }
  return `${JSON.stringify(env, null, 2)}\n`;
}

/** Print the envelope in `format` on stdout, then exit under the envelope exit
 *  model (`ok:true` → 0, `ok:false` → 1). The format-aware sibling of
 *  `emitEnvelope` the finite-output readers use once they resolve their mode. */
export function emitEnvelopeFormatted<D>(
  env: Envelope<D>,
  sink: EnvelopeSink,
  format: FormatMode,
): void {
  sink.writeStdout(renderEnvelope(env, format));
  sink.exit(env.ok ? 0 : 1);
}
