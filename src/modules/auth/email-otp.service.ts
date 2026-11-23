import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomInt, timingSafeEqual } from "crypto";
import { HashService } from "@common/crypto/hash.service";
import { uuidv7 } from "@common/utils/uuidv7";
import { MailerService } from "../mailer/mailer.service";
import {
  EMAIL_OTP_REPOSITORY,
  IEmailOtpRepository,
} from "./domain/email-otp.repository";

/** Ventana estricta de validez del código OTP (300 s). */
export const EMAIL_OTP_TTL_SECONDS = 300;
export const EMAIL_OTP_DIGITS = 6;
/** Intentos fallidos permitidos antes de invalidar el desafío. */
export const EMAIL_OTP_MAX_ATTEMPTS = 5;

export interface IssuedEmailOtp {
  challengeId: string;
  expiresIn: number;
}

/**
 * Segundo factor por correo electrónico (OWASP ASVS V2.7).
 * - Código numérico de 6 dígitos con CSPRNG (crypto.randomInt).
 * - Se guarda solo su hash, ligado al id del desafío.
 * - Caduca a los 300 s, sirve una sola vez y se invalida tras 5 fallos.
 * - Un login nuevo invalida el código anterior del mismo usuario.
 */
@Injectable()
export class EmailOtpService {
  private readonly logger = new Logger(EmailOtpService.name);

  constructor(
    @Inject(EMAIL_OTP_REPOSITORY)
    private readonly repository: IEmailOtpRepository,
    private readonly hashService: HashService,
    private readonly mailer: MailerService,
  ) {}

  /** Genera el código, lo persiste (hash) y lo envía al correo del usuario. */
  async issue(user: {
    id_usuario: string;
    email: string;
  }): Promise<IssuedEmailOtp> {
    const challengeId = uuidv7();
    const code = randomInt(0, 10 ** EMAIL_OTP_DIGITS)
      .toString()
      .padStart(EMAIL_OTP_DIGITS, "0");

    await this.repository.replaceForUser({
      id_desafio: challengeId,
      id_usuario: user.id_usuario,
      code_hash: this.hashCode(challengeId, code),
      expira_en: new Date(Date.now() + EMAIL_OTP_TTL_SECONDS * 1000),
      intentos: 0,
      consumido: false,
    });

    try {
      await this.mailer.sendOtpCode(user.email, code, EMAIL_OTP_TTL_SECONDS);
    } catch (error) {
      await this.repository.delete(challengeId);
      this.logger.error(
        `No se pudo enviar el OTP al usuario ${user.id_usuario}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        "No fue posible enviar el código de verificación. Intente nuevamente.",
      );
    }

    return { challengeId, expiresIn: EMAIL_OTP_TTL_SECONDS };
  }

  /** Valida el código. Devuelve true solo una vez por desafío. */
  async verify(
    idUsuario: string,
    challengeId: string,
    code: string,
  ): Promise<boolean> {
    const record = await this.repository.findById(challengeId);
    if (!record || record.id_usuario !== idUsuario || record.consumido) {
      return false;
    }

    if (Date.now() >= record.expira_en.getTime()) {
      await this.repository.delete(challengeId);
      return false;
    }

    if (record.intentos >= EMAIL_OTP_MAX_ATTEMPTS) {
      await this.repository.delete(challengeId);
      return false;
    }

    const normalized = (code ?? "").trim();
    const valid =
      new RegExp(`^\\d{${EMAIL_OTP_DIGITS}}$`).test(normalized) &&
      this.safeEqual(this.hashCode(challengeId, normalized), record.code_hash);

    if (!valid) {
      const attempts = await this.repository.registerFailedAttempt(challengeId);
      if (attempts >= EMAIL_OTP_MAX_ATTEMPTS) {
        await this.repository.delete(challengeId);
      }
      return false;
    }

    const consumed = await this.repository.consume(challengeId);
    if (consumed) {
      await this.repository.delete(challengeId);
    }
    return consumed;
  }

  private hashCode(challengeId: string, code: string): string {
    return this.hashService.sha256(`${challengeId}:${code}`);
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "hex");
    const bufB = Buffer.from(b, "hex");
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}
