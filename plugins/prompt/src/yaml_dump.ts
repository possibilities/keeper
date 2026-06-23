// Canonical YAML emitter for the prompt plugin's on-disk bundle writer.
// Block-style mapping output matching PyYAML's _LiteralDumper: literal block
// scalars for multiline strings, no key sorting, unicode preserved. js-yaml's
// noArrayIndent reproduces PyYAML's dash-at-parent-indent; lineWidth -1 disables
// folding. These options are load-bearing — the saved bundle YAML is byte-pinned.

import yaml from "js-yaml";

/** Serialize `data` to block-style YAML with PyYAML-matching options. */
export function yamlDump(data: unknown): string {
  return yaml.dump(data, {
    noArrayIndent: true,
    lineWidth: -1,
    sortKeys: false,
  });
}
