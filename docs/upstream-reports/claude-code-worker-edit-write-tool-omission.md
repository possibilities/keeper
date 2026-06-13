# Upstream report: Claude Code can spawn a subagent with Edit/Write in neither the direct tool set nor the deferred registry

**Status:** filed
**Surface:** Claude Code agent/subagent tool provisioning (deferred-tool registry population)
**Impact:** ~24% of `plan:worker-*` subagent spawns lose the ability to write files via the intended Write/Edit tools and silently fall back to `cat > file <<'EOF'` Bash heredocs, which truncate to a partial file when the stream is cut mid-write.

## Summary

For some subagent spawns, the harness provisions a tool universe in which **`Edit` and `Write` are absent from both the direct tool set and the deferred-tool registry**, and **no "deferred tools are now available" system-reminder is emitted**. A `ToolSearch(select:Edit)` / `ToolSearch(select:Edit,Write)` probe returns `No matching deferred tools found`. The subagent therefore cannot honor a "write file content with Write/Edit, never heredocs" instruction and degrades to streamed Bash heredocs — the exact truncation-prone write path the instruction exists to prevent.

This is not a per-environment or per-allowlist effect: it varies **per spawn** within a single session/profile/config-dir/harness-version.

## Reproduction signature

The defect is observed, not deterministically reproducible on demand (the mechanism deciding deferred-registry membership per spawn is not introspectable from transcripts or the event DB). The signature when it occurs:

1. A subagent's direct tool set is e.g. `Read + Bash + ToolSearch`, with `Edit`/`Write` absent.
2. The subagent runs `ToolSearch(select:Edit)` (or `select:Edit,Write`).
3. The probe returns `No matching deferred tools found`.
4. No `deferred tools are now available` reminder appears anywhere in the transcript.
5. The subagent falls back to `cat > <file> <<'EOF'` heredoc writes for all file content.

## Primary evidence (transcript)

Edit-less worker `agent-a18690c9f6b1533cd` — `plan:worker-xhigh`, task `fn-1-bun-cli-frame-compositor.3`, session `26c3c47b`, harness `2.1.176`:

- Transcript: `~/.claude/projects/-Users-mike-code-tmux0r/26c3c47b-bbd0-43aa-90c9-2c035def81a3/subagents/agent-a18690c9f6b1533cd.jsonl`
- L78: "Let me use a precise edit tool. I'll fetch Edit's schema."
- L79: `ToolSearch(select:Edit)`
- L80: `No matching deferred tools found`
- L81: "Edit isn't available as a deferred tool. I'll rewrite ... via a heredoc"
- 25 `cat > file <<EOF` heredoc writes from ~L52 onward (incl. `src/frame.ts` rewritten twice as full-file rewrites).
- Zero `deferred tools are now available` reminders anywhere in the transcript.

The worker still reached `planctl done`, shipping all source via Bash — so the failure is silent: no error surfaces, but every file write rode the truncation-prone path.

## Partition (it is a class, not a one-off)

Across the keeper event DB, of **565** `plan:worker-*` agents:

- 411 Edit-bearing
- 123 Write-bearing
- 430 Edit-or-Write bearing
- **135 (24%) had NEITHER Edit nor Write**

So roughly one in four worker spawns cannot use the intended file-write tools.

## Ruled-out causes (from forensic investigation)

- **Orchestrator allowlist inheritance — ruled out.** The Edit-less worker ran 62 non-planctl Bash calls (`keeper session-state`, `ls`, `grep`, `mkdir`, `cat` heredocs). The spawning skill's `Bash(planctl:*)` allowlist would have denied every one, so the worker had general Bash, not the skill's narrowed set.
- **Per-session / per-profile env divergence — ruled out as a universal cause.** 15 sessions contain BOTH an Edit-bearing AND a neither-class worker, so the same session / profile / `CLAUDE_CONFIG_DIR` / harness version yields both outcomes. The cause is per-spawn, not per-environment.
- **Harness version — not confirmed.** The anomaly appeared on 2.1.176; sampled Edit-bearing workers ran on 2.1.172 / 2.1.145. The event DB stores no version and the session `transcript_path` is absent for 118/135 neither-class agents, so a clean version histogram could not be built.

## Conclusion / ask

The root cause is harness-side deferred-tool registry population: for some spawns, `Edit`/`Write` land in neither the direct tool set nor the deferred registry, and no deferred-tools system-reminder is emitted. We ask Claude Code to (a) ensure `Edit`/`Write` are reliably provisioned (direct or deferred) for subagents that need file writes, or at minimum (b) always emit the "deferred tools are now available" reminder so a subagent can discover and pull them.

## Local mitigation already shipped

`template/agents/worker.md.tmpl` (and the rendered `agents/worker-<tier>.md`) now carry a Phase-1 tooling self-check: when neither `Edit` nor `Write` is direct, the worker runs `ToolSearch(select:Edit,Write)` once and, if both are still absent, returns `BLOCKED: TOOLING_FAILURE` instead of silently degrading to heredocs. This converts the silent drop into a loud, resumable failure but does not address the underlying harness provisioning gap.
