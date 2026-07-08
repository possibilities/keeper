// Unit tests for src/id_ledger.ts — the durable host-local id ledger that keeps
// a plan number burned after its epic's/task's working-tree files are destroyed,
// plus the ids.ts bare-number guard probe. Pure node:fs, zero git.
//
// The ledger lives under HOME (`~/.local/state/keeper/id-ledger/...`), so every
// test runs under a fresh throwaway HOME and a fresh state-repo tmpdir; both are
// removed afterwards and HOME is restored. Expected numbers are hand-computed
// constants, never re-derived by the code under test.

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendEpicRecord,
  appendTaskRecord,
  ledgerMaxEpicNum,
  ledgerMaxTaskNum,
  ledgerPath,
} from "../src/id_ledger.ts";
import { epicIdsWithNumber, scanMaxEpicId } from "../src/ids.ts";

const created: string[] = [];
let priorHome: string | undefined;

afterEach(() => {
  if (priorHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = priorHome;
  }
  priorHome = undefined;
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
  created.length = 0;
});

function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** A fresh throwaway HOME (so the ledger writes under it) plus a fresh state
 * repo path to key the ledger on. Returns the state repo. */
function freshWorld(): string {
  priorHome = process.env.HOME;
  process.env.HOME = freshDir("idledger-home-");
  return freshDir("idledger-state-");
}

describe("id_ledger — allocation durability", () => {
  test("fresh project: no ledger reads 0, first append creates the file", () => {
    const stateRepo = freshWorld();
    expect(ledgerMaxEpicNum(stateRepo)).toBe(0);

    appendEpicRecord(stateRepo, 1, "fn-1-alpha");
    expect(readFileSync(ledgerPath(stateRepo), "utf-8")).toContain(
      "fn-1-alpha",
    );
    expect(ledgerMaxEpicNum(stateRepo)).toBe(1);
  });

  test("incident regression: files destroyed, ledger burns the number", () => {
    const stateRepo = freshWorld();
    // A `.keeper/` data dir whose epic files were destroyed (empty scan), while
    // the ledger still records that fn-6 was handed out.
    const dataDir = join(stateRepo, ".keeper");
    mkdirSync(join(dataDir, "epics"), { recursive: true });
    appendEpicRecord(stateRepo, 6, "fn-6-alpha");

    expect(scanMaxEpicId(dataDir)).toBe(0);
    expect(ledgerMaxEpicNum(stateRepo)).toBe(6);
    // The mint sites' formula: max(scan, ledger)+1 — the destroyed number 6 is
    // NOT reused; allocation jumps to 7.
    const next =
      Math.max(scanMaxEpicId(dataDir), ledgerMaxEpicNum(stateRepo)) + 1;
    expect(next).toBe(7);
  });

  test("max picks the higher of scan and ledger, either way", () => {
    const stateRepo = freshWorld();
    const dataDir = join(stateRepo, ".keeper");
    mkdirSync(join(dataDir, "epics"), { recursive: true });

    // Scan ahead of ledger: fn-8 on disk, ledger only knows 6 -> next 9.
    writeFileSync(join(dataDir, "epics", "fn-8-live.json"), "{}");
    appendEpicRecord(stateRepo, 6, "fn-6-gone");
    expect(scanMaxEpicId(dataDir)).toBe(8);
    expect(
      Math.max(scanMaxEpicId(dataDir), ledgerMaxEpicNum(stateRepo)) + 1,
    ).toBe(9);
  });

  test("epic max folds in a surviving task record's epic_num", () => {
    const stateRepo = freshWorld();
    appendTaskRecord(stateRepo, 9, "fn-9-x", 1, "fn-9-x.1");
    expect(ledgerMaxEpicNum(stateRepo)).toBe(9);
  });
});

