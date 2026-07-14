import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import {
  getClubThemeForAdmin,
  saveClubTheme,
} from "@/lib/club-theme";
import { getBlockingContrastWarnings } from "@/lib/club-theme-schema";
import { clubThemeUpdateSchema } from "@/lib/club-theme-update-schema";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const theme = await getClubThemeForAdmin();
  return NextResponse.json({ theme });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin();
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

  // Enforce WCAG AA text contrast on the configurable palette. The colour schema
  // only validates format, so without this an admin could save arbitrary colours
  // (hex or oklch, both measured) that render body/nav/button text unreadable on
  // the public site.
  const contrastWarnings = getBlockingContrastWarnings(parsed.data);
  if (contrastWarnings.length > 0) {
    return NextResponse.json(
      {
        error:
          "These colours don't meet the WCAG AA 4.5:1 minimum contrast for text. Adjust them before saving.",
        contrastWarnings,
      },
      { status: 400 },
    );
  }

  try {
    const theme = await saveClubTheme(parsed.data);
    revalidatePath("/(website)", "layout");
    revalidatePath("/(authenticated)", "layout");
    revalidatePath("/(admin)", "layout");

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
          brandCharcoal: theme.brandCharcoal,
          brandDeep: theme.brandDeep,
          brandRidge: theme.brandRidge,
          brandMist: theme.brandMist,
          brandSnow: theme.brandSnow,
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
