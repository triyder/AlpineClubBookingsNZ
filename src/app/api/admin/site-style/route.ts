import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import {
  getClubThemeForAdmin,
  saveClubTheme,
} from "@/lib/club-theme";
import { clubThemeUpdateSchema } from "@/lib/club-theme-update-schema";
import { primeEmailPalette } from "@/lib/email-theme";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import {
  invalidatePublicLayoutConfig,
  PUBLIC_LAYOUT_CACHE_TAGS,
} from "@/lib/public-layout-cache";

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const theme = await getClubThemeForAdmin();
  return NextResponse.json({ theme });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = clubThemeUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // #2187: contrast is now guaranteed BY CONSTRUCTION — the three seeds feed the
  // vendored Radix generator, whose banded 12-step substrate clears the guarantee
  // sweep for every seed (see `@/lib/theme/guarantees`). A pathological pick is
  // adjusted, not rejected, so the old blocking contrast gate is gone; the wizard
  // surfaces the before/after adjustment as a disclosure instead.
  try {
    const theme = await saveClubTheme(parsed.data);
    invalidatePublicLayoutConfig(PUBLIC_LAYOUT_CACHE_TAGS.theme);
    revalidatePath("/(website)", "layout");
    revalidatePath("/(authenticated)", "layout");
    revalidatePath("/(admin)", "layout");
    // #1912: HTML emails resolve their brand colours from a cached copy of this
    // theme (see email-theme.ts). Re-prime that cache from the just-saved values
    // so booking/notification emails pick up the new colour scheme immediately
    // rather than only after the cache TTL lapses. Reuses the same persisted
    // ClubTheme source of truth and never throws.
    await primeEmailPalette();

    logAudit({
      action: "site_style.updated",
      memberId: guard.session.user.id,
      targetId: "default",
      category: "admin",
      severity: parsed.data.completeSetup ? "important" : "info",
      summary: parsed.data.completeSetup
        ? "Completed public site style setup"
        : "Updated public site style setup",
      metadata: {
        completed: Boolean(theme.completedAt),
        colours: {
          brandGold: theme.brandGold,
          brandDeep: theme.brandDeep,
          brandSafety: theme.brandSafety,
        },
        headingFontKey: theme.headingFontKey,
        bodyFontKey: theme.bodyFontKey,
        hasLogo: Boolean(theme.logoDataUrl),
      },
    });

    return NextResponse.json({ theme });
  } catch (error) {
    logger.error({ err: error }, "Failed to save site style settings");
    return NextResponse.json(
      { error: "Failed to save site style settings" },
      { status: 500 },
    );
  }
}
