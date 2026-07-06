// epic add-deps — the port of run_epic_add_deps.py. Batch-wires N epic-dep edges
// in one call with assert-all -> mutate -> emit ordering. The classifier collects
// every per-edge error in one pass and surfaces the dominant class in stable
// priority order (bad_id -> dep_ambiguous_id -> epic_not_found -> dep_done ->
// dep_cycle); --skip-invalid diverts per-edge classifier errors into SKIPPED_*
// result statuses instead of failing. Idempotent: an already-wired edge is
// ALREADY_PRESENT (a no-op, not an error). Writes once iff at least one new edge
// lands; a pure all-no-op call writes nothing. After a write the shared
// post-write integrity gate re-validates the tree (it never touches the marker).
// The target-epic-not-found case fails loud even under --skip-invalid (no place
// to wire any edge).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { type DepGraph, detectCycles } from "../deps.ts";
import {
  discoverProjects,
  type ResolveResult,
  resolveEpicGlobally,
} from "../discovery.ts";
import { emitMutating } from "../emit.ts";
import { compactJson, type OutputFormat } from "../format.ts";
import { isEpicId } from "../ids.ts";
import { integrityGateOrFail } from "../integrity_gate.ts";
import { resolveProject } from "../project.ts";
import { resolveDataDir } from "../state_path.ts";
import { atomicWriteJson, loadJson, nowIso } from "../store.ts";

interface AddDepsArgs {
  epicId: string;
  depIds: string[];
  skipInvalid: boolean;
  format: OutputFormat | null;
}

/** Emit a structured failure envelope (compact, single line) and exit 1, writing
 * nothing. Mirrors _emit_failure — accumulates ALL per-edge errors into one
 * envelope rather than hard-failing on the first. */
function emitFailure(code: string, message: string, details: string[]): never {
  const envelope = { success: false, error: { code, message, details } };
  process.stdout.write(`${compactJson(envelope)}\n`);
  process.exit(1);
}

