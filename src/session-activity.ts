import { classifyMonitorActivity } from "./derivers";
import {
  canonicalSubagentInvocations,
  isOpenTurnRow,
} from "./subagent-invocations";

export const HARNESS_CHILD_STALE_SEC = 120;
export const HARNESS_RESOURCE_STALE_SEC = 600;

export type HarnessActivityReason =
  | "main-turn"
  | "open-child"
  | "worker-resource"
  | "parent-terminal"
  | "parent-quiescent"
  | "ambient-resource"
  | "parent-missing"
  | "parent-state-incomplete"
  | "child-evidence-incomplete"
  | "child-evidence-stale"
  | "resource-evidence-incomplete"
  | "resource-evidence-stale";

export type DispatchReservation = "launch" | "bound" | "resume" | null;

export type HarnessActivity =
  | {
      status: "active";
      reason: "main-turn" | "open-child" | "worker-resource";
      reservation: DispatchReservation;
    }
  | {
      status: "quiescent";
      reason: "parent-terminal" | "parent-quiescent" | "ambient-resource";
      reservation: DispatchReservation;
    }
  | {
      status: "unknown";
      reason:
        | "parent-missing"
        | "parent-state-incomplete"
        | "child-evidence-incomplete"
        | "child-evidence-stale"
        | "resource-evidence-incomplete"
        | "resource-evidence-stale";
      reservation: DispatchReservation;
    };

export interface HarnessParentEvidence {
  job_id?: unknown;
  state?: unknown;
  updated_at?: unknown;
  monitors?: unknown;
  has_live_worker_monitor?: unknown;
}

export interface HarnessChildEvidence {
  job_id?: unknown;
  agent_id?: unknown;
  turn_seq?: unknown;
  status?: unknown;
  duration_ms?: unknown;
  updated_at?: unknown;
  subagent_type?: unknown;
}

export interface DeriveHarnessActivityInput {
  parent: HarnessParentEvidence | null | undefined;
  children?: readonly HarnessChildEvidence[];
  now?: number;
  childStaleSec?: number;
  resourceStaleSec?: number;
  reservation?: DispatchReservation;
}

const TERMINAL_PARENT_STATES = new Set(["ended", "killed"]);
const QUIESCENT_PARENT_STATES = new Set(["stopped"]);
const CHILD_STATUSES = new Set([
  "running",
  "ok",
  "failed",
  "unknown",
  "superseded",
]);

