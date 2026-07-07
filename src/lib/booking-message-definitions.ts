export const BOOKING_MESSAGE_KEYS = [
  "booking.payment.card.description",
  "booking.payment.internetBanking.description",
  "booking.payment.internetBanking.unavailable",
  "booking.detail.paymentRequired.description",
  "booking.detail.internetBanking.pending",
  "booking.detail.switchToInternetBanking",
  "paymentLink.internetBanking.description",
  "cancellation.refundAppeal.description",
  "groupBooking.settle.description",
  "groupBooking.internetBanking.description",
  "groupBooking.invoiceSent.description",
] as const;

export type BookingMessageKey = (typeof BOOKING_MESSAGE_KEYS)[number];

const BOOKING_MESSAGE_TOKENS = [
  "bookerFirstName",
  "bookerFullName",
  "checkIn",
  "checkOut",
  "guestCount",
  "amountDue",
  "amountPaid",
  "refundAmount",
  "creditAmount",
  "creditRestored",
  "retainedAmount",
  "changeFee",
  "paymentReference",
  "xeroInvoiceNumber",
  "holdUntil",
  "holdDays",
  "minimumDaysBeforeCheckIn",
  "bookingStatus",
  "CLUB_NAME",
  "CLUB_LODGE_NAME",
  "BASE_URL",
  "SUPPORT_EMAIL",
] as const;

type BookingMessageToken = (typeof BOOKING_MESSAGE_TOKENS)[number];

export type BookingMessageMergeData = Partial<Record<BookingMessageToken, string | number | null | undefined>>;

export interface BookingMessageDefinition {
  key: BookingMessageKey;
  section: string;
  label: string;
  description: string;
  defaultBody: string;
  tokens: readonly BookingMessageToken[];
}

const ALL_TOKENS = BOOKING_MESSAGE_TOKENS;

export const BOOKING_MESSAGE_DEFINITIONS: readonly BookingMessageDefinition[] = [
  {
    key: "booking.payment.card.description",
    section: "Booking Flow",
    label: "Card payment method",
    description: "Shown next to the card payment option during member booking.",
    defaultBody: "Pay now and secure the booking immediately.",
    tokens: ALL_TOKENS,
  },
  {
    key: "booking.payment.internetBanking.description",
    section: "Booking Flow",
    label: "Internet Banking payment method",
    description: "Shown next to the Internet Banking option during booking.",
    defaultBody:
      "Receive a Xero invoice by email and make payment via internet banking. Once the payment is reconciled and sync'd back to the booking system, your booking will be confirmed. Until then your booking is not held and someone else could take your space by booking and paying with Card.",
    tokens: ALL_TOKENS,
  },
  {
    key: "booking.payment.internetBanking.unavailable",
    section: "Booking Flow",
    label: "Internet Banking unavailable",
    description: "Shown when Internet Banking is switched on but unavailable for the selected dates.",
    defaultBody:
      "Internet Banking is not available for this check-in date. Please pay by card to secure the booking immediately.",
    tokens: ALL_TOKENS,
  },
  {
    key: "booking.detail.paymentRequired.description",
    section: "Booking Detail",
    label: "Payment required",
    description: "Shown on booking detail pages when payment is still required.",
    defaultBody:
      "Payment is required to secure this booking. Availability may change until payment succeeds.",
    tokens: ALL_TOKENS,
  },
  {
    key: "booking.detail.internetBanking.pending",
    section: "Booking Detail",
    label: "Internet Banking pending",
    description: "Shown for pending Internet Banking bookings awaiting Xero reconciliation.",
    defaultBody:
      "Your Xero invoice has been emailed. Use reference {{paymentReference}} when paying by internet banking. Your booking will be confirmed once the payment is reconciled.",
    tokens: ALL_TOKENS,
  },
  {
    key: "booking.detail.switchToInternetBanking",
    section: "Booking Detail",
    label: "Switch to Internet Banking",
    description: "Shown beside the button that changes an unpaid card booking to Internet Banking.",
    defaultBody:
      "Prefer to pay by internet banking? We will email a Xero invoice and confirm the booking after the payment is reconciled.",
    tokens: ALL_TOKENS,
  },
  {
    key: "paymentLink.internetBanking.description",
    section: "Payment Link",
    label: "Internet Banking payment link",
    description: "Shown on public payment links when Internet Banking is available.",
    defaultBody:
      "Use reference {{paymentReference}} when making a direct transfer. The booking will be confirmed after the Xero invoice payment is reconciled.",
    tokens: ALL_TOKENS,
  },
  {
    key: "cancellation.refundAppeal.description",
    section: "Cancellation & Refund Appeal",
    label: "Refund appeal",
    description: "Shown near member cancellation and refund appeal controls.",
    defaultBody:
      "If your cancellation is outside the automatic refund window, you can ask the committee to review the refund outcome.",
    tokens: ALL_TOKENS,
  },
  {
    key: "groupBooking.settle.description",
    section: "Group Booking",
    label: "Group settlement",
    description: "Shown to organisers before settling all unpaid group bookings.",
    defaultBody:
      "Pay for every joiner's beds in one settlement. Card payment confirms the group immediately; Internet Banking sends one Xero invoice for the organiser to pay.",
    tokens: ALL_TOKENS,
  },
  {
    key: "groupBooking.internetBanking.description",
    section: "Group Booking",
    label: "Group Internet Banking",
    description: "Shown to organisers choosing Internet Banking for group settlement.",
    defaultBody:
      "Receive one Xero invoice by email for the organiser-settled group bookings.",
    tokens: ALL_TOKENS,
  },
  {
    key: "groupBooking.invoiceSent.description",
    section: "Group Booking",
    label: "Group invoice sent",
    description: "Shown after a group settlement invoice is queued or sent.",
    defaultBody:
      "The organiser invoice has been emailed. The group booking stays confirmed while Xero reconciles the payment.",
    tokens: ALL_TOKENS,
  },
] as const;

