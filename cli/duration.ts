// Re-export shim: cli-side callers import `parseDuration` from here; the
// canonical dep-free implementation lives in `../src/duration.ts` so
// daemon-side modules can reach it without crossing into cli/.
export { type DurationParse, parseDuration } from "../src/duration";
