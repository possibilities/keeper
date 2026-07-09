/**
 * The `keeper handoff` doc-body cap. This is a DEP-FREE leaf (no `bun:sqlite`,
 * no DB, no other keeper module): `src/daemon.ts` imports it directly so the
 * daemon never reaches into `cli/`, and `cli/handoff.ts` re-imports it for its
 * own `validateHandoffDoc` gate and re-exports it so existing cli-side
 * importers keep resolving `../cli/handoff`.
 */

/** Doc-body cap (bytes, UTF-8). The brief rides inline in `events.data` forever
 *  (the canonical fold source), so an uncapped body is a re-fold time-bomb. This
 *  is a SEPARATE replay-cost cap from the dispatch argv cap. Over-cap → exit 2,
 *  never truncate. */
export const HANDOFF_DOC_MAX_BYTES = 64 * 1024;
