// Consistency checks for the hand-written source skills (next / defer / close)
// and the work/worker templates against the live CLI surface and the canon's
// prose invariants. Translated from the markdown-consistency pytest modules:
// every `keeper plan <verb>` in a fenced bash block must resolve to a real command
// (--help exit 0); frontmatter `name:` is the bare verb; the agentId capture
// regex is `re.search`-shaped; the close coordinator's finalize switch is total
// over CLOSE_OUTCOMES and carries no stale pointers; the work template spawns
// the constant work:worker with no model= kwarg; the worker template's
// doc-discipline block holds its shape; and every checked-in epic JSON is clean
// of the retired audited_into / draft fields.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveMatrix,
  hostMatrixV2ProviderRoute,
  loadHostMatrixV2,
} from "../src/host_matrix.ts";
import { CLOSE_OUTCOMES } from "../src/verbs/close_finalize.ts";
import { runCli } from "./harness.ts";

const REPO = join(import.meta.dir, "..");
const CWD = mkdtempSync(join(tmpdir(), "planctl-consistency-"));

// workers/ is gitignored (rendered per-cell from the required host matrix), so a
// clean checkout that never ran render-plugin-templates has no cells on disk. The
// per-cell enumeration below skips there instead of failing hard; install.sh and
// promote.sh render before the suite runs, so real-checkout coverage is preserved.
const WORKERS_RENDERED = existsSync(join(REPO, "workers"));

// agents/ is likewise gitignored — the static plan agents render from
// template/agents/*.md.tmpl with their model/effort injected from the host
// matrix agent_pins. A clean checkout has none until render-plugin-templates
// runs (install.sh / promote.sh render first), so the frontmatter/body checks
// below gate on the rendered artifact's presence rather than failing hard.
const AGENTS_RENDERED = existsSync(join(REPO, "agents", "model-selector.md"));

// Multi-word verb prefixes the CLI exposes as nested groups. When a `keeper plan
// <words…>` reference starts with one of these, both words form the verb path.
const MULTIWORD_PREFIXES = new Set([
  "epic",
  "task",
  "worker",
  "dep",
  "config",
  "audit",
  "verdict",
  "followup",
]);

/** Raw text between the leading `---` frontmatter delimiters (exclusive). */
function frontmatterBlock(path: string): string {
  const text = readFileSync(path, "utf-8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (m === null) {
    throw new Error(`no frontmatter delimiter pair in ${path}`);
  }
  return m[1] as string;
}

/** Parse top-level `key: value` frontmatter lines (continuations folded in). */
function parseFrontmatter(block: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const lines = block.split("\n");
  let i = 0;
  while (i < lines.length) {
    const keyMatch = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(lines[i] as string);
    if (keyMatch === null) {
      i += 1;
      continue;
    }
    const key = keyMatch[1] as string;
    const parts = [keyMatch[2] as string];
    i += 1;
    while (
      i < lines.length &&
      ((lines[i] as string).startsWith(" ") ||
        (lines[i] as string).startsWith("\t"))
    ) {
      parts.push((lines[i] as string).trim());
      i += 1;
    }
    let value = parts.join("\n").trim();
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === '"' || value[0] === "'")
    ) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return fm;
}

/** Every `keeper plan <verb>` argv tuple in the text's fenced bash blocks, sorted. */
function extractPlanctlVerbs(text: string): string[][] {
  const verbs = new Set<string>();
  let inBash = false;
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("```bash")) {
      inBash = true;
      continue;
    }
    if (stripped.startsWith("```")) {
      inBash = false;
      continue;
    }
    if (!inBash) {
      continue;
    }
    for (const m of line.matchAll(/keeper\s+plan\s+([\w-]+(?:\s+[\w-]+)*)/g)) {
      const words = (m[1] as string).split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        continue;
      }
      const head = words[0] as string;
      if (MULTIWORD_PREFIXES.has(head) && words.length >= 2) {
        verbs.add(JSON.stringify([head, words[1]]));
      } else {
        verbs.add(JSON.stringify([head]));
      }
    }
  }
  return [...verbs].sort().map((s) => JSON.parse(s) as string[]);
}

/** Each `Task(...)` literal block in the text (paren-depth bounded). */
function extractTaskCallBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!(lines[i] as string).includes("Task(")) {
      i += 1;
      continue;
    }
    let depth = 0;
    const start = i;
    const captured: string[] = [];
    while (i < lines.length) {
      const ln = lines[i] as string;
      captured.push(ln);
      depth += (ln.match(/\(/g) ?? []).length - (ln.match(/\)/g) ?? []).length;
      i += 1;
      if (depth <= 0 && start !== i - 1) {
        break;
      }
      if (depth <= 0) {
        break;
      }
    }
    blocks.push(captured.join("\n"));
  }
  return blocks;
}

// The agentId capture regex the work/close skills use on the Task tool result.
const AGENT_ID_PATTERN = /agentId:\s*([a-f0-9]{10,})/;

// ---------------------------------------------------------------------------
// next / defer / close — bare-verb skills: existence, frontmatter, verb guard
// ---------------------------------------------------------------------------

interface BareVerbSkill {
  label: string;
  path: string;
  name: string;
  mutatingVerb: string;
}

const BARE_VERB_SKILLS: BareVerbSkill[] = [
  {
    label: "defer",
    path: join(REPO, "skills", "defer", "SKILL.md"),
    name: "defer",
    mutatingVerb: "keeper plan scaffold",
  },
  {
    label: "close",
    path: join(REPO, "skills", "close", "SKILL.md"),
    name: "close",
    mutatingVerb: "keeper plan",
  },
];

