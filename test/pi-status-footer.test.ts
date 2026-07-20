import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPiTelemetryPayload,
  compactPiKeeperLane,
  installPiStatusFooter,
  type PiFooterData,
  type PiFooterTheme,
  renderPiMonitorLine,
  renderPiStatusFooter,
  resolvePiAccountLabel,
  resolvePiVersion,
} from "../plugins/keeper/pi-extension/status-footer";

const plainTheme = { fg: (_color: string, text: string) => text };

describe("Pi keeper status footer", () => {
  test("matches the keeper statusline segment order", () => {
    expect(
      renderPiStatusFooter(
        {
          contextPercent: 12.6,
          project: "keeper",
          branch: "main",
          insertions: 309,
          deletions: 9,
          model: "Claude Opus 4.8",
          effort: "xhigh",
          version: "0.80.6",
          network: false,
          account: "codex-2",
        },
        plainTheme,
        200,
      ),
    ).toBe(
      "13 ∕ keeper ∕ main ∕ +309−9 ∕ claude opus 4.8 ∕ xhigh ∕ 0.80.6 ∕ codex-2",
    );
  });

  test("renders the selected Codex pool position without exposing its alias", () => {
    const env = {
      KEEPER_PI_CODEX_POOL_MODE: "active",
      KEEPER_PI_CODEX_POOL_ALIASES: '["opaque-primary","opaque-alternate"]',
      KEEPER_PI_CODEX_POOL_INITIAL_ALIAS: "opaque-alternate",
    };
    expect(resolvePiAccountLabel(env)).toBe("codex-2");
    expect(
      resolvePiAccountLabel({
        ...env,
        KEEPER_PI_CODEX_POOL_INITIAL_ALIAS: "unknown",
      }),
    ).toBe("");
    expect(
      resolvePiAccountLabel({
        ...env,
        KEEPER_PI_CODEX_POOL_MODE: "native",
      }),
    ).toBe("");
  });

  test("shows only the running Monitor count below the statusline", () => {
    expect(renderPiMonitorLine(0, plainTheme, 80)).toBe("");
    expect(renderPiMonitorLine(1, plainTheme, 80)).toBe("1 monitor");
    expect(renderPiMonitorLine(3, plainTheme, 80)).toBe("3 monitors");
    expect(renderPiMonitorLine(12, plainTheme, 5)).toBe("12 mo\u001b[0m");
  });

  test("compacts keeper worktree lanes to epic and task ordinal", () => {
    expect(
      compactPiKeeperLane("keeper/epic/fn-1193-long-name--fn-1193-long-name.5"),
    ).toBe("⑂ fn-1193.5");
  });

  test("truncates the rendered footer to the available width", () => {
    const rendered = renderPiStatusFooter(
      {
        contextPercent: 0,
        project: "a-very-long-project-name",
        branch: "main",
        insertions: 0,
        deletions: 0,
        model: "model",
        effort: "high",
        version: "pi",
        network: false,
        account: "",
      },
      plainTheme,
      12,
    );
    const esc = String.fromCharCode(27);
    const ansi = new RegExp(`${esc}\\[[0-9;]*m`, "g");
    expect([...rendered.replace(ansi, "")].length).toBeLessThanOrEqual(12);
  });

  test("truncation counts wide project characters as terminal cells", () => {
    const rendered = renderPiStatusFooter(
      {
        contextPercent: 0,
        project: "日本語-project",
        branch: "main",
        insertions: 0,
        deletions: 0,
        model: "model",
        effort: "high",
        version: "pi",
        network: false,
        account: "",
      },
      plainTheme,
      8,
    );
    const esc = String.fromCharCode(27);
    expect(rendered.replace(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "")).toBe(
      "0 ∕ 日",
    );
  });

  test("discovers Pi's package version and omits an unresolved version", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-version-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          version: "1.2.3",
        }),
      );
      mkdirSync(join(root, "dist"));
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "dist", "cli.js"), "");
      symlinkSync("../dist/cli.js", join(root, "bin", "pi"));

      expect(resolvePiVersion(join(root, "dist", "cli.js"))).toBe("1.2.3");
      expect(resolvePiVersion(join(root, "bin", "pi"))).toBe("1.2.3");
      expect(resolvePiVersion("/definitely/missing/pi.js")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("installed footer reads the live Monitor count", () => {
    let monitorCount = 0;
    let footerFactory:
      | ((
          tui: { requestRender(): void },
          theme: PiFooterTheme,
          footerData: PiFooterData,
        ) => {
          render(width: number): string[];
          invalidate(): void;
          dispose?(): void;
        })
      | undefined;
    installPiStatusFooter(
      { getThinkingLevel: () => "high" },
      {
        cwd: "/work/keeper",
        mode: "tui",
        model: { id: "model-1", contextWindow: 100_000 },
        getContextUsage: () => ({
          tokens: 1_000,
          contextWindow: 100_000,
          percent: 1,
        }),
        ui: {
          setFooter: (factory) => {
            footerFactory = factory;
          },
        },
      },
      "job-1",
      {
        version: "pi-test",
        getMonitorCount: () => monitorCount,
        writeTelemetry: () => {},
        probeGit: async () => ({
          project: "keeper",
          insertions: 0,
          deletions: 0,
        }),
      },
    );
    if (footerFactory === undefined) throw new Error("footer not installed");
    const footer = footerFactory({ requestRender() {} }, plainTheme, {
      getGitBranch: () => "main",
      onBranchChange: () => () => {},
    });

    expect(footer.render(100)).toHaveLength(1);
    monitorCount = 1;
    expect(footer.render(100)[1]).toBe("1 monitor");
    monitorCount = 2;
    expect(footer.render(100)[1]).toBe("2 monitors");
  });

  test("non-TUI sessions publish telemetry without installing a footer", () => {
    let writes = 0;
    let footerInstalls = 0;
    const refresh = installPiStatusFooter(
      { getThinkingLevel: () => "high" },
      {
        cwd: "/work/keeper",
        mode: "print",
        model: { id: "model-1", contextWindow: 100_000 },
        getContextUsage: () => ({
          tokens: null,
          contextWindow: 100_000,
          percent: null,
        }),
        ui: { setFooter: () => footerInstalls++ },
      },
      "job-1",
      {
        version: "pi-test",
        writeTelemetry: () => writes++,
        probeGit: async () => {
          throw new Error("non-TUI must not probe git");
        },
      },
    );
    expect(writes).toBe(1);
    expect(footerInstalls).toBe(0);
    refresh();
    expect(writes).toBe(2);
  });

  test("telemetry preserves unknown context and includes Pi model fields", () => {
    const payload = JSON.parse(
      buildPiTelemetryPayload(
        "job-1",
        {
          cwd: "/work/keeper",
          mode: "print",
          model: {
            id: "claude-opus-4-8",
            name: "Opus 4.8",
            contextWindow: 200_000,
          },
          getContextUsage: () => ({
            tokens: null,
            contextWindow: 200_000,
            percent: null,
          }),
          ui: {},
        },
        "xhigh",
        "0.80.6",
      ),
    );
    expect(payload.model).toEqual({
      id: "claude-opus-4-8",
      display_name: "Opus 4.8",
    });
    expect(payload.context_window).toEqual({
      used_percentage: null,
      total_input_tokens: null,
      context_window_size: 200_000,
    });
  });
});
