import "server-only";
import crypto from "node:crypto";

/**
 * MiroTalk P2P JWT access tokens (#calendar meetings).
 *
 * Reproduces MiroTalk P2P's own `encodeToken` byte-for-byte so a token we sign
 * is accepted by a MiroTalk instance sharing the same `JWT_KEY`. From MiroTalk's
 * `app/src/server.js`:
 *
 *   payload   = { username, password, presenter }   // all String()-ified
 *   encrypted = CryptoJS.AES.encrypt(JSON.stringify(payload), JWT_KEY)
 *   token     = jwt.sign({ data: encrypted }, JWT_KEY, { expiresIn })
 *
 * On join MiroTalk verifies the JWT signature, AES-decrypts `data`, then calls
 * `isAuthPeer(username, password)` — so the embedded credentials MUST match a
 * `HOST_USERS` entry. `presenter === 'true'` (or being first into the room)
 * makes the peer a host.
 *
 * This module is server-only: the signing key and the host password are secrets
 * and must never reach the browser. The join URL is assembled during server-side
 * API serialization (see buildMeetingJoinUrl), so a fresh, short-lived token is
 * minted each time the calendar is served.
 *
 * Implemented with Node's built-in `crypto` (no new dependencies). The AES step
 * matches CryptoJS's OpenSSL-compatible format exactly: an 8-byte random salt,
 * EVP_BytesToKey (MD5) key/IV derivation, AES-256-CBC, output
 * `base64("Salted__" + salt + ciphertext)`.
 */

/** OpenSSL EVP_BytesToKey with MD5 (one hash chain), as CryptoJS uses. */
function evpBytesToKey(
  passphrase: Buffer,
  salt: Buffer,
  keyLen: number,
  ivLen: number,
): { key: Buffer; iv: Buffer } {
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < keyLen + ivLen) {
    block = crypto
      .createHash("md5")
      .update(Buffer.concat([block, passphrase, salt]))
      .digest();
    derived = Buffer.concat([derived, block]);
  }
  return {
    key: derived.subarray(0, keyLen),
    iv: derived.subarray(keyLen, keyLen + ivLen),
  };
}

/**
 * CryptoJS-compatible `AES.encrypt(message, passphrase)`. `salt` is exposed only
 * so tests can pin a known-answer vector; production always uses a random salt.
 */
export function cryptoJsAesEncrypt(
  plaintext: string,
  passphrase: string,
  salt: Buffer = crypto.randomBytes(8),
): string {
  const { key, iv } = evpBytesToKey(
    Buffer.from(passphrase, "utf8"),
    salt,
    32,
    16,
  );
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from("Salted__", "utf8"),
    salt,
    ciphertext,
  ]).toString("base64");
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Minimal HS256 JWT (`jsonwebtoken`-compatible for verify + exp). */
function signHs256(
  data: Record<string, unknown>,
  key: string,
  expiresInSeconds: number,
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { ...data, iat: nowSeconds, exp: nowSeconds + expiresInSeconds };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = base64url(
    crypto.createHmac("sha256", key).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}

/**
 * Parse a MiroTalk-style expiry (`"1h"`, `"30m"`, `"45s"`, `"1d"`, or a bare
 * number of seconds) into seconds. Falls back to one hour.
 */
export function parseExpiresToSeconds(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) return 3600;
  const match = /^(\d+)\s*([smhd]?)$/i.exec(raw);
  if (!match) return 3600;
  const amount = Number(match[1]);
  switch (match[2].toLowerCase()) {
    case "s":
    case "":
      return amount;
    case "m":
      return amount * 60;
    case "h":
      return amount * 3600;
    case "d":
      return amount * 86400;
    default:
      return 3600;
  }
}

export interface MirotalkTokenInput {
  key: string;
  username: string;
  password: string;
  presenter: boolean;
  expiresInSeconds: number;
}

/** Sign a MiroTalk P2P access token (see module doc for the exact format). */
export function buildMirotalkToken(input: MirotalkTokenInput): string {
  const payload = {
    username: String(input.username),
    password: String(input.password),
    presenter: String(input.presenter),
  };
  const encrypted = cryptoJsAesEncrypt(JSON.stringify(payload), input.key);
  return signHs256({ data: encrypted }, input.key, input.expiresInSeconds);
}

/**
 * Build the meeting token from the app environment, or null when JWT access is
 * not configured (then the join link carries no token and MiroTalk falls back to
 * its own host-login prompt). Requires all three of `MIRO_JWT_KEY`,
 * `MIRO_MEETING_USERNAME`, and `MIRO_MEETING_PASSWORD` — with HOST_USER_AUTH on,
 * a token whose credentials do not match a HOST_USERS entry would be rejected,
 * so we omit the token entirely rather than emit one that cannot authenticate.
 */
export function resolveMirotalkMeetingToken(): string | null {
  const key = process.env.MIRO_JWT_KEY?.trim();
  const username = process.env.MIRO_MEETING_USERNAME?.trim();
  const password = process.env.MIRO_MEETING_PASSWORD;
  if (!key || !username || !password) return null;

  // Default true: the calendar link is meant to let committee members open and
  // host the meeting immediately. MiroTalk's /join page grants host status
  // purely from this flag (it does NOT apply first-to-join there), so "false"
  // leaves the clicker stuck on the "waiting for host" screen. Set
  // MIRO_MEETING_PRESENTER=false only if you want joiners to wait for a host.
  const presenter =
    (process.env.MIRO_MEETING_PRESENTER ?? "true").trim().toLowerCase() !==
    "false";
  const expiresInSeconds = parseExpiresToSeconds(process.env.MIRO_JWT_EXP);

  return buildMirotalkToken({
    key,
    username,
    password,
    presenter,
    expiresInSeconds,
  });
}
