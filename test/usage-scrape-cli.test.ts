/**
 * In-process coverage for the discriminated-arm contract of run() plus the pure
 * scrape-cli helpers. run()'s scrape / auth / emit collaborators are injected
 * through the RunDeps seam, and claudeAuthLoggedIn's subprocess through an
 * AuthProbe, so NO subprocess spawns and NO stdout pipe is read (which stays
 * empty inside bun test — Bun#24690). The emitted payload OBJECT is captured
 * directly; arm shape + key-absence rules assert against it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ClaudeUsageEndpointRateLimited,
  ClaudeUsageParseError,
  NoActiveSubscription,
  PANEL_HEADER,
  SignedOut,
} from "../src/usage-scrape/parse-claude-usage";
import {
  CodexStatusParseError,
  PANEL_SENTINEL,
} from "../src/usage-scrape/parse-codex-status";
import {
  type AuthProbe,
  claudeAuthLoggedIn,
  hasPanelEvidence,
  main,
  PARSERS,
  passthroughFor,
  type RunDeps,
  run,
  SCHEMA_VERSION,
  screenExcerpt,
} from "../src/usage-scrape/scrape-cli";

type Target = "claude" | "codex";
type Payload = Record<string, unknown>;

const SUBSCRIBED_USAGE = {
  session: { percent_used: 12.0, resets_at: "2026-05-29T17:00:00-04:00" },
  week: { percent_used: 34.0, resets_at: "2026-06-02T09:00:00-04:00" },
};

/** Build a RunDeps whose collaborators never touch a subprocess or stdout, plus
 *  the list the injected emit records into. Overrides win. */
