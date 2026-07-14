// YAML input wrapper — the parity peer of planctl's pyyaml ``safe_load`` for the
// creation surface (scaffold / refine-apply) plus a bounded reader for the
// ``--file <path>`` / ``--file -`` source.
//
// PARSER UNITY: every bun YAML *input* parses through ``parseYamlInput`` (this
// module) so scaffold, refine-apply, and config.loadRoots share one parser with
// one set of implicit-typing rules. pyyaml ``safe_load`` is YAML 1.1, so the
// wrapper pins eemeli ``yaml`` to ``version: "1.1"`` and disables unique-key
// rejection — js-yaml's default (1.2-ish, THROWS on duplicate keys) would
// diverge on the pinned scalar matrix:
//
//   * norway booleans (``no``/``yes``/``on``/``off``) -> bool, NOT the string
//     -> the downstream string guards fire (a non-string ``tier`` is bad_yaml,
//     a bad-string tier is tier_invalid: the type-vs-value fork).
//   * octal ``010`` -> int 8, underscore ``1_0`` -> int 10 (the COERCED integer
//     is what reaches the dep-ordinal range check / its message).
//   * an ISO-date-shaped scalar (``2024-01-01``) -> a Date, NOT a string -> the
//     title guard fires.
//   * duplicate keys are silent last-wins (pyyaml does not throw); the second
//     value lands on disk.
//
// The 1 MiB cap is applied BEFORE the parse (billion-laughs / resource defense):
// a ``--file <path>`` is read whole, so the cap message carries the real byte
// length; ``--file -`` reads MAX+1 bytes off stdin (reject-don't-truncate), so an
// over-cap stream always reports the truncated-read count MAX+1 regardless of how
// many bytes were piped. A TTY stdin is rejected (no silent keyboard hang).

import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { readStdinBytes, stdinIsTTY } from "./stdin.ts";

/** Pre-decode byte cap for any YAML input source. Mirrors
 * run_scaffold._MAX_YAML_BYTES / run_refine_apply._MAX_YAML_BYTES. */
export const MAX_YAML_BYTES = 1 * 1024 * 1024;

/** A bounded-read / cap / TTY failure carrying scaffold's exact bad_yaml
 * envelope triplet. The caller routes ``code`` / ``message`` / ``details``
 * straight into its accumulate-all failure emit — these never bubble as a raw
 * throw past the verb boundary. */
export class YamlInputError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[]) {
    super(message);
    this.name = "YamlInputError";
    this.code = code;
    this.details = details;
  }
}

/** Read the raw YAML bytes for ``--file <fileArg>`` under the 1 MiB cap.
 *
 * ``fileArg === "-"`` reads stdin: a TTY is rejected (``bad_yaml``, "stdin is a
 * TTY …"); otherwise MAX+1 bytes are read (reject-don't-truncate), so an
 * over-cap stream reports got=MAX+1 no matter how much was piped. Any other
 * ``fileArg`` is read whole, so the cap message carries the real file length.
 *
 * Throws YamlInputError on a read failure or an over-cap source — the caller
 * maps it onto its failure envelope. Returns the raw bytes otherwise (the parse
 * is a separate step so callers can label the source). */
export function readYamlBytes(fileArg: string): Buffer {
  const label = fileArg;
  let raw: Buffer;
  if (fileArg === "-") {
    if (stdinIsTTY()) {
      throw new YamlInputError(
        "bad_yaml",
        "stdin is a TTY — pass `--file <path>` or pipe YAML on stdin",
        ["file: -"],
      );
    }
    try {
      // Read MAX+1 bytes; the cap gives the truncated read so an over-cap stream
      // reports got=MAX+1 (matching sys.stdin.buffer.read(N)).
      raw = readStdinBytes(MAX_YAML_BYTES + 1);
    } catch (exc) {
      throw new YamlInputError(
        "bad_yaml",
        `Could not read YAML from stdin: ${describeError(exc)}`,
        ["file: -"],
      );
    }
  } else {
    try {
      raw = readFileSync(fileArg);
    } catch (exc) {
      throw new YamlInputError(
        "bad_yaml",
        `Could not read YAML file: ${describeError(exc)}`,
        [`file: ${label}`],
      );
    }
  }

  if (raw.length > MAX_YAML_BYTES) {
    throw new YamlInputError(
      "bad_yaml",
      `YAML file exceeds ${MAX_YAML_BYTES} bytes (got ${raw.length})`,
      [`file: ${label}`],
    );
  }
  return raw;
}

/** Parse raw YAML bytes the pyyaml-safe_load way (YAML 1.1, duplicate-key
 * last-wins). ``fileLabel`` is the source tag woven into a parse-error envelope.
 * Throws YamlInputError(bad_yaml) on invalid UTF-8 or a YAML syntax error;
 * returns the parsed document (any JS value, or undefined for an empty doc). */
export function parseYamlInput(raw: Buffer, fileLabel: string): unknown {
  return parseYamlBytes(raw, fileLabel, false);
}

/** Parse compiler control data with the same YAML 1.1 scalar semantics as the
 * shared plan loader while rejecting duplicate mapping keys. This is an opt-in
 * seam: plan creation inputs deliberately retain their last-key-wins behavior. */
export function parseStrictYamlInput(raw: Buffer, fileLabel: string): unknown {
  return parseYamlBytes(raw, fileLabel, true);
}

function parseYamlBytes(
  raw: Buffer,
  fileLabel: string,
  uniqueKeys: boolean,
): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (exc) {
    throw new YamlInputError(
      "bad_yaml",
      `YAML file is not valid UTF-8: ${describeError(exc)}`,
      [`file: ${fileLabel}`],
    );
  }

  try {
    return parseYaml(text, { version: "1.1", uniqueKeys });
  } catch (exc) {
    throw new YamlInputError(
      "bad_yaml",
      `YAML parse error: ${describeError(exc)}`,
      [`file: ${fileLabel}`],
    );
  }
}

/** Read-then-parse for callers that don't need to inspect the raw bytes:
 * ``readYamlBytes`` under the cap, then ``parseYamlInput``. The shared entry
 * point for config.loadRoots and any non-mutating YAML reader. */
export function loadYamlInput(fileArg: string): unknown {
  return parseYamlInput(readYamlBytes(fileArg), fileArg);
}

function describeError(exc: unknown): string {
  if (exc instanceof Error) {
    return exc.message;
  }
  return String(exc);
}
