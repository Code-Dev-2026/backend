import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ICryptoVaultPort } from "../ports/crypto-vault.port";
import { AesEncryptionService } from "./aes-encryption.service";
import { BlindIndexService } from "./blind-index.service";

/** Llaves que trae por defecto el esquema de entorno: inseguras en producción. */
const DEFAULT_MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const DEFAULT_HMAC_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

/**
 * Criptovault de datos sensibles (Ley 1581 / ADR-002).
 * Punto único para cifrar, descifrar y generar índices ciegos:
 * - encrypt/decrypt: AES-256-GCM en formato key_version:iv:tag:ciphertext.
 * - generateBlindIndex: HMAC-SHA256 determinístico con la llave (salt) del
 *   sistema APP_BLIND_INDEX_HMAC_KEY, independiente de la llave de cifrado.
 * Las llaves nunca salen de este servicio ni se escriben en logs.
 */
@Injectable()
export class CryptoVaultService implements ICryptoVaultPort {
  constructor(
    private readonly aes: AesEncryptionService,
    private readonly blindIndex: BlindIndexService,
    config: ConfigService,
  ) {
    assertProductionKeys(config);
  }

  encrypt(plaintext: string): string {
    return this.aes.encrypt(plaintext);
  }

  decrypt(ciphertext: string): string {
    return this.aes.decrypt(ciphertext);
  }

  /** Cifra un valor opcional (null/vacío se conserva como null). */
  encryptOptional(plaintext: string | null | undefined): string | null {
    return plaintext ? this.aes.encrypt(plaintext) : null;
  }

  decryptOptional(ciphertext: string | null | undefined): string | null {
    return ciphertext ? this.aes.decrypt(ciphertext) : null;
  }

  generateBlindIndex(plaintext: string): string {
    return this.blindIndex.generateIndex(plaintext);
  }
}

/** En producción exige llaves propias, distintas entre sí. */
export function assertProductionKeys(config: ConfigService): void {
  if (config.get<string>("NODE_ENV") !== "production") {
    return;
  }

  const master = config.get<string>("APP_ENCRYPTION_MASTER_KEY");
  const hmac = config.get<string>("APP_BLIND_INDEX_HMAC_KEY");

  if (!master || master === DEFAULT_MASTER_KEY) {
    throw new Error(
      "APP_ENCRYPTION_MASTER_KEY inseguro para producción: defina una llave propia de 32 bytes en base64.",
    );
  }
  if (!hmac || hmac === DEFAULT_HMAC_KEY) {
    throw new Error(
      "APP_BLIND_INDEX_HMAC_KEY inseguro para producción: defina una llave propia de 32 bytes en base64.",
    );
  }
  if (master === hmac) {
    throw new Error(
      "APP_ENCRYPTION_MASTER_KEY y APP_BLIND_INDEX_HMAC_KEY deben ser distintas.",
    );
  }
}
