// Wiring + behavioral tests for the plugin's native generated-file guard hooks
// (plugin/hooks/{pre,post}-hook.ts) and the hooks.json registration. Translated
// from the generated-guard-hook pytest module: the guard-dispatcher fail-open
// baseline is already covered by commit-guard / stop-guard / subagent-stop-guard
// bun tests, so this file pins (1) the hooks.json co-location + matcher/exec-form
// wiring, (2) the pre-hook deny / pass-through plumbing against a stubbed
// `keeper prompt`, (3) the post-hook additionalContext plumbing, and (4) the
// work marker write→read round-trip through the production writer + reader.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readMarker } from "../plugin/hooks/lib.ts";
import { CANONICAL_EFFORTS } from "../src/host_matrix.ts";
import { writeWorkMarker } from "../src/session_markers.ts";

const REPO = join(import.meta.dir, "..");
const PRE_HOOK = join(REPO, "plugin", "hooks", "pre-hook.ts");
const POST_HOOK = join(REPO, "plugin", "hooks", "post-hook.ts");

// workers/ is gitignored (rendered per-cell from the host worker matrix), so a
// clean checkout that never ran render-plugin-templates has no cells on disk. The
// two tests that enumerate real cells skip there instead of failing hard;
// promote.sh renders before these guards, so promotion-time coverage is
// preserved.
const WORKERS_RENDERED = existsSync(join(REPO, "workers"));

function readHooks(): Record<string, Array<Record<string, unknown>>> {
  const data = JSON.parse(
    readFileSync(join(REPO, "hooks", "hooks.json"), "utf-8"),
  ) as { hooks: Record<string, Array<Record<string, unknown>>> };
  return data.hooks;
}

/** Find the inner exec-form bun entry in `entry` pointing at the named script. */
function execFormCmd(
  entry: Record<string, unknown>,
  basename: string,
): Record<string, unknown> {
  const inners = entry.hooks as Array<Record<string, unknown>>;
  for (const inner of inners) {
    if (inner.command !== "bun") {
      continue;
    }
    const args = (inner.args as string[]) ?? [];
    if (args[0]?.endsWith(`plugin/hooks/${basename}`)) {
      expect(inner.type).toBe("command");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal ${CLAUDE_PLUGIN_ROOT} token in the JSON
      expect(args[0]).toContain("${CLAUDE_PLUGIN_ROOT}");
      return inner;
    }
  }
  throw new Error(`no exec-form bun entry for ${basename}`);
}

// ---------------------------------------------------------------------------
// hooks.json wiring
// ---------------------------------------------------------------------------

