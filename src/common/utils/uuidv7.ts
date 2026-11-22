import { randomBytes } from "crypto";

/**
 * Genera un UUID versión 7 (RFC 9562): 48 bits de marca de tiempo en
 * milisegundos + 74 bits aleatorios. Ordenable por tiempo, igual que
 * `fn_uuid_generate_v7()` de la migración V001/V002.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 48 bits de timestamp (big-endian)
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  bytes[6] = (bytes[6] & 0x0f) | 0x70; // versión 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 9562

  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}