export const BOOKING_MESSAGE_DEFINITION_BY_KEY = new Map(
  BOOKING_MESSAGE_DEFINITIONS.map((definition) => [definition.key, definition]),
);

const KNOWN_TOKEN_SET = new Set<string>(BOOKING_MESSAGE_TOKENS);
const TOKEN_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*>/i;
const MAX_BOOKING_MESSAGE_LENGTH = 4000;

// test seam
export function extractBookingMessageTokens(template: string): string[] {
  const tokens = new Set<string>();
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    tokens.add(match[1]);
  }
  return Array.from(tokens);
}

export function validateBookingMessageContent(
  bodyText: string,
): { ok: true; bodyText: string } | { ok: false; errors: string[] } {
  const normalized = bodyText.replace(/\r\n/g, "\n").trim();
  const errors: string[] = [];

  if (!normalized) {
    errors.push("Message body is required.");
  }
  if (normalized.length > MAX_BOOKING_MESSAGE_LENGTH) {
    errors.push(`Message body must be ${MAX_BOOKING_MESSAGE_LENGTH} characters or fewer.`);
  }
  if (HTML_TAG_PATTERN.test(normalized)) {
    errors.push("Message body must be plain text only.");
  }

  const unknownTokens = extractBookingMessageTokens(normalized).filter(
    (token) => !KNOWN_TOKEN_SET.has(token),
  );
  if (unknownTokens.length > 0) {
    errors.push(`Unknown merge field${unknownTokens.length === 1 ? "" : "s"}: ${unknownTokens.join(", ")}.`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, bodyText: normalized };
}

export function renderBookingMessageTemplate(
  template: string,
  data: BookingMessageMergeData,
): string {
  return template.replace(TOKEN_PATTERN, (_match, token: string) => {
    const value = data[token as BookingMessageToken];
    return value === null || value === undefined ? "" : String(value);
  });
}

export function getDefaultBookingMessages(): Record<BookingMessageKey, string> {
  return Object.fromEntries(
    BOOKING_MESSAGE_DEFINITIONS.map((definition) => [
      definition.key,
      definition.defaultBody,
    ]),
  ) as Record<BookingMessageKey, string>;
}
