import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  EMAIL_TEMPLATE_KEY_SET,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";
import {
  renderEmailTemplatePreview,
  validateEmailTemplateContent,
} from "@/lib/email-message-renderer";
import { requireAdmin } from "@/lib/session-guards";

const previewSchema = z
  .object({
    templateName: z.string().trim().min(1),
    subject: z.string().trim().min(1).max(500),
    bodyText: z.string().trim().min(1).max(10000),
    // Fork #38: preview with the markdown-lite renderer when the editor will
    // save with it, so the admin sees exactly what a member receives.
    bodyMarkdown: z.boolean().optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  // Preview renders a template with sample data and performs no mutation, so a
  // support:view admin may use it (issue #1940). Explicit view keeps it usable
  // for viewers even though the method is POST (which would infer edit).
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (!EMAIL_TEMPLATE_KEY_SET.has(parsed.data.templateName)) {
    return NextResponse.json({ error: "Unknown email template" }, { status: 400 });
  }

  const validation = validateEmailTemplateContent({
    templateName: parsed.data.templateName,
    subject: parsed.data.subject,
    bodyText: parsed.data.bodyText,
  });
  if (!validation.valid) {
    return NextResponse.json(
      {
        error: "Invalid email template",
        issues: validation.issues,
        unknownTokens: validation.unknownTokens,
        disallowedTokens: validation.disallowedTokens,
        missingRequiredTokens: validation.missingRequiredTokens,
        signPrefixedTokens: validation.signPrefixedTokens,
        sensitiveSubjectTokens: validation.sensitiveSubjectTokens,
        unsafeLinks: validation.unsafeLinks,
        bracketAnnotations: validation.bracketAnnotations,
      },
      { status: 400 },
    );
  }

  const definition = getEmailTemplateDefinition(parsed.data.templateName);

  const preview = await renderEmailTemplatePreview({
    templateName: parsed.data.templateName,
    subject: parsed.data.subject,
    bodyText: parsed.data.bodyText,
    bodyMarkdown: parsed.data.bodyMarkdown,
    templateData: definition?.sampleData,
  });

  return NextResponse.json(preview);
}
