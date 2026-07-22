import { describe, expect, it } from "vitest";
import {
  financeAccessBadgeClass,
  financeAccessLongLabels,
  financeAccessShortLabels,
  getLifecycleStatusConfig,
  getLoginBadge,
  LOGIN_BADGE,
  NON_LOGIN_BADGE,
} from "@/lib/admin-member-badges";

describe("admin-member-badges", () => {
  it("exposes a badge class for every finance access level", () => {
    expect(financeAccessBadgeClass.NONE).toContain("muted");
    expect(financeAccessBadgeClass.VIEWER).toContain("warning");
    expect(financeAccessBadgeClass.MANAGER).toContain("success");
  });

  it("exposes both short and long finance access labels", () => {
    expect(financeAccessShortLabels.MANAGER).toBe("Manager");
    expect(financeAccessLongLabels.MANAGER).toBe("Finance Manager");
    expect(financeAccessShortLabels.NONE).toBe("None");
    expect(financeAccessLongLabels.NONE).toBe("No Finance Access");
  });

  describe("getLifecycleStatusConfig", () => {
    it("returns Archived when archivedAt is set", () => {
      const config = getLifecycleStatusConfig({
        active: true,
        cancelledAt: new Date(),
        archivedAt: new Date(),
      });
      expect(config.label).toBe("Archived");
      expect(config.className).toContain("bg-accent");
    });

    it("returns Cancelled when only cancelledAt is set", () => {
      const config = getLifecycleStatusConfig({
        active: false,
        cancelledAt: new Date(),
        archivedAt: null,
      });
      expect(config.label).toBe("Cancelled");
      expect(config.className).toContain("warning");
    });

    it("returns Active for an active member with no lifecycle flags", () => {
      const config = getLifecycleStatusConfig({
        active: true,
        cancelledAt: null,
        archivedAt: null,
      });
      expect(config.label).toBe("Active");
      expect(config.className).toContain("success");
    });

    it("returns Inactive when active is false and no lifecycle flags are set", () => {
      const config = getLifecycleStatusConfig({
        active: false,
        cancelledAt: null,
        archivedAt: null,
      });
      expect(config.label).toBe("Inactive");
      expect(config.className).toBe("");
    });

    it("accepts ISO strings for cancelledAt and archivedAt", () => {
      const config = getLifecycleStatusConfig({
        active: false,
        cancelledAt: "2026-05-25T00:00:00.000Z",
        archivedAt: null,
      });
      expect(config.label).toBe("Cancelled");
    });
  });

  describe("getLoginBadge", () => {
    it("returns the can-login badge when canLogin is true", () => {
      expect(getLoginBadge(true)).toEqual(LOGIN_BADGE);
    });

    it("returns the non-login badge when canLogin is false", () => {
      expect(getLoginBadge(false)).toEqual(NON_LOGIN_BADGE);
    });
  });
});
