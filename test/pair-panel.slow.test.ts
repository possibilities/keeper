/**
 * The KEYSTONE proof for `keeper pair panel start` (epic early-proof-point): a
 * detached leg must SURVIVE `start`'s own process exit on macOS — raw
 * `Bun.spawn({detached:true}).unref()` is reported to die on parent-exit there,
 * which is exactly why the orchestrator interposes the `nohup` double-fork shell.
 *
 * This is a REAL-spawn test (slow tier, folded into `test:full`, path-ignored
 * from the fast tier): it runs `cli/pair.ts panel start` as a genuine subprocess
 * with `KEEPER_AGENT_PATH` pointed at a fake `keeper` that, on `pair send`,
 * SLEEPS well past `start`'s lifetime and only THEN writes its `--output` yaml.
 * The proof: `start` exits cleanly, its legs' yamls are still ABSENT at that
 * instant (the writers are mid-sleep), and they appear afterward — so the writes
 * happened entirely after the launching process died. No real git, no tmux, no
 * keeper daemon — just the detach wrapper under a real OS.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryUntil } from "./helpers/retry-until";

const PAIR_CLI = join(import.meta.dir, "..", "cli", "pair.ts");

// A fake `keeper` entry: on `pair send`, sleep past start's exit, then write the
// --output yaml. Any other invocation exits non-zero.
const FAKE_KEEPER = `
const argv = Bun.argv.slice(2);
if (argv[0] === "pair" && argv[1] === "send") {
  const oi = argv.indexOf("--output");
  const out = argv[oi + 1];
  await Bun.sleep(900);
  await Bun.write(out, "message: fake panelist answer\\n");
  process.exit(0);
}
process.exit(1);
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pair-panel-slow-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("detached legs survive start's process exit (nohup double-fork)", async () => {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "what is the answer?");
  const fakeKeeper = join(dir, "fake-keeper.ts");
  writeFileSync(fakeKeeper, FAKE_KEEPER);
  const scratch = join(dir, "scratch");

  const proc = Bun.spawn(
    [
      process.execPath,
      PAIR_CLI,
      "panel",
      "start",
      promptFile,
      "--dir",
      scratch,
      "--panel",
      "default",
      "--timeout",
      "1800",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // Empty registry → legacy opus+codex fallback (2 legs); both legs
        // re-exec our fake keeper as `<bun> <fakeKeeper> pair send …`.
        KEEPER_AGENT_PATH: fakeKeeper,
        KEEPER_PRESETS_CONFIG: join(dir, "no-such-presets.yaml"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  // start exited cleanly and printed a 2-leg manifest.
  expect(exitCode).toBe(0);
  const manifest = JSON.parse(stdout.trim());
  expect(manifest.members.map((m: { name: string }) => m.name)).toEqual([
    "opus",
    "codex",
  ]);

  const opusYaml = join(scratch, "opus.yaml");
  const codexYaml = join(scratch, "codex.yaml");
  // At start's exit the legs are still sleeping — their outputs do NOT exist yet.
  expect(existsSync(opusYaml)).toBe(false);
  expect(existsSync(codexYaml)).toBe(false);

  // …yet they appear afterward: the detached legs outlived their launcher.
  const landed = await retryUntil(
    () => (existsSync(opusYaml) && existsSync(codexYaml) ? true : null),
    10_000,
    100,
  );
  expect(landed).toBe(true);
});