function makeRunDeps(overrides: Partial<RunDeps> = {}): {
  deps: RunDeps;
  payloads: Payload[];
} {
  const payloads: Payload[] = [];
  const deps: RunDeps = {
    scrape: () => Promise.resolve("rendered panel"),
    claudeAuthLoggedIn: () => Promise.resolve(null),
    emit: (payload) => {
      payloads.push(payload);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, payloads };
}

describe("run — discriminated arm contract", () => {
  let savedParsers: typeof PARSERS;
  let stderrBuf: string[];
  const origStderrWrite = process.stderr.write;

  beforeEach(() => {
    savedParsers = { ...PARSERS };
    stderrBuf = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrBuf.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    Object.assign(PARSERS, savedParsers);
    process.stderr.write = origStderrWrite;
  });

  test("test_subscribed_claude_ok_arm", async () => {
    const { deps, payloads } = makeRunDeps({
      scrape: () => Promise.resolve("rendered panel"),
    });
    PARSERS.claude = () => SUBSCRIBED_USAGE;

    const rc = await run("claude", "default", null, null, null, deps);

    expect(rc).toBe(0);
    expect(payloads.length).toBe(1);
    const p = payloads[0];
    expect(p.schema_version).toBe(SCHEMA_VERSION);
    expect(typeof p.schema_version).toBe("number");
    expect(p.status).toBe("ok");
    expect(p.usage).toEqual(SUBSCRIBED_USAGE);
    expect(p.subscription_active).toBe(true);
    expect("no_subscription" in p).toBe(false);
  });

  test("test_codex_ok_arm_has_null_subscription", async () => {
    const { deps, payloads } = makeRunDeps({
      scrape: () => Promise.resolve("rendered panel"),
    });
    PARSERS.codex = () => SUBSCRIBED_USAGE;

    const rc = await run("codex", "codex", null, null, null, deps);

    expect(rc).toBe(0);
    const p = payloads[0];
    expect(p.status).toBe("ok");
    // Codex has no subscription concept — explicitly null, not absent.
    expect(p.subscription_active).toBe(null);
  });

  test("test_no_subscription_ok_arm", async () => {
    const { deps, payloads } = makeRunDeps({
      scrape: () => Promise.resolve("breakdown panel"),
      claudeAuthLoggedIn: () => Promise.resolve(true),
    });
    PARSERS.claude = () => {
      throw new NoActiveSubscription("no plan limits");
    };

    const rc = await run("claude", "default", null, null, null, deps);

    expect(rc).toBe(0);
    const p = payloads[0];
    expect(p.status).toBe("ok");
    expect(p.no_subscription).toBe(true);
    expect("usage" in p).toBe(false);
    expect("subscription_active" in p).toBe(false);
  });

  test("test_no_subscription_logged_out_auth_status_emits_signed_out", async () => {
    const { deps, payloads } = makeRunDeps({
      scrape: () => Promise.resolve("api billing panel"),
      claudeAuthLoggedIn: () => Promise.resolve(false),
    });
    PARSERS.claude = () => {
      throw new NoActiveSubscription("no quota bars");
    };

    const rc = await run("claude", "multi-claude-1", null, null, null, deps);

    expect(rc).toBe(0);
    const p = payloads[0];
    expect(p.status).toBe("ok");
    expect(p.signed_out).toBe(true);
    expect("no_subscription" in p).toBe(false);
    expect("usage" in p).toBe(false);
    expect("subscription_active" in p).toBe(false);
  });

  test("test_no_subscription_inconclusive_auth_status_stays_no_subscription", async () => {
    const { deps, payloads } = makeRunDeps({
      scrape: () => Promise.resolve("api billing panel"),
      claudeAuthLoggedIn: () => Promise.resolve(null),
    });
    PARSERS.claude = () => {
      throw new NoActiveSubscription("no quota bars");
    };

    const rc = await run("claude", "multi-claude-1", null, null, null, deps);

    expect(rc).toBe(0);
    const p = payloads[0];
    expect(p.status).toBe("ok");
    expect(p.no_subscription).toBe(true);
    expect("signed_out" in p).toBe(false);
  });

  test("test_signed_out_ok_arm", async () => {
    const { deps, payloads } = makeRunDeps({
      scrape: () => {
        throw new SignedOut("OAuth sign-in screen detected pre-send");
      },
    });

    const rc = await run("claude", "default", null, null, null, deps);

    expect(rc).toBe(0);
    const p = payloads[0];
    expect(p.schema_version).toBe(1);
    expect(p.schema_version).toBe(SCHEMA_VERSION);
    expect(p.status).toBe("ok");
    expect(p.signed_out).toBe(true);
    expect("usage" in p).toBe(false);
    expect("subscription_active" in p).toBe(false);
    expect("no_subscription" in p).toBe(false);
  });

  test("test_signed_out_detector_throw_degrades_to_scrape_failed", async () => {
    // An UNEXPECTED throw (not SignedOut) degrades to the scrape_failed arm.
    // JS has no RuntimeError — a plain Error carries name "Error".
    const { deps, payloads } = makeRunDeps({
      scrape: () => {
        throw new Error("detector blew up");
      },
    });

    const rc = await run("claude", "default", null, null, null, deps);

    expect(rc).toBe(1);
    const p = payloads[0];
    expect(p.status).toBe("error");
    expect(p.error_kind).toBe("scrape_failed");
    expect(p.error_type).toBe("Error");
    expect(p.screen_excerpt).toEqual([]);
  });

  test("test_scrape_crash_error_arm_empty_excerpt", async () => {
    const { deps, payloads } = makeRunDeps({
      scrape: () => {
        throw new Error("binary not found");
      },
    });

    const rc = await run("claude", "default", null, null, null, deps);

    expect(rc).toBe(1);
    const p = payloads[0];
    expect(p.status).toBe("error");
    expect(p.error_type).toBe("Error");
    expect(p.message).toBe("binary not found");
    expect(p.error_kind).toBe("scrape_failed");
    expect(p.screen_excerpt).toEqual([]);
  });

  test("test_parse_drift_error_arm", async () => {
    const rendered = "line one\nline two\nline three";
    const { deps, payloads } = makeRunDeps({
      scrape: () => Promise.resolve(rendered),
    });
    PARSERS.claude = () => {
      throw new ClaudeUsageParseError("panel format changed");
    };

    const rc = await run("claude", "default", null, null, null, deps);

    expect(rc).toBe(1);
    const p = payloads[0];
    expect(p.status).toBe("error");
    expect(p.error_type).toBe("ClaudeUsageParseError");
    expect(p.message).toBe("panel format changed");
    // No panel header in the rendered rows → the panel never rendered.
    expect(p.error_kind).toBe("panel_missing");
    expect(p.screen_excerpt).toEqual(["line one", "line two", "line three"]);
    // Diagnostics (the stack, carrying the message) go to stderr, never stdout.
    expect(stderrBuf.join("")).toContain("panel format changed");
  });

  test("test_endpoint_throttle_classifies_upstream_even_with_panel", async () => {
    // Endpoint throttling wins over panel evidence: the panel header is present
    // but the kind is upstream_limited, never format_changed.
    const rendered = `${PANEL_HEADER}\nUsage endpoint is rate limited`;
    const { deps, payloads } = makeRunDeps({
      scrape: () => Promise.resolve(rendered),
    });
    PARSERS.claude = () => {
      throw new ClaudeUsageEndpointRateLimited("endpoint throttled");
    };

    await run("claude", "default", null, null, null, deps);

    expect(payloads[0].error_kind).toBe("upstream_limited");
  });

  // target, rendered screen, parser exception, expected error_kind. Panel
  // evidence (claude header / codex `5h limit:`) separates real format drift
  // from a panel that never rendered.
  const CLAUDE_PANEL = `${PANEL_HEADER}\nCurrent session\nsomething unexpected`;
  const CODEX_PANEL = "Codex usage\n5h limit:  [????] garbled (resets ??)";

  const classifyCases: Array<{
    id: string;
    target: Target;
    rendered: string;
    exc: Error;
    errType: string;
    message: string;
    kind: string;
  }> = [
    {
      id: "claude-drift-with-panel",
      target: "claude",
      rendered: CLAUDE_PANEL,
      exc: new ClaudeUsageParseError("bars drifted"),
      errType: "ClaudeUsageParseError",
      message: "bars drifted",
      kind: "format_changed",
    },
    {
      id: "claude-missing-panel",
      target: "claude",
      rendered: "totally unrelated screen\nno header here",
      exc: new ClaudeUsageParseError("panel never rendered"),
      errType: "ClaudeUsageParseError",
      message: "panel never rendered",
      kind: "panel_missing",
    },
    {
      id: "claude-endpoint-throttle",
      target: "claude",
      rendered: "Usage endpoint is rate limited",
      exc: new ClaudeUsageEndpointRateLimited("endpoint throttled"),
      errType: "ClaudeUsageEndpointRateLimited",
      message: "endpoint throttled",
      kind: "upstream_limited",
    },
    {
      id: "codex-drift-with-panel",
      target: "codex",
      rendered: CODEX_PANEL,
      exc: new CodexStatusParseError("weekly line drifted"),
      errType: "CodexStatusParseError",
      message: "weekly line drifted",
      kind: "format_changed",
    },
    {
      id: "codex-missing-panel",
      target: "codex",
      rendered: "some other codex screen\nnothing parseable",
      exc: new CodexStatusParseError("panel never rendered"),
      errType: "CodexStatusParseError",
      message: "panel never rendered",
      kind: "panel_missing",
    },
  ];

  for (const c of classifyCases) {
    test(`test_error_kind_classification[${c.id}]`, async () => {
      const { deps, payloads } = makeRunDeps({
        scrape: () => Promise.resolve(c.rendered),
      });
      PARSERS[c.target] = () => {
        throw c.exc;
      };
      const profile = c.target === "claude" ? "default" : "codex";

      const rc = await run(c.target, profile, null, null, null, deps);

      expect(rc).toBe(1);
      const p = payloads[0];
      expect(p.status).toBe("error");
      expect(p.error_kind).toBe(c.kind);
      // The detailed diagnostic truth survives alongside the classification.
      expect(p.error_type).toBe(c.errType);
      expect(p.message).toBe(c.message);
    });
  }
});

describe("claudeAuthLoggedIn — auth-status probe", () => {
  test("test_claude_auth_logged_in_uses_named_profile_dir", async () => {
    let argv: string[] | undefined;
    let env: Record<string, string> | undefined;
    const probe: AuthProbe = (a, e) => {
      argv = a;
      env = e;
      return Promise.resolve({ stdout: '{"loggedIn": false}\n' });
    };

    const loggedIn = await claudeAuthLoggedIn(
      "multi-claude-1",
      "/bin/claude",
      probe,
    );

    expect(loggedIn).toBe(false);
    expect(argv).toEqual(["/bin/claude", "auth", "status"]);
    // A named profile routes through ~/.claude-profiles/<name>.
    expect(
      env?.CLAUDE_CONFIG_DIR?.endsWith(
        join(".claude-profiles", "multi-claude-1"),
      ),
    ).toBe(true);
  });

  test("test_claude_auth_logged_in_default_profile_unsets_config_dir", async () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/wrong/profile";
    try {
      let env: Record<string, string> | undefined;
      const probe: AuthProbe = (_a, e) => {
        env = e;
        return Promise.resolve({ stdout: '{"loggedIn": true}\n' });
      };

      const loggedIn = await claudeAuthLoggedIn("default", "claude", probe);

      expect(loggedIn).toBe(true);
      expect("CLAUDE_CONFIG_DIR" in (env ?? {})).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = prev;
      }
    }
  });

  test("test_claude_auth_logged_in_returns_none_on_probe_failure", async () => {
    const probe: AuthProbe = () => {
      throw new Error("missing binary");
    };
    expect(await claudeAuthLoggedIn("default", "claude", probe)).toBe(null);
  });

  test("test_claude_auth_logged_in_returns_none_on_bad_json", async () => {
    const probe: AuthProbe = () => Promise.resolve({ stdout: "not json" });
    expect(await claudeAuthLoggedIn("default", "claude", probe)).toBe(null);
  });

  test("test_claude_auth_logged_in_returns_none_on_non_bool_payload", async () => {
    const probe: AuthProbe = () =>
      Promise.resolve({ stdout: '{"loggedIn": "yes"}\n' });
    expect(await claudeAuthLoggedIn("default", "claude", probe)).toBe(null);
  });
});

