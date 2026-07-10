import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdmin } from "@/lib/session-guards";
import { isFullAdmin } from "@/lib/access-roles";
import { MAX_BUNDLE_BYTES } from "./bundle";
import type { ImportMode, MatchResolution } from "./import-types";
import {
  CONFIG_TRANSFER_CATEGORIES,
  type ConfigTransferCategory,
} from "./manifest";

// Shared request plumbing for the config-transfer admin routes: one full-admin
// gate and one multipart-bundle reader, so the four routes cannot drift on
// authorisation or upload limits.

type Guarded =
  | { ok: true; memberId: string }
  | { ok: false; response: NextResponse };

/** Full-admin gate shared by every config-transfer route. */
export async function requireFullAdminForConfigTransfer(): Promise<Guarded> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, response: guard.response };
  if (!isFullAdmin({ accessRoles: guard.session.user.accessRoles })) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Full admin access is required." },
        { status: 403 },
      ),
    };
  }
  return { ok: true, memberId: guard.session.user.id };
}

const resolutionsSchema = z.array(
  z.object({
    entity: z.string().min(1).max(64),
    key: z.string().min(1).max(512),
    matchId: z.string().min(1).max(64),
  }),
);

const categoriesSchema = z.array(z.enum(CONFIG_TRANSFER_CATEGORIES));

export interface BundleUpload {
  bytes: Uint8Array;
  mode: ImportMode;
  /** Present only when the client sent a categories selection. */
  selectedCategories?: ConfigTransferCategory[];
  resolutions: MatchResolution[];
  expectedFingerprint: string | null;
}

type UploadResult =
  | { ok: true; upload: BundleUpload }
  | { ok: false; response: NextResponse };

/**
 * Read the multipart bundle upload shared by plan/apply/reseal: the 'bundle'
 * file (size-capped), the write mode, and the optional categories selection,
 * resolutions, and dry-run fingerprint.
 */
export async function readBundleUpload(request: Request): Promise<UploadResult> {
  const bad = (error: string, status = 400): UploadResult => ({
    ok: false,
    response: NextResponse.json({ error }, { status }),
  });
  try {
    const form = await request.formData();
    const file = form.get("bundle");
    if (!(file instanceof File)) return bad("Missing 'bundle' file.");
    if (file.size > MAX_BUNDLE_BYTES) return bad("Bundle is too large.", 413);

    const mode: ImportMode = form.get("mode") === "overwrite" ? "overwrite" : "merge";

    let selectedCategories: ConfigTransferCategory[] | undefined;
    const categoriesRaw = form.get("categories");
    if (typeof categoriesRaw === "string" && categoriesRaw !== "") {
      const parsed = categoriesSchema.safeParse(JSON.parse(categoriesRaw));
      if (!parsed.success) return bad("Invalid 'categories' selection.");
      selectedCategories = parsed.data;
    }

    let resolutions: MatchResolution[] = [];
    const resolutionsRaw = form.get("resolutions");
    if (typeof resolutionsRaw === "string" && resolutionsRaw !== "") {
      const parsed = resolutionsSchema.safeParse(JSON.parse(resolutionsRaw));
      if (!parsed.success) return bad("Invalid 'resolutions'.");
      resolutions = parsed.data;
    }

    const fingerprint = form.get("expectedFingerprint");
    return {
      ok: true,
      upload: {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mode,
        selectedCategories,
        resolutions,
        expectedFingerprint:
          typeof fingerprint === "string" && fingerprint.length > 0
            ? fingerprint
            : null,
      },
    };
  } catch {
    return bad("Could not read the uploaded bundle.");
  }
}
