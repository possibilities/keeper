/**
 * Polyglot lint matrix for `keeper commit-work` — the TypeScript port of
 * jobctl's `_run_scoped_lint` (apps/jobctl/jobctl/run_commit_work.py:206),
 * PLUS a new dedicated `tsc --noEmit --project <tsconfig>` arm for the keeper
 * codebase's own `.ts`/`.tsx` sources.
 *
 * `keeper commit-work` is the single mechanical lint gate for ALL agent-edited
 * code. Every checker runs independently against a suffix-filtered subset of
 * the staged files — there are no early returns between them, so one failure
 * never masks another. Exit code is the SOLE pass/fail signal; stderr (falling
 * back to stdout, then a synthetic marker) is captured verbatim.
 *
 * **Per-extension dispatch** (scoped to staged files of that type):
 *
 * | Suffix / basename | Tools |
 * |---|---|
 * | `.py` | repo-declared `uv run ruff check` + `uv run ruff format --check` |
 * | `.ts`/`.tsx` | `tsc --noEmit --project <tsconfig>` (NEW arm) |
 * | `.sh` | `shellcheck` |
 * | `.zig` | `ziglint` + `zlint` |
 * | `Dockerfile*` / `Containerfile*` | `hadolint` |
 * | `.{js,jsx,ts,tsx,mjs,cjs}` | `npm run lint` per nearest package.json |
 *
 * **Python project checks** (only when any `.py` is staged):
 *  - Ruff check + format for repositories that explicitly configure or depend
 *    on Ruff; an undeclared ambient executable never imposes formatter churn.
 *  - `uvx ty check` only for repositories that explicitly configure or depend
 *    on ty; an undeclared ambient type checker never imposes a foreign policy.
 *  - `./scripts/lint-cli-boundaries.py` — fast regardless of repo size.
 *
 * **Staged-path-conditional drift gates** (fire on a staged-PATH match, independent
 * of file type; each is self-contained and sub-second):
 *  - the vendored prompt corpus or a hack/panel skill body staged →
 *    `bun scripts/vendor-corpus.ts --check`
 *  - the plan model-selector config, its research-cache references, the
 *    cross-provider equivalence map, or its parser staged →
 *    `bun plugins/plan/scripts/model-guidance-check.ts --check`
 *  - the plan package's `src/` tree staged → the root
 *    `test/reconcile-core-depgraph.test.ts` import-boundary ratchet (never the
 *    whole root suite — kept sub-second on purpose)
 * `KEEPER_COMMIT_WORK_SKIP_DRIFT_GATES` (any truthy value) skips just these
 * three, logging a loud stderr warning; every other linter arm still runs, and
 * the skip is opt-in only — never the default path.
 *
 * **Failure aggregation:** every checker runs to completion; a single failure
 * surfaces as `linter=<name>`, multiple as `linter="multiple"` with labelled
 * `--- <linter> ---` stderr blocks and a union of implicated files.
 *
 * Concurrency: where the Python ran the checkers sequentially, this port fires
 * them all with `Promise.all` (each is an independent external subprocess with
 * no shared mutable state) and then aggregates in a STABLE dispatch order so
 * the `linter="multiple"` envelope is byte-deterministic regardless of which
 * subprocess finished first.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
  isAdrPath,
  isContextDocPath,
  runDomainDocsLint,
} from "./domain-docs-lint";
import { type GitExecResult, spawnBoundedExec } from "./git-exec";

/** JS/TS suffixes routed to the npm-lint arm (mirrors Python `_JS_TS_SUFFIXES`). */
const JS_TS_SUFFIXES = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

/** TS suffixes routed to the dedicated `tsc --project` arm (NEW vs Python). */
const TS_SUFFIXES = new Set([".ts", ".tsx"]);
const LINT_TIMEOUT_MS = 120_000;
const LINT_OUTPUT_LIMIT_BYTES = 4 * 1_048_576;
const MAX_NPM_LINT_PACKAGE_GROUPS = 64;

