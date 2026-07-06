// ---------------------------------------------------------------------------
// DEMO DATA SEED  —  `npm run db:seed:demo`
//
// Populates a LOCAL demo database with rich, made-up data so every feature can
// be shown off: members across every role/age-tier/lifecycle state, family
// groups, subscriptions (every status), applications (every status), bookings
// (every BookingStatus), payments (every PaymentStatus, both sources, refunds,
// recovery ops), promo codes (every type + a work-party internal promo),
// account credits (every CreditType), modifications/change-requests, refund
// requests, cancellation + lifecycle + deletion requests, bed allocations,
// chores, hut-leader rosters, issue reports, inductions (every status) and
// public booking requests (every status, GENERAL + SCHOOL).
//
// SAFE TO RE-RUN: it first deletes all demo + transactional rows, then rebuilds
// them. The base first-run seed data (seasons, rates, policies, admin/lodge
// accounts, page content, induction template, club theme) is preserved.
//
// SAFETY GUARD: refuses unless explicitly opted in, non-production, local,
// and connected to an empty or demo-only Member table.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { type AgeTier, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ensureAccessRoleDefinitions } from "../src/lib/access-role-definitions";
import { assertDemoSeedMayRun, DEMO_SEED_DOMAIN } from "../src/lib/demo-seed-guard";
import {
  ensureMemberAccessRoles,
  ensureMemberAccessRolesFromCompatibilityFields,
} from "../src/lib/member-access-role-writes";
import { backfillCurrentSeasonMembershipAssignments } from "../src/lib/membership-types";
import { createPrismaPgAdapter } from "../src/lib/prisma-adapter";
import {
  E2E_ADMIN,
  EMAIL_2FA_ENROLLEE,
  IB_BOOKING_ID,
  IB_WINDOW,
  LODGE_FILL_OWNER,
  MEMBERSHIP_APPLICANT,
  MEMBERSHIP_APPLICATION_ID,
  NOMINATION_TOKEN_ONE,
  NOMINATION_TOKEN_TWO,
  NOMINATOR_TWO,
  ROLE_PERSONAS,
  WAITLIST_FILL_GUEST_COUNT,
  WAITLIST_FULL_WINDOW,
  WAITLIST_OFFER_BOOKING_ID,
  WAITLIST_OFFER_WINDOW,
  WAITLISTER,
} from "./e2e-fixtures";

const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });

const DEMO_DOMAIN = DEMO_SEED_DOMAIN;
const DEMO_PASSWORD = process.env.DEMO_SEED_PASSWORD ?? "demo1234";
const PWHASH = bcrypt.hashSync(DEMO_PASSWORD, 12);
const SEASON_YEAR = 2026;

// Date-only helper (schema uses @db.Date for most date columns).
function d(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}
// Nights actually slept = [checkIn, checkOut) — checkout day is not a night.
function nightsBetween(checkIn: string, checkOut: string): string[] {
  const out: string[] = [];
  const cur = d(checkIn);
  const end = d(checkOut);
  while (cur < end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

async function assertDemoSeedSafety() {
  await assertDemoSeedMayRun({
    env: process.env,
    countNonDemoMembers: () =>
      prisma.member.count({
        where: {
          NOT: {
            email: {
              endsWith: `@${DEMO_DOMAIN}`,
            },
          },
        },
      }),
  });
}

// ---------------------------------------------------------------------------
// Cleanup — delete demo + transactional rows in FK-safe (child→parent) order.
// ---------------------------------------------------------------------------
async function cleanup() {
  console.log("Clearing previous demo / transactional data...");
  await prisma.bedAllocation.deleteMany();
  await prisma.guestChoreToken.deleteMany();
  await prisma.choreAssignment.deleteMany();
  await prisma.promoRedemptionGuestTarget.deleteMany();
  await prisma.promoRedemptionAllocation.deleteMany();
  await prisma.bookingGuestNight.deleteMany();
  await prisma.bookingGuest.deleteMany();
  await prisma.paymentRefund.deleteMany();
  await prisma.paymentRecoveryOperation.deleteMany();
  await prisma.paymentTransaction.deleteMany();
  await prisma.refundRequest.deleteMany();
  await prisma.bookingChangeRequest.deleteMany();
  await prisma.memberCredit.deleteMany();
  await prisma.bookingModification.deleteMany();
  await prisma.adminCreditAdjustmentRequest.deleteMany();
  await prisma.promoRedemption.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.paymentLink.deleteMany();
  await prisma.bookingEvent.deleteMany();
  await prisma.bookingRequest.deleteMany();
  await prisma.booking.updateMany({ data: { parentBookingId: null } });
  await prisma.booking.deleteMany();
  await prisma.workPartyEvent.deleteMany();
  await prisma.promoCodeAssignment.deleteMany();
  await prisma.promoCode.deleteMany();
  await prisma.lodgeBed.deleteMany();
  await prisma.lodgeRoom.deleteMany();
  await prisma.memberInductionItemResult.deleteMany();
  await prisma.memberInductionSignOff.deleteMany();
  await prisma.memberInductionAssignedSigner.deleteMany();
  await prisma.memberInduction.deleteMany();
  await prisma.nominationToken.deleteMany();
  await prisma.memberApplication.deleteMany();
  await prisma.membershipCancellationRequestParticipant.deleteMany();
  await prisma.membershipCancellationRequest.deleteMany();
  await prisma.memberLifecycleActionRequest.deleteMany();
  await prisma.familyGroupJoinRequest.deleteMany();
  await prisma.familyGroupMember.deleteMany();
  await prisma.familyGroup.deleteMany();
  await prisma.hutLeaderAssignment.deleteMany();
  await prisma.issueReport.deleteMany();
  await prisma.deletionRequest.deleteMany();

  // Null demo members' self-references, then delete them. Cascade relations
  // (subscriptions, notification prefs, family memberships) clear themselves.
  await prisma.member.updateMany({
    where: { email: { endsWith: `@${DEMO_DOMAIN}` } },
    data: {
      parentMemberId: null,
      secondaryParentId: null,
      inheritEmailFromId: null,
      detailsConfirmedByMemberId: null,
      cancelledViaRequestId: null,
      archivedViaLifecycleActionRequestId: null,
      familyGroupId: null,
    },
  });
  await prisma.member.deleteMany({
    where: { email: { endsWith: `@${DEMO_DOMAIN}` } },
  });
}

type MemberRec = Awaited<ReturnType<typeof prisma.member.create>>;

async function makeMember(
  local: string,
  firstName: string,
  lastName: string,
  extra: Record<string, unknown> = {},
): Promise<MemberRec> {
  const member = await prisma.member.create({
    data: {
      email: `${local}@${DEMO_DOMAIN}`,
      passwordHash: PWHASH,
      firstName,
      lastName,
      role: "USER",
      ageTier: "ADULT",
      active: true,
      canLogin: true,
      emailVerified: true,
      forcePasswordChange: false,
      joinedDate: d("2024-05-01"),
      ...extra,
    },
  });
  await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
    memberId: member.id,
    role: member.role,
    financeAccessLevel: member.financeAccessLevel,
    canLogin: member.canLogin,
  });
  return member;
}

async function addGuest(
  bookingId: string,
  g: {
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
    isMember?: boolean;
    memberId?: string | null;
    arrivedAt?: Date | null;
    departedAt?: Date | null;
  },
  checkIn: string,
  checkOut: string,
  nightlyCents: number,
) {
  const nights = nightsBetween(checkIn, checkOut);
  const guest = await prisma.bookingGuest.create({
    data: {
      bookingId,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember ?? false,
      memberId: g.memberId ?? null,
      stayStart: d(checkIn),
      stayEnd: d(checkOut),
      priceCents: nightlyCents * nights.length,
      arrivedAt: g.arrivedAt ?? null,
      departedAt: g.departedAt ?? null,
    },
  });
  for (const night of nights) {
    await prisma.bookingGuestNight.create({
      data: { bookingGuestId: guest.id, stayDate: d(night), priceCents: nightlyCents },
    });
  }
  return guest;
}

