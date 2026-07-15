#!/usr/bin/env bun
/**
 * `keeper statusline` — Claude Code statusLine renderer plus keeper telemetry
 * capture. Claude invokes this command with one statusLine JSON payload on stdin.
 * The command coalesces the payload into the statusLine leaf directory for the
 * statusline-worker, then prints the human-visible statusline. It never touches
 * the DB/socket and always exits 0 so a render failure cannot blank the prompt.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { KEEPER_ACCOUNT_ORDINAL_ENV } from "../src/account-routing-config";
import { resolveStatuslineDir, runSink } from "./statusline-sink";

const TINTY_SCHEME_FILE = join(
  homedir(),
  ".local/share/tinted-theming/tinty/current_scheme",
);
const TINTY_SCHEMES_DIR = join(
  homedir(),
  ".local/share/tinted-theming/tinty/repos/schemes",
);
const KEEPER_LANE_PREFIX = "keeper/epic/";
const LANE_GLYPH = "⑂";
const CONTEXT_GLYPH = "\uf295";
const NETWORK_GLYPH = "\uf0ec";

interface Theme {
  ctx: string;
  ins: string;
  del: string;
  branch: string;
  project: string;
  sep: string;
  usage: string;
  account: string;
  version: string;
  model: string;
  reset: string;
}

interface StatuslineInput {
  ctxPct: number;
  projectDir: string;
  version: string;
  modelName: string;
  effort: string;
}

export interface GitResult {
  returncode: number;
  stdout: string;
}

export type GitRunner = (projectDir: string, args: string[]) => GitResult;

export interface RenderStatuslineOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  runGit?: GitRunner;
  palette?: Record<string, string> | null;
}

function hexFg(hexColor: string): string {
  const h = hexColor.replace(/^#/, "");
  return `\u001b[38;2;${Number.parseInt(h.slice(0, 2), 16)};${Number.parseInt(h.slice(2, 4), 16)};${Number.parseInt(h.slice(4, 6), 16)}m`;
}

function loadTintyPalette(): Record<string, string> | null {
  try {
    const schemeName = readFileSync(TINTY_SCHEME_FILE, "utf8").trim();
    let system = "";
    let slug = "";
    for (const prefix of ["base24-", "base16-"]) {
      if (schemeName.startsWith(prefix)) {
        system = prefix.slice(0, -1);
        slug = schemeName.slice(prefix.length);
        break;
      }
    }
    if (system === "" || slug === "") {
      return null;
    }
    const yaml = readFileSync(
      join(TINTY_SCHEMES_DIR, system, `${slug}.yaml`),
      "utf8",
    );
    const palette: Record<string, string> = {};
    for (const line of yaml.split(/\r?\n/)) {
      const match = line.match(
        /^\s*(base[0-9A-Fa-f]{2}):\s*["']?#?([0-9A-Fa-f]{6})["']?\s*$/,
      );
      if (match) {
        palette[match[1]] = match[2];
      }
    }
    return Object.keys(palette).length > 0 ? palette : null;
  } catch {
    return null;
  }
}

export function buildTheme(palette: Record<string, string> | null): Theme {
  const reset = "\u001b[0m";
  if (palette !== null) {
    try {
      return {
        ctx: hexFg(palette.base05),
        ins: hexFg(palette.base0B),
        del: hexFg(palette.base08),
        branch: hexFg(palette.base04),
        project: hexFg(palette.base04),
        sep: hexFg(palette.base03),
        usage: hexFg(palette.base0A),
        account: hexFg(palette.base04),
        version: hexFg(palette.base03),
        model: hexFg(palette.base03),
        reset,
      };
    } catch {
      // Fall through to the dependency-free dim theme.
    }
  }
  const dim = "\u001b[2;37m";
  const sep = "\u001b[38;5;245m";
  return {
    ctx: dim,
    ins: dim,
    del: dim,
    branch: dim,
    project: dim,
    sep,
    usage: dim,
    account: dim,
    version: dim,
    model: dim,
    reset,
  };
}

function recordField(
  data: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = data[key];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  data: Record<string, unknown> | null,
  key: string,
): string {
  const value = data?.[key];
  return typeof value === "string" ? value : "";
}

function numberField(
  data: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = data?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseInput(raw: string, cwd: string): StatuslineInput {
  try {
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== "object" || data === null) {
      throw new Error("statusLine payload is not an object");
    }
    const obj = data as Record<string, unknown>;
    const ctx = recordField(obj, "context_window");
    const workspace = recordField(obj, "workspace");
    const model = recordField(obj, "model");
    const effort = recordField(obj, "effort");
    return {
      ctxPct: numberField(ctx, "used_percentage") ?? 0,
      projectDir: stringField(workspace, "project_dir") || cwd,
      version: stringField(obj, "version"),
      modelName: stringField(model, "display_name").toLowerCase(),
      effort: stringField(effort, "level"),
    };
  } catch {
    return {
      ctxPct: 0,
      projectDir: cwd,
      version: "",
      modelName: "",
      effort: "",
    };
  }
}

function defaultRunGit(projectDir: string, args: string[]): GitResult {
  try {
    const result = spawnSync("git", ["-C", projectDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      returncode: result.status ?? 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
    };
  } catch {
    return { returncode: 1, stdout: "" };
  }
}

function compactPlanId(planId: string): string {
  return planId.match(/^(fn-\d+)/)?.[1] ?? planId;
}

export function compactKeeperLane(branch: string): string {
  const raw = branch.trim();
  if (!raw.startsWith(KEEPER_LANE_PREFIX)) {
    return "";
  }
  const lane = raw.slice(KEEPER_LANE_PREFIX.length);
  if (lane === "") {
    return "";
  }
  const [epicId, taskId = ""] = lane.split("--", 2);
  const compactEpic = compactPlanId(epicId);
  if (taskId === "") {
    return `${LANE_GLYPH} ${compactEpic}`;
  }
  const taskPrefix = `${epicId}.`;
  if (taskId.startsWith(taskPrefix)) {
    return `${LANE_GLYPH} ${compactEpic}.${taskId.slice(taskPrefix.length)}`;
  }
  const suffix = taskId.match(/\.(\d+)$/)?.[1];
  if (suffix !== undefined) {
    return `${LANE_GLYPH} ${compactEpic}.${suffix}`;
  }
  return `${LANE_GLYPH} ${compactEpic}--${compactPlanId(taskId)}`;
}

/**
 * Render the selected account's zero-based position in claude-swap's ordered
 * inventory. The launcher supplies this only when multiple Claude accounts are
 * known, so a sole account and every non-Claude provider render no account
 * segment. Slot numbers are deliberately ignored: they may be sparse and are
 * stable route identities, not human-facing ordinals.
 */
