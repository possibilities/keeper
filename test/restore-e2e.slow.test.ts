/**
 * restore-e2e — the real-tmux acceptance instrument for crash-restore, held OUT
 * of the fast pure-in-process tier because it spawns a real tmux server. Gated
 * on `KEEPER_RUN_SLOW`; run it with:
 *
 *   KEEPER_RUN_SLOW=1 bun test test/restore-e2e.slow.test.ts
 *
 * Drives the REAL `applyRestoreVerified` transaction (`src/tabs-core.ts`)
 * against a scratch `tmux -L` socket, with two fake harness binaries standing
 * in for claude — never a real model call:
 *
 *   - the OK harness writes a hook-shaped SessionStart NDJSON evidence line
 *     (the exact shape `claudeAttachEvidence` reads) then blocks, simulating a
 *     live attached session;
 *   - the FAIL harness prints a diagnosis line and exits nonzero; the launch
 *     wrapper never `exec`s "$SHELL" (CLAUDE.md: exec would mask the exit code)
 *     — it captures `$?`, echoes it, THEN falls to a plain "$SHELL" so the pane
 *     stays visible with the diagnosis in its scrollback rather than vanishing.
 *
 * Proves, against REAL tmux panes and a REAL on-disk evidence read (no daemon,
 * no socket, no faked seams below `applyRestoreVerified` itself):
 *   - a verified restore round-trips: launch -> evidence appears -> `verified`,
 *     and a same-generation retry is an idempotent no-op (never a double-spawn);
 *   - a failed resume's pane stays VISIBLE with its diagnosis (never torn down),
 *     and `classifyPaneLiveness` reads the shell-fallback tail as `dead` off the
 *     real probed pane state — never a real 20s wait (a short bespoke bound
 *     drives `verifyAttach`, the same function production uses).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RestoreCandidate } from "../src/restore-set";
import {
  classifyPaneLiveness,
  claudeAttachEvidence,
  type PaneLiveness,
  RESTORE_INTENT_SCHEMA_VERSION,
  type RestoreIntent,
  verifyAttach,
} from "../src/restore-verify";
import { applyRestoreVerified, type IntentSink } from "../src/tabs-core";

const SLOW_ENABLED = process.env.KEEPER_RUN_SLOW !== undefined;
const TMUX_BIN = Bun.which("tmux");

if (SLOW_ENABLED && TMUX_BIN === null) {
  console.warn(
    "[restore-e2e] SKIPPED: tmux not found on PATH — the real-tmux crash-" +
      "restore acceptance instrument cannot run. Install tmux to exercise it.",
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!SLOW_ENABLED || TMUX_BIN === null)(
  "restore-e2e — real tmux crash-restore transaction (KEEPER_RUN_SLOW)",
  () => {
    let root: string;
    let tmuxTmp: string;
    let socket: string;
    let binDir: string;
    let eventsDir: string;
    // tmux env: a dedicated short TMPDIR keeps the AF_UNIX socket path under
    // its ~104-char limit, and a pinned SHELL makes the fail-harness's
    // fallback-to-login-shell classification deterministic across hosts.
    let tmuxEnv: Record<string, string>;

    function tmux(args: string[]): { status: number | null; out: string } {
      const r = Bun.spawnSync(["tmux", "-L", socket, ...args], {
        env: tmuxEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        status: r.exitCode,
        out: (r.stdout ?? new Uint8Array()).toString(),
      };
    }

    /** Probe one session's sole pane liveness via the REAL tmux socket. */
    function probeLiveness(session: string): PaneLiveness {
      const r = tmux([
        "list-panes",
        "-t",
        session,
        "-F",
        "#{pane_dead}\t#{pane_current_command}",
      ]);
      if (r.status !== 0) {
        return "unknown";
      }
      const [dead = "", cmd = ""] = (r.out.split("\n")[0] ?? "").split("\t");
      return classifyPaneLiveness(dead, cmd);
    }

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "kre-root-"));
      tmuxTmp = mkdtempSync(join(tmpdir(), "kre-tmp-"));
      socket = `kre-${process.pid}`;
      tmuxEnv = { ...process.env, TMUX_TMPDIR: tmuxTmp, SHELL: "/bin/bash" };
      binDir = join(root, "bin");
      eventsDir = join(root, "events");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(eventsDir, { recursive: true });

      // OK harness: write the exact SessionStart NDJSON shape
      // `claudeAttachEvidence` reads, then block — a live, attached session.
      const okScript = [
        "#!/usr/bin/env bash",
        'session_id="$1"',
        'events_dir="$2"',
        'line="{\\"bindings\\":{\\"session_id\\":\\"$session_id\\",\\"hook_event\\":\\"SessionStart\\",\\"ts\\":$(date +%s)}}"',
        'printf "%s\\n" "$line" >> "$events_dir/$$.ndjson"',
        // A plain large-seconds sleep, not GNU-only "sleep infinity" — BSD/macOS
        // sleep rejects the "infinity" keyword (numeric-only), and this must
        // hold the pane alive on every dev/CI host the slow tier runs on.
        "exec sleep 999999",
        "",
      ].join("\n");
      writeFileSync(join(binDir, "ok-harness.sh"), okScript);
      chmodSync(join(binDir, "ok-harness.sh"), 0o755);

      // FAIL harness: print a diagnosis, exit nonzero — never launched via
      // `exec "$SHELL"`; the wrapper (below, in the tmux command) captures the
      // exit code first and falls to a plain "$SHELL" so the pane survives.
      const failScript = [
        "#!/usr/bin/env bash",
        'echo "FATAL: simulated attach failure — harness exited nonzero"',
        "exit 7",
        "",
      ].join("\n");
      writeFileSync(join(binDir, "fail-harness.sh"), failScript);
      chmodSync(join(binDir, "fail-harness.sh"), 0o755);
    });

    afterAll(() => {
      tmux(["kill-server"]);
      rmSync(root, { recursive: true, force: true });
      rmSync(tmuxTmp, { recursive: true, force: true });
    });

    test("a verified restore round-trips: launch -> real attach evidence -> verified, and a retry no-ops", async () => {
      const jobId = "51ee6f32-e2e-ok-0000-000000000001";
      const session = "ok";
      const candidate: RestoreCandidate = {
        job_id: jobId,
        resume_target: jobId,
        label: "e2e-ok",
        harness: "claude",
        window_index: 0,
        cwd: root,
        backend_exec_session_id: session,
        created_at: 0,
      };
      const plan = [{ kind: "would-restore" as const, candidate }];

      const writes: RestoreIntent[] = [];
      const intent: IntentSink = { write: (i) => writes.push({ ...i }) };
      const makeIntent = (c: RestoreCandidate): RestoreIntent => ({
        schema_version: RESTORE_INTENT_SCHEMA_VERSION,
        generation_id: "e2e-gen",
        job_id: c.job_id,
        session_uuid: c.resume_target,
        harness: "claude",
        resume_target: c.resume_target,
        cwd: c.cwd ?? "",
        backend_exec_session_id: c.backend_exec_session_id,
        argv: ["keeper", "agent", "claude", "--resume", c.resume_target],
        rerun_command: "keeper tabs restore --apply --session ok",
        attempt: 1,
        state: "planned",
        reason: "",
        created_at: "2026-07-07T00:00:00.000Z",
        updated_at: "2026-07-07T00:00:00.000Z",
      });

      let launches = 0;
      let live = false;
      const outcomes = await applyRestoreVerified(plan, {
        ensureLaunched: async (sess, resumeTarget) => {
          launches++;
          const r = tmux([
            "new-session",
            "-d",
            "-s",
            sess,
            "-c",
            root,
            "bash",
            join(binDir, "ok-harness.sh"),
            resumeTarget,
            eventsDir,
          ]);
          return r.status === 0
            ? { ok: true }
            : { ok: false, error: `tmux new-session exit ${r.status}` };
        },
        verify: async (c, launchStartMs) =>
          verifyAttach({
            hasEvidence: () =>
              claudeAttachEvidence(
                eventsDir,
                c.resume_target,
                // The evidence "ts" is second-granular (the real hook shape) —
                // floor the launch floor to its own second so a same-second
                // write is never mistaken for stale.
                Math.floor(launchStartMs / 1000) * 1000,
              ),
            paneLiveness: () => probeLiveness(session),
            now: Date.now,
            sleep: sleepMs,
            timeoutMs: 5_000,
            pollMs: 100,
          }),
        intent,
        makeIntent,
        isLive: () => live,
      });

      expect(outcomes.map((o) => o.kind)).toEqual(["verified"]);
      expect(launches).toBe(1);
      expect(writes.at(-1)?.state).toBe("verified");
      // The real pane is still alive (the OK harness blocks on `sleep infinity`).
      expect(probeLiveness(session)).toBe("alive");

      // Idempotent retry: a live session (the durable marker from the first
      // apply) is a no-op — never a second tmux spawn.
      live = true;
      const retry = await applyRestoreVerified(plan, {
        ensureLaunched: async () => {
          launches++;
          return { ok: true };
        },
        verify: async () => "verified",
        intent,
        makeIntent,
        isLive: () => live,
      });
      expect(retry.map((o) => o.kind)).toEqual(["verified"]);
      expect(launches).toBe(1); // unchanged — no second spawn.
    }, 30_000);

    test("a failed resume's pane stays visible with its diagnosis, never torn down", async () => {
      const jobId = "deba61ad-e2e-fail-0000-000000000002";
      const session = "fail";
      const candidate: RestoreCandidate = {
        job_id: jobId,
        resume_target: jobId,
        label: "e2e-fail",
        harness: "claude",
        window_index: 0,
        cwd: root,
        backend_exec_session_id: session,
        created_at: 0,
      };
      const plan = [{ kind: "would-restore" as const, candidate }];

      const writes: RestoreIntent[] = [];
      const intent: IntentSink = { write: (i) => writes.push({ ...i }) };
      const makeIntent = (c: RestoreCandidate): RestoreIntent => ({
        schema_version: RESTORE_INTENT_SCHEMA_VERSION,
        generation_id: "e2e-gen",
        job_id: c.job_id,
        session_uuid: c.resume_target,
        harness: "claude",
        resume_target: c.resume_target,
        cwd: c.cwd ?? "",
        backend_exec_session_id: c.backend_exec_session_id,
        argv: ["keeper", "agent", "claude", "--resume", c.resume_target],
        rerun_command: "keeper tabs restore --apply --session fail",
        attempt: 1,
        state: "planned",
        reason: "",
        created_at: "2026-07-07T00:00:00.000Z",
        updated_at: "2026-07-07T00:00:00.000Z",
      });

      const outcomes = await applyRestoreVerified(plan, {
        ensureLaunched: async (sess) => {
          // The wrapper NEVER `exec`s "$SHELL": it captures $? on the next
          // line, echoes it (the diagnosis stays in scrollback), THEN falls
          // to a plain (non-exec'd) "$SHELL" so the pane survives the harness
          // dying instead of the window disappearing.
          const cmd = `${join(binDir, "fail-harness.sh")}; ec=$?; echo "[keeper] harness exited (ec=$ec)"; "$SHELL"`;
          const r = tmux([
            "new-session",
            "-d",
            "-s",
            sess,
            "-c",
            root,
            "bash",
            "-c",
            cmd,
          ]);
          return r.status === 0
            ? { ok: true }
            : { ok: false, error: `tmux new-session exit ${r.status}` };
        },
        verify: async (c, launchStartMs) =>
          verifyAttach({
            hasEvidence: () =>
              claudeAttachEvidence(
                eventsDir,
                c.resume_target,
                // The evidence "ts" is second-granular (the real hook shape) —
                // floor the launch floor to its own second so a same-second
                // write is never mistaken for stale.
                Math.floor(launchStartMs / 1000) * 1000,
              ),
            paneLiveness: () => probeLiveness(session),
            now: Date.now,
            sleep: sleepMs,
            // Bounded well under the sim's fake-clock coverage of the same
            // disambiguation — this instrument's job is the real substrate,
            // not re-proving the timeout math.
            timeoutMs: 3_000,
            pollMs: 100,
          }),
        intent,
        makeIntent,
      });

      // No attach evidence ever appears, and the harness died — the shell
      // fallback took over the pane, which `classifyPaneLiveness` reads as
      // `dead` (never merely `unverified`, since there is no live harness left
      // to eventually attach).
      expect(outcomes.map((o) => o.kind)).toEqual(["failed"]);
      expect(writes.at(-1)?.state).toBe("failed");

      // The pane itself is still there (never torn down) and its scrollback
      // carries the diagnosis — proving "failed" is visible, not silent.
      const captured = tmux(["capture-pane", "-t", session, "-p"]).out;
      expect(captured).toContain(
        "FATAL: simulated attach failure — harness exited nonzero",
      );
      expect(captured).toContain("[keeper] harness exited (ec=7)");
      // The window still exists (a `has-session` probe succeeds).
      expect(tmux(["has-session", "-t", session]).status).toBe(0);
    }, 30_000);
  },
);
