#!/usr/bin/env bun
// No-op stub: live sessions whose captured hook set predates grant-guard still
// invoke this path on every gated tool call; exiting 0 keeps them fail-open and
// silent. Safe to delete once no such session remains.
process.exit(0);
