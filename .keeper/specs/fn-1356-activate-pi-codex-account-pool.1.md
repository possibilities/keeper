## Description

**Size:** M
**Files:** ~/.local/state/keeper/pi-codex-pool/proofs/<run-id>.json, ~/docs/pi-codex-account-pool-live-proof.md, ~/docs/pi-codex-account-pool-live-proof.yaml

### Approach

Work only against the landed `fn-1355-add-pi-codex-account-pool` operator contracts: inspect their actual help/status schemas first and refuse a contract mismatch rather than inventing commands or editing source. Establish an isolated proof window, confirm activation is pending, and drive one allowlisted proof run whose machine report is atomically written `0600` under Keeper state. Every clause must share one run id and current revision/config/opaque-alias binding; any prior report, alias/config change, interruption, restoration failure, scanner uncertainty, or unknown field invalidates it.

Interactive OAuth, MFA, logout/revocation, and reauthorization belong to the human. At each such boundary, return `BLOCKED: INPUT_REQUIRED` with the exact landed command, why it is needed, the expected secret-free status transition, and the recovery command; continue only after positive status evidence. Never ask for, receive, print, hash, decode, or copy credential/token/account identity material.

After two distinct aliases are proven through safe booleans and opaque roles, exercise forced per-alias refresh through the landed secure seam, including coalesced concurrent refresh for one alias. Launch one root plus two bounded foreground children behind a barrier so genuine overlap creates Routing pressure and at least two aliases serve successful requests. Then use provider-supported logout/revocation on the non-native alias, force the controlled proof request through it, verify `Substantive output=false`, one different-alias fallback, and exactly one outward response, and restore/revalidate the alias. Separately withhold pool observation/state through the landed proof control to verify the visible native fallback, then restore normal health.

Scan the complete landed artifact inventory—private report, captured stdout/stderr, Keeper/Pi transcripts, sidecars, pressure/cooldown files, temp files, and repository diff—using the allowlisted schema plus deny patterns. Only a fresh `proven` report with every restoration and scan clause true may feed the landed activation command. Verify active state immediately; on reload/verification failure invoke rollback and record `rollback-complete` or `recovery-required`. Finally write only the sanitized human summary and YAML sidecar under `~/docs/`.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before operating):
- `docs/adr/0090-keeper-managed-pi-codex-account-pool.md:21` — credential, routing, retry, activation, and branch boundaries.
- `/Users/mike/docs/pi-codex-provider-routing-proof.md` — prior structural proof and explicit remaining live gate.
- `integrations/pi-codex-pool/src/proof.ts` — landed allowlisted collector/verdict schema; verify after dependency landing.
- `src/agent/main.ts` — landed read-only status and activation command implementations; locate from current descriptor/help rather than old line numbers.
- `docs/install.md` — landed enrollment, proof, activation, rollback, and recovery commands.

**Optional** (reference as needed):
- `src/restart-observation.ts:157` — typed aggregate proof-verdict precedent.
- `scripts/audit-session-activity.ts:47` — bounded allowlisted report precedent.
- `src/provider-leg-death-notice.ts:198` — producer-side secret redaction for unavoidable text.
- `src/file-lock.ts:169` — cross-process mutation serialization used by the landed workflow.

### Risks

- Provider logout/revocation may affect other processes using that alias; stop unless the non-native alias and maintenance window are positively isolated.
- Refresh timing, provider outages, or stale capacity can make evidence inconclusive; never reinterpret environmental uncertainty as a pass.
- A signal or crash while the alias is unavailable can leave recovery-required state; restoration takes precedence over proof completion.
- Transcripts, raw errors, shell history, or temporary artifacts can retain secrets even when the final report is sanitized.
- Activation from a stale report can bind a different revision, config, or alias set than the one tested.

### Test notes

This task is the sanctioned post-landing live operator verification, not a correctness gate. Use the landed pure classifier and status surfaces for assertions, bound every subprocess/session/provider action with a total deadline, and record only allowlisted safe fields. Do not add a second implementation or patch source in this task; a missing capability is an fn-1355 defect and blocks activation.

### Detailed phases

1. Preflight landed contracts, isolated window, pending state, artifact paths, and rollback readiness.
2. Enroll and prove the distinct second alias plus independent/coalesced refresh.
3. Exercise bounded root/child concurrency and route distribution.
4. Induce one non-native pre-output alias failure, prove one fallback, and restore.
5. Prove visible native degradation and restore healthy pool state.
6. Classify, scan, persist, activate, verify, rollback on failure, and write sanitized docs.

### Alternatives

Combine evidence from several runs — rejected because revision/config/alias drift makes the aggregate unauthoritative. Use a mocked failure — rejected because the dependency already has deterministic tests and this epic exists for real-provider evidence.

### Non-functional targets

One bounded maintenance window and run id; no credential or PII collection; no unbounded concurrency or deliberate quota exhaustion; every mutating phase has an idempotent restoration/rollback path.

### Rollout

Activation remains pending until the final verified step. A passing run activates only new Keeper-launched Pi sessions; immediate verification precedes the human report. Rollback restores native behavior without deleting the enrolled aliases.

## Acceptance

- [ ] Preflight proves the landed revision exposes the required read-only status, allowlisted proof, activation, verification, rollback, and recovery contracts; any mismatch blocks without source edits.
- [ ] Two genuinely distinct same-operator aliases are enrolled and independently refreshed through Pi's credential store, with same-alias concurrent refresh coalesced and no credential-derived evidence retained.
- [ ] One root and two overlapping foreground children create bounded Routing pressure, use distinct session keys, successfully exercise both aliases, and complete without hidden retry amplification.
- [ ] Provider-supported failure of the isolated non-native alias occurs before Substantive output, triggers exactly one different-alias attempt and one outward response, and the alias is restored and healthy before activation.
- [ ] Unavailable pool state visibly falls open to native `openai-codex` without claiming balanced operation, and normal pool health is restored afterward.
- [ ] The private report is fresh, allowlisted, revision/config/alias-bound, atomically persisted, and `proven`; scans of every retained artifact surface find no tokens, token-derived identifiers, auth/provider objects, headers, account PII, or raw provider errors.
- [ ] Activation consumes only the verified report, succeeds atomically, and passes immediate root/child status verification; any failure leaves rollback-complete or explicit recovery-required state.
- [ ] `~/docs/pi-codex-account-pool-live-proof.md` and its YAML sidecar contain only the sanitized clause matrix, opaque roles, bounded counters/timestamps, final activation state, and rollback reference.

## Done summary

## Evidence
