import {
  EMAIL_TEMPLATE_DEFINITIONS,
  EMAIL_TEMPLATE_KEY_SET,
  getDefaultDeliveryMode,
  isAdminSystemTemplate,
  type NotificationDeliveryModeValue,
} from "@/lib/email-message-registry";
import { prisma } from "@/lib/prisma";

export interface NotificationDeliveryPolicyRecord {
  templateName: string;
  mode: "ALWAYS" | "CONTENT_ONLY" | "DISABLED";
  updatedAt?: Date | string | null;
  updatedByMemberId?: string | null;
}

export interface NotificationDeliveryPolicyPayload {
  templateName: string;
  label: string;
  mode: NotificationDeliveryModeValue;
  defaultMode: NotificationDeliveryModeValue;
  deliveryEditable: boolean;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

export interface StaleNotificationDeliveryPolicyPayload {
  templateName: string;
  mode: NotificationDeliveryModeValue;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

export interface NotificationDeliveryPolicyListPayload {
  policies: NotificationDeliveryPolicyPayload[];
  stalePolicyCount: number;
  stalePolicies: StaleNotificationDeliveryPolicyPayload[];
}

function modeFromDb(
  value: NotificationDeliveryPolicyRecord["mode"] | null | undefined,
  fallback: NotificationDeliveryModeValue,
): NotificationDeliveryModeValue {
  if (value === "ALWAYS") return "always";
  if (value === "CONTENT_ONLY") return "content_only";
  if (value === "DISABLED") return "disabled";
  return fallback;
}

export function modeToDb(
  value: NotificationDeliveryModeValue,
): NotificationDeliveryPolicyRecord["mode"] {
  if (value === "content_only") return "CONTENT_ONLY";
  if (value === "disabled") return "DISABLED";
  return "ALWAYS";
}

function serializedUpdatedAt(record: { updatedAt?: Date | string | null }) {
  return record.updatedAt instanceof Date
    ? record.updatedAt.toISOString()
    : record.updatedAt ?? null;
}

async function loadPolicyRecords(): Promise<NotificationDeliveryPolicyRecord[]> {
  const delegate = (prisma as unknown as {
    notificationDeliveryPolicy?: {
      findMany: (args?: unknown) => Promise<NotificationDeliveryPolicyRecord[]>;
    };
  }).notificationDeliveryPolicy;

  if (!delegate) return [];

  try {
    return await delegate.findMany();
  } catch {
    return [];
  }
}

export async function listNotificationDeliveryPolicies(): Promise<
  NotificationDeliveryPolicyPayload[]
> {
  return (await listNotificationDeliveryPolicySettings()).policies;
}

export async function listNotificationDeliveryPolicySettings(): Promise<
  NotificationDeliveryPolicyListPayload
> {
  const records = await loadPolicyRecords();
  const stalePolicies = records
    .filter(
      (record) =>
        !EMAIL_TEMPLATE_KEY_SET.has(record.templateName) ||
        !isAdminSystemTemplate(record.templateName),
    )
    .map((record) => ({
      templateName: record.templateName,
      mode: modeFromDb(record.mode, getDefaultDeliveryMode(record.templateName)),
      updatedAt: serializedUpdatedAt(record),
      updatedByMemberId: record.updatedByMemberId ?? null,
    }));
  const byTemplate = new Map(
    records
      .filter(
        (record) =>
          EMAIL_TEMPLATE_KEY_SET.has(record.templateName) &&
          isAdminSystemTemplate(record.templateName),
      )
      .map((record) => [record.templateName, record]),
  );

  const policies = EMAIL_TEMPLATE_DEFINITIONS
    .filter((definition) => isAdminSystemTemplate(definition.key))
    .map((definition) => {
      const record = byTemplate.get(definition.key);
      const defaultMode = definition.defaultDeliveryMode;
      return {
        templateName: definition.key,
        label: definition.label,
        mode: modeFromDb(record?.mode, defaultMode),
        defaultMode,
        deliveryEditable: definition.deliveryEditable,
        updatedAt: record ? serializedUpdatedAt(record) : null,
        updatedByMemberId: record?.updatedByMemberId ?? null,
      };
    });

  return {
    policies,
    stalePolicyCount: stalePolicies.length,
    stalePolicies,
  };
}

export async function getNotificationDeliveryMode(
  templateName: string,
): Promise<NotificationDeliveryModeValue> {
  const delegate = (prisma as unknown as {
    notificationDeliveryPolicy?: {
      findUnique: (args: unknown) => Promise<NotificationDeliveryPolicyRecord | null>;
    };
  }).notificationDeliveryPolicy;

  const fallback = getDefaultDeliveryMode(templateName);
  if (!delegate) return fallback;

  try {
    const record = await delegate.findUnique({ where: { templateName } });
    return modeFromDb(record?.mode, fallback);
  } catch {
    return fallback;
  }
}

export async function shouldSendAdminSystemEmail({
  templateName,
  hasContent = true,
}: {
  templateName: string;
  hasContent?: boolean;
}): Promise<{ send: boolean; mode: NotificationDeliveryModeValue; reason?: string }> {
  if (!isAdminSystemTemplate(templateName)) {
    return { send: true, mode: "always" };
  }

  const mode = await getNotificationDeliveryMode(templateName);
  if (mode === "disabled") {
    return { send: false, mode, reason: "disabled" };
  }
  if (mode === "content_only" && !hasContent) {
    return { send: false, mode, reason: "no_content" };
  }
  return { send: true, mode };
}
