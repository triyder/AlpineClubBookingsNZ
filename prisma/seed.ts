// Club-agnostic first-run seed. Every section is create-if-missing: re-running
// the seed against a populated database must never delete, overwrite, or
// duplicate data. Clubs customise the placeholders through the admin screens.
import fs from "node:fs";
import path from "node:path";
import { type AgeTier, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { clubConfig } from "../src/config/club";
import {
  CLUB_CONTACT_EMAIL,
  CLUB_LODGE_NAME,
  clubDomainEmail,
} from "../src/config/club-identity";
import { slugifyLodgeName } from "../src/lib/lodges";
import {
  CLUB_THEME_ID,
  DEFAULT_CLUB_THEME_VALUES,
  MAX_LOGO_DATA_URL_BYTES,
  TOKOROA_CLUB_THEME_VALUES,
  isValidLogoDataUrl,
} from "../src/lib/club-theme-schema";
import { DEFAULT_INDUCTION_TEMPLATE } from "../src/lib/induction-checklist-template";
import { DEFAULT_FINANCE_REPORT_CATEGORIES } from "../src/lib/finance-report-mapping-defaults";
import {
  backfillCurrentSeasonMembershipAssignments,
} from "../src/lib/membership-types";
import { ensureAccessRoleDefinitions } from "../src/lib/access-role-definitions";
import { ensureBuiltInDisplays } from "../src/lib/lodge-display/built-in-seeds";
import { ensureMemberAccessRolesFromCompatibilityFields } from "../src/lib/member-access-role-writes";
import { ensureNotRequiredSubscriptionForRole } from "../src/lib/member-subscription-defaults";
import { createPrismaPgAdapter } from "../src/lib/prisma-adapter";
import {
  buildSeedAdminMemberData,
  buildSeedChoreTemplates,
  buildSeedCommitteeRoles,
  buildSeedLodgeMemberData,
  shouldSkipTokoroaThemeSeed,
} from "./seed-data";
import { starterPageContent } from "./starter-page-content";
import { starterSiteContent } from "./starter-site-content";

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(),
});

type InductionChecklistTemplateDelegate = {
  findFirst: (args: {
    where: { version: string };
    select: { id: true };
  }) => Promise<{ id: string } | null>;
  count: (args: { where: { isActive: true } }) => Promise<number>;
  create: (args: {
    data: {
      name: string;
      version: string;
      kind: "NEW_MEMBER" | "HUT_LEADER" | "YOUTH_TO_FULL" | "RE_INDUCTION";
      sourceLabel: string | null;
      isActive: boolean;
      sections: {
        create: Array<{
          title: string;
          description: string | null;
          priority:
            | "EMERGENCY"
            | "SECURITY"
            | "STARTUP"
            | "SHUTDOWN"
            | "GENERAL";
          sortOrder: number;
          items: {
            create: Array<{
              label: string;
              competencyPrompt: string | null;
              notesPrompt: string | null;
              isMandatory: boolean;
              requiresDemonstration: boolean;
              sortOrder: number;
              legacySourceText: string | null;
            }>;
          };
        }>;
      };
    };
  }) => Promise<unknown>;
};

function inductionChecklistTemplateDelegate(): InductionChecklistTemplateDelegate {
  // Some local type-generation states can temporarily miss this delegate even
  // though the model exists in schema and database. Keep seed typing resilient.
  return (
    prisma as unknown as {
      inductionChecklistTemplate: InductionChecklistTemplateDelegate;
    }
  ).inductionChecklistTemplate;
}

function seedRatesForSeason(season: "winter" | "summer") {
  return clubConfig.ageTiers.flatMap((tier) => [
    {
      ageTier: tier.id as AgeTier,
      isMember: true,
      pricePerNightCents: tier.nightlyRates[season].memberCents,
    },
    {
      ageTier: tier.id as AgeTier,
      isMember: false,
      pricePerNightCents: tier.nightlyRates[season].nonMemberCents,
    },
  ]);
}