describe("scrape-cli — pure helpers", () => {
  test("test_main_forwards_args_to_run", async () => {
    // main parses argv and forwards the five values to run, returning its code.
    const calls: Array<
      [Target, string, string | null, number | null, number | null]
    > = [];
    const fakeRun: typeof run = (target, profile, command, rows, cols) => {
      calls.push([target, profile, command, rows, cols]);
      return Promise.resolve(7);
    };

    const rc = await main(
      [
        "--target",
        "codex",
        "--profile",
        "codex-profile",
        "--command",
        "/bin/codex",
        "--rows",
        "41",
        "--cols",
        "120",
      ],
      fakeRun,
    );

    expect(rc).toBe(7);
    expect(calls).toEqual([["codex", "codex-profile", "/bin/codex", 41, 120]]);
  });

  test("test_passthrough_translation", () => {
    // Named Claude profiles route through the agent-profile shim; the default
    // account is native ~/.claude; codex takes no passthrough.
    expect(passthroughFor("claude", "multi-1")).toEqual([
      "--agent-profile",
      "multi-1",
    ]);
    expect(passthroughFor("claude", "default")).toEqual([]);
    expect(passthroughFor("codex", "codex")).toEqual([]);
  });

  test("test_screen_excerpt_elides_long_panels", () => {
    const rendered = Array.from({ length: 100 }, (_, i) => `row ${i}`).join(
      "\n",
    );
    const excerpt = screenExcerpt(rendered, 24);
    expect(excerpt.length).toBe(24);
    expect(excerpt.some((line) => line.includes("lines omitted"))).toBe(true);
    expect(excerpt[0]).toBe("row 0");
    expect(excerpt[excerpt.length - 1]).toBe("row 99");
  });

  test("test_codex_weekly_reset_drift_classifies_as_format_changed", () => {
    // The current codex weekly reset shape drifts from the parser's WEEKLY_RE but
    // the `5h limit:` sentinel still renders — so it's format drift, not a
    // missing panel. Asserted against the real parser.
    const rendered =
      "Codex usage\n" +
      "5h limit:   [####] 99% left (resets 14:05)\n" +
      "Weekly limit:  resets next Monday\n";
    expect(rendered.includes(PANEL_SENTINEL)).toBe(true);
    expect(() => PARSERS.codex(rendered)).toThrow(CodexStatusParseError);
    expect(hasPanelEvidence("codex", rendered)).toBe(true);
  });
});
