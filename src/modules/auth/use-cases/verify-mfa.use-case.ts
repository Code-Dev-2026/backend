import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import {
  ISecurityAuditPort,
  SECURITY_AUDIT,
} from "../domain/security-audit.port";
import { IUserRepository, USER_REPOSITORY } from "../domain/user.repository";
import { OtpMfaService } from "../otp-mfa.service";
import { AuthSession, SessionService } from "../session.service";
import { TokenService } from "../token.service";

/**
 * Caso de uso: completar el desafío MFA.
 * Valida el token provisional y el código OTP; si son correctos marca la
 * sesión como verificada y emite el Access Token con permisos completos.
 */
@Injectable()
export class VerifyMfaUseCase {
  constructor(
    private readonly tokenService: TokenService,
    private readonly otpMfaService: OtpMfaService,
    private readonly sessionService: SessionService,
    @Inject(USER_REPOSITORY) private readonly userRepository: IUserRepository,
    @Inject(SECURITY_AUDIT) private readonly securityAudit: ISecurityAuditPort,
  ) {}

  async execute(mfaToken: string, code: string): Promise<AuthSession> {
    const subject = await this.tokenService.verifyMfaChallengeToken(mfaToken);

    const user = await this.userRepository.findById(subject.id_usuario);
    if (!user || user.estado !== "ACTIVO") {
      throw new UnauthorizedException("Desafío MFA inválido.");
    }

    const valid = await this.otpMfaService.verify(user.id_usuario, code);
    if (!valid) {
      await this.securityAudit.registrarIncidente({
        tipo_evento: "MFA_VERIFY_FAILED",
        id_usuario: user.id_usuario,
        payload: {},
      });
      throw new UnauthorizedException("Código de verificación inválido.");
    }

    await this.userRepository.registrarUltimoIngreso(
      user.id_usuario,
      new Date(),
    );
    await this.securityAudit.registrarIncidente({
      tipo_evento: "MFA_VERIFY",
      id_usuario: user.id_usuario,
      payload: {},
    });

    return this.sessionService.open(user, true);
  }
}
