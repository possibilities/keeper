#!/usr/bin/env bun

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const PI_AI_CATALOG_RELATIVE_PATH = [
  "node_modules",
  "@earendil-works",
  "pi-ai",
  "dist",
  "providers",
  "all.js",
] as const;
const PI_AI_PACKAGE_CATALOG_RELATIVE_PATH = [
  "dist",
  "providers",
  "all.js",
] as const;
const PI_CODING_AGENT_CATALOG_RELATIVE_PATH = [
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  ...PI_AI_CATALOG_RELATIVE_PATH,
] as const;
const PACKAGE_RELATIVE_PARENT_LIMIT = 6;
const NVM_VERSION_CANDIDATE_LIMIT = 16;

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
      const usage = unavailableUsage(alias, now(), "network");
      options.routes.applyUsage(usage);
      aliases.push({ alias, usage });
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
      const usage = unavailableUsage(alias, now(), failureClass(error));
      options.routes.applyUsage(usage);
      aliases.push({ alias, usage });
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

type CatalogImport = (specifier: string) => Promise<unknown>;

export interface CodexOAuthCatalogResolverOptions {
  moduleUrl?: string;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  listDirectories?: (path: string) => string[];
  importModule?: CatalogImport;
}

interface CatalogProvider {
  id: string;
  auth?: { oauth?: CanonicalOAuth };
}

interface CatalogModule {
  builtinProviders?: () => CatalogProvider[];
}

const defaultCatalogImport = new Function(
  "specifier",
  "return import(specifier)",
) as CatalogImport;

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function defaultListDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function pushPackageManagerCatalogCandidates(
  candidates: string[],
  packageManagerRoot: string,
): void {
  pushUnique(
    candidates,
    join(packageManagerRoot, ...PI_AI_CATALOG_RELATIVE_PATH),
  );
  pushUnique(
    candidates,
    join(packageManagerRoot, ...PI_CODING_AGENT_CATALOG_RELATIVE_PATH),
  );
}

function explicitCatalogCandidates(directory: string): string[] {
  const root = resolve(directory);
  const candidates: string[] = [];
  pushUnique(candidates, join(root, "all.js"));
  pushUnique(candidates, join(root, ...PI_AI_CATALOG_RELATIVE_PATH));
  pushUnique(candidates, join(root, ...PI_AI_PACKAGE_CATALOG_RELATIVE_PATH));
  return candidates;
}

