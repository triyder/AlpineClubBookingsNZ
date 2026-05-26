import { describe, expect, it } from "vitest"
import {
  collapsibleMemberSections,
  dedupeParentOptions,
  formatAdminName,
  formatMemberAuditLogSummary,
  formatMemberDateNz,
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
      expect(getMemberDetailBackLabel("/admin/bookings")).toBe("Back to Bookings")
      expect(getMemberDetailBackLabel("/admin/payments/123")).toBe("Back to Payments")
      expect(getMemberDetailBackLabel("/admin/subscriptions")).toBe("Back to Subscriptions")
      expect(getMemberDetailBackLabel("/admin/refund-requests")).toBe("Back to Refund Requests")
      expect(getMemberDetailBackLabel("/admin/xero/health")).toBe("Back to Xero")
    })

    it("defaults to Members for unknown paths", () => {
      expect(getMemberDetailBackLabel("/admin/something-else")).toBe("Back to Members")
      expect(getMemberDetailBackLabel("/")).toBe("Back to Members")
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
        formatPromoBenefit({ type: "PERCENTAGE", percentOff: 15, valueCents: null, freeNightsPerIndividual: null })
      ).toBe("15% off per individual")
      expect(
        formatPromoBenefit({ type: "PERCENTAGE", percentOff: null, valueCents: null, freeNightsPerIndividual: null })
      ).toBe("Percentage discount")
    })

    it("formats fixed amount as dollars", () => {
      expect(
        formatPromoBenefit({ type: "FIXED_AMOUNT", percentOff: null, valueCents: 2550, freeNightsPerIndividual: null })
      ).toBe("$25.50 off per individual")
      expect(
        formatPromoBenefit({ type: "FIXED_AMOUNT", percentOff: null, valueCents: null, freeNightsPerIndividual: null })
      ).toBe("Fixed discount")
    })

    it("formats free nights with correct singular and plural", () => {
      expect(
        formatPromoBenefit({ type: "FREE_NIGHTS", percentOff: null, valueCents: null, freeNightsPerIndividual: 1 })
      ).toBe("1 free night per individual")
      expect(
        formatPromoBenefit({ type: "FREE_NIGHTS", percentOff: null, valueCents: null, freeNightsPerIndividual: 3 })
      ).toBe("3 free nights per individual")
      expect(
        formatPromoBenefit({ type: "FREE_NIGHTS", percentOff: null, valueCents: null, freeNightsPerIndividual: null })
      ).toBe("Free nights")
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
      expect(collapsibleMemberSections).toEqual(["subs", "bookings", "xero", "audit"])
      for (const section of collapsibleMemberSections) {
        expect(memberSectionStorageKeys[section]).toMatch(/^admin-member-section:/)
      }
    })

    it("isCollapsibleMemberSection narrows correctly", () => {
      expect(isCollapsibleMemberSection("subs")).toBe(true)
      expect(isCollapsibleMemberSection("xero")).toBe(true)
      expect(isCollapsibleMemberSection("not-a-section")).toBe(false)
    })
  })

  describe("formatMemberDateNz", () => {
    it("formats a date as a short NZ date", () => {
      expect(formatMemberDateNz("2026-05-01T12:00:00.000Z")).toMatch(/May 2026/)
    })
  })
})