describe("hooks.json wiring", () => {
  test("hooks.json + plugin manifest are co-located at the plugin root", () => {
    expect(existsSync(join(REPO, "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(join(REPO, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  test("registers PreToolUse(Write|Edit) → pre-hook and PostToolUse(Read) → post-hook", () => {
    const hooks = readHooks();
    expect("PreToolUse" in hooks).toBe(true);
    expect("PostToolUse" in hooks).toBe(true);
    const pre = hooks.PreToolUse.find((e) => e.matcher === "Write|Edit");
    expect(pre).toBeDefined();
    execFormCmd(pre as Record<string, unknown>, "pre-hook.ts");
    const post = hooks.PostToolUse[0] as Record<string, unknown>;
    expect(post.matcher).toBe("Read");
    execFormCmd(post, "post-hook.ts");
  });

  test("both hook entry points carry the bun shebang", () => {
    for (const hook of [PRE_HOOK, POST_HOOK]) {
      expect(existsSync(hook)).toBe(true);
      expect(readFileSync(hook, "utf-8").startsWith("#!/usr/bin/env bun")).toBe(
        true,
      );
    }
  });

  test("registers the commit-guard under a Bash matcher", () => {
    const hooks = readHooks();
    const bashEntry = hooks.PreToolUse.find((e) => e.matcher === "Bash");
    expect(bashEntry).toBeDefined();
    execFormCmd(bashEntry as Record<string, unknown>, "commit-guard.ts");
  });

  test("registers the subagent-stop-guard under the ^work:worker$ matcher", () => {
    const hooks = readHooks();
    const entry = hooks.SubagentStop[0] as Record<string, unknown>;
    // The anchored full-name matcher fires cross-plugin for the launch-selected
    // work:worker cell (every cell spawns the constant work:worker).
    expect(entry.matcher).toBe("^work:worker$");
    execFormCmd(entry, "subagent-stop-guard.ts");
  });

  test("registers the stop-guard with no matcher", () => {
    const hooks = readHooks();
    const entry = hooks.Stop[0] as Record<string, unknown>;
    expect("matcher" in entry).toBe(false);
    execFormCmd(entry, "stop-guard.ts");
  });
});

// ---------------------------------------------------------------------------
// per-cell work plugin set ↔ required host matrix (both directions)
// ---------------------------------------------------------------------------

describe("on-disk work-plugin cells are well-formed", () => {
  // The model segment of a cell dir is a host-matrix capability token (mirrors
  // host_matrix.ts MATRIX_TOKEN_RE); a capability may carry hyphens/dots
  // (`gpt-5.3-codex-spark`), so the effort is the final hyphen-delimited segment.
  const CELL_MODEL_RE = /^[a-z0-9._-]+$/;

  test.skipIf(!WORKERS_RENDERED)(
    "every on-disk workers/ cell name is a <model>-<canonical-effort> pair",
    () => {
      // The exact {model × effort} roster a matrix renders is pinned hermetically
      // in the prompt suite (parity.test.ts renders the plan plugin in-process
      // against fixture matrices). A plan test can't read the live host matrix
      // (the preload pins a claude-only fixture, ADR 0036), so it can't re-derive
      // that roster — it holds the host-blind structural invariant instead: every
      // cell name parses as <model>-<effort> with a canonical effort and a valid
      // capability token.
      const cells = readdirSync(join(REPO, "workers"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      // WORKERS_RENDERED gated us in, so a real render left at least one cell.
      expect(cells.length).toBeGreaterThan(0);
      const malformed = cells.filter((name) => {
        const cut = name.lastIndexOf("-");
        if (cut <= 0) {
          return true;
        }
        const model = name.slice(0, cut);
        const effort = name.slice(cut + 1);
        return !(
          CELL_MODEL_RE.test(model) &&
          !model.startsWith(".") &&
          (CANONICAL_EFFORTS as readonly string[]).includes(effort)
        );
      });
      expect(malformed).toEqual([]);
    },
  );

  test("no stale plan:worker-*.md agents linger in agents/", () => {
    // agents/ is gitignored (rendered), so a clean checkout has none — an absent
    // dir trivially carries no stale worker agents.
    const agentsDir = join(REPO, "agents");
    const stale = existsSync(agentsDir)
      ? readdirSync(agentsDir).filter(
          (n) => n.startsWith("worker-") && n.endsWith(".md"),
        )
      : [];
    expect(stale).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// work-name collision guard: no non-cell plugin named `work` may shadow the
// launch-selected work:worker cells.
// ---------------------------------------------------------------------------

/** Every `.claude-plugin/plugin.json` under `root` whose manifest name is
 * `work`. Skips heavy/irrelevant trees so the walk stays bounded. */
function findWorkManifests(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".keeper"]);
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const manifest = join(dir, ".claude-plugin", "plugin.json");
    if (existsSync(manifest)) {
      try {
        const data = JSON.parse(readFileSync(manifest, "utf-8")) as {
          name?: string;
        };
        if (data.name === "work") {
          out.push(manifest);
        }
      } catch {
        /* malformed manifest — not a `work` collision */
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name)) {
        continue;
      }
      walk(join(dir, e.name));
    }
  };
  walk(root);
  return out;
}

/** `work`-named manifests NOT under the workers/ cell base — a shadowing
 * collision that would steal the constant `work:worker` from the selected cell. */
function collidingWorkManifests(root: string, workersBase: string): string[] {
  const base = resolve(workersBase);
  return findWorkManifests(root).filter(
    (m) => !resolve(m).startsWith(base + sep),
  );
}

describe("work-name collision guard", () => {
  test.skipIf(!WORKERS_RENDERED)(
    "the plan plugin ships no non-cell `work`-named plugin",
    () => {
      const hits = collidingWorkManifests(REPO, join(REPO, "workers"));
      expect(hits).toEqual([]);
      // Sanity: the cells themselves ARE `work`-named (the guard excludes them).
      expect(findWorkManifests(join(REPO, "workers")).length).toBeGreaterThan(
        0,
      );
    },
  );

  test("the guard fires when a stray `work` plugin is scanned outside workers/", () => {
    const strayRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "planctl-work-collision-")),
    );
    try {
      const strayDir = join(strayRoot, "some-plugin", ".claude-plugin");
      mkdirSync(strayDir, { recursive: true });
      writeFileSync(
        join(strayDir, "plugin.json"),
        JSON.stringify({ name: "work" }),
      );
      const hits = collidingWorkManifests(
        strayRoot,
        join(strayRoot, "workers"),
      );
      expect(hits.length).toBe(1);
      expect(hits[0]).toContain("some-plugin");
    } finally {
      rmSync(strayRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// pre-hook / post-hook behavior against a stubbed `keeper prompt`
// ---------------------------------------------------------------------------

let root: string;
const savedPath = process.env.PATH;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-guard-hook-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.env.PATH = savedPath;
});

/** Drop a bun-script `keeper` on a fresh bin dir that echoes `envelope`. The
 * hook shells `keeper prompt check-generated …`; the shim ignores its args. */
function stubKeeper(envelope: Record<string, unknown>): string {
  const binDir = join(root, "stub-bin");
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, "keeper");
  writeFileSync(
    shim,
    "#!/usr/bin/env bun\n" +
      `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))} + "\\n");\n`,
  );
  chmodSync(shim, 0o755);
  return binDir;
}

/** Drop a bun-script `keeper` that exits non-zero (broken-tool path). */
function stubBrokenKeeper(): string {
  const binDir = join(root, "stub-bin");
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, "keeper");
  writeFileSync(shim, "#!/usr/bin/env bun\nprocess.exit(99);\n");
  chmodSync(shim, 0o755);
  return binDir;
}

function runHook(
  hook: string,
  stdin: Record<string, unknown>,
  binDir: string,
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, hook], {
    stdin: Buffer.from(JSON.stringify(stdin)),
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: Buffer.from(proc.stdout).toString("utf-8"),
    stderr: Buffer.from(proc.stderr).toString("utf-8"),
  };
}

describe("pre-hook (PreToolUse Write/Edit → deny)", () => {
  test("a marked: true envelope emits permissionDecision: deny", () => {
    const envelope = {
      marked: true,
      mode: "block",
      source_template: "/path/to/template/agents/worker.md.tmpl",
      message:
        "BLOCKED: this is a generated file. Edit /path/to/template/agents/worker.md.tmpl instead.",
    };
    const binDir = stubKeeper(envelope);
    const target = join(root, "agents", "worker-high.md");
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(target, "stub doesn't read it\n");

    const r = runHook(
      PRE_HOOK,
      { tool_name: "Write", tool_input: { file_path: target } },
      binDir,
    );
    expect(r.code).toBe(0);
    const spec = (
      JSON.parse(r.stdout) as Record<string, Record<string, string>>
    ).hookSpecificOutput;
    expect(spec.hookEventName).toBe("PreToolUse");
    expect(spec.permissionDecision).toBe("deny");
    expect(spec.permissionDecisionReason).toContain("BLOCKED");
    expect(spec.permissionDecisionReason).toContain(
      "/path/to/template/agents/worker.md.tmpl",
    );
  });

  test("a marked: false envelope passes silently", () => {
    const binDir = stubKeeper({ marked: false });
    const target = join(root, "plain.md");
    writeFileSync(target, "plain body\n");
    const r = runHook(
      PRE_HOOK,
      { tool_name: "Write", tool_input: { file_path: target } },
      binDir,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a missing file_path passes silently (no keeper prompt call)", () => {
    const binDir = stubKeeper({ marked: true, message: "irrelevant" });
    const r = runHook(PRE_HOOK, { tool_name: "Write", tool_input: {} }, binDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a broken keeper prompt (non-zero exit) fails open — passes silently", () => {
    const binDir = stubBrokenKeeper();
    const target = join(root, "marked.md");
    writeFileSync(target, "---\n_promptctl_path: foo.tmpl\n---\nbody\n");
    const r = runHook(
      PRE_HOOK,
      { tool_name: "Write", tool_input: { file_path: target } },
      binDir,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("post-hook (PostToolUse Read → additionalContext)", () => {
  test("a marked: true envelope emits additionalContext", () => {
    const envelope = {
      marked: true,
      mode: "warn",
      source_template: "/repo/template/agents/worker.md.tmpl",
      message:
        "Heads-up: this is a generated file. Source: /repo/template/agents/worker.md.tmpl.",
    };
    const binDir = stubKeeper(envelope);
    const target = join(root, "agents", "worker.md");
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(target, "body\n");
    const r = runHook(
      POST_HOOK,
      { tool_name: "Read", tool_input: { file_path: target } },
      binDir,
    );
    expect(r.code).toBe(0);
    const spec = (
      JSON.parse(r.stdout) as Record<string, Record<string, string>>
    ).hookSpecificOutput;
    expect(spec.hookEventName).toBe("PostToolUse");
    expect(spec.additionalContext).toContain("Heads-up");
    expect(spec.additionalContext).toContain(
      "/repo/template/agents/worker.md.tmpl",
    );
  });

  test("a non-Read tool is a no-op", () => {
    const binDir = stubKeeper({ marked: true, message: "x" });
    const r = runHook(
      POST_HOOK,
      { tool_name: "Bash", tool_input: { command: "ls" } },
      binDir,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a marked: false envelope injects nothing", () => {
    const binDir = stubKeeper({ marked: false });
    const target = join(root, "plain.md");
    writeFileSync(target, "plain\n");
    const r = runHook(
      POST_HOOK,
      { tool_name: "Read", tool_input: { file_path: target } },
      binDir,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// work marker write→read round-trip through the production writer + reader
// ---------------------------------------------------------------------------

describe("work marker round-trip (writeWorkMarker → readMarker)", () => {
  const savedHome = process.env.HOME;
  const savedSid = process.env.CLAUDE_CODE_SESSION_ID;

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedSid === undefined) {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    } else {
      process.env.CLAUDE_CODE_SESSION_ID = savedSid;
    }
  });

  test("a written work marker reads back with its task identity intact", async () => {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const sessionId = "round-trip-session";
    const taskId = "fn-99-some-epic.3";
    process.env.HOME = home;
    process.env.CLAUDE_CODE_SESSION_ID = sessionId;

    writeWorkMarker(taskId);
    const marker = await readMarker(sessionId);

    expect(marker).not.toBeNull();
    expect((marker as Record<string, unknown>).kind).toBe("work");
    expect((marker as Record<string, unknown>).task_id).toBe(taskId);
    // A work marker carries no epic_id.
    expect("epic_id" in (marker as Record<string, unknown>)).toBe(false);
    expect((marker as Record<string, unknown>).schema_version).toBe(1);
  });
});
