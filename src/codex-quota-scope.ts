export const CODEX_GENERIC_QUOTA_SCOPE = "generic" as const;
export const CODEX_SPARK_QUOTA_SCOPE = "model:gpt-5.3-codex-spark" as const;

export const CODEX_QUOTA_SCOPES = [
  CODEX_GENERIC_QUOTA_SCOPE,
  CODEX_SPARK_QUOTA_SCOPE,
] as const;

export type CodexQuotaScope = (typeof CODEX_QUOTA_SCOPES)[number];

const SPARK_MODEL_BASENAME = "gpt-5.3-codex-spark";
const SPARK_PROVIDER_METER_LABEL = "GPT-5.3-Codex-Spark";
const MAX_MODEL_ID_LENGTH = 160;

export function isCodexQuotaScope(value: unknown): value is CodexQuotaScope {
  return (
    value === CODEX_GENERIC_QUOTA_SCOPE || value === CODEX_SPARK_QUOTA_SCOPE
  );
}

export function parseCodexQuotaScope(
  value: unknown,
): CodexQuotaScope | undefined {
  return isCodexQuotaScope(value) ? value : undefined;
}

function modelBasename(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") return undefined;
  const trimmed = modelId.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > MAX_MODEL_ID_LENGTH ||
    !/^[A-Za-z0-9._:/-]+$/u.test(trimmed)
  ) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  return normalized.split(/[/:]/u).at(-1);
}

export function codexQuotaScopeForModelId(modelId: unknown): CodexQuotaScope {
  return modelBasename(modelId) === SPARK_MODEL_BASENAME
    ? CODEX_SPARK_QUOTA_SCOPE
    : CODEX_GENERIC_QUOTA_SCOPE;
}

export function codexQuotaScopeForUsageMeter(
  meterLabel: unknown,
): CodexQuotaScope {
  return meterLabel === SPARK_PROVIDER_METER_LABEL
    ? CODEX_SPARK_QUOTA_SCOPE
    : CODEX_GENERIC_QUOTA_SCOPE;
}
