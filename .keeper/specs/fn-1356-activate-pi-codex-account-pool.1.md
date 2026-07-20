## Description
**Size:** M
**Files:** ~/.local/state/keeper/pi-codex-pool/proofs/<run-id>.json, ~/docs/pi-codex-account-pool-live-proof.md, ~/docs/pi-codex-account-pool-live-proof.yaml

### Approach

Work only against the landed `fn-1355-add-pi-codex-account-pool` operator contracts: inspect their actual help/status schemas first and refuse a contract mismatch rather than inventing commands or editing source. Establish an isolated proof window, confirm activation is pending, and drive one allowlisted proof run whose machine report is atomically written `0600` under Keeper state. Every clause must share one run id and current revision/config/opaque-alias binding; any prior report, alias/config change, interruption, restoration failure, scanner uncertainty, or unknown field invalidates it.

Never ask for, receive, print, hash, decode, or copy credential/token/account identity material. A genuinely missing enrollment is the only human boundary left; park INPUT_REQUIRED naming the landed enroll command only in that case.

Both aliases are already enrolled (verify their presence read-only in the pool status; enrollment is NOT this task's work and any missing alias is a genuine INPUT_REQUIRED park). **Preflight enrollment evidence, supervisor-verified — do not re-litigate or park on this.** The full read-only evidence chain: (1) the pool credential vault `~/.pi/agent/auth.json` carries stored credentials under BOTH opaque aliases `keeper-codex-a` and `keeper-codex-b` (verify by listing top-level KEYS only — never read, print, or copy values); (2) `~/.config/keeper/codex-pool/activation.json` lists both aliases under a recorded `alias_binding`; (3) `~/.config/keeper/codex-pool/live-proof.json` records a completed prior run whose `independent_credentials` clause rotated BOTH credentials. That chain IS the read-only enrollment verification this spec demands. Whether a stored grant is still live server-side is provable ONLY by the proof run itself — a dead grant surfaces as a classified fault in the verdict, which is reportable evidence, never a preflight blocker. **Expected pre-proof status — not a defect:** `keeper agent accounts codex-pool status --json` currently returns `ok:false`, `state:"native"`, `problem_code:"activation-binding-stale"` with a failed prior-proof verdict (`binding-mismatch`/`stale`/`declared-verdict-mismatch`). That is the STALE PRIOR REPORT bound to an older revision — precisely the designed state this task resolves by producing a fresh `proven` report at the current revision. It is neither structural absence of the proof machinery nor an enrollment gap.

**The proof-producer entry point, verified in source (do not park on "no producer"):** the window is armed by the LAUNCHER flag on the managed pi launch itself — the literal ritual is documented at docs/install.md:228 ("enroll → arm a proof window → prove → activate") and docs/install.md:245-250 (`keeper agent run pi --x-codex-pool-proof-window=arm ...` — the probe directs Pi to invoke `codex_pool_proof` exactly once). The chain in source: src/agent/main.ts:909 defines `--x-codex-pool-proof-window=arm` (fresh managed Pi sessions only, main.ts:3546), main.ts:3919-3920 sets `KEEPER_PI_CODEX_POOL_PROOF_WINDOW` in the leg env under codexMode "proof", and integrations/pi-codex-pool/src/index.ts:673 consumes it, gating the pi.registerTool of `codex_pool_proof` at index.ts:1165. The `keeper agent accounts codex-pool` surface deliberately carries only CONSUMER verbs (status/verify/rollback/proof capture/proof verdict/activate) — the absence of an arming verb there is by design, not a missing producer.

The proof itself is ONE atomic run: arm the proof window at launch, run one managed pi session, and have its model invoke the codex-pool proof tool once (the tool is literally `codex_pool_proof`, registered via pi.registerTool ONLY inside an armed keeper-managed session — it is invisible to CLI help, slash-command lists, and un-armed sessions; verify its presence by asking the armed session's model to enumerate its tools) — the landed atomic orchestrator drives every clause internally — the refresh and fault seams are orchestrator-INTERNAL and have no CLI or command surface; their absence from every help/command listing is by design, never a missing dependency (two forced refreshes across two aliases through the refresh seam including coalesced concurrency, classified pre-output and mid-stream faults through the fault-injection seam, root plus child sessions on distinct aliases, routing pressure, deliberate abort, and the native-fallback window control). No real logout, revocation, or re-enrollment occurs anywhere in the proof: the window-gated seams satisfy the failure clauses per the recorded genuineness carve-out, and a proof path that appears to demand destructive credential operations is a contract mismatch to refuse, not a human boundary to park on.

Scan the complete landed artifact inventory—private report, captured stdout/stderr, Keeper/Pi transcripts, sidecars, pressure/cooldown files, temp files, and repository diff—using the allowlisted schema plus deny patterns. Only a fresh `proven` report with every restoration and scan clause true may feed the landed activation command. Verify active state immediately; on reload/verification failure invoke rollback and record `rollback-complete` or `recovery-required`. Finally write only the sanitized human summary and YAML sidecar under `~/docs/`.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before operating):
- `docs/adr/0090-keeper-managed-pi-codex-account-pool.md:21` — credential, routing, retry, activation, and branch boundaries.
- `/Users/mike/docs/pi-codex-provider-routing-proof.md` — prior structural proof and explicit remaining live gate.
- `integrations/pi-codex-pool/src/proof.ts` — landed allowlisted collector/verdict schema; verify after dependency landing.
- `integrations/pi-codex-pool/src/index.ts` — the `codex_pool_proof` registration (pi.registerTool inside the armed window) and the tool/surface listing.
- `src/agent/main.ts` — landed read-only status and activation command implementations; locate from current descriptor/help rather than old line numbers.
- `docs/install.md` — landed enrollment, proof, activation, rollback, and recovery commands.

**Optional** (reference as needed):
- `src/restart-observation.ts:157` — typed aggregate proof-verdict precedent.
- `scripts/audit-session-activity.ts:47` — bounded allowlisted report precedent.
- `src/provider-leg-death-notice.ts:198` — producer-side secret redaction for unavoidable text.
- `src/file-lock.ts:169` — cross-process mutation serialization used by the landed workflow.

### Risks

- Provider logout/revocation may affect other processes using that alias; stop unless the non-native alias and maintenance window are positively isolated.
- Refresh timing, provider outages, or stale capacity can make evidence inconclusive; never reinterpret environmental uncertainty as a pass. One operator account is currently quota-DEPLETED (human-stated): if its alias cannot serve the two-alias clauses, park with the typed verdict naming the clause — the supervisor routes it to the human.
- A signal or crash while the alias is unavailable can leave recovery-required state; restoration takes precedence over proof completion.
- Transcripts, raw errors, shell history, or temporary artifacts can retain secrets even when the final report is sanitized.
- Activation from a stale report can bind a different revision, config, or alias set than the one tested.

### Test notes

This task is the sanctioned post-landing live operator verification, not a correctness gate. Use the landed pure classifier and status surfaces for assertions, bound every subprocess/session/provider action with a total deadline, and record only allowlisted safe fields. Do not add a second implementation or patch source in this task; a missing capability is an fn-1355 defect and blocks activation.

### Detailed phases

1. Preflight landed contracts, isolated window, pending state, artifact paths, and rollback readiness — using the supervisor-verified enrollment evidence chain above; the stale-bound failed status is the expected starting state, not a blocker.
2. Verify both enrolled aliases read-only and prove independent plus coalesced refresh through the orchestrator's internal seams.
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