/**
 * Thrown when the scoped lint matrix detects errors. The caller catches it,
 * releases the flock, and emits `{success:false, error:"lint_failed", linter,
 * files, stderr, recovery}` — `recovery` steers the agent to
 * fix→re-invoke with the same adoption decision, never around the gate.
 */
export class LintFailure extends Error {
  /** Concatenated stderr (labelled blocks when more than one checker failed). */
  readonly stderr: string;
  /** Single checker name, or `"multiple"`. */
  readonly linter: string;
  /** Union of staged files implicated across the failed checkers. */
  readonly files: string[];

  constructor(stderr: string, linter: string, files: string[] = []) {
    super(stderr);
    this.name = "LintFailure";
    this.stderr = stderr;
    this.linter = linter;
    this.files = [...files];
  }
}

/** A single checker's recorded failure: `(linter, files, stderr)`. */
interface RecordedFailure {
  linter: string;
  files: string[];
  stderr: string;
}

/** True when `path`'s basename matches Dockerfile/Containerfile rules. */
function isDockerfile(path: string): boolean {
  const name = basename(path);
  return (
    name === "Dockerfile" ||
    name === "Containerfile" ||
    name.startsWith("Dockerfile.") ||
    name.startsWith("Containerfile.")
  );
}

/** True when `path` sits in the vendored prompt corpus or is a hack/panel skill
 * body carrying BAKE guards — the vendor-corpus drift check's trigger set.
 * Exported for direct trigger-set testing (the check itself spawns a
 * subprocess, which the fast suite never boots). */
export function isVendorCorpusPath(path: string): boolean {
  return (
    path.startsWith("plugins/prompt/corpus/") ||
    path === "plugins/plan/skills/hack/SKILL.md" ||
    path === "plugins/plan/skills/panel/SKILL.md"
  );
}

/** True when `path` is the plan model-selector config, its research-cache
 * references tree, the cross-provider equivalence map, or its strict parser —
 * the model-guidance drift check's trigger set (the same script gates both
 * the selector config and the equivalence map). */
export function isModelGuidancePath(path: string): boolean {
  return (
    path === "plugins/plan/model-selector.yaml" ||
    path.startsWith("plugins/plan/skills/model-guidance/references/") ||
    path === "plugins/plan/provider-equivalence.yaml" ||
    path === "plugins/plan/src/provider_equivalence.ts"
  );
}

/** True when `path` sits under the plan package's `src/` tree — the
 * import-boundary ratchet's trigger set. */
export function isPlanBoundaryPath(path: string): boolean {
  return path.startsWith("plugins/plan/src/");
}

/** Lowercased file extension, or `""` (mirrors Python `Path(f).suffix.lower()`). */
function suffixLower(path: string): string {
  return extname(path).toLowerCase();
}

/**
 * Build the verbatim stderr blob for a failed checker, mirroring the Python's
 * `result.stderr + result.stdout` concatenation and the empty-output fallback.
 */
function failureStderr(linter: string, result: GitExecResult): string {
  const combined = (result.stderr || "") + (result.stdout || "");
  if (combined) return combined;
  return `<${linter} exited ${result.code} with no output>`;
}

/**
 * Walk up from `fileRel`'s directory to the nearest `package.json` carrying a
 * `lint` script, without escaping `cwd`. Returns that directory, or `null`.
 * Mirrors Python `_find_nearest_pkg_with_lint`.
 */