for (const skill of BARE_VERB_SKILLS) {
  describe(`${skill.label} skill consistency`, () => {
    test("exists as tracked source at the documented path", () => {
      expect(existsSync(skill.path)).toBe(true);
    });

    test(`name: is the bare verb ${skill.label}`, () => {
      const fm = parseFrontmatter(frontmatterBlock(skill.path));
      expect(fm.name).toBe(skill.name);
    });

    test("references its mutating verb", () => {
      expect(readFileSync(skill.path, "utf-8")).toContain(skill.mutatingVerb);
    });

    test("extracts at least one keeper plan verb from a fenced bash block", () => {
      const verbs = extractPlanctlVerbs(readFileSync(skill.path, "utf-8"));
      expect(verbs.length).toBeGreaterThan(0);
    });

    test("every extracted keeper plan verb responds to --help (exit 0)", () => {
      const verbs = extractPlanctlVerbs(readFileSync(skill.path, "utf-8"));
      for (const parts of verbs) {
        const r = runCli([...parts, "--help"], { cwd: CWD });
        expect(r.code).toBe(0);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// plan/defer model selector: content-blind subagent, no inline model override
// ---------------------------------------------------------------------------

const PLAN_SKILL = join(REPO, "skills", "plan", "SKILL.md");
const DEFER_SKILL = join(REPO, "skills", "defer", "SKILL.md");
const CLOSE_SKILL = join(REPO, "skills", "close", "SKILL.md");
const MODEL_SELECTOR_AGENT = join(REPO, "agents", "model-selector.md");
const MODEL_GUIDANCE_SKILL = join(REPO, "skills", "model-guidance", "SKILL.md");
const PANEL_GUIDANCE_SKILL = join(REPO, "skills", "panel-guidance", "SKILL.md");

describe("panel-guidance skill consistency", () => {
  test("exists as source in its documented skill directory", () => {
    expect(existsSync(PANEL_GUIDANCE_SKILL)).toBe(true);
    expect(readdirSync(join(REPO, "skills", "panel-guidance"))).toContain(
      "SKILL.md",
    );
  });

  test("name: is the bare verb panel-guidance", () => {
    const fm = parseFrontmatter(frontmatterBlock(PANEL_GUIDANCE_SKILL));
    expect(fm.name).toBe("panel-guidance");
  });

  test("stays slash-only", () => {
    const fm = parseFrontmatter(frontmatterBlock(PANEL_GUIDANCE_SKILL));
    expect(fm["disable-model-invocation"]).toBe("true");
  });

  test("grants only the roster-authoring tools", () => {
    const fm = parseFrontmatter(frontmatterBlock(PANEL_GUIDANCE_SKILL));
    const tools = fm["allowed-tools"] as string;
    for (const tool of [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "AskUserQuestion",
      "Bash(bun plugins/plan/scripts/panel-guidance-check.ts:*)",
      "Bash(keeper agent presets list:*)",
      "Bash(keeper agent providers check:*)",
      "Bash(cp plugins/plan/panel-selector.yaml:*)",
    ]) {
      expect(tools).toContain(tool);
    }
  });
});

describe("model-guidance skill frontmatter", () => {
  test("name: is the bare verb model-guidance", () => {
    const fm = parseFrontmatter(frontmatterBlock(MODEL_GUIDANCE_SKILL));
    expect(fm.name).toBe("model-guidance");
  });

  test("grants AskUserQuestion in allowed-tools", () => {
    const fm = parseFrontmatter(frontmatterBlock(MODEL_GUIDANCE_SKILL));
    expect(fm["allowed-tools"]).toContain("AskUserQuestion");
  });

  test("stays slash-only", () => {
    const fm = parseFrontmatter(frontmatterBlock(MODEL_GUIDANCE_SKILL));
    expect(fm["disable-model-invocation"]).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// cell-review — the out-of-band selection-grading skill. Static (no .tmpl, no
// managed sidecar), slash-only, and every keeper plan verb it drives resolves
// against the live CLI.
// ---------------------------------------------------------------------------

const CELL_REVIEW_SKILL = join(REPO, "skills", "cell-review", "SKILL.md");

describe("cell-review skill consistency", () => {
  test("exists as tracked source at the documented path", () => {
    expect(existsSync(CELL_REVIEW_SKILL)).toBe(true);
  });

  test("name: is the bare verb cell-review", () => {
    const fm = parseFrontmatter(frontmatterBlock(CELL_REVIEW_SKILL));
    expect(fm.name).toBe("cell-review");
  });

  test("stays slash-only", () => {
    const fm = parseFrontmatter(frontmatterBlock(CELL_REVIEW_SKILL));
    expect(fm["disable-model-invocation"]).toBe("true");
  });

  test("is static — the skill dir carries no .tmpl or managed-file sidecar", () => {
    const entries = readdirSync(join(REPO, "skills", "cell-review"));
    expect(entries).toContain("SKILL.md");
    for (const e of entries) {
      expect(e.endsWith(".tmpl")).toBe(false);
      expect(e.includes("managed-file")).toBe(false);
    }
  });

  test("references both mutating verbs it drives", () => {
    const text = readFileSync(CELL_REVIEW_SKILL, "utf-8");
    expect(text).toContain("keeper plan selection-audit-brief");
    expect(text).toContain("keeper plan selection-review-submit");
  });

  test("extracts at least one keeper plan verb from a fenced bash block", () => {
    const verbs = extractPlanctlVerbs(readFileSync(CELL_REVIEW_SKILL, "utf-8"));
    expect(verbs.length).toBeGreaterThan(0);
  });

  test("every extracted keeper plan verb responds to --help (exit 0)", () => {
    const verbs = extractPlanctlVerbs(readFileSync(CELL_REVIEW_SKILL, "utf-8"));
    for (const parts of verbs) {
      const r = runCli([...parts, "--help"], { cwd: CWD });
      expect(r.code).toBe(0);
    }
  });
});

describe.skipIf(!AGENTS_RENDERED)("model-selector agent frontmatter", () => {
  test("exists as a rendered agent named model-selector", () => {
    expect(existsSync(MODEL_SELECTOR_AGENT)).toBe(true);
    const fm = parseFrontmatter(frontmatterBlock(MODEL_SELECTOR_AGENT));
    expect(fm.name).toBe("model-selector");
  });

  test("pins its own model/effort and disallows write/exec/spawn tools", () => {
    const fm = parseFrontmatter(frontmatterBlock(MODEL_SELECTOR_AGENT));
    expect(fm.model).toBe("opus");
    expect(fm.effort).toBe("high");
    expect(fm.disallowedTools).toContain("Edit");
    expect(fm.disallowedTools).toContain("Write");
    expect(fm.disallowedTools).toContain("Bash");
    expect(fm.disallowedTools).toContain("Task");
  });
});

describe("plan/defer/close selector handoff", () => {
  for (const [label, path] of [
    ["plan", PLAN_SKILL],
    ["defer", DEFER_SKILL],
    ["close", CLOSE_SKILL],
  ] as const) {
    test(`${label} uses selection-brief + plan:model-selector with no model=`, () => {
      const text = readFileSync(path, "utf-8");
      expect(text).toContain("keeper plan selection-brief");
      expect(text).toContain('subagent_type="plan:model-selector"');
      const selectorBlocks = extractTaskCallBlocks(text).filter((b) =>
        b.includes("plan:model-selector"),
      );
      expect(selectorBlocks.length).toBeGreaterThanOrEqual(1);
      for (const block of selectorBlocks) {
        expect(block).not.toContain("model=");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// plan refine selection beat (R6): the refine path re-selects every remaining
// todo cell before arming — pinned so the refine copy cannot drift back to
// claiming it skips selection and rejoins the arm unselected.
// ---------------------------------------------------------------------------

describe("plan skill refine selection beat", () => {
  test("R6 runs the selection beat over the re-ghosted epic before the arm", () => {
    const text = readFileSync(PLAN_SKILL, "utf-8");
    expect(text).toContain("### R6.");
    expect(text).toContain("keeper plan selection-brief");
    expect(text).toContain("keeper plan apply-selection");
  });

  test("states the full-set re-select and the clean zero-todo skip", () => {
    const text = readFileSync(PLAN_SKILL, "utf-8");
    // The full-set/todo-only contract is stated plainly.
    expect(text).toContain("every remaining todo task's cell");
    // The zero-todo skip keys on the selection-brief NO_TODO_TASKS error.
    expect(text).toContain("NO_TODO_TASKS");
  });

  test("no prose claims the refine path skips selection or rejoins unselected", () => {
    const text = readFileSync(PLAN_SKILL, "utf-8");
    expect(text).not.toMatch(/refine path skips (this|the) beat/i);
    expect(text).not.toMatch(/skips this beat entirely/i);
    expect(text).not.toMatch(/rejoins at Phase 7/i);
  });
});

// ---------------------------------------------------------------------------
// defer-specific: carries no board-priority knob
// ---------------------------------------------------------------------------

describe("defer skill board-priority discipline", () => {
  test("carries no `queue_jump` literal", () => {
    const text = readFileSync(
      join(REPO, "skills", "defer", "SKILL.md"),
      "utf-8",
    );
    expect(text).not.toContain("queue_jump");
  });
});

// ---------------------------------------------------------------------------
// close skill: agentId regex, blind spawns, total switch, no stale pointers
// ---------------------------------------------------------------------------

const CLOSE_AGENT_ID_SAMPLE =
  "QUESTION pending.\n" +
  "agentId: a1b2c3d4e5f6 (use SendMessage with to: 'a1b2c3d4e5f6' " +
  "to continue this agent)";

describe("close skill agentId capture regex", () => {
  test("search captures the hex agent_id from the sample", () => {
    const m = AGENT_ID_PATTERN.exec(CLOSE_AGENT_ID_SAMPLE);
    expect(m).not.toBeNull();
    expect((m as RegExpExecArray)[1]).toBe("a1b2c3d4e5f6");
  });

  test("the regex is search-shaped (no anchored ^ — content precedes it)", () => {
    // The sample has content before `agentId:`; an anchored ^ regex would miss.
    const anchored = /^agentId:\s*([a-f0-9]{10,})/;
    expect(anchored.test(CLOSE_AGENT_ID_SAMPLE)).toBe(false);
    expect(AGENT_ID_PATTERN.test(CLOSE_AGENT_ID_SAMPLE)).toBe(true);
  });

  test("the skill pins the agentId capture regex literal", () => {
    expect(readFileSync(CLOSE_SKILL, "utf-8")).toContain(
      "agentId:\\s*([a-f0-9]{10,})",
    );
  });
});

describe("close skill coordinator invariants", () => {
  test("both agent spawns are blind: namespaced ids, no model= kwarg", () => {
    const text = readFileSync(CLOSE_SKILL, "utf-8");
    const blocks = extractTaskCallBlocks(text);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const spawned = new Set(
      ["quality-auditor", "close-planner"].filter((kind) =>
        blocks.some((b) => b.includes(kind)),
      ),
    );
    expect([...spawned].sort()).toEqual(["close-planner", "quality-auditor"]);
    for (const kind of ["quality-auditor", "close-planner"]) {
      expect(text).toContain(`subagent_type="plan:${kind}"`);
    }
    for (const block of blocks) {
      expect(block).not.toContain("model=");
    }
  });

  test("finalize switch is total over CLOSE_OUTCOMES", () => {
    const text = readFileSync(CLOSE_SKILL, "utf-8");
    const enumValues = Object.values(CLOSE_OUTCOMES);
    const named = enumValues.filter((v) => text.includes(`\`${v}\``));
    expect(named.sort()).toEqual([...enumValues].sort());
  });

  test("carries no version-pinned model ids or retired pointers", () => {
    const text = readFileSync(CLOSE_SKILL, "utf-8");
    const forbidden = [
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "<VERDICT_JSON>",
      "classifier",
      "session_naming",
      "hookctl",
    ];
    expect(forbidden.filter((needle) => text.includes(needle))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// close skill pre-select beat: the interposed cell-selection beat briefs the
// stored follow-up (--from-followup), spawns the selector blind, hands finalize
// a --selection-verdict file, and degrades to a verdict-less finalize — pinned
// so the close copy cannot drift out of parity with the defer Phase 4b beat.
// ---------------------------------------------------------------------------

describe("close skill pre-select beat", () => {
  test("briefs the stored follow-up via selection-brief --from-followup", () => {
    const text = readFileSync(CLOSE_SKILL, "utf-8");
    expect(text).toContain("keeper plan selection-brief");
    expect(text).toContain("--from-followup");
  });

  test("spawns the selector blind and hands finalize a --selection-verdict", () => {
    const text = readFileSync(CLOSE_SKILL, "utf-8");
    const selectorBlocks = extractTaskCallBlocks(text).filter((b) =>
      b.includes("plan:model-selector"),
    );
    expect(selectorBlocks.length).toBeGreaterThanOrEqual(1);
    for (const block of selectorBlocks) {
      expect(block).not.toContain("model=");
    }
    expect(text).toContain("--selection-verdict");
  });

  test("degrades to a verdict-less finalize, never a retry loop", () => {
    const text = readFileSync(CLOSE_SKILL, "utf-8");
    expect(text).toContain("verdict-less");
    expect(text).toContain("never a retry loop");
  });
});

// ---------------------------------------------------------------------------
// close skill blocking-follow-up gate: the SKILL must drive every new gate beat
// — the preflight re-entry short-circuit, the armed-mode arm, and the
// deleted-follow-up epic-question escalation — and grant the autopilot Bash it
// needs to arm. Pinned so the gate contract cannot silently rot back to the
// non-blocking flow.
// ---------------------------------------------------------------------------

describe("close skill blocking-follow-up gate contract", () => {
  const body = () => readFileSync(CLOSE_SKILL, "utf-8");

  test("frontmatter grants the autopilot Bash the armed-mode arm needs", () => {
    const fm = parseFrontmatter(frontmatterBlock(CLOSE_SKILL));
    expect(fm["allowed-tools"]).toContain("Bash(keeper autopilot:*)");
  });

  test("re-entry short-circuits on the preflight blocking_followup field", () => {
    const text = body();
    expect(text).toContain("blocking_followup");
    // The short-circuit skips the audit/plan spawns straight to finalize.
    expect(text).toContain("straight to Phase 4");
  });

  test("the followup_blocks_close branch arms the follow-up under armed mode", () => {
    const text = body();
    expect(text).toContain("keeper autopilot show");
    expect(text).toContain("keeper autopilot arm");
    // The gate defers to a human when the arm cannot land, never wedging.
    expect(text).toContain("waits on a human");
  });

  test("a deleted follow-up escalates via the source epic-question", () => {
    const text = body();
    expect(text).toContain("BLOCKING_FOLLOWUP_DELETED");
    expect(text).toContain("keeper plan epic-question");
  });

  test("carries the followup_blocks_close deferred-close report phrase", () => {
    expect(body()).toContain("held open by blocking follow-up");
  });
});

// ---------------------------------------------------------------------------
// close skill durable phase-resume gate: a hash-fresh typed preflight signal
// resumes only the first unfinished phase without the coordinator opening an
// artifact or re-spawning already completed work.
// ---------------------------------------------------------------------------

describe("close skill durable phase-resume gate contract", () => {
  const body = () => readFileSync(CLOSE_SKILL, "utf-8");

  test("documents the typed resume field and blocking-followup precedence", () => {
    const text = body();
    expect(text).toContain("phase_resume");
    expect(text).toContain(
      "`blocking_followup` takes precedence over `phase_resume`",
    );
  });

  test("skips satisfied or not_needed phases without agent re-spawns", () => {
    const text = body();
    expect(text).toContain("not_needed");
    expect(text).toContain("without re-spawning agents");
  });

  test("remains content-blind while switching on the resume field", () => {
    expect(body()).toContain(
      "NEVER reads `state/audits` artifacts itself to make this decision",
    );
  });
});

// ---------------------------------------------------------------------------
// close-planner: follow-up template stamps both tier and model as enum
// placeholders marked REQUIRED. Shape-only by design: the rendered agent file
// carries enums from the HOST matrix it was rendered from, while this suite
// runs under the sandboxed claude-only fixture matrix (preload-host-matrix) —
// comparing exact enum content across those two sources is a category error.
// Exact enum parity belongs to the render pipeline that owns the bytes.
// ---------------------------------------------------------------------------

const CLOSE_PLANNER = join(REPO, "agents", "close-planner.md");

describe.skipIf(!AGENTS_RENDERED)(
  "close-planner follow-up template tier/model shape",
  () => {
    test("template block carries both `tier:` and `model:` enum lines marked REQUIRED", () => {
      const text = readFileSync(CLOSE_PLANNER, "utf-8");
      const tierLine = /tier: <[a-z]+(\|[a-z]+)+>\s+# REQUIRED/;
      const modelLine = /model: <[a-z0-9.-]+(\|[a-z0-9.-]+)+>\s+# REQUIRED/;
      expect(text).toMatch(tierLine);
      expect(text).toMatch(modelLine);
    });

    test("task-spec rules prose requires both tier and model", () => {
      const text = readFileSync(CLOSE_PLANNER, "utf-8");
      expect(text).toContain("`tier` and `model` are both required per task");
    });
  },
);

describe.skipIf(!AGENTS_RENDERED)(
  "close-planner blocking-decision contract",
  () => {
    const body = () => readFileSync(CLOSE_PLANNER, "utf-8");

    test("verdict shape carries the blocks_closing / blocks_closing_reason pair", () => {
      const text = body();
      expect(text).toContain('"blocks_closing"');
      expect(text).toContain('"blocks_closing_reason"');
    });

    test("the rubric is consumer-observable with a default-to-not-block", () => {
      const text = body();
      expect(text).toContain("consumer-observable");
      expect(text).toContain("When torn, do not block");
    });

    test("the blocking case drops the source dep and adds an Overview provenance line", () => {
      const text = body();
      // The blocking follow-up omits the source-link the finalize verb substitutes.
      expect(text).toMatch(/omit.*depends_on_epics/i);
      expect(text).toContain("blocks the close of");
    });
  },
);

// ---------------------------------------------------------------------------
// panel skill — thin shim spawns plan:panel-runner; the runner agent's
// frontmatter; the stale "never in a subagent" claim gone from both surfaces
// ---------------------------------------------------------------------------

const PANEL_RUNNER = join(REPO, "agents", "panel-runner.md");
const PANEL_SKILL = join(REPO, "skills", "panel", "SKILL.md");
const PANEL_REFERENCE = join(REPO, "skills", "panel", "references", "panel.md");

describe.skipIf(!AGENTS_RENDERED)("panel-runner agent frontmatter", () => {
  test("exists as a rendered agent named panel-runner", () => {
    expect(existsSync(PANEL_RUNNER)).toBe(true);
    const fm = parseFrontmatter(frontmatterBlock(PANEL_RUNNER));
    expect(fm.name).toBe("panel-runner");
  });

  test("pins model: opus", () => {
    const fm = parseFrontmatter(frontmatterBlock(PANEL_RUNNER));
    expect(fm.model).toBe("opus");
  });

  test("disallows Monitor (waits with blocking Bash) but keeps Task (spawns the judge)", () => {
    const fm = parseFrontmatter(frontmatterBlock(PANEL_RUNNER));
    expect(fm.disallowedTools).toContain("Monitor");
    expect(fm.disallowedTools).not.toContain("Task");
  });
});

describe.skipIf(!AGENTS_RENDERED)(
  "panel-runner wait discipline is drop-hardened",
  () => {
    const body = () => readFileSync(PANEL_RUNNER, "utf-8");

    test("the wait example carries the explicit Bash tool timeout parameter at its 10-min ceiling", () => {
      expect(body()).toContain("timeout: 600000");
    });

    test("states the verified harness defaults (120s default window, 600000ms ceiling)", () => {
      const text = body();
      expect(text).toContain("120000ms");
      expect(text).toContain("600000ms");
    });

    test("documents the auto-background envelope as a tripwire", () => {
      const text = body();
      expect(text).toContain("tripwire");
      expect(text).toContain("Command running in background");
    });

    test("bounds all re-issues with a stated backstop terminating in PANEL_RUN_FAILED", () => {
      const text = body();
      expect(text).toContain("backstop");
      expect(text).toContain("PANEL_RUN_FAILED");
    });

    test("forbids ending the turn while legs are non-terminal (house wording)", () => {
      expect(body()).toContain("never end a turn text-only to wait");
    });

    test("Step 6 return is positively marked with a first-line PANEL_ANSWER", () => {
      expect(body()).toContain("PANEL_ANSWER");
    });

    test("drops the false claim that a chunk is safe without the explicit timeout parameter", () => {
      expect(body()).not.toContain("safely under Bash's hard 10-min");
    });
  },
);

describe("panel skill shim", () => {
  test("spawns plan:panel-runner with no model= kwarg", () => {
    const text = readFileSync(PANEL_SKILL, "utf-8");
    const runnerBlocks = extractTaskCallBlocks(text).filter((b) =>
      b.includes("plan:panel-runner"),
    );
    expect(runnerBlocks.length).toBeGreaterThanOrEqual(1);
    expect(text).toContain('subagent_type="plan:panel-runner"');
    for (const block of runnerBlocks) {
      expect(block).not.toContain("model=");
    }
  });

  test("keys on the runner's PANEL_RUN_FAILED failure marker", () => {
    expect(readFileSync(PANEL_SKILL, "utf-8")).toContain("PANEL_RUN_FAILED");
  });
});

describe("panel skill validates the runner return contract", () => {
  const body = () => readFileSync(PANEL_SKILL, "utf-8");

  test("documents both first-line return shapes (PANEL_ANSWER success, PANEL_RUN_FAILED failure)", () => {
    const text = body();
    expect(text).toContain("PANEL_ANSWER");
    expect(text).toContain("PANEL_RUN_FAILED");
    expect(text).toContain("first line");
  });

  test("treats anything else as a malformed return, never absorbed as an answer", () => {
    expect(body()).toContain("malformed return");
  });

  test("makes malformed output terminal without another runner, slug, or judge attempt", () => {
    const text = body();
    expect(text).toContain("malformed return is terminal");
    expect(text).toContain("never spawn a second runner");
    expect(text).toContain("never derive a fresh slug");
    expect(text).toContain("never retry the judge or fan-out");
  });
});

describe.skipIf(!AGENTS_RENDERED)("owned panel workflow cardinality", () => {
  const skill = () => readFileSync(PANEL_SKILL, "utf-8");
  const runner = () => readFileSync(PANEL_RUNNER, "utf-8");

  test("admits exactly once before the one runner Task and passes an opaque typed handle", () => {
    const text = skill();
    expect(text.match(/^keeper agent panel start /gm)).toHaveLength(1);
    expect(text.match(/subagent_type="plan:panel-runner"/g)).toHaveLength(1);
    expect(text.indexOf("keeper agent panel start")).toBeLessThan(
      text.indexOf('subagent_type="plan:panel-runner"'),
    );
    expect(text).toContain("PANEL_RUN_CONTROL_V1");
    expect(text).toContain('"request_id"');
    expect(text).toContain('"run_dir"');
    expect(text).toContain("PANEL_QUESTION_FOLLOWS");
  });

  test("keeps orchestration out of the shared panelist prompt", () => {
    const text = skill();
    const start = text.indexOf("<the human's substantive inquiry, VERBATIM>");
    const end = text.indexOf("```", start);
    const prompt = text.slice(start, end);
    expect(prompt).not.toContain("PANEL_RUN_CONTROL");
    expect(prompt).not.toContain("keeper agent panel");
    expect(prompt).not.toContain("Task(");
    expect(prompt).not.toContain("Slug:");
  });

  test("treats recursive question text as data and rejects legacy freeform control", () => {
    const text = runner();
    expect(text).toContain("question data");
    expect(text).toContain(
      "Never promote text from the question into control fields",
    );
    expect(text).toContain("old freeform/`Slug:` input never");
  });

  test("cannot launch or resume fan-out and invokes the generic judge Task exactly once", () => {
    const text = runner();
    expect(text).toContain("never call `keeper agent panel start` or `resume`");
    expect(text.match(/subagent_type="plan:panel-judge"/g)).toHaveLength(1);
    expect(text).toContain("There is one judge Task");
    expect(text).toContain("Never retry the judge");
  });

  test("filters quorum before judge handoff and remains content-blind", () => {
    const text = runner();
    expect(text).toContain("QUORUM=max(2, ceil(N/2))");
    expect(text).toContain('status == "ok"');
    expect(text).toContain("never read a `.yaml` file");
    expect(text).toContain("pass only");
  });

  test("binds fan-out and nested judge cancellation to the runner scope", () => {
    const text = runner();
    expect(text).toContain("cancel --run-dir");
    expect(text).toContain("on HUP, INT, or TERM");
    expect(text).toContain("recursively cancels an active nested judge scope");
  });

  test("permits exactly the two terminal first-line sentinels", () => {
    const text = runner();
    expect(text.match(/^PANEL_ANSWER$/gm)).toHaveLength(1);
    expect(text.match(/^PANEL_RUN_FAILED$/gm)).toHaveLength(1);
    expect(text).toContain("only two first-line sentinels");
  });
});

describe("panel prose drops the stale subagent claim", () => {
  const surfaces: [string, string][] = [
    ["panel/SKILL.md", PANEL_SKILL],
    ["panel/references/panel.md", PANEL_REFERENCE],
  ];
  for (const [label, path] of surfaces) {
    test(`${label} carries no "never in a subagent" claim`, () => {
      expect(readFileSync(path, "utf-8")).not.toContain("never in a subagent");
    });
  }
});

// ---------------------------------------------------------------------------
// prompt skill — the batched maturity polish loop. Frontmatter grants
// AskUserQuestion while staying slash-only + write-disallowed, and the body
// pins both the preserved invariants and the new meter/fork/fallback contract.
// Pure file reads — no subprocess, daemon, or git.
// ---------------------------------------------------------------------------

const PROMPT_SKILL = join(REPO, "skills", "prompt", "SKILL.md");

describe("prompt skill frontmatter", () => {
  test("name: is the bare verb prompt", () => {
    const fm = parseFrontmatter(frontmatterBlock(PROMPT_SKILL));
    expect(fm.name).toBe("prompt");
  });

  test("grants AskUserQuestion in allowed-tools", () => {
    const fm = parseFrontmatter(frontmatterBlock(PROMPT_SKILL));
    expect(fm["allowed-tools"]).toContain("AskUserQuestion");
  });

  test("stays slash-only and disallows the write tools", () => {
    const fm = parseFrontmatter(frontmatterBlock(PROMPT_SKILL));
    expect(fm["disable-model-invocation"]).toBe("true");
    expect(fm["disallowed-tools"]).toBe("Edit, Write, NotebookEdit, TodoWrite");
  });
});

describe("prompt skill load-bearing literals", () => {
  const needles = [
    // preserved invariants
    "PROMPT_COPY_EOF",
    "wc -w",
    "collision-safe fence",
    "polarity",
    "Polish only",
    "Nothing persists to disk",
    "No `TodoWrite`",
    // batched-maturity contract
    "disable-model-invocation: true",
    "memo ▮▮▮▮▯▯ 4/6",
    "re-ask the same questions as plain text",
    "deliberate divergence",
  ];
  for (const needle of needles) {
    test(`pins the literal ${JSON.stringify(needle)}`, () => {
      expect(readFileSync(PROMPT_SKILL, "utf-8")).toContain(needle);
    });
  }
});

// ---------------------------------------------------------------------------
// work.md.tmpl — verb guard, agentId regex, tier-routed agents, spawn shape
// ---------------------------------------------------------------------------

const WORK_TMPL = join(REPO, "template", "skills", "work.md.tmpl");
const WORK_AGENT_ID_SAMPLE =
  "Worker complete.\n" +
  "agentId: a1b2c3d4e5f6 (use SendMessage with to: 'a1b2c3d4e5f6' " +
  "to continue this agent)";

describe("work.md.tmpl verb-existence guard", () => {
  test("extracts at least one keeper plan verb", () => {
    expect(
      extractPlanctlVerbs(readFileSync(WORK_TMPL, "utf-8")).length,
    ).toBeGreaterThan(0);
  });

  test("every extracted keeper plan verb responds to --help (exit 0)", () => {
    for (const parts of extractPlanctlVerbs(readFileSync(WORK_TMPL, "utf-8"))) {
      const r = runCli([...parts, "--help"], { cwd: CWD });
      expect(r.code).toBe(0);
    }
  });
});

describe("work.md.tmpl agentId capture regex", () => {
  test("search captures the hex agent_id", () => {
    const m = AGENT_ID_PATTERN.exec(WORK_AGENT_ID_SAMPLE);
    expect(m).not.toBeNull();
    expect((m as RegExpExecArray)[1]).toBe("a1b2c3d4e5f6");
  });

  test("no false positive on a string without agentId", () => {
    expect(AGENT_ID_PATTERN.test("no agent id here")).toBe(false);
  });

  test("the regex is search-shaped, not anchored", () => {
    const anchored = /^agentId:\s*([a-f0-9]{10,})/;
    expect(anchored.test(WORK_AGENT_ID_SAMPLE)).toBe(false);
  });
});

describe("generated work plugins in the plan plugin", () => {
  // The Claude prompt compiler fans out over the effective matrix using each
  // capability's own effort list. The cell path retains that assigned capability,
  // while frontmatter carries the exact Claude launch route: the cell itself when
  // native, or the fixed wrapper driver when wrapped.
  const matrix = effectiveMatrix();
  const host = loadHostMatrixV2();
  const wrapperRoute = hostMatrixV2ProviderRoute(
    host,
    "claude",
    host.wrapper_driver.model,
  );
  for (const model of matrix.models) {
    for (const effort of matrix.effortsFor(model)) {
      test.skipIf(!WORKERS_RENDERED)(
        `workers/${model}-${effort} renders a work plugin with the {model × effort} worker`,
        () => {
          const cellDir = join(REPO, "workers", `${model}-${effort}`);
          const manifestPath = join(cellDir, ".claude-plugin", "plugin.json");
          expect(existsSync(manifestPath)).toBe(true);
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
            name?: string;
          };
          expect(manifest.name).toBe("work");
          const agentPath = join(cellDir, "agents", "worker.md");
          expect(existsSync(agentPath)).toBe(true);
          const fm = parseFrontmatter(frontmatterBlock(agentPath));
          const native = host.driverByModel.get(model) === "native";
          const launch = native
            ? hostMatrixV2ProviderRoute(host, "claude", model)
            : wrapperRoute;
          expect(launch).toBeDefined();
          expect(fm.name).toBe("worker");
          expect(fm.model).toBe(launch?.launchId);
          expect(fm.effort).toBe(native ? effort : host.wrapper_driver.effort);
          expect(fm.maxTurns).toBe(native ? "300" : "160");
        },
      );
    }
  }
});

describe("work.md.tmpl spawn shape", () => {
  test("constant work:worker spawn, no composed literal, no model=", () => {
    const tmpl = readFileSync(WORK_TMPL, "utf-8");
    const spawnBlocks = extractTaskCallBlocks(tmpl).filter((b) =>
      b.includes("work:worker"),
    );
    expect(spawnBlocks.length).toBeGreaterThanOrEqual(2);
    expect(tmpl).toContain("work:worker");
    // The launch mechanism (--plugin-dir cell selection) is documented in prose.
    expect(tmpl).toContain("plugin-dir");
    expect(tmpl).not.toContain("plan:worker-<model>-<effort>");
    expect(tmpl).not.toContain('subagent_type=f"plan:worker-{tier}"');
    expect(tmpl).not.toContain("keeper plan task set-tier");
    for (const block of spawnBlocks) {
      expect(block).not.toContain("model=");
    }
  });
});

describe("work.md.tmpl input-shape contract", () => {
  test("`## When to invoke` names only the fn-N-slug.M task shape", () => {
    const tmpl = readFileSync(WORK_TMPL, "utf-8");
    const m = /^## When to invoke\s*\n([\s\S]*?)(?=^## )/m.exec(tmpl);
    expect(m).not.toBeNull();
    const section = (m as RegExpExecArray)[1] as string;
    expect(section).toContain("fn-N-slug.M");
    const leftover = section.split("fn-N-slug.M").join("");
    expect(leftover).not.toContain("fn-N-slug");
  });

  test("no bare-epic regex literal anywhere in the template", () => {
    const tmpl = readFileSync(WORK_TMPL, "utf-8");
    expect(tmpl).not.toContain("^fn-\\d+(-[a-z0-9-]+)?$");
  });
});

// ---------------------------------------------------------------------------
// worker.md.tmpl — doc & comment discipline block shape
// ---------------------------------------------------------------------------

const WORKER_TMPL = join(REPO, "template", "agents", "worker.md.tmpl");

/** Body of the `## Doc & comment discipline` section (up to the next `## `). */
function disciplineSection(text: string): string {
  const m = /^## Doc & comment discipline\s*\n([\s\S]*?)(?=^## )/m.exec(text);
  if (m === null) {
    throw new Error("`## Doc & comment discipline` section not found");
  }
  return m[1] as string;
}

describe("worker.md.tmpl doc & comment discipline block", () => {
  test("the discipline heading sits immediately before `## Rules`", () => {
    const tmpl = readFileSync(WORKER_TMPL, "utf-8");
    expect(tmpl).toContain("## Doc & comment discipline");
    const disciplineIdx = tmpl.indexOf("## Doc & comment discipline");
    const rulesIdx = tmpl.indexOf("## Rules", disciplineIdx);
    const between = tmpl.slice(
      disciplineIdx + "## Doc & comment discipline".length,
      rulesIdx,
    );
    expect(between).not.toContain("\n## ");
  });

  test("carries the protected-comments allowlist bullet", () => {
    const section = disciplineSection(readFileSync(WORKER_TMPL, "utf-8"));
    expect(section).toContain("Protected comments");
    for (const needle of ["noqa", "type: ignore", "SPDX"]) {
      expect(section).toContain(needle);
    }
  });

  test("stays at or under the 5-bullet ceiling", () => {
    const section = disciplineSection(readFileSync(WORKER_TMPL, "utf-8"));
    const bullets = section.split("\n").filter((ln) => ln.startsWith("- "));
    expect(bullets.length).toBeGreaterThanOrEqual(1);
    expect(bullets.length).toBeLessThanOrEqual(5);
  });

  test("carries no fn-N ticket id in the block prose", () => {
    const section = disciplineSection(readFileSync(WORKER_TMPL, "utf-8"));
    expect(/\bfn-\d+\b/.test(section)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// field absence — every checked-in epic JSON is clean of retired fields
// ---------------------------------------------------------------------------

// Plan state lives in the keeper repo-root `.keeper/`, two levels above the
// plugin (`plugins/plan/`); the plugin dir carries no data dir of its own.
const EPICS_DIR = join(REPO, "..", "..", ".keeper", "epics");

function epicFiles(): string[] {
  if (!existsSync(EPICS_DIR)) {
    return [];
  }
  return readdirSync(EPICS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

describe("checked-in epic JSON field hygiene", () => {
  for (const file of epicFiles()) {
    test(`${file} carries no retired audited_into / draft field`, () => {
      const obj = JSON.parse(
        readFileSync(join(EPICS_DIR, file), "utf-8"),
      ) as Record<string, unknown>;
      expect("audited_into" in obj).toBe(false);
      expect("draft" in obj).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// close skill auditor-fixture sanity — the close pipeline relies on these
// ---------------------------------------------------------------------------

const AUDITOR_DIR = join(import.meta.dir, "fixtures", "auditor");

describe("close skill auditor fixtures", () => {
  test("clean.md exists, is non-empty, and is a Quality Audit Report", () => {
    const content = readFileSync(join(AUDITOR_DIR, "clean.md"), "utf-8");
    expect(content).toContain("Quality Audit Report");
    expect(content.length).toBeGreaterThan(50);
  });

  test("with_findings.md exists and names a findings tier", () => {
    const content = readFileSync(
      join(AUDITOR_DIR, "with_findings.md"),
      "utf-8",
    );
    expect(content.includes("Should Fix") || content.includes("Consider")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// brain — the model-invocable Agentbrain routing/safety skill, and the one
// concise /hack delegation pointer to it outside hack's BAKE regions.
// ---------------------------------------------------------------------------

const BRAIN_SKILL = join(REPO, "skills", "brain", "SKILL.md");
const HACK_SKILL = join(REPO, "skills", "hack", "SKILL.md");

describe("brain skill consistency", () => {
  test("exists as tracked source at the documented path", () => {
    expect(existsSync(BRAIN_SKILL)).toBe(true);
  });

  test("name: is the bare verb brain", () => {
    const fm = parseFrontmatter(frontmatterBlock(BRAIN_SKILL));
    expect(fm.name).toBe("brain");
  });

  test("is model-invocable, not slash-only", () => {
    const fm = parseFrontmatter(frontmatterBlock(BRAIN_SKILL));
    expect(fm["disable-model-invocation"]).toBeUndefined();
  });

  test("grants only Agentbrain-scoped Bash access", () => {
    const fm = parseFrontmatter(frontmatterBlock(BRAIN_SKILL));
    expect(fm["allowed-tools"]).toBe("Bash(agentbrain:*)");
  });

  test("description names every positive trigger", () => {
    const fm = parseFrontmatter(frontmatterBlock(BRAIN_SKILL));
    // Fold the hand-rolled parser's literal "\n" continuations to spaces —
    // matches how a real YAML ">-" folded scalar renders to the model.
    const description = (fm.description ?? "").replace(/\s+/g, " ");
    for (const needle of [
      "here's a link",
      "store an article",
      "watch or check a supported blog or X source",
      "already saved",
      "durable-knowledge question",
      "queued, blocked, or failed",
    ]) {
      expect(description).toContain(needle);
    }
  });

  test("description routes every near miss away from Agentbrain", () => {
    const fm = parseFrontmatter(frontmatterBlock(BRAIN_SKILL));
    const description = (fm.description ?? "").replace(/\s+/g, " ");
    for (const needle of [
      "repository code question",
      "keeper history",
      "WebSearch",
      "Gmail",
      "Agentscrape",
    ]) {
      expect(description).toContain(needle);
    }
  });

  test("body distinguishes an unsupported connector from an implemented one", () => {
    const text = readFileSync(BRAIN_SKILL, "utf-8");
    expect(text).toContain("not supported");
  });

  test("retrieval guidance names every citation field", () => {
    const text = readFileSync(BRAIN_SKILL, "utf-8");
    for (const field of ["document_id", "chunk_id", "title", "source_uri"]) {
      expect(text).toContain(field);
    }
  });

  test("retrieval guidance discloses truncation and treats retrieved content as untrusted", () => {
    const text = readFileSync(BRAIN_SKILL, "utf-8");
    expect(text).toContain("truncated");
    expect(text).toContain("untrusted");
  });

  test("queue guidance reports job_id, distinguishes attempts, and gates reveal", () => {
    const text = readFileSync(BRAIN_SKILL, "utf-8");
    expect(text).toContain("job_id");
    expect(text).toContain("attempt");
    expect(text).toContain("--reveal-content");
  });

  test("queue guidance forbids tight polling and blind retry", () => {
    const text = readFileSync(BRAIN_SKILL, "utf-8");
    expect(text.toLowerCase()).toContain("don't poll tightly");
  });

  test("carries no retired Linkctl reference", () => {
    const text = readFileSync(BRAIN_SKILL, "utf-8");
    expect(text.toLowerCase()).not.toContain("linkctl");
  });
});

describe("hack delegates to brain outside its BAKE regions", () => {
  test("references brain via the Skill tool exactly once", () => {
    const text = readFileSync(HACK_SKILL, "utf-8");
    const matches = text.match(/invoke `brain`/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test("the delegation line sits outside every BAKE guard", () => {
    const text = readFileSync(HACK_SKILL, "utf-8");
    const lines = text.split("\n");
    let inBake = false;
    let sawDelegation = false;
    for (const line of lines) {
      if (line.includes("BAKE:BEGIN")) inBake = true;
      if (line.includes("BAKE:END")) inBake = false;
      if (line.includes("invoke `brain`")) {
        expect(inBake).toBe(false);
        sawDelegation = true;
      }
    }
    expect(sawDelegation).toBe(true);
  });

  test("hack keeps its full complement of BAKE guards (drift gate covers byte content)", () => {
    const text = readFileSync(HACK_SKILL, "utf-8");
    const begins = text.match(/<!-- BAKE:BEGIN/g) ?? [];
    const ends = text.match(/<!-- BAKE:END/g) ?? [];
    expect(begins.length).toBe(7);
    expect(ends.length).toBe(7);
  });

  test("does not duplicate an Agentbrain CLI recipe inline", () => {
    const text = readFileSync(HACK_SKILL, "utf-8");
    expect(text).not.toContain("agentbrain submit");
    expect(text).not.toContain("agentbrain search");
  });
});
