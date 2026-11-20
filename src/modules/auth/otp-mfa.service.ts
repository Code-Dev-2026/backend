import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "crypto";
import { AesEncryptionService } from "@common/crypto/aes-encryption.service";
import { HashService } from "@common/crypto/hash.service";
import { MfaSecretRecord } from "./domain/auth.models";
import { IMfaRepository, MFA_REPOSITORY } from "./domain/mfa.repository";
import {
  base32Decode,
  base32Encode,
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  verifyTotp,
} from "./infrastructure/totp";

export const MFA_ISSUER = "Camino Seguro";
const BACKUP_CODES_COUNT = 8;

export interface MfaEnrollment {
  /** Secreto en Base32 para la app autenticadora. Solo se muestra al enrolar. */
  secretBase32: string;
  otpauthUri: string;
  /** Códigos de respaldo en claro. Solo se muestran al enrolar. */
  backupCodes: string[];
}

/**
 * Segundo factor de autenticación (OWASP ASVS V3.5).
 * - Código de 6 dígitos (TOTP) de un solo uso.
 * - Secreto cifrado en reposo con AES-256-GCM (tabla mfa_secret).
 * - Códigos de respaldo guardados solo como hash SHA-256; cada uno sirve una vez.
 */
@Injectable()
export class OtpMfaService {
  /**
   * Último paso TOTP aceptado por usuario, para impedir reusar un código.
   * Limitación: vive en memoria de la instancia (no se comparte entre réplicas).
   */
  private readonly lastCounterByUser = new Map<string, number>();

  constructor(
    @Inject(MFA_REPOSITORY) private readonly mfaRepository: IMfaRepository,
    private readonly aesEncryption: AesEncryptionService,
    private readonly hashService: HashService,
  ) {}

  /** Crea (o reemplaza) el secreto MFA de un usuario, aún sin confirmar. */
  async enroll(idUsuario: string, accountName: string): Promise<MfaEnrollment> {
    const secretBase32 = base32Encode(randomBytes(20));
    const backupCodes = Array.from({ length: BACKUP_CODES_COUNT }, () =>
      randomBytes(5).toString("hex"),
    );

    await this.mfaRepository.save({
      id_usuario: idUsuario,
      secret_cifrado: this.aesEncryption.encrypt(secretBase32),
      backup_codes_hashes: backupCodes.map((c) => this.hashService.sha256(c)),
      confirmado: false,
    });
    this.lastCounterByUser.delete(idUsuario);

    const label = encodeURIComponent(`${MFA_ISSUER}:${accountName}`);
    const otpauthUri =
      `otpauth://totp/${label}?secret=${secretBase32}` +
      `&issuer=${encodeURIComponent(MFA_ISSUER)}&algorithm=SHA1` +
      `&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;

    return { secretBase32, otpauthUri, backupCodes };
  }

  /** Valida un código TOTP de 6 dígitos o un código de respaldo. */
  async verify(idUsuario: string, code: string): Promise<boolean> {
    const record = await this.mfaRepository.findByUserId(idUsuario);
    if (!record) {
      return false;
    }

    const normalized = (code ?? "").replace(/[\s-]/g, "").toLowerCase();

    if (/^\d{6}$/.test(normalized)) {
      return this.verifyTotpCode(record, normalized);
    }
    if (/^[0-9a-f]{10}$/.test(normalized)) {
      return this.verifyBackupCode(record, normalized);
    }
    return false;
  }

  private async verifyTotpCode(
    record: MfaSecretRecord,
    code: string,
  ): Promise<boolean> {
    const secret = base32Decode(
      this.aesEncryption.decrypt(record.secret_cifrado),
    );

    const matchedCounter = verifyTotp(secret, code);
    if (matchedCounter === null) {
      return false;
    }

    // Un código TOTP solo se puede usar una vez (ASVS V2.8.4).
    const lastCounter = this.lastCounterByUser.get(record.id_usuario);
    if (lastCounter !== undefined && matchedCounter <= lastCounter) {
      return false;
    }
    this.lastCounterByUser.set(record.id_usuario, matchedCounter);

    if (!record.confirmado) {
      await this.mfaRepository.save({ ...record, confirmado: true });
    }
    return true;
  }

  private async verifyBackupCode(
    record: MfaSecretRecord,
    code: string,
  ): Promise<boolean> {
    const hash = this.hashService.sha256(code);
    if (!record.backup_codes_hashes.includes(hash)) {
      return false;
    }

    await this.mfaRepository.updateBackupCodes(
      record.id_usuario,
      record.backup_codes_hashes.filter((h) => h !== hash),
    );
    return true;
  }
}
