// Conformance guard: no plan verb source may carry a raw NUL or other C0
// control byte (outside \t/\n/\r), since git records such a file as binary
// (`-text`), suppressing its diff from review and hiding it from blame/grep.
// A dedup or delimiter need lands via an escape sequence (`\0`, `\x1f`, ...)
// in source text, never a literal control byte.

import { describe, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VERBS_DIR = join(import.meta.dir, "..", "src", "verbs");

// Allowed control bytes: tab (9), LF (10), CR (13). Byte-range check (not a
// regex) so no control-character-in-regex lint concern.
function isDisallowedControlByte(byte: number): boolean {
  return byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13;
}

function verbSourceFiles(): string[] {
  return readdirSync(VERBS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(VERBS_DIR, name));
}

describe("verb sources carry no raw control bytes", () => {
  for (const file of verbSourceFiles()) {
    test(file.slice(VERBS_DIR.length + 1), () => {
      const buf = readFileSync(file);
      const idx = buf.findIndex((byte) => isDisallowedControlByte(byte));
      if (idx === -1) {
        return;
      }
      const byte = buf[idx] ?? 0;
      throw new Error(
        `raw control byte 0x${byte.toString(16).padStart(2, "0")} at offset ${idx} in ${file}`,
      );
    });
  }
});
