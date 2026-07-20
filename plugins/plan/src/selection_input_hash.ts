import { createHash } from "node:crypto";

export function computeSelectionInputHash(inputForHash: string): string {
  return createHash("sha256").update(inputForHash).digest("hex");
}
