import { type ChildProcess, execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const CONTEXT_GLYPH = "\uf295";
const LANE_GLYPH = "⑂";
const NETWORK_GLYPH = "\uf0ec";
const KEEPER_LANE_PREFIX = "keeper/epic/";
const SEP = " ∕ ";
const ANSI_SGR_PATTERN = `${String.fromCharCode(27)}\\[[0-9;]*m`;
const ANSI_SGR_GLOBAL = new RegExp(ANSI_SGR_PATTERN, "g");
const ANSI_SGR_PREFIX = new RegExp(`^${ANSI_SGR_PATTERN}`);

export interface PiFooterTheme {
  fg(color: string, text: string): string;
}

export interface PiFooterData {
  getGitBranch(): string | null;
  onBranchChange(callback: () => void): () => void;
}

export interface PiFooterContext {
  cwd: string;
  mode?: string;
  model?: { id?: string; name?: string; contextWindow?: number };
  getContextUsage?():
    | {
        tokens: number | null;
        contextWindow: number;
        percent: number | null;
      }
    | undefined;
  ui: {
    setFooter?(
      factory:
        | ((
            tui: { requestRender(): void },
            theme: PiFooterTheme,
            footerData: PiFooterData,
          ) => {
            render(width: number): string[];
            invalidate(): void;
            dispose?(): void;
          })
        | undefined,
    ): void;
  };
}

export interface PiFooterApi {
  getThinkingLevel?(): string;
}

interface FooterState {
  project: string;
  insertions: number;
  deletions: number;
  version: string;
}

interface FooterRenderInput extends FooterState {
  contextPercent: number;
  branch: string;
  model: string;
  effort: string;
  network: boolean;
}

function compactPlanId(planId: string): string {
  return planId.match(/^(fn-\d+)/)?.[1] ?? planId;
}

export function compactPiKeeperLane(branch: string): string {
  const raw = branch.trim();
  if (!raw.startsWith(KEEPER_LANE_PREFIX)) return "";
  const lane = raw.slice(KEEPER_LANE_PREFIX.length);
  if (lane === "") return "";
  const [epicId, taskId = ""] = lane.split("--", 2);
  const compactEpic = compactPlanId(epicId);
  if (taskId === "") return `${LANE_GLYPH} ${compactEpic}`;
  const taskPrefix = `${epicId}.`;
  if (taskId.startsWith(taskPrefix)) {
    return `${LANE_GLYPH} ${compactEpic}.${taskId.slice(taskPrefix.length)}`;
  }
  const suffix = taskId.match(/\.(\d+)$/)?.[1];
  if (suffix !== undefined) return `${LANE_GLYPH} ${compactEpic}.${suffix}`;
  return `${LANE_GLYPH} ${compactEpic}--${compactPlanId(taskId)}`;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_SGR_GLOBAL, "");
}

function terminalCellWidth(point: number): number {
  if (
    point === 0 ||
    point < 32 ||
    (point >= 0x7f && point < 0xa0) ||
    (point >= 0x300 && point <= 0x36f) ||
    (point >= 0x1ab0 && point <= 0x1aff) ||
    (point >= 0x1dc0 && point <= 0x1dff) ||
    (point >= 0xfe00 && point <= 0xfe0f) ||
    (point >= 0xfe20 && point <= 0xfe2f)
  ) {
    return 0;
  }
  return point >= 0x1100 &&
    (point <= 0x115f ||
      point === 0x2329 ||
      point === 0x232a ||
      (point >= 0x2e80 && point <= 0xa4cf) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe10 && point <= 0xfe19) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6) ||
      (point >= 0x1f300 && point <= 0x1faff) ||
      (point >= 0x20000 && point <= 0x3fffd))
    ? 2
    : 1;
}

function visibleCells(value: string): number {
  let width = 0;
  for (const char of stripAnsi(value)) {
    width += terminalCellWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

function truncateAnsi(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleCells(value) <= width) return value;
  let visible = 0;
  let result = "";
  for (let i = 0; i < value.length && visible < width; ) {
    if (value[i] === "\u001b") {
      const match = value.slice(i).match(ANSI_SGR_PREFIX);
      if (match) {
        result += match[0];
        i += match[0].length;
        continue;
      }
    }
    const point = value.codePointAt(i);
    if (point === undefined) break;
    const cellWidth = terminalCellWidth(point);
    if (visible + cellWidth > width) break;
    result += String.fromCodePoint(point);
    i += point > 0xffff ? 2 : 1;
    visible += cellWidth;
  }
  return `${result}\u001b[0m`;
}

export function renderPiStatusFooter(
  input: FooterRenderInput,
  theme: PiFooterTheme,
  width: number,
): string {
  const contextColor =
    input.contextPercent >= 20
      ? "warning"
      : input.contextPercent >= 15
        ? "muted"
        : "dim";
  const parts = [
    theme.fg(
      contextColor,
      `${input.contextPercent.toFixed(0)}${CONTEXT_GLYPH}`,
    ),
    theme.fg("muted", input.project),
  ];
  const branch = compactPiKeeperLane(input.branch) || input.branch;
  if (branch !== "") parts.push(theme.fg("muted", branch));
  if (input.insertions !== 0 || input.deletions !== 0) {
    parts.push(
      theme.fg("success", `+${input.insertions}`) +
        theme.fg("error", `−${input.deletions}`),
    );
  }
  if (input.model !== "")
    parts.push(theme.fg("dim", input.model.toLowerCase()));
  if (input.effort !== "") parts.push(theme.fg("dim", input.effort));
  const tail = [input.version, input.network ? NETWORK_GLYPH : ""]
    .filter(Boolean)
    .join(" ");
  if (tail !== "") parts.push(theme.fg("dim", tail));
  return truncateAnsi(parts.join(theme.fg("dim", SEP)), width);
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["-C", cwd, ...args],
        { encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024 },
        (error, stdout) => resolve(error ? "" : stdout.trim()),
      );
    } catch {
      resolve("");
    }
  });
}

