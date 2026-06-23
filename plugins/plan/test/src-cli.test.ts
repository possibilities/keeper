// Dispatch tests for src/cli.ts, exercised through the COMPILED binary
// (dist/keeper-plan-bun) via Bun.spawnSync — the PROCESS-BOUNDARY bucket. The
// default `bun test` covers dispatch in-process via the harness; this file proves
// the same shapes survive the compiled artifact (virtual FS, env minimalism), so
// it runs only when KEEPER_PLAN_RUN_PROCESS is set (after `bun run build`).

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROCESS_ENABLED, resolveBin } from "./harness.ts";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the compiled binary under a minimal env (HOME + PATH only) — the same
 * env-minimalism the conformance harness imposes. */
function run(args: string[], cwd: string): RunResult {
  const proc = Bun.spawnSync([resolveBin(), ...args], {
    cwd,
    env: { HOME: join(cwd, ".home"), PATH: process.env.PATH ?? "" },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function seedProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-cli-test-")));
  mkdirSync(join(root, ".keeper", "state"), { recursive: true });
  return root;
}

describe.skipIf(!PROCESS_ENABLED)("--help", () => {
  test("exit 0 on stdout with a Commands section and the four verbs", () => {
    const r = run(["--help"], tmpdir());
    expect(r.code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("planctl");
    expect(r.stdout).toContain("Commands:");
    for (const verb of ["state-path", "detect", "status", "epics"]) {
      expect(r.stdout).toContain(verb);
    }
  });
});

describe.skipIf(!PROCESS_ENABLED)("unknown command", () => {
  test("exit 2 on stderr with click's no-such-command shape", () => {
    const r = run(["frobnicate"], tmpdir());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Usage: planctl [OPTIONS] COMMAND [ARGS]...");
    expect(r.stderr).toContain("Try 'planctl --help' for help.");
    expect(r.stderr).toContain("Error: No such command 'frobnicate'.");
  });
});

describe.skipIf(!PROCESS_ENABLED)("state-path", () => {
  test("json envelope + byte-exact read-only trailer", () => {
    const root = seedProject();
    try {
      const r = run(["state-path"], root);
      expect(r.code).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      const trailer = lines[lines.length - 1] as string;
      const primary = lines.slice(0, -1).join("\n");
      expect(primary).toBe(
        `{\n  "success": true,\n  "state_dir": "${root}/.keeper/state"\n}`,
      );
      expect(trailer).toBe(
        '{"plan_invocation":{"files":null,"op":"state-path","target":null,' +
          '"subject":null,"touched_path_files":[],' +
          `"repo_root":"${root}","state_repo":"${root}"}}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--task adds task_state_path", () => {
    const root = seedProject();
    try {
      const r = run(["state-path", "--task", "fn-1-x.2"], root);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(
        `"task_state_path": "${root}/.keeper/state/tasks/fn-1-x.2.state.json"`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format yaml renders block style", () => {
    const root = seedProject();
    try {
      const r = run(["--format", "yaml", "state-path"], root);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(
        `success: true\nstate_dir: ${root}/.keeper/state\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing project errors (exit 1, no trailer)", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "planctl-cli-empty-")),
    );
    try {
      const r = run(["state-path"], root);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe(
        '{\n  "success": false,\n' +
          '  "error": "No planctl project found. Run \'planctl init\' first."\n}\n',
      );
      expect(r.stdout).not.toContain("plan_invocation");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!PROCESS_ENABLED)(
  "read-only verbs dispatch through the compiled binary",
  () => {
    test("detect found-true reads schema_version (0 default, no meta.json)", () => {
      const root = seedProject();
      try {
        const r = run(["detect"], root);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('"found": true');
        expect(r.stdout).toContain('"schema_version": 0');
        expect(r.stdout).toContain('"plan_invocation"');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("detect found-false: bare {found:false} then resolver error + exit 1", () => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "planctl-cli-detect-empty-")),
      );
      try {
        const r = run(["detect"], root);
        expect(r.code).toBe(1);
        expect(
          r.stdout.startsWith('{\n  "success": true,\n  "found": false\n}\n'),
        ).toBe(true);
        expect(r.stdout).not.toContain('"plan_invocation"');
        expect(r.stdout).toContain(
          "No planctl project found. Run 'planctl init' first.",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("status on an empty project emits zero counts + the trailer", () => {
      const root = seedProject();
      try {
        const r = run(["status"], root);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('"schema_version": 1');
        expect(r.stdout).toContain('"total": 0');
        expect(r.stdout).toContain('"plan_invocation"');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("epics on an empty project emits [] + the trailer", () => {
      const root = seedProject();
      try {
        const r = run(["epics"], root);
        expect(r.code).toBe(0);
        const lines = r.stdout.trimEnd().split("\n");
        const trailer = lines[lines.length - 1] as string;
        const primary = lines.slice(0, -1).join("\n");
        expect(primary).toBe('{\n  "success": true,\n  "epics": []\n}');
        expect(trailer).toContain('"op":"epics"');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test.each(["status", "epics"])(
      "%s on a missing project errors (exit 1, no trailer)",
      (verb) => {
        const root = realpathSync(
          mkdtempSync(join(tmpdir(), "planctl-cli-noproj-")),
        );
        try {
          const r = run([verb], root);
          expect(r.code).toBe(1);
          expect(r.stdout).toBe(
            '{\n  "success": false,\n' +
              '  "error": "No planctl project found. Run \'planctl init\' first."\n}\n',
          );
          expect(r.stdout).not.toContain("plan_invocation");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  },
);
