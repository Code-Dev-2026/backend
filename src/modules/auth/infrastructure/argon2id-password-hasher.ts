import { Injectable, Logger } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { IPasswordHasher } from "../domain/password-hasher.interface";

type Argon2Module = typeof import("argon2");

/**
 * Hasher de contraseñas Argon2id (OWASP ASVS V2.1).
 * Parámetros ASVS: m=64MB, t=3, p=4.
 * Si el módulo nativo de Argon2 no está disponible, usa Bcrypt como fallback.
 * Al verificar, reconoce ambos formatos ($argon2id$... y $2a/$2b$...).
 */
@Injectable()
export class Argon2idPasswordHasher implements IPasswordHasher {
  private readonly logger = new Logger(Argon2idPasswordHasher.name);
  private readonly argon2: Argon2Module | null;

  private static readonly MEMORY_COST_KIB = 65536; // 64 MB
  private static readonly TIME_COST = 3;
  private static readonly PARALLELISM = 4;
  private static readonly BCRYPT_ROUNDS = 12;

  constructor() {
    this.argon2 = this.loadArgon2();
    if (!this.argon2) {
      this.logger.warn(
        "Argon2 no disponible: se usará Bcrypt como fallback para hashing.",
      );
    }
  }

  async hash(plain: string): Promise<string> {
    if (this.argon2) {
      return this.argon2.hash(plain, {
        type: this.argon2.argon2id,
        memoryCost: Argon2idPasswordHasher.MEMORY_COST_KIB,
        timeCost: Argon2idPasswordHasher.TIME_COST,
        parallelism: Argon2idPasswordHasher.PARALLELISM,
      });
    }
    return bcrypt.hash(plain, Argon2idPasswordHasher.BCRYPT_ROUNDS);
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    if (!plain || !hash) {
      return false;
    }

    try {
      if (hash.startsWith("$argon2")) {
        return this.argon2 ? await this.argon2.verify(hash, plain) : false;
      }
      if (hash.startsWith("$2")) {
        return await bcrypt.compare(plain, hash);
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Separado para poder simular la ausencia de Argon2 en pruebas. */
  protected loadArgon2(): Argon2Module | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require("argon2") as Argon2Module;
    } catch {
      return null;
    }
  }
}
