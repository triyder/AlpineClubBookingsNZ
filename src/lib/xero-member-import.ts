/**
 * Cached-contact import from configured Xero contact groups.
 *
 * Reads `XeroContactCache` + `XeroContactGroupMembershipCache` (populated
 * by xero-bulk-contact-sync and xero-contact-groups) and creates local
 * `Member` rows for contacts in each mapped group. Falls back to a live
 * Xero fetch only when the caller opts in via `allowLiveXeroFetch`.
 */

import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import type { AgeTier } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { sendPasswordResetEmail } from "./email";
import { issueActionToken } from "./action-tokens";
import {
  getAuthenticatedXeroClient,
  XeroDailyLimitError,
} from "./xero-api-client";
import {
  CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
  fetchXeroContactsByIdsFromXero,
  getXeroContactDisplayName,
  upsertXeroContactCacheEntry,
} from "./xero-contact-cache";
import { parseXeroCompanyNumberDate } from "./xero-contacts";
import {
  DEFAULT_XERO_SYNC_SCOPE,
  getXeroSyncCursor,
  parseXeroError,
} from "./xero-sync-cursors";

// The bulk contact sync owns the canonical resource constant; depend on
// it directly so the two flows can never drift.
const CONTACT_SYNC_CURSOR_RESOURCE = "CONTACT_SYNC";

interface ImportMembersFromXeroGroupsOptions {
  allowLiveXeroFetch?: boolean;
}

interface ImportedXeroMemberDetail {
  name: string;
  email: string;
  xeroContactId: string;
  group: string;
}

interface ImportedXeroDependentDetail extends ImportedXeroMemberDetail {
  parentMemberId: string;
  parentName: string;
}

interface LinkedXeroMemberDetail extends ImportedXeroMemberDetail {
  memberId: string;
}

interface SkippedXeroContactDetail {
  name: string;
  xeroContactId: string;
  group: string;
  reason?: string;
}

interface CachedGroupContactRef {
  contactId: string;
  contactName: string | null;
}

