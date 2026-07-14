/**
 * Pure-data descriptor module for `keeper prompt` (ADR 0008).
 *
 * The SINGLE source of truth for the prompt CLI's verb surface: `src/cli.ts`
 * renders both the top-level Commands listing and each verb's `--help` leaf help
 * from {@link PROMPT_COMMANDS}, and the dispatcher resolves a verb name against
 * the same table — so a documented verb can never drift from a dispatchable one.
 *
 * PURITY CONTRACT: this module is dependency-free data + types. It imports only
 * the descriptor TYPES from the native `cli/descriptor.ts` (erased at build) and
 * pulls in NO verb implementation module, so the help path — which the CLI reaches
 * before constructing any dependency — never touches the filesystem corpus. Keep
 * it types + literals only; an import-graph test pins this.
 *
 * Conforms to the ordinal-1 {@link CommandDescriptor} shape so `cli/keeper.ts` can
 * consume these entries for `keeper --help --json` and completions, extended with
 * a prompt-local positional-argument list ({@link PromptArgDescriptor}) the leaf
 * help renders in its Arguments section.
 */

import type {
  CommandDescriptor,
  FlagDescriptor,
} from "../../../cli/descriptor.ts";

/** One positional argument of a prompt verb, rendered in the Arguments section of
 *  its leaf help. `name` is the uppercase metavar shown in the usage tail. */
export interface PromptArgDescriptor {
  readonly name: string;
  readonly summary: string;
  /** Shown bare (`REF`) in the usage tail when required, bracketed (`[REF]`) when
   *  optional. */
  readonly required: boolean;
}

/** A prompt verb: the ordinal-1 command shape plus its positional arguments. */
export interface PromptCommandDescriptor extends CommandDescriptor {
  readonly args?: readonly PromptArgDescriptor[];
}

// ── shared option fragments ──────────────────────────────────────────────────

const FLAG_PROJECT_ROOT: FlagDescriptor = {
  name: "project-root",
  type: "string",
  summary: "Corpus project root (default: auto-detect from cwd)",
};

// ── verb table ───────────────────────────────────────────────────────────────
//
// Registration order = help-listing order (alphabetical, matching click). Every
// verb declares its real option surface (the flags `src/cli.ts` reads in
// dispatch) plus its positional arguments. The global `--format` and `--help`/`-h`
// options are injected by the leaf-help renderer and omitted here.