function result<T extends HarnessActivity>(
  activity: Omit<T, "reservation">,
  reservation: DispatchReservation,
): T {
  return { ...activity, reservation } as T;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function childEvidenceComplete(child: HarnessChildEvidence): boolean {
  return (
    typeof child.job_id === "string" &&
    child.job_id.length > 0 &&
    typeof child.agent_id === "string" &&
    child.agent_id.length > 0 &&
    finiteNumber(child.turn_seq) &&
    typeof child.status === "string" &&
    CHILD_STATUSES.has(child.status) &&
    (child.duration_ms == null || finiteNumber(child.duration_ms)) &&
    finiteNumber(child.updated_at)
  );
}

export function deriveHarnessActivity(
  input: DeriveHarnessActivityInput,
): HarnessActivity {
  const reservation = input.reservation ?? null;
  const parent = input.parent;
  if (parent == null) {
    return result({ status: "unknown", reason: "parent-missing" }, reservation);
  }

  const state = parent.state;
  if (typeof state !== "string") {
    return result(
      { status: "unknown", reason: "parent-state-incomplete" },
      reservation,
    );
  }
  if (TERMINAL_PARENT_STATES.has(state)) {
    return result(
      { status: "quiescent", reason: "parent-terminal" },
      reservation,
    );
  }
  if (state === "working") {
    return result({ status: "active", reason: "main-turn" }, reservation);
  }
  if (!QUIESCENT_PARENT_STATES.has(state)) {
    return result(
      { status: "unknown", reason: "parent-state-incomplete" },
      reservation,
    );
  }

  const parentJobId =
    typeof parent.job_id === "string" && parent.job_id.length > 0
      ? parent.job_id
      : null;
  const children = input.children ?? [];
  if (parentJobId == null && children.length > 0) {
    return result(
      { status: "unknown", reason: "child-evidence-incomplete" },
      reservation,
    );
  }
  const attributableChildren = children.filter(
    (child) => child.job_id === parentJobId,
  );
  const canonicalChildren = canonicalSubagentInvocations(attributableChildren);
  let incompleteChild = false;
  let staleChild = false;
  for (const child of canonicalChildren) {
    if (!childEvidenceComplete(child)) {
      incompleteChild = true;
      continue;
    }
    if (
      !isOpenTurnRow({
        status: child.status as string,
        duration_ms: child.duration_ms as number | null,
      })
    ) {
      continue;
    }
    const now = input.now ?? Number.NEGATIVE_INFINITY;
    const staleSec = input.childStaleSec ?? HARNESS_CHILD_STALE_SEC;
    if (now - (child.updated_at as number) > staleSec) {
      staleChild = true;
      continue;
    }
    return result({ status: "active", reason: "open-child" }, reservation);
  }
  if (incompleteChild) {
    return result(
      { status: "unknown", reason: "child-evidence-incomplete" },
      reservation,
    );
  }
  if (staleChild) {
    return result(
      { status: "unknown", reason: "child-evidence-stale" },
      reservation,
    );
  }

  const monitorActivity = classifyMonitorActivity(parent.monitors);
  if (
    parent.has_live_worker_monitor != null &&
    typeof parent.has_live_worker_monitor !== "boolean"
  ) {
    return result(
      { status: "unknown", reason: "resource-evidence-incomplete" },
      reservation,
    );
  }
  const embeddedMonitor = parent.has_live_worker_monitor === true;
  if (monitorActivity === "malformed") {
    return result(
      { status: "unknown", reason: "resource-evidence-incomplete" },
      reservation,
    );
  }
  if (monitorActivity === "worker" || embeddedMonitor) {
    if (!finiteNumber(parent.updated_at)) {
      return result(
        { status: "unknown", reason: "resource-evidence-incomplete" },
        reservation,
      );
    }
    const now = input.now ?? Number.NEGATIVE_INFINITY;
    const staleSec = input.resourceStaleSec ?? HARNESS_RESOURCE_STALE_SEC;
    if (now - parent.updated_at > staleSec) {
      return result(
        { status: "unknown", reason: "resource-evidence-stale" },
        reservation,
      );
    }
    return result({ status: "active", reason: "worker-resource" }, reservation);
  }
  if (monitorActivity === "ambient") {
    return result(
      { status: "quiescent", reason: "ambient-resource" },
      reservation,
    );
  }
  return result(
    { status: "quiescent", reason: "parent-quiescent" },
    reservation,
  );
}

export function deriveHarnessActivities<
  P extends HarnessParentEvidence,
  C extends HarnessChildEvidence,
>(
  parents: Iterable<P>,
  children: readonly C[],
  now: number,
  reservationByJobId: ReadonlyMap<
    string,
    Exclude<DispatchReservation, null>
  > = new Map(),
): Map<string, HarnessActivity> {
  const childrenByJobId = new Map<string, C[]>();
  for (const child of children) {
    if (typeof child.job_id !== "string" || child.job_id.length === 0) continue;
    const group = childrenByJobId.get(child.job_id);
    if (group === undefined) childrenByJobId.set(child.job_id, [child]);
    else group.push(child);
  }
  const activities = new Map<string, HarnessActivity>();
  for (const parent of parents) {
    if (typeof parent.job_id !== "string" || parent.job_id.length === 0)
      continue;
    activities.set(
      parent.job_id,
      deriveHarnessActivity({
        parent,
        children: childrenByJobId.get(parent.job_id),
        now,
        reservation: reservationByJobId.get(parent.job_id) ?? null,
      }),
    );
  }
  return activities;
}

export function isResourceEvidenceStaleActivity(
  activity: HarnessActivity | undefined,
): activity is HarnessActivity & {
  status: "unknown";
  reason: "resource-evidence-stale";
} {
  return (
    activity?.status === "unknown" &&
    activity.reason === "resource-evidence-stale"
  );
}

export function harnessActivityHoldsCapacity(
  activity: HarnessActivity,
): boolean {
  return activity.status !== "quiescent" || activity.reservation !== null;
}
