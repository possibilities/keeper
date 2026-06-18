// Consistency checks for the hand-written source skills (next / defer / close)
// and the work/worker templates against the live CLI surface and the canon's
// prose invariants. Translated from the markdown-consistency pytest modules:
// every `planctl <verb>` in a fenced bash block must resolve to a real command
// (--help exit 0); frontmatter `name:` is the bare verb; the agentId capture
// regex is `re.search`-shaped; the close coordinator's finalize switch is total
// over CLOSE_OUTCOMES and carries no stale pointers; the work template spawns
// the envelope's worker_agent with no bare literal / model= kwarg; the worker
// template's doc-discipline block holds its shape; and every checked-in epic
// JSON is clean of the retired audited_into / draft fields.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOSE_OUTCOMES } from "../src/verbs/close_finalize.ts";
import { runCli } from "./harness.ts";

const REPO = join(import.meta.dir, "..");
const CWD = mkdtempSync(join(tmpdir(), "planctl-consistency-"));

// Multi-word verb prefixes the CLI exposes as nested groups. When a `planctl
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

/** Every `planctl <verb>` argv tuple in the text's fenced bash blocks, sorted. */
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
    for (const m of line.matchAll(/planctl\s+([\w-]+(?:\s+[\w-]+)*)/g)) {
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
    label: "next",
    path: join(REPO, "skills", "next", "SKILL.md"),
    name: "next",
    mutatingVerb: "planctl epic queue-jump",
  },
  {
    label: "defer",
    path: join(REPO, "skills", "defer", "SKILL.md"),
    name: "defer",
    mutatingVerb: "planctl scaffold",
  },
  {
    label: "close",
    path: join(REPO, "skills", "close", "SKILL.md"),
    name: "close",
    mutatingVerb: "planctl",
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

    test("extracts at least one planctl verb from a fenced bash block", () => {
      const verbs = extractPlanctlVerbs(readFileSync(skill.path, "utf-8"));
      expect(verbs.length).toBeGreaterThan(0);
    });

    test("every extracted planctl verb responds to --help (exit 0)", () => {
      const verbs = extractPlanctlVerbs(readFileSync(skill.path, "utf-8"));
      for (const parts of verbs) {
        const r = runCli([...parts, "--help"], { cwd: CWD });
        expect(r.code).toBe(0);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// defer-specific: omits queue_jump: true (board priority lives in /plan:next)
// ---------------------------------------------------------------------------

describe("defer skill board-priority discipline", () => {
  test("omits the `queue_jump: true` literal entirely", () => {
    const text = readFileSync(
      join(REPO, "skills", "defer", "SKILL.md"),
      "utf-8",
    );
    expect(text).not.toContain("queue_jump: true");
  });
});

// ---------------------------------------------------------------------------
// next-specific: the epic queue-jump verb path surfaces from extraction
// ---------------------------------------------------------------------------

describe("next skill verb extraction", () => {
  test("`epic queue-jump` surfaces from the fenced-bash extraction", () => {
    const verbs = extractPlanctlVerbs(
      readFileSync(join(REPO, "skills", "next", "SKILL.md"), "utf-8"),
    );
    expect(verbs.some((v) => v[0] === "epic" && v[1] === "queue-jump")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// close skill: agentId regex, blind spawns, total switch, no stale pointers
// ---------------------------------------------------------------------------

const CLOSE_SKILL = join(REPO, "skills", "close", "SKILL.md");
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
// work.md.tmpl — verb guard, agentId regex, tier-routed agents, spawn shape
// ---------------------------------------------------------------------------

const WORK_TMPL = join(REPO, "template", "skills", "work.md.tmpl");
const WORK_AGENT_ID_SAMPLE =
  "Worker complete.\n" +
  "agentId: a1b2c3d4e5f6 (use SendMessage with to: 'a1b2c3d4e5f6' " +
  "to continue this agent)";

describe("work.md.tmpl verb-existence guard", () => {
  test("extracts at least one planctl verb", () => {
    expect(
      extractPlanctlVerbs(readFileSync(WORK_TMPL, "utf-8")).length,
    ).toBeGreaterThan(0);
  });

  test("every extracted planctl verb responds to --help (exit 0)", () => {
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

const TIERS = ["medium", "high", "xhigh", "max"] as const;

describe("tier-routed worker agents in the plan plugin", () => {
  for (const tier of TIERS) {
    test(`agents/worker-${tier}.md is rendered with the tier frontmatter`, () => {
      const path = join(REPO, "agents", `worker-${tier}.md`);
      expect(existsSync(path)).toBe(true);
      const fm = parseFrontmatter(frontmatterBlock(path));
      expect(fm.name).toBe(`worker-${tier}`);
      expect(fm.model).toBe("opus");
      expect(fm.effort).toBe(tier);
      expect(fm.maxTurns).toBe("300");
    });
  }
});

describe("work.md.tmpl spawn shape", () => {
  test("envelope-driven worker_agent spawn, no bare literal, no model=", () => {
    const tmpl = readFileSync(WORK_TMPL, "utf-8");
    const spawnBlocks = extractTaskCallBlocks(tmpl).filter((b) =>
      b.includes("<worker_agent>"),
    );
    expect(spawnBlocks.length).toBeGreaterThanOrEqual(2);
    expect(tmpl).not.toContain("work:worker");
    expect(tmpl).not.toContain("plugin-dir");
    expect(tmpl).toContain("plan:worker-<tier>");
    expect(tmpl).not.toContain('subagent_type=f"plan:worker-{tier}"');
    expect(tmpl).not.toContain("planctl task set-tier");
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

const EPICS_DIR = join(REPO, ".planctl", "epics");

function epicFiles(): string[] {
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