export const PROMPT_COMMANDS: readonly PromptCommandDescriptor[] = [
  {
    name: "build-snippets",
    summary: "Build _partials/snippets/_index.yaml from classified snippets.",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    flags: [
      {
        name: "check",
        type: "boolean",
        summary:
          "Verify the index is current; exit non-zero on drift (no write)",
      },
    ],
  },
  {
    name: "check-generated",
    summary:
      "Detect the managed-file sidecar; emit the generated-guard message.",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json"],
    flags: [
      {
        name: "on",
        type: "string",
        summary:
          "Hook phase: 'read' (heads-up) or 'write' (block); default write",
      },
    ],
    args: [
      {
        name: "FILE",
        summary: "File whose managed-file sidecar to inspect",
        required: false,
      },
    ],
  },
  {
    name: "compile",
    summary: "Compile a role or bundle into target-native agent definitions.",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json"],
    flags: [
      {
        name: "bundle",
        type: "string",
        summary: "Fully-qualified catalog bundle to ensure",
      },
      {
        name: "role",
        type: "string",
        summary: "Fully-qualified static role to ensure",
      },
      {
        name: "target",
        type: "string",
        summary: "Publication target (this slice: pi)",
      },
      {
        name: "agent-dir",
        type: "string",
        summary: "Pi agent root (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)",
      },
      {
        name: "check",
        type: "boolean",
        summary: "Verify outputs without writing; exit non-zero on drift",
      },
      FLAG_PROJECT_ROOT,
    ],
  },
  {
    name: "find-snippets",
    summary: "BM25-rank snippets against a query, with excerpts.",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json", "human"],
    flags: [
      {
        name: "domain",
        type: "string",
        summary: "Restrict to a snippet domain",
      },
      { name: "scope", type: "string", summary: "Restrict to a scope" },
      { name: "phase", type: "string", summary: "Restrict to a phase" },
      {
        name: "bundle",
        type: "string",
        summary: "Restrict to a bundle's members",
      },
      {
        name: "limit",
        type: "string",
        summary: "Max ranked rows (positive int)",
      },
      FLAG_PROJECT_ROOT,
    ],
    args: [
      {
        name: "QUERY",
        summary: "Free-text query to rank against",
        required: true,
      },
    ],
  },
  {
    name: "list-bundles",
    summary: "List bundles across one or all runtime namespaces.",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json", "human"],
    flags: [
      {
        name: "namespace",
        type: "string",
        summary: "Scope to one namespace (default: all)",
      },
    ],
  },
  {
    name: "list-snippets",
    summary: "Enumerate every snippet id (unranked), optionally by --domain.",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json", "human"],
    flags: [
      {
        name: "domain",
        type: "string",
        summary: "Restrict to a snippet domain",
      },
      FLAG_PROJECT_ROOT,
    ],
  },
  {
    name: "render",
    summary: "Render a substrate ref (bundle/, sketch/, or bare snippet id).",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    flags: [FLAG_PROJECT_ROOT],
    args: [
      {
        name: "REF",
        summary: "Substrate ref: bundle/…, sketch/…, or a bare snippet id",
        required: true,
      },
    ],
  },
  {
    name: "render-plugin-templates",
    summary: "Render every plugin's command/skill/agent templates.",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    flags: [FLAG_PROJECT_ROOT],
  },
  {
    name: "save-bundle",
    summary: "Atomically write a runtime bundle (bundle/ or sketch/).",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json", "human"],
    flags: [
      {
        name: "snippets",
        type: "string",
        summary: "CSV of snippet ids to include",
      },
      { name: "summary", type: "string", summary: "Bundle summary line" },
      { name: "tags", type: "string", summary: "CSV of tags" },
      {
        name: "append",
        type: "boolean",
        summary: "Append to an existing bundle instead of replacing",
      },
      {
        name: "force",
        type: "boolean",
        summary: "Overwrite an existing bundle",
      },
    ],
    args: [
      {
        name: "REF",
        summary: "Bundle ref to write (bundle/… or sketch/…)",
        required: true,
      },
    ],
  },
  {
    name: "save-snippet",
    summary: "Atomically write a snippet and update _index.yaml.",
    visibility: "public",
    mutates: true,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json", "human"],
    flags: [
      { name: "name", type: "string", summary: "Snippet name (required)" },
      { name: "domain", type: "string", summary: "Snippet domain (required)" },
      {
        name: "summary",
        type: "string",
        summary: "One-line summary (required)",
      },
      {
        name: "body",
        type: "string",
        summary: "Snippet body (default: stdin)",
      },
      { name: "tags", type: "string", summary: "CSV of tags" },
      { name: "scope", type: "string", summary: "Classification scope" },
      { name: "phase", type: "string", summary: "Classification phase" },
      {
        name: "related",
        type: "string",
        summary: "CSV of related snippet ids",
      },
      {
        name: "audience",
        type: "string",
        summary: "Audience (default: agent)",
      },
      {
        name: "severity",
        type: "string",
        summary: "Severity (default: default)",
      },
      {
        name: "force",
        type: "boolean",
        summary: "Overwrite an existing snippet",
      },
    ],
  },
  {
    name: "show-bundle",
    summary: "Load and emit a single bundle YAML by ref.",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    format_modes: ["json", "human"],
    flags: [],
    args: [
      {
        name: "REF",
        summary: "Bundle ref to load (bundle/… or sketch/…)",
        required: true,
      },
    ],
  },
  {
    name: "validate-bundles",
    summary: "Resolve every bundle snippet_id; non-zero on any miss.",
    visibility: "public",
    mutates: false,
    requires_daemon: false,
    requires_tty: false,
    flags: [],
  },
];