export function runEpicAddDeps(args: AddDepsArgs): void {
  const { epicId, depIds, skipInvalid, format } = args;
  void format;

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;
  const epicsDir = join(dataDir, "epics");
  const epicPath = join(epicsDir, `${epicId}.json`);

  // Assert-all: id shape, existence (cwd-then-global), self-ref, ambiguous,
  // done-target — collect every per-edge error before any mutation.
  const badIdErrors: string[] = [];
  const ambiguousErrors: string[] = [];
  const notFoundErrors: string[] = [];
  const doneErrors: string[] = [];
  const skippedById: Record<string, string> = {};
  const normalizedById: Record<string, string> = {};

  if (!existsSync(epicPath)) {
    notFoundErrors.push(`epic not found: ${epicId}`);
  }

  const seen = new Set<string>();
  for (const depId of depIds) {
    if (seen.has(depId)) {
      continue;
    }
    seen.add(depId);
    if (!isEpicId(depId)) {
      if (skipInvalid) {
        skippedById[depId] = "SKIPPED_BAD_ID";
        continue;
      }
      badIdErrors.push(`dep id '${depId}' is not a valid epic id`);
      continue;
    }
    if (depId === epicId) {
      if (skipInvalid) {
        skippedById[depId] = "SKIPPED_BAD_ID";
        continue;
      }
      badIdErrors.push(`epic cannot depend on itself: ${depId}`);
      continue;
    }
    const depResolution: ResolveResult = resolveEpicGlobally(depId);
    if (depResolution.ambiguous) {
      if (skipInvalid) {
        skippedById[depId] = "SKIPPED_AMBIGUOUS";
        continue;
      }
      const owners = depResolution.owners.join(", ");
      ambiguousErrors.push(
        `dep epic ${depId} exists in multiple projects: ${owners}`,
      );
      continue;
    }
    if (!depResolution.resolved) {
      if (skipInvalid) {
        skippedById[depId] = "SKIPPED_NOT_FOUND";
        continue;
      }
      notFoundErrors.push(`dep epic not found: ${depId}`);
      continue;
    }
    const resolvedId = depResolution.resolvedId as string;
    normalizedById[depId] = resolvedId;
    const depDef = loadJson(depResolution.epicPath as string);
    if (depDef.status === "done") {
      if (skipInvalid) {
        skippedById[depId] = "SKIPPED_DONE";
        continue;
      }
      doneErrors.push(`dep epic is done (cannot depend on it): ${depId}`);
    }
  }

  // Stable priority order so a single envelope surfaces the dominant class;
  // other-class errors still appear in details.
  if (badIdErrors.length > 0) {
    emitFailure(
      "bad_id",
      "One or more dep ids are malformed or self-referential",
      [...badIdErrors, ...ambiguousErrors, ...notFoundErrors, ...doneErrors],
    );
  }
  if (ambiguousErrors.length > 0) {
    emitFailure(
      "dep_ambiguous_id",
      "One or more dep ids resolve to multiple projects",
      [...ambiguousErrors, ...notFoundErrors, ...doneErrors],
    );
  }
  if (notFoundErrors.length > 0) {
    emitFailure("epic_not_found", "One or more epics do not exist", [
      ...notFoundErrors,
      ...doneErrors,
    ]);
  }
  if (doneErrors.length > 0) {
    emitFailure("dep_done", "One or more dep epics are done", doneErrors);
  }

  // Compute the post-wire dep list (idempotent: dup -> ALREADY_PRESENT, no-op).
  const epicDef = loadJson(epicPath);
  const deps = [...((epicDef.depends_on_epics as string[] | undefined) ?? [])];

  const results: { dep_id: string; status: string }[] = [];
  let newEdges = 0;
  const resultsSeen = new Set<string>();
  for (const depId of depIds) {
    if (resultsSeen.has(depId)) {
      continue;
    }
    resultsSeen.add(depId);
    if (depId in skippedById) {
      results.push({ dep_id: depId, status: skippedById[depId] as string });
      continue;
    }
    const fullId = normalizedById[depId] ?? depId;
    if (deps.includes(fullId)) {
      results.push({ dep_id: fullId, status: "ALREADY_PRESENT" });
      continue;
    }
    deps.push(fullId);
    newEdges += 1;
    results.push({ dep_id: fullId, status: "WIRED" });
  }

  // Cycle detection on the post-wire epic-dep graph, across every discovered
  // project + a local backstop. Sort node ids + adjacency lists at construction
  // so the surfaced cycle is deterministic across engines.
  if (newEdges > 0) {
    const graph: DepGraph = {};
    let discovered: string[];
    try {
      discovered = discoverProjects();
    } catch {
      discovered = [];
    }
    for (const project of discovered) {
      const projectDataDir = resolveDataDir(project);
      if (projectDataDir === null) {
        continue;
      }
      const projectEpics = join(projectDataDir, "epics");
      if (!existsSync(projectEpics)) {
        continue;
      }
      for (const entry of readdirSync(projectEpics).sort()) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        const ep = loadJson(join(projectEpics, entry));
        graph[ep.id as string] = {
          depends_on: [
            ...((ep.depends_on_epics as string[] | undefined) ?? []),
          ],
        };
      }
    }
    // Local backstop: cwd may not be under a configured root.
    for (const entry of readdirSync(epicsDir).sort()) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const ep = loadJson(join(epicsDir, entry));
      const id = ep.id as string;
      if (!(id in graph)) {
        graph[id] = {
          depends_on: [
            ...((ep.depends_on_epics as string[] | undefined) ?? []),
          ],
        };
      }
    }
    graph[epicId] = { depends_on: deps };
    const cycle = detectCycles(graph);
    if (cycle !== null) {
      emitFailure(
        "dep_cycle",
        "Wiring these edges would introduce a cycle in the epic-dep graph",
        [`cycle: ${cycle.join(" -> ")}`],
      );
    }
  }

  // Mutate: write once iff at least one new edge landed.
  if (newEdges > 0) {
    epicDef.depends_on_epics = deps;
    epicDef.updated_at = nowIso();
    atomicWriteJson(epicPath, epicDef, dataDir);

    integrityGateOrFail(epicId, dataDir, { verb: "add-deps" });
  }

  emitMutating(
    { epic_id: epicId, depends_on_epics: deps, results },
    { verb: "add-deps", target: epicId, repoRoot: ctx.projectPath },
  );
}
