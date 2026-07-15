import { describe, expect, test } from "bun:test";
import {
  type CodexResetNamedKey,
  type CodexResetTerminal,
  parseCodexResetMenu,
  parseCodexUsageMenu,
  runCodexResetTui,
} from "../src/codex-reset-tui";

const AVAILABLE = "You have 1 usage limit reset available.";
const CHECK = "Check reset availability.";

function usageScreen(selected: 1 | 2, suffix = AVAILABLE): string {
  return [
    "old unrelated output",
    "    Usage   \r",
    "    View account usage or redeem an earned reset.\r",
    "       \r",
    `${selected === 1 ? "› " : "  "}1. Show usage                View recent account token usage.   \r`,
    `${selected === 2 ? "› " : "  "}2. Redeem usage limit reset  ${suffix}  \r`,
  ].join("\n");
}

function resetScreen(selected: 1 | 2): string {
  return [
    usageScreen(2),
    "",
    "  Usage limit resets",
    "  1 usage limit reset available.",
    "",
    `${selected === 1 ? "› " : "  "}1. Cancel`,
    `${selected === 2 ? "› " : "  "}2. Full reset  Expires 13:40 on 12 Aug 2026.`,
  ].join("\n");
}

class FakeTerminal implements CodexResetTerminal {
  readonly events: string[] = [];
  readonly #screens: string[];
  failFinalEnter = false;

  constructor(screens: string[]) {
    this.#screens = [...screens];
  }

  async start(): Promise<void> {
    this.events.push("start");
  }

  async capture(timeoutMs: number): Promise<string> {
    this.events.push(`capture:${timeoutMs}`);
    const screen = this.#screens.shift();
    if (screen === undefined) throw new Error("unexpected capture");
    return screen;
  }

  async wait(_ms: number): Promise<void> {}

  async sendLiteral(text: string): Promise<void> {
    this.events.push(`literal:${text}`);
  }

  async sendKey(key: CodexResetNamedKey): Promise<void> {
    this.events.push(`key:${key}`);
    if (
      this.failFinalEnter &&
      key === "Enter" &&
      this.events.includes("armed")
    ) {
      throw new Error("transport lost");
    }
  }

  async close(): Promise<void> {
    this.events.push("close");
  }
}

describe("strict Codex reset parsers", () => {
  test("accepts only the two observed first-menu suffixes", () => {
    expect(parseCodexUsageMenu(usageScreen(1, AVAILABLE))).toEqual({
      selected: 1,
      availability: AVAILABLE,
    });
    expect(parseCodexUsageMenu(usageScreen(2, CHECK))).toEqual({
      selected: 2,
      availability: CHECK,
    });
  });

  test("parses the one-reset menu and preserves the expiry text", () => {
    expect(parseCodexResetMenu(resetScreen(1))).toEqual({
      selected: 1,
      expires: "13:40 on 12 Aug 2026.",
    });
  });

  test("fails closed on changed labels, case, numbering, spacing, and suffix", () => {
    const changed = [
      usageScreen(1).replace("Show usage", "Show Usage"),
      usageScreen(1).replace("1. Show", "3. Show"),
      usageScreen(1).replace("usage                View", "usage View"),
      usageScreen(1, "You have 2 usage limit resets available."),
      resetScreen(1).replace("Full reset", "Full Reset"),
      resetScreen(1).replace(
        "  1 usage limit reset available.\n\n› 1. Cancel",
        "  2 usage limits reset available.\n\n› 1. Cancel",
      ),
      resetScreen(1).replace("Expires 13:40 on 12 Aug 2026.", "Expires "),
    ];
    for (const screen of changed.slice(0, 4)) {
      expect(() => parseCodexUsageMenu(screen)).toThrow();
    }
    for (const screen of changed.slice(4)) {
      expect(() => parseCodexResetMenu(screen)).toThrow();
    }
  });

  test("rejects absent, duplicate, ambiguous, and extra-choice menus", () => {
    expect(() => parseCodexUsageMenu("unrelated")).toThrow();
    expect(() =>
      parseCodexUsageMenu(`${usageScreen(1)}\n${usageScreen(1)}`),
    ).toThrow();
    expect(() =>
      parseCodexUsageMenu(usageScreen(1).replace("  2.", "› 2.")),
    ).toThrow();
    expect(() =>
      parseCodexUsageMenu(`${usageScreen(1)}\n  3. Surprise`),
    ).toThrow();
    expect(() =>
      parseCodexResetMenu(`${resetScreen(1)}\n  3. Partial reset`),
    ).toThrow();
    expect(() =>
      parseCodexResetMenu(resetScreen(1).replace("  2.", "› 2.")),
    ).toThrow();
  });
});