export async function importMembersFromXeroGroups(
  groupMappings: Array<{ groupId: string; groupName: string; ageTier: AgeTier }>,
  sendInvites: boolean,
  options: ImportMembersFromXeroGroupsOptions = {}
): Promise<{
  created: number;
  createdAsDependent: number;
  skippedExisting: number;
  linkedExisting: number;
  skippedNoEmail: number;
  skippedNoEmailDetails: Array<{ name: string; xeroContactId: string }>;
  skippedArchived: number;
  skippedArchivedDetails: SkippedXeroContactDetail[];
  createdMembers: ImportedXeroMemberDetail[];
  createdDependents: ImportedXeroDependentDetail[];
  linkedExistingDetails: LinkedXeroMemberDetail[];
  errors: number;
  errorDetails: Array<{ member: string; error: string }>;
  groupsProcessed: string[];
}> {
  let created = 0;
  let createdAsDependent = 0;
  let skippedExisting = 0;
  let linkedExisting = 0;
  let skippedNoEmail = 0;
  const skippedNoEmailDetails: Array<{ name: string; xeroContactId: string }> = [];
  let skippedArchived = 0;
  const skippedArchivedDetails: SkippedXeroContactDetail[] = [];
  const createdMembers: ImportedXeroMemberDetail[] = [];
  const createdDependents: ImportedXeroDependentDetail[] = [];
  const linkedExistingDetails: LinkedXeroMemberDetail[] = [];
  let errors = 0;
  const errorDetails: Array<{ member: string; error: string }> = [];
  const groupsProcessed: string[] = [];

  // Hash a random UUID — unguessable placeholder password
  const placeholderHash = await hash(randomBytes(32).toString("hex"), 13);
  const groupCacheCursor = await getXeroSyncCursor(
    CONTACT_GROUP_CACHE_CURSOR_RESOURCE,
    DEFAULT_XERO_SYNC_SCOPE
  );
  if (!groupCacheCursor?.lastSuccessfulSyncAt) {
    throw new Error(
      "Xero contact group cache is empty. Refresh cached contact groups before importing members."
    );
  }

  const uniqueGroupIds = Array.from(
    new Set(groupMappings.map((mapping) => mapping.groupId))
  );
  const membershipRows = await prisma.xeroContactGroupMembershipCache.findMany({
    where: {
      contactGroupId: {
        in: uniqueGroupIds,
      },
    },
    select: {
      contactGroupId: true,
      contactId: true,
      contactName: true,
    },
  });
  const contactsByGroup = new Map<string, CachedGroupContactRef[]>();
  const contactNamesById = new Map<string, string>();
  for (const row of membershipRows) {
    const existing = contactsByGroup.get(row.contactGroupId) ?? [];
    existing.push({
      contactId: row.contactId,
      contactName: row.contactName ?? null,
    });
    contactsByGroup.set(row.contactGroupId, existing);

    if (row.contactName) {
      contactNamesById.set(row.contactId, row.contactName);
    }
  }

  const uniqueContactIds = Array.from(
    new Set(membershipRows.map((row) => row.contactId))
  );
  const contactSyncCursor = await getXeroSyncCursor(
    CONTACT_SYNC_CURSOR_RESOURCE,
    DEFAULT_XERO_SYNC_SCOPE
  );
  const cachedContacts = uniqueContactIds.length
    ? await prisma.xeroContactCache.findMany({
        where: {
          contactId: {
            in: uniqueContactIds,
          },
        },
        select: {
          contactId: true,
          name: true,
          firstName: true,
          lastName: true,
          emailAddress: true,
          companyNumber: true,
          contactStatus: true,
          phoneCountryCode: true,
          phoneAreaCode: true,
          phoneNumber: true,
          streetAddressLine1: true,
          streetAddressLine2: true,
          streetCity: true,
          streetRegion: true,
          streetPostalCode: true,
          streetCountry: true,
          postalAddressLine1: true,
          postalAddressLine2: true,
          postalCity: true,
          postalRegion: true,
          postalPostalCode: true,
          postalCountry: true,
        },
      })
    : [];
  const cachedContactsById = new Map(
    cachedContacts.map((contact) => [contact.contactId, contact])
  );
  const missingContactIds = uniqueContactIds.filter(
    (contactId) => !cachedContactsById.has(contactId)
  );

  if (missingContactIds.length > 0) {
    if (!contactSyncCursor?.lastSuccessfulSyncAt && !options.allowLiveXeroFetch) {
      throw new Error(
        "Xero contact cache is empty. Run contact sync before importing members."
      );
    }

    if (!options.allowLiveXeroFetch) {
      throw new Error(
        `Xero contact cache is missing ${missingContactIds.length} contact snapshot(s). Run contact sync first, or retry the import in repair mode.`
      );
    }

    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const repairedContacts = await fetchXeroContactsByIdsFromXero({
      xero,
      tenantId,
      contactIds: missingContactIds,
      workflow: "importMembersFromXeroGroups",
      contextPrefix: "importMembersFromXeroGroups repair",
      includeArchived: true,
    });
    const repairedAt = new Date();

    for (const contact of repairedContacts) {
      const cachedContact = await upsertXeroContactCacheEntry(contact, repairedAt);
      if (cachedContact) {
        cachedContactsById.set(cachedContact.contactId, cachedContact);
      }
    }
  }

  for (const mapping of groupMappings) {
    const groupContacts = contactsByGroup.get(mapping.groupId) ?? [];
    groupsProcessed.push(mapping.groupName);
    logger.info(
      {
        groupName: mapping.groupName,
        groupContactCount: groupContacts.length,
        cachedContactCount: groupContacts.filter((groupContact) =>
          cachedContactsById.has(groupContact.contactId)
        ).length,
      },
      "Loaded cached group contacts for import"
    );

    for (const groupContact of groupContacts) {
      const contact = cachedContactsById.get(groupContact.contactId);
      if (!contact) {
        errors++;
        const contactName =
          groupContact.contactName ??
          contactNamesById.get(groupContact.contactId) ??
          groupContact.contactId;
        errorDetails.push({
          member: `${mapping.groupName}: ${contactName}`,
          error: options.allowLiveXeroFetch
            ? "Xero did not return a contact snapshot during repair, so this group member could not be imported."
            : "Missing cached Xero contact snapshot. Run contact sync first, or retry the import in repair mode.",
        });
        continue;
      }

      try {
        const contactName = getXeroContactDisplayName(contact);
        if (contact.contactStatus.toUpperCase() !== "ACTIVE") {
          skippedArchived++;
          skippedArchivedDetails.push({
            name: contactName,
            xeroContactId: contact.contactId,
            group: mapping.groupName,
            reason: `Xero contact status is ${contact.contactStatus}`,
          });
          continue;
        }

        if (!contact.emailAddress) {
          skippedNoEmail++;
          skippedNoEmailDetails.push({
            name: contactName,
            xeroContactId: contact.contactId,
          });
          continue;
        }

        const email = contact.emailAddress.toLowerCase().trim();

        const alreadyLinked = await prisma.member.findFirst({
          where: { xeroContactId: contact.contactId },
        });
        if (alreadyLinked) {
          skippedExisting++;
          continue;
        }

        const existingPrimary = await prisma.member.findFirst({
          where: { email, canLogin: true },
        });

        if (existingPrimary) {
          const contactFirstName = (contact.firstName || "")
            .toLowerCase()
            .trim();
          const contactLastName = (contact.lastName || "").toLowerCase().trim();
          const primaryFirstName = existingPrimary.firstName.toLowerCase().trim();
          const primaryLastName = existingPrimary.lastName.toLowerCase().trim();

          const isSamePerson =
            (contactFirstName === primaryFirstName &&
              contactLastName === primaryLastName) ||
            (!contactFirstName && !contactLastName);

          if (isSamePerson) {
            skippedExisting++;
            const updates: Record<string, unknown> = {};

            if (!existingPrimary.xeroContactId) {
              updates.xeroContactId = contact.contactId;
            }
            if (!existingPrimary.dateOfBirth) {
              const parsedDateOfBirth = parseXeroCompanyNumberDate(
                contact.companyNumber
              );
              if (parsedDateOfBirth) {
                updates.dateOfBirth = parsedDateOfBirth;
              }
            }
            if (!existingPrimary.phoneNumber && contact.phoneNumber) {
              updates.phoneCountryCode = contact.phoneCountryCode;
              updates.phoneAreaCode = contact.phoneAreaCode;
              updates.phoneNumber = contact.phoneNumber;
            }
            if (
              !existingPrimary.streetAddressLine1 &&
              contact.streetAddressLine1
            ) {
              updates.streetAddressLine1 = contact.streetAddressLine1;
              updates.streetAddressLine2 = contact.streetAddressLine2;
              updates.streetCity = contact.streetCity;
              updates.streetRegion = contact.streetRegion;
              updates.streetPostalCode = contact.streetPostalCode;
              updates.streetCountry = contact.streetCountry;
            }
            if (
              !existingPrimary.postalAddressLine1 &&
              contact.postalAddressLine1
            ) {
              updates.postalAddressLine1 = contact.postalAddressLine1;
              updates.postalAddressLine2 = contact.postalAddressLine2;
              updates.postalCity = contact.postalCity;
              updates.postalRegion = contact.postalRegion;
              updates.postalPostalCode = contact.postalPostalCode;
              updates.postalCountry = contact.postalCountry;
            }

            if (Object.keys(updates).length > 0) {
              await prisma.member.update({
                where: { id: existingPrimary.id },
                data: updates,
              });
              if (updates.xeroContactId) {
                linkedExisting++;
                linkedExistingDetails.push({
                  name: `${existingPrimary.firstName} ${existingPrimary.lastName}`,
                  email: existingPrimary.email,
                  memberId: existingPrimary.id,
                  xeroContactId: contact.contactId,
                  group: mapping.groupName,
                });
              }
            }
            continue;
          }

          const existingFamilyMember = await prisma.member.findFirst({
            where: {
              email,
              canLogin: false,
              firstName: {
                equals: contact.firstName || "Unknown",
                mode: "insensitive",
              },
              lastName: {
                equals: contact.lastName || "Unknown",
                mode: "insensitive",
              },
            },
          });
          if (existingFamilyMember) {
            skippedExisting++;
            if (!existingFamilyMember.xeroContactId) {
              await prisma.member.update({
                where: { id: existingFamilyMember.id },
                data: { xeroContactId: contact.contactId },
              });
              linkedExisting++;
              linkedExistingDetails.push({
                name: `${existingFamilyMember.firstName} ${existingFamilyMember.lastName}`,
                email,
                memberId: existingFamilyMember.id,
                xeroContactId: contact.contactId,
                group: mapping.groupName,
              });
            }
            continue;
          }

          let depFirstName = contact.firstName || "";
          let depLastName = contact.lastName || "";
          if (!depFirstName && !depLastName && contact.name) {
            const parts = contact.name.trim().split(/\s+/);
            depFirstName = parts[0] || "Unknown";
            depLastName = parts.slice(1).join(" ") || "Unknown";
          }
          if (!depFirstName) depFirstName = "Unknown";
          if (!depLastName) depLastName = "Unknown";

          const depDob = parseXeroCompanyNumberDate(contact.companyNumber);

          const newFamilyMember = await prisma.member.create({
            data: {
              email,
              firstName: depFirstName,
              lastName: depLastName,
              passwordHash: placeholderHash,
              ageTier: mapping.ageTier,
              dateOfBirth: depDob,
              xeroContactId: contact.contactId,
              phoneCountryCode: contact.phoneCountryCode,
              phoneAreaCode: contact.phoneAreaCode,
              phoneNumber: contact.phoneNumber,
              streetAddressLine1: contact.streetAddressLine1,
              streetAddressLine2: contact.streetAddressLine2,
              streetCity: contact.streetCity,
              streetRegion: contact.streetRegion,
              streetPostalCode: contact.streetPostalCode,
              streetCountry: contact.streetCountry,
              postalAddressLine1: contact.postalAddressLine1,
              postalAddressLine2: contact.postalAddressLine2,
              postalCity: contact.postalCity,
              postalRegion: contact.postalRegion,
              postalPostalCode: contact.postalPostalCode,
              postalCountry: contact.postalCountry,
              active: true,
              emailVerified: true,
              canLogin: false,
              inheritEmailFromId: existingPrimary.id,
            },
          });

          const existingGroup = await prisma.familyGroupMember.findFirst({
            where: { memberId: existingPrimary.id },
            select: { familyGroupId: true },
          });

          if (existingGroup) {
            await prisma.familyGroupMember
              .create({
                data: {
                  familyGroupId: existingGroup.familyGroupId,
                  memberId: newFamilyMember.id,
                  role: "MEMBER",
                },
              })
              .catch(() => {});
          } else {
            const group = await prisma.familyGroup.create({
              data: { name: `${existingPrimary.lastName} Family` },
            });
            await prisma.familyGroupMember.createMany({
              data: [
                {
                  familyGroupId: group.id,
                  memberId: existingPrimary.id,
                  role: "ADMIN",
                },
                {
                  familyGroupId: group.id,
                  memberId: newFamilyMember.id,
                  role: "MEMBER",
                },
              ],
              skipDuplicates: true,
            });
          }

          createdAsDependent++;
          createdDependents.push({
            name: `${depFirstName} ${depLastName}`,
            email,
            xeroContactId: contact.contactId,
            group: mapping.groupName,
            parentMemberId: existingPrimary.id,
            parentName: `${existingPrimary.firstName} ${existingPrimary.lastName}`,
          });
          continue;
        }

        let firstName = contact.firstName || "";
        let lastName = contact.lastName || "";
        if (!firstName && !lastName && contact.name) {
          const parts = contact.name.trim().split(/\s+/);
          firstName = parts[0] || "Unknown";
          lastName = parts.slice(1).join(" ") || "Unknown";
        }
        if (!firstName) firstName = "Unknown";
        if (!lastName) lastName = "Unknown";

        const dateOfBirth = parseXeroCompanyNumberDate(contact.companyNumber);

        const member = await prisma.member.create({
          data: {
            email,
            firstName,
            lastName,
            passwordHash: placeholderHash,
            ageTier: mapping.ageTier,
            dateOfBirth,
            xeroContactId: contact.contactId,
            phoneCountryCode: contact.phoneCountryCode,
            phoneAreaCode: contact.phoneAreaCode,
            phoneNumber: contact.phoneNumber,
            streetAddressLine1: contact.streetAddressLine1,
            streetAddressLine2: contact.streetAddressLine2,
            streetCity: contact.streetCity,
            streetRegion: contact.streetRegion,
            streetPostalCode: contact.streetPostalCode,
            streetCountry: contact.streetCountry,
            postalAddressLine1: contact.postalAddressLine1,
            postalAddressLine2: contact.postalAddressLine2,
            postalCity: contact.postalCity,
            postalRegion: contact.postalRegion,
            postalPostalCode: contact.postalPostalCode,
            postalCountry: contact.postalCountry,
            active: true,
            emailVerified: true,
          },
        });

        created++;
        createdMembers.push({
          name: `${firstName} ${lastName}`,
          email,
          xeroContactId: contact.contactId,
          group: mapping.groupName,
        });

        if (sendInvites) {
          try {
            const { token, tokenHash } = issueActionToken();
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

            await prisma.passwordResetToken.create({
              data: {
                tokenHash,
                memberId: member.id,
                expiresAt,
              },
            });

            sendPasswordResetEmail(member.email, token).catch((err) => {
              logger.error(
                { err, email: member.email },
                "Failed to send invite email during member import"
              );
            });
          } catch (emailErr) {
            logger.error(
              { err: emailErr, email: member.email },
              "Failed to create invite token during member import"
            );
          }
        }
      } catch (contactErr) {
        if (contactErr instanceof XeroDailyLimitError) throw contactErr;
        logger.error(
          { err: contactErr, contactEmail: contact.emailAddress },
          "Error processing cached contact during member import"
        );
        errors++;
        errorDetails.push({
          member: contact.name || contact.emailAddress || contact.contactId,
          error: parseXeroError(contactErr),
        });
      }
    }
  }

  return {
    created,
    createdAsDependent,
    skippedExisting,
    linkedExisting,
    skippedNoEmail,
    skippedNoEmailDetails,
    skippedArchived,
    skippedArchivedDetails,
    createdMembers,
    createdDependents,
    linkedExistingDetails,
    errors,
    errorDetails,
    groupsProcessed,
  };
}
