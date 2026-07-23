// Model-level completeness for config transfer (#2200). PR #2199 (#2178) proved
// no COLUMN inside a registered singleton is silently dropped. This is the
// MODEL-level analogue: every singleton-shaped Prisma model must be either
// registered for export or named in MODEL_LEVEL_EXCLUSIONS with a reason, so a
// newly added settings singleton cannot silently join config transfer's blind
// spot by default. The guard test enumerates singleton-shaped models
// mechanically from prisma/schema.prisma and fails on any that is neither.

/**
 * "Singleton-shaped" is the id="default" upsert pattern every club-settings
 * singleton uses: a model whose `@id` scalar defaults to the literal string
 * "default", so the app reads/writes exactly one row via `where: { id: "default" }`.
 * That is how this repo identifies its config singletons (see the per-model
 * loaders and `categories/club-settings.ts`). Models keyed by `cuid()`/`uuid()`
 * or by a business unique — e.g. `AgeTierSetting` (`@default(cuid())`, `tier
 * @unique`, one row per age tier) — are NOT singletons and are deliberately out
 * of scope for this guard: they are multi-row tables that, if portable, belong
 * in the natural-key entity mechanism, not the singleton upsert path.
 *
 * The signature is read from prisma/schema.prisma TEXT, not the runtime DMMF,
 * because Prisma 7's client-side DMMF strips `isId`/`default` from fields (only
 * name/kind/type survive). Parsing the schema source is both the authoritative
 * signal and a truly mechanical enumeration.
 */
export function singletonShapedModelNamesFromSchema(schemaText: string): string[] {
  const names: string[] = [];
  let current: string | null = null;
  for (const rawLine of schemaText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) {
      current = modelMatch[1];
      continue;
    }
    if (line.startsWith("}")) {
      current = null;
      continue;
    }
    // The id line of a singleton: `id String @id @default("default")`. Tolerate
    // spacing variants inside @default(...) so a reformatted schema can't slip a
    // singleton past the enumeration.
    if (current && /@id\b/.test(line) && /@default\(\s*"default"\s*\)/.test(line)) {
      names.push(current);
    }
  }
  return [...names].sort();
}

/**
 * Singleton-shaped models registered for export OUTSIDE the club-settings
 * category (whose registered set the guard derives mechanically from its own
 * SINGLETONS list). Each maps to a one-line note. Kept small and cross-checked:
 * a guard test asserts every entry is genuinely singleton-shaped AND genuinely a
 * registered entity, so a stale claim of registration fails loudly.
 */
export const SINGLETON_MODELS_REGISTERED_ELSEWHERE: Record<string, string> = {
  ClubTheme:
    "exported as the club-theme singleton in the site-content category " +
    "(seed brand columns; format-version 2 collapse, #2187)",
};

/**
 * Singleton-shaped models DELIBERATELY not exported by config transfer, each with
 * a one-line reason — the model-level analogue of `COMMON_EXCLUDED_COLUMNS` /
 * per-spec `excluded` (#2199). A new singleton-shaped model must be registered or
 * added here, or the completeness guard fails until someone classifies it as
 * portable club policy or instance-local. Every reason must be non-empty and name
 * a real, currently singleton-shaped model (both asserted by the guard test).
 */
export const MODEL_LEVEL_EXCLUSIONS: Record<string, string> = {
  XeroGroupingSettings:
    "Xero member-grouping mode is bound to the SOURCE install's connected Xero " +
    "organisation (tenant) and its contact-group configuration; Xero settings are " +
    "tenant-specific and never travel across installs (see the sealed xero-config " +
    "provenance) — instance-local",
  LodgeSettings:
    "per-lodge physical/operational settings (bed capacity, school-group soft cap) " +
    "keyed to a specific lodge via lodgeId; lodge identity and capacity travel " +
    "through the lodge-config category's Lodge rows, not this singleton — " +
    "instance-local",
  SetupProgress:
    "deployment-local setup-wizard progress (which steps THIS install has " +
    "completed/skipped, and by whom); operational install state, not portable " +
    "club policy — instance-local",
  AiAssistantSettings:
    "deployment-specific AI monthly spend cap (NZD integer cents); an operational " +
    "spend control a source club must never silently reset on a target — a fresh " +
    "import keeps the target's own cap (#2211) — instance-local",
};

/**
 * Pure partition helper: given every singleton-shaped model name and the set of
 * names that are accounted for (registered or excluded), return the names that
 * are neither. The guard test asserts this is empty for the live schema, and
 * mutation-checks it with synthetic inputs (a fake unclassified model must be
 * returned; removing a real classification must surface that model).
 */
export function unclassifiedSingletonModels(
  allSingletonModelNames: readonly string[],
  accountedFor: ReadonlySet<string>,
): string[] {
  return allSingletonModelNames.filter((name) => !accountedFor.has(name));
}
