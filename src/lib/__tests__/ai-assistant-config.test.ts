import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getIntegrationCredentialValue: vi.fn(),
  providerNeedsReentry: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: mocks.getIntegrationCredentialValue,
  providerNeedsReentry: mocks.providerNeedsReentry,
}));

import {
  getAiAssistantAvailability,
  getAiAssistantSetupState,
  getOperationalAnthropicApiKey,
} from "@/lib/ai-assistant-config";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOperationalAnthropicApiKey", () => {
  it("returns the key when configured", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue("sk-ant-xyz");
    expect(await getOperationalAnthropicApiKey()).toBe("sk-ant-xyz");
  });

  it("returns undefined when not configured / needs re-entry (null value)", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    expect(await getOperationalAnthropicApiKey()).toBeUndefined();
  });
});

describe("getAiAssistantSetupState", () => {
  it("is not_configured with no stored row", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.providerNeedsReentry.mockResolvedValue(false);
    expect(await getAiAssistantSetupState()).toEqual({
      state: "not_configured",
      keySetAt: null,
    });
  });

  it("is saved when a row exists and decrypts", async () => {
    mocks.findUnique.mockResolvedValue({
      updatedAt: new Date("2026-07-23T10:00:00.000Z"),
    });
    mocks.providerNeedsReentry.mockResolvedValue(false);
    expect(await getAiAssistantSetupState()).toEqual({
      state: "saved",
      keySetAt: "2026-07-23T10:00:00.000Z",
    });
  });

  it("is needs_reentry when a stored row fails GCM", async () => {
    mocks.findUnique.mockResolvedValue({
      updatedAt: new Date("2026-07-23T10:00:00.000Z"),
    });
    mocks.providerNeedsReentry.mockResolvedValue(true);
    const state = await getAiAssistantSetupState();
    expect(state.state).toBe("needs_reentry");
  });
});

describe("getAiAssistantAvailability", () => {
  it("is false when the module is off (no key read attempted)", async () => {
    expect(await getAiAssistantAvailability({ aiAssistant: false })).toBe(false);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("is false when the module is on but the key is not saved", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.providerNeedsReentry.mockResolvedValue(false);
    expect(await getAiAssistantAvailability({ aiAssistant: true })).toBe(false);
  });

  it("is true only when the module is on AND the key is saved", async () => {
    mocks.findUnique.mockResolvedValue({
      updatedAt: new Date("2026-07-23T10:00:00.000Z"),
    });
    mocks.providerNeedsReentry.mockResolvedValue(false);
    expect(await getAiAssistantAvailability({ aiAssistant: true })).toBe(true);
  });
});
