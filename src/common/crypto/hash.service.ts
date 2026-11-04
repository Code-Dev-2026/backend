import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as bcrypt from 'bcrypt';

/**
 * Servicio de Hashing de Contraseñas
 * Prioriza Argon2id conforme a OWASP ASVS L2 y RNF-01, con soporte de verificación Bcrypt.
 */
@Injectable()
export class HashService {
  /**
   * Genera un hash Argon2id seguro
   */
  async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16, // 64 MB
      timeCost: 3,         // 3 iteraciones
      parallelism: 4,      // 4 hilos
    });
  }

  /**
   * Verifica la contraseña contra el hash (Argon2id o Bcrypt)
   */
  async compare(password: string, hash: string): Promise<boolean> {
    if (!password || !hash) {
      return false;
    }

    try {
      if (hash.startsWith('$argon2')) {
        return await argon2.verify(hash, password);
      }
      if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) {
        return await bcrypt.compare(password, hash);
      }
      return false;
    } catch {
      return false;
    }
  }
}
