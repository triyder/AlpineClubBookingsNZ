import {
  EMAIL_TEMPLATE_DEFINITIONS,
  EMAIL_TEMPLATE_KEYS,
  isAdminSystemTemplate,
} from "@/lib/email-message-registry";
import { prisma } from "@/lib/prisma";

type DeleteManyResult = { count: number };
type EmailMessageMaintenanceStore = {
  emailTemplateOverride?: {
    deleteMany: (args: unknown) => Promise<DeleteManyResult>;
  };
  notificationDeliveryPolicy?: {
    deleteMany: (args: unknown) => Promise<DeleteManyResult>;
  };
};

const CURRENT_ADMIN_SYSTEM_TEMPLATE_KEYS = EMAIL_TEMPLATE_DEFINITIONS
  .filter((definition) => isAdminSystemTemplate(definition.key))
  .map((definition) => definition.key);

export async function deleteStaleEmailTemplateOverrides(
  store: EmailMessageMaintenanceStore =
    prisma as unknown as EmailMessageMaintenanceStore,
) {
  const delegate = store.emailTemplateOverride;
  if (!delegate) return { count: 0 };

  return delegate.deleteMany({
    where: {
      templateName: { notIn: EMAIL_TEMPLATE_KEYS },
    },
  });
}

export async function deleteStaleNotificationDeliveryPolicies(
  store: EmailMessageMaintenanceStore =
    prisma as unknown as EmailMessageMaintenanceStore,
) {
  const delegate = store.notificationDeliveryPolicy;
  if (!delegate) return { count: 0 };

  return delegate.deleteMany({
    where: {
      templateName: { notIn: CURRENT_ADMIN_SYSTEM_TEMPLATE_KEYS },
    },
  });
}

export async function deleteStaleEmailMessageAdminRows(
  store: EmailMessageMaintenanceStore =
    prisma as unknown as EmailMessageMaintenanceStore,
) {
  const [templateOverrides, deliveryPolicies] = await Promise.all([
    deleteStaleEmailTemplateOverrides(store),
    deleteStaleNotificationDeliveryPolicies(store),
  ]);

  return {
    staleTemplateOverridesDeleted: templateOverrides.count,
    staleDeliveryPoliciesDeleted: deliveryPolicies.count,
  };
}
