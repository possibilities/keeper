## Description

Finding F4: the comment at `src/daemon.ts:888-889` says "bounded by `MAX_ZELLIJ_EVENTS_FILE_BYTES`" when describing the `readFileSync` call, but the read at line 833 materializes the full file unconditionally. The `MAX_ZELLIJ_EVENTS_FILE_BYTES` cap bounds only the tail-slice window (`tailBase = Math.max(priorOffset, st.size - maxBytes)` at line 886). fn-706.2 rotation keeps real feeds at ~4 MiB so no memory issue exists in practice, but the comment misleads a future reader who might trace the "bounded by" claim and conclude the read is memory-safe for arbitrarily large files.

Update the comment to accurately say: the full file is materialized first; MAX_ZELLIJ_EVENTS_FILE_BYTES caps the consumed tail window; rotation keeps real feeds well under the cap.

## Acceptance

- [ ] Comment at daemon.ts:888-889 accurately describes that readFileSync reads the full file and the cap bounds only the tail-slice window.

## Done summary
Rewrote the daemon.ts comment so it states readFileSync materializes the whole file and MAX_ZELLIJ_EVENTS_FILE_BYTES caps only the tail-slice window, with a note that fn-706.2 rotation keeps real feeds well under the cap.
## Evidence
