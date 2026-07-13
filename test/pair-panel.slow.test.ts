/**
 * `keeper agent panel` — the REAL-spawn detached-survival proof deliberately held
 * OUT of the fast pure-in-process tier. The fast sibling (`test/pair-panel.test.ts`)
 * injects every effect; this file spawns actual detached `sh` processes to pin the
 * one property that cannot be faked: a leg launched detached+unref'd keeps running
 * after the launcher's flow moves on, atomically writes its `--output` result
 * file, and the poller then picks it up — the exact behavior reported shaky on
 * macOS parent-exit. It also pins the pidfile crash-backstop against a real
 * process that dies before writing a file.
 *
 * SKIPPED by default (it launches subprocesses, which the fast tier forbids). Run
 * it out-of-band with `KEEPER_RUN_SLOW=1 bun test test/pair-panel.slow.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExactRunTeardown } from "../src/agent/run-capture";
import {
  buildDetachWrapperArgv,
  buildPanelDeps,
  type PanelDeps,
  type PanelManifest,
  type PanelVerdict,
  panelCancel,
  panelWait,
} from "../src/pair/panel";
import { retryUntil } from "./helpers/retry-until";

const SLOW_ENABLED = process.env.KEEPER_RUN_SLOW !== undefined;

describe.skipIf(!SLOW_ENABLED)("pair panel — real detached spawn", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pair-panel-slow-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Spawn ONE real detached leg through the same detach wrapper `panelStart`
   *  uses, carrying `$LOG`/`$PIDFILE`/`$RESULT` in env. `legScript` runs under
   *  `sh -c … leg <yamlPath>` so `$1` is the result-file path. */
  function spawnDetachedLeg(name: string, legScript: string): PanelManifest {
    const yamlPath = join(dir, `${name}.yaml`);
    const logPath = join(dir, `${name}.log`);
    const pidfilePath = join(dir, `${name}.pidfile`);
    const legArgv = ["sh", "-c", legScript, "leg", yamlPath];
    const proc = Bun.spawn(buildDetachWrapperArgv(legArgv), {
      env: {
        ...process.env,
        LOG: logPath,
        PIDFILE: pidfilePath,
        RESULT: JSON.stringify({
          schema_version: 1,
          outcome: "completed",
          message: "hi",
        }),
      },
      cwd: dir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    proc.unref();
    const manifest: PanelManifest = {
      dir,
      slug: "slow-run",
      members: [
        { name, harness: "claude", yaml: yamlPath, pidfile: pidfilePath },
      ],
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    return manifest;
  }

  /** Production deps (real spawn/clock/sleep/pidAlive) with stdout captured. */
  function waitDeps(graceMs?: number): {
    deps: PanelDeps;
    verdict: () => string;
  } {
    const out: string[] = [];
    return {
      deps: {
        ...buildPanelDeps(),
        write: (s) => out.push(s),
        writeErr: () => {},
        pollIntervalMs: 100,
        graceMs,
      },
      verdict: () => out.join("").trim(),
    };
  }

  test("a detached leg outlives the launch and its atomic result file is polled → ok", async () => {
    // The leg sleeps past the launch, THEN atomically writes its result file —
    // proving it kept running after we moved on to the poll.
    spawnDetachedLeg(
      "solo",
      'sleep 0.4; printf "%s\\n" "$RESULT" > "$1.tmp"; mv "$1.tmp" "$1"',
    );
    const { deps, verdict } = waitDeps();
    const code = await panelWait({ dir, chunkSeconds: 30 }, deps);
    expect(code).toBe(0);
    const v: PanelVerdict = JSON.parse(verdict());
    expect(v.ok).toBe(true);
    expect(v.members[0]).toMatchObject({ name: "solo", status: "ok" });
  });

  test("a detached leg that dies before writing a file → crash fail via the pidfile", async () => {
    spawnDetachedLeg("solo", "exit 7");
    const { deps, verdict } = waitDeps(200);
    const code = await panelWait({ dir, chunkSeconds: 30 }, deps);
    expect(code).toBe(0);
    const v: PanelVerdict = JSON.parse(verdict());
    expect(v.ok).toBe(false);
    expect(v.members[0]?.status).toBe("fail");
    expect(v.members[0]?.reason).toContain(
      "exited before producing a result file",
    );
  });

  test("terminal fake harness leaves no registered wrapper surviving", async () => {
    const run = spawnDetachedLeg(
      "terminal",
      'printf "%s\\n" "$RESULT" > "$1.tmp"; mv "$1.tmp" "$1"',
    );
    const { deps } = waitDeps();
    expect(await panelWait({ dir, chunkSeconds: 10 }, deps)).toBe(0);
    const pid = Number.parseInt(
      await Bun.file(run.members[0]?.pidfile as string).text(),
      10,
    );
    const gone = await retryUntil(() => {
      try {
        process.kill(pid, 0);
        return null;
      } catch {
        return true;
      }
    }, 5_000);
    expect(gone).toBe(true);
  });

  test("aborted fake harness reaps the exact wrapper and exact fake tmux target", async () => {
    const run = spawnDetachedLeg(
      "aborted",
      "trap 'exit 0' TERM INT; while :; do sleep 1; done",
    );
    run.request_id = "slow-abort-request";
    run.state = "running";
    const member = run.members[0] as NonNullable<
      PanelManifest["members"][number]
    >;
    member.launched_at = Date.now();
    member.attempts = [
      {
        attempt: 1,
        yaml: member.yaml,
        pidfile: member.pidfile,
        startfile: join(dir, "aborted.starttime"),
        launched_at: member.launched_at,
        state: "running",
      },
    ];
    member.startfile = join(dir, "aborted.starttime");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(run));

    const wrapperPidText = await retryUntil(() => {
      const path = member.pidfile as string;
      if (!existsSync(path)) return null;
      const text = readFileSync(path, "utf8").trim();
      return text === "" ? null : text;
    });
    expect(wrapperPidText).not.toBeNull();
    const wrapperPid = Number.parseInt(wrapperPidText as string, 10);

    const tmuxTarget = Bun.spawn(
      ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done"],
      { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const exactTarget = `fake-tmux:@${tmuxTarget.pid}`;
    const reap = createExactRunTeardown(
      ["fake-tmux", "kill-window", "-t", exactTarget],
      (command) => {
        expect(command.at(-1)).toBe(exactTarget);
        process.kill(tmuxTarget.pid, "SIGTERM");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    );

    const deps = {
      ...buildPanelDeps(),
      pollIntervalMs: 25,
      write: () => {},
      writeErr: () => {},
    };
    expect(await panelCancel({ dir, cleanupMs: 5_000 }, deps)).toBe(0);
    expect(reap()).toEqual({ kind: "torn_down" });
    await tmuxTarget.exited;

    const wrapperGone = await retryUntil(() => {
      try {
        process.kill(wrapperPid, 0);
        return null;
      } catch {
        return true;
      }
    }, 5_000);
    expect(wrapperGone).toBe(true);
    expect(tmuxTarget.exitCode).not.toBeNull();
    expect(
      JSON.parse(await Bun.file(join(dir, "manifest.json")).text()),
    ).toMatchObject({
      state: "cancelled",
      unresolved_cleanup: [],
    });
  });
});
