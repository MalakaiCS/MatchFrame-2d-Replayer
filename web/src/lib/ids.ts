import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";

const ALPHA = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Opaque random identifier (base62). 16 chars ~ 95 bits. */
export function newId(len = 16): string {
  const bytes = randomBytes(len * 2);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < len; i++) {
    const b = bytes[i];
    if (b < 248) out += ALPHA[b % 62];
  }
  return out.length === len ? out : newId(len);
}

/** 256-bit share token, URL-safe. Returned once; only its hash is stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export function hmac(secret: string, msg: string): string {
  return createHmac("sha256", secret).update(msg).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
