## Description

**Size:** M
**Files:** a re-runnable reconcile script + ndjson state file; backfills gist-url into ~/docs sidecars (commits land in ~/docs)

### Approach

Best-effort, idempotent, rate-limit-paced reconciliation of the ~1000 remote gists to the post-migration shape. Steps:
1. Pre-build the index in ONE call: `gh gist list --json id,description,files -L 1000` (avoids ~1000 `gist view` calls).
2. Join key: the gist's single `.md` filename == a local `~/docs/<basename>.md`. SKIP + LOG ambiguous matches — both REMOTE duplicates (same filename in multiple gists) AND LOCAL same-basename collisions (~11 basenames; README.md already excluded). Do not guess.
3. For each unambiguous match: update the `.md` content (stripped) and add the `.yaml` sidecar. `gh gist edit` is EDITOR-BOUND — use `gh api PATCH /gists/<id> --field "files[<name>.md][content]=<stripped md>"` for the update and `--field "files[<name>.yaml][content]=<sidecar>"` to add (PATCH upserts both files in one call). Single-quote/escape content (YAML/JSON injection surface from adversarial session-id/path).
4. Backfill the discovered `gist-url:` into the local sidecar (so the mapping finally lives locally).
5. ndjson state file: record each processed gist id AFTER a successful PATCH; re-runs skip recorded ids. Handle 404 (deleted gist) → log + skip. On 403/429 secondary-rate-limit → sleep >=60s then exponential backoff. Pace writes well under ~80/min.

### Investigation targets

**Required:**
- `gh gist list --json id,description,files -L 5` + `gh api /gists/<id>` — confirm the PATCH `files[name][content]` shape works (test on ONE gist first)
- ~/docs sidecars from task .4 — the `.yaml` content to upload + where to backfill gist-url

### Risks

- `gh api PATCH` content escaping with multiline + special chars — validate on one gist before the batch.
- Rate limits / abuse detection — respect Retry-After; never hammer on 403.
- Best-effort by design: ~500 of ~1000 expected to match; the rest (temp-named, deleted, non-doc gists) are logged, not errors.

### Test notes

Single-gist end-to-end first (PATCH md + add yaml + backfill local gist-url + verify on github). Then the batch. Final evidence: counts of matched/updated/skipped/404, and the ndjson state file.

## Acceptance

- [ ] one-gist end-to-end verified before the batch
- [ ] matchable gists updated to stripped `.md` + `.yaml` sidecar via `gh api PATCH`; gist-url backfilled into local sidecars
- [ ] ambiguous (remote dup + local same-basename) and 404 gists skipped + logged, not errored
- [ ] ndjson state file makes a re-run skip processed ids; rate-limit backoff in place
- [ ] summary counts reported (matched / updated / skipped / 404)

## Done summary
Added re-runnable gist-reconcile.ts (one paginated index call, basename join skipping remote-dup/local-collision/no-match/multi-file, one PATCH per match upserting stripped .md + .yaml sidecar via -F @file, gist-url backfilled into local sidecars, ndjson state for resumable runs, rate-limit backoff). Validated one-gist-then-batch; reconciled 98 gists this run (matched 313, skip remote-dup 1073, skip no-local 871, skip multi/non-md 888); 215 remain blocked on GitHub's secondary content-write limit, resumable via the state file.
## Evidence
