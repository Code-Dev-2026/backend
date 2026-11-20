import { Injectable } from "@nestjs/common";
import { MfaSecretRecord } from "../domain/auth.models";
import { IMfaRepository } from "../domain/mfa.repository";

/**
 * Adaptador TEMPORAL en memoria de IMfaRepository.
 * Se reemplaza por una implementación PostgreSQL (tabla mfa_secret)
 * cambiando un solo provider (MFA_REPOSITORY) en AuthModule.
 */
@Injectable()
export class InMemoryMfaRepository implements IMfaRepository {
  private readonly secrets = new Map<string, MfaSecretRecord>();

  async findByUserId(idUsuario: string): Promise<MfaSecretRecord | null> {
    const record = this.secrets.get(idUsuario);
    return record
      ? { ...record, backup_codes_hashes: [...record.backup_codes_hashes] }
      : null;
  }

  async save(secret: MfaSecretRecord): Promise<void> {
    this.secrets.set(secret.id_usuario, {
      ...secret,
      backup_codes_hashes: [...secret.backup_codes_hashes],
    });
  }

  async updateBackupCodes(idUsuario: string, hashes: string[]): Promise<void> {
    const record = this.secrets.get(idUsuario);
    if (record) {
      record.backup_codes_hashes = [...hashes];
    }
  }
}
