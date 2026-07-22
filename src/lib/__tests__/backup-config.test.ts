import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    integrationCredential: {
      findMany: vi.fn(),
    },
  },
  getIntegrationCredentialValue: vi.fn(),
  providerNeedsReentry: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: mocks.getIntegrationCredentialValue,
  providerNeedsReentry: mocks.providerNeedsReentry,
}));

import {
  BACKUP_CREDENTIAL_KEYS,
  DEFAULT_BACKUP_REGION,
  DEFAULT_BACKUP_RETENTION_DAYS,
  getBackupSetupState,
  isValidS3Bucket,
  isValidS3Region,
  parseRetentionDays,
  resolveBackupConfig,
} from "@/lib/backup-config";

describe("backup-config validators", () => {
  it("accepts valid S3 bucket names and rejects malformed ones", () => {
    expect(isValidS3Bucket("my-club-backups")).toBe(true);
    expect(isValidS3Bucket("club.backups.2026")).toBe(true);
    expect(isValidS3Bucket("AB")).toBe(false); // too short + uppercase
    expect(isValidS3Bucket("UPPER")).toBe(false);
    expect(isValidS3Bucket("has space")).toBe(false);
    expect(isValidS3Bucket("dots..double")).toBe(false);
    expect(isValidS3Bucket("192.168.0.1")).toBe(false);
    expect(isValidS3Bucket("-startshyphen")).toBe(false);
  });

  it("accepts valid AWS regions and rejects malformed ones", () => {
    expect(isValidS3Region("ap-southeast-2")).toBe(true);
    expect(isValidS3Region("us-east-1")).toBe(true);
    expect(isValidS3Region("Bad Region")).toBe(false);
    expect(isValidS3Region("us_east_1")).toBe(false);
    expect(isValidS3Region("")).toBe(false);
  });

  it("clamps retention days to a sane range", () => {
    expect(parseRetentionDays("7")).toBe(7);
    expect(parseRetentionDays("0")).toBe(1);
    expect(parseRetentionDays("99999")).toBe(3650);
    expect(parseRetentionDays("")).toBe(DEFAULT_BACKUP_RETENTION_DAYS);
    expect(parseRetentionDays("not-a-number")).toBe(DEFAULT_BACKUP_RETENTION_DAYS);
  });
});

describe("resolveBackupConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerNeedsReentry.mockResolvedValue(false);
  });

  function valueMap(values: Record<string, string | null>) {
    mocks.getIntegrationCredentialValue.mockImplementation(
      async (_provider: string, key: string) => values[key] ?? null,
    );
  }

  it("resolves a fully configured backup", async () => {
    valueMap({
      [BACKUP_CREDENTIAL_KEYS.enabled]: "true",
      [BACKUP_CREDENTIAL_KEYS.bucket]: "my-backups",
      [BACKUP_CREDENTIAL_KEYS.region]: "us-east-1",
      [BACKUP_CREDENTIAL_KEYS.retentionDays]: "14",
      [BACKUP_CREDENTIAL_KEYS.accessKeyId]: "AKIA",
      [BACKUP_CREDENTIAL_KEYS.secretAccessKey]: "secret",
      [BACKUP_CREDENTIAL_KEYS.restoreValidationUrl]: "postgresql://x/shadow",
    });

    await expect(resolveBackupConfig()).resolves.toEqual({
      enabled: true,
      bucket: "my-backups",
      region: "us-east-1",
      retentionDays: 14,
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      restoreValidationUrl: "postgresql://x/shadow",
      needsReentry: false,
    });
  });

  it("applies defaults when unconfigured", async () => {
    valueMap({});

    await expect(resolveBackupConfig()).resolves.toEqual({
      enabled: false,
      bucket: null,
      region: DEFAULT_BACKUP_REGION,
      retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
      accessKeyId: null,
      secretAccessKey: null,
      restoreValidationUrl: null,
      needsReentry: false,
    });
  });

  it("flags needsReentry when a stored credential fails to decrypt", async () => {
    valueMap({ [BACKUP_CREDENTIAL_KEYS.enabled]: "true" });
    mocks.providerNeedsReentry.mockResolvedValue(true);

    const config = await resolveBackupConfig();
    expect(config.needsReentry).toBe(true);
  });
});

describe("getBackupSetupState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerNeedsReentry.mockResolvedValue(false);
  });

  it("reports metadata only and computes durability", async () => {
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([
      { key: BACKUP_CREDENTIAL_KEYS.enabled },
      { key: BACKUP_CREDENTIAL_KEYS.bucket },
      { key: BACKUP_CREDENTIAL_KEYS.accessKeyId },
      { key: BACKUP_CREDENTIAL_KEYS.secretAccessKey },
    ]);
    mocks.getIntegrationCredentialValue.mockImplementation(
      async (_provider: string, key: string) => {
        const values: Record<string, string> = {
          [BACKUP_CREDENTIAL_KEYS.enabled]: "true",
          [BACKUP_CREDENTIAL_KEYS.bucket]: "my-backups",
          [BACKUP_CREDENTIAL_KEYS.accessKeyId]: "AKIA",
          [BACKUP_CREDENTIAL_KEYS.secretAccessKey]: "secret",
        };
        return values[key] ?? null;
      },
    );

    const state = await getBackupSetupState();
    expect(state).toMatchObject({
      enabled: true,
      bucket: "my-backups",
      accessKeyIdSet: true,
      secretAccessKeySet: true,
      restoreValidationUrlSet: false,
      durable: true,
      needsReentry: false,
    });
    // Never leaks secret values — only booleans/non-secret destination.
    expect(state).not.toHaveProperty("accessKeyId");
    expect(state).not.toHaveProperty("secretAccessKey");
  });

  it("is not durable without both S3 secrets", async () => {
    mocks.prisma.integrationCredential.findMany.mockResolvedValue([
      { key: BACKUP_CREDENTIAL_KEYS.enabled },
      { key: BACKUP_CREDENTIAL_KEYS.bucket },
    ]);
    mocks.getIntegrationCredentialValue.mockImplementation(
      async (_provider: string, key: string) =>
        key === BACKUP_CREDENTIAL_KEYS.bucket ? "my-backups" : null,
    );

    const state = await getBackupSetupState();
    expect(state.durable).toBe(false);
  });
});
