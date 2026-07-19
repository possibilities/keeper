import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  aliasesFromEnvironment,
  type CanonicalOAuth,
  CredentialVault,
  extensionOAuthFromCanonical,
  FileCredentialStorage,
} from "./auth.ts";
import { observePool, renderObserverEnvelope } from "./observer.ts";
import { type CodexDelegate, createPooledCodexStream } from "./pool.ts";
import { PoolRouteState, PoolStateStore } from "./state.ts";

type CompatPiAi = typeof import("@earendil-works/pi-ai/compat");
const { openAICodexResponsesApi } = piAi as unknown as CompatPiAi;

const KEEPER_MARKER = "KEEPER_JOB_ID";
const ALIASES_ENV = "KEEPER_PI_CODEX_POOL_ALIASES";
const WARNING =
  "[keeper-codex-pool] pool-unavailable; using native openai-codex";

interface CommandContext {
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
  signal?: AbortSignal;
}

interface PoolExtensionApi {
  registerProvider(
    name: string,
    config: {
      name?: string;
      api?: string;
      oauth?: ReturnType<typeof extensionOAuthFromCanonical>;
      streamSimple?: (
        model: Model<"openai-codex-responses">,
        context: Context,
        options?: SimpleStreamOptions,
      ) => AssistantMessageEventStream;
    },
  ): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler(args: string, ctx: CommandContext): Promise<void> | void;
    },
  ): void;
}

function nativeOAuth(): CanonicalOAuth | undefined {
  const provider = builtinProviders().find(
    (candidate) => candidate.id === "openai-codex",
  );
  return provider?.auth.oauth as CanonicalOAuth | undefined;
}

function warn(): void {
  console.warn(WARNING);
}

function fallbackStream(
  nativeDelegate: CodexDelegate,
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  warn();
  return nativeDelegate(model, context, options);
}

export function installCodexPool(pi: PoolExtensionApi): void {
  if ((process.env[KEEPER_MARKER] ?? "").trim() === "") return;

  const nativeDelegate = openAICodexResponsesApi()
    .streamSimple as CodexDelegate;
  let aliases: string[];
  let oauth: CanonicalOAuth | undefined;
  try {
    aliases = aliasesFromEnvironment(process.env[ALIASES_ENV]);
    oauth = nativeOAuth();
  } catch {
    aliases = [];
  }

  if (!oauth || aliases.length === 0) {
    pi.registerProvider("openai-codex", {
      api: "openai-codex-responses",
      streamSimple: (model, context, options) =>
        fallbackStream(nativeDelegate, model, context, options),
    });
    pi.registerCommand("codex-pool-observe", {
      description: "Report bounded Keeper Codex pool capacity",
      handler(_args, ctx) {
        ctx.ui.notify(
          JSON.stringify({
            schema_version: 1,
            status: "unavailable",
            reason: "pool-unavailable",
          }),
          "warning",
        );
      },
    });
    return;
  }

  const aliasOAuth = extensionOAuthFromCanonical(oauth);
  for (const [index, alias] of aliases.entries()) {
    pi.registerProvider(alias, {
      name: `Keeper Codex account ${index + 1}`,
      oauth: aliasOAuth,
    });
  }

  const vault = new CredentialVault(
    new FileCredentialStorage(),
    (credential, signal) => oauth.refresh(credential, signal),
  );
  const routes = new PoolRouteState(aliases, new PoolStateStore());
  const pooledDelegate = (
    model: Model<"openai-codex-responses">,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream =>
    createPooledCodexStream(
      {
        vault,
        routes,
        delegate: nativeDelegate,
        nativeDelegate,
        warn: () => warn(),
      },
      model,
      context,
      options,
    );

  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    streamSimple: pooledDelegate,
  });
  pi.registerCommand("codex-pool-observe", {
    description: "Report bounded Keeper Codex pool capacity",
    async handler(_args, ctx) {
      try {
        const envelope = await observePool({
          aliases,
          vault,
          routes,
          signal: ctx.signal,
        });
        ctx.ui.notify(renderObserverEnvelope(envelope), "info");
      } catch {
        ctx.ui.notify(
          JSON.stringify({
            schema_version: 1,
            status: "unavailable",
            reason: "pool-unavailable",
          }),
          "warning",
        );
      }
    },
  });
}

export default function keeperCodexPool(pi: ExtensionAPI): void {
  try {
    installCodexPool(pi as unknown as PoolExtensionApi);
  } catch {
    // A companion failure never prevents Pi from starting.
  }
}
