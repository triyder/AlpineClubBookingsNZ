// One home for escaping text into a RegExp across scripts/ci (#4397). Kept
// free of `import.meta` and side effects: playwright.config.ts loads it, via
// e2e-spec-shard.mjs, as CommonJS.

/** Escape text for use inside a RegExp. */
export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
