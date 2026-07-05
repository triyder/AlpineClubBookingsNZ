import { z } from "zod";

import {
  CLUB_THEME_FONT_KEYS,
  isValidLogoDataUrl,
  isValidThemeColour,
  sanitiseRawCss,
} from "@/lib/club-theme-schema";

/**
 * Zod validators for the club-theme update payload. These live apart from
 * `club-theme-schema.ts` so that the base module (colour/font constants,
 * contrast helpers, CSS builders, sanitisers) stays free of any `zod` value
 * import and is therefore safe to bundle into the `'use client'` site-style
 * wizard without dragging zod into the `admin/site-style` client bundle. The
 * wizard lazy-loads this module via a dynamic `import()` purely for live
 * client-side field validation; server request validation
 * (`api/admin/site-style/route.ts`) imports it statically. The helpers pulled
 * from the base module are plain functions/constant tuples, so importing them
 * here does not pull zod back into that base module (#1278, follow-up from
 * #1197).
 */
const colourSchema = z
  .string()
  .trim()
  .refine(
    isValidThemeColour,
    "Use a 6-digit hex colour or exact oklch() value.",
  );

const logoDataUrlSchema = z
  .string()
  .trim()
  .max(2_000_000)
  .refine(
    isValidLogoDataUrl,
    "Logo must be a PNG, JPEG, WebP, or GIF data URL no larger than 900KB.",
  );

export const clubThemeUpdateSchema = z
  .object({
    brandGold: colourSchema,
    brandCharcoal: colourSchema,
    brandDeep: colourSchema,
    brandRidge: colourSchema,
    brandMist: colourSchema,
    brandSnow: colourSchema,
    brandSafety: colourSchema,
    headingFontKey: z.enum(CLUB_THEME_FONT_KEYS),
    bodyFontKey: z.enum(CLUB_THEME_FONT_KEYS),
    logoDataUrl: z
      .union([logoDataUrlSchema, z.literal(""), z.null()])
      .transform((value) => value || null),
    rawCss: z.string().max(50_000).default("").transform(sanitiseRawCss),
    completeSetup: z.boolean().optional(),
  })
  .strict();

export type ClubThemeUpdateInput = z.infer<typeof clubThemeUpdateSchema>;
