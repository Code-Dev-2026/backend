import { Inject, Injectable } from "@nestjs/common";
import { AuthService } from "../auth.service";
import { requiresMfa } from "../domain/auth-policy";
import { UserRecord } from "../domain/auth.models";
import {
  ISecurityAuditPort,
  SECURITY_AUDIT,
} from "../domain/security-audit.port";
import { IUserRepository, USER_REPOSITORY } from "../domain/user.repository";
import { LoginDto } from "../dto/login.dto";
import {
  AuthSession,
  MFA_CHALLENGE_TTL_SECONDS,
  SessionService,
} from "../session.service";

export interface MfaChallengeResult {
  requiresMfa: true;
  /** Token provisional: solo sirve en POST /auth/mfa/verify. */
  mfaToken: string;
  mfaChallenge: { type: "TOTP"; digits: 6 };
  expiresIn: number;
}

export type LoginResult =
  | MfaChallengeResult
  | ({ requiresMfa: false } & AuthSession);

/**
 * Caso de uso: login con correo y contraseña.
 * Si el rol exige MFA, entrega un token provisional y el desafío OTP de
 * 6 dígitos; el Access Token definitivo solo sale tras /auth/mfa/verify.
 */
@Injectable()
export class LoginUseCase {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
    @Inject(USER_REPOSITORY) private readonly userRepository: IUserRepository,
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

    if (requiresMfa(user)) {
      return {
        requiresMfa: true,
        mfaToken: await this.sessionService.challenge(user),
        mfaChallenge: { type: "TOTP", digits: 6 },
        expiresIn: MFA_CHALLENGE_TTL_SECONDS,
      };
    }

    await this.userRepository.registrarUltimoIngreso(
      user.id_usuario,
      new Date(),
    );
    await this.securityAudit.registrarIncidente({
      tipo_evento: "LOGIN",
      id_usuario: user.id_usuario,
      payload: { mfa: false },
    });

    return { requiresMfa: false, ...(await this.sessionService.open(user, false)) };
  }
}
