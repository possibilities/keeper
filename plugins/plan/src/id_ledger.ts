// Durable host-local id ledger — an append-only JSONL record of every plan
// number a project has handed out, consulted at mint alongside the directory
// scan so destroying a minted epic's or task's working-tree files can never
// free its number for re-allocation on the same host.
//
// node stdlib ONLY (no git, no bun:sqlite, no store/emit facade). One file per
// project under `~/.local/state/keeper/id-ledger/<sha256(realpath)>.jsonl`, keyed
// on the STATE repo realpath (the audit_artifacts sha256+realpath idiom) so a
// lane-worktree mint and the shared-checkout mint address the SAME ledger rather
// than forking a second one. Each record is one bounded single-write() JSON
// line: JSON.stringify escapes any newline a minter-influenced slug carries, so a
// record can never inject a second one, and the trailing `\n` is the sole
// separator.
//
// EAFP — the ledger is a durability BACKSTOP, never the authority. The directory
// scan stays the source of truth: allocation is max(scan, ledger)+1, so every
// ledger IO failure (missing dir, unwritable file, corrupt tail) fails soft to
// scan-only and a mint never breaks. Reads tolerate a crash-truncated trailing
// line by skipping any record that does not parse. No per-mint fsync — the scan
// is the durability net a lost append falls back to.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

interface LedgerRecord {
  kind: "epic" | "task";
  epic_num: number;
  epic_of?: string;
  task_num?: number;
  id: string;
  ts: string;
}

/** `~/.local/state/keeper/id-ledger/<sha256(realpath(stateRepo))>.jsonl`,
 * honoring a mutated $HOME (tests). Keyed on the STATE repo realpath so a lane
 * worktree keys the same file as the shared checkout. */
export function ledgerPath(stateRepo: string): string {
  const home = process.env.HOME || homedir();
  const key = createHash("sha256")
    .update(realpathOrAbs(stateRepo))
    .digest("hex");
  return join(home, ".local", "state", "keeper", "id-ledger", `${key}.jsonl`);
}

/** Highest epic number the ledger has recorded for `stateRepo` — 0 when the
 * ledger is absent, empty, or unreadable (fail-soft to scan-only). Folds in
 * task records' `epic_num` too, so a surviving task record keeps its epic number
 * burned even if the epic record was lost. */
export function ledgerMaxEpicNum(stateRepo: string): number {
  let max = 0;
  for (const rec of readRecords(stateRepo)) {
    if (rec.epic_num > max) {
      max = rec.epic_num;
    }
  }
  return max;
}

/** Highest task number the ledger has recorded for `epicId` under `stateRepo`
 * (per-epic scope) — 0 when none. Fail-soft to scan-only on any read error. */
export function ledgerMaxTaskNum(stateRepo: string, epicId: string): number {
  let max = 0;
  for (const rec of readRecords(stateRepo)) {
    if (
      rec.kind === "task" &&
      rec.epic_of === epicId &&
      typeof rec.task_num === "number" &&
      rec.task_num > max
    ) {
      max = rec.task_num;
    }
  }
  return max;
}

/** Record a freshly-minted epic number. Best-effort: any IO failure is swallowed
 * so a ledger write never breaks the mint (the scan is the durability backstop).
 * Call inside the epic-id flock, before the epic files are written, so the number
 * is burned the instant it is claimed. */
export function appendEpicRecord(
  stateRepo: string,
  epicNum: number,
  id: string,
): void {
  appendRecord(stateRepo, {
    kind: "epic",
    epic_num: epicNum,
    id,
    ts: nowStamp(),
  });
}

/** Record a freshly-minted task number under its epic. Best-effort, same
 * fail-soft contract as appendEpicRecord; call inside the flock before the task
 * files are written. */
export function appendTaskRecord(
  stateRepo: string,
  epicNum: number,
  epicOf: string,
  taskNum: number,
  id: string,
): void {
  appendRecord(stateRepo, {
    kind: "task",
    epic_num: epicNum,
    epic_of: epicOf,
    task_num: taskNum,
    id,
    ts: nowStamp(),
  });
}

function appendRecord(stateRepo: string, rec: LedgerRecord): void {
  try {
    const path = ledgerPath(stateRepo);
    mkdirSync(dirname(path), { recursive: true });
    // JSON.stringify escapes any newline in a minter-influenced slug, so the
    // serialized line can never inject a second record; the trailing `\n` is
    // the sole separator. One appendFileSync == one O_APPEND write(), no fsync.
    appendFileSync(path, `${JSON.stringify(rec)}\n`);
  } catch {
    // Fail-soft: a lost append degrades allocation to scan-only.
  }
}

/** Parse the ledger's records, skipping any line that fails to parse or match
 * the record shape (tolerates a crash-truncated trailing line). Missing file or
 * any read error → []. */
function readRecords(stateRepo: string): LedgerRecord[] {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(stateRepo), "utf-8");
  } catch {
    return [];
  }
  const out: LedgerRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isLedgerRecord(parsed)) {
      out.push(parsed);
    }
  }
  return out;
}

function isLedgerRecord(value: unknown): value is LedgerRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    (r.kind === "epic" || r.kind === "task") &&
    typeof r.epic_num === "number" &&
    typeof r.id === "string"
  );
}

/** `str(Path(p).resolve())` — realpath when it exists (matching how the mint
 * sites already resolve the state repo), else the plain absolute form so a key
 * is always derivable and never throws. */
function realpathOrAbs(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function nowStamp(): string {
  return process.env.KEEPER_PLAN_NOW || new Date().toISOString();
}
