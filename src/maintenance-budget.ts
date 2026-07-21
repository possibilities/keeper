import { performance } from "node:perf_hooks";

export const MAIN_MAINTENANCE_TICK_BUDGET_MS = 250;

export interface MaintenanceTimeBudget {
  readonly limitMs: number;
  exhausted(): boolean;
}

export interface MaintenanceTimeBudgetOptions {
  limitMs?: number;
  now?: () => number;
}

export function createMaintenanceTimeBudget(
  options: MaintenanceTimeBudgetOptions = {},
): MaintenanceTimeBudget {
  const limitMs = options.limitMs ?? MAIN_MAINTENANCE_TICK_BUDGET_MS;
  if (!Number.isFinite(limitMs) || limitMs <= 0) {
    throw new RangeError("limitMs must be a positive finite number");
  }
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  return {
    limitMs,
    exhausted: () => now() - startedAt >= limitMs,
  };
}

export interface BoundedMaintenanceResult {
  batches: number;
  moreLikely: boolean;
}

export interface BudgetedMaintenanceLoopOptions {
  maxBatches: number;
  budget?: MaintenanceTimeBudget;
  yieldTurn?: () => Promise<void>;
  shouldContinue?: () => boolean;
}

function defaultYieldTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export async function runBudgetedMaintenanceLoop<
  T extends BoundedMaintenanceResult,
>(step: () => T, options: BudgetedMaintenanceLoopOptions): Promise<T[]> {
  const { maxBatches } = options;
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 0) {
    throw new RangeError("maxBatches must be a safe non-negative integer");
  }
  const budget = options.budget ?? createMaintenanceTimeBudget();
  const yieldTurn = options.yieldTurn ?? defaultYieldTurn;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const results: T[] = [];

  for (let i = 0; i < maxBatches; i++) {
    if (!shouldContinue() || budget.exhausted()) break;
    const result = step();
    if (
      !Number.isSafeInteger(result.batches) ||
      result.batches < 0 ||
      result.batches > 1
    ) {
      throw new Error("maintenance step must execute at most one transaction");
    }
    results.push(result);
    if (
      result.batches === 0 ||
      !result.moreLikely ||
      i + 1 >= maxBatches ||
      budget.exhausted()
    ) {
      break;
    }
    await yieldTurn();
  }

  return results;
}
