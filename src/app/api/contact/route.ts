import { NextResponse } from "next/server";
import { z } from "zod";
import { sendEmail } from "@/lib/email";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { escapeHtml } from "@/lib/email-templates";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { CLUB_CONTACT_EMAIL } from "@/config/club-identity";

const noEmailHeaderCrlf = (value: string) => !/[\r\n]/.test(value);

const contactSchema = z.object({
  name: z.string().min(1, "Name is required").max(200).refine(
    noEmailHeaderCrlf,
    "Name cannot contain line breaks"
  ),
  email: z.string().email("Invalid email address").max(200),
  message: z.string().min(1, "Message is required").max(5000),
  recipient: z.string().max(50).refine(
    noEmailHeaderCrlf,
    "Recipient cannot contain line breaks"
  ).optional(),
});

const CONTACT_EMAIL =
  process.env.CONTACT_EMAIL || CLUB_CONTACT_EMAIL;

async function resolveCommitteeRecipient(recipient: string) {
  return prisma.committeeAssignment.findFirst({
    where: {
      id: recipient,
      isActive: true,
      published: true,
      contactable: true,
      committeeRole: { isActive: true },
      member: { active: true },
    },
    select: {
      contactEmailMode: true,
      contactEmailOverride: true,
      committeeRole: { select: { name: true, contactEmail: true } },
      member: { select: { email: true } },
    },
  });
}

function buildRecipientLabel(roleName: string) {
  const normalized = roleName.replace(/[\r\n]+/g, " ").trim();
  return normalized ? ` (to ${normalized})` : "";
}

export async function POST(request: Request) {
  const rateLimited = await applyRateLimit(rateLimiters.contact, request);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  try {
    const result = contactSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Invalid input", details: result.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { name, email, message, recipient } = result.data;

    let toEmail = CONTACT_EMAIL;
    let recipientLabel = "";
    let logRecipient = CONTACT_EMAIL;

    if (recipient) {
      const committeeAssignment = await resolveCommitteeRecipient(recipient);

      if (committeeAssignment) {
        recipientLabel = buildRecipientLabel(
          committeeAssignment.committeeRole.name,
        );
        const roleEmail =
          committeeAssignment.committeeRole.contactEmail?.trim() || null;
        const memberEmail = committeeAssignment.member.email?.trim() || null;
        const overrideEmail =
          committeeAssignment.contactEmailOverride?.trim() || null;
        let committeeRecipientEmail: string | null;
        switch (committeeAssignment.contactEmailMode) {
          case "CUSTOM":
            committeeRecipientEmail = overrideEmail;
            break;
          case "MEMBER":
            committeeRecipientEmail = memberEmail;
            break;
          default:
            committeeRecipientEmail = roleEmail; // ROLE
            break;
        }
        if (!committeeRecipientEmail) {
          // Selected mode's address is missing/deactivated — fall back
          // ROLE -> member so public contact mail is never black-holed.
          committeeRecipientEmail = roleEmail || memberEmail;
          logger.warn(
            { assignmentId: recipient, mode: committeeAssignment.contactEmailMode },
            "Committee contact email fell back to role/member address",
          );
        }
        if (committeeRecipientEmail) {
          toEmail = committeeRecipientEmail;
          logRecipient = `committee-contact:${recipient}`;
        }
      }
    }

    await sendEmail({
      to: toEmail,
      subject: `Website Contact${recipientLabel}: ${escapeHtml(name)}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1e293b;">New Contact Form Submission</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; font-weight: bold; color: #475569; vertical-align: top; width: 80px;">Name:</td>
              <td style="padding: 8px 0; color: #1e293b;">${escapeHtml(name)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-weight: bold; color: #475569; vertical-align: top;">Email:</td>
              <td style="padding: 8px 0; color: #1e293b;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-weight: bold; color: #475569; vertical-align: top;">Message:</td>
              <td style="padding: 8px 0; color: #1e293b; white-space: pre-wrap;">${escapeHtml(message)}</td>
            </tr>
          </table>
        </div>
      `,
      templateName: "website-contact",
      templateData: {
        recipientLabel,
        name,
        email,
        message,
      },
      logRecipient,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to send message. Please try again later." },
      { status: 500 }
    );
  }
}
