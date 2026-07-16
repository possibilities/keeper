import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanelSelections } from "../src/agent/config";
import { isRunControlArtifact } from "../src/agent/run-capture";
import { defaultTmuxCommandRunner } from "../src/agent/tmux-launch";
import {
  buildPanelDeps,
  type PanelManifest,
  panelCancel,
  panelStart,
} from "../src/pair/panel";
import { retryUntil } from "./helpers/retry-until";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const runSlow = process.env.KEEPER_RUN_SLOW === "1";

test.skipIf(!runSlow)(
  "real abort settles wrappers, canonical controls, and exact tmux windows",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-panel-abort-slow-"));
    roots.push(root);
    const runDir = join(root, "run");
    const promptFile = join(root, "prompt.txt");
    const fakeAgent = join(root, "fake-agent.ts");
    const socket = `keeper-panel-slow-${process.pid}-${Date.now()}`;
    const tmux = "/opt/homebrew/bin/tmux";
    writeFileSync(promptFile, "exercise exact cancellation");
    writeFileSync(
      fakeAgent,
      `import { writeFileSync } from "node:fs";
const args = Bun.argv.slice(2);
const controlIndex = args.indexOf("--control");
const ownerIndex = args.indexOf("--control-owner");
if (controlIndex < 0 || ownerIndex < 0) process.exit(2);
const controlPath = args[controlIndex + 1];
const owner = JSON.parse(args[ownerIndex + 1]);
const tmux = process.env.KEEPER_SLOW_TMUX_BIN;
const socket = process.env.KEEPER_SLOW_TMUX_SOCKET;
const session = ("slow-" + owner.member).replace(/[^a-zA-Z0-9_-]/g, "-");
const launched = Bun.spawnSync([tmux, "-L", socket, "new-session", "-d", "-P", "-F", "#{window_id}", "-s", session, "sleep 300"], { stdout: "pipe", stderr: "pipe" });
if (launched.exitCode !== 0) process.exit(3);
const windowId = new TextDecoder().decode(launched.stdout).trim();
writeFileSync(controlPath, JSON.stringify({ schema_version: 1, run_id: "tmux-" + owner.member, agent: "claude", started_at_ms: Date.now(), kill_window_command: [tmux, "-L", socket, "kill-window", "-t", windowId], status: "running", owner }) + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );

    const selections: PanelSelections = {
      panels: {
        two: {
          strength: "standard",
          description: "slow lifecycle fixture",
          members: ["claude::opus::high", "claude::sonnet::high"],
        },
      },
      default: "two",
    };
    const deps = buildPanelDeps();
    deps.keeperBin = process.execPath;
    deps.keeperAgentPath = fakeAgent;
    deps.cwd = root;
    deps.env = {
      ...process.env,
      KEEPER_SLOW_TMUX_BIN: tmux,
      KEEPER_SLOW_TMUX_SOCKET: socket,
    };
    deps.loadRegistry = () => ({ catalog: { presets: {} }, selections });
    deps.write = () => {};
    deps.writeErr = () => {};

    let completed = false;
    let wrapperPids: number[] = [];
    try {
      expect(
        await panelStart(
          {
            promptFile,
            slug: "slow-abort",
            panel: "two",
            dir: runDir,
            timeoutSeconds: 300,
          },
          deps,
        ),
      ).toBe(0);

      const published = await retryUntil(() => {
        if (!existsSync(join(runDir, "manifest.json"))) return null;
        const manifest = JSON.parse(
          readFileSync(join(runDir, "manifest.json"), "utf8"),
        ) as PanelManifest;
        const attempts = manifest.members.flatMap(
          (member) => member.attempts ?? [],
        );
        if (
          attempts.length !== 2 ||
          attempts.some(
            (attempt) =>
              attempt.pidfile === null ||
              !existsSync(attempt.pidfile) ||
              attempt.control == null ||
              !existsSync(attempt.control.path),
          )
        ) {
          return null;
        }
        return manifest;
      }, 10_000);
      expect(published).not.toBeNull();
      if (published === null)
        throw new Error("attempt controls did not publish");

      wrapperPids = published.members.map((member) =>
        Number.parseInt(
          readFileSync(member.attempts?.[0]?.pidfile ?? "", "utf8"),
          10,
        ),
      );
      expect(wrapperPids).toHaveLength(2);
      expect(await panelCancel({ dir: runDir, cleanupMs: 5_000 }, deps)).toBe(
        0,
      );

      const settled = JSON.parse(
        readFileSync(join(runDir, "manifest.json"), "utf8"),
      ) as PanelManifest;
      expect(settled.cleanup_status).toBe("settled");
      expect(settled.unresolved_cleanup).toEqual([]);
      for (const member of settled.members) {
        const attempt = member.attempts?.[0];
        const artifact = JSON.parse(
          readFileSync(attempt?.control?.path ?? "", "utf8"),
        ) as unknown;
        expect(isRunControlArtifact(artifact)).toBe(true);
        if (!isRunControlArtifact(artifact)) continue;
        expect(artifact.status).toBe("terminal");
        const windowId = artifact.kill_window_command.at(-1) as string;
        const probe = defaultTmuxCommandRunner([
          ...artifact.kill_window_command.slice(0, -3),
          "display-message",
          "-p",
          "-t",
          windowId,
          "#{window_id}",
        ]);
        expect(probe.exitCode).not.toBe(0);
      }
      for (const pid of wrapperPids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      completed = true;
    } finally {
      if (!completed) {
        defaultTmuxCommandRunner([tmux, "-L", socket, "kill-server"]);
        for (const pid of wrapperPids) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // already absent
          }
        }
      }
    }
  },
  20_000,
);
