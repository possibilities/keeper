// ID parsing — the port of planctl/ids.py:parse_id. epics relies on the
// unparseable-sorts-as-999 behavior: an id that fails the regex yields
// [null, null], which the sort comparator maps to 999 so it sorts LAST.

import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Mirrors ID_REGEX: fn-<num>[-slug][.<task>]. The slug arm matches either a
// >=2-char [a-z0-9]-bounded run or a 1-3 char short token.
const ID_REGEX =
  /^fn-(\d+)(?:-[a-z0-9][a-z0-9-]*[a-z0-9]|-[a-z0-9]{1,3})?(?:\.(\d+))?$/;

/** Parse an id into [epicNum, taskNum]. [epic, null] for an epic id,
 * [epic, task] for a task id, [null, null] when unparseable. */
export function parseId(idStr: string): [number | null, number | null] {
  const match = ID_REGEX.exec(idStr);
  if (!match) {
    return [null, null];
  }
  const epic = Number.parseInt(match[1] as string, 10);
  const task = match[2] !== undefined ? Number.parseInt(match[2], 10) : null;
  return [epic, task];
}

/** True iff `s` is a task id (epic-num AND task-num both parse). Mirrors
 * ids.is_task_id. */
export function isTaskId(s: string): boolean {
  const [epic, task] = parseId(s);
  return epic !== null && task !== null;
}

/** True iff `s` is an epic id (epic-num parses, task-num absent). Mirrors
 * ids.is_epic_id. */
export function isEpicId(s: string): boolean {
  const [epic, task] = parseId(s);
  return epic !== null && task === null;
}

/** Extract the epic id from a task id by stripping the final `.<task>` segment.
 * Throws on a non-task id. Mirrors ids.epic_id_from_task. */
export function epicIdFromTask(taskId: string): string {
  const [epic, task] = parseId(taskId);
  if (epic === null || task === null) {
    throw new Error(`Invalid task ID: ${taskId}`);
  }
  const dot = taskId.lastIndexOf(".");
  return taskId.slice(0, dot);
}

// ---------------------------------------------------------------------------
// Slug + suffix generation, scan-based id allocation — the port of the
// allocation helpers in planctl/ids.py used by epic create / scaffold.
// ---------------------------------------------------------------------------

// Filename pattern for an epic JSON / spec: fn-<num>[-slug].(json|md). The slug
// arm mirrors ID_REGEX's. Used by scanMaxEpicId across BOTH epics/ and specs/.
const EPIC_FILE_NUM_REGEX =
  /^fn-(\d+)(?:-[a-z0-9][a-z0-9-]*[a-z0-9]|-[a-z0-9]{1,3})?\.(?:json|md)$/;

const SUFFIX_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Convert free text to a URL-safe slug for an epic id, or null when the result
 * is empty (the caller falls back to a random suffix). Mirrors ids.slugify:
 * NFKD-normalize + drop non-ASCII (so ``café`` -> ``cafe``), lowercase, strip
 * everything but ``[A-Za-z0-9_ -]``, turn ``_`` into a space, collapse runs of
 * ``-``/whitespace into a single ``-``, trim leading/trailing ``-``, then
 * word-boundary truncate to ``maxLength`` (40). */
export function slugify(text: string, maxLength = 40): string | null {
  // NFKD then strip the combining marks / non-ASCII the Python ascii-ignore
  // encode drops.
  let s = String(text)
    .normalize("NFKD")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: keep ASCII only.
    .replace(/[^\x00-\x7F]/g, "");
  s = s.toLowerCase();
  // Drop everything that is not a word char (A-Za-z0-9_), whitespace, or hyphen.
  s = s.replace(/[^\w\s-]/g, "");
  s = s.replace(/_/g, " ");
  s = s.replace(/[-\s]+/g, "-").replace(/^-+|-+$/g, "");
  if (maxLength && s.length > maxLength) {
    let truncated = s.slice(0, maxLength);
    if (truncated.includes("-")) {
      truncated = truncated.slice(0, truncated.lastIndexOf("-"));
    }
    s = truncated.replace(/^-+|-+$/g, "");
  }
  return s === "" ? null : s;
}

/** Random ``[a-z0-9]`` string of ``length`` (default 3), the slug-fallback
 * suffix. Mirrors ids.generate_suffix (secrets.choice) — uses
 * crypto.randomBytes with rejection-free modulo over a 36-char alphabet. */
export function generateSuffix(length = 3): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += SUFFIX_CHARS[(bytes[i] as number) % SUFFIX_CHARS.length];
  }
  return out;
}

/** Highest epic number across BOTH ``epics/*.json`` AND ``specs/fn-*.md`` under
 * ``dataDir`` — the orphan-spec invariant: a mid-scaffold crash can leave a spec
 * with no JSON, so allocation must scan specs too or risk reusing a number.
 * Mirrors ids.scan_max_epic_id; 0 when neither dir holds a match. */
export function scanMaxEpicId(dataDir: string): number {
  let maxN = 0;
  for (const sub of ["epics", "specs"]) {
    let entries: string[];
    try {
      entries = readdirSync(join(dataDir, sub));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("fn-")) {
        continue;
      }
      const match = EPIC_FILE_NUM_REGEX.exec(entry);
      if (match) {
        maxN = Math.max(maxN, Number.parseInt(match[1] as string, 10));
      }
    }
  }
  return maxN;
}

/** Full epic ids across BOTH ``epics/*.json`` AND ``specs/fn-*.md`` under
 * ``dataDir`` whose bare number equals ``num`` — the mint-time same-project
 * bare-number guard's probe. Deduped, sorted. Under a locked flock this is empty
 * for a fresh candidate (candidate > scan max); it fires only when a concurrent
 * unlocked-degrade mint already wrote a sibling carrying the number. */
export function epicIdsWithNumber(dataDir: string, num: number): string[] {
  const ids = new Set<string>();
  for (const sub of ["epics", "specs"]) {
    let entries: string[];
    try {
      entries = readdirSync(join(dataDir, sub));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("fn-")) {
        continue;
      }
      const match = EPIC_FILE_NUM_REGEX.exec(entry);
      if (match && Number.parseInt(match[1] as string, 10) === num) {
        ids.add(entry.slice(0, entry.lastIndexOf(".")));
      }
    }
  }
  return [...ids].sort();
}

/** Highest task number for ``epicId`` across ``tasks/<epicId>.<m>.json`` under
 * ``dataDir``. Mirrors ids.scan_max_task_id; 0 when the dir or epic has none. */
export function scanMaxTaskId(dataDir: string, epicId: string): number {
  let entries: string[];
  try {
    entries = readdirSync(join(dataDir, "tasks"));
  } catch {
    return 0;
  }
  const prefix = `${epicId}.`;
  const taskRegex = new RegExp(`^${escapeRegex(epicId)}\\.(\\d+)\\.json$`);
  let maxM = 0;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const match = taskRegex.exec(entry);
    if (match) {
      maxM = Math.max(maxM, Number.parseInt(match[1] as string, 10));
    }
  }
  return maxM;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
