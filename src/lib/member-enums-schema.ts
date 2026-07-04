import { z } from "zod";

import { GENDER_VALUES, TITLE_VALUES } from "@/lib/member-enums";

/**
 * Zod validators for the Member `gender`/`title` enums. These live apart from
 * `member-enums.ts` so that the base module (labels, option lists, formatters,
 * CSV parsers) stays free of any `zod` value import and is therefore safe to
 * bundle into `'use client'` components without dragging zod into the client
 * bundle. Only server-side code (request validation in the member services)
 * needs these schemas, so keep this module server-side. `GENDER_VALUES` /
 * `TITLE_VALUES` are plain constant tuples, so importing them here does not pull
 * zod back into the base module.
 */
export const genderEnum = z.enum(GENDER_VALUES);
export const titleEnum = z.enum(TITLE_VALUES);
