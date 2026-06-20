## Description

**Size:** S
**Files:** src/db.ts, cli/dispatch.ts, README.md, test/ (config-parser + dispatch-handler suites)

Add a config-driven global prompt prefix that wraps `keeper dispatch`
free-form prompts only. Builds on the shipped fn-858 dispatch command.

### Approach

- **`src/db.ts`**: add `dispatchPromptPrefix?: string` to the `KeeperConfig` interface and parse the snake_case `dispatch_prompt_prefix` key inside `resolveConfig()` — non-empty-string only, default `undefined`, independent best-effort. Mirror the existing `buildbot_url` arm exactly (no default, garbage/absent -> undefined).
- **`cli/dispatch.ts`**: it already imports `resolveSockPath` from `../src/db`, so importing `resolveConfig` adds no new import-graph cost. In the FREE-FORM branch ONLY (after the `--prompt`/`--prompt-file` bytes are read), when a prefix is configured, set the prompt to `prefix + " " + prompt`. The plan-form branch (`prompt = defaultPlanPrompt(verb, id)`) MUST stay untouched, and the no-prompt path is unreachable in free form (a prompt is required). Run the existing NUL/96 KB guard (`src/dispatch-command.ts`) on the FINAL prefixed prompt, and ensure `--dry-run` prints the prefixed prompt.
- **Optional nicety**: a `--no-prefix` flag that bypasses the configured prefix for a single invocation (escape hatch once a global prefix is set). Implement only if cheap; otherwise note it in the Done summary as deferred.
- **`README.md`**: document the new `dispatch_prompt_prefix` config key in the config.yaml key list and the `keeper dispatch` section. Forward-facing prose only (state current behavior, no change history).

### Investigation targets

**Required** (read before coding):
- src/db.ts:88-200 — the `KeeperConfig` interface (~:93) and `resolveConfig()` parser; the `buildbot_url` arm (~:165) is the independent best-effort string-key pattern to copy.
- cli/dispatch.ts:37 — the `../src/db` import (resolveConfig is free); :351 — the plan-form `defaultPlanPrompt` site (DO NOT touch); the free-form branch (~:360+) where `--prompt`/`--prompt-file` bytes are assembled — apply the prefix here.

**Optional** (reference as needed):
- src/dispatch-command.ts — the NUL / 96 KB prompt guard, which must run on the final prefixed prompt.

## Acceptance

- [ ] `dispatch_prompt_prefix` parses into `KeeperConfig.dispatchPromptPrefix` (non-empty string; absent/garbage -> undefined), mirroring `buildbot_url`.
- [ ] A free-form dispatch launches with `<prefix> <prompt>` (single space) when the key is set; plan-form (`<verb>::<id>`) and no-prompt dispatches are never prefixed.
- [ ] The NUL/96 KB guard runs on the final prefixed prompt; `--dry-run` reflects the prefixed prompt.
- [ ] Config-parser test (key parses; absent -> undefined) and dispatch-handler test (free-form prefixed; plan-form NOT; dry-run reflects it) added; `bun run test:full` passes.
- [ ] README documents the new config key.

## Done summary

## Evidence
