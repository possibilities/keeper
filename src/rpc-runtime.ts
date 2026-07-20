import type { Database } from "bun:sqlite";
import type {
  DeadLetterOperatorOutcome,
  DeadLetterOperatorRequest,
} from "./dead-letter";
import type {
  DispatchClearOutcome,
  RetryDispatchVerb,
} from "./dispatch-command";
import type { NormalizedFableFocusInput } from "./fable-focus";
import type { RequestAwaitRpcParams } from "./protocol";

export const RPC_METHODS = [
  "replay_dead_letter",
  "resolve_dead_letter",
  "set_autopilot_paused",
  "set_autopilot_mode",
  "set_autopilot_config",
  "set_epic_armed",
  "retry_dispatch",
  "request_handoff",
  "request_await",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

export type RpcHandler = (db: Database, params: unknown) => unknown;

export interface ReplayBridge {
  replay(): Promise<{
    ok: boolean;
    recovered_dl_id?: string | null;
    error?: string;
  }>;
  resolveDeadLetter(request: DeadLetterOperatorRequest): Promise<{
    ok: boolean;
    outcome?: DeadLetterOperatorOutcome;
    error?: string;
  }>;
  setAutopilotPaused(paused: boolean): Promise<{
    ok: boolean;
    error?: string;
  }>;
  retryDispatch(
    verb: RetryDispatchVerb,
    dispatch_id: string,
    force: boolean,
    caller_session: string | null,
  ): Promise<{
    ok: boolean;
    error?: string;
    outcome?: DispatchClearOutcome;
  }>;
  setAutopilotMode(mode: "yolo" | "armed"): Promise<{
    ok: boolean;
    error?: string;
  }>;
  setAutopilotConfig(patch: {
    max_concurrent_jobs?: number | null;
    max_concurrent_per_root?: number | null;
    worktree_mode?: boolean;
    worktree_multi_repo?: boolean;
    worker_provider?: "claude" | "gpt" | null;
    drift_behind_threshold?: number | null;
    drift_age_threshold_days?: number | null;
    fable_focus?: NormalizedFableFocusInput | null;
  }): Promise<{
    ok: boolean;
    error?: string;
    note?: string;
  }>;
  setEpicArmed(
    epic_id: string,
    armed: boolean,
  ): Promise<{
    ok: boolean;
    error?: string;
  }>;
  requestHandoff(req: {
    desired_slug: string;
    doc_path: string;
    title: string | null;
    target_session: string;
    target_dir: string | null;
    initiator_session: string | null;
    initiator_pane: string | null;
    capture: boolean;
    model: string | null;
    effort: string | null;
    preset: string | null;
  }): Promise<{
    ok: boolean;
    error?: string;
    conflict?: boolean;
  }>;
  requestAwait(req: RequestAwaitRpcParams): Promise<{
    ok: boolean;
    error?: string;
  }>;
}

export type AsyncRpcHandler = (
  params: unknown,
  bridge: ReplayBridge,
) => Promise<unknown>;

export class BadParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadParamsError";
  }
}

export class SlugConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlugConflictError";
  }
}

export type RpcRegistration =
  | { method: RpcMethod; kind: "sync"; handler: RpcHandler }
  | { method: RpcMethod; kind: "async"; handler: AsyncRpcHandler };

export interface RpcRegistrar {
  install(registrations: readonly RpcRegistration[]): void;
}

export interface RpcRegistry extends RpcRegistrar {
  readonly syncHandlers: ReadonlyMap<string, RpcHandler>;
  readonly asyncHandlers: ReadonlyMap<string, AsyncRpcHandler>;
  registerSync(method: string, handler: RpcHandler): void;
  registerAsync(method: string, handler: AsyncRpcHandler): void;
  unregister(method: string): void;
  reset(): void;
  assertInstalled(): void;
}

export function createRpcRegistry(): RpcRegistry {
  const syncHandlers = new Map<string, RpcHandler>();
  const asyncHandlers = new Map<string, AsyncRpcHandler>();

  function assertAvailable(method: string): void {
    if (syncHandlers.has(method) || asyncHandlers.has(method)) {
      throw new Error(`RPC method already registered: ${method}`);
    }
  }

  return {
    syncHandlers,
    asyncHandlers,
    registerSync(method, handler) {
      assertAvailable(method);
      syncHandlers.set(method, handler);
    },
    registerAsync(method, handler) {
      assertAvailable(method);
      asyncHandlers.set(method, handler);
    },
    install(registrations) {
      const pending = new Set<string>();
      for (const registration of registrations) {
        if (pending.has(registration.method)) {
          throw new Error(
            `RPC method duplicated in installation: ${registration.method}`,
          );
        }
        pending.add(registration.method);
      }
      if (
        pending.size !== RPC_METHODS.length ||
        RPC_METHODS.some((method) => !pending.has(method))
      ) {
        throw new Error(
          `RPC handler installation incomplete: expected [${RPC_METHODS.join(", ")}], received [${[...pending].join(", ")}]`,
        );
      }
      for (const registration of registrations) {
        assertAvailable(registration.method);
      }
      for (const registration of registrations) {
        if (registration.kind === "sync") {
          syncHandlers.set(registration.method, registration.handler);
        } else {
          asyncHandlers.set(registration.method, registration.handler);
        }
      }
    },
    unregister(method) {
      syncHandlers.delete(method);
      asyncHandlers.delete(method);
    },
    reset() {
      syncHandlers.clear();
      asyncHandlers.clear();
    },
    assertInstalled() {
      const expected = new Set<string>(RPC_METHODS);
      const actual = [...syncHandlers.keys(), ...asyncHandlers.keys()];
      if (
        actual.length !== expected.size ||
        actual.some((method) => !expected.has(method))
      ) {
        throw new Error(
          `RPC registry incomplete: expected [${[...expected].join(", ")}], installed [${actual.join(", ")}]`,
        );
      }
    },
  };
}

export function isMutatingRpcMethod(method: string): boolean {
  return (RPC_METHODS as readonly string[]).includes(method);
}
