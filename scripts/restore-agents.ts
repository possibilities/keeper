#!/usr/bin/env bun
/**
 * restore-agents — DEPRECATED thin deprecation shim.
 *
 * The crash-restore engine now lives in `src/tabs-core.ts` behind the first-class
 * `keeper tabs` subcommand (`list` / `restore` / `dump`). This script survives
 * ONLY so `cli/setup-tmux.ts`'s existing spawn keeps working until the delegation
 * task re-points setup-tmux at `keeper tabs` and deletes this file. It maps the
 * legacy flag surface to a `keeper tabs` invocation and delegates in-process to
 * `cli/tabs.ts`'s `main`.
 *
 * Flag mapping ({@link mapLegacyArgs}):
 *   --snapshot-current [--session X] [--db Y]  →  tabs dump --include-managed …
 *   [--apply] [--session X] [--last-generation] [--force] [--db Y]  →  tabs restore …
 *
 * `--last-generation` is now the DEFAULT selection (the recency-bounded,
 * richness-ranked topology auto-pick), so it maps to no flag. `--apply` adds
 * `--allow-empty` to preserve the old exit-0-on-zero-candidates behavior. Old
 * `--snapshot-current` dumped the FULL live set (no `plan_verb` filter), so it maps
 * to `--include-managed` to keep that membership. NOTE (transitional): a non-TTY
 * AMBIGUOUS restore now REFUSES (exit 6) where the old util applied the auto-pick
 * anyway — the delegation task's `--generation <id>` closes that gap.
 */

import { parseArgs } from "node:util";
import { main as tabsMain } from "../cli/tabs";

/**
 * Pure: map the legacy `restore-agents` argv to a `keeper tabs` argv. Exported for
 * the shim's flag-mapping tests. Throws on an unrecognized flag (only the legacy
 * set — the sole caller, setup-tmux, passes exactly those).
 */
export function mapLegacyArgs(argv: string[]): string[] {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      apply: { type: "boolean", default: false },
      "snapshot-current": { type: "boolean", default: false },
      "last-generation": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      db: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    return ["restore", "--help"];
  }

  if (values["snapshot-current"] === true) {
    // Old --snapshot-current dumped the FULL live set (no plan_verb filter);
    // `keeper tabs dump` excludes reconciler-managed workers by default, so
    // --include-managed preserves the legacy membership.
    const out = ["dump", "--include-managed"];
    if (values.session != null) out.push("--session", values.session);
    if (values.db != null) out.push("--db", values.db);
    return out;
  }

  // Restore. `--last-generation` IS the new default bounded selection (no flag).
  const out = ["restore"];
  if (values.apply === true) {
    out.push("--apply");
    // The old util exited 0 on a zero-candidate --apply; --allow-empty preserves
    // that (else `keeper tabs restore --apply` exits 7 on an empty set).
    out.push("--allow-empty");
  }
  if (values.session != null) out.push("--session", values.session);
  if (values.force === true) out.push("--force");
  if (values.db != null) out.push("--db", values.db);
  return out;
}

async function main(): Promise<void> {
  process.stderr.write(
    "restore-agents: DEPRECATED — this shim delegates to 'keeper tabs' " +
      "(list/restore/dump); call 'keeper tabs' directly.\n",
  );
  await tabsMain(mapLegacyArgs(Bun.argv.slice(2)));
}

if (import.meta.main) {
  await main();
}
