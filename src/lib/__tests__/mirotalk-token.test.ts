import { afterEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

import {
  buildMirotalkToken,
  cryptoJsAesEncrypt,
  parseExpiresToSeconds,
  resolveMirotalkMeetingToken,
} from "@/lib/mirotalk-token";

// Independent OpenSSL/CryptoJS-compatible AES decrypt, so a round-trip proves
// our encrypt produces exactly what MiroTalk's CryptoJS.AES.decrypt consumes.
function cryptoJsAesDecrypt(b64: string, passphrase: string): string {
  const buf = Buffer.from(b64, "base64");
  // Layout: "Salted__"(8) + salt(8) + ciphertext
  const salt = buf.subarray(8, 16);
  const ciphertext = buf.subarray(16);
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  const pass = Buffer.from(passphrase, "utf8");
  while (derived.length < 48) {
    block = crypto
      .createHash("md5")
      .update(Buffer.concat([block, pass, salt]))
      .digest();
    derived = Buffer.concat([derived, block]);
  }
  const key = derived.subarray(0, 32);
  const iv = derived.subarray(32, 48);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

describe("cryptoJsAesEncrypt", () => {
  it("round-trips through the OpenSSL/CryptoJS format", () => {
    const key = "super-secret-key";
    const plaintext = '{"username":"lwtc","presenter":"true"}';
    const encrypted = cryptoJsAesEncrypt(plaintext, key);
    // Always starts with base64("Salted__") — the CryptoJS/OpenSSL header.
    expect(encrypted.startsWith("U2FsdGVk")).toBe(true);
    expect(cryptoJsAesDecrypt(encrypted, key)).toBe(plaintext);
  });

  it("uses a random salt (distinct ciphertext each call)", () => {
    const a = cryptoJsAesEncrypt("x", "k");
    const b = cryptoJsAesEncrypt("x", "k");
    expect(a).not.toBe(b);
  });
});

describe("buildMirotalkToken", () => {
  const key = "shared-jwt-key";

  it("produces a MiroTalk-compatible HS256 JWT whose data decrypts to the payload", () => {
    const token = buildMirotalkToken({
      key,
      username: "lwtc",
      password: "pw",
      presenter: true,
      expiresInSeconds: 3600,
    });

    const [header, payload, signature] = token.split(".");
    expect(header && payload && signature).toBeTruthy();

    // Header is HS256.
    expect(decodeSegment(header)).toEqual({ alg: "HS256", typ: "JWT" });

    // Signature verifies with the shared key (what MiroTalk's jwt.verify does).
    const expectedSig = crypto
      .createHmac("sha256", key)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(signature).toBe(expectedSig);

    // Payload carries iat/exp and the AES-encrypted credentials in `data`.
    const decodedPayload = decodeSegment(payload) as {
      data: string;
      iat: number;
      exp: number;
    };
    expect(decodedPayload.exp - decodedPayload.iat).toBe(3600);

    // MiroTalk decrypts `data` and reads username/password/presenter (strings).
    const inner = JSON.parse(cryptoJsAesDecrypt(decodedPayload.data, key));
    expect(inner).toEqual({
      username: "lwtc",
      password: "pw",
      presenter: "true",
    });
  });
});

describe("parseExpiresToSeconds", () => {
  it("parses MiroTalk-style durations", () => {
    expect(parseExpiresToSeconds("45s")).toBe(45);
    expect(parseExpiresToSeconds("30m")).toBe(1800);
    expect(parseExpiresToSeconds("1h")).toBe(3600);
    expect(parseExpiresToSeconds("2d")).toBe(172800);
    expect(parseExpiresToSeconds("900")).toBe(900);
  });

  it("falls back to one hour for missing/invalid values", () => {
    expect(parseExpiresToSeconds(undefined)).toBe(3600);
    expect(parseExpiresToSeconds("nonsense")).toBe(3600);
  });
});

describe("resolveMirotalkMeetingToken", () => {
  const saved = {
    key: process.env.MIRO_JWT_KEY,
    user: process.env.MIRO_MEETING_USERNAME,
    pass: process.env.MIRO_MEETING_PASSWORD,
    presenter: process.env.MIRO_MEETING_PRESENTER,
  };

  afterEach(() => {
    for (const [k, v] of [
      ["MIRO_JWT_KEY", saved.key],
      ["MIRO_MEETING_USERNAME", saved.user],
      ["MIRO_MEETING_PASSWORD", saved.pass],
      ["MIRO_MEETING_PRESENTER", saved.presenter],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns null when JWT access is not configured", () => {
    delete process.env.MIRO_JWT_KEY;
    delete process.env.MIRO_MEETING_USERNAME;
    delete process.env.MIRO_MEETING_PASSWORD;
    expect(resolveMirotalkMeetingToken()).toBeNull();
  });

  it("returns null when the key is set but credentials are missing", () => {
    process.env.MIRO_JWT_KEY = "k";
    delete process.env.MIRO_MEETING_USERNAME;
    delete process.env.MIRO_MEETING_PASSWORD;
    expect(resolveMirotalkMeetingToken()).toBeNull();
  });

  it("mints a token that decrypts to the configured host identity", () => {
    process.env.MIRO_JWT_KEY = "k";
    process.env.MIRO_MEETING_USERNAME = "lwtc";
    process.env.MIRO_MEETING_PASSWORD = "pw";
    process.env.MIRO_MEETING_PRESENTER = "true";
    const token = resolveMirotalkMeetingToken();
    expect(token).toBeTruthy();
    const payload = decodeSegment(token!.split(".")[1]) as { data: string };
    expect(JSON.parse(cryptoJsAesDecrypt(payload.data, "k"))).toEqual({
      username: "lwtc",
      password: "pw",
      presenter: "true",
    });
  });
});
