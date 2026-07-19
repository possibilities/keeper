# Keeper Pi Codex pool

Route Keeper-marked Pi Codex requests across opaque subscription aliases while leaving standalone Pi untouched.

## Activation boundary

Pi loads the package as an extension, but it registers nothing unless `KEEPER_JOB_ID` is nonempty. Keeper launch integration supplies that marker. Installing the package alone does not activate account routing for ordinary Pi sessions.

The default aliases are `keeper-codex-a` and `keeper-codex-b`. Set `KEEPER_PI_CODEX_POOL_ALIASES` to a JSON array of one through eight names matching `keeper-codex-*` before launch to use a different opaque set. Alias names must not contain email addresses, account names, plan names, or other operator identity.

Enroll each alias through Pi's login flow:

```text
/login keeper-codex-a
/login keeper-codex-b
```

OAuth credentials stay in Pi's `auth.json`. The companion resolves and refreshes only the selected alias under the credential file's cross-process lock and replaces refreshed JSON atomically with private file permissions. Tokens and token-derived account identity are used only for the delegated request and usage fetch.

## Routing contract

The companion overrides only `openai-codex` streaming and delegates wire behavior to Pi's built-in Codex implementation. A session keeps its selected healthy alias. New sessions choose deterministically from fresh worst-window usage, expiring pressure, cooldown, and least-recently-used state.

One logical call can use an initial alias and at most one different alias. The companion disables lower transport retries for pooled attempts. It retries only classified quota, rate, authentication, or transport failures that occur before Substantive output. Text, thinking, tool-call, and unknown events are Substantive; after any such event the attempt and its terminal outcome remain ordered and are never replayed. Abort and the caller's total timeout cover selection, refresh, backoff, and both attempts.

Caller headers, callbacks, transport preference, cache controls, metadata, environment, reasoning controls, context, model, and logical session identity pass through unchanged. Account stickiness prevents a healthy cached connection from crossing aliases; a route changes only after its prior account attempt fails. Pooled delegates force `maxRetries` to zero so the wrapper remains the only account-retry owner.

Missing configuration, unavailable credentials, or failed pool machinery emits this fixed warning and delegates to native `openai-codex`:

```text
[keeper-codex-pool] pool-unavailable; using native openai-codex
```

## Observation and private state

Run `/codex-pool-observe` inside a marked Pi instance, or invoke the package's `keeper-pi-codex-observe` executable from a Keeper-marked environment, to fetch a bounded capacity envelope. It contains only:

- schema and configuration bindings;
- opaque aliases;
- bounded observation and expiration timestamps;
- normalized usage percentages and reset times; and
- fixed health or failure classes.

It never contains raw provider responses, headers, errors, credentials, account IDs, plan labels, or free-form account data.

`keeper-codex-pool-state.json` stores only opaque aliases, bounded usage, pressure, cooldown, selection timestamps, expirations, and the configuration binding. Session routes remain memory-only. This surface is transient routing state, not a keeperd Projection, RPC mutation, lease, or claim.

## Live proof

An armed managed Pi session registers `codex_pool_proof`, a sequential no-argument tool that runs the complete proof once and atomically writes its private report. Models do not assemble proof primitives: the tool drives every required route and records the observed per-clause transcript.

The forced-refresh seam in the credential layer performs a bounded normal OAuth refresh for enrolled aliases even when expiry does not require one. The fault-injection seam at the pooled-stream delegate emits an allowed classified fault before output or after Substantive output, exercising the production classification, retry, cooldown, and fallback path. Both seams are inert outside an armed managed proof window.

The report is an attestation, not a self-reported result. Verification re-derives the verdict from the recorded transcript and the exact revision, configuration, and alias bindings; it also requires root and child routes, completed restoration, and a clean artifact scan. A report that is not derived from an actually recorded run fails verification structurally. The report is evidence only: it does not register providers, change configuration, or activate the pool.

## Pi compatibility seam

The extension imports `openAICodexResponsesApi()` from the `@earendil-works/pi-ai` compat root. Pi's extension loader aliases that root correctly, while its alias currently also captures the documented `@earendil-works/pi-ai/api/openai-codex-responses` subpath as though it were below `compat.js`. The upstream fix belongs in `packages/coding-agent/src/core/extensions/loader.ts` and is tracked through <https://github.com/earendil-works/pi-mono/issues>. Production uses the compat-root seam and does not depend on that issue being resolved.
