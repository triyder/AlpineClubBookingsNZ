import { expect, test } from "@playwright/test";
import { loginPersona, storageStatePath } from "./helpers/auth";
import {
  E2E_ADMIN,
  MEMBERSHIP_APPLICANT,
  MEMBERSHIP_APPLICATION_ID,
  NOMINATION_TOKEN_ONE,
  NOMINATION_TOKEN_TWO,
  NOMINATOR_TWO,
  PUBLIC_APPLICANT_EMAIL,
  WAITLISTER,
} from "./helpers/fixtures";
import { personas } from "./helpers/personas";

// High row (docs/END_TO_END_TEST_MATRIX.md): "Application, nomination reminders,
// admin refresh/replacement, approval, ..." — the public application →
// nominator confirmations → admin approval → member-exists journey.
//
// The nominator confirmation links are token URLs delivered by email, which is
// unconfigured in this stack. Since src/lib/action-tokens hashes tokens with a
// plain SHA-256 (no secret), the demo seed stores a PENDING_NOMINATORS
// application whose two nomination tokens have KNOWN raw values
// (e2e/helpers/fixtures.ts), so the two confirmation pages are driven for real
// without needing the email. The seeded nominators (Wanda, Nadia) both have
// complete, confirmed profiles so the onboarding modal never blocks their
// /nominations pages. The public submit is asserted separately against a fresh
// applicant (its own tokens are unrecoverable, by design).
test.describe.configure({ mode: "serial" });

test("the public membership application endpoint accepts a valid submission", async ({
  request,
}) => {
  const res = await request.post("/api/applications", {
    data: {
      applicantFirstName: "Penny",
      applicantLastName: "Public",
      applicantEmail: PUBLIC_APPLICANT_EMAIL,
      applicantDateOfBirth: "1990-02-02",
      nominator1Email: personas.booker.email, // alice — PAID, eligible
      nominator2Email: NOMINATOR_TWO.email, // nadia — PAID, eligible
    },
  });
  const body = await res.json().catch(() => ({}));
  expect(res.status(), JSON.stringify(body)).toBe(201);
  expect(body.status).toBe("PENDING_NOMINATORS");
});

test("nominator one agrees to the seeded nomination", async ({ browser }) => {
  // Confirmation requires being signed in as the specific nominator
  // (confirmNomination checks the id). Nominator1 is Wanda (complete profile →
  // no onboarding modal).
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginPersona(page, WAITLISTER.email);

  await page.goto(`/nominations/${NOMINATION_TOKEN_ONE}`);
  // The applicant name renders in a CardTitle (a div, not a heading role).
  await expect(
    page.getByText(new RegExp(`Nominate ${MEMBERSHIP_APPLICANT.firstName}`)),
  ).toBeVisible();
  await page.getByRole("button", { name: "Agree to Nominate" }).click();
  await expect(page.getByText(/confirmation has been recorded/i)).toBeVisible();

  await context.close();
});

test("nominator two agrees and the application moves to committee", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginPersona(page, NOMINATOR_TWO.email);

  await page.goto(`/nominations/${NOMINATION_TOKEN_TWO}`);
  await page.getByRole("button", { name: "Agree to Nominate" }).click();
  // The second confirmation completes both nominators → committee review.
  await expect(page.getByText(/moved to committee review/i)).toBeVisible();

  await context.close();
});

test("an admin approves the application and the applicant becomes a member", async ({
  browser,
}) => {
  // Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
  // per-spec login (#1779). This test drives the admin API directly, so it
  // needs the session cookies but no page.
  const context = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });

  // Approve via the review endpoint. Xero is absent, so skip the entrance-fee
  // invoice (a CREATE would only queue an outbox row that never sends).
  const approve = await context.request.put(
    `/api/admin/member-applications/${MEMBERSHIP_APPLICATION_ID}`,
    {
      data: {
        decision: "APPROVE",
        entranceFeeInvoiceDecision: {
          action: "SKIP",
          reason: "E2E: Xero not connected",
        },
      },
    },
  );
  const approveBody = await approve.json().catch(() => ({}));
  expect(approve.status(), JSON.stringify(approveBody)).toBe(200);
  expect(approveBody.status).toBe("APPROVED");

  // The approved applicant now exists as a member (admin member search finds
  // the new login by email).
  const members = await context.request.get(
    `/api/admin/members?search=${encodeURIComponent(MEMBERSHIP_APPLICANT.email)}`,
  );
  expect(members.ok(), `GET /api/admin/members (${members.status()})`).toBeTruthy();
  const membersText = await members.text();
  expect(
    membersText.includes(MEMBERSHIP_APPLICANT.email),
    "approved applicant should exist as a member",
  ).toBeTruthy();

  await context.close();
});