describe("Codex reset terminal state machine", () => {
  test("uses the exact guarded sequence and submits once", async () => {
    const terminal = new FakeTerminal([
      usageScreen(1, CHECK),
      usageScreen(2, CHECK),
      resetScreen(1),
      resetScreen(2),
      resetScreen(2),
      "  Usage reset.",
    ]);
    const outcome = await runCodexResetTui(
      terminal,
      () => {
        terminal.events.push("armed");
      },
      { captureTimeoutMs: 321 },
    );

    expect(outcome).toEqual({ kind: "submitted" });
    expect(terminal.events).toEqual([
      "start",
      "literal:/usage",
      "key:Enter",
      "capture:321",
      "key:Down",
      "capture:321",
      "key:Enter",
      "capture:321",
      "key:Down",
      "capture:321",
      "capture:321",
      "armed",
      "key:Enter",
      "capture:321",
      "close",
    ]);
  });

  test("waits through unrelated startup output before applying strict parsing", async () => {
    const terminal = new FakeTerminal([
      "Codex is starting…",
      usageScreen(1),
      usageScreen(2),
      resetScreen(1),
      resetScreen(2),
      resetScreen(2),
      "Usage reset.",
    ]);
    const outcome = await runCodexResetTui(
      terminal,
      () => {
        terminal.events.push("armed");
      },
      { captureTimeoutMs: 500, capturePollMs: 250 },
    );
    expect(outcome).toEqual({ kind: "submitted" });
    expect(
      terminal.events.filter((event) => event.startsWith("capture:")),
    ).toHaveLength(7);
  });

  test("fails after a changed target menu is stable across two captures", async () => {
    const changed = usageScreen(1, "You have one reset available.");
    const terminal = new FakeTerminal([changed, changed]);
    const outcome = await runCodexResetTui(terminal, () => {
      throw new Error("must not arm");
    });
    expect(outcome.kind).toBe("pre-submit-failure");
    expect(
      terminal.events.filter((event) => event.startsWith("capture:")),
    ).toHaveLength(2);
    expect(terminal.events).not.toContain("armed");
  });

  test("revalidates Full reset selection after slow preparation", async () => {
    const terminal = new FakeTerminal([
      usageScreen(1),
      usageScreen(2),
      resetScreen(1),
      resetScreen(2),
      resetScreen(1),
    ]);
    const outcome = await runCodexResetTui(
      terminal,
      () => {
        terminal.events.push("armed");
      },
      {
        prepareFinalEnter: () => {
          terminal.events.push("prepared");
        },
      },
    );
    expect(outcome.kind).toBe("pre-submit-failure");
    if (outcome.kind === "pre-submit-failure") {
      expect(outcome.stage).toBe("revalidate-full-reset");
    }
    expect(terminal.events).toContain("prepared");
    expect(terminal.events).not.toContain("armed");
    expect(
      terminal.events.filter((event) => event === "key:Enter"),
    ).toHaveLength(2);
  });

  test("callback failure is pre-submit and sends no final Enter", async () => {
    const terminal = new FakeTerminal([
      usageScreen(1),
      usageScreen(2),
      resetScreen(1),
      resetScreen(2),
      resetScreen(2),
    ]);
    const outcome = await runCodexResetTui(terminal, () => {
      terminal.events.push("arm-failed");
      throw new Error("latch write failed");
    });

    expect(outcome.kind).toBe("pre-submit-failure");
    if (outcome.kind === "pre-submit-failure") {
      expect(outcome.stage).toBe("before-final-enter");
    }
    expect(terminal.events.slice(-2)).toEqual(["arm-failed", "close"]);
  });

  test("final Enter transport failure is uncertain and never retried", async () => {
    const terminal = new FakeTerminal([
      usageScreen(1),
      usageScreen(2),
      resetScreen(1),
      resetScreen(2),
      resetScreen(2),
    ]);
    terminal.failFinalEnter = true;
    const outcome = await runCodexResetTui(terminal, () => {
      terminal.events.push("armed");
    });

    expect(outcome.kind).toBe("final-enter-uncertain");
    expect(
      terminal.events.filter((event) => event === "key:Enter"),
    ).toHaveLength(3);
    expect(terminal.events.slice(-3)).toEqual(["armed", "key:Enter", "close"]);
  });

  test("reports an explicit post-submit rejection without retrying Enter", async () => {
    const terminal = new FakeTerminal([
      usageScreen(1),
      usageScreen(2),
      resetScreen(1),
      resetScreen(2),
      resetScreen(2),
      "That reset is no longer available.",
    ]);
    const outcome = await runCodexResetTui(terminal, () => {
      terminal.events.push("armed");
    });
    expect(outcome).toEqual({
      kind: "submitted-rejected",
      message: "That reset is no longer available.",
    });
    expect(
      terminal.events.filter((event) => event === "key:Enter"),
    ).toHaveLength(3);
  });

  test("missing post-submit evidence is uncertain and never retries", async () => {
    const terminal = new FakeTerminal([
      usageScreen(1),
      usageScreen(2),
      resetScreen(1),
      resetScreen(2),
      resetScreen(2),
    ]);
    const outcome = await runCodexResetTui(terminal, () => {
      terminal.events.push("armed");
    });
    expect(outcome.kind).toBe("final-enter-uncertain");
    expect(
      terminal.events.filter((event) => event === "key:Enter"),
    ).toHaveLength(3);
  });

  test("selection drift fails before entering the changed menu", async () => {
    const terminal = new FakeTerminal([usageScreen(1), usageScreen(1)]);
    const outcome = await runCodexResetTui(terminal, () => {
      throw new Error("must not run");
    });

    expect(outcome.kind).toBe("pre-submit-failure");
    if (outcome.kind === "pre-submit-failure") {
      expect(outcome.stage).toBe("select-redeem");
    }
    expect(terminal.events).not.toContain("armed");
    expect(terminal.events.slice(-1)).toEqual(["close"]);
  });

  test("does not clean up a session when start did not establish ownership", async () => {
    const terminal = new FakeTerminal([]);
    terminal.start = async () => {
      terminal.events.push("start-failed");
      throw new Error("session already exists");
    };
    const outcome = await runCodexResetTui(terminal, () => undefined);

    expect(outcome.kind).toBe("pre-submit-failure");
    expect(terminal.events).toEqual(["start-failed"]);
  });
});