function accountLabel(rawOrdinal: string): string {
  if (!/^(0|[1-9]\d*)$/.test(rawOrdinal)) {
    return "";
  }
  return `c${rawOrdinal}`;
}

function resolveGitBranch(
  projectDir: string,
  env: NodeJS.ProcessEnv,
  runGit: GitRunner,
): string {
  const branch = (env.KEEPER_PLAN_WORKTREE_BRANCH ?? "").trim();
  if (branch !== "") {
    return branch;
  }
  const result = runGit(projectDir, ["branch", "--show-current"]);
  return result.returncode === 0 ? result.stdout.trim() : "";
}

function resolveGitProjectName(projectDir: string, runGit: GitRunner): string {
  const fallback = basename(projectDir) || projectDir;
  const result = runGit(projectDir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (result.returncode !== 0) {
    return fallback;
  }
  const commonDir = result.stdout.trim();
  if (commonDir === "") {
    return fallback;
  }
  const commonBase = basename(commonDir);
  if (commonBase === ".git") {
    return basename(dirname(commonDir)) || fallback;
  }
  if (commonBase.endsWith(".git")) {
    return commonBase.slice(0, -4) || fallback;
  }
  return commonBase || fallback;
}

function diffStats(
  projectDir: string,
  runGit: GitRunner,
): { insertions: number; deletions: number } {
  const result = runGit(projectDir, ["diff", "--shortstat"]);
  if (result.returncode !== 0 || result.stdout.trim() === "") {
    return { insertions: 0, deletions: 0 };
  }
  return {
    insertions: Number.parseInt(
      result.stdout.match(/(\d+) insertion/)?.[1] ?? "0",
      10,
    ),
    deletions: Number.parseInt(
      result.stdout.match(/(\d+) deletion/)?.[1] ?? "0",
      10,
    ),
  };
}

export function renderStatusline(
  raw: string,
  options: RenderStatuslineOptions = {},
): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const runGit = options.runGit ?? defaultRunGit;
  const input = parseInput(raw, cwd);
  const theme = buildTheme(
    options.palette === undefined ? loadTintyPalette() : options.palette,
  );

  const ctxColor =
    input.ctxPct >= 20
      ? theme.usage
      : input.ctxPct >= 15
        ? theme.ctx
        : theme.version;
  const sep = `${theme.sep} ∕ `;
  let parts = `${ctxColor}${input.ctxPct.toFixed(0)}${CONTEXT_GLYPH}`;

  const branch = resolveGitBranch(input.projectDir, env, runGit);
  const branchLabel = compactKeeperLane(branch) || branch;
  const project = resolveGitProjectName(input.projectDir, runGit);
  const { insertions, deletions } = diffStats(input.projectDir, runGit);

  parts += `${sep}${theme.project}${project}`;
  if (branchLabel !== "") {
    parts += `${sep}${theme.sep}${theme.branch}${branchLabel}`;
  }
  if (insertions !== 0 || deletions !== 0) {
    parts += `${sep}${theme.ins}+${insertions}${theme.del}−${deletions}`;
  }

  if (input.modelName !== "") {
    parts += `${sep}${theme.model}${input.modelName}`;
    if (input.effort !== "") {
      parts += `${sep}${theme.version}${input.effort}`;
    }
  }

  const statusChunks: string[] = [];
  if ((env.ANTHROPIC_BASE_URL ?? "").startsWith("http://127.0.0.1:")) {
    statusChunks.push(`${theme.account}${NETWORK_GLYPH}`);
  }
  const account = accountLabel((env[KEEPER_ACCOUNT_ORDINAL_ENV] ?? "").trim());

  if (input.version !== "") {
    let versionSeg = `${theme.version}${input.version}`;
    if (statusChunks.length > 0) {
      versionSeg += ` ${statusChunks.join(" ")}`;
    }
    if (account !== "") {
      versionSeg += `${theme.sep} ∕ ${theme.account}${account}`;
    }
    parts += `${sep}${versionSeg}`;
  } else if (statusChunks.length > 0 || account !== "") {
    const chunks = [...statusChunks];
    if (account !== "") {
      chunks.push(`${theme.account}${account}`);
    }
    parts += `${sep}${chunks.join(" ")}`;
  }

  return `${parts}${theme.reset}`;
}

/** Read all of stdin to a UTF-8 string. */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const HELP =
  "keeper statusline — internal Claude Code statusLine renderer/capture. " +
  "Machine-invoked with the statusLine JSON on stdin; writes telemetry for " +
  "the statusline-worker and prints the visible statusline. Takes no arguments.\n";

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    raw = "";
  }
  try {
    runSink(raw, resolveStatuslineDir(), Date.now());
  } catch {
    // runSink is fail-open; keep the render path isolated anyway.
  }
  try {
    process.stdout.write(`${renderStatusline(raw)}\n`);
  } catch {
    process.stdout.write(
      `${buildTheme(null).version}0${CONTEXT_GLYPH}${buildTheme(null).reset}\n`,
    );
  }
}

if (import.meta.main) {
  void main(Bun.argv.slice(2)).finally(() => process.exit(0));
}
