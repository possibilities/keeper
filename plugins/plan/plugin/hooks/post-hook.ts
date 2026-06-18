#!/usr/bin/env bun
// PostToolUse(Read) generated-file heads-up.
//
// Injects a non-blocking note when reading a file that carries the
// `_promptctl_path` frontmatter marker: shells `promptctl check-generated
// <file> --on read` and, when the envelope reports `marked: true`, emits the
// softer warn-variant message via `additionalContext` so the agent knows the
// file is generated before trying to edit it. Fail open on every path (exit 0,
// silent) — surfacing tool noise just because promptctl was off PATH is wrong
// for the read path.

import { emitAdditionalContext, readStdin, runPromptctl } from "./lib.ts";

async function main(): Promise<void> {
  const raw = await readStdin();
  const payload = JSON.parse(raw) as {
    tool_name?: string;
    tool_input?: { file_path?: string };
  };

  if (payload.tool_name !== "Read") return;

  const filePath = payload.tool_input?.file_path ?? "";
  if (!filePath) return;

  const envelope = await runPromptctl([
    "check-generated",
    filePath,
    "--on",
    "read",
  ]);
  if (!envelope || !envelope.marked) return;

  const message =
    typeof envelope.message === "string" ? envelope.message.trim() : "";
  if (!message) return;

  emitAdditionalContext(message);
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the Read proceed.
});