describe("id_ledger — task numbers are per-epic scoped", () => {
  test("each epic's task numbers are independent", () => {
    const stateRepo = freshWorld();
    appendTaskRecord(stateRepo, 3, "fn-3-a", 1, "fn-3-a.1");
    appendTaskRecord(stateRepo, 3, "fn-3-a", 2, "fn-3-a.2");
    appendTaskRecord(stateRepo, 4, "fn-4-b", 1, "fn-4-b.1");

    expect(ledgerMaxTaskNum(stateRepo, "fn-3-a")).toBe(2);
    expect(ledgerMaxTaskNum(stateRepo, "fn-4-b")).toBe(1);
    expect(ledgerMaxTaskNum(stateRepo, "fn-5-none")).toBe(0);
  });
});

describe("id_ledger — fail-soft under corruption / IO failure", () => {
  test("a corrupt trailing line degrades to the last valid record", () => {
    const stateRepo = freshWorld();
    appendEpicRecord(stateRepo, 2, "fn-2-good");
    // Simulate a crash-truncated tail: append a partial (unparseable) line.
    appendFileSync(
      ledgerPath(stateRepo),
      '{"kind":"epic","epic_num":3,"id":"fn-',
    );
    expect(ledgerMaxEpicNum(stateRepo)).toBe(2);
  });

  test("an unwritable ledger location never breaks the mint", () => {
    priorHome = process.env.HOME;
    // Point HOME at a regular FILE so mkdir of the ledger dir fails (ENOTDIR),
    // and reading the (nonexistent) ledger throws — both must degrade to 0.
    const fileHome = join(freshDir("idledger-file-"), "not-a-dir");
    writeFileSync(fileHome, "x");
    process.env.HOME = fileHome;
    const stateRepo = freshDir("idledger-state-");

    expect(() => appendEpicRecord(stateRepo, 1, "fn-1-a")).not.toThrow();
    expect(ledgerMaxEpicNum(stateRepo)).toBe(0);
    expect(ledgerMaxTaskNum(stateRepo, "fn-1-a")).toBe(0);
  });
});

describe("id_ledger — newline-injection safety", () => {
  test("a newline in a minter-influenced id cannot inject a second record", () => {
    const stateRepo = freshWorld();
    const nastyId = 'fn-1-a\n{"kind":"epic","epic_num":999,"id":"x"}';
    appendEpicRecord(stateRepo, 1, nastyId);

    // Exactly one physical record line (JSON.stringify escaped the newline).
    const raw = readFileSync(ledgerPath(stateRepo), "utf-8");
    expect(raw.split("\n").filter((l) => l !== "")).toHaveLength(1);
    // The injected epic_num:999 is inside the escaped string, not a live record.
    expect(ledgerMaxEpicNum(stateRepo)).toBe(1);
  });
});

describe("bare-number guard — epicIdsWithNumber probe", () => {
  test("finds a same-number sibling across epics/ and specs/", () => {
    const dataDir = join(freshDir("idledger-guard-"), ".keeper");
    mkdirSync(join(dataDir, "epics"), { recursive: true });
    mkdirSync(join(dataDir, "specs"), { recursive: true });
    writeFileSync(join(dataDir, "epics", "fn-6-alpha.json"), "{}");
    writeFileSync(join(dataDir, "specs", "fn-6-alpha.md"), "");
    writeFileSync(join(dataDir, "epics", "fn-7-other.json"), "{}");

    // Deduped across epics/ + specs/, scoped to number 6.
    expect(epicIdsWithNumber(dataDir, 6)).toEqual(["fn-6-alpha"]);

    // A candidate fn-6-beta collides with the fn-6-alpha sibling.
    const siblings = epicIdsWithNumber(dataDir, 6).filter(
      (id) => id !== "fn-6-beta",
    );
    expect(siblings).toEqual(["fn-6-alpha"]);
  });

  test("no match returns empty (the normal locked-flock case)", () => {
    const dataDir = join(freshDir("idledger-guard-"), ".keeper");
    mkdirSync(join(dataDir, "epics"), { recursive: true });
    writeFileSync(join(dataDir, "epics", "fn-6-alpha.json"), "{}");
    // Candidate number 7 is higher than every scanned file — no sibling.
    expect(epicIdsWithNumber(dataDir, 7)).toEqual([]);
  });
});