async function main() {
  await assertDemoSeedSafety();
  await cleanup();
  console.log("Building demo data...");

  // Demo data expects the seeded access-role definitions to exist.
  await ensureAccessRoleDefinitions(prisma);

  // Need an admin to act as reviewer/approver on requests.
  const admin =
    (await prisma.member.findFirst({ where: { role: "ADMIN" } })) ??
    (await makeMember("demo-admin", "Demo", "Admin", { role: "ADMIN" }));
  await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
    memberId: admin.id,
    role: admin.role,
    financeAccessLevel: admin.financeAccessLevel,
    canLogin: admin.canLogin,
  });

  // -------------------------------------------------------------------------
  // Members — every role, age tier, and lifecycle state.
  // -------------------------------------------------------------------------
  const alice = await makeMember("alice", "Alice", "Anderson", {
    financeAccessLevel: "MANAGER",
    requiresInduction: true,
    phoneCountryCode: "64",
    phoneAreaCode: "27",
    phoneNumber: "5551001",
    streetAddressLine1: "12 Mountain Rd",
    streetCity: "Alpine Village",
    streetRegion: "Waikato",
    streetPostalCode: "3420",
    streetCountry: "New Zealand",
  });
  const bob = await makeMember("bob", "Bob", "Brown", {
    financeAccessLevel: "VIEWER",
  });
  const carol = await makeMember("carol", "Carol", "Clark");
  const dave = await makeMember("dave", "Dave", "Davis");
  const erin = await makeMember("erin", "Erin", "Evans");
  const frank = await makeMember("frank", "Frank", "Foster");
  const grace = await makeMember("grace", "Grace", "Green");
  const heidi = await makeMember("heidi", "Heidi", "Hill");
  const ivan = await makeMember("ivan", "Ivan", "Ivanov");
  const judy = await makeMember("judy", "Judy", "Jones");
  const ken = await makeMember("ken", "Ken", "King");
  const mallory = await makeMember("mallory", "Mallory", "Moore");
  const lars = await makeMember("lars", "Lars", "Larsen");
  const pat = await makeMember("pat", "Pat", "Powell");

  // Lifecycle states
  const arnold = await makeMember("arnold", "Arnold", "Archer", {
    archivedAt: d("2026-03-01"),
    archivedReason: "Moved overseas",
    active: false,
  });
  const carmen = await makeMember("carmen", "Carmen", "Cole", {
    cancelledAt: d("2026-02-15"),
    cancelledReason: "Membership cancelled",
    active: false,
  });
  await makeMember("ian", "Ian", "Inactive", { active: false });

  // Dependents (non-login) covering INFANT / CHILD / YOUTH
  await prisma.member.create({
    data: {
      email: `alice@${DEMO_DOMAIN}`,
      passwordHash: PWHASH,
      firstName: "Quinn",
      lastName: "Anderson",
      role: "USER",
      ageTier: "CHILD",
      canLogin: false,
      emailVerified: false,
      inheritParentEmail: true,
      parentMemberId: alice.id,
      dateOfBirth: d("2017-04-10"),
    },
  });
  const sam = await prisma.member.create({
    data: {
      email: `pat@${DEMO_DOMAIN}`,
      passwordHash: PWHASH,
      firstName: "Sam",
      lastName: "Powell",
      role: "USER",
      ageTier: "YOUTH",
      canLogin: false,
      inheritParentEmail: true,
      parentMemberId: pat.id,
      dateOfBirth: d("2010-08-22"),
    },
  });
  await prisma.member.create({
    data: {
      email: `pat@${DEMO_DOMAIN}`,
      passwordHash: PWHASH,
      firstName: "Baby",
      lastName: "Powell",
      role: "USER",
      ageTier: "INFANT",
      canLogin: false,
      inheritParentEmail: true,
      parentMemberId: pat.id,
      dateOfBirth: d("2025-11-02"),
    },
  });
  console.log("Members seeded");

  const membershipAssignmentBackfill =
    await backfillCurrentSeasonMembershipAssignments(prisma, SEASON_YEAR);
  console.log(
    `Membership types seeded; demo assignments created: ${membershipAssignmentBackfill.createdCount}`,
  );

  // -------------------------------------------------------------------------
  // Subscriptions — every SubscriptionStatus.
  // -------------------------------------------------------------------------
  const subs: Array<[MemberRec, "NOT_INVOICED" | "NOT_REQUIRED" | "UNPAID" | "PAID" | "OVERDUE"]> = [
    [alice, "PAID"],
    [bob, "UNPAID"],
    [carol, "OVERDUE"],
    [dave, "NOT_INVOICED"],
    [erin, "NOT_REQUIRED"],
  ];
  for (const [m, status] of subs) {
    await prisma.memberSubscription.create({
      data: {
        memberId: m.id,
        seasonYear: SEASON_YEAR,
        status,
        paidAt: status === "PAID" ? d("2026-01-20") : null,
        xeroInvoiceNumber: status === "NOT_INVOICED" ? null : `INV-${1000 + Math.floor(Math.random() * 9000)}`,
      },
    });
  }
  console.log("Subscriptions seeded (all statuses)");

  // -------------------------------------------------------------------------
  // Member applications — every ApplicationStatus.
  // -------------------------------------------------------------------------
  const appStatuses: Array<"PENDING_NOMINATORS" | "PENDING_ADMIN" | "APPROVED" | "REJECTED"> = [
    "PENDING_NOMINATORS",
    "PENDING_ADMIN",
    "APPROVED",
    "REJECTED",
  ];
  for (const [i, status] of appStatuses.entries()) {
    await prisma.memberApplication.create({
      data: {
        applicantFirstName: ["Nina", "Olive", "Peter", "Rita"][i],
        applicantLastName: ["Newman", "Owens", "Price", "Reed"][i],
        applicantEmail: `applicant${i}@${DEMO_DOMAIN}`,
        applicantDateOfBirth: d("1990-06-15"),
        nominator1Email: alice.email,
        nominator2Email: bob.email,
        nominator1Id: status === "PENDING_NOMINATORS" ? null : alice.id,
        nominator2Id: status === "PENDING_NOMINATORS" ? null : bob.id,
        nominator1ConfirmedAt: status === "PENDING_NOMINATORS" ? null : d("2026-05-01"),
        nominator2ConfirmedAt: status === "PENDING_NOMINATORS" ? null : d("2026-05-02"),
        status,
        adminNotes: status === "REJECTED" ? "Insufficient nominator history." : null,
        reviewedBy: status === "APPROVED" || status === "REJECTED" ? admin.id : null,
        reviewedAt: status === "APPROVED" || status === "REJECTED" ? d("2026-05-10") : null,
      },
    });
  }
  console.log("Applications seeded (all statuses)");

  // -------------------------------------------------------------------------
  // Lodge rooms + beds.
  // -------------------------------------------------------------------------
  const roomA = await prisma.lodgeRoom.create({ data: { name: "Bunk Room A", sortOrder: 1 } });
  const roomB = await prisma.lodgeRoom.create({ data: { name: "Bunk Room B", sortOrder: 2 } });
  const roomFamily = await prisma.lodgeRoom.create({ data: { name: "Family Room", sortOrder: 3 } });
  const bedsA = [];
  for (let i = 1; i <= 6; i++) {
    bedsA.push(await prisma.lodgeBed.create({ data: { roomId: roomA.id, name: `A${i}`, sortOrder: i } }));
  }
  for (let i = 1; i <= 4; i++) {
    await prisma.lodgeBed.create({ data: { roomId: roomB.id, name: `B${i}`, sortOrder: i } });
  }
  for (let i = 1; i <= 4; i++) {
    await prisma.lodgeBed.create({ data: { roomId: roomFamily.id, name: `F${i}`, sortOrder: i } });
  }
  console.log("Lodge rooms + beds seeded");

  // -------------------------------------------------------------------------
  // Promo codes — every PromoCodeType (+ a work-party internal promo).
  // -------------------------------------------------------------------------
  await prisma.promoCode.create({
    data: { code: "WINTER15", description: "15% off winter stays", type: "PERCENTAGE", percentOff: 15, validUntil: d("2026-09-30") },
  });
  const promoFixed = await prisma.promoCode.create({
    data: { code: "MATE20", description: "$20 off per guest", type: "FIXED_AMOUNT", valueCents: 2000, maxUsesPerMember: 1 },
  });
  const promoFreeNights = await prisma.promoCode.create({
    data: { code: "STAY3GET1", description: "1 free night per guest", type: "FREE_NIGHTS", freeNightsPerIndividual: 1, lifetimeFreeNightsCap: 4 },
  });
  await prisma.promoCode.create({
    data: { code: "FLAT50", description: "Flat $50/night", type: "FIXED_NIGHTLY_PRICE", fixedNightlyPriceCents: 5000, fixedNightlyMode: "SET_PRICE" },
  });
  // Work-party internal promo (auto-applied, hidden from listings).
  const workPromo = await prisma.promoCode.create({
    data: { code: "WORKPARTY-JUL26", description: "July working bee — free nights", type: "PERCENTAGE", percentOff: 100, internal: true },
  });
  await prisma.workPartyEvent.create({
    data: { name: "July Working Bee 2026", description: "Track clearing + firewood", startDate: d("2026-07-12"), endDate: d("2026-07-14"), discountPercent: 100, promoCodeId: workPromo.id },
  });
  // Assign a personal promo to a member.
  await prisma.promoCodeAssignment.create({ data: { promoCodeId: promoFixed.id, memberId: bob.id } });
  console.log("Promo codes seeded (all types + work party)");

  // -------------------------------------------------------------------------
  // Bookings — one per BookingStatus, with guests, nights, events, payments.
  // -------------------------------------------------------------------------
  const NIGHTLY = 4500; // $45/night member rate (demo)

  // helper to create a booking shell
  async function makeBooking(
    member: MemberRec,
    status: string,
    checkIn: string,
    checkOut: string,
    over: Record<string, unknown> = {},
  ) {
    const nights = nightsBetween(checkIn, checkOut).length;
    const total = NIGHTLY * nights;
    return prisma.booking.create({
      data: {
        memberId: member.id,
        checkIn: d(checkIn),
        checkOut: d(checkOut),
        status: status as never,
        totalPriceCents: total,
        finalPriceCents: total,
        ...over,
      },
    });
  }

  // 1. DRAFT
  const bDraft = await makeBooking(alice, "DRAFT", "2026-07-10", "2026-07-12", {
    draftExpiresAt: d("2026-07-09"),
  });
  await addGuest(bDraft.id, { firstName: "Alice", lastName: "Anderson", ageTier: "ADULT", isMember: true, memberId: alice.id }, "2026-07-10", "2026-07-12", NIGHTLY);
  await prisma.bookingEvent.create({ data: { bookingId: bDraft.id, type: "CREATED", actorMemberId: alice.id } });

  // 2. PENDING (payment PENDING)
  const bPending = await makeBooking(bob, "PENDING", "2026-07-15", "2026-07-17");
  await addGuest(bPending.id, { firstName: "Bob", lastName: "Brown", ageTier: "ADULT", isMember: true, memberId: bob.id }, "2026-07-15", "2026-07-17", NIGHTLY);
  await prisma.payment.create({ data: { bookingId: bPending.id, amountCents: bPending.finalPriceCents, source: "STRIPE", status: "PENDING", stripePaymentIntentId: "pi_demo_pending" } });
  await prisma.bookingEvent.create({ data: { bookingId: bPending.id, type: "CREATED", actorMemberId: bob.id } });

  // 3. PAYMENT_PENDING (payment PROCESSING)
  const bPayPending = await makeBooking(carol, "PAYMENT_PENDING", "2026-07-20", "2026-07-23");
  await addGuest(bPayPending.id, { firstName: "Carol", lastName: "Clark", ageTier: "ADULT", isMember: true, memberId: carol.id }, "2026-07-20", "2026-07-23", NIGHTLY);
  await prisma.payment.create({ data: { bookingId: bPayPending.id, amountCents: bPayPending.finalPriceCents, source: "STRIPE", status: "PROCESSING", stripePaymentIntentId: "pi_demo_processing" } });

  // 4. CONFIRMED (payment SUCCEEDED via INTERNET_BANKING) + bed allocations + modification
  const bConfirmed = await makeBooking(dave, "CONFIRMED", "2026-06-25", "2026-06-28");
  const daveGuest = await addGuest(bConfirmed.id, { firstName: "Dave", lastName: "Davis", ageTier: "ADULT", isMember: true, memberId: dave.id }, "2026-06-25", "2026-06-28", NIGHTLY);
  const confirmedPayment = await prisma.payment.create({ data: { bookingId: bConfirmed.id, amountCents: bConfirmed.finalPriceCents, source: "INTERNET_BANKING", reference: "BANK-REF-7781", status: "SUCCEEDED", xeroInvoiceNumber: "INV-2201" } });
  await prisma.paymentTransaction.create({ data: { paymentId: confirmedPayment.id, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: bConfirmed.finalPriceCents, status: "SUCCEEDED", reference: "BANK-REF-7781" } });
  for (const [i, night] of nightsBetween("2026-06-25", "2026-06-28").entries()) {
    await prisma.bedAllocation.create({ data: { bookingId: bConfirmed.id, bookingGuestId: daveGuest.id, roomId: roomA.id, bedId: bedsA[i].id, stayDate: d(night), source: "AUTO" } });
  }
  await prisma.bookingEvent.create({ data: { bookingId: bConfirmed.id, type: "CREATED", actorMemberId: dave.id } });
  await prisma.bookingEvent.create({ data: { bookingId: bConfirmed.id, type: "MEMBER_PAID", actorMemberId: dave.id, amountCents: bConfirmed.finalPriceCents } });
  // A booking modification (date change) + resulting credit + recovery op.
  const daveMod = await prisma.bookingModification.create({
    data: {
      bookingId: bConfirmed.id,
      memberId: dave.id,
      modificationType: "DATE_CHANGE",
      previousData: { checkIn: "2026-06-24", checkOut: "2026-06-28" },
      newData: { checkIn: "2026-06-25", checkOut: "2026-06-28" },
      priceDiffCents: -NIGHTLY,
      changeFeeCents: 0,
    },
  });
  await prisma.paymentRecoveryOperation.create({
    data: {
      type: "REFUND_BOOKING_MODIFICATION",
      status: "SUCCEEDED",
      bookingId: bConfirmed.id,
      paymentId: confirmedPayment.id,
      paymentIntentId: "pi_demo_confirmed",
      amountCents: NIGHTLY,
      idempotencyKey: "demo-recovery-mod-1",
      succeededAt: d("2026-06-20"),
    },
  });

  // 5. PAID (payment SUCCEEDED via STRIPE + ADDITIONAL txn + FREE_NIGHTS promo)
  const bPaid = await prisma.booking.create({
    data: {
      memberId: erin.id,
      checkIn: d("2026-07-03"),
      checkOut: d("2026-07-06"),
      status: "PAID",
      totalPriceCents: NIGHTLY * 3,
      promoAdjustmentCents: NIGHTLY,
      finalPriceCents: NIGHTLY * 2,
    },
  });
  const erinGuest = await addGuest(bPaid.id, { firstName: "Erin", lastName: "Evans", ageTier: "ADULT", isMember: true, memberId: erin.id }, "2026-07-03", "2026-07-06", NIGHTLY);
  const paidPayment = await prisma.payment.create({ data: { bookingId: bPaid.id, amountCents: bPaid.finalPriceCents, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_demo_paid", stripeCustomerId: "cus_demo_erin", additionalPaymentIntentId: "pi_demo_paid_add", additionalAmountCents: 1500, additionalPaymentStatus: "SUCCEEDED" } });
  await prisma.paymentTransaction.create({ data: { paymentId: paidPayment.id, kind: "PRIMARY", source: "STRIPE", amountCents: bPaid.finalPriceCents, status: "SUCCEEDED", stripePaymentIntentId: "pi_demo_paid" } });
  await prisma.paymentTransaction.create({ data: { paymentId: paidPayment.id, kind: "ADDITIONAL", source: "STRIPE", amountCents: 1500, status: "SUCCEEDED", stripePaymentIntentId: "pi_demo_paid_add", reason: "Added extra guest night" } });
  // The PromoRedemption_sync_allocation_insert trigger creates the matching
  // PromoRedemptionAllocation row; inserting it here too violates the
  // (promoRedemptionId, memberId) unique constraint.
  const erinRedemption = await prisma.promoRedemption.create({ data: { promoCodeId: promoFreeNights.id, bookingId: bPaid.id, memberId: erin.id, discountCents: NIGHTLY, freeNightsUsed: 1, eligibleGuestCount: 1 } });
  await prisma.promoRedemptionGuestTarget.create({ data: { promoRedemptionId: erinRedemption.id, bookingId: bPaid.id, bookingGuestId: erinGuest.id } });
  await prisma.promoCode.update({ where: { id: promoFreeNights.id }, data: { currentRedemptions: 1 } });
  await prisma.bookingEvent.create({ data: { bookingId: bPaid.id, type: "MEMBER_PAID", actorMemberId: erin.id, amountCents: bPaid.finalPriceCents } });

  // 6. BUMPED (payment REFUNDED + refund + recovery op)
  const bBumped = await makeBooking(frank, "BUMPED", "2026-07-08", "2026-07-10");
  await addGuest(bBumped.id, { firstName: "Frank", lastName: "Foster", ageTier: "ADULT", isMember: true, memberId: frank.id }, "2026-07-08", "2026-07-10", NIGHTLY);
  const bumpedPayment = await prisma.payment.create({ data: { bookingId: bBumped.id, amountCents: bBumped.finalPriceCents, source: "STRIPE", status: "REFUNDED", refundedAmountCents: bBumped.finalPriceCents, stripePaymentIntentId: "pi_demo_bumped" } });
  await prisma.paymentRefund.create({ data: { paymentId: bumpedPayment.id, stripeRefundId: "re_demo_bumped", amountCents: bBumped.finalPriceCents, status: "succeeded", reason: "Bumped by capacity", stripeCreatedAt: d("2026-06-30") } });
  await prisma.paymentRecoveryOperation.create({ data: { type: "REFUND_SUPERSEDED_PAYMENT", status: "PROCESSING", bookingId: bBumped.id, paymentId: bumpedPayment.id, paymentIntentId: "pi_demo_bumped", amountCents: bBumped.finalPriceCents, idempotencyKey: "demo-recovery-bump-1", attempts: 1 } });
  await prisma.bookingEvent.create({ data: { bookingId: bBumped.id, type: "BUMPED", actorMemberId: admin.id, reason: "Capacity reached" } });
  await prisma.bookingEvent.create({ data: { bookingId: bBumped.id, type: "REFUNDED", amountCents: bBumped.finalPriceCents } });

  // 7. CANCELLED (payment PARTIALLY_REFUNDED + partial refund + cancellation credit)
  const bCancelled = await makeBooking(grace, "CANCELLED", "2026-07-25", "2026-07-28");
  await addGuest(bCancelled.id, { firstName: "Grace", lastName: "Green", ageTier: "ADULT", isMember: true, memberId: grace.id }, "2026-07-25", "2026-07-28", NIGHTLY);
  const cancelledPayment = await prisma.payment.create({ data: { bookingId: bCancelled.id, amountCents: bCancelled.finalPriceCents, source: "STRIPE", status: "PARTIALLY_REFUNDED", refundedAmountCents: Math.round(bCancelled.finalPriceCents / 2), stripePaymentIntentId: "pi_demo_cancelled" } });
  await prisma.paymentRefund.create({ data: { paymentId: cancelledPayment.id, stripeRefundId: "re_demo_cancelled", amountCents: Math.round(bCancelled.finalPriceCents / 2), status: "succeeded", reason: "50% cancellation refund" } });
  const cancellationCredit = await prisma.memberCredit.create({ data: { memberId: grace.id, amountCents: Math.round(bCancelled.finalPriceCents / 2), type: "CANCELLATION_REFUND", description: "50% credit from cancelled July booking", sourceBookingId: bCancelled.id } });
  await prisma.bookingEvent.create({ data: { bookingId: bCancelled.id, type: "CANCELLED", actorMemberId: grace.id, reason: "Change of plans" } });
  await prisma.bookingEvent.create({ data: { bookingId: bCancelled.id, type: "CREDITED", amountCents: cancellationCredit.amountCents } });

  // 8. COMPLETED (past, payment SUCCEEDED, guests arrived/departed, chores done)
  const bCompleted = await makeBooking(heidi, "COMPLETED", "2026-06-05", "2026-06-08");
  const heidiGuest = await addGuest(bCompleted.id, { firstName: "Heidi", lastName: "Hill", ageTier: "ADULT", isMember: true, memberId: heidi.id, arrivedAt: d("2026-06-05"), departedAt: d("2026-06-08") }, "2026-06-05", "2026-06-08", NIGHTLY);
  await prisma.payment.create({ data: { bookingId: bCompleted.id, amountCents: bCompleted.finalPriceCents, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_demo_completed", xeroInvoiceNumber: "INV-2180" } });
  await prisma.bookingEvent.create({ data: { bookingId: bCompleted.id, type: "MEMBER_PAID", actorMemberId: heidi.id, amountCents: bCompleted.finalPriceCents } });

  // 9. WAITLISTED
  const bWaitlisted = await makeBooking(ivan, "WAITLISTED", "2026-08-01", "2026-08-03", { waitlistPosition: 2 });
  await addGuest(bWaitlisted.id, { firstName: "Ivan", lastName: "Ivanov", ageTier: "ADULT", isMember: true, memberId: ivan.id }, "2026-08-01", "2026-08-03", NIGHTLY);

  // 10. WAITLIST_OFFERED
  const bWaitlistOffered = await makeBooking(judy, "WAITLIST_OFFERED", "2026-08-01", "2026-08-03", { waitlistPosition: 1, waitlistOfferedAt: d("2026-06-18"), waitlistOfferExpiresAt: d("2026-06-21") });
  await addGuest(bWaitlistOffered.id, { firstName: "Judy", lastName: "Jones", ageTier: "ADULT", isMember: true, memberId: judy.id }, "2026-08-01", "2026-08-03", NIGHTLY);

  // 11. AWAITING_REVIEW (admin review required)
  const bReview = await makeBooking(ken, "AWAITING_REVIEW", "2026-07-30", "2026-08-01", {
    requiresAdminReview: true,
    adminReviewReason: "Large group / short notice",
    adminReviewStatus: "PENDING",
    memberReviewJustification: "Club committee trip, approved verbally by President.",
  });
  await addGuest(bReview.id, { firstName: "Ken", lastName: "King", ageTier: "ADULT", isMember: true, memberId: ken.id }, "2026-07-30", "2026-08-01", NIGHTLY);

  // Failed-payment booking (covers PaymentStatus.FAILED + CANCEL_PAYMENT_INTENT recovery)
  const bFailed = await makeBooking(lars, "PENDING", "2026-07-19", "2026-07-21");
  await addGuest(bFailed.id, { firstName: "Lars", lastName: "Larsen", ageTier: "ADULT", isMember: true, memberId: lars.id }, "2026-07-19", "2026-07-21", NIGHTLY);
  const failedPayment = await prisma.payment.create({ data: { bookingId: bFailed.id, amountCents: bFailed.finalPriceCents, source: "STRIPE", status: "FAILED", stripePaymentIntentId: "pi_demo_failed" } });
  await prisma.paymentTransaction.create({ data: { paymentId: failedPayment.id, kind: "PRIMARY", source: "STRIPE", amountCents: bFailed.finalPriceCents, status: "FAILED", reason: "card_declined", stripePaymentIntentId: "pi_demo_failed" } });
  await prisma.paymentRecoveryOperation.create({ data: { type: "CANCEL_PAYMENT_INTENT", status: "FAILED", bookingId: bFailed.id, paymentId: failedPayment.id, paymentIntentId: "pi_demo_failed", amountCents: bFailed.finalPriceCents, idempotencyKey: "demo-recovery-cancel-1", attempts: 3, lastError: "PaymentIntent already canceled" } });

  // Split booking: member parent (CONFIRMED) + non-member provisional child (PENDING)
  const splitParent = await makeBooking(mallory, "CONFIRMED", "2026-07-04", "2026-07-06", { hasNonMembers: true });
  await addGuest(splitParent.id, { firstName: "Mallory", lastName: "Moore", ageTier: "ADULT", isMember: true, memberId: mallory.id }, "2026-07-04", "2026-07-06", NIGHTLY);
  await prisma.payment.create({ data: { bookingId: splitParent.id, amountCents: splitParent.finalPriceCents, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_demo_split" } });
  const splitChild = await prisma.booking.create({
    data: {
      memberId: mallory.id,
      parentBookingId: splitParent.id,
      checkIn: d("2026-07-04"),
      checkOut: d("2026-07-06"),
      status: "PENDING",
      hasNonMembers: true,
      cancelIfGuestsBumped: false,
      nonMemberHoldUntil: d("2026-06-27"),
      totalPriceCents: NIGHTLY * 2 * 2,
      finalPriceCents: NIGHTLY * 2 * 2,
    },
  });
  await addGuest(splitChild.id, { firstName: "Gerry", lastName: "Guest", ageTier: "ADULT", isMember: false }, "2026-07-04", "2026-07-06", NIGHTLY * 2);
  console.log("Bookings seeded (all statuses, payments, refunds, split, promo)");

  // -------------------------------------------------------------------------
  // Account credits — every CreditType.
  // -------------------------------------------------------------------------
  // (CANCELLATION_REFUND already created above on the cancelled booking.)
  await prisma.memberCredit.create({ data: { memberId: dave.id, amountCents: NIGHTLY, type: "BOOKING_MODIFICATION_REFUND", description: "Refund from date change", sourceBookingModificationId: daveMod.id } });
  const adminAdjRequestApproved = await prisma.adminCreditAdjustmentRequest.create({ data: { memberId: alice.id, amountCents: 5000, description: "Goodwill credit", idempotencyKey: "demo-adj-approved", status: "APPROVED", requestedById: admin.id, reviewedById: admin.id, reviewedAt: d("2026-05-20") } });
  await prisma.memberCredit.create({ data: { memberId: alice.id, amountCents: 5000, type: "ADMIN_ADJUSTMENT", description: "Goodwill credit", requestedById: admin.id, approvedById: admin.id, approvalRequestId: adminAdjRequestApproved.id } });
  await prisma.memberCredit.create({ data: { memberId: erin.id, amountCents: -NIGHTLY, type: "BOOKING_APPLIED", description: "Credit applied to July booking", appliedToBookingId: bPaid.id } });
  await prisma.adminCreditAdjustmentRequest.create({ data: { memberId: bob.id, amountCents: 2500, description: "Pending review adjustment", idempotencyKey: "demo-adj-pending", status: "PENDING", requestedById: admin.id } });
  await prisma.adminCreditAdjustmentRequest.create({ data: { memberId: carol.id, amountCents: 3000, description: "Rejected adjustment", idempotencyKey: "demo-adj-rejected", status: "REJECTED", requestedById: admin.id, reviewedById: admin.id, reviewedAt: d("2026-05-22") } });
  console.log("Account credits seeded (all types + adjustment requests)");

  // -------------------------------------------------------------------------
  // Change requests + refund requests (every status).
  // -------------------------------------------------------------------------
  await prisma.bookingChangeRequest.create({ data: { bookingId: bConfirmed.id, requestedByMemberId: dave.id, status: "REQUESTED", requestedChanges: { addGuest: { firstName: "Extra", lastName: "Guest", ageTier: "ADULT" } }, reason: "Friend wants to join" } });
  await prisma.bookingChangeRequest.create({ data: { bookingId: bConfirmed.id, requestedByMemberId: dave.id, status: "APPROVED", requestedChanges: { checkOut: "2026-06-29" }, reviewedByMemberId: admin.id, reviewedAt: d("2026-06-19"), linkedModificationId: daveMod.id } });
  await prisma.bookingChangeRequest.create({ data: { bookingId: bCompleted.id, requestedByMemberId: heidi.id, status: "REJECTED", requestedChanges: { checkIn: "2026-06-04" }, adminNotes: "Past booking; cannot change.", reviewedByMemberId: admin.id, reviewedAt: d("2026-06-06") } });

  await prisma.refundRequest.create({ data: { bookingId: bCancelled.id, memberId: grace.id, reason: "Hospitalised — requesting full refund", requestedAmountCents: bCancelled.finalPriceCents, status: "PENDING" } });
  await prisma.refundRequest.create({ data: { bookingId: bBumped.id, memberId: frank.id, reason: "Bumped, want cash not credit", requestedAmountCents: bBumped.finalPriceCents, status: "APPROVED", approvedAmountCents: bBumped.finalPriceCents, reviewedBy: admin.id, reviewedAt: d("2026-07-01") } });
  await prisma.refundRequest.create({ data: { bookingId: bCompleted.id, memberId: heidi.id, reason: "Unhappy with stay", status: "REJECTED", adminNotes: "Stay completed as booked.", reviewedBy: admin.id, reviewedAt: d("2026-06-10") } });
  console.log("Change + refund requests seeded (all statuses)");

  // -------------------------------------------------------------------------
  // Membership cancellation + lifecycle + deletion requests.
  // -------------------------------------------------------------------------
  const mcr = await prisma.membershipCancellationRequest.create({ data: { requestedByMemberId: carmen.id, status: "APPROVED", reason: "Family relocating", reviewedByMemberId: admin.id, reviewedAt: d("2026-02-14"), completedAt: d("2026-02-15") } });
  await prisma.membershipCancellationRequestParticipant.create({ data: { requestId: mcr.id, memberId: carmen.id, status: "APPROVED", reviewedByMemberId: admin.id, reviewedAt: d("2026-02-14"), confirmedAt: d("2026-02-13") } });
  const mcrPending = await prisma.membershipCancellationRequest.create({ data: { requestedByMemberId: bob.id, status: "REQUESTED", reason: "Considering leaving" } });
  await prisma.membershipCancellationRequestParticipant.create({ data: { requestId: mcrPending.id, memberId: bob.id, status: "PENDING_CONFIRMATION" } });

  await prisma.memberLifecycleActionRequest.create({ data: { memberId: arnold.id, action: "ARCHIVE", status: "APPROVED", reason: "Moved overseas", requestedByMemberId: admin.id, reviewedByMemberId: admin.id, reviewedAt: d("2026-03-01"), processedAt: d("2026-03-01") } });
  await prisma.memberLifecycleActionRequest.create({ data: { memberId: bob.id, action: "DELETE", status: "REQUESTED", reason: "GDPR-style erasure request", requestedByMemberId: admin.id } });

  await prisma.deletionRequest.create({ data: { memberId: carol.id, status: "PENDING", reason: "Please delete my account" } });
  await prisma.deletionRequest.create({ data: { memberId: ivan.id, status: "APPROVED", reason: "No longer a member", reviewedBy: admin.id, reviewedAt: d("2026-05-30") } });
  await prisma.deletionRequest.create({ data: { memberId: ken.id, status: "REJECTED", reason: "Mistaken request", adminNote: "Member confirmed they want to stay.", reviewedBy: admin.id, reviewedAt: d("2026-05-31") } });
  console.log("Cancellation / lifecycle / deletion requests seeded");

  // -------------------------------------------------------------------------
  // Family group + join requests.
  // -------------------------------------------------------------------------
  const smithGroup = await prisma.familyGroup.create({ data: { name: "The Powell Family" } });
  await prisma.familyGroupMember.create({ data: { familyGroupId: smithGroup.id, memberId: pat.id, role: "ADMIN" } });
  await prisma.familyGroupMember.create({ data: { familyGroupId: smithGroup.id, memberId: alice.id, role: "MEMBER" } });
  await prisma.familyGroupMember.create({ data: { familyGroupId: smithGroup.id, memberId: sam.id, role: "MEMBER" } });
  await prisma.familyGroupJoinRequest.create({ data: { familyGroupId: smithGroup.id, requesterId: pat.id, type: "ADULT_INVITE", status: "PENDING", invitedMemberId: bob.id } });
  await prisma.familyGroupJoinRequest.create({ data: { familyGroupId: smithGroup.id, requesterId: pat.id, type: "CHILD_REQUEST", status: "PENDING", childFirstName: "Lily", childLastName: "Powell", childDateOfBirth: d("2019-01-15") } });
  await prisma.familyGroupJoinRequest.create({ data: { familyGroupId: smithGroup.id, requesterId: carol.id, type: "JOIN_REQUEST", status: "APPROVED", reviewedBy: admin.id, reviewedAt: d("2026-04-01") } });
  console.log("Family group + join requests seeded");

  // -------------------------------------------------------------------------
  // Chores (every ChoreStatus) + hut leader roster + issue reports.
  // -------------------------------------------------------------------------
  const choreTemplates = await prisma.choreTemplate.findMany({ take: 3, orderBy: { sortOrder: "asc" } });
  if (choreTemplates.length > 0) {
    await prisma.choreAssignment.create({ data: { choreTemplateId: choreTemplates[0].id, bookingId: bCompleted.id, bookingGuestId: heidiGuest.id, date: d("2026-06-06"), status: "COMPLETED", completedAt: d("2026-06-06"), completedVia: "KIOSK" } });
    await prisma.choreAssignment.create({ data: { choreTemplateId: choreTemplates[Math.min(1, choreTemplates.length - 1)].id, bookingId: bConfirmed.id, bookingGuestId: daveGuest.id, date: d("2026-06-26"), status: "CONFIRMED" } });
    await prisma.choreAssignment.create({ data: { choreTemplateId: choreTemplates[Math.min(2, choreTemplates.length - 1)].id, bookingId: bConfirmed.id, date: d("2026-06-27"), status: "SUGGESTED" } });
  }

  await prisma.hutLeaderAssignment.create({ data: { memberId: dave.id, startDate: d("2026-06-25"), endDate: d("2026-06-28"), hutLeaderPin: "4821" } });

  await prisma.issueReport.create({ data: { memberId: alice.id, pageUrl: "https://demo/booking", pageTitle: "New booking", description: "Calendar didn't show August dates." } });
  await prisma.issueReport.create({ data: { memberId: bob.id, pageUrl: "https://demo/dashboard", pageTitle: "Dashboard", description: "Credit balance looked wrong (now fixed).", resolvedAt: d("2026-06-12"), resolvedById: admin.id, resolutionNote: "Cache cleared." } });
  console.log("Chores, hut-leader roster, issue reports seeded");

  // -------------------------------------------------------------------------
  // Inductions — every InductionStatus.
  // -------------------------------------------------------------------------
  const template = await prisma.inductionChecklistTemplate.findFirst({ where: { isActive: true }, include: { sections: { include: { items: true } } } });
  if (template) {
    // COMPLETED induction with sign-offs.
    const completedInduction = await prisma.memberInduction.create({ data: { memberId: alice.id, templateId: template.id, kind: "NEW_MEMBER", status: "COMPLETED", requiredSignOffs: 2, inductionDate: d("2026-05-15"), completedAt: d("2026-05-16"), completionSource: "SIGN_OFFS", finalComments: "Confident lodge user." } });
    await prisma.memberInductionSignOff.create({ data: { inductionId: completedInduction.id, signerMemberId: dave.id, signerName: "Dave Davis", signerRole: "NOMINATOR", declarationAccepted: true, comments: "Inducted on the June trip." } });
    await prisma.memberInductionSignOff.create({ data: { inductionId: completedInduction.id, signerMemberId: admin.id, signerName: "Demo Admin", signerRole: "ADMIN", declarationAccepted: true } });

    // IN_PROGRESS with assigned signers.
    const inProgress = await prisma.memberInduction.create({ data: { memberId: bob.id, templateId: template.id, kind: "NEW_MEMBER", status: "IN_PROGRESS" } });
    await prisma.memberInductionAssignedSigner.create({ data: { inductionId: inProgress.id, memberId: dave.id, emailSentAt: d("2026-06-11") } });

    // DRAFT
    await prisma.memberInduction.create({ data: { memberId: carol.id, templateId: template.id, kind: "YOUTH_TO_FULL", status: "DRAFT" } });
    // VOIDED
    await prisma.memberInduction.create({ data: { memberId: frank.id, templateId: template.id, kind: "RE_INDUCTION", status: "VOIDED", voidedReason: "Superseded by a newer induction." } });
    console.log("Inductions seeded (all statuses)");
  } else {
    console.log("No active induction template found; skipping inductions");
  }

  // -------------------------------------------------------------------------
  // Public booking requests — every status, GENERAL + SCHOOL.
  // -------------------------------------------------------------------------
  const guestsJson = [
    { firstName: "Tina", lastName: "Tramper", ageTier: "ADULT" },
    { firstName: "Theo", lastName: "Tramper", ageTier: "CHILD" },
  ];
  await prisma.bookingRequest.create({ data: { type: "GENERAL", status: "NEW", contactFirstName: "Tina", contactLastName: "Tramper", contactEmail: `tina@${DEMO_DOMAIN}`, contactPhone: "021555100", checkIn: d("2026-08-10"), checkOut: d("2026-08-12"), guests: guestsJson, message: "Two of us, hoping to visit." } });
  await prisma.bookingRequest.create({ data: { type: "GENERAL", status: "VERIFIED", contactFirstName: "Uma", contactLastName: "Usher", contactEmail: `uma@${DEMO_DOMAIN}`, checkIn: d("2026-08-15"), checkOut: d("2026-08-17"), guests: guestsJson, verifiedAt: d("2026-06-15") } });
  await prisma.bookingRequest.create({ data: { type: "GENERAL", status: "PRICED", contactFirstName: "Vic", contactLastName: "Vance", contactEmail: `vic@${DEMO_DOMAIN}`, checkIn: d("2026-08-20"), checkOut: d("2026-08-22"), guests: guestsJson, indicativePriceCents: 18000, priceCents: 18000, pricedByMemberId: admin.id, pricedAt: d("2026-06-16"), verifiedAt: d("2026-06-15") } });
  const approvedReq = await prisma.bookingRequest.create({ data: { type: "GENERAL", status: "APPROVED", contactFirstName: "Wendy", contactLastName: "West", contactEmail: `wendy@${DEMO_DOMAIN}`, checkIn: d("2026-08-25"), checkOut: d("2026-08-27"), guests: guestsJson, priceCents: 18000, pricedByMemberId: admin.id, pricedAt: d("2026-06-16"), reviewedByMemberId: admin.id, reviewedAt: d("2026-06-17"), verifiedAt: d("2026-06-15") } });
  await prisma.paymentLink.create({ data: { bookingId: bReview.id, bookingRequestId: approvedReq.id, tokenHash: "demo-paylink-hash-1", expiresAt: d("2026-06-30") } });
  await prisma.bookingRequest.create({ data: { type: "GENERAL", status: "DECLINED", contactFirstName: "Xena", contactLastName: "Xu", contactEmail: `xena@${DEMO_DOMAIN}`, checkIn: d("2026-08-28"), checkOut: d("2026-08-30"), guests: guestsJson, reviewedByMemberId: admin.id, reviewedAt: d("2026-06-17"), declineReason: "Lodge fully booked that week." } });
  // SCHOOL request, CONVERTED into a booking.
  await prisma.bookingRequest.create({
    data: {
      type: "SCHOOL",
      status: "CONVERTED",
      contactFirstName: "Mr",
      contactLastName: "Teacher",
      contactEmail: `office@${DEMO_DOMAIN}`,
      contactPhone: "078881234",
      checkIn: d("2026-09-07"),
      checkOut: d("2026-09-09"),
      guests: [
        { firstName: "Mr", lastName: "Teacher", ageTier: "ADULT" },
        { firstName: "School Child 1", lastName: "", ageTier: "YOUTH" },
        { firstName: "School Child 2", lastName: "", ageTier: "YOUTH" },
      ],
      schoolName: "Demo High School",
      teachers: [{ firstName: "Mr", lastName: "Teacher", email: `teacher@${DEMO_DOMAIN}` }],
      priceCents: 36000,
      pricedByMemberId: admin.id,
      pricedAt: d("2026-06-10"),
      reviewedByMemberId: admin.id,
      reviewedAt: d("2026-06-11"),
      convertedBookingId: bConfirmed.id,
      convertedMemberId: dave.id,
    },
  });
  console.log("Public booking requests seeded (all statuses, GENERAL + SCHOOL)");

  // -------------------------------------------------------------------------
  // E2E fixtures (Playwright suite; see e2e/helpers/fixtures.ts). Deterministic
  // personas + bookings + a membership application the browser specs drive.
  // Guarded by the same explicit local demo-only checks as the rest of this seed.
  // -------------------------------------------------------------------------
  // Scoped access-role personas: one bundled role each (plus baseline USER) so
  // the admin-permission matrix (src/lib/admin-permissions.ts) governs access.
  // Each gets a complete, self-confirmed profile: admin-UI specs drive real
  // pages as these personas, and an unconfirmed profile pops the blocking
  // "Confirm member details" modal over every page (it broke the
  // admin-member-detail spec's clicks; alice deliberately keeps that gate).
  const roleProfileConfirmedAt = new Date();
  for (const [role, persona] of Object.entries(ROLE_PERSONAS)) {
    const scoped = await makeMember(persona.email.split("@")[0], persona.firstName, persona.lastName, {
      dateOfBirth: d("1984-03-03"),
      phoneCountryCode: "64",
      phoneAreaCode: "21",
      phoneNumber: "5550100",
      streetAddressLine1: "2 Ridgeline Terrace",
      streetCity: "Alpine Village",
      streetRegion: "Waikato",
      streetPostalCode: "3420",
      streetCountry: "New Zealand",
      postalAddressLine1: "2 Ridgeline Terrace",
      postalCity: "Alpine Village",
      postalRegion: "Waikato",
      postalPostalCode: "3420",
      postalCountry: "New Zealand",
      profileCompletedAt: roleProfileConfirmedAt,
      detailsConfirmedAt: roleProfileConfirmedAt,
      onboardingConfirmedAt: roleProfileConfirmedAt,
    });
    await prisma.member.update({
      where: { id: scoped.id },
      data: { detailsConfirmedByMemberId: scoped.id },
    });
    await ensureMemberAccessRoles(prisma, {
      memberId: scoped.id,
      roles: [role],
      canLogin: true,
    });
  }

  // A full ADMIN with a known password (the base seed admin forces a password
  // change), for approving applications and toggling modules from specs.
  await makeMember(E2E_ADMIN.email.split("@")[0], E2E_ADMIN.firstName, E2E_ADMIN.lastName, {
    role: "ADMIN",
  });

  // Members who drive member-facing PAGES in the E2E specs need a PAID,
  // COMPLETE, self-confirmed profile so the onboarding "Confirm member details"
  // modal never blocks the page (and, for API-created bookings, so the booking
  // guest-profile gate passes). alice is deliberately NOT one of these: she is
  // kept unconfirmed so booking.spec keeps exercising that gate (#1124).
  const nowConfirmed = new Date();
  const seedConfirmedPaidMember = async (
    local: string,
    first: string,
    last: string,
    dobIso: string,
    phoneNumber: string,
  ) => {
    const member = await makeMember(local, first, last, {
      dateOfBirth: d(dobIso),
      phoneCountryCode: "64",
      phoneAreaCode: "21",
      phoneNumber,
      streetAddressLine1: "8 Summit Way",
      streetCity: "Alpine Village",
      streetRegion: "Waikato",
      streetPostalCode: "3420",
      streetCountry: "New Zealand",
      postalAddressLine1: "8 Summit Way",
      postalCity: "Alpine Village",
      postalRegion: "Waikato",
      postalPostalCode: "3420",
      postalCountry: "New Zealand",
      profileCompletedAt: nowConfirmed,
      detailsConfirmedAt: nowConfirmed,
      onboardingConfirmedAt: nowConfirmed,
    });
    await prisma.member.update({
      where: { id: member.id },
      data: { detailsConfirmedByMemberId: member.id },
    });
    await prisma.memberSubscription.create({
      data: { memberId: member.id, seasonYear: SEASON_YEAR, status: "PAID", paidAt: d("2026-01-20") },
    });
    return member;
  };

  // Complete-profile driver: owns the waitlist + Internet Banking bookings and
  // acts as nomination #1 — all member-page journeys that must not hit the modal.
  const wanda = await seedConfirmedPaidMember(
    WAITLISTER.email.split("@")[0],
    WAITLISTER.firstName,
    WAITLISTER.lastName,
    "1988-06-06",
    "5552002",
  );

  // Second paid-up nominator (nomination #2), also complete-profile so its
  // /nominations page is not blocked by the onboarding modal.
  const nadia = await seedConfirmedPaidMember(
    NOMINATOR_TWO.email.split("@")[0],
    NOMINATOR_TWO.firstName,
    NOMINATOR_TWO.lastName,
    "1979-11-03",
    "5552003",
  );

  // Email-code two-factor enrollee: un-enrolled (makeMember sets no two-factor
  // state) so global enforcement forces enrollment, and the email-code spec
  // (e2e/two-factor-email.spec.ts) drives the EMAIL method end-to-end. Kept
  // separate from bob so it never collides with the TOTP spec.
  await makeMember(
    EMAIL_2FA_ENROLLEE.email.split("@")[0],
    EMAIL_2FA_ENROLLEE.firstName,
    EMAIL_2FA_ENROLLEE.lastName,
  );

  // Waitlist spec: fill a September window to capacity (lodge capacity is 20)
  // so a fresh booking there is refused and can be waitlisted.
  const fillOwner = await makeMember(
    LODGE_FILL_OWNER.email.split("@")[0],
    LODGE_FILL_OWNER.firstName,
    LODGE_FILL_OWNER.lastName,
    { canLogin: false },
  );
  const fillNights = nightsBetween(WAITLIST_FULL_WINDOW.checkIn, WAITLIST_FULL_WINDOW.checkOut).length;
  const fillBooking = await prisma.booking.create({
    data: {
      memberId: fillOwner.id,
      checkIn: d(WAITLIST_FULL_WINDOW.checkIn),
      checkOut: d(WAITLIST_FULL_WINDOW.checkOut),
      status: "CONFIRMED",
      totalPriceCents: NIGHTLY * fillNights * WAITLIST_FILL_GUEST_COUNT,
      finalPriceCents: NIGHTLY * fillNights * WAITLIST_FILL_GUEST_COUNT,
    },
  });
  for (let i = 1; i <= WAITLIST_FILL_GUEST_COUNT; i += 1) {
    await addGuest(
      fillBooking.id,
      { firstName: "Filler", lastName: `Guest${i}`, ageTier: "ADULT", isMember: false },
      WAITLIST_FULL_WINDOW.checkIn,
      WAITLIST_FULL_WINDOW.checkOut,
      NIGHTLY,
    );
  }
  await prisma.payment.create({
    data: {
      bookingId: fillBooking.id,
      amountCents: fillBooking.finalPriceCents,
      source: "INTERNET_BANKING",
      reference: "BANK-REF-FILL",
      status: "SUCCEEDED",
    },
  });

  // Waitlist spec: a ready-to-accept offer owned by Wanda on an empty window
  // (capacity is free, so accepting confirms). Future expiry.
  const offerNights = nightsBetween(WAITLIST_OFFER_WINDOW.checkIn, WAITLIST_OFFER_WINDOW.checkOut).length;
  const offerBooking = await prisma.booking.create({
    data: {
      id: WAITLIST_OFFER_BOOKING_ID,
      memberId: wanda.id,
      checkIn: d(WAITLIST_OFFER_WINDOW.checkIn),
      checkOut: d(WAITLIST_OFFER_WINDOW.checkOut),
      status: "WAITLIST_OFFERED",
      waitlistPosition: 1,
      waitlistOfferedAt: new Date(),
      waitlistOfferExpiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      totalPriceCents: NIGHTLY * offerNights,
      finalPriceCents: NIGHTLY * offerNights,
    },
  });
  await addGuest(
    offerBooking.id,
    { firstName: WAITLISTER.firstName, lastName: WAITLISTER.lastName, ageTier: "ADULT", isMember: true, memberId: wanda.id },
    WAITLIST_OFFER_WINDOW.checkIn,
    WAITLIST_OFFER_WINDOW.checkOut,
    NIGHTLY,
  );

  // Internet Banking spec: a card (Stripe) PAYMENT_PENDING booking owned by
  // Wanda (complete profile → no onboarding modal on the booking page), far
  // enough out to clear the IB lead-time cutoff.
  const ibNights = nightsBetween(IB_WINDOW.checkIn, IB_WINDOW.checkOut).length;
  const ibBooking = await prisma.booking.create({
    data: {
      id: IB_BOOKING_ID,
      memberId: wanda.id,
      checkIn: d(IB_WINDOW.checkIn),
      checkOut: d(IB_WINDOW.checkOut),
      status: "PAYMENT_PENDING",
      totalPriceCents: NIGHTLY * ibNights,
      finalPriceCents: NIGHTLY * ibNights,
    },
  });
  await addGuest(
    ibBooking.id,
    { firstName: WAITLISTER.firstName, lastName: WAITLISTER.lastName, ageTier: "ADULT", isMember: true, memberId: wanda.id },
    IB_WINDOW.checkIn,
    IB_WINDOW.checkOut,
    NIGHTLY,
  );
  await prisma.payment.create({
    data: {
      bookingId: ibBooking.id,
      amountCents: ibBooking.finalPriceCents,
      source: "STRIPE",
      status: "PROCESSING",
      stripePaymentIntentId: "pi_e2e_ib_pending",
    },
  });

  // Membership application spec: PENDING_NOMINATORS with two nomination tokens
  // whose raw values are known (SHA-256 stored, matching action-tokens.ts), so
  // the spec can drive /nominations/<token> without the (disabled) email link.
  const membershipApp = await prisma.memberApplication.create({
    data: {
      id: MEMBERSHIP_APPLICATION_ID,
      applicantFirstName: MEMBERSHIP_APPLICANT.firstName,
      applicantLastName: MEMBERSHIP_APPLICANT.lastName,
      applicantEmail: MEMBERSHIP_APPLICANT.email,
      applicantDateOfBirth: d(MEMBERSHIP_APPLICANT.dateOfBirth),
      nominator1Email: wanda.email,
      nominator2Email: nadia.email,
      nominator1Id: wanda.id,
      nominator2Id: nadia.id,
      status: "PENDING_NOMINATORS",
    },
  });
  const nominationTokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
  await prisma.nominationToken.createMany({
    data: [
      { tokenHash: sha256Hex(NOMINATION_TOKEN_ONE), applicationId: membershipApp.id, nominatorMemberId: wanda.id, expiresAt: nominationTokenExpiry, reminderCount: 0, lastSentAt: new Date() },
      { tokenHash: sha256Hex(NOMINATION_TOKEN_TWO), applicationId: membershipApp.id, nominatorMemberId: nadia.id, expiresAt: nominationTokenExpiry, reminderCount: 0, lastSentAt: new Date() },
    ],
  });
  console.log("E2E fixtures seeded (role personas, admin, waitlist, internet banking, membership application)");

  // Notification preference example (differs from defaults).
  await prisma.notificationPreference.create({ data: { memberId: alice.id, marketingEmails: true } });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const [members, bookings, payments, promos, credits, inductions, requests] = await Promise.all([
    prisma.member.count({ where: { email: { endsWith: `@${DEMO_DOMAIN}` } } }),
    prisma.booking.count(),
    prisma.payment.count(),
    prisma.promoCode.count(),
    prisma.memberCredit.count(),
    prisma.memberInduction.count(),
    prisma.bookingRequest.count(),
  ]);
  console.log("\nDemo data complete:");
  console.log(`  demo members:      ${members}`);
  console.log(`  bookings:          ${bookings} (every status)`);
  console.log(`  payments:          ${payments} (every status)`);
  console.log(`  promo codes:       ${promos} (every type)`);
  console.log(`  account credits:   ${credits} (every type)`);
  console.log(`  inductions:        ${inductions} (every status)`);
  console.log(`  booking requests:  ${requests} (every status)`);
  const passwordHint = process.env.DEMO_SEED_PASSWORD ? "your DEMO_SEED_PASSWORD value" : DEMO_PASSWORD;
  console.log(`\nLogin: any demo member, e.g. alice@${DEMO_DOMAIN} / ${passwordHint}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
