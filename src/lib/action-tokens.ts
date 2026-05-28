import { createHash, randomBytes } from "crypto";

export const ACTION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export type IssuedActionToken = {
  token: string;
  tokenHash: string;
};

export function isActionTokenFormat(token: string) {
  return ACTION_TOKEN_PATTERN.test(token.trim());
}

export function hashActionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function issueActionToken(): IssuedActionToken {
  const token = randomBytes(32).toString("hex");

  return {
    token,
    tokenHash: hashActionToken(token),
  };
}