export async function probePiFooterGit(
  cwd: string,
): Promise<Pick<FooterState, "project" | "insertions" | "deletions">> {
  const [commonDir, shortstat] = await Promise.all([
    runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    runGit(cwd, ["diff", "--shortstat"]),
  ]);
  const commonBase = basename(commonDir);
  const project =
    commonBase === ".git"
      ? basename(dirname(commonDir)) || basename(cwd)
      : commonBase.endsWith(".git")
        ? commonBase.slice(0, -4)
        : basename(cwd) || cwd;
  return {
    project,
    insertions: Number.parseInt(
      shortstat.match(/(\d+) insertion/)?.[1] ?? "0",
      10,
    ),
    deletions: Number.parseInt(
      shortstat.match(/(\d+) deletion/)?.[1] ?? "0",
      10,
    ),
  };
}

export function resolvePiVersion(entryPath = process.argv[1] ?? ""): string {
  // `pi` is commonly launched through an npm/nvm bin symlink. Node preserves
  // that launcher path in argv, so walking its parents searches the bin tree
  // rather than the installed package. Resolve the executable first; a bundled
  // binary and a direct dist/cli.js launch both remain valid package anchors.
  let packageEntryPath = entryPath;
  try {
    packageEntryPath = realpathSync(entryPath);
  } catch {
    // Tests, moved installs, or transient launcher paths still get the original
    // best-effort parent walk below.
  }
  let dir = dirname(packageEntryPath);
  for (let depth = 0; depth < 8; depth++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        pkg.name === "@earendil-works/pi-coding-agent" &&
        typeof pkg.version === "string"
      ) {
        return pkg.version;
      }
    } catch {
      // Keep walking toward the package root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // An unresolved package version is not an account identity; omit the segment
  // instead of showing the misleading fallback label `pi`.
  return "";
}

export function buildPiTelemetryPayload(
  jobId: string,
  ctx: PiFooterContext,
  effort: string,
  version: string,
): string {
  const usage = ctx.getContextUsage?.();
  return JSON.stringify({
    session_id: jobId,
    context_window: {
      used_percentage: usage?.percent ?? null,
      total_input_tokens: usage?.tokens ?? null,
      context_window_size:
        usage?.contextWindow ?? ctx.model?.contextWindow ?? null,
    },
    workspace: { project_dir: ctx.cwd },
    version,
    model: {
      id: ctx.model?.id ?? null,
      display_name: ctx.model?.name ?? ctx.model?.id ?? null,
    },
    effort: { level: effort || null },
  });
}

function writeTelemetry(
  jobId: string,
  ctx: PiFooterContext,
  effort: string,
  version: string,
): void {
  const payload = buildPiTelemetryPayload(jobId, ctx, effort, version);
  try {
    const child: ChildProcess = execFile(
      "keeper",
      ["statusline-sink"],
      { timeout: 2_000, maxBuffer: 16 * 1024 },
      () => {},
    );
    child.stdin?.end(payload);
  } catch {
    // Telemetry is advisory; never disturb the Pi session.
  }
}

export interface PiStatusFooterDeps {
  probeGit?: typeof probePiFooterGit;
  writeTelemetry?: typeof writeTelemetry;
  version?: string;
}

/** Install keeper's Claude-style statusline as Pi's custom footer. */
export function installPiStatusFooter(
  pi: PiFooterApi,
  ctx: PiFooterContext,
  jobId: string,
  deps: PiStatusFooterDeps = {},
): () => void {
  try {
    const canRender =
      ctx.mode === "tui" && typeof ctx.ui.setFooter === "function";
    const state: FooterState = {
      project: basename(ctx.cwd) || ctx.cwd,
      insertions: 0,
      deletions: 0,
      version: deps.version ?? resolvePiVersion(),
    };
    const probeGit = deps.probeGit ?? probePiFooterGit;
    const publishTelemetry = deps.writeTelemetry ?? writeTelemetry;
    let requestRender = (): void => {};
    const effort = (): string => pi.getThinkingLevel?.() ?? "";
    const refresh = (): void => {
      if (canRender) {
        void probeGit(ctx.cwd)
          .then((git) => {
            Object.assign(state, git);
            requestRender();
          })
          .catch(() => {});
      }
      publishTelemetry(jobId, ctx, effort(), state.version);
    };

    if (!canRender) {
      refresh();
      return refresh;
    }

    ctx.ui.setFooter?.((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(requestRender);
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          return [
            renderPiStatusFooter(
              {
                ...state,
                contextPercent: ctx.getContextUsage?.()?.percent ?? 0,
                branch:
                  (process.env.KEEPER_PLAN_WORKTREE_BRANCH ?? "").trim() ||
                  footerData.getGitBranch() ||
                  "",
                model: ctx.model?.name ?? ctx.model?.id ?? "",
                effort: effort(),
                network: (process.env.ANTHROPIC_BASE_URL ?? "").startsWith(
                  "http://127.0.0.1:",
                ),
              },
              theme,
              width,
            ),
          ];
        },
      };
    });
    refresh();
    return refresh;
  } catch {
    // A custom footer is cosmetic; Pi must remain usable if it fails.
    return () => {};
  }
}
