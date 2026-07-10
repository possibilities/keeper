/**
 * Shared v2 host-matrix fixtures — the cross-island parity contract. Both the
 * launcher island (`src/agent/matrix.ts` `loadMatrixV2`, Bun.YAML 1.2) and the plan
 * island (`plugins/plan/src/host_matrix.ts` `loadHostMatrixV2`, eemeli YAML 1.1)
 * parse these identically. Every scalar here is boolean/null/date/octal-free so the
 * 1.1-vs-1.2 typing rules can't diverge on the two parsers.
 *
 * A fixture is a YAML body; the tests write it to a tmp path and load it by that
 * path (never the live `~/.config/keeper`).
 */

/** A valid claude-only roster — two native cells, no wrapped providers. */
export const CLAUDE_ONLY = [
  "efforts:",
  "  - medium",
  "  - high",
  "subagent_templates:",
  "  - template/agents/worker.md.tmpl",
  "subagent_models:",
  "  - opus",
  "  - sonnet",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - opus",
  "      - sonnet",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

/**
 * A valid multi-provider roster with every launch-id form: claude native
 * (opus/sonnet); codex with a provider-level effort override serving a BARE
 * launch-id (gpt-5.3-codex-spark); pi with a PROVIDER-QUALIFIED launch-id whose
 * basename collides with codex's (cross-provider dedup → codex wins, pi shadowed)
 * and a {id, efforts} band whose capability is launch-only (absent from
 * subagent_models). Mirrors docs/examples/matrix.example.yaml (plus a second
 * template).
 */
export const MULTI_PROVIDER = [
  "efforts:",
  "  - medium",
  "  - high",
  "subagent_templates:",
  "  - template/agents/worker.md.tmpl",
  "  - template/agents/reviewer.md.tmpl",
  "subagent_models:",
  "  - opus",
  "  - sonnet",
  "  - gpt-5.3-codex-spark",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - opus",
  "      - sonnet",
  "  - name: codex",
  "    efforts:",
  "      - high",
  "      - xhigh",
  "    models:",
  "      - gpt-5.3-codex-spark",
  "  - name: pi",
  "    models:",
  "      - id: openai-codex/gpt-5.3-codex-spark",
  "      - id: gpt-5.3-spark-preview",
  "        efforts:",
  "          - medium",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

/** The hand-computed projection of {@link MULTI_PROVIDER} — the parity anchor.
 *  Both islands must reduce to exactly this. */
export const MULTI_PROVIDER_EXPECTED = {
  efforts: ["medium", "high"],
  subagentTemplates: [
    "template/agents/worker.md.tmpl",
    "template/agents/reviewer.md.tmpl",
  ],
  subagentModels: ["opus", "sonnet", "gpt-5.3-codex-spark"],
  drivers: {
    opus: "native",
    sonnet: "native",
    "gpt-5.3-codex-spark": "wrapped",
  } as Record<string, "native" | "wrapped">,
  effortsByModel: {
    opus: ["medium", "high"],
    sonnet: ["medium", "high"],
    "gpt-5.3-codex-spark": ["high", "xhigh"],
    "gpt-5.3-spark-preview": ["medium"],
  } as Record<string, string[]>,
  shadowed: [
    {
      provider: "pi",
      capability: "gpt-5.3-codex-spark",
      launchId: "openai-codex/gpt-5.3-codex-spark",
      winner: "codex",
    },
  ],
};

/** A cross-provider dedup: codex (roster-first) wins gpt-5.5; pi's slashed
 *  launch-id (basename gpt-5.5) is shadowed, not an error. */
export const CROSS_PROVIDER_DEDUP = [
  "efforts:",
  "  - high",
  "subagent_templates:",
  "  - template/agents/worker.md.tmpl",
  "subagent_models:",
  "  - gpt-5.5",
  "providers:",
  "  - name: codex",
  "    models:",
  "      - gpt-5.5",
  "  - name: pi",
  "    models:",
  "      - openai/gpt-5.5",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

/** A provider serving a cell capability AND a launch-only one (absent from
 *  subagent_models): gpt-5.5 is a cell; gpt-5.5-preview enumerates but never
 *  forms a cell. */
export const LAUNCH_ONLY = [
  "efforts:",
  "  - high",
  "subagent_templates:",
  "  - template/agents/worker.md.tmpl",
  "subagent_models:",
  "  - gpt-5.5",
  "providers:",
  "  - name: codex",
  "    models:",
  "      - gpt-5.5",
  "      - gpt-5.5-preview",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

/** A same-provider basename collision — two launch-ids under ONE provider whose
 *  basenames both derive gpt-5.5. A typo → load error. */
export const SAME_PROVIDER_COLLISION = [
  "efforts:",
  "  - high",
  "subagent_templates:",
  "  - template/agents/worker.md.tmpl",
  "subagent_models:",
  "  - gpt-5.5",
  "providers:",
  "  - name: codex",
  "    models:",
  "      - openai/gpt-5.5",
  "      - anthropic/gpt-5.5",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

/** A subagent_models entry no provider serves → load error. */
export const SUBAGENT_MODEL_UNSERVED = [
  "efforts:",
  "  - high",
  "subagent_templates:",
  "  - template/agents/worker.md.tmpl",
  "subagent_models:",
  "  - gpt-5.5",
  "  - ghost-model",
  "providers:",
  "  - name: codex",
  "    models:",
  "      - gpt-5.5",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

/** Build a claude-only body carrying the given extra provider/model lines — the
 *  frame the retired-key fixtures reuse. */
function claudeBase(extra: string[]): string {
  return [
    "efforts:",
    "  - high",
    "subagent_templates:",
    "  - template/agents/worker.md.tmpl",
    "subagent_models:",
    "  - opus",
    "providers:",
    "  - name: claude",
    "    models:",
    "      - opus",
    ...extra,
    "wrapper_driver:",
    "  model: sonnet",
    "  effort: high",
    "",
  ].join("\n");
}

/** Each retired key, paired with the token the rejection must name. */
export const RETIRED_KEY_FIXTURES: {
  key: string;
  body: string;
}[] = [
  {
    key: "subagents",
    body: [
      "efforts:",
      "  - high",
      "subagent_templates:",
      "  - template/agents/worker.md.tmpl",
      "subagent_models:",
      "  - opus",
      "subagents:",
      "  - work",
      "providers:",
      "  - name: claude",
      "    models:",
      "      - opus",
      "wrapper_driver:",
      "  model: sonnet",
      "  effort: high",
      "",
    ].join("\n"),
  },
  {
    key: "route",
    body: claudeBase([
      "  - name: codex",
      "    route: false",
      "    models:",
      "      - gpt-5.5",
    ]),
  },
  {
    key: "native",
    body: claudeBase([
      "  - name: codex",
      "    models:",
      "      - id: gpt-5.5",
      "        native: gpt-5.5-codex",
    ]),
  },
  {
    key: "name",
    body: claudeBase([
      "  - name: codex",
      "    models:",
      "      - name: gpt-5.5",
    ]),
  },
];

/** Fixtures per non-absent failure state (absent is exercised by a missing path).
 *  `unparseable` is malformed YAML; `valid-but-empty` is whitespace; the
 *  `schema-invalid` representative is an unknown top-level key. */
export const UNPARSEABLE = "providers: [unterminated\n";
export const VALID_BUT_EMPTY = "\n   \n";
export const SCHEMA_INVALID = [
  "efforts:",
  "  - high",
  "subagent_templates:",
  "  - template/agents/worker.md.tmpl",
  "subagent_models:",
  "  - opus",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - opus",
  "surprise: 1",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

/** A bad template path (absolute) → schema-invalid. */
export const BAD_TEMPLATE_ABSOLUTE = [
  "efforts:",
  "  - high",
  "subagent_templates:",
  "  - /etc/passwd",
  "subagent_models:",
  "  - opus",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - opus",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

/** A bad template path (traversal) → schema-invalid. */
export const BAD_TEMPLATE_TRAVERSAL = [
  "efforts:",
  "  - high",
  "subagent_templates:",
  "  - ../../etc/passwd",
  "subagent_models:",
  "  - opus",
  "providers:",
  "  - name: claude",
  "    models:",
  "      - opus",
  "wrapper_driver:",
  "  model: sonnet",
  "  effort: high",
  "",
].join("\n");

/** Every VALID fixture body → the parity suite loads each through both islands
 *  and asserts identical projections. */
export const VALID_FIXTURES: { name: string; body: string }[] = [
  { name: "claude-only", body: CLAUDE_ONLY },
  { name: "multi-provider", body: MULTI_PROVIDER },
  { name: "cross-provider-dedup", body: CROSS_PROVIDER_DEDUP },
  { name: "launch-only", body: LAUNCH_ONLY },
];

/** Every SCHEMA-INVALID fixture body → both islands must reject each with a
 *  `schema-invalid` state error. */
export const SCHEMA_INVALID_FIXTURES: { name: string; body: string }[] = [
  { name: "unknown-top-level-key", body: SCHEMA_INVALID },
  { name: "same-provider-collision", body: SAME_PROVIDER_COLLISION },
  { name: "subagent-model-unserved", body: SUBAGENT_MODEL_UNSERVED },
  { name: "bad-template-absolute", body: BAD_TEMPLATE_ABSOLUTE },
  { name: "bad-template-traversal", body: BAD_TEMPLATE_TRAVERSAL },
  ...RETIRED_KEY_FIXTURES.map((f) => ({
    name: `retired-${f.key}`,
    body: f.body,
  })),
];
