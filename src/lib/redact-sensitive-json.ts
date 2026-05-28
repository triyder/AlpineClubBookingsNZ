const REDACTED_SECRET = "[REDACTED]";
const SENSITIVE_JSON_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "apikey",
  "password",
  "stripetoken",
  "email",
  "phone",
  "phonenumber",
  "mobilephone",
  "paymentmethod",
  "paymentmethodid",
  "charge",
  "chargeid",
  "clientreferenceid",
]);
const SENSITIVE_JSON_KEY_FRAGMENTS = new Set([
  "email",
  "phone",
  "paymentmethod",
  "charge",
  "clientreferenceid",
]);
const SENSITIVE_STRING_VALUE_PATTERNS = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\+?[0-9]{8,15}/,
];
const STRIPE_SECRET_VALUE_PATTERN =
  /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|(?:pi|seti|si|cs)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+)\b/g;
const TOKEN_QUERY_VALUE_PATTERN =
  /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|payment[_-]?intent[_-]?client[_-]?secret|setup[_-]?intent[_-]?client[_-]?secret|token)=)[^&#\s]+/gi;
const TOKEN_KEY_VALUE_PATTERN =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|stripe[_-]?token|token)\s*([:=])\s*("[^"]*"|'[^']*'|[^,\s;&]+)/gi;

function normalizeJsonKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveJsonKey(key: string) {
  const normalizedKey = normalizeJsonKey(key);

  // Fragment matches may redact noisy keys like emailedAt, which is acceptable to avoid leaking PII or Stripe IDs.
  return (
    SENSITIVE_JSON_KEYS.has(normalizedKey) ||
    Array.from(SENSITIVE_JSON_KEY_FRAGMENTS).some((sensitiveFragment) =>
      normalizedKey.includes(sensitiveFragment)
    )
  );
}

function isSensitiveStringValue(value: string) {
  return SENSITIVE_STRING_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function redactJsonStringCandidate(value: string): string | null {
  const trimmed = value.trim();
  const firstBraceIndex = trimmed.search(/[{\[]/);

  if (firstBraceIndex === -1) {
    return null;
  }

  const prefix = trimmed.slice(0, firstBraceIndex);
  const jsonCandidate = trimmed.slice(firstBraceIndex);

  try {
    return `${prefix}${JSON.stringify(redactSensitiveJson(JSON.parse(jsonCandidate)))}`;
  } catch {
    return null;
  }
}

// Token-bearing paths can land in webserver, proxy, callbackUrl, and
// observability access logs. Redact both literal paths and URL-encoded callback
// paths so opaque action tokens do not leak through login redirects.
const TOKEN_PATH_PATTERN =
  /(\/(?:membership-cancellation|chores|nominations)\/)[A-Za-z0-9_-]+/g;
const ENCODED_TOKEN_PATH_PATTERN =
  /(%2F(?:membership-cancellation|chores|nominations)%2F)[A-Za-z0-9_-]+/gi;

export function redactSensitiveText(value: string): string {
  const redactedJsonCandidate = redactJsonStringCandidate(value);
  if (redactedJsonCandidate) {
    return redactedJsonCandidate;
  }

  const redactedValue = value
    .replace(TOKEN_PATH_PATTERN, `$1${REDACTED_SECRET}`)
    .replace(ENCODED_TOKEN_PATH_PATTERN, `$1${REDACTED_SECRET}`)
    .replace(
      /("?(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|stripe[_-]?token|email|phone|phone[_-]?number|mobile[_-]?phone|payment[_-]?method(?:[_-]?id)?|charge(?:[_-]?id)?|client[_-]?reference[_-]?id)"?\s*:\s*")([^"]*)"/gi,
      `$1${REDACTED_SECRET}"`
    )
    .replace(TOKEN_QUERY_VALUE_PATTERN, `$1${REDACTED_SECRET}`)
    .replace(TOKEN_KEY_VALUE_PATTERN, `$1$2${REDACTED_SECRET}`)
    .replace(STRIPE_SECRET_VALUE_PATTERN, REDACTED_SECRET)
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi, `Bearer ${REDACTED_SECRET}`);

  return isSensitiveStringValue(redactedValue) ? REDACTED_SECRET : redactedValue;
}

export function redactSensitiveJson(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveText(value.message),
      stack: value.stack ? redactSensitiveText(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveJson(entry));
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    result[key] = isSensitiveJsonKey(key)
      ? REDACTED_SECRET
      : redactSensitiveJson(entryValue);
  }

  return result;
}

export function formatRedactedJson(value: unknown): string {
  return JSON.stringify(redactSensitiveJson(value ?? null), null, 2);
}