function seedAgeTierSettings() {
  return clubConfig.ageTiers.map((tier, sortOrder) => ({
    tier: tier.id as AgeTier,
    minAge: tier.minAge,
    maxAge: tier.maxAge,
    label: tier.label,
    subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
    familyGroupRequestCreateMemberAllowed:
      tier.familyGroupRequestCreateMemberAllowed,
    sortOrder,
  }));
}

function requireSeedEnv(
  name: "SEED_ADMIN_EMAIL" | "SEED_ADMIN_PASSWORD" | "SEED_LODGE_PASSWORD",
) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required before running prisma/seed.ts`);
  }
  return value;
}

function readBrandingLogoDataUrl() {
  const logoPath = path.join(process.cwd(), "public", "branding", "logo.png");
  if (!fs.existsSync(logoPath)) {
    return null;
  }

  const logo = fs.readFileSync(logoPath);
  if (logo.byteLength > MAX_LOGO_DATA_URL_BYTES) {
    throw new Error(
      `public/branding/logo.png is ${logo.byteLength} bytes; the site style logo cap is ${MAX_LOGO_DATA_URL_BYTES} bytes.`,
    );
  }

  const dataUrl = `data:image/png;base64,${logo.toString("base64")}`;
  if (!isValidLogoDataUrl(dataUrl)) {
    throw new Error(
      "public/branding/logo.png could not be converted to a valid logo data URL.",
    );
  }

  return dataUrl;
}

async function seedClubTheme() {
  if (process.env.SEED_TOKOROA_THEME_COMPLETE === "1") {
    const existing = await prisma.clubTheme.findUnique({
      where: { id: CLUB_THEME_ID },
      select: { completedAt: true },
    });
    if (shouldSkipTokoroaThemeSeed(existing)) {
      console.log(
        "Club theme setup already completed; skipping Tokoroa site style re-seed",
      );
      return;
    }

    const logoDataUrl = readBrandingLogoDataUrl();
    await prisma.clubTheme.upsert({
      where: { id: CLUB_THEME_ID },
      update: {
        ...TOKOROA_CLUB_THEME_VALUES,
        logoDataUrl,
        completedAt: new Date(),
      },
      create: {
        id: CLUB_THEME_ID,
        ...TOKOROA_CLUB_THEME_VALUES,
        logoDataUrl,
        completedAt: new Date(),
      },
    });
    console.log(
      logoDataUrl
        ? "Tokoroa site style seeded with palette and logo"
        : "Tokoroa site style seeded with palette; public/branding/logo.png was not present",
    );
    return;
  }

  await prisma.clubTheme.upsert({
    where: { id: CLUB_THEME_ID },
    update: {},
    create: {
      id: CLUB_THEME_ID,
      ...DEFAULT_CLUB_THEME_VALUES,
      completedAt: null,
    },
  });
  console.log("Default site style seeded");
}

// Create any missing per-tier rates for a season without touching existing
// rows, so rates edited by admins survive a re-run.
async function createMissingSeasonRates(
  seasonId: string,
  season: "winter" | "summer",
) {
  for (const rate of seedRatesForSeason(season)) {
    await prisma.seasonRate.upsert({
      where: {
        seasonId_ageTier_isMember: {
          seasonId,
          ageTier: rate.ageTier,
          isMember: rate.isMember,
        },
      },
      update: {},
      create: {
        seasonId,
        ...rate,
      },
    });
  }
}

// Seed the default Lodge Induction checklist template (create-if-missing). The
// template is only created when no template with this version exists, so admin
// edits and new versions survive a re-run. It is marked active only when no
// other active template is present.
async function seedInductionChecklistTemplate() {
  const inductionChecklistTemplate = inductionChecklistTemplateDelegate();

  const existing = await inductionChecklistTemplate.findFirst({
    where: { version: DEFAULT_INDUCTION_TEMPLATE.version },
    select: { id: true },
  });
  if (existing) {
    console.log("Induction checklist template already present; skipping");
    return;
  }

  const activeCount = await inductionChecklistTemplate.count({
    where: { isActive: true },
  });

  await inductionChecklistTemplate.create({
    data: {
      name: DEFAULT_INDUCTION_TEMPLATE.name,
      version: DEFAULT_INDUCTION_TEMPLATE.version,
      kind: DEFAULT_INDUCTION_TEMPLATE.kind,
      sourceLabel: DEFAULT_INDUCTION_TEMPLATE.sourceLabel,
      isActive: activeCount === 0,
      sections: {
        create: DEFAULT_INDUCTION_TEMPLATE.sections.map(
          (section, sectionIndex) => ({
            title: section.title,
            description: section.description ?? null,
            priority: section.priority,
            sortOrder: sectionIndex,
            items: {
              create: section.items.map((item, itemIndex) => ({
                label: item.label,
                competencyPrompt: item.competencyPrompt ?? null,
                notesPrompt: item.notesPrompt ?? null,
                isMandatory: item.isMandatory ?? false,
                requiresDemonstration: item.requiresDemonstration ?? false,
                sortOrder: itemIndex,
                legacySourceText: item.legacySourceText ?? null,
              })),
            },
          }),
        ),
      },
    },
  });
  console.log(
    `Induction checklist template seeded: ${DEFAULT_INDUCTION_TEMPLATE.name} v${DEFAULT_INDUCTION_TEMPLATE.version}`,
  );
}

async function main() {
  console.log(
    "Seeding database (create-if-missing; re-runs change nothing)...",
  );

  const seedAdminEmail = requireSeedEnv("SEED_ADMIN_EMAIL").toLowerCase();
  const seedAdminPassword = requireSeedEnv("SEED_ADMIN_PASSWORD");

  // Ensure the club's lodge exists (create-if-missing). The migration that
  // introduced the Lodge table seeds a 'Lodge' placeholder row when
  // EmailMessageSetting has no configured lodge name; on a first-run seed,
  // upgrade that placeholder to the club-config lodge name. Rows with any
  // other name are club data and are never touched.
  const existingLodges = await prisma.lodge.findMany({
    select: { id: true, name: true },
    // Deterministic order so the else-branch below stamps the oldest lodge
    // (matching getDefaultLodgeId), not whatever the engine returns first.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
  });
  let seedLodgeId: string;
  if (existingLodges.length === 0) {
    const createdLodge = await prisma.lodge.create({
      data: {
        name: CLUB_LODGE_NAME,
        slug: slugifyLodgeName(CLUB_LODGE_NAME),
        active: true,
        // Flag the sole lodge as the club default (#1656). The migration
        // backfill already sets this on the migration-seeded lodge; this
        // branch only fires where no lodge exists yet (e.g. a db-push test
        // setup that skipped the migration INSERT), so the flag would
        // otherwise be missing and getDefaultLodgeId would fall back to
        // createdAt ordering.
        isDefault: true,
      },
    });
    seedLodgeId = createdLodge.id;
    console.log(`Lodge seeded: ${CLUB_LODGE_NAME}`);
  } else if (
    existingLodges.length === 1 &&
    existingLodges[0].name === "Lodge"
  ) {
    const updatedLodge = await prisma.lodge.update({
      where: { id: existingLodges[0].id },
      data: {
        name: CLUB_LODGE_NAME,
        slug: slugifyLodgeName(CLUB_LODGE_NAME),
      },
    });
    seedLodgeId = updatedLodge.id;
    console.log(`Lodge placeholder renamed to: ${CLUB_LODGE_NAME}`);
  } else {
    seedLodgeId = existingLodges[0].id;
  }

  // Seed default cancellation policy tiers (create-if-missing).
  const policies = [
    { daysBeforeStay: 14, refundPercentage: 100 },
    { daysBeforeStay: 7, refundPercentage: 50 },
    { daysBeforeStay: 0, refundPercentage: 0 },
  ];

  for (const policy of policies) {
    // Tier uniqueness is per partition ([lodgeId, daysBeforeStay]) and the
    // club-wide partition is the null lodgeId, which a compound-unique
    // upsert cannot address — so create-if-missing by lookup instead.
    const existing = await prisma.cancellationPolicy.findFirst({
      where: { daysBeforeStay: policy.daysBeforeStay, lodgeId: null },
      select: { id: true },
    });
    if (!existing) {
      await prisma.cancellationPolicy.create({ data: policy });
    }
  }

  console.log("Cancellation policies seeded");

  // Seed example chore templates only when none exist yet, so re-runs never
  // resurrect templates an admin has deleted or renamed.
  const choreTemplateCount = await prisma.choreTemplate.count();
  if (choreTemplateCount === 0) {
    const choreTemplates = buildSeedChoreTemplates();
    for (const chore of choreTemplates) {
      await prisma.choreTemplate.create({
        data: { ...chore, lodgeId: seedLodgeId },
      });
    }
    console.log(
      `Chore templates seeded: ${choreTemplates.length} example templates`,
    );
  } else {
    console.log("Chore templates already present; skipping");
  }

  // Seed the editable access-role definitions (create-if-missing; club edits
  // are never overwritten) and re-link any enum-only assignment rows.
  await ensureAccessRoleDefinitions(prisma);

  // Seed the first admin account (only if no admin exists). canLogin and
  // emailVerified are required for the credentials login flow to accept the
  // account; forcePasswordChange routes the first login to /change-password.
  const existingAdmin = await prisma.member.findFirst({
    where: { role: "ADMIN" },
  });

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(seedAdminPassword, 12);
    const admin = await prisma.member.create({
      data: buildSeedAdminMemberData({
        email: seedAdminEmail,
        passwordHash,
        firstName: process.env.SEED_ADMIN_FIRST_NAME,
        lastName: process.env.SEED_ADMIN_LAST_NAME,
      }),
    });
    // Admin accounts never owe a membership subscription.
    await ensureNotRequiredSubscriptionForRole(prisma, admin);
    await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
      memberId: admin.id,
      role: admin.role,
      financeAccessLevel: admin.financeAccessLevel,
      canLogin: admin.canLogin,
    });
    console.log(
      `Admin user seeded: ${seedAdminEmail} (password change required on first login)`,
    );
  } else {
    await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
      memberId: existingAdmin.id,
      role: existingAdmin.role,
      financeAccessLevel: existingAdmin.financeAccessLevel,
      canLogin: existingAdmin.canLogin,
    });
  }

  // Seed the shared lodge kiosk account (create-if-missing).
  const lodgeAccountEmail = clubDomainEmail("lodge");
  const existingLodge = await prisma.member.findFirst({
    where: { email: lodgeAccountEmail },
  });

  if (!existingLodge) {
    const lodgePasswordHash = await bcrypt.hash(
      requireSeedEnv("SEED_LODGE_PASSWORD"),
      12,
    );
    const lodge = await prisma.member.create({
      data: buildSeedLodgeMemberData({
        email: lodgeAccountEmail,
        passwordHash: lodgePasswordHash,
      }),
    });
    await ensureNotRequiredSubscriptionForRole(prisma, lodge);
    await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
      memberId: lodge.id,
      role: lodge.role,
      financeAccessLevel: lodge.financeAccessLevel,
      canLogin: lodge.canLogin,
    });
    console.log(`Lodge account seeded: ${lodgeAccountEmail}`);
  } else {
    await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
      memberId: existingLodge.id,
      role: existingLodge.role,
      financeAccessLevel: existingLodge.financeAccessLevel,
      canLogin: existingLodge.canLogin,
    });
  }

  const membershipAssignmentBackfill =
    await backfillCurrentSeasonMembershipAssignments(prisma);
  console.log(
    `Membership types seeded; current-season assignments created: ${membershipAssignmentBackfill.createdCount}`,
  );

  // Seed Winter 2026 season (June - September) with rates from club config.
  const winter2026 = await prisma.season.upsert({
    where: { id: "seed-winter-2026" },
    update: {},
    create: {
      id: "seed-winter-2026",
      name: "Winter 2026",
      type: "WINTER",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-09-30"),
      active: true,
      lodgeId: seedLodgeId,
    },
  });
  await createMissingSeasonRates(winter2026.id, "winter");
  console.log(`Season seeded: ${winter2026.name}`);

  // Seed Summer 2026-27 season (November - March) with rates from club config.
  const summer2026 = await prisma.season.upsert({
    where: { id: "seed-summer-2026" },
    update: {},
    create: {
      id: "seed-summer-2026",
      name: "Summer 2026-27",
      type: "SUMMER",
      startDate: new Date("2026-11-01"),
      endDate: new Date("2027-03-31"),
      active: true,
      lodgeId: seedLodgeId,
    },
  });
  await createMissingSeasonRates(summer2026.id, "summer");
  console.log(`Season seeded: ${summer2026.name}`);

  // Seed Xero account mappings with current defaults (create-if-missing).
  const accountMappings = [
    { key: "hutFeesIncome", code: "200" },
    { key: "hutFeeRefunds", code: "200" },
    { key: "stripeBankAccount", code: "606" },
    { key: "stripeFees", code: null },
    { key: "subscriptionIncome", code: "203" },
    { key: "membershipCancellationCredit", code: "203" },
  ];
  for (const mapping of accountMappings) {
    await prisma.xeroAccountMapping.upsert({
      where: { key: mapping.key },
      update: {},
      create: mapping,
    });
  }
  console.log("Xero account mappings seeded");

  for (const category of DEFAULT_FINANCE_REPORT_CATEGORIES) {
    await prisma.financeReportCategory.upsert({
      where: {
        kind_name: {
          kind: category.kind,
          name: category.name,
        },
      },
      update: {},
      create: category,
    });
  }
  console.log("Finance report categories seeded");

  // Seed age tier settings from club config (create-if-missing so settings
  // edited by admins survive a re-run).
  const ageTierSettings = seedAgeTierSettings();
  for (const setting of ageTierSettings) {
    await prisma.ageTierSetting.upsert({
      where: { tier: setting.tier },
      update: {},
      create: setting,
    });
  }
  console.log("Age tier settings seeded");

  // Seed starter editable page content only when records do not yet exist.
  for (const page of starterPageContent) {
    await prisma.pageContent.upsert({
      where: { slug: page.slug },
      update: {},
      create: {
        slug: page.slug,
        path: page.path,
        caption: page.caption,
        menuTitle: page.menuTitle,
        title: page.title,
        headerText: page.headerText,
        sortOrder: page.sortOrder,
        contentHtml: page.contentHtml,
      },
    });
  }
  console.log(`Page content seeded: ${starterPageContent.length} pages`);

  // Seed starter site content (public footer columns) only when records do
  // not yet exist, so admin edits survive a re-run.
  for (const section of starterSiteContent) {
    await prisma.siteContent.upsert({
      where: { key: section.key },
      update: {},
      create: {
        id: section.id,
        key: section.key,
        contentHtml: section.contentHtml,
      },
    });
  }
  console.log(`Site content seeded: ${starterSiteContent.length} sections`);

  const committeeRoles = buildSeedCommitteeRoles({
    domainEmail: clubDomainEmail,
    contactEmail: CLUB_CONTACT_EMAIL,
  });
  for (const role of committeeRoles) {
    await prisma.committeeRole.upsert({
      where: { key: role.key },
      update: {},
      create: {
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        contactEmail: role.contactEmail,
        sortOrder: role.sortOrder,
      },
    });
  }
  console.log(`Committee master roles seeded: ${committeeRoles.length} roles`);

  await seedClubTheme();

  await seedInductionChecklistTemplate();

  // Seed the three built-in lobby-display designs as v2 Layout + Template rows
  // (LTV-038). DELIBERATE EXCEPTION to this file's "never overwrite" contract
  // (see the header): the built-ins are code-managed scaffolding, so
  // `ensureBuiltInDisplays` upserts each by `key` and REFRESHES its definition
  // from code on every re-seed — shipped-design improvements reach already-seeded
  // installs (owner decision A, issue #111). Only the reserved `builtin-*` keys
  // are touched; an admin customises by DUPLICATING a built-in into a new
  // (non-built-in) row, so an in-place edit to a built-in is intentionally
  // overwritten here (the authoring editors warn + confirm before such an edit,
  // issue #156). Devices bind to these rows by `templateId`.
  await ensureBuiltInDisplays(prisma);
  console.log("Built-in display layouts/templates seeded");

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
