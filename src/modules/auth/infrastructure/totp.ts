import { createHmac, timingSafeEqual } from "crypto";

/**
 * TOTP (RFC 6238) / HOTP (RFC 4226) con HMAC-SHA1, 6 dígitos y paso de 30 s.
 * Implementado con `crypto` de Node para no depender de librerías externas.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error("Cadena Base32 inválida.");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

export function hotp(
  secret: Buffer,
  counter: number,
  digits: number = TOTP_DIGITS,
): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];

  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export function totpCounter(timeMs: number): number {
  return Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
}

export function generateTotp(
  secret: Buffer,
  timeMs: number = Date.now(),
): string {
  return hotp(secret, totpCounter(timeMs));
}

/**
 * Verifica un código TOTP con tolerancia de ±`window` pasos (reloj desfasado).
 * Devuelve el contador que coincidió (útil para impedir reuso) o null.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  timeMs: number = Date.now(),
  window = 1,
): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  const given = Buffer.from(code);
  const current = totpCounter(timeMs);
  let matched: number | null = null;

  // Se recorre toda la ventana siempre (tiempo constante, ASVS V2.8).
  for (let counter = current - window; counter <= current + window; counter++) {
    const expected = Buffer.from(hotp(secret, counter));
    if (timingSafeEqual(expected, given)) {
      matched = counter;
    }
  }
  return matched;
}
