/**
 * Fixture corpus for the domain-docs lint arm (src/commit-work/domain-docs-lint.ts).
 * No prior-art glossary linter exists, so the proof is the corpus: known-GOOD
 * glossary lines (including prose naming CLI commands and slash-terms) must pass,
 * and known-BAD lines must fail. Drives the pure scanners directly (fast tier, no
 * subprocess/git) plus one integration pass through `runScopedLint` with an
 * injected staged file and a sandboxed pain-ledger path.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAdrPath,
  isContextDocPath,
  resolveDomainDocsLedgerPath,
  scanAdrFile,
  scanAdrSet,
  scanContextDoc,
} from "../src/commit-work/domain-docs-lint";
import { LintFailure, runScopedLint } from "../src/commit-work/lint-matrix";

function rules(text: string): string[] {
  return scanContextDoc(text).map((f) => f.rule);
}

// --- known-GOOD glossary corpus: every line must scan clean ------------------

const GOOD_LINES = [
  "**Lane**: A per-task worktree the autopilot derives from the DAG each cycle. Avoid: branch, checkout.",
  "**Cursor**: The last event id a reducer has folded; run keeper status to read it. Avoid: pointer, offset.",
  "**Dispatch**: Fire one worker by hand with the keeper:dispatch skill. Avoid: launch, spawn.",
  "**Planning**: Scaffold an epic by invoking /plan:plan on a request. Avoid: ticketing.",
  "**Worktree**: An isolated checkout; the autopilot may derive many worktree(s) per epic. Avoid: clone.",
  "**Fold**: How the reducer turns an event stream into a projection. It advances one cursor. Avoid: ingest.",
];

test("every known-good glossary line scans clean", () => {
  for (const line of GOOD_LINES) {
    expect(scanContextDoc(line)).toEqual([]);
  }
});

test("prose naming a CLI command and a slash-term does not trip a fingerprint", () => {
  const line =
    "**Board**: The plan state you orient on; read it with keeper status or /plan:work. Avoid: kanban.";
  expect(scanContextDoc(line)).toEqual([]);
});

// --- known-BAD corpus: each leak must produce the expected rule ---------------

test("a file path in prose FAILs with impl-path", () => {
  const line = "**Reducer**: uses src/foo.ts to fold events. Avoid: folder.";
  expect(rules(line)).toContain("impl-path");
});

test("a multi-arg call signature in prose FAILs with impl-signature", () => {
  const line =
    "**Verdict**: what computeReadiness(snap, board) returns each cycle. Avoid: status.";
  expect(rules(line)).toContain("impl-signature");
});

test("re-narration fingerprints each FAIL on CONTEXT.md prose", () => {
  for (const [line, rule] of [
    ["**Epic**: tracked under fn-1106 in the plan. Avoid: project.", "fn-id"],
    ["**Shed**: seeded in v74 of the schema. Avoid: bucket.", "version-number"],
    ["**Bug**: the 2026-06-23 wedge in dispatch. Avoid: defect.", "iso-date"],
    ["**Relay**: previously spawned the worker. Avoid: pipe.", "provenance"],
  ] as const) {
    expect(rules(line)).toContain(rule);
  }
});

test("a code fence past a single signature line FAILs with code-fence", () => {
  const text = [
    "**Snapshot**: The reducer input shape. Avoid: dump.",
    "",
    "```ts",
    "const a = 1;",
    "const b = 2;",
    "```",
    "",
  ].join("\n");
  expect(rules(text)).toContain("code-fence");
});

test("a single-line signature fence is allowed (no code-fence finding)", () => {
  const text = [
    "**Snapshot**: The reducer input shape. Avoid: dump.",
    "",
    "```ts",
    "computeReadiness(snapshot: Snapshot): Verdict",
    "```",
    "",
  ].join("\n");
  expect(rules(text)).not.toContain("code-fence");
});

// --- structural caps ----------------------------------------------------------

test("over the 140-line cap FAILs with context-size", () => {
  const text = Array.from({ length: 150 }, (_, i) => `- line ${i}`).join("\n");
  const size = scanContextDoc(text).filter((f) => f.rule === "context-size");
  expect(size.length).toBe(1);
  expect(size[0].message).toContain("exceeds the 140-line cap");
});

test("exactly at the 140-line cap passes (no context-size finding)", () => {
  const text = Array.from({ length: 140 }, (_, i) => `- line ${i}`).join("\n");
  expect(text.split("\n").length).toBe(140);
  expect(rules(text)).not.toContain("context-size");
});

test("a 3-sentence definition FAILs; a 2-sentence one passes", () => {
  const bad = "**Overloaded**: One thing. Two things. Three things. Avoid: x.";
  const good = "**Trim**: One thing. Two things. Avoid: x.";
  expect(rules(bad)).toContain("definition-sentences");
  expect(rules(good)).not.toContain("definition-sentences");
});

test("a term with no Avoid line, and an empty Avoid, both FAIL missing-avoid", () => {
  expect(rules("**NoAvoid**: A definition with no avoid line.")).toContain(
    "missing-avoid",
  );
  expect(rules("**EmptyAvoid**: A definition. Avoid:")).toContain(
    "missing-avoid",
  );
});

// --- escape hatch -------------------------------------------------------------

const ESCAPED = [
  "<!-- keeper-lint off -->",
  "**Legacy**: fn-1106 shipped this whole concept in one go",
  "<!-- keeper-lint on -->",
].join("\n");

const UNESCAPED = "**Legacy**: fn-1106 shipped this whole concept in one go";

test("the escape hatch suppresses a fingerprint but NEVER a structural cap", () => {
  // Unescaped: both the fn-id fingerprint AND the missing-avoid cap fire.
  const bare = rules(UNESCAPED);
  expect(bare).toContain("fn-id");
  expect(bare).toContain("missing-avoid");

  // Escaped: the fn-id fingerprint is gone, but missing-avoid still fires.
  const escaped = rules(ESCAPED);
  expect(escaped).not.toContain("fn-id");
  expect(escaped).toContain("missing-avoid");
});

// --- ADR checks ---------------------------------------------------------------

const GOOD_ADR = [
  "# 1. Use event sourcing",
  "",
  "Date: 2026-06-23",
  "",
  "## Status",
  "Accepted, previously superseded 0000-draft.",
  "",
  "## Context",
  "The daemon folds src/db.ts events into a projection via applyEvent(e, state).",
  "",
].join("\n");

test("an ADR accepts dates, history, and code — no fingerprints run there", () => {
  expect(scanAdrFile("docs/adr/0001-use-event-sourcing.md", GOOD_ADR)).toEqual(
    [],
  );
});

test("the same date/history/path content FAILs in a CONTEXT.md", () => {
  // The exact leaks an ADR tolerates must be rejected in the glossary.
  expect(rules("**X**: Date 2026-06-23 in src/db.ts. Avoid: y.")).toEqual(
    expect.arrayContaining(["iso-date", "impl-path"]),
  );
});

test("a malformed ADR filename FAILs with adr-naming", () => {
  const findings = scanAdrFile("docs/adr/use_event_sourcing.md", "# ok\n");
  expect(findings.map((f) => f.rule)).toContain("adr-naming");
});

test("an ADR index file is exempt from naming", () => {
  expect(scanAdrFile("docs/adr/README.md", "# ADRs\n")).toEqual([]);
});

test("an over-cap ADR FAILs with adr-size", () => {
  const text = Array.from({ length: 90 }, (_, i) => `line ${i}`).join("\n");
  const findings = scanAdrFile("docs/adr/0002-big.md", text);
  expect(findings.map((f) => f.rule)).toContain("adr-size");
});

test("duplicate ADR numbers across the staged set FAIL", () => {
  const dup = scanAdrSet(["docs/adr/0002-a.md", "docs/adr/0002-b.md"]);
  expect(dup.length).toBe(2);
  expect(dup.every((d) => d.finding.rule === "adr-duplicate-number")).toBe(
    true,
  );
  expect(scanAdrSet(["docs/adr/0002-a.md", "docs/adr/0003-b.md"])).toEqual([]);
});

// --- path classifiers ---------------------------------------------------------

test("path classifiers gate on the right files and never on CLAUDE/README", () => {
  expect(isContextDocPath("CONTEXT.md")).toBe(true);
  expect(isContextDocPath("CONTEXT-MAP.md")).toBe(true);
  expect(isContextDocPath("CLAUDE.md")).toBe(false);
  expect(isContextDocPath("README.md")).toBe(false);
  expect(isAdrPath("docs/adr/0001-x.md")).toBe(true);
  expect(isAdrPath("sub/docs/adr/0001-x.md")).toBe(true);
  expect(isAdrPath("docs/adr/0001-x.txt")).toBe(false);
  expect(isAdrPath("docs/architecture.md")).toBe(false);
});

// --- integration through runScopedLint with a sandboxed ledger ----------------

let repo: string;
let ledger: string;
let prevLedger: string | undefined;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "domain-docs-repo-"));
  const ledgerDir = mkdtempSync(join(tmpdir(), "domain-docs-ledger-"));
  ledger = join(ledgerDir, "pain.ndjson");
  prevLedger = process.env.KEEPER_DOMAIN_DOCS_LEDGER;
  process.env.KEEPER_DOMAIN_DOCS_LEDGER = ledger;
});

afterEach(() => {
  if (prevLedger === undefined) delete process.env.KEEPER_DOMAIN_DOCS_LEDGER;
  else process.env.KEEPER_DOMAIN_DOCS_LEDGER = prevLedger;
  rmSync(repo, { recursive: true, force: true });
});

test("resolveDomainDocsLedgerPath honors the env override", () => {
  expect(resolveDomainDocsLedgerPath()).toBe(ledger);
});

test("runScopedLint blocks a leaky CONTEXT.md and appends the pain ledger", async () => {
  writeFileSync(
    join(repo, "CONTEXT.md"),
    "**Reducer**: uses src/foo.ts to fold. Avoid: folder.\n",
  );

  let caught: unknown;
  try {
    await runScopedLint(["CONTEXT.md"], repo);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(LintFailure);
  const failure = caught as LintFailure;
  expect(failure.linter).toBe("domain-docs");
  expect(failure.files).toContain("CONTEXT.md");
  expect(failure.stderr).toContain("impl-path");

  // One NDJSON pain record per finding, under the sandboxed path.
  expect(existsSync(ledger)).toBe(true);
  const records = readFileSync(ledger, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(records.length).toBeGreaterThanOrEqual(1);
  const impl = records.find((r) => r.rule === "impl-path");
  expect(impl).toBeDefined();
  expect(impl?.file).toBe("CONTEXT.md");
  expect(impl?.repo).toBe(repo);
});

test("a clean docs/adr commit passes runScopedLint and writes no ledger", async () => {
  mkdirSync(join(repo, "docs", "adr"), { recursive: true });
  writeFileSync(join(repo, "docs", "adr", "0001-use-events.md"), GOOD_ADR);
  await expect(
    runScopedLint(["docs/adr/0001-use-events.md"], repo),
  ).resolves.toBeUndefined();
  expect(existsSync(ledger)).toBe(false);
});

test("an oversized domain doc fails closed before an unbounded read", async () => {
  const context = join(repo, "CONTEXT.md");
  writeFileSync(context, "x");
  truncateSync(context, 1_048_577);
  await expect(runScopedLint(["CONTEXT.md"], repo)).rejects.toMatchObject({
    linter: "domain-docs",
    stderr: expect.stringContaining("bounded domain-docs input size"),
  });
});

test("a repo with no CONTEXT.md or docs/adr staged is untouched by the arm", async () => {
  writeFileSync(join(repo, "notes.md"), "# just notes\nsrc/foo.ts mentioned\n");
  await expect(runScopedLint(["notes.md"], repo)).resolves.toBeUndefined();
  expect(existsSync(ledger)).toBe(false);
});
