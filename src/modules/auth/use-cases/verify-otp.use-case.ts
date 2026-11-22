import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import {
  ISecurityAuditPort,
  SECURITY_AUDIT,
} from "../domain/security-audit.port";
import { IUserRepository, USER_REPOSITORY } from "../domain/user.repository";
import { EmailOtpService } from "../email-otp.service";
import { AuthSession, SessionService } from "../session.service";
import { TokenService } from "../token.service";

/**
 * Caso de uso: paso 2 del login (POST /auth/verify-otp).
 * Valida el token provisional y el código OTP enviado por correo. Si son
 * correctos emite Access Token (15 min) + Refresh Token (7 días) e
 * invalida las sesiones previas del usuario.
 */
@Injectable()
export class VerifyOtpUseCase {
  constructor(
    private readonly tokenService: TokenService,
    private readonly emailOtpService: EmailOtpService,
    private readonly sessionService: SessionService,
    @Inject(USER_REPOSITORY) private readonly userRepository: IUserRepository,
    @Inject(SECURITY_AUDIT) private readonly securityAudit: ISecurityAuditPort,
  ) {}

  async execute(mfaToken: string, code: string): Promise<AuthSession> {
    const subject = await this.tokenService.verifyMfaChallengeToken(mfaToken);

    const user = await this.userRepository.findById(subject.id_usuario);
    if (!user || user.estado !== "ACTIVO") {
      throw new UnauthorizedException("Desafío de verificación inválido.");
    }

    const valid = await this.emailOtpService.verify(
      user.id_usuario,
      subject.challengeId,
      code,
    );
    if (!valid) {
      await this.securityAudit.registrarIncidente({
        tipo_evento: "MFA_VERIFY_FAILED",
        id_usuario: user.id_usuario,
        payload: { canal: "EMAIL" },
      });
      throw new UnauthorizedException(
        "Código de verificación inválido o expirado.",
      );
    }

    await this.userRepository.registrarUltimoIngreso(
      user.id_usuario,
      new Date(),
    );
    await this.securityAudit.registrarIncidente({
      tipo_evento: "MFA_VERIFY",
      id_usuario: user.id_usuario,
      payload: { canal: "EMAIL" },
    });

    return this.sessionService.open(user, true);
  }
}
