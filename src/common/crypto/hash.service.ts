import { Injectable } from "@nestjs/common";
import * as crypto from "crypto";

/**
 * Servicio Criptográfico de Hashing e Inmutabilidad Forense
 * Proporciona cálculo de SHA-256 para encadenamiento WORM (ADR-002)
 * y hashing robusto de contraseñas mediante PBKDF2-SHA512.
 */
@Injectable()
export class HashService {
  /**
   * Genera un hash SHA-256 estándar en formato hexadecimal (64 caracteres)
   * Utilizado para encadenamiento de bitácora y verificación de inmutabilidad
   */
  sha256(data: string): string {
    return crypto.createHash("sha256").update(data, "utf8").digest("hex");
  }

  /**
   * Genera hash de encadenamiento para auditoría: SHA-256(id + hash_anterior + payload + salt)
   */
  chainHash(
    id: string,
    previousHash: string,
    payload: string,
    salt: string,
  ): string {
    const message = `${id}:${previousHash}:${payload}:${salt}`;
    return this.sha256(message);
  }

  /**
   * Genera un hash seguro para contraseñas utilizando PBKDF2 con SHA-512
   */
  async hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString("hex");
    const iterations = 100000;
    const keylen = 64;
    const digest = "sha512";

    return new Promise((resolve, reject) => {
      crypto.pbkdf2(
        password,
        salt,
        iterations,
        keylen,
        digest,
        (err, derivedKey) => {
          if (err) return reject(err);
          resolve(`pbkdf2:${iterations}:${salt}:${derivedKey.toString("hex")}`);
        },
      );
    });
  }

  /**
   * Compara una contraseña en texto plano contra su hash almacenado
   */
  async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    if (!password || !storedHash) {
      return false;
    }

    const parts = storedHash.split(":");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") {
      return false;
    }

    const iterations = parseInt(parts[1], 10);
    const salt = parts[2];
    const originalHash = parts[3];

    return new Promise((resolve) => {
      crypto.pbkdf2(
        password,
        salt,
        iterations,
        64,
        "sha512",
        (err, derivedKey) => {
          if (err) return resolve(false);
          const match = crypto.timingSafeEqual(
            Buffer.from(originalHash, "hex"),
            derivedKey,
          );
          resolve(match);
        },
      );
    });
  }
}
