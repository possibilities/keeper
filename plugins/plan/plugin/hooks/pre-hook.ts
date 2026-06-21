#!/usr/bin/env bun
// PreToolUse(Write|Edit) generated-file guard.
//
// Blocks an edit to a file carrying a `<file>.managed-file-dont-edit` sidecar:
// shells `keeper prompt check-generated <file> --on write` and, when the
// envelope reports `marked: true`, emits a `permissionDecision: deny` naming the
// source template + regenerate command. Fail open on every path (exit 0, no
// deny) — a hot-path hook that blocked every Write because keeper prompt is
// broken would brick the agent surface; only a definitive `marked` verdict
// denies.

import { emitDeny, readStdin, runKeeperPrompt } from "./lib.ts";

async function main(): Promise<void> {
  const raw = await readStdin();
  const payload = JSON.parse(raw) as {
    tool_input?: { file_path?: string };
  };

  const filePath = payload.tool_input?.file_path ?? "";
  if (!filePath) return;

  const envelope = await runKeeperPrompt([
    "check-generated",
    filePath,
    "--on",
    "write",
  ]);
  if (!envelope || !envelope.marked) return;

  const message =
    typeof envelope.message === "string" ? envelope.message.trim() : "";
  if (!message) return;

  emitDeny(message);
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the Write/Edit proceed.
});
