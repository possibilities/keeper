#!/usr/bin/env bun

import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  aliasesFromEnvironment,
  type CanonicalOAuth,
  CredentialVault,
  FileCredentialStorage,
} from "./auth.ts";
import { PoolRouteState, PoolStateStore } from "./state.ts";
import {
  parseUsageResponse,
  type SanitizedUsageSnapshot,
  unavailableUsage,
} from "./usage.ts";

export const OBSERVER_SCHEMA_VERSION = 1;
const OBSERVER_TIMEOUT_MS = 8_000;
const MAX_USAGE_BODY_BYTES = 128 * 1024;
const MAX_OBSERVER_OUTPUT_BYTES = 16 * 1024;

export interface ObserverEnvelope {
  schema_version: 1;
  config_binding: string;
  observed_at_ms: number;
  aliases: Array<{
    alias: string;
    usage: SanitizedUsageSnapshot;
  }>;
  truncated: boolean;
}

export type UsageRequest = (input: {
  access: string;
  accountId: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function accountIdFromAccessToken(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid-token");
    const payload = JSON.parse(decodeBase64Url(parts[1])) as Record<
      string,
      unknown
    >;
    const auth = payload["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    const accountId = auth?.chatgpt_account_id;
    if (
      typeof accountId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)
    ) {
      throw new Error("missing-account-id");
    }
    return accountId;
  } catch {
    throw new Error("usage-auth-invalid");
  }
}

function combineSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  caller?.addEventListener("abort", onAbort, { once: true });
  if (caller?.aborted) controller.abort();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      caller?.removeEventListener("abort", onAbort);
    },
  };
}

export const requestCodexUsage: UsageRequest = async ({
  access,
  accountId,
  signal,
}) => {
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${access}`,
      "ChatGPT-Account-Id": accountId,
    },
    signal,
  });
  if (!response.ok) throw new Error(`usage-response-${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_USAGE_BODY_BYTES) {
    throw new Error("usage-response-oversize");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("usage-response-invalid");
  }
};

function failureClass(
  error: unknown,
): "auth" | "network" | "response" | "schema" {
  const message = error instanceof Error ? error.message : "";
  if (/response-\d|response/i.test(message)) return "response";
  if (/auth|credential|token/i.test(message)) return "auth";
  if (/schema|invalid|oversize/i.test(message)) return "schema";
  return "network";
}

export async function observePool(options: {
  aliases: readonly string[];
  vault: CredentialVault;
  routes: PoolRouteState;
  requestUsage?: UsageRequest;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<ObserverEnvelope> {
  const now = options.now ?? Date.now;
  const observedAt = now();
  const aliases: ObserverEnvelope["aliases"] = [];
  const requestUsage = options.requestUsage ?? requestCodexUsage;
  for (const alias of options.aliases) {
    if (options.signal?.aborted) {
      aliases.push({
        alias,
        usage: unavailableUsage(alias, now(), "network"),
      });
      continue;
    }
    const remainingMs = Math.max(1, observedAt + OBSERVER_TIMEOUT_MS - now());
    const combined = combineSignals(options.signal, remainingMs);
    try {
      const credential = await options.vault.resolve(alias, {
        signal: combined.signal,
        deadlineMs: observedAt + OBSERVER_TIMEOUT_MS,
      });
      const raw = await requestUsage({
        access: credential.access,
        accountId: accountIdFromAccessToken(credential.access),
        signal: combined.signal,
      });
      const usage = parseUsageResponse(alias, raw, now());
      options.routes.applyUsage(usage);
      aliases.push({ alias, usage });
    } catch (error) {
      aliases.push({
        alias,
        usage: unavailableUsage(alias, now(), failureClass(error)),
      });
    } finally {
      combined.cleanup();
    }
  }
  return {
    schema_version: OBSERVER_SCHEMA_VERSION,
    config_binding: options.routes.binding,
    observed_at_ms: Math.floor(observedAt),
    aliases,
    truncated: false,
  };
}

export function renderObserverEnvelope(envelope: ObserverEnvelope): string {
  const rendered = JSON.stringify(envelope);
  if (Buffer.byteLength(rendered) <= MAX_OBSERVER_OUTPUT_BYTES) return rendered;
  const bounded: ObserverEnvelope = {
    ...envelope,
    aliases: envelope.aliases.slice(0, 1),
    truncated: true,
  };
  const fallback = JSON.stringify(bounded);
  if (Buffer.byteLength(fallback) > MAX_OBSERVER_OUTPUT_BYTES) {
    return JSON.stringify({
      schema_version: OBSERVER_SCHEMA_VERSION,
      config_binding: envelope.config_binding,
      observed_at_ms: envelope.observed_at_ms,
      aliases: [],
      truncated: true,
    } satisfies ObserverEnvelope);
  }
  return fallback;
}

async function loadInstalledCodexOAuth(
  env: NodeJS.ProcessEnv,
): Promise<CanonicalOAuth> {
  const candidates = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => join(entry, "pi"));
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const cliPath = realpathSync(candidate);
      const packageRoot = dirname(dirname(cliPath));
      const catalogPath = join(
        packageRoot,
        "node_modules",
        "@earendil-works",
        "pi-ai",
        "dist",
        "providers",
        "all.js",
      );
      if (!existsSync(catalogPath)) continue;
      const importModule = new Function(
        "specifier",
        "return import(specifier)",
      ) as (specifier: string) => Promise<unknown>;
      const catalog = (await importModule(pathToFileURL(catalogPath).href)) as {
        builtinProviders?: () => Array<{
          id: string;
          auth: { oauth?: CanonicalOAuth };
        }>;
      };
      const oauth = catalog
        .builtinProviders?.()
        .find((provider) => provider.id === "openai-codex")?.auth.oauth;
      if (oauth) return oauth;
    } catch {
      // Try the next trusted executable location without exposing diagnostics.
    }
  }
  throw new Error("native-codex-oauth-unavailable");
}

function unavailableCommandEnvelope(): string {
  return JSON.stringify({
    schema_version: OBSERVER_SCHEMA_VERSION,
    status: "unavailable",
    reason: "pool-unavailable",
  });
}

export async function runObserverCommand(
  env: NodeJS.ProcessEnv = process.env,
  writeOutput: (output: string) => void = (output) =>
    process.stdout.write(`${output}\n`),
): Promise<number> {
  if ((env.KEEPER_JOB_ID ?? "").trim() === "") {
    writeOutput(unavailableCommandEnvelope());
    return 2;
  }
  try {
    const aliases = aliasesFromEnvironment(env.KEEPER_PI_CODEX_POOL_ALIASES);
    const oauth = await loadInstalledCodexOAuth(env);
    const vault = new CredentialVault(
      new FileCredentialStorage(),
      (credential, signal) => oauth.refresh(credential, signal),
    );
    const routes = new PoolRouteState(aliases, new PoolStateStore());
    writeOutput(
      renderObserverEnvelope(await observePool({ aliases, vault, routes })),
    );
    return 0;
  } catch {
    writeOutput(unavailableCommandEnvelope());
    return 1;
  }
}

if (typeof Bun !== "undefined" && /(?:^|[/\\])observer\.ts$/.test(Bun.main)) {
  runObserverCommand()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stdout.write(`${unavailableCommandEnvelope()}\n`);
      process.exitCode = 1;
    });
}
