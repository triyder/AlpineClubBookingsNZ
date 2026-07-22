import { DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS } from "@/config/club-settings-defaults";
import { addDaysDateOnly, formatDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

export const INTERNET_BANKING_PAYMENT_SETTINGS_ID = "default";

export interface InternetBankingPaymentSettingsValues {
  holdBedSlots: boolean;
  holdDays: number;
  minimumDaysBeforeCheckIn: number;
}

export interface InternetBankingLeadTimeResult {
  allowed: boolean;
  minimumDaysBeforeCheckIn: number;
  unavailableReason: string | null;
  checkIn: string | null;
  today: string;
}

export function normalizeInternetBankingPaymentSettings(
  record: Partial<InternetBankingPaymentSettingsValues> | null | undefined,
): InternetBankingPaymentSettingsValues {
  return {
    holdBedSlots: record?.holdBedSlots ?? DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS.holdBedSlots,
    holdDays: record?.holdDays ?? DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS.holdDays,
    minimumDaysBeforeCheckIn:
      record?.minimumDaysBeforeCheckIn ??
      DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS.minimumDaysBeforeCheckIn,
  };
}

export async function loadInternetBankingPaymentSettings(): Promise<InternetBankingPaymentSettingsValues> {
  const record = await prisma.internetBankingPaymentSettings.findUnique({
    where: { id: INTERNET_BANKING_PAYMENT_SETTINGS_ID },
    select: {
      holdBedSlots: true,
      holdDays: true,
      minimumDaysBeforeCheckIn: true,
    },
  });

  return normalizeInternetBankingPaymentSettings(record);
}

export function buildInternetBankingHoldUntil(
  settings: InternetBankingPaymentSettingsValues,
  now = new Date(),
): Date | null {
  if (!settings.holdBedSlots) {
    return null;
  }
  return new Date(now.getTime() + settings.holdDays * 24 * 60 * 60 * 1000);
}

export function buildInternetBankingHoldPolicySummary(
  settings: InternetBankingPaymentSettingsValues,
): string {
  if (!settings.holdBedSlots) {
    return "Internet Banking bookings are not held until Xero reconciliation marks the invoice paid.";
  }

  return `Internet Banking bookings hold beds for ${settings.holdDays} ${settings.holdDays === 1 ? "day" : "days"} while awaiting payment.`;
}

export function checkInternetBankingLeadTime(args: {
  checkIn?: Date | null;
  settings: InternetBankingPaymentSettingsValues;
  today?: Date;
}): InternetBankingLeadTimeResult {
  const today = args.today ?? getTodayDateOnly();
  const minimumDays = Math.max(0, args.settings.minimumDaysBeforeCheckIn);
  const checkIn = args.checkIn ?? null;

  if (!checkIn || minimumDays === 0) {
    return {
      allowed: true,
      minimumDaysBeforeCheckIn: minimumDays,
      unavailableReason: null,
      checkIn: checkIn ? formatDateOnly(checkIn) : null,
      today: formatDateOnly(today),
    };
  }

  const cutoffDate = addDaysDateOnly(today, minimumDays);
  const allowed = checkIn >= cutoffDate;
  const unit = minimumDays === 1 ? "day" : "days";

  return {
    allowed,
    minimumDaysBeforeCheckIn: minimumDays,
    unavailableReason: allowed
      ? null
      : `Internet Banking is only available at least ${minimumDays} ${unit} before check-in. Please pay by card to secure the booking.`,
    checkIn: formatDateOnly(checkIn),
    today: formatDateOnly(today),
  };
}

export function buildInternetBankingPaymentOptionState(args: {
  moduleEnabled: boolean;
  xeroIntegrationEnabled: boolean;
  internetBankingPaymentsEnabled: boolean;
  settings: InternetBankingPaymentSettingsValues;
  checkIn?: Date | null;
}) {
  const cutoff = checkInternetBankingLeadTime({
    checkIn: args.checkIn ?? null,
    settings: args.settings,
  });
  const moduleReason = !args.xeroIntegrationEnabled
    ? "Xero integration is not enabled."
    : !args.internetBankingPaymentsEnabled
      ? "Internet Banking payments are not enabled."
      : null;
  const unavailableReason = moduleReason ?? cutoff.unavailableReason;

  return {
    enabled: args.moduleEnabled && cutoff.allowed,
    moduleEnabled: args.moduleEnabled,
    xeroIntegrationEnabled: args.xeroIntegrationEnabled,
    internetBankingPaymentsEnabled: args.internetBankingPaymentsEnabled,
    unavailableReason,
    holdPolicy: {
      holdBedSlots: args.settings.holdBedSlots,
      holdDays: args.settings.holdDays,
      summary: buildInternetBankingHoldPolicySummary(args.settings),
    },
    cutoff,
  };
}
