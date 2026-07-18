import { describe, expect, it } from "vitest"
import {
  collapsibleMemberSections,
  dedupeParentOptions,
  formatAdminName,
  formatMemberAccountPreview,
  formatMemberAuditLogSummary,
  formatMemberCommitteePreview,
  formatMemberContactPreview,
  formatMemberDateNz,
  formatMemberFamilyPreview,
  formatMemberFinancePreview,
  formatMemberHistoryPreview,
  formatMemberLifecyclePreview,
  formatMemberMembershipPreview,
  formatMemberPhone,
  formatPromoBenefit,
  getAuditActorDisplayName,
  getMemberDetailBackLabel,
  getMissingFieldsForXeroCreate,
  isCollapsibleMemberSection,
  memberSectionStorageKeys,
  memberUsesSamePostalAddress,
  parentLinkTypeLabel,
  parseInviteAuditDetails,
  shouldDefaultLinkSideEffects,
} from "@/lib/admin-member-detail-helpers"

describe("admin-member-detail-helpers", () => {
  describe("getMemberDetailBackLabel", () => {
    it("returns context-specific label for known return paths", () => {
      expect(getMemberDetailBackLabel("/admin/bookings")).toBe("Bookings")
      expect(getMemberDetailBackLabel("/admin/payments/123")).toBe("Payments")
      expect(getMemberDetailBackLabel("/admin/subscriptions")).toBe("Subscriptions")
      expect(getMemberDetailBackLabel("/admin/refund-requests")).toBe("Refund Requests")
      expect(getMemberDetailBackLabel("/admin/xero/health")).toBe("Xero")
    })

    it("defaults to Members for unknown paths", () => {
      expect(getMemberDetailBackLabel("/admin/something-else")).toBe("Members")
      expect(getMemberDetailBackLabel("/")).toBe("Members")
    })
  })

  describe("formatAdminName", () => {
    it("formats first and last name", () => {
      expect(formatAdminName({ id: "1", firstName: "Ada", lastName: "Admin" })).toBe("Ada Admin")
    })
    it("returns Unknown admin when null", () => {
      expect(formatAdminName(null)).toBe("Unknown admin")
      expect(formatAdminName(undefined)).toBe("Unknown admin")
    })
  })

  describe("parseInviteAuditDetails", () => {
    it("returns null when details is empty", () => {
      expect(parseInviteAuditDetails(null)).toBeNull()
      expect(parseInviteAuditDetails("")).toBeNull()
    })

    it("returns null when JSON is invalid", () => {
      expect(parseInviteAuditDetails("not json")).toBeNull()
    })

    it("parses structured invite details", () => {
      const json = JSON.stringify({ recipientEmail: "x@y.com", kind: "invite" })
      expect(parseInviteAuditDetails(json)).toEqual({ recipientEmail: "x@y.com", kind: "invite" })
    })

    it("returns null when JSON does not yield an object", () => {
      expect(parseInviteAuditDetails(JSON.stringify(null))).toBeNull()
    })
  })

  describe("getAuditActorDisplayName", () => {
    it("falls back to System when actor is missing", () => {
      expect(getAuditActorDisplayName(null)).toBe("System")
      expect(getAuditActorDisplayName(undefined)).toBe("System")
    })

    it("uses full name when present", () => {
      expect(
        getAuditActorDisplayName({ id: "1", firstName: "Ada", lastName: "Admin", email: "ada@example.com" })
      ).toBe("Ada Admin")
    })

    it("falls back to email when name is empty", () => {
      expect(
        getAuditActorDisplayName({ id: "1", firstName: "", lastName: "", email: "ada@example.com" })
      ).toBe("ada@example.com")
    })
  })

  describe("formatMemberAuditLogSummary", () => {
    it("formats setup invite rows with recipient and actor", () => {
      const result = formatMemberAuditLogSummary(
        {
          id: "audit-1",
          action: "member.setup-invite-sent",
          createdAt: "2026-05-01T12:00:00.000Z",
          details: JSON.stringify({ recipientEmail: "alice@example.com" }),
          actor: { id: "admin-1", firstName: "Ada", lastName: "Admin", email: "ada@example.com" },
        },
        "1 May 2026, 12:00 pm"
      )
      expect(result).toBe("Invited via email to alice@example.com on 1 May 2026, 12:00 pm by Ada Admin")
    })

    it("formats password reset rows", () => {
      const result = formatMemberAuditLogSummary(
        {
          id: "audit-2",
          action: "member.password-reset-sent",
          createdAt: "2026-05-02T12:00:00.000Z",
          details: JSON.stringify({ recipientEmail: "bob@example.com" }),
          actor: null,
        },
        "2 May 2026, 12:00 pm"
      )
      expect(result).toBe("Password reset sent to bob@example.com on 2 May 2026, 12:00 pm by System")
    })

    it("falls back to the raw action name when details are missing", () => {
      const result = formatMemberAuditLogSummary(
        {
          id: "audit-3",
          action: "member.something-else",
          createdAt: "2026-05-03T12:00:00.000Z",
          details: null,
          actor: null,
        },
        "3 May 2026, 12:00 pm"
      )
      expect(result).toBe("member.something-else")
    })
  })

  describe("shouldDefaultLinkSideEffects", () => {
    it("returns false for ADULT", () => {
      expect(shouldDefaultLinkSideEffects("ADULT")).toBe(false)
    })
    it("returns true for non-adult tiers", () => {
      expect(shouldDefaultLinkSideEffects("CHILD")).toBe(true)
      expect(shouldDefaultLinkSideEffects("INFANT")).toBe(true)
      expect(shouldDefaultLinkSideEffects("YOUTH")).toBe(true)
    })
  })

  describe("parentLinkTypeLabel", () => {
    it("returns Second parent for SECONDARY", () => {
      expect(parentLinkTypeLabel("SECONDARY")).toBe("Second parent")
    })
    it("returns Primary parent for PRIMARY or undefined", () => {
      expect(parentLinkTypeLabel("PRIMARY")).toBe("Primary parent")
      expect(parentLinkTypeLabel(undefined)).toBe("Primary parent")
    })
  })

  describe("dedupeParentOptions", () => {
    it("removes duplicates by id, keeping first occurrence", () => {
      const result = dedupeParentOptions([
        { id: "a", label: "first" },
        { id: "b", label: "other" },
        { id: "a", label: "duplicate" },
      ])
      expect(result.map((entry) => entry.label)).toEqual(["first", "other"])
    })
  })

  describe("formatPromoBenefit", () => {
    it("formats percentage", () => {
      expect(
        formatPromoBenefit({ type: "PERCENTAGE", percentOff: 15, valueCents: null, freeNightsPerIndividual: null, lifetimeFreeNightsCap: null })
      ).toBe("15% off per individual")
      expect(
        formatPromoBenefit({ type: "PERCENTAGE", percentOff: null, valueCents: null, freeNightsPerIndividual: null, lifetimeFreeNightsCap: null })
      ).toBe("Percentage discount")
    })

    it("formats fixed amount as dollars", () => {
      expect(
        formatPromoBenefit({ type: "FIXED_AMOUNT", percentOff: null, valueCents: 2550, freeNightsPerIndividual: null, lifetimeFreeNightsCap: null })
      ).toBe("$25.50 off per individual")
      expect(
        formatPromoBenefit({ type: "FIXED_AMOUNT", percentOff: null, valueCents: null, freeNightsPerIndividual: null, lifetimeFreeNightsCap: null })
      ).toBe("Fixed discount")
    })

    it("formats free nights with correct singular and plural", () => {
      expect(
        formatPromoBenefit({ type: "FREE_NIGHTS", percentOff: null, valueCents: null, freeNightsPerIndividual: 1, lifetimeFreeNightsCap: null })
      ).toBe("1 free night per booking")
      expect(
        formatPromoBenefit({ type: "FREE_NIGHTS", percentOff: null, valueCents: null, freeNightsPerIndividual: 3, lifetimeFreeNightsCap: null })
      ).toBe("3 free nights per booking")
      expect(
        formatPromoBenefit({ type: "FREE_NIGHTS", percentOff: null, valueCents: null, freeNightsPerIndividual: null, lifetimeFreeNightsCap: null })
      ).toBe("Free nights")
    })

    it("appends lifetime cap when set", () => {
      expect(
        formatPromoBenefit({ type: "FREE_NIGHTS", percentOff: null, valueCents: null, freeNightsPerIndividual: 1, lifetimeFreeNightsCap: 4 })
      ).toBe("1 free night per booking · 4 lifetime")
    })
  })

  describe("memberUsesSamePostalAddress", () => {
    it("returns true when postal is empty but a physical address exists", () => {
      const result = memberUsesSamePostalAddress({
        streetAddressLine1: "1 Main Rd",
        streetAddressLine2: null,
        streetCity: "Wellington",
        streetRegion: null,
        streetPostalCode: "6011",
        streetCountry: null,
        postalAddressLine1: null,
        postalAddressLine2: null,
        postalCity: null,
        postalRegion: null,
        postalPostalCode: null,
        postalCountry: null,
      })
      expect(result).toBe(true)
    })

    it("returns true for a fully blank new address", () => {
      const result = memberUsesSamePostalAddress({
        streetAddressLine1: null,
        streetAddressLine2: null,
        streetCity: null,
        streetRegion: null,
        streetPostalCode: null,
        streetCountry: null,
        postalAddressLine1: null,
        postalAddressLine2: null,
        postalCity: null,
        postalRegion: null,
        postalPostalCode: null,
        postalCountry: null,
      })
      expect(result).toBe(true)
    })

    it("returns false when postal differs from physical", () => {
      const result = memberUsesSamePostalAddress({
        streetAddressLine1: "1 Main Rd",
        streetAddressLine2: null,
        streetCity: "Wellington",
        streetRegion: "Wellington",
        streetPostalCode: "6011",
        streetCountry: "New Zealand",
        postalAddressLine1: "PO Box 99",
        postalAddressLine2: null,
        postalCity: "Wellington",
        postalRegion: "Wellington",
        postalPostalCode: "6140",
        postalCountry: "New Zealand",
      })
      expect(result).toBe(false)
    })
  })

  describe("getMissingFieldsForXeroCreate", () => {
    const completeForm = {
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "1234567",
      dateOfBirth: "1990-01-15",
      joinedDate: "2024-05-01",
      streetAddressLine1: "1 Main Rd",
      streetCity: "Wellington",
      streetRegion: "Wellington",
      streetPostalCode: "6011",
      streetCountry: "New Zealand",
      postalAddressLine1: "1 Main Rd",
      postalCity: "Wellington",
      postalRegion: "Wellington",
      postalPostalCode: "6011",
      postalCountry: "New Zealand",
    }

    it("returns an empty array when all required fields are present", () => {
      expect(getMissingFieldsForXeroCreate(completeForm)).toEqual([])
    })

    it("flags missing first and last names", () => {
      expect(
        getMissingFieldsForXeroCreate({ ...completeForm, firstName: "", lastName: "" })
      ).toContain("First Name")
      expect(
        getMissingFieldsForXeroCreate({ ...completeForm, firstName: "", lastName: "" })
      ).toContain("Last Name")
    })

    it("requires all three phone parts", () => {
      expect(
        getMissingFieldsForXeroCreate({ ...completeForm, phoneAreaCode: "" })
      ).toContain("Phone")
    })

    it("flags missing physical and postal addresses", () => {
      const missing = getMissingFieldsForXeroCreate({
        ...completeForm,
        streetAddressLine1: "",
        postalCity: "",
      })
      expect(missing).toContain("Physical Address")
      expect(missing).toContain("Postal Address")
    })
  })

  describe("collapsible section keys", () => {
    it("exports stable storage keys for each collapsible section", () => {
      expect(collapsibleMemberSections).toEqual([
        "contact",
        "account",
        "family",
        "membership",
        "finance",
        "committee",
        "history",
        "lifecycle",
      ])
      for (const section of collapsibleMemberSections) {
        expect(memberSectionStorageKeys[section]).toBe(
          `admin-member-section:${section}`
        )
      }
    })

    it("isCollapsibleMemberSection narrows correctly", () => {
      expect(isCollapsibleMemberSection("contact")).toBe(true)
      expect(isCollapsibleMemberSection("finance")).toBe(true)
      // Retired pre-grouping section ids no longer narrow.
      expect(isCollapsibleMemberSection("subs")).toBe(false)
      expect(isCollapsibleMemberSection("not-a-section")).toBe(false)
    })
  })

  describe("group preview lines", () => {
    it("formats a phone from its parts", () => {
      expect(
        formatMemberPhone({
          phoneCountryCode: "64",
          phoneAreaCode: "27",
          phoneNumber: "5551234",
        })
      ).toBe("+64 27 5551234")
      expect(
        formatMemberPhone({
          phoneCountryCode: null,
          phoneAreaCode: null,
          phoneNumber: null,
        })
      ).toBeNull()
    })

    it("builds the contact preview from available parts", () => {
      expect(
        formatMemberContactPreview({
          email: "jane@example.com",
          phoneCountryCode: "64",
          phoneAreaCode: "27",
          phoneNumber: "5551234",
          streetCity: "Hamilton",
        })
      ).toBe("jane@example.com · +64 27 5551234 · Hamilton")
      expect(
        formatMemberContactPreview({
          email: "jane@example.com",
          phoneCountryCode: null,
          phoneAreaCode: null,
          phoneNumber: null,
          streetCity: null,
        })
      ).toBe("jane@example.com")
    })

    it("summarises account state, hiding role counts for no-login members", () => {
      expect(
        formatMemberAccountPreview({
          canLogin: true,
          accessRoleCount: 2,
          active: true,
        })
      ).toBe("Can log in · 2 roles · Active")
      expect(
        formatMemberAccountPreview({
          canLogin: false,
          accessRoleCount: 0,
          active: false,
        })
      ).toBe("No login · Inactive")
    })

    it("summarises family links and falls back to None", () => {
      expect(
        formatMemberFamilyPreview({
          parentCount: 1,
          dependentCount: 2,
          familyGroupCount: 1,
        })
      ).toBe("1 parent · 2 dependents · 1 family group")
      expect(
        formatMemberFamilyPreview({
          parentCount: 0,
          dependentCount: 0,
          familyGroupCount: 0,
        })
      ).toBe("None")
    })

    it("summarises the current-season membership", () => {
      expect(
        formatMemberMembershipPreview({
          currentSeasonYear: 2026,
          currentSeasonTypeName: "Full Member",
          currentSeasonSubscriptionLabel: "Paid",
        })
      ).toBe("2026/2027: Full Member · Paid")
      expect(
        formatMemberMembershipPreview({
          currentSeasonYear: 2026,
          currentSeasonTypeName: null,
          currentSeasonSubscriptionLabel: null,
        })
      ).toBe("2026/2027: No seasonal type set")
    })

    it("summarises finance state with a loading placeholder", () => {
      expect(
        formatMemberFinancePreview({
          creditBalanceCents: 4050,
          promoCodeCount: 1,
          xeroLinked: true,
        })
      ).toBe("Credit $40.50 · 1 promo code · Xero linked")
      expect(
        formatMemberFinancePreview({
          creditBalanceCents: null,
          promoCodeCount: 0,
          xeroLinked: false,
        })
      ).toBe("Credit — · Not linked to Xero")
    })

    it("summarises committee assignments", () => {
      expect(formatMemberCommitteePreview({ assignmentCount: 3 })).toBe(
        "3 assignments"
      )
      expect(formatMemberCommitteePreview({ assignmentCount: 0 })).toBe("None")
    })

    it("summarises booking history", () => {
      expect(
        formatMemberHistoryPreview({
          totalBookings: 12,
          lastStay: "2026-07-04T00:00:00.000Z",
        })
      ).toMatch(/^12 bookings · last stay /)
      expect(
        formatMemberHistoryPreview({ totalBookings: 0, lastStay: null })
      ).toBe("0 bookings")
    })

    it("summarises lifecycle status with pending delete flag", () => {
      expect(
        formatMemberLifecyclePreview({
          active: true,
          cancelledAt: null,
          archivedAt: null,
          hasPendingDeleteRequest: false,
        })
      ).toBe("Active")
      expect(
        formatMemberLifecyclePreview({
          active: false,
          cancelledAt: "2026-01-01T00:00:00.000Z",
          archivedAt: "2026-02-01T00:00:00.000Z",
          hasPendingDeleteRequest: true,
        })
      ).toBe("Archived · delete requested")
    })
  })

  describe("formatMemberDateNz", () => {
    it("formats a date as a short NZ date", () => {
      expect(formatMemberDateNz("2026-05-01T12:00:00.000Z")).toMatch(/May 2026/)
    })
  })
})
