#!/usr/bin/env bun
/**
 * Installer bridge: write keeper's default `~/.config/keeper/plugins.yaml` when
 * absent so a fresh machine's `keeper agent` launches without arthack's stow
 * package. Runs keeper's own tested {@link ensureDefaultPluginConfig} (the write
 * decision + never-clobber gate live in src/agent/config.ts, not in bash), so
 * scripts/install.sh stays a thin caller with no divergent copy of the default.
 */
import {
  ensureDefaultPluginConfig,
  pluginConfigPath,
} from "../src/agent/config";

const path = pluginConfigPath();
const outcome = ensureDefaultPluginConfig(path);
process.stdout.write(
  outcome === "written"
    ? `install: wrote default plugins.yaml at ${path}\n`
    : `install: plugins.yaml present at ${path}; left untouched\n`,
);
