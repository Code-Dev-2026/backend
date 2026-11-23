import { Inject, Injectable } from "@nestjs/common";
import { AuthService } from "../auth.service";
import { UserRecord } from "../domain/auth.models";
import {
  ISecurityAuditPort,
  SECURITY_AUDIT,
} from "../domain/security-audit.port";
import { LoginDto } from "../dto/login.dto";
import { EMAIL_OTP_DIGITS, EmailOtpService } from "../email-otp.service";
import { SessionService } from "../session.service";

export interface LoginResult {
  requiresMfa: true;
  /** Token provisional: solo sirve en POST /auth/verify-otp. */
  mfaToken: string;
  mfaChallenge: { type: "EMAIL_OTP"; digits: 6; destination: string };
  expiresIn: number;
}

/** Oculta el correo en la respuesta: "acudiente@correo.co" -> "ac***@correo.co". */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) {
    return "***";
  }
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

/**
 * Caso de uso: paso 1 del login (correo + contraseña).
 * Valida las credenciales con Argon2id y envía un código OTP de 6 dígitos al
 * correo registrado. NO entrega Access ni Refresh Token: eso solo ocurre en
 * POST /auth/verify-otp. Aplica a todos los roles.
 */
@Injectable()
export class LoginUseCase {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    private readonly emailOtpService: EmailOtpService,
    @Inject(SECURITY_AUDIT) private readonly securityAudit: ISecurityAuditPort,
  ) {}

  async execute(dto: LoginDto): Promise<LoginResult> {
    let user: UserRecord;
    try {
      user = await this.authService.validateCredentials(
        dto.email,
        dto.password,
      );
    } catch (error) {
      await this.securityAudit.registrarIncidente({
        tipo_evento: "LOGIN_FAILED",
        payload: { email: (dto.email ?? "").trim().toLowerCase() },
      });
      throw error;
    }

    const otp = await this.emailOtpService.issue(user);
    await this.securityAudit.registrarIncidente({
      tipo_evento: "LOGIN_OTP_SENT",
      id_usuario: user.id_usuario,
      payload: { canal: "EMAIL" },
    });

    return {
      requiresMfa: true,
      mfaToken: await this.sessionService.challenge(user, otp.challengeId),
      mfaChallenge: {
        type: "EMAIL_OTP",
        digits: EMAIL_OTP_DIGITS as 6,
        destination: maskEmail(user.email),
      },
      expiresIn: otp.expiresIn,
    };
  }
}
