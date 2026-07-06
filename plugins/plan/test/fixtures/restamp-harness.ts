// Spawn harness for the integrity-gate pipeline tests. Driven as a child process
// so the process.exit(1) failure path is observable from the bun:test parent.
// Each scenario seeds nothing — the parent pre-builds the `.keeper/` tree — and
// only exercises one pipeline path: apply a structural write (recorded to
// applied.txt so fail-forward is provable), then run runSetter with the
// scenario's hooks. Usage: bun run restamp-harness.ts <dataDir> <scenario>

import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runSetter } from "../../src/integrity_gate.ts";
import { atomicWriteJson, loadJsonSafe } from "../../src/store.ts";

const dataDir = process.argv[2] as string;
const scenario = process.argv[3] as string;
const projectDir = dirname(dataDir);

/** Record that the per-verb structural write ran (fail-forward evidence). */
function recordApplied(): void {
  writeFileSync(join(projectDir, "applied.txt"), scenario);
}

function epicPath(eid: string): string {
  return join(dataDir, "epics", `${eid}.json`);
}

if (scenario === "setter-clean") {
  // Clean tree: apply a structural write, then run the gate (marker untouched).
  runSetter("fn-1-clean", dataDir, {
    verb: "set-description",
    hooks: { apply: recordApplied },
  });
} else if (scenario === "armed-preserved") {
  // Armed epic (non-null marker seeded by the parent): a clean setter runs the
  // gate + bumps updated_at but must leave last_validated_at byte-identical.
  runSetter("fn-1-armed", dataDir, {
    verb: "set-description",
    hooks: { apply: recordApplied },
  });
} else if (scenario === "setter-fail-forward") {
  // Apply the structural write, then corrupt the tree (delete .2's spec) so the
  // post-write integrity gate fails — the write must stay on disk (fail-forward).
  runSetter("fn-1-ff", dataDir, {
    verb: "set-description",
    hooks: {
      apply: () => {
        recordApplied();
        rmSync(join(dataDir, "specs", "fn-1-ff.2.md"));
      },
    },
  });
} else if (scenario === "add-dep-cycle") {
  // Add fn-1 -> fn-2 (closes the fn-2 -> fn-1 -> fn-2 cycle). The rollback hook
  // restores fn-1's pre-write epic JSON when the post-write gate rejects it.
  const prior = loadJsonSafe(epicPath("fn-1-cyc"));
  runSetter("fn-1-cyc", dataDir, {
    verb: "add-dep",
    stampUpdatedAt: false,
    hooks: {
      apply: () => {
        const ep = loadJsonSafe(epicPath("fn-1-cyc")) ?? {};
        ep.depends_on_epics = ["fn-2-cyc"];
        atomicWriteJson(epicPath("fn-1-cyc"), ep, dataDir);
      },
      rollback: () => {
        if (prior !== null) {
          atomicWriteJson(epicPath("fn-1-cyc"), prior, dataDir);
        }
      },
    },
  });
} else if (scenario === "set-target-repo") {
  // Repoint .1 at repo_b, then recompute touched_repos (pre-gate hook) before the
  // integrity gate — the set-target-repo special case.
  const repoB = join(projectDir, "repo_b");
  runSetter("fn-1-str", dataDir, {
    verb: "set-target-repo",
    hooks: {
      apply: () => {
        const tPath = join(dataDir, "tasks", "fn-1-str.1.json");
        const t = loadJsonSafe(tPath) ?? {};
        t.target_repo = repoB;
        atomicWriteJson(tPath, t, dataDir);
      },
      preGate: () => {
        // Recompute touched_repos from every task's target_repo, sorted.
        const touched = new Set<string>();
        for (const tid of ["fn-1-str.1", "fn-1-str.2"]) {
          const t = loadJsonSafe(join(dataDir, "tasks", `${tid}.json`));
          const tr = t?.target_repo;
          if (typeof tr === "string") {
            touched.add(tr);
          }
        }
        const ep = loadJsonSafe(epicPath("fn-1-str")) ?? {};
        ep.touched_repos = [...touched].sort();
        atomicWriteJson(epicPath("fn-1-str"), ep, dataDir);
      },
    },
  });
} else {
  process.stderr.write(`unknown scenario: ${scenario}\n`);
  process.exit(2);
}

// Reaching here means the pipeline returned without exiting — success. Echo a
// terminal marker so the parent can distinguish a clean run from a silent exit.
process.stdout.write(`OK ${scenario}\n`);
