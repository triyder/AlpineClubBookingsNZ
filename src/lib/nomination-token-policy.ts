const NOMINATION_TOKEN_TTL_DAYS = 7;
export const NOMINATION_AUTOMATIC_REMINDER_LIMIT = 4;

const NOMINATION_TOKEN_TTL_MS = NOMINATION_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

export function getNominationTokenExpiryDate(now = new Date()) {
  return new Date(now.getTime() + NOMINATION_TOKEN_TTL_MS);
}