function findNearestPkgWithLint(fileRel: string, cwd: string): string | null {
  let candidate = resolve(cwd, dirname(fileRel));
  const cwdResolved = resolve(cwd);
  while (true) {
    const pkgPath = join(candidate, "package.json");
    if (existsSync(pkgPath)) {
      const scripts = readPkgScripts(pkgPath);
      if (scripts && "lint" in scripts) {
        return candidate;
      }
    }
    if (candidate === cwdResolved) break;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return null;
}

/** Read a package.json's `scripts` map synchronously, or `null` on any error. */
function readPkgScripts(pkgPath: string): Record<string, unknown> | null {
  try {
    const text = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
    return parsed.scripts ?? {};
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirementNamesPackage(value: string, packageName: string): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^${escaped}(?:\\[[^\\]]*\\])?(?=$|\\s|[<>=!~@;(])`,
    "iu",
  ).test(value.trim());
}

function requirementListNamesPackage(
  value: unknown,
  packageName: string,
): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (entry) =>
        typeof entry === "string" &&
        requirementNamesPackage(entry, packageName),
    )
  );
}

function dependencyMapNamesPackage(
  value: unknown,
  packageName: string,
): boolean {
  if (!isRecord(value)) return false;
  return Object.keys(value).some(
    (name) => name.split("[", 1)[0]?.toLowerCase() === packageName,
  );
}

function groupedRequirementListsNamePackage(
  value: unknown,
  packageName: string,
): boolean {
  return (
    isRecord(value) &&
    Object.values(value).some((entries) =>
      requirementListNamesPackage(entries, packageName),
    )
  );
}

function recordValuesAreArrays(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(Array.isArray);
}

function poetryGroupsHaveValidShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (group) =>
      isRecord(group) &&
      (!Object.hasOwn(group, "dependencies") || isRecord(group.dependencies)),
  );
}

function poetryGroupsNamePackage(value: unknown, packageName: string): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).some((group) => {
    if (!isRecord(group)) return false;
    return dependencyMapNamesPackage(group.dependencies, packageName);
  });
}

/** Whether a pyproject explicitly configures or depends on a Python tool.
 * Malformed manifests conservatively count as declared so an unreadable
 * repository contract is never weakened by the fallback. */
function pyprojectDeclaresPythonTool(
  pyprojectPath: string,
  toolName: string,
): boolean {
  try {
    const parsed = Bun.TOML.parse(
      readFileSync(pyprojectPath, "utf8"),
    ) as Record<string, unknown>;
    if (Object.hasOwn(parsed, "tool") && !isRecord(parsed.tool)) return true;
    if (Object.hasOwn(parsed, "project") && !isRecord(parsed.project)) {
      return true;
    }
    const tool = isRecord(parsed.tool) ? parsed.tool : {};
    if (Object.hasOwn(tool, toolName)) return true;

    const project = isRecord(parsed.project) ? parsed.project : {};
    for (const owner of ["poetry", "pdm", "uv"]) {
      if (Object.hasOwn(tool, owner) && !isRecord(tool[owner])) return true;
    }
    const poetry = isRecord(tool.poetry) ? tool.poetry : {};
    const pdm = isRecord(tool.pdm) ? tool.pdm : {};
    const uv = isRecord(tool.uv) ? tool.uv : {};
    if (
      (Object.hasOwn(project, "dependencies") &&
        !Array.isArray(project.dependencies)) ||
      (Object.hasOwn(project, "optional-dependencies") &&
        !recordValuesAreArrays(project["optional-dependencies"])) ||
      (Object.hasOwn(parsed, "dependency-groups") &&
        !recordValuesAreArrays(parsed["dependency-groups"])) ||
      (Object.hasOwn(poetry, "dependencies") &&
        !isRecord(poetry.dependencies)) ||
      (Object.hasOwn(poetry, "dev-dependencies") &&
        !isRecord(poetry["dev-dependencies"])) ||
      (Object.hasOwn(poetry, "group") &&
        !poetryGroupsHaveValidShape(poetry.group)) ||
      (Object.hasOwn(pdm, "dev-dependencies") &&
        !recordValuesAreArrays(pdm["dev-dependencies"])) ||
      (Object.hasOwn(uv, "dev-dependencies") &&
        !Array.isArray(uv["dev-dependencies"]))
    ) {
      return true;
    }
    return (
      requirementListNamesPackage(project.dependencies, toolName) ||
      groupedRequirementListsNamePackage(
        project["optional-dependencies"],
        toolName,
      ) ||
      groupedRequirementListsNamePackage(
        parsed["dependency-groups"],
        toolName,
      ) ||
      dependencyMapNamesPackage(poetry.dependencies, toolName) ||
      dependencyMapNamesPackage(poetry["dev-dependencies"], toolName) ||
      poetryGroupsNamePackage(poetry.group, toolName) ||
      groupedRequirementListsNamePackage(pdm["dev-dependencies"], toolName) ||
      requirementListNamesPackage(uv["dev-dependencies"], toolName)
    );
  } catch {
    return true;
  }
}

/** Whether pyproject declares a project-wide ty contract. `[tool.ty]` or a
 * supported dependency entry opts in; unreadable supported containers choose
 * checking conservatively. The caller also recognizes root `ty.toml`; a repo
 * declaring neither receives no ambient type-check policy. */
export function pyprojectRequiresProjectWideTy(pyprojectPath: string): boolean {
  return pyprojectDeclaresPythonTool(pyprojectPath, "ty");
}

/** Whether this repository owns a Ruff formatter/linter contract. */
export function pyprojectUsesRuff(pyprojectPath: string): boolean {
  return pyprojectDeclaresPythonTool(pyprojectPath, "ruff");
}

/**
 * Group JS/TS files by the nearest lint-capable package dir. Files with no
 * lint-capable ancestor are dropped (they still commit, just unlinted by npm).
 * Mirrors Python `_group_js_ts_by_pkg`.
 */
function groupJsTsByPkg(
  jsTsFiles: string[],
  cwd: string,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const f of jsTsFiles) {
    const pkgDir = findNearestPkgWithLint(f, cwd);
    if (pkgDir === null) continue;
    const bucket = groups.get(pkgDir) ?? [];
    bucket.push(f);
    groups.set(pkgDir, bucket);
  }
  return groups;
}

/** A non-git subprocess runner: real by default ({@link spawnTool}), injectable
 * via {@link runScopedLint}'s `deps.runTool` so the conditional-stage trigger
 * and failure-aggregation logic is testable without spawning a subprocess. */
export type ToolRunner = (cmd: string[], cwd: string) => Promise<GitExecResult>;

/** Spawn one non-git checker with the same bounded process-tree contract as Git. */
async function spawnTool(cmd: string[], cwd: string): Promise<GitExecResult> {
  return spawnBoundedExec(cmd, {
    cwd,
    timeoutMs: LINT_TIMEOUT_MS,
    maxStdoutBytes: LINT_OUTPUT_LIMIT_BYTES,
    maxStderrBytes: LINT_OUTPUT_LIMIT_BYTES,
  });
}

/**
 * Run the full polyglot check matrix scoped to `stagedFiles`. Resolves when
 * every checker has completed; throws {@link LintFailure} if any failed.
 *
 * `stagedFiles` are repo-relative and already exclude paths deleted in this
 * commit (linters operate on file contents — the caller filters those out).
 * The caller must release the flock before propagating the failure to stdout.
 */
export async function runScopedLint(
  stagedFiles: string[],
  cwd: string,
  deps: { runTool?: ToolRunner } = {},
): Promise<void> {
  const runTool = deps.runTool ?? spawnTool;

  // Loud, opt-in escape hatch for the three staged-path-conditional drift
  // gates below (vendor-corpus, model-guidance, import-boundary) — never the
  // default path, and never the other linter arms above.
  const skipDriftGates = Boolean(
    process.env.KEEPER_COMMIT_WORK_SKIP_DRIFT_GATES,
  );
  if (skipDriftGates) {
    process.stderr.write(
      "commit-work: KEEPER_COMMIT_WORK_SKIP_DRIFT_GATES set — skipping the " +
        "vendor-corpus/model-guidance/import-boundary drift gates for this commit\n",
    );
  }

  const pyFiles = stagedFiles.filter((f) => suffixLower(f) === ".py");
  const tsFiles = stagedFiles.filter((f) => TS_SUFFIXES.has(suffixLower(f)));
  const shFiles = stagedFiles.filter((f) => suffixLower(f) === ".sh");
  const zigFiles = stagedFiles.filter((f) => suffixLower(f) === ".zig");
  const dockerFiles = stagedFiles.filter((f) => isDockerfile(f));
  const jsTsFiles = stagedFiles.filter((f) =>
    JS_TS_SUFFIXES.has(suffixLower(f)),
  );

  const pyprojectPath = join(cwd, "pyproject.toml");
  const hasPyproject = existsSync(pyprojectPath);
  const useTy =
    existsSync(join(cwd, "ty.toml")) ||
    (hasPyproject && pyprojectRequiresProjectWideTy(pyprojectPath));
  const useRuff =
    existsSync(join(cwd, "ruff.toml")) ||
    existsSync(join(cwd, ".ruff.toml")) ||
    (hasPyproject && pyprojectUsesRuff(pyprojectPath));
  const cliBoundariesScript = join(cwd, "scripts", "lint-cli-boundaries.py");
  const tsconfigPath = join(cwd, "tsconfig.json");
  const vendorCorpusScript = join(cwd, "scripts", "vendor-corpus.ts");
  const modelGuidanceScript = join(
    cwd,
    "plugins",
    "plan",
    "scripts",
    "model-guidance-check.ts",
  );
  const boundaryTestFile = join(cwd, "test", "reconcile-core-depgraph.test.ts");

  // Each task resolves to a RecordedFailure or null. They run concurrently;
  // the `order` index pins a stable aggregation order independent of finish
  // time so the `linter="multiple"` envelope is deterministic.
  const tasks: Array<{
    order: number;
    run: () => Promise<RecordedFailure | null>;
  }> = [];

  // 0 --- ruff check (Python, per-file) ---
  if (useRuff && pyFiles.length > 0) {
    tasks.push({
      order: 0,
      run: async () => {
        const r = await runTool(
          ["uv", "run", "ruff", "check", "--", ...pyFiles],
          cwd,
        );
        return r.code !== 0
          ? { linter: "ruff", files: pyFiles, stderr: failureStderr("ruff", r) }
          : null;
      },
    });
  }

  // 1 --- ruff format --check (Python, per-file) ---
  if (useRuff && pyFiles.length > 0) {
    tasks.push({
      order: 1,
      run: async () => {
        const r = await runTool(
          ["uv", "run", "ruff", "format", "--check", "--", ...pyFiles],
          cwd,
        );
        return r.code !== 0
          ? {
              linter: "ruff-format",
              files: pyFiles,
              stderr: failureStderr("ruff-format", r),
            }
          : null;
      },
    });
  }

  // 2 --- ty (only when the repository declares a type-check contract) ---
  if (useTy && pyFiles.length > 0) {
    tasks.push({
      order: 2,
      run: async () => {
        const r = await runTool(["uvx", "ty", "check"], cwd);
        return r.code !== 0
          ? { linter: "ty", files: pyFiles, stderr: failureStderr("ty", r) }
          : null;
      },
    });
  }

  // 3 --- cli-boundaries (project-wide; only when any .py is staged) ---
  if (pyFiles.length > 0 && existsSync(cliBoundariesScript)) {
    tasks.push({
      order: 3,
      run: async () => {
        const r = await runTool([cliBoundariesScript], cwd);
        return r.code !== 0
          ? {
              linter: "cli-boundaries",
              files: pyFiles,
              stderr: failureStderr("cli-boundaries", r),
            }
          : null;
      },
    });
  }

  // 4 --- tsc --noEmit --project <tsconfig> (NEW arm; only when .ts/.tsx staged
  //       AND a tsconfig.json exists at cwd). `--project` is PINNED so tsc can
  //       never silently false-pass against a missing config (a bare
  //       `tsc --noEmit` with no inputs exits 0). Whole-project typecheck is
  //       cross-file by nature, so we do not scope to the staged paths. ---
  if (tsFiles.length > 0 && existsSync(tsconfigPath)) {
    tasks.push({
      order: 4,
      run: async () => {
        const r = await runTool(
          ["tsc", "--noEmit", "--project", tsconfigPath],
          cwd,
        );
        return r.code !== 0
          ? { linter: "tsc", files: tsFiles, stderr: failureStderr("tsc", r) }
          : null;
      },
    });
  }

  // 5 --- shellcheck (.sh, per-file) ---
  if (shFiles.length > 0) {
    tasks.push({
      order: 5,
      run: async () => {
        const r = await runTool(["shellcheck", ...shFiles], cwd);
        return r.code !== 0
          ? {
              linter: "shellcheck",
              files: shFiles,
              stderr: failureStderr("shellcheck", r),
            }
          : null;
      },
    });
  }

  // 6 --- ziglint (.zig, per-file) ---
  if (zigFiles.length > 0) {
    tasks.push({
      order: 6,
      run: async () => {
        const r = await runTool(["ziglint", ...zigFiles], cwd);
        return r.code !== 0
          ? {
              linter: "ziglint",
              files: zigFiles,
              stderr: failureStderr("ziglint", r),
            }
          : null;
      },
    });
  }

  // 7 --- zlint (.zig, walks cwd; invoked once with no args) ---
  if (zigFiles.length > 0) {
    tasks.push({
      order: 7,
      run: async () => {
        const r = await runTool(["zlint"], cwd);
        return r.code !== 0
          ? {
              linter: "zlint",
              files: zigFiles,
              stderr: failureStderr("zlint", r),
            }
          : null;
      },
    });
  }

  // 8 --- hadolint (Dockerfile*, per-file) ---
  if (dockerFiles.length > 0) {
    tasks.push({
      order: 8,
      run: async () => {
        const r = await runTool(["hadolint", ...dockerFiles], cwd);
        return r.code !== 0
          ? {
              linter: "hadolint",
              files: dockerFiles,
              stderr: failureStderr("hadolint", r),
            }
          : null;
      },
    });
  }

  // 9 --- npm (per-subpackage routing; batched once per package dir) ---
  if (jsTsFiles.length > 0) {
    tasks.push({
      order: 9,
      run: async () => {
        const pkgGroups = groupJsTsByPkg(jsTsFiles, cwd);
        // Sorted package-dir order so concatenated stderr is deterministic
        // (mirrors Python's `sorted(pkg_groups.items())`).
        const sortedDirs = [...pkgGroups.keys()].sort();
        if (sortedDirs.length > MAX_NPM_LINT_PACKAGE_GROUPS) {
          return {
            linter: "npm",
            files: jsTsFiles,
            stderr:
              `npm lint spans ${sortedDirs.length} package roots; ` +
              `the bounded maximum is ${MAX_NPM_LINT_PACKAGE_GROUPS}`,
          };
        }
        // Package roots run concurrently. Every child has the same wall-clock
        // timeout, so matrix duration is bounded by one tool window rather than
        // package-count × timeout when --max-files disables cardinality refusal.
        const results = await Promise.all(
          sortedDirs.map(async (pkgDir) => {
            const packageFiles = pkgGroups.get(pkgDir) ?? [];
            const relPaths = packageFiles.map((fileRel) => {
              const absPath = resolve(cwd, fileRel);
              const relPath = relative(pkgDir, absPath);
              return relPath.replace(/\\/g, "/");
            });
            return {
              pkgDir,
              result: await runTool(
                ["npm", "run", "lint", "--", ...relPaths],
                pkgDir,
              ),
            };
          }),
        );
        const npmStderrs = results
          .filter(({ result }) => result.code !== 0)
          .map(({ result }) => (result.stderr || "") + (result.stdout || ""));
        return npmStderrs.length > 0
          ? { linter: "npm", files: jsTsFiles, stderr: npmStderrs.join("") }
          : null;
      },
    });
  }

  // 10 --- claude-md (CLAUDE.md + README.md size + re-narration guard;
  //        keeper-only). Gated on CLAUDE.md OR README.md being staged AND the
  //        script existing at cwd, so it is a strict no-op in any other repo
  //        (commit-work is a general tool). The script scans both files, so a
  //        README-only commit is gated too. ---
  const claudeMdScript = join(cwd, "scripts", "lint-claude-md.ts");
  const docsStaged =
    stagedFiles.includes("CLAUDE.md") || stagedFiles.includes("README.md");
  if (docsStaged && existsSync(claudeMdScript)) {
    tasks.push({
      order: 10,
      run: async () => {
        const r = await runTool(["bun", claudeMdScript], cwd);
        return r.code !== 0
          ? {
              linter: "claude-md",
              files: stagedFiles.filter(
                (f) => f === "CLAUDE.md" || f === "README.md",
              ),
              stderr: failureStderr("claude-md", r),
            }
          : null;
      },
    });
  }

  // 11 --- domain-docs (CONTEXT.md/CONTEXT-MAP.md + docs/adr; ANY repo). The
  //        check travels in the binary, so it gates ONLY on staged paths — never
  //        on a repo-local script (a repo without these files is untouched). The
  //        arm itself fails CLOSED internally, so it never rejects here. ---
  const domainDocFiles = stagedFiles.filter(
    (f) => isContextDocPath(f) || isAdrPath(f),
  );
  if (domainDocFiles.length > 0) {
    tasks.push({
      order: 11,
      run: () => runDomainDocsLint(stagedFiles, cwd),
    });
  }

  // 12 --- vendor-corpus drift (staged path touches the vendored prompt corpus
  //        or a hack/panel skill BAKE guard body; self-contained, sub-second). ---
  if (
    !skipDriftGates &&
    stagedFiles.some(isVendorCorpusPath) &&
    existsSync(vendorCorpusScript)
  ) {
    tasks.push({
      order: 12,
      run: async () => {
        const r = await runTool(["bun", vendorCorpusScript, "--check"], cwd);
        return r.code !== 0
          ? {
              linter: "vendor-corpus",
              files: stagedFiles.filter(isVendorCorpusPath),
              stderr: failureStderr("vendor-corpus", r),
            }
          : null;
      },
    });
  }

  // 13 --- model-guidance drift (staged path touches the plan model-selector
  //        config or its research-cache references tree). ---
  if (
    !skipDriftGates &&
    stagedFiles.some(isModelGuidancePath) &&
    existsSync(modelGuidanceScript)
  ) {
    tasks.push({
      order: 13,
      run: async () => {
        const r = await runTool(["bun", modelGuidanceScript, "--check"], cwd);
        return r.code !== 0
          ? {
              linter: "model-guidance",
              files: stagedFiles.filter(isModelGuidancePath),
              stderr: failureStderr("model-guidance", r),
            }
          : null;
      },
    });
  }

  // 14 --- import-boundary ratchet (staged path touches the plan package's
  //        src/ tree). Scoped to the one fast structural pin, never the whole
  //        root suite. ---
  if (
    !skipDriftGates &&
    stagedFiles.some(isPlanBoundaryPath) &&
    existsSync(boundaryTestFile)
  ) {
    tasks.push({
      order: 14,
      run: async () => {
        const r = await runTool(["bun", "test", boundaryTestFile], cwd);
        return r.code !== 0
          ? {
              linter: "import-boundary",
              files: stagedFiles.filter(isPlanBoundaryPath),
              stderr: failureStderr("import-boundary", r),
            }
          : null;
      },
    });
  }

  // Fire every checker concurrently, then sort results by their dispatch order
  // so aggregation is byte-deterministic regardless of subprocess finish order.
  const settled = await Promise.all(
    tasks.map(async (t) => ({ order: t.order, failure: await t.run() })),
  );
  const failures: RecordedFailure[] = settled
    .filter((s) => s.failure !== null)
    .sort((a, b) => a.order - b.order)
    .map((s) => s.failure as RecordedFailure);

  if (failures.length === 0) return;

  if (failures.length === 1) {
    const only = failures[0];
    throw new LintFailure(only.stderr, only.linter, only.files);
  }

  // Multiple checkers failed — labelled blocks, unioned files (insertion order).
  const blocks: string[] = [];
  const seen = new Set<string>();
  const unionFiles: string[] = [];
  for (const { linter, files, stderr } of failures) {
    blocks.push(`--- ${linter} ---\n${stderr.replace(/\s+$/, "")}\n`);
    for (const f of files) {
      if (!seen.has(f)) {
        seen.add(f);
        unionFiles.push(f);
      }
    }
  }
  throw new LintFailure(blocks.join("\n"), "multiple", unionFiles);
}
