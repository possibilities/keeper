/**
 * `keeper pair panel` — the REAL-spawn detached-survival proof deliberately held
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDetachWrapperArgv,
  buildPanelDeps,
  type PanelDeps,
  type PanelManifest,
  type PanelVerdict,
  panelWait,
} from "../src/pair/panel";

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
});