function packageRelativeCatalogCandidates(
  moduleUrl: string,
  realpath: (path: string) => string,
): string[] {
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return [];
  }

  const modulePaths: string[] = [];
  pushUnique(modulePaths, modulePath);
  try {
    pushUnique(modulePaths, realpath(modulePath));
  } catch {
    // The unresolved module path is still enough for fixture and checkout layouts.
  }

  const candidates: string[] = [];
  for (const path of modulePaths) {
    let directory = dirname(path);
    for (let index = 0; index < PACKAGE_RELATIVE_PARENT_LIMIT; index += 1) {
      pushPackageManagerCatalogCandidates(candidates, directory);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return candidates;
}

function nvmVersionParts(name: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(name);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareNvmVersionsDescending(left: string, right: string): number {
  const leftParts = nvmVersionParts(left);
  const rightParts = nvmVersionParts(right);
  if (leftParts && rightParts) {
    for (let index = 0; index < leftParts.length; index += 1) {
      const difference = rightParts[index] - leftParts[index];
      if (difference !== 0) return difference;
    }
  }
  if (leftParts) return -1;
  if (rightParts) return 1;
  return left.localeCompare(right);
}

function homePackageCatalogCandidates(
  env: NodeJS.ProcessEnv,
  listDirectories: (path: string) => string[],
): string[] {
  const home = env.HOME?.trim();
  if (!home) return [];

  const candidates: string[] = [];
  pushPackageManagerCatalogCandidates(
    candidates,
    join(home, ".bun", "install", "global"),
  );

  const nvmVersionsRoot = join(home, ".nvm", "versions", "node");
  for (const version of listDirectories(nvmVersionsRoot)
    .sort(compareNvmVersionsDescending)
    .slice(0, NVM_VERSION_CANDIDATE_LIMIT)) {
    pushPackageManagerCatalogCandidates(
      candidates,
      join(nvmVersionsRoot, version, "lib"),
    );
  }
  return candidates;
}

function pathCatalogCandidates(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  realpath: (path: string) => string,
): string[] {
  const candidates: string[] = [];
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (entry.length === 0) continue;
    try {
      const candidate = join(entry, "pi");
      if (!exists(candidate)) continue;
      const cliPath = realpath(candidate);
      const packageRoot = dirname(dirname(cliPath));
      pushUnique(candidates, join(packageRoot, ...PI_AI_CATALOG_RELATIVE_PATH));
    } catch {
      // Try the next trusted executable location without exposing diagnostics.
    }
  }
  return candidates;
}

export function codexOAuthCatalogCandidates(
  env: NodeJS.ProcessEnv,
  options: CodexOAuthCatalogResolverOptions = {},
): string[] {
  const exists = options.exists ?? existsSync;
  const realpath = options.realpath ?? realpathSync;
  const listDirectories = options.listDirectories ?? defaultListDirectories;
  const candidates: string[] = [];
  const explicitDirectory = env.KEEPER_PI_CODEX_CATALOG_DIR?.trim();
  if (explicitDirectory) {
    for (const candidate of explicitCatalogCandidates(explicitDirectory)) {
      pushUnique(candidates, candidate);
    }
  }
  for (const candidate of packageRelativeCatalogCandidates(
    options.moduleUrl ?? import.meta.url,
    realpath,
  )) {
    pushUnique(candidates, candidate);
  }
  for (const candidate of homePackageCatalogCandidates(env, listDirectories)) {
    pushUnique(candidates, candidate);
  }
  for (const candidate of pathCatalogCandidates(env, exists, realpath)) {
    pushUnique(candidates, candidate);
  }
  return candidates;
}

export async function loadInstalledCodexOAuth(
  env: NodeJS.ProcessEnv,
  options: CodexOAuthCatalogResolverOptions = {},
): Promise<CanonicalOAuth> {
  const exists = options.exists ?? existsSync;
  const importModule = options.importModule ?? defaultCatalogImport;
  for (const catalogPath of codexOAuthCatalogCandidates(env, options)) {
    try {
      if (!exists(catalogPath)) continue;
      const catalog = (await importModule(
        pathToFileURL(catalogPath).href,
      )) as CatalogModule;
      const oauth = catalog
        .builtinProviders?.()
        .find((provider) => provider.id === "openai-codex")?.auth?.oauth;
      if (oauth) return oauth;
    } catch {
      // Try the next trusted catalog location without exposing diagnostics.
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

export interface ObserverCommandOptions {
  catalogResolver?: CodexOAuthCatalogResolverOptions;
}

export async function runObserverCommand(
  env: NodeJS.ProcessEnv = process.env,
  writeOutput: (output: string) => void = (output) =>
    process.stdout.write(`${output}\n`),
  options: ObserverCommandOptions = {},
): Promise<number> {
  if ((env.KEEPER_JOB_ID ?? "").trim() === "") {
    writeOutput(unavailableCommandEnvelope());
    return 2;
  }
  try {
    const aliases = aliasesFromEnvironment(env.KEEPER_PI_CODEX_POOL_ALIASES);
    const oauth = await loadInstalledCodexOAuth(env, options.catalogResolver);
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

let observerEntrypoint = false;
try {
  observerEntrypoint =
    process.argv[1] !== undefined &&
    realpathSync(resolve(process.argv[1])) ===
      realpathSync(fileURLToPath(import.meta.url));
} catch {
  observerEntrypoint = false;
}

if (observerEntrypoint) {
  runObserverCommand()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stdout.write(`${unavailableCommandEnvelope()}\n`);
      process.exitCode = 1;
    });
}
