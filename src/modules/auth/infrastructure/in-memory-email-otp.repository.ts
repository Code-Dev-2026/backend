import { Injectable } from "@nestjs/common";
import { EmailOtpRecord } from "../domain/auth.models";
import { IEmailOtpRepository } from "../domain/email-otp.repository";

/**
 * Adaptador TEMPORAL en memoria de IEmailOtpRepository.
 * Se reemplaza por PostgreSQL/Redis cambiando el provider EMAIL_OTP_REPOSITORY.
 */
@Injectable()
export class InMemoryEmailOtpRepository implements IEmailOtpRepository {
  private readonly challenges = new Map<string, EmailOtpRecord>();

  async replaceForUser(record: EmailOtpRecord): Promise<void> {
    for (const [id, existing] of this.challenges) {
      if (existing.id_usuario === record.id_usuario) {
        this.challenges.delete(id);
      }
    }
    this.challenges.set(record.id_desafio, { ...record });
  }

  async findById(idDesafio: string): Promise<EmailOtpRecord | null> {
    const record = this.challenges.get(idDesafio);
    return record ? { ...record } : null;
  }

  async registerFailedAttempt(idDesafio: string): Promise<number> {
    const record = this.challenges.get(idDesafio);
    if (!record) {
      return Number.MAX_SAFE_INTEGER;
    }
    record.intentos += 1;
    return record.intentos;
  }

  async consume(idDesafio: string): Promise<boolean> {
    const record = this.challenges.get(idDesafio);
    if (!record || record.consumido) {
      return false;
    }
    // Sin await entre la lectura y la marca: atómico en el event loop.
    record.consumido = true;
    return true;
  }

  async delete(idDesafio: string): Promise<void> {
    this.challenges.delete(idDesafio);
  }
}
