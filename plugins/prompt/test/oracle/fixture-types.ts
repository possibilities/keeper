// Shared shape of the recorded golden fixtures. Both the capture script and the
// regression-pin suite import these so the on-disk layout has one definition.

/** One recorded `keeper prompt render <ref>` invocation. */
export interface RenderFixture {
  /** The substrate ref rendered (bare snippet id, `bundle/<name>`, or
   *  `sketch/<name>`). */
  ref: string;
  /** Raw stdout bytes, base64-encoded so trailing-newline / non-ASCII shape
   *  survives JSON round-trip exactly. */
  stdout_b64: string;
  /** Process exit code. */
  exit_code: number;
}

/** One recorded `keeper prompt check-generated <file> --on <mode>` invocation,
 *  captured against a hermetically-rendered plan-plugin tree. */
export interface CheckGeneratedFixture {
  /** The target file, relative to the temp render root the tree was rendered
   *  under (path-stable). */
  target_relative: string;
  /** The `--on` mode the envelope was captured under. */
  on: "read" | "write";
  /** The parsed JSON envelope, with absolute roots already tokenized to
   *  placeholders at capture time. */
  envelope_raw: Record<string, unknown>;
  /** Process exit code. */
  exit_code: number;
}

/** One rendered output file (or sidecar) produced by render-plugin-templates. */
export interface PluginTemplateFile {
  /** Path relative to the rendered plugin root (path-stable). */
  relative: string;
  /** File content, base64-encoded for exact byte fidelity. */
  content_b64: string;
  /** True when this entry is a `.managed-file-dont-edit` sidecar. */
  is_sidecar: boolean;
}

/** The full render-plugin-templates capture for one plugin root. */
export interface PluginTemplatesFixture {
  /** Which plugin tree was rendered, repo-relative to the keeper root. */
  plugin_root_relative: string;
  /** Raw stdout (the `✓ Rendered …` lines), with roots tokenized. */
  stdout: string;
  /** Process exit code. */
  exit_code: number;
  /** Every output file + sidecar the verb produced, sorted by `relative`. */
  files: PluginTemplateFile[];
}

/** Top-level manifest written alongside the per-verb fixtures. */
export interface OracleManifest {
  /** The live absolute roots the capture ran against — recorded so the
   *  regression-pin suite can re-tokenize for a host-independent compare. */
  arthack_root: string;
  keeper_root: string;
  /** Path to the `keeper` binary that recorded the goldens, for drift forensics
   *  if a later capture diverges. */
  oracle_path: string;
  /** ISO capture timestamp (forensic only; never asserted). */
  captured_at: string;
}
